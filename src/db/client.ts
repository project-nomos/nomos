import postgres from "postgres";

let sqlInstance: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!sqlInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    sqlInstance = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}, // Suppress NOTICE messages from CREATE IF NOT EXISTS
    });
  }
  return sqlInstance;
}

export async function closeDb(): Promise<void> {
  if (sqlInstance) {
    await sqlInstance.end();
    sqlInstance = null;
  }
}
