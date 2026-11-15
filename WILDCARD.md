# Wildcard submission — zkVerify Agent Games (Season 01)

Prepared for the dashboard submission form. Entry: **archietecture1** (GitHub: jkislew).

## Agent link

https://github.com/jkislew/zkverify-agent

## Public endpoint

https://<app-name>.vercel.app/api/agent  ← replace with the live Vercel URL before submitting

## Use case

**A payment judge that cannot lie about its work.**

The agent plays the Proof Gatekeeper arena: it receives proof-backed payment
requests and must APPROVE or REJECT each one, and every decision it makes is
backed by a Groth16 proof that the platform verifies against its registered
verification keys. It is a working prototype of the transaction-guard pattern
anyone needs before letting an autonomous agent touch money: the agent screens
what it is asked to approve, checks the proof instead of trusting the request,
and its own decisions are checkable in return.

Who it helps: builders and operators who delegate payments or approvals to an
AI agent and need evidence, not assurances — the same pattern applies to
treasury bots, allowance guardians, and agent-to-agent payments.

The same endpoint also plays Steal the VFY with a committed threshold strategy:
every move carries a proof that the move is one the committed strategy allows.

## Build context

- Zero-runtime-dependency Node agent, deployed as a Vercel serverless function
  (`api/agent.js`) whose thin shell reuses the exact same handler modules as
  the local Node server — same code path in development and production.
- Transport security: every task envelope is HMAC-SHA256 signed over the raw
  body; responses are signed the same way; task IDs are idempotency keys, so a
  redelivered task replays the identical signed answer instead of double-acting.
- Fail-closed by design: malformed or unverifiable input gets a signed REJECT,
  never a guess. The prover never fabricates a proof — when circuit artifacts
  or inputs are missing it answers with an explicit `proofError`.
- Gatekeeper logic screens six trap classes (wrong verification key, replayed
  or mismatched public inputs, malformed proofs, expired or mismatched task
  bindings, amount and recipient inconsistencies).
- Steal the VFY strategy is a pure deterministic function of the public state
  using only threshold comparisons, so it is exactly expressible in the
  vfy-policy circuit: extract up to the cap by default, fortify only inside a
  narrow protect-the-lead window, hold when there is nothing worth taking.
- Built and tested locally end to end (unit tests plus a signed smoke test)
  before deployment.

## zkVerify (optional plus)

Verification is the point of the build, not a bolt-on: Gatekeeper decisions are
proven with Groth16 (BN128, Circom 2.x) against the platform's registered
gatekeeper verification key, and Steal moves are proven against the registered
vfy-policy key, so the platform — and anyone reading the public result record —
can check that the agent followed the rules and its committed strategy without
trusting the agent's own word.
