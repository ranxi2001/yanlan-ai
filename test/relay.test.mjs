import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createLocalServer, listenLocalServer } from "../server/local.mjs";

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("local relay forwards only same-origin API requests without exposing a public proxy", async () => {
  let received = null;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  const upstreamAddress = await listenLocalServer(upstream, { port: 0 });
  const gateway = createLocalServer();
  const gatewayAddress = await listenLocalServer(gateway, { port: 0 });
  const origin = `http://127.0.0.1:${gatewayAddress.port}`;
  const target = `http://127.0.0.1:${upstreamAddress.port}/v1/responses`;

  try {
    const response = await fetch(`${origin}/api/relay?url=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: { Origin: origin, Authorization: "Bearer test-only", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "example" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(received, { method: "POST", authorization: "Bearer test-only", body: '{"model":"example"}' });

    received = null;
    const forbidden = await fetch(`${origin}/api/relay?url=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    assert.equal(received, null);

    const invalid = await fetch(`${origin}/api/relay?url=${encodeURIComponent("file:///etc/passwd")}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(invalid.status, 400);

    const insecureRemote = await fetch(`${origin}/api/relay?url=${encodeURIComponent("http://api.example/v1")}`, {
      method: "POST",
      headers: { Origin: origin, Authorization: "Bearer must-not-leak", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(insecureRemote.status, 400);
    assert.equal(received, null);

    const status = await fetch(`${origin}/api/relay/status`);
    assert.deepEqual(await status.json(), { ok: true, service: "yanlan-local-relay" });
  } finally {
    await Promise.all([closeServer(gateway), closeServer(upstream)]);
  }
});
