// Steal the VFY — tournament strategy (implemented; see STEAL.md for the
// full fact base, the margin arithmetic, and the open blockers).
//
// Match format (build guide, agentgames.zkverify.io/build §06): two
// agents, 100 simulated VFY each, 20 turns, highest balance wins.
//   EXTRACT N  free; steals up to N (cap 10) from the opponent's
//              spendable balance; a fortified opponent reduces the
//              effective gain by 6.
//   FORTIFY    costs 2; blocks up to 6 of incoming extraction this turn.
//   HOLD       free; nothing moves.
// Simultaneous submission; the resolver uses prior public state only.
//
// Each turn the platform posts a signed envelope whose state is:
//   { selfBalance: "95", opponentBalance: "105",
//     selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null }
// (balances are STRINGS; the envelope also carries matchId, turn, and
// strategyCommitment.hash). The reply must:
//   - echo matchId and turn EXACTLY as received (a stale echo = HOLD)
//   - declare one action as { type, amount? }; amount is OMITTED
//     entirely for HOLD and FORTIFY (the schema rejects it even when 0)
//   - attach the policy proof INSIDE policyProof: { circuitVersion,
//     proof, public_signals } — top-level proof fields score as a
//     missing proof (-2, resolved as HOLD)
//   - use a fresh idempotencyKey per turn
//
// The strategy below is a pure deterministic function of the public
// state plus the frozen STEAL_POLICY parameters, built only from
// threshold comparisons — the class of policy the vfyPolicy circuit
// (comparators + Poseidon commitment, 9 public inputs; see STEAL.md)
// can express, so it can be encoded in the strategy commitment once
// the platform reveals the commitment format. Fail closed: any
// missing or malformed field means HOLD.

export const VFY_POLICY_VK_HASH =
  '0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047';

// Resolver parameters from the build guide. fortifyCost is paid to the
// resolver (burned), never chosen by us — it is recorded here because
// the strategy's expected-value math depends on it. If the platform
// publishes different numbers, only this object changes.
export const STEAL_POLICY = Object.freeze({
  extractCap: 10,          // EXTRACT steals at most 10 per turn
  fortifyBlock: 6,         // FORTIFY blocks up to 6 of incoming extraction
  fortifyCost: 2,          // FORTIFY price, burned by the resolver
  protectSelfBalanceMin: 40, // only protect a balance at least this large
  protectGainMax: 4,       // = extractCap - fortifyBlock: blunted-gain ceiling for the protect window
  endgameTurns: 2,         // final N turns: EXTRACT is itself the hedge, never FORTIFY
  defaultTurnsTotal: 20,
});

// Action codes for the public-inputs hash (build guide §06).
export const ACTION_CODES = Object.freeze({ HOLD: 0, FORTIFY: 1, EXTRACT: 2 });

// Ordered fields of the keccak256 public-inputs hash (optional audit
// field policyProof.publicInputsHash). Exported for the proving wiring;
// the platform verifies the Groth16 proof itself, not this hash.
export const STEAL_PUBLIC_INPUT_FIELDS = Object.freeze([
  'strategyCommitment', 'matchId', 'turn', 'selfBalance',
  'opponentBalance', 'actionCode', 'amount', 'circuitVersion',
]);

const pick = (obj, names) => {
  for (const n of names) if (obj && obj[n] !== undefined) return obj[n];
  return undefined;
};

