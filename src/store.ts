import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.ts';
import type { Kind } from './schema.ts';
export type Access = { billingKey: string; period: string; expiresAt: string };
type RequestRow = { fingerprint: string; status: string; result: string | null; result_expires: number | null };
const DAY = 86400000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(path: string, dataKey: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.key = Buffer.from(dataKey, 'hex');
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) { this.db.close(); throw new Error('Unsupported database schema version'); }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, consent TEXT);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        billing_key TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','uncertain')),
        result TEXT, result_expires INTEGER, created INTEGER NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, model TEXT,
        PRIMARY KEY(user_id,id)
      );
      CREATE INDEX IF NOT EXISTS requests_quota ON requests(billing_key,period,kind,status);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_subscription ON requests(billing_key) WHERE status='pending';
      PRAGMA user_version=1;
    `);
    // ponytail: one process owns this file; use a job lease before running multiple instances.
    this.db.exec("UPDATE requests SET status='uncertain' WHERE status='pending'");
    this.cleanup();
  }
  digest(value: string) { return createHmac('sha256', this.key).update(value).digest('hex'); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  cleanup() {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    this.db.prepare('DELETE FROM limits WHERE expires <= ?').run(now);
    this.db.prepare('UPDATE requests SET result=NULL, result_expires=NULL WHERE result_expires <= ?').run(now);
    this.db.exec('DELETE FROM users WHERE consent IS NULL AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id=users.id) AND NOT EXISTS (SELECT 1 FROM requests WHERE user_id=users.id)');
  }
  rateLimit(scope: string, identity: string, maximum: number, windowMs: number) {
    const now = Date.now();
    const key = this.digest(`${scope}:${identity}:${Math.floor(now / windowMs)}`);
    const count = this.db.prepare(`INSERT INTO limits(key,count,expires) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).get(key, now + windowMs) as { count: number };
    if (count.count > maximum) throw new HttpError(429, 'rate_limited');
  }
  createSession() {
    return this.transaction(() => {
      const userId = randomUUID();
      this.db.prepare('INSERT INTO users(id) VALUES (?)').run(userId);
      return { userId, ...this.issueToken(userId) };
    });
  }
  issueToken(userId: string) {
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + 90 * DAY;
    this.db.prepare('INSERT INTO sessions(hash,user_id,expires) VALUES (?,?,?)').run(tokenHash(token), userId, expires);
    return { token, expiresAt: new Date(expires).toISOString() };
  }
  authenticate(token: string) {
    const session = this.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires>?').get(tokenHash(token), Date.now()) as { user_id: string } | undefined;
    if (!session) throw new HttpError(401, 'invalid_session');
    return session.user_id;
  }
  rotate(token: string, userId: string) {
    return this.transaction(() => {
      const result = this.issueToken(userId);
      // Brief overlap lets a client recover if the rotation response is lost.
      this.db.prepare('UPDATE sessions SET expires=MIN(expires,?) WHERE hash=?').run(Date.now() + 5 * 60000, tokenHash(token));
      return result;
    });
  }
  setConsent(userId: string, version: string | null) {
    this.db.prepare('UPDATE users SET consent=? WHERE id=?').run(version, userId);
    if (version === null) this.db.prepare('UPDATE requests SET result=NULL,result_expires=NULL WHERE user_id=?').run(userId);
  }
  consent(userId: string) {
    return (this.db.prepare('SELECT consent FROM users WHERE id=?').get(userId) as { consent: string | null }).consent;
  }
  revoke(userId: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      this.setConsent(userId, null);
    });
  }
  replay(userId: string, id: string, fingerprint: string) {
    const row = this.db.prepare('SELECT fingerprint,status,result,result_expires FROM requests WHERE user_id=? AND id=?').get(userId, id) as RequestRow | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, 'request_id_conflict');
    if (row.status !== 'completed') throw new HttpError(409, `request_${row.status}`);
    if (!row.result || !row.result_expires || row.result_expires <= Date.now()) throw new HttpError(410, 'result_expired');
    return this.decrypt(row.result);
  }
  reserve(userId: string, id: string, fingerprint: string, access: Access, kind: Kind, dailyLimit: number) {
    this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM requests WHERE user_id=? AND id=?').get(userId, id)) throw new HttpError(409, 'request_exists');
      if (this.db.prepare("SELECT 1 FROM requests WHERE billing_key=? AND status='pending'").get(access.billingKey)) throw new HttpError(409, 'generation_in_progress');
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE status='pending'").get() as { count: number };
      if (pending.count >= 10) throw new HttpError(503, 'service_busy');
      const used = this.usage(access, kind);
      if (used >= (kind === 'interpretation' ? 30 : 4)) throw new HttpError(429, 'quota_exceeded');
      const today = Math.floor(Date.now() / DAY) * DAY;
      const total = this.db.prepare('SELECT COUNT(*) AS count FROM requests WHERE created>=?').get(today) as { count: number };
      if (total.count >= dailyLimit) throw new HttpError(503, 'daily_budget_reached');
      this.db.prepare(`INSERT INTO requests(user_id,id,fingerprint,billing_key,period,kind,status,created) VALUES (?,?,?,?,?,?,'pending',?)`)
        .run(userId, id, fingerprint, access.billingKey, access.period, kind, Date.now());
    });
  }
  usage(access: Access, kind: Kind) {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE billing_key=? AND period=? AND kind=? AND status!='failed'")
      .get(access.billingKey, access.period, kind) as { count: number }).count;
  }
  complete(userId: string, id: string, result: unknown, usage: { input: number | null; output: number | null }, model: string) {
    // Never recreate a content cache after consent was withdrawn while awaiting the provider.
    const consent = this.consent(userId);
    this.db.prepare("UPDATE requests SET status='completed',result=?,result_expires=?,input_tokens=?,output_tokens=?,model=? WHERE user_id=? AND id=? AND status='pending'")
      .run(consent ? this.encrypt(result) : null, consent ? Date.now() + DAY : null, usage.input, usage.output, model, userId, id);
  }
  fail(userId: string, id: string, uncertain: boolean) {
    this.db.prepare("UPDATE requests SET status=? WHERE user_id=? AND id=? AND status='pending'").run(uncertain ? 'uncertain' : 'failed', userId, id);
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value: string): unknown {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  close() { this.db.close(); }
}
