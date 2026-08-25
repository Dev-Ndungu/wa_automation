import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureInitialAdministrator, removeExpiredSessions, removeLegacyDefaultAdministrator } from './auth/service.js';
import { CampaignService } from './campaigns/service.js';
import { config } from './config.js';
import { bootstrapDatabase } from './db/bootstrap.js';
import { campaignRoutes } from './routes/campaigns.js';
import { groupRoutes } from './routes/groups.js';
import { systemRoutes } from './routes/system.js';
import { linkRoutes } from './routes/links.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { ScannerService } from './scanner/service.js';
import { WhatsAppManager } from './whatsapp/manager.js';

const app = Fastify({
  // A campaign image is submitted as a base64 data URL. Allow the documented
  // roughly-4 MB image maximum plus base64 overhead and JSON framing.
  bodyLimit: 12_000_000,
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie', 'password', 'passwordHash', 'csrfToken'],
  },
  trustProxy: config.NODE_ENV === 'production',
});

// The built dashboard is served by this same local API. This removes the
// fragile requirement to keep a separate Vite development server alive.
const dashboardDirectory = resolve(fileURLToPath(new URL('../../web/dist/', import.meta.url)));
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const sendDashboardFile = async (relativePath: string) => {
  const filePath = resolve(dashboardDirectory, relativePath);
  if (filePath !== dashboardDirectory && !filePath.startsWith(`${dashboardDirectory}${sep}`)) throw new Error('Invalid dashboard asset path.');
  return { filePath, contents: await readFile(filePath) };
};

await app.register(cookie);
await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
await app.register(rateLimit, { global: false });
await app.register(systemRoutes);
const scanner = new ScannerService(app.log);
const whatsapp = new WhatsAppManager(app.log, scanner);
await app.register(groupRoutes(whatsapp));
await app.register(whatsappRoutes(whatsapp));
await app.register(linkRoutes(scanner, whatsapp));
const campaignService = new CampaignService(whatsapp, app.log);
await app.register(campaignRoutes(campaignService));

app.get('/', async (_request, reply) => {
  const { contents } = await sendDashboardFile('index.html');
  return reply.type('text/html; charset=utf-8').send(contents);
});
app.get('/assets/*', async (request, reply) => {
  const asset = (request.params as { '*': string })['*'];
  const { filePath, contents } = await sendDashboardFile(`assets/${asset}`);
  return reply.type(contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream').send(contents);
});

app.log.info('Database initialization started');
await bootstrapDatabase();
app.log.info('Database initialization completed');
await removeLegacyDefaultAdministrator();
app.log.info('Legacy default-administrator check completed');
await ensureInitialAdministrator();
app.log.info('Initial administrator check completed');
await removeExpiredSessions();
app.log.info('Expired-session cleanup completed');
await campaignService.recover();
if (whatsapp.hasSavedSession()) void whatsapp.start();

const close = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);

await app.listen({ port: config.PORT, host: '127.0.0.1' });
app.log.info({ port: config.PORT }, 'API listening');
