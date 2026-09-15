const { Client } = require("pg");
const { isIP } = require("node:net");
const { readEncryptedBackup, encryptionKey, sha256 } = require("./backup-format.cjs");
const identifier = value => `"${String(value).replaceAll('"', '""')}"`;
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const qualified = name => `public.${identifier(name)}`;
const roleSql = name => name === "PUBLIC" ? "PUBLIC" : identifier(name);

function validateRestoreTarget(connectionString) {
  const url = new URL(connectionString || "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || url.search || !/^\/brawl_[a-z0-9_]+_(tests|restore)$/.test(url.pathname)) {
    throw new Error("Restore requires a loopback-only brawl_*_tests or brawl_*_restore database without URL query overrides");
  }
  return url.pathname.slice(1);
}

function validateRestoreConnection(remoteAddress, target, expectedDatabase) {
  let loopback = remoteAddress === "127.0.0.1";
  if (typeof remoteAddress === "string" && isIP(remoteAddress) === 6) {
    const normalized = new URL(`http://[${remoteAddress}]/`).hostname;
    loopback = ["[::1]", "[::ffff:7f00:1]"].includes(normalized);
  }
  // A locally forwarded Docker service reports its container bridge address
  // from inet_server_addr(). Validate our actual TCP peer instead, along with
  // the independently checked database identity and encoding.
  if (!loopback || target.db !== expectedDatabase || target.encoding !== "UTF8") {
    throw new Error("Restore target must be a local UTF8 test database");
  }
}

function sequenceOptions(sequence) {
  for (const field of ["start", "increment", "min", "max", "cache", "last_value"]) {
    if (!/^-?\d+$/.test(sequence[field])) throw new Error("Invalid sequence metadata");
  }
  return `INCREMENT BY ${sequence.increment} MINVALUE ${sequence.min} MAXVALUE ${sequence.max} START WITH ${sequence.start} CACHE ${sequence.cache} ${sequence.cycle ? "CYCLE" : "NO CYCLE"}`;
}

