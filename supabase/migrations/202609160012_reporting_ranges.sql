-- Add reporting ranges without changing tables, retention or the original RPC signature.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_activity_summary_v2(p_player_tags text[],p_now timestamptz DEFAULT now())
RETURNS TABLE(player_tag text,last_battle_at timestamptz,last_activity_at timestamptz,
  trophies_24h integer,trophies_3d integer,trophies_7d integer,trophies_30d integer,trophies_90d integer,trophy_baselines jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT m.player_tag,s.last_battle_at,s.last_activity_at,
    max(m.trophies-a.trophies) FILTER(WHERE r.days=1)::integer,
    max(m.trophies-a.trophies) FILTER(WHERE r.days=3)::integer,
    max(m.trophies-a.trophies) FILTER(WHERE r.days=7)::integer,
    max(m.trophies-a.trophies) FILTER(WHERE r.days=30)::integer,
    max(m.trophies-a.trophies) FILTER(WHERE r.days=90)::integer,
    jsonb_object_agg(r.key,a.recorded_at)
  FROM public.members m
  LEFT JOIN public.member_activity_state s USING(player_tag)
  CROSS JOIN (VALUES('24h',1),('3d',3),('7d',7),('30d',30),('90d',90)) r(key,days)
  -- A later observation would silently shorten the claimed period. A baseline more
  -- than 24h older is also unknown. Expose the actual observation timestamps.
  LEFT JOIN LATERAL (
    SELECT l.trophies,l.recorded_at FROM public.activity_log l
    WHERE l.player_tag=m.player_tag AND l.trophies IS NOT NULL
      AND l.recorded_at BETWEEN p_now-make_interval(days=>r.days+1) AND p_now-make_interval(days=>r.days)
    ORDER BY l.recorded_at DESC,l.id DESC LIMIT 1
  ) a ON true
  WHERE m.player_tag=ANY(p_player_tags) AND cardinality(p_player_tags)<=100
  GROUP BY m.player_tag,m.trophies,s.last_battle_at,s.last_activity_at;
$$;

CREATE OR REPLACE FUNCTION public.sync_activity_summary(p_player_tags text[],p_now timestamptz DEFAULT now())
RETURNS TABLE(player_tag text,last_battle_at timestamptz,last_activity_at timestamptz,trophies_24h integer,trophies_3d integer,trophies_7d integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT player_tag,last_battle_at,last_activity_at,trophies_24h,trophies_3d,trophies_7d
  FROM public.sync_activity_summary_v2(p_player_tags,p_now);
$$;

CREATE OR REPLACE FUNCTION public.report_account_trophy_trend(p_player_tags text[],p_days integer,p_now timestamptz DEFAULT now())
RETURNS TABLE(date date,trophies bigint,observed_members integer,total_members integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 OR p_now IS NULL OR cardinality(p_player_tags)>100 THEN
    RAISE EXCEPTION 'Invalid reporting range' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH dates AS (
    SELECT ((p_now AT TIME ZONE 'UTC')::date-i)::date AS date_key,
      least(p_now,(((p_now AT TIME ZONE 'UTC')::date-i+1)::timestamp AT TIME ZONE 'UTC')-interval '1 microsecond') cutoff
    FROM generate_series(0,p_days-1) i
  ), selected AS (SELECT m.player_tag FROM public.members m WHERE m.player_tag=ANY(p_player_tags))
  SELECT d.date_key,
    CASE WHEN count(a.trophies)=count(m.player_tag) AND count(m.player_tag)>0 THEN sum(a.trophies)::bigint ELSE NULL END,
    count(a.trophies)::integer,count(m.player_tag)::integer
  FROM dates d LEFT JOIN selected m ON true
  LEFT JOIN LATERAL (
    SELECT l.trophies FROM public.activity_log l
    WHERE l.player_tag=m.player_tag AND l.trophies IS NOT NULL
      AND l.recorded_at BETWEEN d.cutoff-interval '24 hours' AND d.cutoff
    ORDER BY l.recorded_at DESC,l.id DESC LIMIT 1
  ) a ON true
  GROUP BY d.date_key ORDER BY d.date_key;
END;
$$;

-- Keep an individual chart bounded even when legacy history contains a row per minute.
-- Every point is an actual observation; gaps are not filled with invented balances.
CREATE OR REPLACE FUNCTION public.report_member_activity_history(p_player_tag text,p_days integer,p_now timestamptz DEFAULT now())
RETURNS TABLE(id bigint,player_tag text,trophies integer,trophy_change integer,activity_type text,recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bucket_width interval; start_at timestamptz;
BEGIN
  IF p_days IS NULL OR p_days NOT IN (1,3,7,30,90) OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid reporting range' USING ERRCODE='22023';
  END IF;
  bucket_width:=CASE p_days WHEN 1 THEN interval '1 hour' WHEN 3 THEN interval '3 hours' WHEN 7 THEN interval '6 hours' ELSE interval '1 day' END;
  start_at:=(((p_now AT TIME ZONE 'UTC')::date-(p_days-1))::timestamp AT TIME ZONE 'UTC');
  RETURN QUERY SELECT q.id::bigint,q.player_tag::text,q.trophies,q.trophy_change,q.activity_type::text,q.recorded_at FROM (
    SELECT DISTINCT ON (date_bin(bucket_width,l.recorded_at,start_at))
      l.id,l.player_tag,l.trophies,l.trophy_change,l.activity_type,l.recorded_at
    FROM public.activity_log l WHERE l.player_tag=p_player_tag AND l.recorded_at BETWEEN start_at AND p_now
    ORDER BY date_bin(bucket_width,l.recorded_at,start_at),l.recorded_at DESC,l.id DESC
  ) q ORDER BY q.recorded_at DESC,q.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_activity_summary_v2(text[],timestamptz),public.sync_activity_summary(text[],timestamptz),public.report_account_trophy_trend(text[],integer,timestamptz),public.report_member_activity_history(text,integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_activity_summary_v2(text[],timestamptz),public.sync_activity_summary(text[],timestamptz),public.report_account_trophy_trend(text[],integer,timestamptz),public.report_member_activity_history(text,integer,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
