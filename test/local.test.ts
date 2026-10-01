import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
test('local membership simulation uses real CLIProxy HTTP client for dreams and weekly results', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dreamer-local-'));
  const script = fileURLToPath(new URL('../scripts/local-server.ts', import.meta.url));
  let proxyCalls = 0;
  const proxy = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-proxy-key');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(payload.model, 'test-proxy-model');
    assert.equal(payload.stream, false);
    const input = JSON.parse(payload.messages[1].content);
    proxyCalls++;
    const raw = input.dream ? {
      title: 'Proxy test reply', summary: 'Reply delivered over HTTP.', themes: [],
      meaning: 'Provider response.', question: 'How did it feel?', connectionId: null, connection: null, safety: 'reflection',
    } : { title: 'Proxy test week', summary: 'Weekly reply delivered over HTTP.', question: 'What repeats?', sourceIds: input.entries.map((e: { id: string }) => e.id), insights: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: 'stop' }] }));
  }).listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  const blocked = spawn(process.execPath, ['--experimental-strip-types', script], { cwd, env: {
    ...process.env, NODE_ENV: 'development', LOCAL_HOST: '127.0.0.1', LOCAL_PORT: String(port),
    CLIPROXY_API_KEY: 'test-proxy-key', CLIPROXY_MODEL: 'test-proxy-model', REVENUECAT_TEST_PRODUCT_ID: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let blockedError = '';
  let blockedOutput = '';
  blocked.stderr.on('data', data => { blockedError += String(data); });
  blocked.stdout.on('data', data => { blockedOutput += String(data); });
  const [blockedCode] = await once(blocked, 'exit');
  assert.equal(blockedCode, 1);
  assert.match(blockedError, /EADDRINUSE/);
  assert.doesNotMatch(blockedError, /TypeError/);
  assert.doesNotMatch(blockedOutput, /LOCAL DEVELOPMENT/);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', script], { cwd, env: {
    ...process.env, NODE_ENV: 'development', LOCAL_HOST: '127.0.0.1', LOCAL_PORT: String(port),
    CLIPROXY_BASE_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`,
    CLIPROXY_API_KEY: 'test-proxy-key', CLIPROXY_MODEL: 'test-proxy-model', REVENUECAT_TEST_PRODUCT_ID: '',
    LOCAL_INTERPRETATION_LIMIT: '2', LOCAL_WEEKLY_LIMIT: '1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Local harness startup timeout')), 10000);
      child.stdout.on('data', data => { const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(data)); if (match) { clearTimeout(timer); resolve(match[0]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Local harness exited before startup')); });
    });
    let token = '';
    const call = (path: string, body?: unknown, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await call('/v1/membership', undefined, 'GET')).status, 401);
    token = (await (await call('/v1/sessions', {})).json()).token;
    assert.equal((await call('/v1/membership', undefined, 'GET')).status, 200);
    const dream = { requestId: randomUUID(), dream: { id: 'one', date: '2026-10-01', text: 'A lake.', context: '' } };
    assert.equal((await call('/v1/interpretations', dream)).status, 403);
    assert.equal((await call('/v1/consent', { granted: true, version: '2026-10-01-evidence-v1' }, 'PUT')).status, 204);
    const first = await (await call('/v1/interpretations', dream)).json();
    assert.equal(first.result.sourceText, 'A lake.');
    assert.equal(first.result.title, 'Proxy test reply');
    assert.equal(proxyCalls, 1);
    assert.equal(first.cached, false);
    assert.equal((await (await call('/v1/interpretations', dream)).json()).cached, true);
    assert.equal(proxyCalls, 1, 'Replay must not contact the proxy again');
    const week = { requestId: randomUUID(), entries: ['one', 'two', 'three'].map(id => ({ id, date: '2026-10-01', summary: 'A lake.', themes: ['Calm'], themeDetails: [], context: '' })) };
    const weekly = await (await call('/v1/weekly', week)).json();
    assert.deepEqual(weekly.result.sourceIds, ['one', 'two', 'three']);
    assert.equal(weekly.result.title, 'Proxy test week');
    assert.equal(proxyCalls, 2);
    assert.equal((await call('/v1/interpretations', { ...dream, requestId: randomUUID() })).status, 200);
    for (const [path, body] of [['/v1/interpretations', dream], ['/v1/weekly', week]] as const) {
      const rejected = await call(path, { ...body, requestId: randomUUID() });
      assert.equal(rejected.status, 429, 'Quota must be enforced without refreshing membership');
      assert.equal((await rejected.json()).error, 'quota_exceeded');
    }
    assert.equal(proxyCalls, 3, 'Over-quota requests must not contact the AI provider');
    const usage = (await (await call('/v1/membership', undefined, 'GET')).json()).usage;
    assert.deepEqual(usage, { interpretations: { used: 2, limit: 2 }, weekly: { used: 1, limit: 1 } });
  } finally { child.kill('SIGTERM'); await exited; await new Promise<void>(resolve => proxy.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }); }
  const rejected = spawn(process.execPath, ['--experimental-strip-types', script], { env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
  const [code] = await once(rejected, 'exit');
  assert.notEqual(code, 0, 'Production must reject the local harness');
});
