# Steal the VFY — policy format, circuit artifacts, and the implemented strategy

Written 2026-11-15. Facts below are from the repo, the live platform
(`https://agentgames.zkverify.io`), or byte-level inspection of the
platform-served artifacts. Anything not established is labelled an open
blocker — no guessing.

## 1. Established facts

### Circuit artifacts — platform download, confirmed live

Source: `circuits/README.md`, the build guide §02.5, and
`GET https://agentgames.zkverify.io/api/circuit-info` (read 2026-11-15,
returns exactly these URLs and hashes). All four URLs were HEAD-checked
on 2026-11-15 and return HTTP 200:

| file | bytes |
| --- | --- |
| `circuits/gatekeeper.wasm` | 1,755,820 |
| `circuits/gatekeeper_final.zkey` | 309,750 |
| `circuits/vfy-policy.wasm` | 2,991,212 |
| `circuits/vfy-policy_final.zkey` | 810,586 |

Registered vk hashes (also in `src/kurier.js` / `src/steal.js`):
gatekeeper `0x6b79c601…bad77b0`, vfyPolicy `0x6c56509f…d74be047`.
Artifacts are **not** generated locally with circom and **not** committed
(`.gitignore` covers `circuits/*.wasm` / `*.zkey`); you download them and
prove locally with snarkjs (`src/prover.js`). They are not yet downloaded
in this working tree, and `snarkjs` is not installed — both are required
before any proof can be generated.

### What the vfy-policy circuit is (byte-level forensics, 2026-11-15)

Parsed from the served artifacts themselves:

- zkey header: **1,909 variables, 9 public inputs**, domain size 2,048
  (gatekeeper, for comparison: 647 vars, **13 public inputs** — matching
  the known 13-input gatekeeper mapping).
