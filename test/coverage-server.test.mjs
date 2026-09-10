import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalServer, listenLocalServer } from '../server/local.mjs';

test('local coverage endpoint validates origin, method, payload and does not expose worker errors', async () => {
  let calls = 0, closed = false;
  const server = createLocalServer({ coverageWorker: { close() { closed = true; }, async scout(bytes, lengths) {
    calls++; assert.equal(bytes.length, 320); assert.deepEqual(lengths, [160]);
    if (calls > 1) throw new Error('private model path and audio');
    return { model: 'sensevoice-small-int8', parts: [{ text: '测试', pcm_sha256: 'hash' }] };
  } } });
  const address = await listenLocalServer(server, { port: 0 });
  const origin = `http://127.0.0.1:${address.port}`, url = origin + '/api/coverage/scout';
  const post = (headers = {}, body = new Uint8Array(320)) => fetch(url, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/octet-stream', 'X-Coverage-Parts': '160', ...headers }, body });
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await post({ Origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ 'Content-Type': 'application/json' })).status, 415);
    assert.equal((await post({ 'X-Coverage-Parts': '161' })).status, 400);
    assert.equal((await post({}, new Uint8Array(960002))).status, 413);
    assert.equal(calls, 0);
    assert.equal((await post()).status, 200);
    const failure = await post();
    assert.equal(failure.status, 503);
    assert.ok(!(await failure.text()).includes('private'));
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.ok(closed);
});
