const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const source = process.env.SIGNAL_TEST_DATABASE_URL || process.env.SYNC_TEST_DATABASE_URL;
const root = path.resolve(__dirname, '../..');

test('one safe public signal per committed sync', { skip: !source }, async t => {
  const url = new URL(source);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
  assert.ok(url.pathname.endsWith('_tests'));
  const control = new Pool({ connectionString: source, max: 1 });
  const database = 'brawl_sync_signal_tests';
  if (!(await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
    await control.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
  }
  await control.end();
  url.pathname = '/' + database;
  const db = new Pool({ connectionString: url.toString(), max: 1 });
  const migration = fs.readFileSync(path.join(root,'supabase/migrations/202609160016_sync_signals.sql'),'utf8');
  const signal = async () => (await db.query('SELECT * FROM club_sync_signals WHERE id=1')).rows[0];
  const run = async (scope='full', club='#CLUB') => {
    const id = randomUUID();
    await db.query("INSERT INTO sync_runs(id,club_tag,source,scope,fence) VALUES($1,$2,'cron',$3,1)",[id,club,scope]);
    return id;
  };
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;');
    await db.query(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
    await db.query(fs.readFileSync(path.join(root,'supabase/migrations/202609160001_sync_durability.sql'),'utf8'));
    await db.query(fs.readFileSync(path.join(root,'supabase/migrations/202609160005_adaptive_sync.sql'),'utf8'));
    await db.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role');
    await db.query("INSERT INTO settings(key,value) VALUES('club_tag','#CLUB')");
    await db.query(migration);
    await t.test('initial value contains no invented success', async () => {
      assert.deepEqual(await signal(), { id:1, version:null, completed_at:null, datasets:[] });
    });
    await t.test('running, failed, and another club do not publish', async () => {
      const before = await signal();
      const id = await run();
      await db.query("UPDATE sync_runs SET status='failed',finished_at=now() WHERE id=$1",[id]);
      const other = await run('full','#OTHER');
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now() WHERE id=$1",[other]);
      assert.deepEqual(await signal(), before);
    });
    await t.test('success creates one compact signal and a replay does not change it', async () => {
      const id = await run();
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now(),result='{}' WHERE id=$1",[id]);
      const first = await signal();
      assert.equal(first.version,id);
      assert.deepEqual(first.datasets,['roster','battles','ranked']);
      assert.ok(first.completed_at instanceof Date);
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now()+interval '1 second' WHERE id=$1",[id]);
      assert.deepEqual(await signal(),first);
    });
    await t.test('roster and member commits select the appropriate datasets', async () => {
      const roster = await run('roster');
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now() WHERE id=$1",[roster]);
      assert.deepEqual((await signal()).datasets,['roster']);
      const member = await run('member');
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now() WHERE id=$1",[member]);
      assert.deepEqual((await signal()).datasets,['roster','battles','ranked']);
    });
    await t.test('a rolled-back snapshot cannot leave a successful signal', async () => {
      const before = await signal(); const id = await run();
      await db.query('BEGIN');
      await db.query("UPDATE sync_runs SET status='succeeded',finished_at=now() WHERE id=$1",[id]);
      await db.query('ROLLBACK');
      assert.deepEqual(await signal(),before);
    });
    await t.test('public roles can only read the explicit signal fields', async () => {
      for(const role of ['anon','authenticated','service_role']) {
        const connection = await db.connect();
        await connection.query('SET ROLE '+role);
        try {
          assert.deepEqual(Object.keys((await connection.query('SELECT * FROM club_sync_signals')).rows[0]).sort(),['completed_at','datasets','id','version']);
          for(const sql of ["UPDATE club_sync_signals SET version=NULL,completed_at=NULL","DELETE FROM club_sync_signals","INSERT INTO club_sync_signals(id) VALUES(1)","SELECT publish_club_sync_signal()"]) {
            await assert.rejects(connection.query(sql), error=>error.code==='42501');
          }
          if(role!=='service_role') await assert.rejects(connection.query('SELECT * FROM sync_runs'), error=>error.code==='42501');
        } finally { await connection.query('RESET ROLE'); connection.release(); }
      }
    });
    await t.test('migration is repeatable and preserves the latest version', async () => {
      const before = await signal(); await db.query(migration); assert.deepEqual(await signal(),before);
    });
  } finally { await db.end(); }
});