// Balances arrive as strings; accept numbers too. Returns a safe
// non-negative integer or null on anything malformed.
const toAmount = (v) => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(typeof v === 'string' ? v.trim() : v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

const toTurn = (v) => {
  const n = toAmount(v);
  return n === null ? null : n;
};

// A fortified-until field counts as active when it is non-null and
// reaches at least the current turn. With the turn unknown, any
// non-null value is treated as active (conservative both ways: we do
// not pay to re-fortify, and we assume the opponent's defence is up).
function isFortified(untilTurn, turn) {
  if (untilTurn === null || untilTurn === undefined) return false;
  if (untilTurn === true) return true;
  const until = toTurn(untilTurn);
  if (until === null) return true; // non-null but unparsable: assume active
  if (turn === null) return true;
  return until >= turn;
}

// Decide one turn. state: the envelope's state object (aliases accepted
// defensively). Returns { action } or { action: 'EXTRACT', amount }.
export function decideStealTurn(state) {
  const s = state ?? {};
  const self = toAmount(pick(s, ['selfBalance', 'myBalance', 'self', 'balance']));
  const opponent = toAmount(pick(s, ['opponentBalance', 'oppBalance', 'opponent']));
  if (self === null || opponent === null) return { action: 'HOLD' }; // fail closed

  const total = toTurn(pick(s, ['turnsTotal', 'totalTurns'])) ?? STEAL_POLICY.defaultTurnsTotal;
  const turn = toTurn(pick(s, ['turn', 'currentTurn', 'turnNumber']));
  // Turns are 1-based in the guide's examples; tolerate a 0-based feed.
  const turnsRemaining = turn === null
    ? null
    : Math.min(total, Math.max(1, turn <= 0 ? total : total - turn + 1));
  const lateGame = turnsRemaining !== null && turnsRemaining <= STEAL_POLICY.endgameTurns;

  const selfFortified = isFortified(
    pick(s, ['selfFortifiedUntilTurn', 'selfFortified']), turn);
  const opponentFortified = isFortified(
    pick(s, ['opponentFortifiedUntilTurn', 'opponentFortified']), turn);

  const cap = STEAL_POLICY.extractCap;
  const rawGain = Math.min(cap, opponent);
  const gain = opponentFortified
    ? Math.max(0, rawGain - STEAL_POLICY.fortifyBlock)
    : rawGain;
  const lead = self - opponent;

  // Nothing to take: the match is decided on this axis already.
  if (rawGain <= 0) return { action: 'HOLD' };

  // Protect-lead window: the opponent's defence blunts our extraction
  // to <= protectGainMax, we are ahead with a balance worth protecting,
  // we are not already fortified, and the game is not in its final
  // turns (where EXTRACT's simultaneous wash is the better hedge).
  if (
    opponentFortified &&
    gain <= STEAL_POLICY.protectGainMax &&
    lead > 0 &&
    self >= STEAL_POLICY.protectSelfBalanceMin &&
    !selfFortified &&
    !lateGame
  ) {
    return { action: 'FORTIFY' };
  }

  // Default and endgame: EXTRACT for the maximum. It is free, and
  // simultaneous extraction is a wash, so it attacks a passive or
  // fortifying opponent and hedges an extracting one at once.
  if (gain > 0) return { action: 'EXTRACT', amount: rawGain };

  // Gain is 0 (opponent fortified and nearly bust) but we hold a
  // balance worth shielding and are not behind: buy the defence.
  // Never in the endgame, never while already fortified.
  if (
    !lateGame &&
    !selfFortified &&
    self >= STEAL_POLICY.protectSelfBalanceMin &&
    lead >= 0
  ) {
    return { action: 'FORTIFY' };
  }
  return { action: 'HOLD' };
}

export function shapeStealResponse(envelope, decision, proofBundle, idempotencyKey) {
  const action = { type: decision.action };
  // amount exists only on EXTRACT; never emit it for HOLD or FORTIFY.
  if (decision.amount !== undefined && decision.action === 'EXTRACT') {
    action.amount = decision.amount;
  }
  const res = {
    matchId: envelope.matchId,
    turn: envelope.turn,
    action,
    idempotencyKey,
  };
  if (proofBundle?.ok) {
    res.policyProof = {
      circuitVersion: proofBundle.circuitVersion ?? 'v1',
      proof: proofBundle.proof,
      public_signals: proofBundle.publicSignals,
    };
  }
  return res;
}
