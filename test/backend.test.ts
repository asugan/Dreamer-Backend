import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import { CONSENT_VERSION, interpretationInput, weeklyInput, validateResult } from '../src/schema.ts';
import { createServices } from '../src/services.ts';
import { Store } from '../src/store.ts';
const config: Config = {
  HOST: '127.0.0.1', PORT: 3001, DATABASE_PATH: ':memory:', DATA_KEY: 'a'.repeat(64),
  CLIPROXY_BASE_URL: 'http://proxy.test/v1', CLIPROXY_API_KEY: 'proxy-secret', CLIPROXY_MODEL: 'configured-model',
  REVENUECAT_SECRET_KEY: 'rc-secret', REVENUECAT_ENTITLEMENT: 'premium', REVENUECAT_MONTHLY_PRODUCT_ID: 'monthly',
  ALLOW_SANDBOX: 'false', DAILY_GENERATION_LIMIT: 200,
};
const input = () => ({ requestId: randomUUID(), dream: { id: 'dream-1', date: '2026-10-01', text: 'I walked beside a quiet lake.', context: '' }, history: [] });
const result = { title: 'A quiet lake', summary: 'You walked beside a lake.', themes: [{ name: 'Calm', detail: 'The quiet water may suggest calm.', icon: 'water' }], meaning: 'It might reflect a wish for stillness.', question: 'How did the lake feel?', connectionId: null, connection: null, safety: 'reflection' };
const start = new Date(Date.now() - 86400000).toISOString();
const end = new Date(Date.now() + 30 * 86400000).toISOString();
function customer(overrides = {}) {
  return { subscriber: { entitlements: { premium: { product_identifier: 'monthly', expires_date: end } }, subscriptions: { monthly: {
    purchase_date: start, expires_date: end, grace_period_expires_date: null, refunded_at: null,
    is_sandbox: false, store: 'app_store', store_transaction_id: 'transaction-1', ownership_type: 'PURCHASED', ...overrides,
  } } } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const access = { billingKey: 'verified-transaction', period: start, expiresAt: end };
const code = (value: string) => (error: unknown) => error instanceof HttpError && error.code === value;

test('HTTP flow: authentication, consent, RevenueCat, proxy contract, replay and revocation', async () => {
  const store = new Store(':memory:', config.DATA_KEY);
  let generations = 0;
  let rcCalls = 0;
  let mode = 'valid';
  const upstream: typeof fetch = async (url, options) => {
    if (String(url).startsWith('https://api.revenuecat.com/')) {
      rcCalls++;
      assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer rc-secret');
      return json(customer());
    }
    generations++;
    assert.equal(String(url), 'http://proxy.test/v1/chat/completions');
    assert.equal((options?.headers as Record<string,string>).Authorization, 'Bearer proxy-secret');
    const payload = JSON.parse(options?.body as string);
    assert.equal(payload.model, 'configured-model');
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 2000);
    assert.equal(payload.messages[0].role, 'system');
    if (mode === 'network') throw new Error('Network interrupted');
    const data = JSON.parse(payload.messages[1].content);
    const reply = mode === 'invalid' ? { ...result, connectionId: 'invented' } : data.entries
      ? { title: 'A quiet week', summary: 'Calm appeared in these entries.', question: 'What felt peaceful?', sourceIds: data.entries.map((e: { id: string }) => e.id), insights: [{ kind: 'repeat', theme: 'Calm', detail: 'Quiet appeared in the supplied summaries.', evidence: data.entries.slice(0, 2).map((e: { id: string; summary: string }) => ({ entryId: e.id, quote: e.summary })) }] }
      : result;
    return json({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  };
  const server = createApp(config, store, createServices(config, store, upstream)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, token?: string, method = 'POST') => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await call('/v1/interpretations', input())).status, 401);
    const created = await call('/v1/sessions', {});
    assert.equal(created.status, 201);
    const session = await created.json() as { userId: string; token: string };
    assert.notEqual(session.userId, session.token);
    assert.equal((await call('/v1/interpretations', input(), session.token)).status, 403);
    assert.equal(generations, 0);
    assert.equal((await call('/v1/consent', { granted: true, version: CONSENT_VERSION }, session.token, 'PUT')).status, 204);
    const body = input();
    const first = await call('/v1/interpretations', body, session.token);
    assert.equal(first.status, 200);
    const output = await first.json();
    assert.equal(output.result.sourceText, body.dream.text);
    assert.equal(output.cached, false);
    const retry = await call('/v1/interpretations', body, session.token);
    assert.equal((await retry.json()).cached, true);
    assert.equal(generations, 1);
    assert.equal(rcCalls, 1);
    assert.equal((await call('/v1/interpretations', { ...body, dream: { ...body.dream, text: 'Changed' } }, session.token)).status, 409);
    const row = store.db.prepare('SELECT result,fingerprint,input_tokens FROM requests').get() as { result: string; fingerprint: string; input_tokens: number };
    assert.ok(!row.result.includes('quiet lake'));
    assert.ok(!row.fingerprint.includes('quiet lake'));
    assert.equal(row.input_tokens, 100);
    const membership = await call('/v1/membership', undefined, session.token, 'GET');
    assert.equal((await membership.json()).usage.interpretations.used, 1);
    const week = { requestId: randomUUID(), entries: ['a', 'b', 'c'].map(id => ({ id, date: '2026-10-01', summary: 'A quiet dream', themes: ['Calm'], themeDetails: [], context: '' })) };
    const weekly = await call('/v1/weekly', week, session.token);
    assert.equal(weekly.status, 200);
    const weeklyOutput = (await weekly.json()).result;
    assert.deepEqual(weeklyOutput.sourceIds, ['a', 'b', 'c']);
    assert.equal(weeklyOutput.insights[0].theme, 'Calm');
    assert.deepEqual(weeklyOutput.insights[0].evidence.map((e: { entryId: string }) => e.entryId), ['a', 'b']);
    mode = 'invalid';
    const invalid = await call('/v1/interpretations', input(), session.token);
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).error, 'generation_failed');
    const afterFailure = await call('/v1/membership', undefined, session.token, 'GET');
    assert.equal((await afterFailure.json()).usage.interpretations.used, 1);
    mode = 'network';
    const ambiguousBody = input();
    const ambiguous = await call('/v1/interpretations', ambiguousBody, session.token);
    assert.equal((await ambiguous.json()).error, 'generation_uncertain');
    const afterNetwork = await call('/v1/membership', undefined, session.token, 'GET');
    assert.equal((await afterNetwork.json()).usage.interpretations.used, 2);
    const count = generations;
    assert.equal((await call('/v1/interpretations', ambiguousBody, session.token)).status, 409);
    assert.equal(generations, count);
    assert.equal((await call('/v1/interpretations', { ...input(), premium: true }, session.token)).status, 400);
    assert.equal((await call('/v1/consent', { granted: false, version: CONSENT_VERSION }, session.token, 'PUT')).status, 204);
    assert.equal((await call('/v1/interpretations', body, session.token)).status, 403);
    assert.equal((store.db.prepare('SELECT result FROM requests').get() as { result: unknown }).result, null);
    assert.equal((await call('/v1/session', undefined, session.token, 'DELETE')).status, 204);
    assert.equal((await call('/v1/membership', undefined, session.token, 'GET')).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});

