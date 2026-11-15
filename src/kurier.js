// Kurier (zkVerify) proof submission — OPTIONAL audit path.
//
// The platform re-verifies the proof you return in your response against
// its own registered verification key; submitting the proof to zkVerify
// mainnet via Kurier additionally gives you a finalized on-chain proof
// reference (tx hash) to attach as proofReference.
//
// This module is DISABLED unless KURIER_API_KEY is set in the environment.
// The API key belongs to the operator's own zkVerify/Kurier account — it
// must be created by the user (see README "User action checklist") and must
// never be committed. No key is bundled, requested, or fabricated here.
//
// Flow (per the build guide): register the verification key once, submit
// the proof with its vk hash, poll the job until status = Finalized.

export const VK_HASHES = {
  gatekeeper: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  vfyPolicy: '0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047',
};

export async function submitProofViaKurier({ circuit, proof, publicSignals }, env = process.env) {
  if (!env.KURIER_API_KEY) return { ok: false, skipped: true, error: 'KURIER_API_KEY not set' };
  // Intentionally left as an integration stub: Kurier's REST surface is
  // account-bound, so the exact base URL and vk-registration call are wired
  // up once the operator has an API key. Returning "skipped" keeps the
  // agent's scored path (proof in the response body) fully functional.
  return { ok: false, skipped: true, error: 'Kurier integration not configured for this deployment', circuit, hasProof: Boolean(proof), publicSignalsCount: publicSignals?.length ?? 0 };
}
