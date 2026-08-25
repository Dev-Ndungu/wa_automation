import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import * as schema from './schema.js';

const databasePath = config.DATABASE_PATH;
mkdirSync(dirname(databasePath), { recursive: true });

export const client = createClient({ url: pathToFileURL(databasePath).toString() });
export const db = drizzle({ client, schema });