test('quota is shared across restored identities, retries cannot consume twice, failure releases reservation', () => {
  const store = new Store(':memory:', config.DATA_KEY);
  try {
    const a = store.createSession(); const b = store.createSession();
    const id = randomUUID();
    store.reserve(a.userId, id, 'fingerprint', access, 'interpretation', 200);
    assert.throws(() => store.reserve(b.userId, randomUUID(), 'other', access, 'interpretation', 200), code('generation_in_progress'));
    assert.throws(() => store.replay(a.userId, id, 'fingerprint'), code('request_pending'));
    store.fail(a.userId, id, false);
    assert.equal(store.usage(access, 'interpretation'), 0);
    assert.throws(() => store.reserve(a.userId, id, 'fingerprint', access, 'interpretation', 200), code('request_exists'));
    for (let i = 0; i < 30; i++) {
      const requestId = randomUUID();
      store.reserve(a.userId, requestId, 'fingerprint', access, 'interpretation', 200);
      store.complete(a.userId, requestId, result, { input: 1, output: 1 }, 'model');
    }
    assert.throws(() => store.reserve(b.userId, randomUUID(), 'f', access, 'interpretation', 200), code('quota_exceeded'));
    store.reserve(b.userId, randomUUID(), 'f', { ...access, period: end }, 'interpretation', 200);
  } finally { store.close(); }
});

