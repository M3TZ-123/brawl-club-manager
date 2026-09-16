-- Preserve the existing team evidence rules while validating all participants in
-- one query instead of issuing repeated PL/pgSQL queries for every participant.
BEGIN;

CREATE OR REPLACE FUNCTION public.analysis_team(p_raw jsonb,p_player text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_source jsonb:=p_raw;v_result jsonb;
BEGIN
  IF jsonb_typeof(v_source)='string' THEN
    BEGIN v_source:=(v_source #>> '{}')::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END;
  END IF;
  IF jsonb_typeof(v_source)='object' THEN v_source:=v_source->'teams'; END IF;
  -- Flat solo-player lists are not teams. Never manufacture a partnership.
  IF jsonb_typeof(v_source) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(v_source) NOT BETWEEN 1 AND 20 THEN RETURN NULL; END IF;

  WITH teams AS (
    SELECT value,ordinality team_id,
      CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) BETWEEN 1 AND 20 ELSE false END valid
    FROM jsonb_array_elements(v_source) WITH ORDINALITY
  ), players AS MATERIALIZED (
    SELECT t.team_id,t.valid AND jsonb_typeof(p.value)='object'
        AND jsonb_typeof(p.value->'tag')='string' valid,
      CASE WHEN left(upper(btrim(p.value->>'tag')),1)='#' THEN upper(btrim(p.value->>'tag'))
        ELSE '#'||upper(btrim(p.value->>'tag')) END tag
    FROM teams t LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN t.valid THEN t.value ELSE '[]'::jsonb END) p(value) ON true
  )
  SELECT CASE WHEN bool_and(coalesce(valid,false)) AND count(*)<=40
      AND bool_and(coalesce(tag ~ '^#[A-Z0-9]{1,20}$',false)) AND count(DISTINCT tag)=count(*)
      AND count(*) FILTER(WHERE tag=p_player)=1
    THEN jsonb_build_object('own',array_agg(tag ORDER BY tag) FILTER(WHERE team_id=(SELECT min(team_id) FROM players WHERE tag=p_player)),
      'participants',array_agg(tag ORDER BY tag)) ELSE NULL END
    INTO v_result FROM players;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_team(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_team(jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
