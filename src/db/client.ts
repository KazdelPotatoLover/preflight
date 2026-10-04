import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
export function connectDatabase(url: string) {
  const client = postgres(url, { max: 10, connect_timeout: 5, onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}
export type Database = ReturnType<typeof connectDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type QueryDatabase = Database | Transaction;