test('uncertain generation stays charged; restart never regenerates it; encrypted response expires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreamer-test-')); const path = join(dir, 'test.sqlite');
  let store = new Store(path, config.DATA_KEY);
  try {
    const session = store.createSession(); const id = randomUUID();
    store.reserve(session.userId, id, 'f', access, 'interpretation', 200);
    store.close(); store = new Store(path, config.DATA_KEY);
    assert.throws(() => store.replay(session.userId, id, 'f'), code('request_uncertain'));
    assert.equal(store.usage(access, 'interpretation'), 1);
    store.setConsent(session.userId, CONSENT_VERSION);
    const completed = randomUUID();
    store.reserve(session.userId, completed, 'f', access, 'interpretation', 200);
    store.complete(session.userId, completed, result, { input: null, output: null }, 'model');
    assert.deepEqual(store.replay(session.userId, completed, 'f'), result);
    store.db.prepare('UPDATE requests SET result_expires=? WHERE id=?').run(Date.now()-1, completed);
    store.cleanup();
    assert.throws(() => store.replay(session.userId, completed, 'f'), code('result_expired'));
    assert.equal(store.usage(access, 'interpretation'), 2);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('RevenueCat rejects expiry, refund, sandbox, shared/promo access and missing transaction; allows verified grace', async () => {
  const store = new Store(':memory:', config.DATA_KEY);
  try {
    for (const overrides of [
      { expires_date: start }, { refunded_at: start }, { is_sandbox: true },
      { ownership_type: 'FAMILY_SHARED' }, { store: 'promotional' }, { store_transaction_id: null },
    ]) {
      const service = createServices(config, store, async () => json(customer(overrides)));
      await assert.rejects(service.access('server-issued-id'), code('subscription_required'));
    }
    const service = createServices(config, store, async () => json(customer({ expires_date: start, grace_period_expires_date: end })));
    const a = await service.access('original-user'); const b = await service.access('restored-user');
    assert.deepEqual(a, b);
    const broken = createServices(config, store, async () => json({}, 500));
    await assert.rejects(broken.access('id'), code('subscription_service_unavailable'));
  } finally { store.close(); }
});

test('schema guards text limits, weekly thresholds, duplicate IDs and invented history references', () => {
  assert.equal(interpretationInput.safeParse({ ...input(), dream: { ...input().dream, text: 'a'.repeat(8001) } }).success, false);
  const entry = { id: 'old', date: '2026-10-01', summary: 'A dream.', themes: ['Calm'], themeDetails: [], context: '' };
  assert.equal(weeklyInput.safeParse({ requestId: randomUUID(), entries: [entry, entry, entry] }).success, false);
  assert.equal(weeklyInput.safeParse({ requestId: randomUUID(), entries: [entry] }).success, false);
  const data = interpretationInput.parse(input());
  assert.throws(() => validateResult('interpretation', { ...result, connectionId: 'invented' }, data));
  const week = weeklyInput.parse({ requestId: randomUUID(), entries: [entry, { ...entry, id: 'b' }, { ...entry, id: 'c' }] });
  assert.throws(() => validateResult('weekly', { title: 'Week', summary: 'A reflection', question: 'How?', sourceIds: ['old', 'b', 'invented'], insights: [] }, week));
  assert.equal(weeklyInput.safeParse({ ...week, entries: [entry, { ...entry, id: 'b', date: '2026-09-24' }, { ...entry, id: 'c' }] }).success, false);
});

test('provider invalid output releases quota, network ambiguity is classified conservatively', async () => {
  const store = new Store(':memory:', config.DATA_KEY);
  try {
    const truncated = createServices(config, store, async () => json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }));
    await assert.rejects(truncated.generate('interpretation', interpretationInput.parse(input())), (e: unknown) => e instanceof Error && 'uncertain' in e && e.uncertain === false);
    const timeout = createServices(config, store, async () => { throw new Error('network'); });
    await assert.rejects(timeout.generate('interpretation', interpretationInput.parse(input())), (e: unknown) => e instanceof Error && 'uncertain' in e && e.uncertain === true);
  } finally { store.close(); }
});

test('session renewal, durable rate limits, daily cap and consent withdrawal during generation', () => {
  const store = new Store(':memory:', config.DATA_KEY);
  try {
    const a = store.createSession();
    assert.throws(() => store.authenticate(a.userId), code('invalid_session'));
    const renewed = store.rotate(a.token, a.userId);
    assert.equal(store.authenticate(renewed.token), a.userId);
    store.db.prepare('UPDATE sessions SET expires=0 WHERE expires<?').run(Date.now()+10*60000);
    assert.throws(() => store.authenticate(a.token), code('invalid_session'));
    store.rateLimit('test', 'ip', 1, 60000);
    assert.throws(() => store.rateLimit('test', 'ip', 1, 60000), code('rate_limited'));
    store.setConsent(a.userId, CONSENT_VERSION);
    const id = randomUUID();
    store.reserve(a.userId, id, 'f', access, 'weekly', 1);
    store.setConsent(a.userId, null);
    store.complete(a.userId, id, result, { input: null, output: null }, 'model');
    assert.equal((store.db.prepare('SELECT result FROM requests').get() as { result: unknown }).result, null);
    assert.throws(() => store.reserve(a.userId, randomUUID(), 'f', access, 'weekly', 1), code('daily_budget_reached'));
  } finally { store.close(); }
});


