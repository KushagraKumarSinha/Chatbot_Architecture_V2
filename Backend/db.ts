import postgres from "npm:postgres@3.4.5";

//const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const SUPABASE_DB_URL = Deno.env.get("CONNECTION_STRING");

export const sql = postgres(SUPABASE_DB_URL, {
  ssl: "require",
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  max_lifetime: 60 * 15, 
});
