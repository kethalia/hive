import postgres from "postgres";

let pool: postgres.Sql | null = null;

export function getPool(): postgres.Sql {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL environment variable is not set — cannot create Postgres connection pool",
    );
  }

  pool = postgres(url, {
    max: 10,
    connect_timeout: 10,
    idle_timeout: 30,
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
