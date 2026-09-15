const { Client } = require("pg");
async function main() {
  const connectionString = process.env.TEST_POSTGRES_URL || "postgresql://postgres:local-test-only@127.0.0.1:5432/postgres";
  const url = new URL(connectionString);
  if (!["localhost","127.0.0.1","[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("A local test cluster is required.");
  const db = new Client({connectionString});
  await db.connect();
  try {
    for (const role of ["anon","authenticated","service_role"]) {
      if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role])).rowCount) await db.query(`CREATE ROLE ${role} ${role === "service_role" ? "BYPASSRLS" : ""}`);
    }
    for (const name of ["brawl_sync_tests","brawl_security_tests","brawl_backup_tests"]) {
      if (!(await db.query("SELECT 1 FROM pg_database WHERE datname=$1",[name])).rowCount) await db.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
  } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
