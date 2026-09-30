import { z } from 'zod';
const env = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().default('./data/dreamer.sqlite'),
  DATA_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  CLIPROXY_BASE_URL: z.url().default('http://127.0.0.1:8317/v1'),
  CLIPROXY_API_KEY: z.string().min(1),
  CLIPROXY_MODEL: z.string().min(1),
  REVENUECAT_SECRET_KEY: z.string().min(1),
  REVENUECAT_ENTITLEMENT: z.string().default('premium'),
  REVENUECAT_MONTHLY_PRODUCT_ID: z.string().min(1),
  ALLOW_SANDBOX: z.enum(['true', 'false']).default('false'),
  DAILY_GENERATION_LIMIT: z.coerce.number().int().positive().default(200),
  TRUST_PROXY: z.string().optional(),
});
export type Config = z.infer<typeof env>;
export function readConfig(): Config {
  const parsed = env.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const url = new URL(parsed.data.CLIPROXY_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('CLIPROXY_BASE_URL must be an HTTP(S) URL without credentials, query or fragment');
  return parsed.data;
}
