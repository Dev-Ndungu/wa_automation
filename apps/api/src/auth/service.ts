import argon2 from 'argon2';
import { and, eq, gt, lt } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { adminUsers, sessions } from '../db/schema.js';

const now = () => new Date().toISOString();
const expiry = () => new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();

export async function ensureInitialAdministrator(): Promise<void> {
  const existing = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
  if (existing.length > 0 || !config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;

  await createAdministrator(config.ADMIN_EMAIL, config.ADMIN_PASSWORD);
}

async function createAdministrator(email: string, password: string) {

  const createdAt = now();
  await db.insert(adminUsers).values({
    id: randomUUID(),
    email: email.toLowerCase(),
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    createdAt,
    updatedAt: createdAt,
  });
}

export async function initialSetupRequired(): Promise<boolean> {
  const existing = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
  return existing.length === 0;
}

export async function createInitialAdministrator(email: string, password: string): Promise<boolean> {
  if (!(await initialSetupRequired())) return false;
  await createAdministrator(email, password);
  return true;
}

export async function removeLegacyDefaultAdministrator(): Promise<void> {
  if (config.ADMIN_EMAIL || config.ADMIN_PASSWORD) return;
  const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.email, 'admin@example.com') });
  if (user && await argon2.verify(user.passwordHash, 'change-this-before-first-start')) {
    await db.delete(adminUsers).where(eq(adminUsers.id, user.id));
  }
}

export async function verifyCredentials(email: string, password: string) {
  const user = await db.query.adminUsers.findFirst({ where: eq(adminUsers.email, email.toLowerCase()) });
  if (!user || !(await argon2.verify(user.passwordHash, password))) return null;
  return user;
}

export async function createSession(userId: string) {
  const session = {
    id: randomBytes(32).toString('base64url'),
    userId,
    csrfToken: randomBytes(32).toString('base64url'),
    expiresAt: expiry(),
    createdAt: now(),
  };
  await db.insert(sessions).values(session);
  return session;
}

export async function getSession(sessionId: string | undefined) {
  if (!sessionId) return null;
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now())),
  });
  return session ?? null;
}

export async function destroySession(sessionId: string | undefined): Promise<void> {
  if (sessionId) await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function removeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now()));
}
