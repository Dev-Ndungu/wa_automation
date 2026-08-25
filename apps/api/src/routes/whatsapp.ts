import type { FastifyInstance } from 'fastify';
import type { WhatsAppManager } from '../whatsapp/manager.js';

export function whatsappRoutes(manager: WhatsAppManager) {
  return async function routes(app: FastifyInstance): Promise<void> {
    app.get('/api/whatsapp/status', async () => manager.getStatus());
    app.post('/api/whatsapp/link', async () => manager.requestLink());
    app.post('/api/whatsapp/disconnect', async () => { await manager.disconnect(); return manager.getStatus(); });
    app.post('/api/whatsapp/relink', async () => { await manager.relink(); return manager.getStatus(); });
    app.post('/api/whatsapp/sync-groups', async () => ({ count: await manager.syncGroups() }));
  };
}
