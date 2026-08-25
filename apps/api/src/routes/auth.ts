import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { createInitialAdministrator, createSession, destroySession, getSession, initialSetupRequired, verifyCredentials } from '../auth/service.js';

const credentialsSchema = z.object({ email: z.email(), password: z.string().min(1).max(1024) });
const setupSchema = z.object({ email: z.email(), password: z.string().min(12).max(1024) });
const cookieOptions = {
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: config.COOKIE_SECURE,
  maxAge: config.SESSION_TTL_HOURS * 60 * 60,
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/status', async (request) => {
    const session = await getSession(request.cookies.wa_session);
    return { authenticated: Boolean(session) };
  });

  app.get('/api/setup/status', async () => ({ required: await initialSetupRequired() }));

  app.post('/api/setup', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) return reply.code(403).send({ message: 'Untrusted request origin.' });

    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Use a valid email and a password of at least 12 characters.' });
    if (!(await createInitialAdministrator(parsed.data.email, parsed.data.password))) {
      return reply.code(409).send({ message: 'An administrator is already configured.' });
    }

    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) return reply.code(500).send({ message: 'Administrator setup could not be completed.' });
    const session = await createSession(user.id);
    reply.setCookie('wa_session', session.id, cookieOptions);
    return { csrfToken: session.csrfToken };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) return reply.code(403).send({ message: 'Untrusted request origin.' });

    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Email and password are required.' });
    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) return reply.code(401).send({ message: 'Invalid email or password.' });

    const session = await createSession(user.id);
    reply.setCookie('wa_session', session.id, cookieOptions);
    return { csrfToken: session.csrfToken };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const session = await getSession(request.cookies.wa_session);
    if (session && request.headers['x-csrf-token'] !== session.csrfToken) {
      return reply.code(403).send({ message: 'Invalid CSRF token.' });
    }
    await destroySession(session?.id);
    reply.clearCookie('wa_session', { path: '/' });
    return reply.code(204).send();
  });
}
