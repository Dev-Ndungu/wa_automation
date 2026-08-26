import type { FastifyInstance } from 'fastify';
import type { AccountService } from '../accounts/service.js';
import { accountIdFrom } from './accounts.js';

export function whatsappRoutes(accounts: AccountService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/whatsapp/status', async (request) => (await accounts.get(accountIdFrom(request))).whatsapp.getStatus());
    app.post('/api/whatsapp/link', async (request) => (await accounts.get(accountIdFrom(request))).whatsapp.requestLink());
    app.post('/api/whatsapp/disconnect', async (request) => { const manager = (await accounts.get(accountIdFrom(request))).whatsapp; await manager.disconnect(); return manager.getStatus(); });
    app.post('/api/whatsapp/relink', async (request) => { const manager = (await accounts.get(accountIdFrom(request))).whatsapp; await manager.relink(); return manager.getStatus(); });
    app.post('/api/whatsapp/sync-groups', async (request) => ({ count: await (await accounts.get(accountIdFrom(request))).whatsapp.syncGroups() }));
  };
}
