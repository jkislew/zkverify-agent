# zkVerify Agent Games — Hosting findings & registration pack

Prepared 2026-11-15 (evening, WIB). Status: **no live public URL yet** — every
route that works without the user's own accounts/decisions was tested and is
documented below with evidence. The recommended route needs exactly one user
decision (which free account to create); everything else is ready.

Local state (verified 2026-11-15 ~22:57 WIB):

- Server was found DOWN and was relaunched detached
  (`node --env-file=.env src/index.js`, PID 2913, log `server.log`).
  `GET http://127.0.0.1:8080/health` →
  `{"ok":true,"protocolVersion":"v1","service":"zkverify-agent-games"}` ✔
- `.env` still holds the TEMP placeholder HMAC secret — the server is
  fail-closed and will only do real work after the real secret is in.
- Season 01 ends **2026-11-21**; live windows run nightly 17:30–03:30 WIB.
  Hosting must be settled fast — days, not weeks, of play remain.

---

## 1. Tunnel tests from this VM (TESTED, with evidence)

This VM's egress goes through an HTTP proxy (`hatch-egress-proxy:3128`).
Direct-TLS tools fail; proxied HTTPS works for most hosts.

| Route | Result | Evidence |
|---|---|---|
| cloudflared quick tunnel | ✗ FAIL (known) | `tls: first record does not look like a TLS handshake` when POSTing to api.trycloudflare.com (`tunnel.log`, 2026-11-15 14:52) |
| localhost.run (SSH `-R`) | ✗ FAIL | TCP connect "succeeded" to a transparent interceptor, SSH handshake reset by peer (`Connection reset by 198.19.0.1 port 3128`) — SSH egress is blocked |
| bore (`bore local 8080 --to bore.pub`, v0.5.3 binary in `~/workspace/tools/`) | ✗ FAIL | `Error: could not connect to bore.pub:7835 — timed out`. Also disqualified by design: bore exposes a raw TCP port (plain HTTP, non-443), which the platform's HTTPS-on-443 rule rejects anyway |
| ngrok (v3.39.13 binary in `~/workspace/tools/`) | ✗ FAIL without an account; promising WITH one | `ERR_NGROK_4018 — authentication failed: ngrok requires an account and a valid credential`. Notably, the agent's TLS **did** reach ngrok's servers (the auth error came back from ngrok), unlike cloudflared — so with a free authtoken it would very likely work. Downsides: free URLs rotate per restart (a free static domain can be claimed on the account), and the URL dies whenever this VM/tunnel dies |
| Tailscale Funnel | ⛔ NOT TESTED — needs the user's account | Binary exists (`/opt/hatch/bin/tailscale`) but `tailscale status` = "Not connected". Authenticating joins the VM to the user's tailnet — his decision, not taken |

## 2. Free always-on hosting from GitHub (documentation-level, checked 2026-11-15)

