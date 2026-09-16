-- One public invalidation signal per committed snapshot, not per battle row.
BEGIN;

CREATE TABLE IF NOT EXISTS public.club_sync_signals (
  id smallint PRIMARY KEY CHECK (id = 1),
  version uuid,
  completed_at timestamptz,
  datasets text[] NOT NULL DEFAULT '{}',
  CHECK (datasets <@ ARRAY['roster','battles','ranked']::text[]),
  CHECK ((version IS NULL) = (completed_at IS NULL))
);
ALTER TABLE public.club_sync_signals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_sync_signals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.club_sync_signals TO anon, authenticated, service_role;
DROP POLICY IF EXISTS club_sync_signal_read ON public.club_sync_signals;
CREATE POLICY club_sync_signal_read ON public.club_sync_signals FOR SELECT TO anon, authenticated USING (true);
INSERT INTO public.club_sync_signals(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.publish_club_sync_signal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status <> 'succeeded' OR NEW.finished_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settings WHERE key='club_tag'
    AND upper(CASE WHEN left(trim(value),1)='#' THEN trim(value) ELSE '#' || trim(value) END)=NEW.club_tag) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.club_sync_signals(id,version,completed_at,datasets)
  VALUES (1,NEW.id,NEW.finished_at,CASE WHEN NEW.scope='roster' THEN ARRAY['roster']::text[]
    ELSE ARRAY['roster','battles','ranked']::text[] END)
  ON CONFLICT (id) DO UPDATE SET version=excluded.version,completed_at=excluded.completed_at,datasets=excluded.datasets;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.publish_club_sync_signal() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS publish_completed_club_sync ON public.sync_runs;
CREATE TRIGGER publish_completed_club_sync AFTER INSERT OR UPDATE OF status ON public.sync_runs
FOR EACH ROW EXECUTE FUNCTION public.publish_club_sync_signal();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime' AND NOT puballtables)
    AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
      AND schemaname='public' AND tablename='club_sync_signals') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.club_sync_signals;
  END IF;
END $$;
COMMIT;