test('Test Store verification requires explicit local mode and shares real quota accounting', async () => {
  const store = new Store(':memory:', config.DATA_KEY);
  const testConfig = { ...config, REVENUECAT_MONTHLY_PRODUCT_ID: 'monthly' };
  try {
    const reply = customer({ store: 'test_store', is_sandbox: true });
    const upstream: typeof fetch = async (url, options) => {
      assert.equal(String(url), 'https://api.revenuecat.com/v1/subscribers/guest-id');
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer rc-secret');
      return json(reply);
    };
    await assert.rejects(createServices(testConfig, store, upstream).access('guest-id'), code('subscription_required'));
    const service = createServices(testConfig, store, upstream, true);
    const a = await service.access('guest-id');
    assert.equal(a.billingKey, store.digest('test_store:transaction-1'));
    assert.equal(a.period, start);
    const user = store.createSession();
    store.setConsent(user.userId, CONSENT_VERSION);
    for (const [kind, limit] of [['interpretation', 30], ['weekly', 4]] as const) {
      for (let i = 0; i < limit; i++) {
        const id = randomUUID();
        store.reserve(user.userId, id, 'fingerprint', a, kind, 200);
        store.complete(user.userId, id, result, { input: null, output: null }, 'test');
      }
      assert.equal(store.usage(a, kind), limit);
      assert.throws(() => store.reserve(user.userId, randomUUID(), 'fingerprint', a, kind, 200), code('quota_exceeded'));
    }
    for (const overrides of [
      { store: 'app_store' }, { is_sandbox: false }, { expires_date: start },
      { store_transaction_id: null }, { refunded_at: start }, { ownership_type: 'FAMILY_SHARED' },
    ]) {
      const invalid = createServices(testConfig, store, async () => json(customer({ store: 'test_store', is_sandbox: true, ...overrides })), true);
      await assert.rejects(invalid.access('guest-id'), code('subscription_required'));
    }
  } finally { store.close(); }
});


test('lower local quotas reject the next request while defaults stay at 30 / 4', () => {
  const normal = new Store(':memory:', config.DATA_KEY);
  const local = new Store(':memory:', config.DATA_KEY, { interpretation: 2, weekly: 1 });
  try {
    assert.deepEqual(normal.quota, { interpretation: 30, weekly: 4 });
    const user = local.createSession();
    local.setConsent(user.userId, CONSENT_VERSION);
    for (const [kind, limit] of [['interpretation', 2], ['weekly', 1]] as const) {
      for (let i = 0; i < limit; i++) {
        const id = randomUUID();
        local.reserve(user.userId, id, 'fingerprint', access, kind, 200);
        local.complete(user.userId, id, result, { input: null, output: null }, 'test');
        assert.deepEqual(local.replay(user.userId, id, 'fingerprint'), result);
      }
      assert.throws(() => local.reserve(user.userId, randomUUID(), 'fingerprint', access, kind, 200), code('quota_exceeded'));
    }
    assert.throws(() => new Store(':memory:', config.DATA_KEY, { interpretation: 0, weekly: 1 }), /Invalid quota/);
  } finally { normal.close(); local.close(); }
});


test('actual Test Store shape omits ownership; App Store still requires it', async () => {
  const store = new Store(':memory:', config.DATA_KEY);
  try {
    const response = customer({ store: 'test_store', is_sandbox: true });
    delete (response.subscriber.subscriptions.monthly as { ownership_type?: string }).ownership_type;
    const service = createServices(config, store, async () => json(response), true);
    const verified = await service.access('guest-id');
    assert.equal(verified.billingKey, store.digest('test_store:transaction-1'));
    assert.equal(verified.expiresAt, end);
    const appStoreResponse = customer();
    delete (appStoreResponse.subscriber.subscriptions.monthly as { ownership_type?: string }).ownership_type;
    const productionService = createServices(config, store, async () => json(appStoreResponse));
    await assert.rejects(productionService.access('guest-id'), code('subscription_required'));
    const shared = createServices(config, store, async () => json(customer({ store: 'test_store', is_sandbox: true, ownership_type: 'FAMILY_SHARED' })), true);
    await assert.rejects(shared.access('guest-id'), code('subscription_required'));
  } finally { store.close(); }
});