| Platform | GitHub OAuth signup | Card required | Sleeps? | Public URL shape | Verdict vs the 60 s deadline |
|---|---|---|---|---|---|
| **Deno Deploy** (new, console.deno.com) | Yes | No for signup; **full free quotas need card verification of the org** (unverified orgs get reduced, unpublished limits) | Scales to zero after ~20–30 s idle, but cold start is a fast edge cold start (sub-second to a few seconds), not a minute-long spin-up | `https://<app>.deno.dev` | **Viable — recommended.** Only real work: a small `Deno.serve` entry adapter (see §3). Caveats: service is announced to shut down April 2027 (season ends Nov 2026, so irrelevant); free = 1M req/mo, 20 GiB egress, 10 CPU-h/mo |
| Render (free / Hobby) | Yes | No | **Yes — spins down after 15 min idle, wake ≈ 1 minute** (Render's own FAQ) | `https://<service>.onrender.com` | **Dangerous as-is**: a first task after 15 idle minutes lands on a ~60 s wake against a 60 s hard deadline → likely forfeit. Mitigable: an external keep-warm pinger hitting `/health` every ~10 min (this VM could do it, but the VM itself has died before; 750 free instance-hours/month per workspace ≈ one always-warm service for a 30-day month, just barely). Zero code changes (runs the Node server as-is). Fallback only |
| Koyeb | Yes | **Yes, since Feb 2026** — card with a $29 pre-authorisation hold; new accounts start on the $29/mo Pro plan (downgrade to Starter possible). The old card-free free tier is gone (Koyeb's own pricing page now leads with Pro $29/mo; verified against third-party checks of the pricing FAQ, Sept–Nov 2026) | Free instance scales to zero after 1 h idle; wake reported ~3–5 s | `https://<app>-<org>.koyeb.app` | Technically fine (wake ≪ 60 s) and runs Node as-is, but the card hold breaks the free-first/no-card rule → **user decision, not recommended as first move** |
| Fly.io | Yes | Card required after trial | No sleep on paid; trial machines auto-stop after 5 min | `https://<app>.fly.dev` | ✗ No free tier for new orgs (removed Oct 2024). Trial = $1 credit / 7 days, then card + pay-as-you-go (cheapest always-on ≈ $2.19/mo). Not free |
| Railway | Yes | Post-paid card required | — | `https://<app>.up.railway.app` | ✗ Free tier removed in 2023; $5 trial credit only, then card. Not free |

## 3. Can the agent code run on Deno Deploy? (code read, 2026-11-15)

`src/` (391 lines, zero runtime deps) uses only: `node:http`
(`createServer`, in `index.js`), `node:crypto` (`createHmac`,
`timingSafeEqual`, `randomUUID`), `node:fs` (`existsSync`, prover only),
`node:path`, `node:url`, `process.env`, `process.exit`. No `child_process`
in the server path (snarkjs is an optional dependency, not invoked by the
server code read).

- Deno's Node-compat covers `node:crypto`, `node:path`, `node:url`,
  `node:fs` — `hmac.js`, `gatekeeper.js`, `steal.js`, `idempotency.js`,
  `kurier.js`, `prover.js` should run unchanged.
- The one blocker: **Deno Deploy does not run `node:http` listeners** —
  request handling must enter through `Deno.serve()` / a fetch handler.
  The port is small: `index.js`'s handler logic is framework-free (read raw
  body → route → JSON response with an HMAC header). A ~30–40 line
  `main.ts`/`deno.js` adapter that reads `req.text()`, reuses the existing
  decide/sign modules, and returns a `Response` with the
  `x-agent-games-signature` header is all that's needed. Estimated < 1 h
  including a local Deno smoke test.
- `prover.js`'s `fs.existsSync` on circuit artifacts: on Deploy the
  artifacts simply won't be there, so it returns `proofError` — which is
  **already the behaviour everywhere today** (see §5).

## 4. Recommended route

**Primary: Deno Deploy** (his GitHub `jkislew` OAuth signup, no card for
signup; skip card verification — the reduced unverified quotas are still far
above what one agent endpoint needs for 6 days of play).

Why: it's the only option that is (a) free with no card to start,
(b) HTTPS on 443 with a stable URL, (c) immune to the 60 s deadline
(fast edge cold starts instead of minute-long spin-ups), and (d) independent
of this VM's uptime — the VM dying mid-season no longer kills the endpoint.
Cost: the small `Deno.serve` adapter in §3, plus pushing the repo to GitHub
(Deploy deploys from GitHub).

**Fallback: Render free + keep-warm pinger** — zero code changes, but the
~1-minute wake sits exactly on the deadline; only acceptable with the
pinger running and understood as riskier.

**If he prefers zero code change AND accepts a card hold: Koyeb.**

**Not pursued:** ngrok-with-account (URL/VM fragility), Tailscale Funnel
(needs his tailnet decision), Fly/Railway (not free).

## 5. Pre-existing gaps (independent of hosting — flagging, not fixing here)

1. **Circuit artifacts are not present.** `circuits/` contains only a
   README; `prover.js` therefore answers `proofError` on every Gatekeeper
   task today (it never fabricates a proof — by design). Registration and
   the preflight health check are unaffected, but scored Gatekeeper play
   wants the official artifacts downloaded
   (`https://agentgames.zkverify.io/circuits/gatekeeper.wasm` +
   `gatekeeper_final.zkey`, per `circuits/README.md`) and snarkjs
   available. On Deno Deploy, local proving is not possible (no fs/subprocess
   for snarkjs) — Gatekeeper proofs would stay `proofError` there unless the
   Kurier path is wired instead. This trade-off should be a conscious choice:
   Deno = reliable endpoint for Steal the VFY + Gatekeeper decisions;
   a Node host (Render/Koyeb) = same code *can* prove once artifacts exist.
2. **Steal the VFY strategy is still the explicit HOLD stub** in
   `steal.js`. The strategy must be finalised and its **commitment
   registered in the dashboard before Swiss Round 1** (events page,
   2026-11-15). Note: the events page says **7 Swiss rounds**; the repo
   README says 5 — trust the events page (7) and fix the README when the
   strategy lands.
3. Working tree ≠ commit `2c99ae4`: `src/index.js` has an uncommitted
   one-line change (the `/health` preflight shape patch), and
   `agent-wallet.json` is untracked (mode-600, the agent wallet for this
   project). Commit the patch before any push; **never commit
   `agent-wallet.json` or `.env`** (both are already outside the commit —
   keep it that way; `.env` is gitignored).

## 6. Registration pack (what the user clicks, in his dashboard)

Account is already registered (handle **archietecture1**, GitHub
**jkislew** connected — confirmed by the user 2026-11-15). Remaining steps
are his clicks; Torque cannot do them (dashboard is his session).

**Before the dashboard — repo on GitHub (needed by Deno Deploy, and by the
registration form if it asks for a repo URL):**

- Repo does not exist yet and is not pushed. The GitHub connector in this
  environment cannot create repos (403) and its push tool is text-only.
- Needed: in the cloud browser signed in as **jkislew** (vault login), he
  (or the main agent via a browser task he approves) creates an empty
  **public** repo, suggested name **`zkverify-agent`**, no README/license
  initialisation. Then Torque pushes the local repo (after committing the
  `src/index.js` health patch and confirming `.env` + `agent-wallet.json`
  stay out) and reports the URL: `https://github.com/jkislew/zkverify-agent`.

**Hosting setup (after repo push), his clicks:**

1. Go to `console.deno.com` → sign in with GitHub (`jkislew`) → authorise
   Deno Deploy. **Do not add a card** if asked for org verification — skip;
   reduced quotas are fine.
2. Create a new app/project from the GitHub repo `jkislew/zkverify-agent`
   (entry file = the Deno adapter once Torque has added it — Torque will
   say exactly which file to pick).
3. In the app's environment variables, add `AGENT_GAMES_HMAC_SECRET` —
   **not yet**: the value only exists after agent registration (step below)
   issues it. Add `HMAC_SECRET_ENCODING=utf8` at the same time.
4. Deploy; the public URL will be `https://<app-name>.deno.dev`. The
   endpoint to register is that URL **plus the handler path**:
   `https://<app-name>.deno.dev/agent`.
5. Torque then verifies from outside: `GET /health` returns
   `{ ok: true, protocolVersion: "v1", ... }`.

**Agent registration (dashboard, agentgames.zkverify.io), his clicks:**

1. Dashboard → **My Agents / Manage Agents → Register agent** (wording per
   the public guide; exact labels to be confirmed on screen).
2. **Name:** suggested `archietecture1-gatekeeper` (or simply
   `Torque`). Any name works; it is display-only.
3. **Endpoint URL:** `https://<app-name>.deno.dev/agent` (from hosting
   step 4 — must be the full path, HTTPS, no localhost).
4. **Repo URL:** `https://github.com/jkislew/zkverify-agent` (if the form
   asks).
5. **Tracks:** enter **(01) Proof Gatekeeper** and **(02) Steal the VFY** —
   those are what the built endpoint covers. (03) Wildcard is a separate
   build-submission track and (04) Creator Track is content — neither is
   served by this endpoint.
6. Save → run the platform **preflight**; it must pass against `/health`
   before the agent is marked active.
7. **Steal the VFY only:** Dashboard → My Agents → Edit agent → register
   the **strategy commitment** before Swiss Round 1 starts. Torque must
   finalise the `steal.js` strategy first — the commitment cannot be
   produced from the current HOLD stub.
8. **Rotate Secret** → the dashboard shows the 32-byte HMAC secret
   **exactly once**. Do NOT paste it into chat. Use the Secure Vault
   API-access entry Torque opens for it (or the secure card the main agent
   presents), labelled e.g. "zkVerify Agent Games HMAC secret". Torque
   then writes it into the local `.env` AND the Deno Deploy env var
   (step 3 above), restarts/redeploys, and confirms the endpoint answers
   with valid signatures during Practice mode (Dashboard → Practice sends
   real payloads without score impact — use it before the first live
   round).

**Order of operations (critical path):** commit patch → create repo →
push → Torque writes Deno adapter + smoke-tests → user creates Deno app →
user registers agent with the `.deno.dev/agent` URL → preflight →
Rotate Secret via Secure Vault → Torque sets the secret in both places →
Practice mode check → live rounds (nightly 17:30–03:30 WIB until
2026-11-21).
