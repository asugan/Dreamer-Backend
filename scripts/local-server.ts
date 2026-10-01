// Separate local harness: production server never imports this file.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { createServices } from '../src/services.ts';
import { Store } from '../src/store.ts';
if (process.env.NODE_ENV === 'production') throw new Error('Local mock server cannot run in production');
process.umask(0o077);
mkdirSync('data/local', { recursive: true });
const keyFile = 'data/local/key';
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const testProduct = process.env.REVENUECAT_TEST_PRODUCT_ID?.trim();
const config = readConfig({
  ...process.env,
  HOST: process.env.LOCAL_HOST || '127.0.0.1', PORT: process.env.LOCAL_PORT || '3002',
  DATABASE_PATH: 'data/local/journal.sqlite', DATA_KEY: readFileSync(keyFile, 'utf8').trim(),
  REVENUECAT_SECRET_KEY: testProduct ? process.env.REVENUECAT_SECRET_KEY : 'unused',
  REVENUECAT_MONTHLY_PRODUCT_ID: testProduct || 'local-monthly',
  TRUST_PROXY: undefined,
});
const store = new Store(config.DATABASE_PATH, config.DATA_KEY, {
  interpretation: Number(process.env.LOCAL_INTERPRETATION_LIMIT || 30),
  weekly: Number(process.env.LOCAL_WEEKLY_LIMIT || 4),
});
const realServices = createServices(config, store, fetch, !!testProduct);
const services = testProduct ? realServices : {
  ...realServices,
  // Only membership is simulated; generation uses the production CLIProxy HTTP client.
  async access(userId: string) {
    return { billingKey: store.digest(`local:${userId}`), period: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  },
};
const server = createApp(config, store, services).listen(config.PORT, config.HOST);
server.once('listening', () => {
  console.log(`LOCAL DEVELOPMENT: http://${config.HOST}:${(server.address() as { port: number }).port} — ${testProduct ? "RevenueCat Test Store verification" : "simulated membership"}; real CLIProxy AI requests; no payments`);
});
server.once('error', (error: NodeJS.ErrnoException) => {
  console.error(`Local backend could not listen on ${config.HOST}:${config.PORT}: ${error.code ?? 'listen_error'}`);
  store.close();
  process.exit(1);
});
const cleanup = setInterval(() => store.cleanup(), 600000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(cleanup); server.close(() => { store.close(); process.exit(0); });
});
