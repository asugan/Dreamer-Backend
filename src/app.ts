import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Config } from './config.ts';
import { GenerationError, HttpError } from './errors.ts';
import { CONSENT_VERSION, interpretationInput, weeklyInput, validateResult, type Kind } from './schema.ts';
import type { Services } from './services.ts';
import type { Store } from './store.ts';
export function createApp(config: Config, store: Store, services: Services) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY.split(',').map(s => s.trim()));
  app.use(helmet());
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/health', (_req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.use('/v1', (req, _res, next) => { store.rateLimit('ip', req.ip ?? 'unknown', 120, 60000); next(); });
  app.use(express.json({ limit: '48kb', strict: true }));
  app.post('/v1/sessions', (req, res) => {
    z.object({}).strict().parse(req.body);
    store.rateLimit('registration', req.ip ?? 'unknown', 10, 3600000);
    store.rateLimit('registration-global', 'all', 1000, 86400000);
    res.status(201).json({ ...store.createSession(), consentVersion: CONSENT_VERSION });
  });
  app.use('/v1', (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '');
    if (!match) throw new HttpError(401, 'invalid_session');
    res.locals.token = match[1];
    res.locals.userId = store.authenticate(match[1]);
    store.rateLimit('user', res.locals.userId, 60, 60000);
    next();
  });
  app.post('/v1/session/renew', (_req, res) => {
    store.rateLimit('renewal', res.locals.userId, 5, 3600000);
    res.json(store.rotate(res.locals.token, res.locals.userId));
  });
  app.delete('/v1/session', (_req, res) => { store.revoke(res.locals.userId); res.sendStatus(204); });
  app.put('/v1/consent', (req, res) => {
    const body = z.object({ granted: z.boolean(), version: z.literal(CONSENT_VERSION) }).strict().parse(req.body);
    store.setConsent(res.locals.userId, body.granted ? body.version : null);
    res.sendStatus(204);
  });
  app.get('/v1/membership', async (_req, res) => {
    const access = await services.access(res.locals.userId);
    res.json({ active: true, expiresAt: access.expiresAt, usage: {
      interpretations: { used: store.usage(access, 'interpretation'), limit: 30 },
      weekly: { used: store.usage(access, 'weekly'), limit: 4 },
    } });
  });
  async function generate(kind: Kind, req: Request, res: Response) {
    const input = kind === 'interpretation' ? interpretationInput.parse(req.body) : weeklyInput.parse(req.body);
    const userId = res.locals.userId as string;
    if (store.consent(userId) !== CONSENT_VERSION) throw new HttpError(403, 'consent_required');
    const fingerprint = store.digest(JSON.stringify({ kind, input }));
    const cached = store.replay(userId, input.requestId, fingerprint);
    if (cached !== undefined) { res.json({ requestId: input.requestId, cached: true, result: cached }); return; }
    const access = await services.access(userId);
    // Consent/session can change while RevenueCat is answering.
    store.authenticate(res.locals.token);
    if (store.consent(userId) !== CONSENT_VERSION) throw new HttpError(403, 'consent_required');
    store.rateLimit('generation', userId, 10, 3600000);
    store.reserve(userId, input.requestId, fingerprint, access, kind, config.DAILY_GENERATION_LIMIT);
    try {
      const output = await services.generate(kind, input);
      let result: unknown;
      try { result = validateResult(kind, output.raw, input); } catch { throw new GenerationError(false); }
      store.complete(userId, input.requestId, result, output.usage, config.CLIPROXY_MODEL);
      if (store.consent(userId) !== CONSENT_VERSION) throw new HttpError(403, 'consent_required');
      res.json({ requestId: input.requestId, cached: false, result });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Unknown failures may have occurred after the provider generated a result.
      const uncertain = !(error instanceof GenerationError) || error.uncertain;
      store.fail(userId, input.requestId, uncertain);
      throw new HttpError(502, uncertain ? 'generation_uncertain' : 'generation_failed');
    }
  }
  app.post('/v1/interpretations', (req, res) => generate('interpretation', req, res));
  app.post('/v1/weekly', (req, res) => generate('weekly', req, res));
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next; // Express identifies error middleware by its four arguments.
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'invalid_request' }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.code }); return; }
    const type = (error as { type?: string })?.type;
    if (type === 'entity.too.large') { res.status(413).json({ error: 'request_too_large' }); return; }
    if (type === 'entity.parse.failed') { res.status(400).json({ error: 'invalid_json' }); return; }
    // Never log request bodies, bearer tokens, provider replies or raw exception messages.
    console.error(JSON.stringify({ event: 'internal_error' }));
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errors);
  return app;
}
