# zkVerify Agent Games — Agent

A working agent endpoint for the [zkVerify Agent Games](https://agentgames.zkverify.io)
(Season 01, 21 Oct – 21 Nov 2026), covering the **Proof Gatekeeper** track end
to end and the **Steal the VFY** track with a real implemented strategy
(see `STEAL.md` for the fact base, the strategy, and the one open
blocker: the platform has not published the strategy-commitment format
or the vfy-policy circuit's input names, so policy proofs cannot be
wired yet). Node.js ≥ 18, zero runtime dependencies (snarkjs is
optional, only for proof generation).

## How the platform works

Agent Games is a tournament where **you host the agent yourself** — the
platform never runs your code. You register a public HTTPS endpoint, and the
platform POSTs HMAC-signed task envelopes to it:

1. **Register** a competition account (X account or wallet sign-in), pick a
   handle, connect GitHub (required for prize eligibility) and a wallet
   address (required to claim VFY prizes).
2. **Register an agent** in the dashboard: give it your endpoint URL and the
   tracks you enter. The platform generates a **32-byte HMAC secret, shown
   exactly once** — that secret authenticates both directions.
3. **Play**: for every task, verify `x-agent-games-signature` over the *raw*
   body before parsing, decide, and return a response signed the same way.
   Task IDs are idempotency keys; retries must return the first response.
4. **Prove**: arena-track answers carry a Groth16 (BN128, Circom 2.x) proof
   generated locally with snarkjs; the platform re-verifies it against its
   own registered verification key. Optionally submit via Kurier to zkVerify
   mainnet for a finalized on-chain proof reference.

Tracks and prizes: 400,000 VFY total, 100,000 per track split 50/30/20 —
Proof Gatekeeper, Steal the VFY, Creator Track, Wildcard. Entry is free.

- **Proof Gatekeeper**: decide APPROVE/REJECT on a transfer condition
  (balance ≥ minimum, amount ≤ cap, recipient match, not expired, correct
  verification key) within a hard **60-second** deadline, with a proof.
- **Steal the VFY**: 20-turn matches, 100 simulated VFY each, 5 Swiss
  rounds. Echo `matchId`/`turn` exactly, omit `amount` for HOLD/FORTIFY,
  fresh idempotency key per turn, policy proof whose public-inputs hash the
  platform recomputes. A strategy commitment must be frozen before Round 1.

Circuit artifacts and registered vk hashes (live source:
`https://agentgames.zkverify.io/api/circuit-info`):

| circuit | vk hash |
| --- | --- |
| gatekeeper | `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0` |
| vfyPolicy | `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047` |

## Run it

```sh
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET after registering
npm test               # unit tests (HMAC, decisions, shaping, idempotency)
npm run smoke          # boots the server and exercises it over HTTP
npm start              # listens on PORT (default 8080)
```

Download the circuit artifacts into `circuits/` (see
`circuits/README.md`) and `npm install snarkjs` to enable proof generation.
Without them the agent still answers, with a `proofError` field instead of a
proof — it never fabricates one.

## Layout

```
src/index.js        HTTP endpoint: raw-body HMAC verify -> route -> sign response
src/hmac.js         HMAC-SHA256 signing/verification (utf8 + hex secret encodings)
src/gatekeeper.js   deterministic APPROVE/REJECT logic + circuit input mapping
src/prover.js       snarkjs Groth16 wrapper (optional, artifact-gated)
src/kurier.js       Kurier submission stub (disabled without your own API key)
src/steal.js        Steal the VFY strategy + response shaping (see STEAL.md)
src/idempotency.js  bounded task-ID response cache
test/               unit tests + live smoke test
circuits/           download instructions for the .wasm/.zkey artifacts
```

## ⚠️ User action checklist — the parts only you can do

Registration is bound to *your* identity and was deliberately **not** done
by the agent's author tooling (no wallet was connected, nothing was signed):

1. Go to https://agentgames.zkverify.io/register and sign in with **your X
   account or your wallet**; choose your handle, country, bio.
2. **Connect your GitHub account** (one per competition account; required
   for prize eligibility) and add your **wallet address** (required to
   claim VFY prizes).
3. Deploy this code to a **public HTTPS endpoint on port 443** (no
   localhost, no custom ports — e.g. a small VPS, Fly.io, Render, or a
   named tunnel). Free tiers that sleep will forfeit tasks.
4. In the dashboard, **register the agent** with that URL and your tracks.
   Copy the **HMAC secret (shown once)** into `.env` as
   `AGENT_GAMES_HMAC_SECRET`. Never commit it.
5. Use the dashboard's preflight/practice dispatch (10/hour) to verify the
   endpoint reports healthy, then enter scored rounds. For Steal the VFY,
   **commit a strategy before Swiss Round 1** and replace the HOLD
   placeholder in `src/steal.js` with your own policy.
6. Optional: create a **Kurier API key** under your own zkVerify account
   and set `KURIER_API_KEY` if you want on-chain proof references.

Two integration details to confirm against the live dashboard/starter
prompt before scored play: the exact task-envelope field names
(`src/gatekeeper.js` accepts the documented aliases and isolates them in
one mapping layer) and the gatekeeper circuit's 13 input names/order for
`circuitInputs()` (recoverable from the circuit's `.sym` file).
