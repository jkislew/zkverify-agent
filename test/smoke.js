// Live smoke test: boots the server on a scratch port and exercises the
// health route, a signed gatekeeper task, a bad-signature rejection, and
// idempotent redelivery. Run with: npm run smoke
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = 18099;
const SECRET = 'smoke-secret-local-only';
const env = { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET };
const child = spawn('node', ['src/index.js'], { env, stdio: 'pipe' });
const sign = (raw) => crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(raw).digest('hex');

try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  });
  const base = `http://127.0.0.1:${PORT}`;
  const health = await (await fetch(`${base}/health`)).json();
  if (!health.ok) throw new Error('health check failed');

  const task = {
    taskId: 'smoke-1',
    condition: { balance: 1460, minBalance: 1000, maxAmount: 1000, expectedRecipient: '0xR', currentBlock: 10, expiryBlock: 99 },
    transfer: { amount: 500, recipient: '0xR' },
  };
  const raw = JSON.stringify(task);
  const res1 = await fetch(`${base}/agent`, {
    method: 'POST', headers: { 'x-agent-games-signature': sign(raw) }, body: raw,
  });
  const body1 = await res1.json();
  if (body1.decision !== 'APPROVE') throw new Error(`expected APPROVE, got ${JSON.stringify(body1)}`);
  if (!res1.headers.get('x-agent-games-signature')) throw new Error('response not signed');

  const res2 = await fetch(`${base}/agent`, {
    method: 'POST', headers: { 'x-agent-games-signature': sign(raw) }, body: raw,
  });
  const body2 = await res2.json();
  if (JSON.stringify(body2) !== JSON.stringify(body1)) throw new Error('redelivery not idempotent');

  const res3 = await fetch(`${base}/agent`, {
    method: 'POST', headers: { 'x-agent-games-signature': 'f'.repeat(64) }, body: raw,
  });
  if (res3.status !== 401) throw new Error(`expected 401 for bad signature, got ${res3.status}`);

  console.log('smoke test passed: health, signed APPROVE, signed response, idempotent retry, 401 on forgery');
} finally {
  child.kill();
}
