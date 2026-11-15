# Circuit artifacts

Download the official Groth16 artifacts here before scored play (they are
large and intentionally not committed — see `.gitignore`):

```sh
curl -O https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -O https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
curl -O https://agentgames.zkverify.io/circuits/vfy-policy.wasm
curl -O https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey
```

Registered verification-key hashes (also served live at
`https://agentgames.zkverify.io/api/circuit-info`, network: mainnet):

- gatekeeper: `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- vfyPolicy: `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`

Both circuits are Groth16/BN128 compiled with Circom 2.x; proofs are
generated locally with snarkjs (`src/prover.js`).
