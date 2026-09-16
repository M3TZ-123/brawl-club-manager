BEGIN;
-- Patch only the notification recipient selection; the activity computation and
-- complete fenced sync transaction remain identical to migration029.
DO $$
DECLARE v_definition text; v_before text := 'FROM public.members WHERE player_tag=ANY(v_tags) AND NOT is_active;';
BEGIN
  SELECT pg_get_functiondef('public.commit_sync_snapshot(uuid,bigint,jsonb)'::regprocedure) INTO v_definition;
  IF (length(v_definition)-length(replace(v_definition,v_before,'')))/length(v_before)<>1 THEN
    RAISE EXCEPTION 'review_inactivity_selection_before_migration';
  END IF;
  EXECUTE replace(v_definition,v_before,'FROM public.members WHERE player_tag=ANY(v_tags) AND NOT is_active AND NOT public.member_inactivity_exempt(v_run.club_tag,player_tag,v_now);');
END $$;
REVOKE ALL ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sync_snapshot(uuid,bigint,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
