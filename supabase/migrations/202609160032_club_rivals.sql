BEGIN;
CREATE TABLE public.club_rivals (
  club_tag text NOT NULL CHECK(club_tag ~ '^#[0289PYLQGRJCUV]{2,19}$'),
  rival_tag text NOT NULL CHECK(rival_tag ~ '^#[0289PYLQGRJCUV]{2,19}$'),
  active boolean NOT NULL DEFAULT true, profile jsonb, fetched_at timestamptz, expires_at timestamptz,
  lease_token uuid, lease_until timestamptz, retry_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(club_tag,rival_tag), CHECK(club_tag<>rival_tag),
  CHECK(profile IS NULL OR (jsonb_typeof(profile)='object' AND pg_column_size(profile)<=10000))
);
CREATE TABLE public.club_rival_snapshots (
  club_tag text NOT NULL, rival_tag text NOT NULL, day date NOT NULL, observed_at timestamptz NOT NULL,
  trophies bigint NOT NULL CHECK(trophies>=0), member_count integer NOT NULL CHECK(member_count BETWEEN 0 AND 30),
  PRIMARY KEY(club_tag,rival_tag,day), FOREIGN KEY(club_tag,rival_tag) REFERENCES public.club_rivals(club_tag,rival_tag)
);
CREATE TABLE public.club_rank_history (
  club_tag text NOT NULL, observed_tag text NOT NULL, region text NOT NULL CHECK(region IN ('global','TN','DZ','MA','FR','EG','SA','US')),
  day date NOT NULL, observed_at timestamptz NOT NULL, rank integer CHECK(rank BETWEEN 1 AND 50), trophies bigint CHECK(trophies>=0),
  PRIMARY KEY(club_tag,observed_tag,region,day)
);
CREATE INDEX club_rank_history_recent ON public.club_rank_history(club_tag,region,day DESC);
ALTER TABLE public.club_rivals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_rival_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_rank_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_rivals,public.club_rival_snapshots,public.club_rank_history FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.club_rivals,public.club_rival_snapshots,public.club_rank_history TO service_role;

CREATE FUNCTION public.save_club_rival(p_club text,p_tag text,p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
BEGIN
  IF p_club IS NULL OR p_tag IS NULL OR p_active IS NULL OR p_club=p_tag OR p_club !~ '^#[0289PYLQGRJCUV]{2,19}$' OR p_tag !~ '^#[0289PYLQGRJCUV]{2,19}$' THEN RAISE EXCEPTION 'invalid_club' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('club-rivals:'||p_club,0));
  IF p_active AND NOT EXISTS(SELECT 1 FROM public.club_rivals WHERE club_tag=p_club AND rival_tag=p_tag AND active) AND (SELECT count(*) FROM public.club_rivals WHERE club_tag=p_club AND active)>=5 THEN RAISE EXCEPTION 'rival_limit' USING ERRCODE='54000'; END IF;
  IF NOT p_active THEN UPDATE public.club_rivals SET active=false,updated_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE club_tag=p_club AND rival_tag=p_tag; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.club_rivals WHERE club_tag=p_club AND rival_tag=p_tag) AND (SELECT count(*) FROM public.club_rivals WHERE club_tag=p_club)>=100 THEN RAISE EXCEPTION 'rival_archive_limit' USING ERRCODE='54000'; END IF;
  INSERT INTO public.club_rivals(club_tag,rival_tag) VALUES(p_club,p_tag)
    ON CONFLICT(club_tag,rival_tag) DO UPDATE SET active=true,updated_at=clock_timestamp();
END $$;

