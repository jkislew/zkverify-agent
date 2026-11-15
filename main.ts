// Deno Deploy entrypoint for the zkVerify Agent Games agent.
//
// src/index.js wires the request handler directly into a node:http
// listener, which Deno Deploy cannot run (requests must enter through
// Deno.serve). This adapter therefore re-implements ONLY that thin HTTP
// shell and reuses the exact same modules — hmac, idempotency,
// gatekeeper, steal, prover, kurier — with the exact same order of
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
// any other method gets a bare 405.
//
// Deadlines: Proof Gatekeeper tasks carry a hard 60-second response limit.
// Fail closed: bad signature -> 401, malformed task -> signed REJECT/HOLD.
//
// Routes:
//   GET  /health   -> { ok: true, protocolVersion: 'v1', ... } (preflight)
//   POST /agent    -> task endpoint (register THIS url at sign-up)

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBody, verifySignature } from "./src/hmac.js";
import { IdempotencyStore } from "./src/idempotency.js";
import { circuitInputs, decideGatekeeper } from "./src/gatekeeper.js";
import { decideStealTurn, shapeStealResponse } from "./src/steal.js";
import { generateProof } from "./src/prover.js";
import { submitProofViaKurier } from "./src/kurier.js";

const PORT = Number(Deno.env.get("PORT") || 8080);
const SECRET = Deno.env.get("AGENT_GAMES_HMAC_SECRET") || "";
const ENCODING = Deno.env.get("HMAC_SECRET_ENCODING") || "utf8";
// src/index.js resolves ../circuits from src/; this file sits at the repo
// root, so ./circuits is the same directory.
const CIRCUITS_DIR = Deno.env.get("CIRCUITS_DIR") ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "circuits");
const seen = new IdempotencyStore();

if (!SECRET) {
  console.error(
    "AGENT_GAMES_HMAC_SECRET is not set — refusing to start (fail closed).",
  );
  console.error(
    "The secret is issued once when you register the agent; see README.",
  );
  Deno.exit(1);
}

function sendSigned(status: number, obj: unknown): Response {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": signBody(SECRET, body, ENCODING),
    },
  });
}

// deno-lint-ignore no-explicit-any
async function handleGatekeeper(task: any, taskId: unknown) {
  const { decision, reasons, condition } = decideGatekeeper(task);
  // deno-lint-ignore no-explicit-any
  const response: any = { taskId, decision };
  if (reasons.length) response.reasons = reasons;
  const proved = await generateProof(
    "gatekeeper",
    circuitInputs(condition, decision),
    CIRCUITS_DIR,
  );
  if (proved.ok) {
    response.proof = proved.proof;
    response.publicSignals = proved.publicSignals;
    const kurier = await submitProofViaKurier(
      {
        circuit: "gatekeeper",
        proof: proved.proof,
        publicSignals: proved.publicSignals,
      },
    );
    if (kurier.ok && kurier.txHash) response.proofReference = kurier.txHash;
  } else {
    response.proofError = proved.error;
  }
  return response;
}

// deno-lint-ignore no-explicit-any
async function handleSteal(task: any) {
  const state = { ...(task.state ?? task.payload?.state ?? task), turn: task.turn, strategyCommitment: task.strategyCommitment };
  const decision = decideStealTurn(state);
  const idempotencyKey = crypto.randomUUID();
  // Policy-proof inputs depend on the frozen strategy commitment and the
  // platform's public-inputs hash field order — wire generateProof() here
  // once your strategy (and its commitment) is final. Until then the
  // response is a valid proof-less HOLD, exactly as the protocol defines.
  return shapeStealResponse(task, decision, null, idempotencyKey);
}

async function handler(req: Request): Promise<Response> {
  // node:http's req.url is the raw origin-form target (path + query);
  // reconstruct it so the exact-match health check behaves identically.
  const url = new URL(req.url);
  const rawUrl = url.pathname + url.search;
  if (req.method === "GET" && (rawUrl === "/health" || rawUrl === "/")) {
    return new Response(
      JSON.stringify({
        ok: true,
        protocolVersion: "v1",
        service: "zkverify-agent-games",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (req.method !== "POST") return new Response(null, { status: 405 });

  // Keep the body as raw bytes end to end: the signature is over them.
  const raw = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("x-agent-games-signature");
  if (!verifySignature(SECRET, raw, signature, ENCODING)) {
    return new Response(JSON.stringify({ error: "invalid signature" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  // deno-lint-ignore no-explicit-any
  let task: any;
  try {
    task = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendSigned(400, { error: "invalid json" });
  }
  const taskId = task.taskId ?? task.id ?? task.idempotencyKey ?? null;
  if (taskId && seen.get(taskId)) return sendSigned(200, seen.get(taskId));
  try {
    const kind = String(task.track ?? task.type ?? task.event ?? "")
      .toLowerCase();
    const response =
      (kind.includes("steal") || kind.includes("vfy") || task.matchId)
        ? await handleSteal(task)
        : await handleGatekeeper(task, taskId);
    if (taskId) seen.set(taskId, response);
    return sendSigned(200, response);
  } catch (err) {
    // Fail closed with a signed rejection rather than a hang or a 500:
    // a timeout forfeits the task exactly like a crash does.
    console.error("task handling failed:", err);
    return sendSigned(200, {
      taskId,
      decision: "REJECT",
      reasons: ["internal error, failing closed"],
    });
  }
}

Deno.serve(
  { port: PORT, onListen: () => console.log(`agent listening on :${PORT}`) },
  handler,
);
