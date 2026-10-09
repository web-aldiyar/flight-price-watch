import type { Query } from './db.ts';

/**
 * Neon (serverless Postgres over HTTP) when DATABASE_URL is set; otherwise an embedded
 * PGlite database in ./data/pglite for local development.
 */
export async function connect(databaseUrl: string | undefined): Promise<Query> {
  if (databaseUrl) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(databaseUrl);
    return (text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite('./data/pglite');
  return async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows;
}
