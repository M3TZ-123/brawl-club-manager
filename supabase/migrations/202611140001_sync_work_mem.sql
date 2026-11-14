BEGIN;
-- Nano compute ships with work_mem=2MB. The fenced sync commit expands the whole
-- JSON payload (members, battles, brawlers) into tuplestores/sorts on every member
-- iteration, which spilled ~200MB of temp files per call (1.6TB total) and
-- exhausted the Disk IO budget, causing every sync to exceed its lease.
-- Raise work_mem only for these serialized, lease-guarded writer functions.
ALTER FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) SET work_mem='32MB';
ALTER FUNCTION public.commit_roster_snapshot(uuid,bigint,jsonb) SET work_mem='32MB';
ALTER FUNCTION public.run_sync_maintenance() SET work_mem='32MB';
DO $$
BEGIN
  IF to_regprocedure('public.create_backup_snapshot(uuid)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_backup_snapshot(uuid) SET work_mem=''32MB''';
  END IF;
END $$;
-- The API gateway's authenticator role caps statements at 8s. The server-only
-- service_role runs the full sync commit, which can exceed that after a backlog.
ALTER ROLE service_role SET statement_timeout='60s';
NOTIFY pgrst,'reload schema';
NOTIFY pgrst,'reload config';
COMMIT;
