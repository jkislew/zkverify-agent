import assert from 'node:assert';
import crypto from 'node:crypto';
import { verifySignature, signBody } from '../src/hmac.js';
import { decideGatekeeper } from '../src/gatekeeper.js';
import { decideStealTurn, shapeStealResponse, STEAL_POLICY } from '../src/steal.js';
import { IdempotencyStore } from '../src/idempotency.js';

// --- HMAC round trip (utf8 secret) ---
const secret = 'test-secret-for-local-tests-only';
const body = Buffer.from(JSON.stringify({ taskId: 't1', amount: 5 }));
const sig = crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex');
assert.equal(verifySignature(secret, body, sig), true);
assert.equal(verifySignature(secret, body, `sha256=${sig}`), true);
assert.equal(verifySignature(secret, body, 'f'.repeat(64)), false);
assert.equal(verifySignature(secret, Buffer.from('{"tampered":1}'), sig), false);
assert.equal(verifySignature('', body, sig), false);
// hex-encoded secret variant
const hexSecret = 'ab'.repeat(32);
const rawKeySig = crypto.createHmac('sha256', Buffer.from(hexSecret, 'hex'))
  .update(body).digest('hex');
assert.equal(verifySignature(hexSecret, body, rawKeySig, 'hex'), true);
// response signing verifies with the same secret
const respBody = '{"decision":"APPROVE"}';
assert.equal(verifySignature(secret, Buffer.from(respBody), signBody(secret, respBody)), true);

// --- Gatekeeper decisions ---
const good = {
  condition: {
    balance: 1460, minBalance: 1000, maxAmount: 1000,
    expectedRecipient: '0xRecipient', currentBlock: 8420000, expiryBlock: 8430000,
  },
  transfer: { amount: 500, recipient: '0xRecipient' },
};
assert.equal(decideGatekeeper(good).decision, 'APPROVE');
const lowBalance = structuredClone(good); lowBalance.condition.balance = 900;
assert.equal(decideGatekeeper(lowBalance).decision, 'REJECT');
const tooBig = structuredClone(good); tooBig.transfer.amount = 1500;
assert.equal(decideGatekeeper(tooBig).decision, 'REJECT');
const wrongRecipient = structuredClone(good); wrongRecipient.transfer.recipient = '0xOther';
assert.equal(decideGatekeeper(wrongRecipient).decision, 'REJECT');
const expired = structuredClone(good); expired.condition.currentBlock = 8430000;
assert.equal(decideGatekeeper(expired).decision, 'REJECT');
assert.equal(decideGatekeeper({}).decision, 'REJECT'); // fail closed on empty task
assert.equal(decideGatekeeper(null).decision, 'REJECT');

// --- Steal the VFY response shaping ---
const hold = shapeStealResponse({ matchId: 'm1', turn: 3 }, { action: 'HOLD' }, null, 'k1');
assert.equal(hold.matchId, 'm1');
assert.equal(hold.turn, 3);
assert.ok(!('amount' in hold), 'HOLD must omit amount entirely');
assert.deepEqual(hold.action, { type: 'HOLD' }, 'action is a nested object without amount');
const ext = shapeStealResponse({ matchId: 'm1', turn: 4 }, { action: 'EXTRACT', amount: 7 }, null, 'k2');
assert.deepEqual(ext.action, { type: 'EXTRACT', amount: 7 });
const fort = shapeStealResponse({ matchId: 'm1', turn: 5 }, { action: 'FORTIFY', amount: 3 }, null, 'k3');
assert.deepEqual(fort.action, { type: 'FORTIFY' }, 'FORTIFY never carries amount, even if a decision does');
const proved = shapeStealResponse({ matchId: 'm1', turn: 6 }, { action: 'HOLD' },
  { ok: true, proof: { pi_a: [] }, publicSignals: ['1'] }, 'k4');
assert.equal(proved.policyProof.circuitVersion, 'v1');
assert.deepEqual(proved.policyProof.public_signals, ['1']);
assert.ok(!('proof' in proved), 'proof must live inside policyProof, never top level');

// --- Steal the VFY strategy (decideStealTurn) ---
// Envelope states use string balances, exactly as the platform posts them.
const S = (over) => ({
  selfBalance: '100', opponentBalance: '100',
  selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null,
  turn: 1, turnsTotal: 20, ...over,
});
// Resolver-matrix postures:
// vs a passive (HOLD) opponent posture — unfortified, rich: extract max.
assert.deepEqual(decideStealTurn(S({})), { action: 'EXTRACT', amount: 10 });
// vs an extracting opponent (same public state — simultaneous): extraction is the wash/hedge.
assert.deepEqual(decideStealTurn(S({ turn: 10 })), { action: 'EXTRACT', amount: 10 });
// vs a fortified opponent while BEHIND: chase, do not defend.
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '60', opponentBalance: '90', opponentFortifiedUntilTurn: 5, turn: 5 })),
  { action: 'EXTRACT', amount: 10 });
// Protect-lead window: opponent fortified, ahead, rich, mid-game -> FORTIFY.
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '110', opponentBalance: '70', opponentFortifiedUntilTurn: 8, turn: 8 })),
  { action: 'FORTIFY' });
// ...but never pay to fortify twice while a fortify is already active.
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '110', opponentBalance: '70', selfFortifiedUntilTurn: 8, opponentFortifiedUntilTurn: 8, turn: 8 })),
  { action: 'EXTRACT', amount: 10 });
