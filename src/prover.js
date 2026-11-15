// Groth16 proof generation with snarkjs (optional dependency).
// Circuit artifacts are NOT committed to this repo (they are large and are
// served by the platform):
//   gatekeeper: https://agentgames.zkverify.io/circuits/gatekeeper.wasm
//               https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
//   vfy-policy: https://agentgames.zkverify.io/circuits/vfy-policy.wasm
//               https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey
// Download them into ./circuits (see circuits/README.md) before scored play.
// If snarkjs or the artifacts are absent, proving is skipped and the caller
// decides how to respond (the platform scores a missing proof lower than a
// wrong one — never fabricate a proof).

import fs from 'node:fs';
import path from 'node:path';

export async function generateProof(circuit, inputs, circuitsDir) {
  const wasm = path.join(circuitsDir, `${circuit}.wasm`);
  const zkeyName = circuit === 'gatekeeper' ? 'gatekeeper_final.zkey' : 'vfy-policy_final.zkey';
  const zkey = path.join(circuitsDir, zkeyName);
  if (!fs.existsSync(wasm) || !fs.existsSync(zkey)) {
    return { ok: false, error: `circuit artifacts missing for ${circuit} (see circuits/README.md)` };
  }
  let snarkjs;
  try {
    snarkjs = await import('snarkjs');
  } catch {
    return { ok: false, error: 'snarkjs not installed (npm install snarkjs)' };
  }
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey);
  return { ok: true, proof, publicSignals };
}