- wasm template inventory: main template `VfyPolicyProof`; two Poseidon
  hashes (`Poseidon`, `PoseidonEx`); comparators `LessThan` ×2,
  `LessEqThan`, `GreaterEqThan`, `GreaterThan`; `IsEqual`, `IsZero`,
  `AND`, `NOT`, `Num2Bits` ×2. So the circuit checks a policy expressed
  as **threshold comparisons over the game state**, with a Poseidon
  commitment binding — it is not an open-ended strategy language
  (the event page says the same: "Complexity lives in the committed
  strategy, not in an open-ended action language").

### Turn envelope and response (build guide, §06)

Each turn the platform POSTs:

```json
{
  "protocolVersion": "v1", "eventId": "steal-the-vfy", "mode": "competition",
  "matchId": "9f4e1b2a-…", "turn": 3, "issuedAt": "…", "deadlineAt": "…",
  "state": {
    "selfBalance": "95", "opponentBalance": "105",
    "selfFortifiedUntilTurn": null, "opponentFortifiedUntilTurn": null
  },
  "strategyCommitment": { "hash": "0x7d…91" },
  "resolverVersion": "v1", "nonce": "3c2f1a…"
}
```

Balances arrive as **strings**. The response is:

```json
{
  "matchId": "…", "turn": 3,
  "action": { "type": "EXTRACT", "amount": 5 },
  "policyProof": { "circuitVersion": "v1", "proof": {…}, "public_signals": […] },
  "idempotencyKey": "…"
}
```

Two wire details the guide calls out explicitly, both now implemented in
`shapeStealResponse()` (the previous scaffold shape violated both):

- `action` is an **object** `{ type, amount? }`; `amount` is omitted
  entirely for HOLD and FORTIFY (schema rejects it even when 0).
- `proof` and `public_signals` must sit **inside `policyProof`** — at the
  top level they are scored as a missing proof (−2, resolved as HOLD).

### Resolver parameters (build guide, §06 — the only published numbers)

- Start: **100 VFY each**, **20 turns**, highest final balance wins.
- **EXTRACT N**: free; steals up to N from the opponent's spendable
  balance, **N ≤ 10** (cap 10). Against a fortified opponent the
  effective gain is **reduced by 6**.
- **FORTIFY**: costs **2 VFY**; blocks up to **6 VFY** of incoming
  extraction this turn.
- **HOLD**: free; nothing moves.
- Simultaneous submission; the resolver uses prior public state only.

### Public-inputs hash (optional audit field)

`policyProof.publicInputsHash` = keccak256 over the concatenation of
eight 32-byte big-endian fields, in this order (build guide §06):
`strategyCommitment.hash`, `matchId` (UUID as integer), `turn`,
`selfBalance`, `opponentBalance`, action code (**HOLD 0, FORTIFY 1,
EXTRACT 2**), `amount` (0 for HOLD/FORTIFY), circuit version (**v1 → 1**).
`src/steal.js` exports this field order (`STEAL_PUBLIC_INPUT_FIELDS`,
`ACTION_CODES`) for the future proving wiring; the hash itself is an
optional audit pointer — the platform verifies the Groth16 proof and its
public signals, not this hash.

### Scoring (event page)

Win +18, draw +9, loss +3; verified-turn reliability bonus +0..+2;
timeout −1/turn; invalid policy proof −2/turn. A missed turn is
substituted with HOLD and the match continues. Swiss 13–17 Nov 2026,
7 rounds, then Top 16 knockout. Turn deadline 5 min (platform waits
~30 s per push). Strategy commitment is registered in the dashboard
before Swiss Round 1, frozen mid-match, redeployable between rounds.

## 2. Open blockers (not established anywhere public)

1. **The commitment preimage is unpublished.** No public source — the
   build guide, the event page, `/guide`, `/rules`, or
   `/api/circuit-info` — states what is hashed or uploaded in the
   dashboard to create `strategyCommitment.hash`, nor the vfy-policy
   circuit's **input signal names/order**. The `.sym` and `.r1cs` files
   are **not** served (`/circuits/vfy-policy.sym` and `.r1cs` return
   404, verified 2026-11-15), and the wasm embeds no signal names
   (circom maps names to hashes). Consequence: `generateProof()` cannot
   yet be wired for vfy-policy — the witness inputs cannot be named.
   This must come from the signed-in dashboard registration flow or
   platform support. Until then the endpoint answers proof-less, which
   the platform resolves as HOLD — the strategy below decides correctly,
   but scored play additionally requires this blocker resolved, the
   artifacts downloaded, and `snarkjs` installed.
2. **Fortify duration.** The guide says FORTIFY blocks extraction "this
   turn", yet the state carries `selfFortifiedUntilTurn` /
   `opponentFortifiedUntilTurn`. The strategy treats a non-null
   until-turn ≥ the current turn as "fortified for this resolution" and
   never pays to fortify while already fortified; if the platform's
   fortify lasts exactly one resolution, that reading is still correct
   on the turn after a fortify only if the field then points at the
   current turn — to be confirmed in practice mode.
3. **`turn` lives outside `state`.** `src/index.js` `handleSteal()`
   passes only `task.state` to `decideStealTurn()`, so on real envelopes
   the strategy cannot see the turn number (it degrades gracefully:
   EXTRACT-dominant play, no endgame/fortify windows). Recommended
   one-line follow-up for whoever owns `index.js`: merge the envelope
   fields in — `const state = { ...(task.state ?? task.payload?.state ?? task), turn: task.turn, strategyCommitment: task.strategyCommitment };`
   Not applied here: `index.js` carries unrelated in-flight changes.

## 3. The implemented strategy (`src/steal.js`)

Pure, deterministic function of the public state
(`selfBalance`, `opponentBalance`, fortified-until fields, turn) plus
the frozen parameter set `STEAL_POLICY` — deliberately built **only
from threshold comparisons** over those fields, the exact class of
policy the circuit's comparator inventory can express, so it can be
encoded in the commitment once blocker 1 is resolved. Fail-closed: any
missing/malformed field ⇒ HOLD (the previous stub's behaviour).

### Why EXTRACT dominates (margin arithmetic, both balances ≥ 10)

Δ(margin) per action pairing, from the resolver matrix:

| mine \ opp | EXTRACT | FORTIFY | HOLD |
| --- | --- | --- | --- |
| **EXTRACT** | 0 | +10 | +20 |
| **FORTIFY** | −10 | 0 | −2 |
| **HOLD** | −20 | +2 | 0 |

Simultaneous extraction is a wash (both take 10), so EXTRACT is both
the attack and the hedge: it weakly dominates FORTIFY and HOLD in
every pairing. FORTIFY only earns its 2 VFY in narrow corners — when
the opponent is *already fortified* (my extraction is blunted to
10 − 6 = 4, and an extracting opponent then costs me −12 by EXTRACT
vs −10 by FORTIFY) while I hold a lead worth protecting. On the final
turns EXTRACT is strictly the protection: FORTIFY against an extractor
loses 10 of margin, EXTRACT loses 0.

### Rules (in priority order)

1. Opponent balance 0 → **HOLD** (nothing to take).
2. Protect-lead window — opponent fortified now, my effective gain
   ≤ 4, I am ahead, my balance ≥ 40, I am not already fortified, and
   more than 2 turns remain → **FORTIFY**.
3. Effective gain > 0 → **EXTRACT** for `min(10, opponentBalance)`
   (maximum is always at least as good: the transfer is free).
4. Gain is 0 (opponent fortified and poor) but I hold ≥ 40 with a
   non-negative lead, am not fortified, and the game is not in its
   last two turns → **FORTIFY**; otherwise **HOLD**.

This extracts aggressively against passive and aggressive opponents
alike, never pays fortify costs against a passive opponent (rule 2/4
require the opponent to be fortified, and a passive opponent's balance
is drained at +20 margin/turn instead), protects a lead in the endgame
by extracting (the wash), and never fortifies twice while a fortify is
already active.

### Parameters

All in `STEAL_POLICY` (`src/steal.js`): `extractCap 10`,
`fortifyBlock 6`, `fortifyCost 2` (resolver-side burn; documented for
the EV math), `protectSelfBalanceMin 40`, `protectGainMax 4`
(= cap − block), `endgameTurns 2`. If the platform ever publishes
different resolver numbers, only this object changes.

## 4. Tests

`test/test.js` covers: the documented resolver-matrix postures
(EXTRACT vs HOLD/EXTRACT/FORTIFY postures, protect-lead FORTIFY,
chasing while behind, endgame), fail-closed HOLD on garbage state,
amount capping at `min(10, opponentBalance)`, no double-fortify,
determinism, the corrected response shape (nested `action`,
`policyProof` nesting, amount omitted for HOLD/FORTIFY), and two
scripted 20-turn simulations against always-EXTRACT and always-FORTIFY
opponents under a local model of the documented resolver matrix.
