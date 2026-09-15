const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brawl-postgres-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory, port: 55432, user: "postgres", password: "local-test-only",
    authMethod: "scram-sha-256", persistent: true,
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {}, onError: message => process.stderr.write(String(message)),
  });
  await server.initialise();
  await server.start();
  const client = server.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  await client.query("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const name of ["brawl_sync_tests", "brawl_security_tests", "brawl_backup_tests"]) {
    await client.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
  }
  await client.end();
  console.log("Local PostgreSQL ready on 127.0.0.1:55432; user postgres, password local-test-only.");
  console.log(`Temporary cluster: ${directory}`);
  const keepAlive = setInterval(() => {}, 30_000);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(keepAlive);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
