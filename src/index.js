// zkVerify Agent Games — agent endpoint.
//
// One public HTTPS endpoint (behind your host's TLS terminator; this server
// itself speaks plain HTTP on PORT). The platform POSTs signed task
// envelopes here. Order of operations is a security requirement, not a
// preference:
//   1. Read the RAW body bytes.
//   2. Verify x-agent-games-signature (HMAC-SHA256) over the raw body.
//      Never parse or act on an unverified body.
//   3. Parse JSON, route by track/type, decide deterministically.
//   4. Sign the exact response bytes and return them with the same header.
//
// Deadlines: Proof Gatekeeper tasks carry a hard 60-second response limit.
// Fail closed: bad signature -> 401, malformed task -> signed REJECT/HOLD.
//
// Routes:
//   GET  /health   -> { ok: true } (platform preflight / health check)
//   POST /agent    -> task endpoint (register THIS url at sign-up)

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySignature, signBody } from './hmac.js';
import { IdempotencyStore } from './idempotency.js';
import { decideGatekeeper, circuitInputs } from './gatekeeper.js';
import { decideStealTurn, shapeStealResponse } from './steal.js';
import { generateProof } from './prover.js';
import { submitProofViaKurier } from './kurier.js';

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const ENCODING = process.env.HMAC_SECRET_ENCODING || 'utf8';
const CIRCUITS_DIR = process.env.CIRCUITS_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'circuits');
const seen = new IdempotencyStore();

if (!SECRET) {
  console.error('AGENT_GAMES_HMAC_SECRET is not set — refusing to start (fail closed).');
  console.error('The secret is issued once when you register the agent; see README.');
  process.exit(1);
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-agent-games-signature': signBody(SECRET, body, ENCODING),
  });
  res.end(body);
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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocolVersion: 'v1', service: 'zkverify-agent-games' }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const signature = req.headers['x-agent-games-signature'];
    if (!verifySignature(SECRET, raw, signature, ENCODING)) {
      res.writeHead(401, { 'content-type': 'application/json' });
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
  });
});

server.listen(PORT, () => console.log(`agent listening on :${PORT}`));
