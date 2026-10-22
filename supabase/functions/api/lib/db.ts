import { CamelCasePlugin, Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { DB } from "./schema.ts";

export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  idle_timeout: 20,
  max: 3,
});

export const db = new Kysely<DB>({
  plugins: [new CamelCasePlugin()],
  dialect: new PostgresJSDialect({ postgres: sql }),
});