CREATE FUNCTION public.claim_club_rival(p_club text,p_tag text,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='3s' AS $$
DECLARE v_row public.club_rivals; v_now timestamptz; v_pause timestamptz;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'token_required'; END IF;
  SELECT * INTO v_row FROM public.club_rivals WHERE club_tag=p_club AND rival_tag=p_tag AND active FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now:=clock_timestamp();
  BEGIN SELECT value::timestamptz INTO v_pause FROM public.settings WHERE key='sync_upstream_cooldown_until'; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN v_pause:=NULL; END;
  IF v_row.expires_at>v_now OR v_row.lease_until>v_now OR v_row.retry_at>v_now OR v_pause>v_now THEN RETURN jsonb_build_object('acquired',false,'entry',to_jsonb(v_row)-'lease_token'); END IF;
  UPDATE public.club_rivals SET lease_token=p_token,lease_until=v_now+interval '15 seconds' WHERE club_tag=p_club AND rival_tag=p_tag;
  RETURN jsonb_build_object('acquired',true,'entry',to_jsonb(v_row)-'lease_token');
END $$;

CREATE FUNCTION public.finish_club_rival(p_club text,p_tag text,p_token uuid,p_profile jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_now timestamptz:=clock_timestamp();
BEGIN
  IF p_profile IS NOT NULL AND (jsonb_typeof(p_profile)<>'object' OR p_profile->>'tag' IS DISTINCT FROM p_tag OR NOT(p_profile ?& ARRAY['trophies','memberCount']) OR (p_profile->>'trophies')::bigint<0 OR (p_profile->>'memberCount')::integer NOT BETWEEN 0 AND 30) THEN RAISE EXCEPTION 'invalid_club'; END IF;
  UPDATE public.club_rivals SET profile=coalesce(p_profile,profile),fetched_at=CASE WHEN p_profile IS NULL THEN fetched_at ELSE v_now END,
    expires_at=CASE WHEN p_profile IS NULL THEN expires_at ELSE v_now+interval '6 hours' END,
    retry_at=CASE WHEN p_profile IS NULL THEN v_now+interval '5 minutes' ELSE NULL END,lease_token=NULL,lease_until=NULL
    WHERE club_tag=p_club AND rival_tag=p_tag AND active AND lease_token=p_token AND lease_until>v_now;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_profile IS NOT NULL THEN
    INSERT INTO public.club_rival_snapshots VALUES(p_club,p_tag,(v_now AT TIME ZONE 'UTC')::date,v_now,(p_profile->>'trophies')::bigint,(p_profile->>'memberCount')::integer)
    ON CONFLICT(club_tag,rival_tag,day) DO UPDATE SET observed_at=excluded.observed_at,trophies=excluded.trophies,member_count=excluded.member_count;
  END IF;
  DELETE FROM public.club_rival_snapshots WHERE day<(v_now AT TIME ZONE 'UTC')::date-90;
  DELETE FROM public.club_rank_history WHERE day<(v_now AT TIME ZONE 'UTC')::date-90;
  RETURN true;
END $$;

CREATE FUNCTION public.capture_club_rank_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_club text; v_region text; v_tag text; v_entry jsonb; v_now timestamptz;
BEGIN
  IF NEW.cache_key !~ '^rankings:(global|TN|DZ|MA|FR|EG|SA|US):clubs$' OR NEW.fetched_at IS NULL OR NEW.fetched_at IS NOT DISTINCT FROM OLD.fetched_at OR jsonb_typeof(NEW.payload)<>'array' THEN RETURN NEW; END IF;
  SELECT value INTO v_club FROM public.settings WHERE key='club_tag';
  IF v_club IS NULL OR v_club !~ '^#[0289PYLQGRJCUV]{2,19}$' THEN RETURN NEW; END IF;
  v_now:=NEW.fetched_at; v_region:=split_part(NEW.cache_key,':',2);
  FOR v_tag IN SELECT v_club UNION SELECT rival_tag FROM public.club_rivals WHERE club_tag=v_club AND active LOOP
    SELECT value INTO v_entry FROM jsonb_array_elements(NEW.payload) WHERE value->>'tag'=v_tag AND value->>'rank' ~ '^[0-9]+$' AND (value->>'rank')::integer BETWEEN 1 AND 50 LIMIT 1;
    INSERT INTO public.club_rank_history VALUES(v_club,v_tag,v_region,(v_now AT TIME ZONE 'UTC')::date,v_now,(v_entry->>'rank')::integer,(v_entry->>'trophies')::bigint)
      ON CONFLICT(club_tag,observed_tag,region,day) DO UPDATE SET observed_at=excluded.observed_at,rank=excluded.rank,trophies=excluded.trophies;
  END LOOP;
  DELETE FROM public.club_rank_history WHERE day<(v_now AT TIME ZONE 'UTC')::date-90;
  RETURN NEW;
END $$;
CREATE TRIGGER game_cache_club_rank_history AFTER UPDATE ON public.game_api_cache FOR EACH ROW EXECUTE FUNCTION public.capture_club_rank_history();
REVOKE ALL ON FUNCTION public.save_club_rival(text,text,boolean),public.claim_club_rival(text,text,uuid),public.finish_club_rival(text,text,uuid,jsonb),public.capture_club_rank_history() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_club_rival(text,text,boolean),public.claim_club_rival(text,text,uuid),public.finish_club_rival(text,text,uuid,jsonb),public.capture_club_rank_history() TO service_role;
COMMIT;
