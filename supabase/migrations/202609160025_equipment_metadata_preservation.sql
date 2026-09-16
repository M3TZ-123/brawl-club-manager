-- A reported array is authoritative for IDs, including an explicit empty array.
-- Missing optional attributes of the same ID retain their last known evidence.
-- No historical rows are rewritten and no additional upstream reads are needed.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_merge_progress_equipment(p_previous jsonb,p_incoming jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE v_previous jsonb; v_incoming jsonb; v_item jsonb; v_old jsonb; v_level integer; v_result jsonb:='[]';
BEGIN
  v_incoming:=public.sync_progress_equipment(p_incoming);
  IF v_incoming IS NULL THEN RETURN NULL; END IF;
  v_previous:=coalesce(public.sync_progress_equipment(p_previous),'[]');
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_incoming) LOOP
    SELECT value INTO v_old FROM jsonb_array_elements(v_previous) WHERE value->'id'=v_item->'id';
    v_level:=coalesce(public.sync_progress_integer(v_item->'level'),public.sync_progress_integer(v_old->'level'));
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_item->'id','name',coalesce(v_item->>'name',v_old->>'name'))
      || CASE WHEN v_level IS NOT NULL THEN jsonb_build_object('level',v_level) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.sync_merge_progress_equipment(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sync_apply_player_progress(p_run_id uuid,p_payload jsonb,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item jsonb; v_input jsonb; v_optional jsonb; v_checked jsonb; v_value jsonb; v_key text; v_tag text; v_at text;
  v_brawler public.player_brawler_details%ROWTYPE; v_member public.members%ROWTYPE;
  v_previous public.player_ranked_history%ROWTYPE; v_merged jsonb; v_candidate jsonb; v_exists boolean; v_kind text;
BEGIN
  v_at:=to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'members') LOOP
    v_tag:=v_item->>'player_tag'; v_input:=v_item->'profile_progress'; v_optional:='{}'; v_checked:='{}';
    IF public.sync_progress_integer(v_item->'highest_trophies') IS NOT NULL THEN v_checked:=jsonb_build_object('highest_trophies',v_at); END IF;
    FOREACH v_key IN ARRAY ARRAY['exp_points','total_prestige_level','fame'] LOOP
      v_value:=to_jsonb(public.sync_progress_integer(v_input->v_key));
      IF v_value IS NOT NULL THEN v_optional:=v_optional||jsonb_build_object(v_key,v_value); v_checked:=v_checked||jsonb_build_object(v_key,v_at); END IF;
    END LOOP;
    v_value:=to_jsonb(public.sync_progress_text(v_input->'fame_tier_name'));
    IF v_value IS NOT NULL THEN v_optional:=v_optional||jsonb_build_object('fame_tier_name',v_value); v_checked:=v_checked||jsonb_build_object('fame_tier_name',v_at); END IF;
    INSERT INTO public.player_profile_details(player_tag,exp_points,total_prestige_level,fame,fame_tier_name,observed_at,field_checked_at)
      VALUES(v_tag,(v_optional->>'exp_points')::integer,(v_optional->>'total_prestige_level')::integer,(v_optional->>'fame')::integer,v_optional->>'fame_tier_name',p_at,v_checked)
      ON CONFLICT(player_tag) DO UPDATE SET exp_points=coalesce(excluded.exp_points,player_profile_details.exp_points),
        total_prestige_level=coalesce(excluded.total_prestige_level,player_profile_details.total_prestige_level),
        fame=coalesce(excluded.fame,player_profile_details.fame),fame_tier_name=coalesce(excluded.fame_tier_name,player_profile_details.fame_tier_name),
        observed_at=excluded.observed_at,field_checked_at=player_profile_details.field_checked_at||excluded.field_checked_at;

    SELECT * INTO STRICT v_member FROM public.members WHERE player_tag=v_tag;
    SELECT * INTO v_previous FROM public.player_ranked_history WHERE player_tag=v_tag ORDER BY observed_at DESC,id DESC LIMIT 1;
    v_exists:=FOUND;
    -- Retained values carry their original field provenance. Missing data is
    -- never inserted as a fabricated zero or as a past observation.
    IF public.sync_ranked_provenance(v_item->'ranked_provenance')<>'{}'::jsonb THEN
      IF NOT v_exists OR ROW(v_member.ranked_season_id,v_member.rank_current,v_member.ranked_points,v_member.ranked_season_best,v_member.ranked_season_best_points,v_member.rank_highest,v_member.ranked_all_time_best_points)
          IS DISTINCT FROM ROW(v_previous.season_id,v_previous.current_rank,v_previous.points,v_previous.season_best,v_previous.season_best_points,v_previous.all_time_best,v_previous.all_time_best_points) THEN
        v_kind:=CASE WHEN NOT v_exists THEN 'initial' WHEN v_previous.season_id IS NOT NULL AND v_member.ranked_season_id IS NOT NULL AND v_previous.season_id<>v_member.ranked_season_id THEN 'season_reset' ELSE 'change' END;
        INSERT INTO public.player_ranked_history(player_tag,run_id,observed_at,kind,season_id,current_rank,points,season_best,season_best_points,all_time_best,all_time_best_points,source,provenance)
          VALUES(v_tag,p_run_id,p_at,v_kind,v_member.ranked_season_id,v_member.rank_current,v_member.ranked_points,v_member.ranked_season_best,v_member.ranked_season_best_points,
            v_member.rank_highest,v_member.ranked_all_time_best_points,v_member.ranked_source,public.sync_ranked_provenance(v_member.ranked_provenance)) ON CONFLICT(run_id,player_tag) DO NOTHING;
      END IF;
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'brawlers') LOOP
    v_tag:=v_item->>'player_tag'; v_input:=v_item->'progress'; v_optional:='{}'; v_checked:='{}';
    SELECT * INTO v_brawler FROM public.player_brawler_details WHERE player_tag=v_tag AND brawler_id=(v_item->>'brawler_id')::integer FOR UPDATE;
    FOREACH v_key IN ARRAY ARRAY['highest_trophies','prestige_level','current_win_streak','max_win_streak'] LOOP
      v_value:=to_jsonb(public.sync_progress_integer(v_input->v_key));
      IF v_value IS NOT NULL THEN v_optional:=v_optional||jsonb_build_object(v_key,v_value); v_checked:=v_checked||jsonb_build_object(v_key,v_at); END IF;
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['gadgets','star_powers','gears','hyper_charges'] LOOP
      v_value:=public.sync_progress_equipment(v_input->v_key);
      IF v_value IS NOT NULL THEN
        v_merged:=public.sync_merge_progress_equipment(to_jsonb(v_brawler)->v_key,v_value);
        v_optional:=v_optional||jsonb_build_object(v_key,v_merged);
        -- Retained attributes were not rechecked. Keep the older field evidence
        -- even when other brawler values change in this same snapshot.
        v_checked:=v_checked||jsonb_build_object(v_key,CASE WHEN v_merged IS DISTINCT FROM v_value THEN v_brawler.field_checked_at->v_key ELSE to_jsonb(v_at) END);
      END IF;
    END LOOP;
    v_value:=public.sync_progress_equipment(jsonb_build_array(v_input->'skin'));
    IF v_value IS NOT NULL THEN
      v_merged:=public.sync_merge_progress_equipment(jsonb_build_array(v_brawler.skin),v_value);
      v_optional:=v_optional||jsonb_build_object('skin',v_merged->0);
      v_checked:=v_checked||jsonb_build_object('skin',CASE WHEN v_merged IS DISTINCT FROM v_value THEN v_brawler.field_checked_at->'skin' ELSE to_jsonb(v_at) END);
    END IF;
    v_value:='{}';
    FOREACH v_key IN ARRAY ARRAY['gadget','starPower','hyperCharge'] LOOP
      IF jsonb_typeof(v_input->'buffies'->v_key)='boolean' THEN v_value:=v_value||jsonb_build_object(v_key,v_input->'buffies'->v_key); END IF;
    END LOOP;
    IF v_value<>'{}'::jsonb THEN
      v_optional:=v_optional||jsonb_build_object('buffies',coalesce(v_brawler.buffies,'{}')||v_value);
      v_checked:=v_checked||jsonb_build_object('buffies',v_at);
    END IF;
    v_candidate:=coalesce(to_jsonb(v_brawler),'{}')||v_optional||jsonb_build_object(
      'player_tag',v_tag,'brawler_id',(v_item->>'brawler_id')::integer,'brawler_name',v_item->>'brawler_name',
      'power_level',(v_item->>'power_level')::integer,'trophies',(v_item->>'trophies')::integer,'rank',(v_item->>'rank')::integer,
      'observed_at',p_at,'field_checked_at',coalesce(v_brawler.field_checked_at,'{}')||v_checked);
    INSERT INTO public.player_brawler_details SELECT * FROM jsonb_populate_record(NULL::public.player_brawler_details,v_candidate)
      ON CONFLICT(player_tag,brawler_id) DO UPDATE SET brawler_name=excluded.brawler_name,power_level=excluded.power_level,trophies=excluded.trophies,rank=excluded.rank,
        highest_trophies=excluded.highest_trophies,prestige_level=excluded.prestige_level,current_win_streak=excluded.current_win_streak,max_win_streak=excluded.max_win_streak,
        skin=excluded.skin,gadgets=excluded.gadgets,star_powers=excluded.star_powers,gears=excluded.gears,hyper_charges=excluded.hyper_charges,buffies=excluded.buffies,
        observed_at=excluded.observed_at,field_checked_at=excluded.field_checked_at
      WHERE (to_jsonb(player_brawler_details)-ARRAY['observed_at','field_checked_at']) IS DISTINCT FROM (to_jsonb(excluded)-ARRAY['observed_at','field_checked_at']);
  END LOOP;
  -- A profile's brawler list is authoritative; do not retain removed/invalidated
  -- collection entries indefinitely, but keep the existing daily history.
  DELETE FROM public.player_brawler_details d WHERE d.player_tag IN (SELECT value->>'player_tag' FROM jsonb_array_elements(p_payload->'members'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'brawlers') b WHERE b->>'player_tag'=d.player_tag AND (b->>'brawler_id')::integer=d.brawler_id);
END $$;
REVOKE ALL ON FUNCTION public.sync_apply_player_progress(uuid,jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