async function restoreBackup(backup, connectionString) {
  const expectedDatabase = validateRestoreTarget(connectionString);
  const { manifest, tables } = backup;
  if (manifest.external_dependencies?.length) {
    const schemas = [...new Set(manifest.external_dependencies.map(item => item.schema))];
    throw new Error(`Restore needs external schemas not included in this app backup: ${schemas.join(", ")}`);
  }
  // Public app backups do not pretend to include Supabase's managed auth,
  // storage, or extension internals. Require those dependencies explicitly.
  for (const table of manifest.tables) {
    for (const constraint of table.constraints) {
      if (constraint.external_schema && constraint.external_schema !== "public") throw new Error(`Restore needs external schema ${constraint.external_schema}; it is not included in this app backup`);
    }
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const target = (await client.query("SELECT current_database() AS db,current_setting('server_encoding') AS encoding")).rows[0];
    validateRestoreConnection(client.connection?.stream?.remoteAddress, target, expectedDatabase);
    const existing = await client.query(`
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f','S')
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND t.typtype IN ('e','d') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
      LIMIT 1`);
    if (existing.rowCount) throw new Error("Restore target is not empty; refusing to overwrite any data or schema");
    await client.query("BEGIN; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL extra_float_digits=3; SET LOCAL check_function_bodies=off");
    const roles = new Set(["anon", "authenticated", "service_role"]);
    if (manifest.schema?.owner) roles.add(manifest.schema.owner);
    for (const grant of manifest.schema?.grants || []) if (grant.role !== "PUBLIC") roles.add(grant.role);
    for (const object of [...manifest.tables, ...manifest.sequences, ...manifest.functions]) {
      if (object.owner) roles.add(object.owner);
      for (const grant of [...(object.grants || []), ...(object.column_grants || [])]) if (grant.role !== "PUBLIC") roles.add(grant.role);
      for (const policy of object.policies || []) for (const role of policy.roles) if (role !== "PUBLIC") roles.add(role);
    }
    for (const grant of manifest.default_grants || []) { roles.add(grant.owner); if (grant.role !== "PUBLIC") roles.add(grant.role); }
    for (const role of roles) {
      if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN ${role === "service_role" ? "BYPASSRLS" : "NOBYPASSRLS"}`);
    }
    await client.query("CREATE SCHEMA IF NOT EXISTS public");
    // Do not inherit the empty target database's broad default grants.
    const targetDefaults = await client.query("SELECT pg_get_userbyid(d.defaclrole) AS owner,n.nspname AS schema,d.defaclobjtype AS type,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS role FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace=0 OR n.nspname='public'");
    const defaultTypes = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };
    for (const grant of targetDefaults.rows) {
      if (defaultTypes[grant.type]) await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(grant.owner)} ${grant.schema ? `IN SCHEMA ${identifier(grant.schema)}` : ""} REVOKE ALL ON ${defaultTypes[grant.type]} FROM ${roleSql(grant.role)}`);
    }
    for (const extension of manifest.extensions || []) {
      // Extensions are dependencies, not bundled provider implementation data.
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(extension.schema)}`);
      try { await client.query(`CREATE EXTENSION IF NOT EXISTS ${identifier(extension.name)} WITH SCHEMA ${identifier(extension.schema)}`); }
      catch { throw new Error(`Required extension is unavailable locally: ${extension.name}`); }
    }
    for (const type of manifest.enums || []) await client.query(`CREATE TYPE ${qualified(type.name)} AS ENUM (${type.labels.map(literal).join(",")})`);
    for (const sequence of manifest.sequences) {
      if (!sequence.owned_by?.identity) await client.query(`CREATE SEQUENCE ${qualified(sequence.name)} AS ${sequence.type} ${sequenceOptions(sequence)}`);
    }
    for (const table of manifest.tables) {
      const definitions = table.columns.map(column => {
        let definition = `${identifier(column.name)} ${column.type}`;
        if (column.collation) definition += ` COLLATE ${column.collation}`;
        if (column.identity) {
          const sequence = manifest.sequences.find(sequence => sequence.owned_by?.table === table.name && sequence.owned_by?.column === column.name);
          if (!sequence) throw new Error("Missing identity sequence metadata");
          definition += ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY (SEQUENCE NAME ${qualified(sequence.name)} ${sequenceOptions(sequence)})`;
        } else if (column.generated) definition += ` GENERATED ALWAYS AS (${column.default}) STORED`;
        if (!column.nullable) definition += " NOT NULL";
        return definition;
      });
      await client.query(`CREATE TABLE ${qualified(table.name)} (${definitions.join(",")})`);
    }
    for (const fn of manifest.functions) await client.query(fn.definition);
    for (const table of manifest.tables) {
      for (const column of table.columns) {
        if (column.default !== null && !column.identity && !column.generated) await client.query(`ALTER TABLE ${qualified(table.name)} ALTER COLUMN ${identifier(column.name)} SET DEFAULT ${column.default}`);
      }
      const columns = table.columns.filter(column => !column.generated).map(column => identifier(column.name)).join(",");
      const bytes = tables.get(table.name);
      if (!bytes) throw new Error(`Missing table payload: ${table.name}`);
      const rows = bytes.length ? bytes.toString("utf8").slice(0, -1).split("\n") : [];
      for (let offset = 0; offset < rows.length; offset += 500) {
        // Pass JSON text directly to PostgreSQL: JavaScript must not round bigint
        // IDs or precise numeric values while parsing/re-serializing records.
        await client.query(`INSERT INTO ${qualified(table.name)} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::${qualified(table.name)},$1::jsonb)`, [`[${rows.slice(offset, offset + 500).join(",")}]`]);
      }
    }
    for (const foreign of [false, true]) for (const table of manifest.tables) for (const constraint of table.constraints) {
      if ((constraint.type === "f") === foreign) await client.query(`ALTER TABLE ${qualified(table.name)} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition}`);
    }
    for (const table of manifest.tables) for (const index of table.indexes) await client.query(index);
    for (const sequence of manifest.sequences) {
      if (sequence.owned_by && !sequence.owned_by.identity) await client.query(`ALTER SEQUENCE ${qualified(sequence.name)} OWNED BY ${qualified(sequence.owned_by.table)}.${identifier(sequence.owned_by.column)}`);
      await client.query("SELECT setval($1::regclass,$2::bigint,$3)", [`public.${identifier(sequence.name)}`, sequence.last_value, sequence.is_called]);
    }
    // Verify exact canonical rows before triggers/permissions are re-enabled.
    for (const table of manifest.tables) {
      const primary = await client.query("SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY k.ord", [`public.${identifier(table.name)}`]);
      const order = primary.rowCount ? primary.rows.map(row => `t.${identifier(row.attname)}`).join(",") : "t.ctid";
      const restored = await client.query(`SELECT to_jsonb(t)::text AS row FROM ${qualified(table.name)} t ORDER BY ${order}`);
      if (restored.rowCount !== table.row_count || sha256(Buffer.from(restored.rows.map(row => `${row.row}\n`).join(""))) !== sha256(tables.get(table.name))) throw new Error(`Restored row verification failed for ${table.name}`);
    }
    async function grants(kind, object, entries) {
      // Newly created functions default to PUBLIC EXECUTE, and Supabase DBs
      // may have default anon table grants. Restore the exact captured ACL.
      await client.query(`REVOKE ALL ON ${kind} ${object} FROM PUBLIC, ${[...roles].map(identifier).join(",")}`);
      for (const grant of entries) await client.query(`GRANT ${grant.privilege} ON ${kind} ${object} TO ${roleSql(grant.role)}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
    for (const table of manifest.tables) {
      await client.query(`ALTER TABLE ${qualified(table.name)} OWNER TO ${identifier(table.owner)}`);
      await grants("TABLE", qualified(table.name), table.grants);
      for (const grant of table.column_grants) await client.query(`GRANT ${grant.privilege} (${identifier(grant.column)}) ON ${qualified(table.name)} TO ${roleSql(grant.role)}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
      for (const policy of table.policies) {
        const command = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" }[policy.command];
        if (!command) throw new Error("Unknown RLS policy command");
        await client.query(`CREATE POLICY ${identifier(policy.name)} ON ${qualified(table.name)} AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${command} TO ${policy.roles.map(roleSql).join(",")}${policy.using ? ` USING (${policy.using})` : ""}${policy.check ? ` WITH CHECK (${policy.check})` : ""}`);
      }
      if (table.rls) await client.query(`ALTER TABLE ${qualified(table.name)} ENABLE ROW LEVEL SECURITY`);
      if (table.force_rls) await client.query(`ALTER TABLE ${qualified(table.name)} FORCE ROW LEVEL SECURITY`);
      if (["f", "n"].includes(table.replica_identity)) await client.query(`ALTER TABLE ${qualified(table.name)} REPLICA IDENTITY ${table.replica_identity === "f" ? "FULL" : "NOTHING"}`);
      if (table.replica_identity === "i") throw new Error("Restore requires explicit replica-identity index metadata");
      for (const trigger of table.triggers) {
        await client.query(trigger.definition);
        if (trigger.enabled !== "O") {
          const matched = trigger.definition.match(/^CREATE (?:CONSTRAINT )?TRIGGER ("(?:[^"]|"")*"|[^ ]+)/);
          if (!matched) throw new Error("Cannot identify captured trigger");
          await client.query(`ALTER TABLE ${qualified(table.name)} ${trigger.enabled === "D" ? "DISABLE" : trigger.enabled === "A" ? "ENABLE ALWAYS" : "ENABLE REPLICA"} TRIGGER ${matched[1]}`);
        }
      }
    }
    for (const sequence of manifest.sequences) {
      await client.query(`ALTER SEQUENCE ${qualified(sequence.name)} OWNER TO ${identifier(sequence.owner)}`);
      await grants("SEQUENCE", qualified(sequence.name), sequence.grants);
    }
    for (const fn of manifest.functions) {
      await client.query(`ALTER ROUTINE ${fn.identity} OWNER TO ${identifier(fn.owner)}`);
      await grants("ROUTINE", fn.identity, fn.grants);
    }
    for (const grant of manifest.default_grants || []) {
      if (!defaultTypes[grant.type]) throw new Error("Unknown default privilege type");
      await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(grant.owner)} ${grant.schema ? `IN SCHEMA ${identifier(grant.schema)}` : ""} GRANT ${grant.privilege} ON ${defaultTypes[grant.type]} TO ${roleSql(grant.role)}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
    }
    if (manifest.schema) {
      await client.query(`ALTER SCHEMA public OWNER TO ${identifier(manifest.schema.owner)}`);
      await grants("SCHEMA", "public", manifest.schema.grants);
    } else throw new Error("Missing public schema permissions");
    for (const publication of manifest.publications || []) {
      if (!(await client.query("SELECT 1 FROM pg_publication WHERE pubname=$1", [publication.name])).rowCount) await client.query(`CREATE PUBLICATION ${identifier(publication.name)}`);
      await client.query(`ALTER PUBLICATION ${identifier(publication.name)} ADD TABLE ${qualified(publication.table)}${publication.columns?.length ? ` (${publication.columns.map(identifier).join(",")})` : ""}${publication.row_filter ? ` WHERE (${publication.row_filter})` : ""}`);
    }
    // Rehearsals verify that restoring ACLs did not reopen the private tables.
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["member_reviews", "admin_login_attempts", "backup_snapshots", "backup_chunks", "profiles", "clubs", "user_clubs"]) {
        if (!manifest.tables.some(item => item.name === table)) continue;
        const permissions = await client.query("SELECT has_any_column_privilege($1,$2,'SELECT') OR has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') AS exposed", [role, `public.${identifier(table)}`]);
        if (permissions.rows[0].exposed) throw new Error(`Private permissions verification failed for ${table}`);
      }
      if (manifest.tables.some(table => table.name === "member_history")) {
        const permissions = await client.query("SELECT has_column_privilege($1,'public.member_history','notes','SELECT') AS notes,has_column_privilege($1,'public.member_history','player_tag','SELECT') AS public_tag", [role]);
        if (permissions.rows[0].notes || !permissions.rows[0].public_tag) throw new Error("History column permissions verification failed");
      }
      for (const identity of ["public.create_backup_snapshot(uuid)", "public.complete_backup_snapshot(uuid,text)", "public.consume_admin_login_attempt(text)"]) {
        const access = await client.query("SELECT to_regprocedure($1) IS NOT NULL AND has_function_privilege($2,$1,'EXECUTE') AS exposed", [identity, role]);
        if (access.rows[0].exposed) throw new Error("Private function permissions verification failed");
      }
      if (manifest.tables.some(table => table.name === "settings")) {
        await client.query("SAVEPOINT settings_permission_check");
        try {
          await client.query(`SET LOCAL ROLE ${identifier(role)}`);
          const visible = await client.query("SELECT 1 FROM public.settings LIMIT 1");
          if (visible.rowCount) throw new Error("Private settings permissions verification failed");
        } catch (error) { if (error.code !== "42501") throw error; }
        finally { await client.query("ROLLBACK TO SAVEPOINT settings_permission_check"); }
      }
    }
    for (const table of ["member_reviews", "backup_snapshots", "backup_chunks", "admin_login_attempts"]) {
      if (!manifest.tables.some(item => item.name === table)) continue;
      const security = await client.query("SELECT relrowsecurity AS rls FROM pg_class WHERE oid=$1::regclass", [`public.${identifier(table)}`]);
      if (!security.rows[0].rls) throw new Error(`Private RLS verification failed for ${table}`);
    }
    await client.query("COMMIT");
    return { snapshot_id: manifest.snapshot_id, tables: manifest.tables.length, rows: manifest.tables.reduce((sum, table) => sum + table.row_count, 0), verified: true };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await client.end(); }
}

async function main() {
  const filename = process.argv[2];
  if (!filename || !process.argv.includes("--apply")) throw new Error("Usage: node scripts/restore-backup.cjs FILE.brawlbackup --apply (RESTORE_DATABASE_URL must be an empty local test database)");
  const backup = await readEncryptedBackup(filename, encryptionKey());
  console.log(JSON.stringify(await restoreBackup(backup, process.env.RESTORE_DATABASE_URL)));
}
if (require.main === module) main().catch(error => {
  // Database diagnostics can include row values. Keep them out of CI logs.
  console.error(`Local backup restore failed: ${error.code ? `database/file error ${error.code}` : error.message}`);
  process.exitCode = 1;
});
module.exports = { validateRestoreTarget, validateRestoreConnection, restoreBackup };
