import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

// Keep the local database and WhatsApp credentials in one place regardless of
// whether the API is started from the repository root or apps/api.
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fromProjectRoot = (path: string) => isAbsolute(path) ? path : resolve(projectRoot, path);

const booleanFromEnvironment = z.enum(['true', 'false']).transform((value) => value === 'true');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.url().default('http://127.0.0.1:3001'),
  DATABASE_PATH: z.string().min(1).default('./data/wa-control.db'),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  COOKIE_SECURE: booleanFromEnvironment.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WHATSAPP_AUTH_DIR: z.string().min(1).default('./whatsapp-auth'),
}).superRefine((environment, context) => {
  if (Boolean(environment.ADMIN_EMAIL) !== Boolean(environment.ADMIN_PASSWORD)) {
    context.addIssue({ code: 'custom', message: 'Set both ADMIN_EMAIL and ADMIN_PASSWORD, or neither.' });
  }
});

const parsedConfig = environmentSchema.parse(process.env);
const normalizedConfig = {
  ...parsedConfig,
  DATABASE_PATH: fromProjectRoot(parsedConfig.DATABASE_PATH),
  WHATSAPP_AUTH_DIR: fromProjectRoot(parsedConfig.WHATSAPP_AUTH_DIR),
};

const hasLegacyDefaultCredentials = normalizedConfig.ADMIN_EMAIL === 'admin@example.com'
  && normalizedConfig.ADMIN_PASSWORD === 'change-this-before-first-start';

// Old local .env files may contain these former sample values. Treat them as unset.
export const config = hasLegacyDefaultCredentials
  ? { ...normalizedConfig, ADMIN_EMAIL: undefined, ADMIN_PASSWORD: undefined }
  : normalizedConfig;

if (config.NODE_ENV === 'production' && (!config.COOKIE_SECURE || !config.ADMIN_EMAIL || !config.ADMIN_PASSWORD)) {
  throw new Error('Production requires COOKIE_SECURE=true plus an explicit ADMIN_EMAIL and ADMIN_PASSWORD.');
}
