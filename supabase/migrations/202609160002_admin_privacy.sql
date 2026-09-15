-- Private reviews and shared admin login throttling. Apply after schema.sql.
BEGIN;

CREATE TABLE IF NOT EXISTS public.member_reviews (
  player_tag VARCHAR(20) PRIMARY KEY REFERENCES public.member_history(player_tag),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'follow_up')),
  follow_up_at TIMESTAMPTZ,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT member_reviews_follow_up CHECK (
    (status = 'follow_up' AND follow_up_at IS NOT NULL)
    OR (status <> 'follow_up' AND follow_up_at IS NULL)
  )
);
ALTER TABLE public.member_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_reviews TO service_role;

CREATE OR REPLACE FUNCTION public.touch_member_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_member_review() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS member_reviews_updated_at ON public.member_reviews;
CREATE TRIGGER member_reviews_updated_at BEFORE UPDATE ON public.member_reviews
FOR EACH ROW EXECUTE FUNCTION public.touch_member_review();

-- Copy notes exactly once. Preserve the legacy column as a recovery source;
-- rerunning this migration never replaces a subsequently edited private note.
INSERT INTO public.member_reviews (player_tag, notes)
SELECT player_tag, notes FROM public.member_history WHERE notes IS NOT NULL
ON CONFLICT (player_tag) DO NOTHING;

-- RLS policies apply to rows, not individual columns. Remove inherited table
-- SELECT and grant only public history columns; SELECT * must fail for anon.
REVOKE ALL ON public.member_history FROM PUBLIC, anon, authenticated;
REVOKE ALL (notes) ON public.member_history FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  player_tag, player_name, first_seen, last_seen, last_left_at, times_joined,
  times_left, is_current_member, role_at_leave, trophies_at_leave
) ON public.member_history TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_history TO service_role;

-- Legacy tenant identifiers were added outside schema.sql. They are not part
-- of the public club dashboard, even on tables whose rows are public.
DO $$
DECLARE item text; columns_sql text;
BEGIN
  FOREACH item IN ARRAY ARRAY['members','member_history','activity_log','club_events','battle_history','brawler_snapshots','daily_stats','notifications','player_tracking'] LOOP
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.' || item) AND attname='owner_user_id' AND NOT attisdropped) THEN
      SELECT string_agg(quote_ident(attname),', ' ORDER BY attnum) INTO columns_sql FROM pg_attribute
        WHERE attrelid=to_regclass('public.' || item) AND attnum>0 AND NOT attisdropped
          AND attname<>'owner_user_id' AND NOT (item='member_history' AND attname='notes');
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',item);
      EXECUTE format('REVOKE ALL (owner_user_id) ON public.%I FROM PUBLIC,anon,authenticated',item);
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO anon,authenticated',columns_sql,item);
      -- Keep existing subscriptions, omitting the private column from WAL.
      IF item<>'member_history' AND EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=item) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I',item);
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I (%s)',item,columns_sql);
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- No frontend subscription uses member_history. Exclude its legacy private
-- notes from Realtime as well as SELECT; public history uses the HTTP API.
-- Private reviews are only available through authenticated server APIs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'member_history') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.member_history;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'member_reviews') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.member_reviews;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.admin_login_attempts (
  client_key TEXT PRIMARY KEY CHECK (client_key ~ '^[0-9a-f]{64}$'),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 9),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_expiry ON public.admin_login_attempts(expires_at);
ALTER TABLE public.admin_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_login_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_login_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.consume_admin_login_attempt(p_client_key TEXT)
RETURNS TABLE(allowed BOOLEAN, retry_after INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_count INTEGER;
  v_expiry TIMESTAMPTZ;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid rate-limit key' USING ERRCODE = '22023';
  END IF;
  -- Bounded work on every request; no unbounded background cleanup is needed.
  DELETE FROM public.admin_login_attempts WHERE client_key IN (
    SELECT old.client_key FROM public.admin_login_attempts AS old
    WHERE old.expires_at <= v_now ORDER BY old.expires_at LIMIT 100
  );
  INSERT INTO public.admin_login_attempts AS attempts (client_key, attempt_count, expires_at)
  VALUES (p_client_key, 1, v_now + INTERVAL '10 minutes')
  ON CONFLICT (client_key) DO UPDATE SET
    attempt_count = CASE WHEN attempts.expires_at <= v_now THEN 1 ELSE LEAST(attempts.attempt_count + 1, 9) END,
    expires_at = CASE WHEN attempts.expires_at <= v_now THEN v_now + INTERVAL '10 minutes' ELSE attempts.expires_at END
  RETURNING attempt_count, expires_at INTO v_count, v_expiry;
  RETURN QUERY SELECT v_count <= 8,
    CASE WHEN v_count <= 8 THEN 0 ELSE GREATEST(1, CEIL(EXTRACT(EPOCH FROM v_expiry - v_now))::INTEGER) END;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_admin_login_attempt(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_admin_login_attempt(TEXT) TO service_role;

-- Empty legacy account tables have no implemented tenant authorization model.
-- Lock them down without deleting data or inventing policies for Clerk users.
DO $$
DECLARE legacy_table TEXT; legacy_columns TEXT;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY['profiles', 'clubs', 'user_clubs'] LOOP
    IF to_regclass('public.' || legacy_table) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', legacy_table);
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', legacy_table);
      -- Table-level REVOKE does not remove older column-specific grants.
      SELECT string_agg(quote_ident(attname), ', ') INTO legacy_columns
      FROM pg_attribute WHERE attrelid = to_regclass('public.' || legacy_table)
        AND attnum > 0 AND NOT attisdropped;
      IF legacy_columns IS NOT NULL THEN
        EXECUTE format('REVOKE ALL (%s) ON public.%I FROM PUBLIC, anon, authenticated', legacy_columns, legacy_table);
      END IF;
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', legacy_table);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
