import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { createServices } from './services.ts';
import { Store } from './store.ts';
const config = readConfig();
process.umask(0o077);
const store = new Store(config.DATABASE_PATH, config.DATA_KEY);
const app = createApp(config, store, createServices(config, store));
const cleanup = setInterval(() => store.cleanup(), 10 * 60000);
cleanup.unref();
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(JSON.stringify({ event: 'listening', host: config.HOST, port: config.PORT }));
});
function shutdown() {
  clearInterval(cleanup);
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 65000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
