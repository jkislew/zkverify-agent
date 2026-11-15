// Vercel serverless health endpoint for the zkVerify Agent Games agent.
//
// The Node/Deno shells serve the health shape from the same process as
// the task endpoint (GET /health and GET /). On Vercel each route is
// its own function, so the shape lives here, byte-identical and
// unsigned, exactly as the shells send it:
//
//   GET /api/health -> { ok: true, protocolVersion: 'v1',
//                        service: 'zkverify-agent-games' }
//
// vercel.json additionally rewrites '/' to this function, mirroring
// the shells' GET / behaviour. Any non-GET method gets a bare 405,
// as in the shells.

export default function handler(req, res) {
  if (req.method !== 'GET') { res.status(405); res.end(); return; }
  res.status(200);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, protocolVersion: 'v1', service: 'zkverify-agent-games' }));
}