test('connections and weekly insights require exact evidence and consistent canonical themes', () => {
  const past = { id: 'past', date: '2026-09-30', summary: 'You rested beside quiet water.', themes: ['Calm'],
    themeDetails: ['Quiet water may suggest calm.'], mood: 'Peaceful', context: 'A restful weekend.' };
  const data = interpretationInput.parse({ ...input(), history: [past] });
  const linked = { ...result, connectionId: 'past', connection: { currentEvidence: 'quiet lake', pastEvidence: 'quiet water',
    sharedDetail: 'Both records mention quiet waters; perhaps stillness matters to you.', difference: null } };
  assert.equal(validateResult('interpretation', linked, data).connectionId, 'past');
  assert.throws(() => validateResult('interpretation', { ...linked, connection: null }, data));
  for (const evidence of [
    { pastEvidence: 'invented details' },
    { currentEvidence: 'You wrote, “quiet lake.”' },
    { pastEvidence: 'An earlier AI reflection summarized, “quiet water.”' },
  ]) {
    const unlinked = validateResult('interpretation', { ...linked, connection: { ...linked.connection, ...evidence } }, data);
    assert.equal(unlinked.connectionId, null);
    assert.equal(unlinked.connection, null);
    assert.equal(unlinked.meaning, result.meaning);
  }
  assert.throws(() => validateResult('interpretation', { ...linked, connectionId: null }, data));
  assert.throws(() => validateResult('interpretation', { ...result, themes: [{ ...result.themes[0], name: 'New model label' }] }, data));
  assert.throws(() => validateResult('interpretation', { ...linked, safety: 'support' }, data));
  const week = weeklyInput.parse({ requestId: randomUUID(), entries: [past, { ...past, id: 'second', mood: 'Curious' },
    { ...past, id: 'third', themes: ['Exploration'] }] });
  const reflection = { title: 'Recorded period', summary: 'Quiet water appeared twice.', question: 'What did the water feel like?',
    sourceIds: ['past', 'second', 'third'], insights: [{ kind: 'repeat', theme: 'Calm', detail: 'The first two summaries mention quiet water.',
      evidence: [{ entryId: 'past', quote: 'quiet water' }, { entryId: 'second', quote: 'quiet water' }] }] };
  assert.equal(validateResult('weekly', reflection, week).insights.length, 1);
  assert.throws(() => validateResult('weekly', { ...reflection, insights: [{ ...reflection.insights[0], theme: 'Loss' }] }, week));
  assert.throws(() => validateResult('weekly', { ...reflection, insights: [{ ...reflection.insights[0], evidence: [{ entryId: 'past', quote: 'quiet water' }] }] }, week));
  assert.throws(() => validateResult('weekly', { ...reflection, insights: [{ ...reflection.insights[0], evidence: [{ entryId: 'past', quote: 'quiet water' }, { entryId: 'past', quote: 'quiet water' }] }] }, week));
  assert.throws(() => validateResult('weekly', { ...reflection, insights: [{ ...reflection.insights[0], evidence: [{ entryId: 'past', quote: 'quiet water' }, { entryId: 'second', quote: 'fabricated quote' }] }] }, week));
  const difference = { kind: 'difference', theme: null, detail: 'Reported moods differ.', evidence: [{ entryId: 'past', quote: 'Peaceful' }, { entryId: 'second', quote: 'Curious' }] };
  assert.equal(validateResult('weekly', { ...reflection, insights: [difference] }, week).insights[0].kind, 'difference');
  assert.equal(validateResult('weekly', { ...reflection, insights: [] }, week).insights.length, 0, 'No pattern is valid');
  const { connection: omittedConnection, ...incompleteResult } = result;
  void omittedConnection;
  assert.throws(() => validateResult('interpretation', incompleteResult, data), 'Current result contract is required');
  const { insights: omittedInsights, ...incompleteWeek } = reflection;
  void omittedInsights;
  assert.throws(() => validateResult('weekly', incompleteWeek, week));
  const { themeDetails: omittedDetails, ...incompleteHistory } = past;
  void omittedDetails;
  assert.equal(weeklyInput.safeParse({ ...week, entries: [incompleteHistory, week.entries[1], week.entries[2]] }).success, false);
  assert.equal(weeklyInput.safeParse({ ...week, entries: [{ ...past, themes: ['Searching for familiarity'] }, week.entries[1], week.entries[2]] }).success, false);

});
