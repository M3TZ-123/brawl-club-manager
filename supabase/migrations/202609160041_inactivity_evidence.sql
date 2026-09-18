BEGIN;
-- The legacy is_active flag is false for members with no activity evidence.
-- Require a real, finite timestamp before alerting; missing data is not inactivity.
-- Keep the fenced transaction, absence/join exemptions and alert deduplication.
DO $$
DECLARE
  v_definition text;
  v_before text := 'FROM public.members WHERE player_tag=ANY(v_tags) AND NOT is_active AND NOT public.member_inactivity_exempt(v_run.club_tag,player_tag,v_now);';
  v_after text := 'FROM public.members WHERE player_tag=ANY(v_tags) AND NOT is_active AND NOT public.member_inactivity_exempt(v_run.club_tag,player_tag,v_now)
          AND EXISTS (SELECT 1 FROM public.member_activity_state s
            WHERE s.player_tag=members.player_tag AND isfinite(s.last_activity_at)
              AND s.last_activity_at<v_now-make_interval(hours=>v_threshold));';
BEGIN
  SELECT pg_get_functiondef('public.commit_sync_snapshot(uuid,bigint,jsonb)'::regprocedure) INTO v_definition;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'review_inactivity_evidence_before_migration';
  END IF;
  EXECUTE replace(v_definition,v_before,v_after);
END $$;
REVOKE ALL ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
