// Vercel serverless entrypoint for the zkVerify Agent Games agent.
//
// src/index.js wires the request handler directly into a node:http
// listener, which Vercel cannot run (requests must enter through an
// exported (req, res) function). This adapter therefore re-implements
// ONLY that thin HTTP shell — exactly as main.ts did for Deno — and
// reuses the exact same modules in ../src (hmac, idempotency,
// gatekeeper, steal, prover, kurier) with the exact same order of
// operations, which is a security requirement, not a preference:
//   1. Read the RAW body bytes (the HMAC is over the raw bytes).
//   2. Verify x-agent-games-signature (HMAC-SHA256) over the raw body.
//      Never parse or act on an unverified body.
//   3. Parse JSON, route by track/type, decide deterministically.
//   4. Sign the exact response bytes and return them with the same header.
//
// Routes, JSON shapes, status codes and fail-closed errors are identical
// to src/index.js — including its quirks: the health route matches the
// raw path exactly ('/health' or '/'), POST is accepted on any path, and
// any other method gets a bare 405. (On Vercel this function is mounted
// at /api/agent, so in practice the platform POSTs here and preflight
// uses api/health.js; the in-shell health branch is kept for parity.)
//
// Vercel adaptations, and nothing else:
//   - `export const config = { api: { bodyParser: false } }` so Vercel
//     does NOT pre-parse the body — the raw bytes are read from the
//     request stream, byte-for-byte as node:http delivered them.
//   - Responses go through res.status() / res.setHeader() / res.end(),
//     the Vercel (Node) response API, with the same bytes the other
//     shells send.
//   - The idempotency store is module-level, i.e. one store per warm
//     function instance — the same scoping main.ts gets per isolate.
//   - There is no process to exit() when the secret is missing, so the
//     startup refusal becomes: log the same refusal lines at module
//     load, and let the handler fail closed — verifySignature()
//     returns false for an empty secret, so every POST gets a 401 and
//     nothing is ever parsed or acted on.
//
// Deadlines: Proof Gatekeeper tasks carry a hard 60-second response
// limit; vercel.json sets this function's maxDuration to 60.
//
// Routes (as deployed):
//   POST /api/agent   -> task endpoint (register THIS url at sign-up)
//   GET  /api/health  -> preflight health (see api/health.js)

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signBody, verifySignature } from '../src/hmac.js';
import { IdempotencyStore } from '../src/idempotency.js';
import { circuitInputs, decideGatekeeper } from '../src/gatekeeper.js';
import { decideStealTurn, shapeStealResponse } from '../src/steal.js';
import { generateProof } from '../src/prover.js';
import { submitProofViaKurier } from '../src/kurier.js';

export const config = { api: { bodyParser: false } };

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const ENCODING = process.env.HMAC_SECRET_ENCODING || 'utf8';
// src/index.js resolves ../circuits from src/; this file sits in api/,
// so ../circuits is the same directory.
const CIRCUITS_DIR = process.env.CIRCUITS_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'circuits');
const seen = new IdempotencyStore();

if (!SECRET) {
  console.error('AGENT_GAMES_HMAC_SECRET is not set — refusing to start (fail closed).');
  console.error('The secret is issued once when you register the agent; see README.');
  // No process to exit in serverless: the handler fails closed instead
  // (see the header comment) — an empty secret verifies nothing.
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  res.status(status);
  res.setHeader('content-type', 'application/json');
  res.setHeader('x-agent-games-signature', signBody(SECRET, body, ENCODING));
  res.end(body);
}

// Read the request stream to the exact raw bytes, as node:http's
// 'data'/'end' accumulation did in src/index.js.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleGatekeeper(task, taskId) {
  const { decision, reasons, condition } = decideGatekeeper(task);
  const response = { taskId, decision };
  if (reasons.length) response.reasons = reasons;
  const proved = await generateProof('gatekeeper', circuitInputs(condition, decision), CIRCUITS_DIR);
  if (proved.ok) {
    response.proof = proved.proof;
    response.publicSignals = proved.publicSignals;
    const kurier = await submitProofViaKurier(
      { circuit: 'gatekeeper', proof: proved.proof, publicSignals: proved.publicSignals });
    if (kurier.ok && kurier.txHash) response.proofReference = kurier.txHash;
  } else {
    response.proofError = proved.error;
  }
  return response;
}

async function handleSteal(task) {
  const state = { ...(task.state ?? task.payload?.state ?? task), turn: task.turn, strategyCommitment: task.strategyCommitment };
  const decision = decideStealTurn(state);
  const idempotencyKey = crypto.randomUUID();
  // Policy-proof inputs depend on the frozen strategy commitment and the
  // platform's public-inputs hash field order — wire generateProof() here
  // once your strategy (and its commitment) is final. Until then the
  // response is a valid proof-less HOLD, exactly as the protocol defines.
  return shapeStealResponse(task, decision, null, idempotencyKey);
}

export default async function handler(req, res) {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.status(200);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, protocolVersion: 'v1', service: 'zkverify-agent-games' }));
    return;
  }
  if (req.method !== 'POST') { res.status(405); res.end(); return; }
  const raw = await readRawBody(req);
  const signature = req.headers['x-agent-games-signature'];
  if (!verifySignature(SECRET, raw, signature, ENCODING)) {
    res.status(401);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid signature' }));
    return;
  }
  let task;
  try { task = JSON.parse(raw.toString('utf8')); }
  catch { sendSigned(res, 400, { error: 'invalid json' }); return; }
  const taskId = task.taskId ?? task.id ?? task.idempotencyKey ?? null;
  if (taskId && seen.get(taskId)) { sendSigned(res, 200, seen.get(taskId)); return; }
  try {
    const kind = String(task.track ?? task.type ?? task.event ?? '').toLowerCase();
    const response = (kind.includes('steal') || kind.includes('vfy') || task.matchId)
      ? await handleSteal(task)
      : await handleGatekeeper(task, taskId);
    if (taskId) seen.set(taskId, response);
    sendSigned(res, 200, response);
  } catch (err) {
    // Fail closed with a signed rejection rather than a hang or a 500:
    // a timeout forfeits the task exactly like a crash does.
    console.error('task handling failed:', err);
    sendSigned(res, 200, { taskId, decision: 'REJECT', reasons: ['internal error, failing closed'] });
  }
}
