BEGIN;
-- Fetch Mega Pig every 10 minutes (instead of 20) while an automatic or manual
-- cycle is capturing, not only while a planned club event exists.
DO $$
DECLARE v_sig text; v_definition text;
  v_needle text:='EXISTS(SELECT 1 FROM public.club_planned_events WHERE club_tag=p_club AND kind=''mega_pig''';
  v_replacement text:='EXISTS(SELECT 1 FROM public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled AND finalized_at IS NULL'
    ||' AND starts_at<=v_now AND ends_at>=v_now) OR EXISTS(SELECT 1 FROM public.club_planned_events WHERE club_tag=p_club AND kind=''mega_pig''';
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.finish_mega_pig_source_cache(text,uuid,jsonb,text,integer)','public.claim_mega_pig_provider_cache(text,uuid,text)'] LOOP
    v_definition:=replace(pg_get_functiondef(v_sig::regprocedure),chr(13),'');
    CONTINUE WHEN position('public.club_mega_pig_cycles WHERE club_tag=p_club AND capture_enabled' in v_definition)>0;
    IF (length(v_definition)-length(replace(v_definition,v_needle,'')))/length(v_needle)<>1 OR position('v_now' in v_definition)=0 THEN
      RAISE EXCEPTION 'mega_pig_cadence_patch_mismatch %',v_sig;
    END IF;
    EXECUTE replace(v_definition,v_needle,v_replacement);
  END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
