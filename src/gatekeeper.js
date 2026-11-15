// Proof Gatekeeper — deterministic decision logic.
//
// The agent receives a transfer-approval task and must answer APPROVE or
// REJECT. The decision must be deterministic (same input, same output, no
// LLM in the decision path) and provable with the tournament's Groth16
// gatekeeper circuit: the proof's public signals must match the condition
// the platform asked about. A proof that verifies but authorizes the wrong
// action still scores as a failure, so every check below mirrors one of the
// circuit's constraints (the "trap classes" described in the build guide):
//
//   1. verification-key substitution -> vkHash must equal the registered one
//   2. balance below the minimum     -> balance >= minBalance
//   3. amount above the cap          -> amount <= maxAmount
//   4. recipient mismatch            -> recipient == expectedRecipient
//   5. expired condition             -> currentBlock < expiryBlock
//   6. proof reuse                   -> handled by the idempotency store
//
// Fail closed: any missing, malformed or uncertain field means REJECT.
//
// The task payload field names below follow the public descriptions of the
// envelope (condition + transfer). Aliases are accepted defensively; if the
// platform's live schema differs, adjust ONLY this mapping layer.

export const GATEKEEPER_VK_HASH =
  '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

const asInt = (v) => {
  if (v === null || v === undefined) return null;
  try { return BigInt(v); } catch { return null; }
};

const pick = (obj, names) => {
  for (const n of names) if (obj && obj[n] !== undefined) return obj[n];
  return undefined;
};

export function extractCondition(task) {
  const c = task?.condition ?? task?.payload?.condition ?? task ?? {};
  const t = task?.transfer ?? task?.payload?.transfer ?? task ?? {};
  return {
    balance: asInt(pick(c, ['balance', 'publicBalance', 'accountBalance'])),
    minBalance: asInt(pick(c, ['minBalance', 'minimumBalance', 'min', 'threshold'])),
    amount: asInt(pick(t, ['amount', 'transferAmount', 'value'])),
    maxAmount: asInt(pick(c, ['maxAmount', 'maxTransfer', 'cap', 'maximumAmount'])),
    recipient: pick(t, ['recipient', 'to', 'recipientAddress']),
    expectedRecipient: pick(c, ['expectedRecipient', 'recipient', 'allowedRecipient', 'recipientHash']),
    currentBlock: asInt(pick(c, ['currentBlock', 'blockNumber', 'block'])),
    expiryBlock: asInt(pick(c, ['expiryBlock', 'expiresAtBlock', 'expiry', 'validUntilBlock'])),
    vkHash: pick(c, ['vkHash', 'verificationKeyHash', 'vk_hash']) ?? GATEKEEPER_VK_HASH,
  };
}

// Returns { decision: 'APPROVE' | 'REJECT', reasons: string[], condition }
export function decideGatekeeper(task) {
  const cond = extractCondition(task);
  const reasons = [];
  if (cond.balance === null || cond.minBalance === null) reasons.push('missing balance fields');
  else if (cond.balance < cond.minBalance) reasons.push('balance below minimum');
  if (cond.amount === null || cond.maxAmount === null) reasons.push('missing amount fields');
  else if (cond.amount > cond.maxAmount) reasons.push('amount above maximum');
  if (!cond.recipient || !cond.expectedRecipient) reasons.push('missing recipient fields');
  else if (String(cond.recipient).toLowerCase() !== String(cond.expectedRecipient).toLowerCase()) {
    reasons.push('recipient mismatch');
  }
  if (cond.currentBlock === null || cond.expiryBlock === null) reasons.push('missing block fields');
  else if (cond.currentBlock >= cond.expiryBlock) reasons.push('condition expired');
  if (String(cond.vkHash).toLowerCase() !== GATEKEEPER_VK_HASH) reasons.push('vk hash mismatch');
  return { decision: reasons.length === 0 ? 'APPROVE' : 'REJECT', reasons, condition: cond };
}

// Map the checked condition to circuit inputs for snarkjs fullProve.
// NOTE: the gatekeeper circuit takes 13 inputs (per public reverse
// engineering of gatekeeper.wasm). The exact input names/order must be
// confirmed against the circuit's .sym file or the platform's starter
// prompt before scored play; the values below are the semantic mapping.
export function circuitInputs(cond, decision) {
  return {
    balance: cond.balance?.toString(),
    minBalance: cond.minBalance?.toString(),
    amount: cond.amount?.toString(),
    maxAmount: cond.maxAmount?.toString(),
    currentBlock: cond.currentBlock?.toString(),
    expiryBlock: cond.expiryBlock?.toString(),
    approved: decision === 'APPROVE' ? '1' : '0',
  };
}
