# Deno Deploy — project settings for the agent endpoint

The Deno adapter is `main.ts` at the repo root (the canonical entrypoint
for a GitHub-linked Deno Deploy app — the create-app flow detects it, and
it leaves `src/` untouched). It re-implements only the `node:http` shell
of `src/index.js` on `Deno.serve` and imports the existing modules
unchanged. Local run (mirrors `npm start`):

```
deno task start        # = deno run --allow-net --allow-env --allow-read main.ts
```

Permissions are the minimum the code needs: `--allow-net` (serve +
optional Kurier calls), `--allow-env` (config below), `--allow-read`
(the prover's `fs.existsSync` on the circuits dir). No write/run/ffi.

## Project settings (console.deno.com)

- **Source:** deploy from GitHub repo `jkislew/zkverify-agent`, production
  branch = the branch the code is pushed to (`main`).
- **Entrypoint:** `main.ts` (repo root). No build step, no framework
  preset.
- **Endpoint to register** in the Agent Games dashboard:
  `https://<app-name>.deno.dev/agent` (the `/agent` path is the handler;
  `/health` on the same origin is the preflight check).

## Environment variables (app → Settings → Environment Variables)

Names only — values never go in this repo:

| Variable | Required | Notes |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | **Yes** | The endpoint refuses to start without it (fail closed, same as the Node server). |
| `HMAC_SECRET_ENCODING` | Set to `utf8` | Pins the secret encoding the HMAC verify/sign uses (same default as local). |
| `CIRCUITS_DIR` | Optional | Defaults to `<app>/circuits`. Artifacts are absent on Deploy, so the prover answers `proofError` — the same behaviour as local today (see HOSTING.md §5). |
| `KURIER_API_KEY` | Optional | Unset = Kurier submission skipped; the scored path (proof in the response body) is unaffected. |
| `PORT` | Optional | Adapter defaults to 8080 like the Node server; set only if the platform instructs otherwise. |

## TEMP placeholder secret — how it carries over

The local `.env` currently holds the TEMP placeholder secret
(`TEMP_PLACEHOLDER_UNTIL_REGISTRATION`). For the deploy/preflight stage,
set `AGENT_GAMES_HMAC_SECRET` in the Deno dashboard to **that same
placeholder value** (copy it from the local `.env`; do not paste it into
chat or any doc). `/health` is unsigned, so platform preflight passes and
the deploy can be verified end-to-end before registration.

After the user registers the agent and runs **Rotate Secret** in the
Agent Games dashboard, replace the value in **both** places — the Deno
env var and the local `.env` — with the real secret (delivered via the
Secure Vault route, never chat), redeploy/restart, and confirm via
Dashboard → Practice mode before the first live round. Until then the
endpoint starts and answers health checks, but real platform deliveries
will fail signature verification (401) — expected and fail-closed.

## Notes

- The idempotency store is in-memory, exactly as in the Node server
  (single-process design). On Deploy an isolate restart clears it; a
  redelivered task inside one isolate's lifetime still returns the first
  response.
- Steal the VFY responses are proof-less HOLDs until the strategy
  commitment is final — unchanged from `src/index.js`.