// ...and never fortify in the endgame: EXTRACT's wash protects the lead.
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '110', opponentBalance: '70', opponentFortifiedUntilTurn: 20, turn: 20 })),
  { action: 'EXTRACT', amount: 10 });
// Endgame: last turn ahead -> EXTRACT; last turn behind -> EXTRACT (only swing available).
assert.deepEqual(decideStealTurn(S({ selfBalance: '105', opponentBalance: '95', turn: 20 })),
  { action: 'EXTRACT', amount: 10 });
assert.deepEqual(decideStealTurn(S({ selfBalance: '90', opponentBalance: '105', turn: 20 })),
  { action: 'EXTRACT', amount: 10 });
// Nothing to take -> HOLD, whatever the turn.
assert.deepEqual(decideStealTurn(S({ opponentBalance: '0', turn: 20 })), { action: 'HOLD' });
// Amount is capped by the opponent's balance as well as the cap of 10.
assert.deepEqual(decideStealTurn(S({ opponentBalance: '7' })), { action: 'EXTRACT', amount: 7 });
// Opponent fortified and nearly bust (gain 0), we hold a protectable lead -> FORTIFY mid-game...
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '150', opponentBalance: '5', opponentFortifiedUntilTurn: 9, turn: 9 })),
  { action: 'FORTIFY' });
// ...but HOLD when our own balance is too small to be worth the 2 VFY defence.
assert.deepEqual(
  decideStealTurn(S({ selfBalance: '30', opponentBalance: '5', opponentFortifiedUntilTurn: 9, turn: 9 })),
  { action: 'HOLD' });
// Fail closed on malformed state.
assert.deepEqual(decideStealTurn({}), { action: 'HOLD' });
assert.deepEqual(decideStealTurn(null), { action: 'HOLD' });
assert.deepEqual(decideStealTurn({ selfBalance: 'abc', opponentBalance: '100' }), { action: 'HOLD' });
assert.deepEqual(decideStealTurn({ selfBalance: '-5', opponentBalance: '100' }), { action: 'HOLD' });
// Deterministic: identical state -> identical decision.
assert.deepEqual(decideStealTurn(S({ turn: 7 })), decideStealTurn(S({ turn: 7 })));

// --- Scripted 20-turn simulations under the documented resolver matrix ---
// Local model: simultaneous resolution on prior balances; FORTIFY costs 2
// and cuts the opponent's extraction by 6 on the same turn.
function resolveTurn(me, opp, myAction, oppAction) {
  const take = (amount, targetFortified) =>
    Math.max(0, Math.min(amount, targetFortified.balance) - (targetFortified.fortified ? STEAL_POLICY.fortifyBlock : 0));
  const myFort = myAction.action === 'FORTIFY';
  const oppFort = oppAction.action === 'FORTIFY';
  const myGain = myAction.action === 'EXTRACT' ? take(myAction.amount, { balance: opp.balance, fortified: oppFort }) : 0;
  const oppGain = oppAction.action === 'EXTRACT' ? take(oppAction.amount, { balance: me.balance, fortified: myFort }) : 0;
  return {
    me: me.balance + myGain - oppGain - (myFort ? STEAL_POLICY.fortifyCost : 0),
    opp: opp.balance + oppGain - myGain - (oppFort ? STEAL_POLICY.fortifyCost : 0),
  };
}
function playMatch(oppPolicy) {
  let me = { balance: 100 }, opp = { balance: 100 };
  let myFortUntil = null, oppFortUntil = null;
  for (let turn = 1; turn <= 20; turn++) {
    const mine = decideStealTurn({
      selfBalance: String(me.balance), opponentBalance: String(opp.balance),
      selfFortifiedUntilTurn: myFortUntil, opponentFortifiedUntilTurn: oppFortUntil,
      turn, turnsTotal: 20,
    });
    const theirs = oppPolicy(turn, opp.balance, me.balance);
    const next = resolveTurn(me, opp, mine, theirs);
    me = { balance: next.me }; opp = { balance: next.opp };
    myFortUntil = mine.action === 'FORTIFY' ? turn : myFortUntil;
    oppFortUntil = theirs.action === 'FORTIFY' ? turn : oppFortUntil;
  }
  return { me: me.balance, opp: opp.balance };
}
// Against an always-EXTRACT opponent the strategy must not lose (wash or better).
const vsExtract = playMatch(() => ({ action: 'EXTRACT', amount: 10 }));
assert.ok(vsExtract.me >= vsExtract.opp, `vs always-EXTRACT: ${JSON.stringify(vsExtract)}`);
// Against an always-FORTIFY opponent the strategy must win outright.
const vsFortify = playMatch(() => ({ action: 'FORTIFY' }));
assert.ok(vsFortify.me > vsFortify.opp, `vs always-FORTIFY: ${JSON.stringify(vsFortify)}`);
// Against a passive HOLD opponent the strategy must win big.
const vsHold = playMatch(() => ({ action: 'HOLD' }));
assert.ok(vsHold.me > vsHold.opp + 50, `vs always-HOLD: ${JSON.stringify(vsHold)}`);

// --- Idempotency ---
const store = new IdempotencyStore(2);
store.set('a', { decision: 'APPROVE' });
assert.deepEqual(store.get('a'), { decision: 'APPROVE' });
assert.equal(store.get('missing'), null);

console.log('all tests passed');
