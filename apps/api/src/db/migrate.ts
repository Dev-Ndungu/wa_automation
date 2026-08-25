import { bootstrapDatabase } from './bootstrap.js';

await bootstrapDatabase();
console.log('Database schema is current.');
