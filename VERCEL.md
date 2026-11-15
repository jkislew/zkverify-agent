# Vercel deployment — zkVerify Agent Games agent

Vercel (Hobby) is the current host. The adapter is `api/agent.js` (task
endpoint) + `api/health.js` (preflight), re-shelling the exact logic of
`src/index.js` / `main.ts` on Vercel's (req, res) function API with the
raw body preserved (`bodyParser: false`). No existing file was changed.

## Project settings (Vercel dashboard → import from GitHub)

- Repository: `jkislew/zkverify-agent`, production branch: `main`
- Framework Preset: **Other**
- Root Directory: **repo root** (default; do not set it to `api/`)
- Build Command: **none** (leave empty / off)
- Output Directory: **n/a** (leave default; there is no static site)
- Install Command: default is fine (the agent has zero runtime
  dependencies; `snarkjs` is an optional dependency and is only used
  when circuit artifacts are present — see the note below)

## Environment variables (Settings → Environment Variables, Production)

| Name | Value |
| --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | **required** — the endpoint fails closed without it (every POST is answered 401; nothing is parsed or acted on) |
| `HMAC_SECRET_ENCODING` | `utf8` |
| `CIRCUITS_DIR` | optional override; defaults to the repo's `circuits/` |
| `KURIER_API_KEY` | optional; Kurier submission stays skipped without it |

Set `AGENT_GAMES_HMAC_SECRET` to the **same TEMP placeholder value**
currently in the local `.env` for the preflight stage — `/api/health`
is unsigned so preflight passes; after Rotate Secret in the Agent
Games dashboard, replace the value in **both** Vercel and the local
`.env` via the Secure Vault route and redeploy. Until then real
deliveries 401 (expected, fail-closed).

## URLs to register

- Task endpoint (register this one): `https://<app-name>.vercel.app/api/agent`
- Health / preflight: `https://<app-name>.vercel.app/api/health`
  (plain `https://<app-name>.vercel.app/` returns the same health JSON
  via the rewrite in `vercel.json`)

## What vercel.json does (and why it exists)

- `functions.api/agent.js.maxDuration = 60` — Gatekeeper tasks carry
  a hard 60-second platform deadline; the function is allowed to use
  all of it instead of a shorter default.
- `rewrites: / -> /api/health` — mirrors the Node/Deno shells, where
  `GET /` returns the health JSON.

## Notes / known behaviour on Vercel

- **Idempotency is per warm instance.** The store is module-level, as
  in the other shells; a cold start forgets seen task IDs. This is
  the same trade-off as the Deno isolate and is acceptable for the
  platform's retry pattern.
- **Circuit artifacts are not bundled.** Vercel only ships files the
  function imports/traces, so `circuits/*.wasm` / `*.zkey` are absent
  at runtime and Gatekeeper answers carry a `proofError` (identical
  to the Deno deployment). If scored proving on Vercel is ever
  wanted, add `"includeFiles": "circuits/**"` to the `api/agent.js`
  entry in `vercel.json` — a deliberate deploy decision, not a default.
- Cold starts on Hobby are typically sub-second to a few seconds,
  comfortably inside the 60-second deadline, and unlike a free
  spin-down host there is no 15-minute sleep to wake from.
