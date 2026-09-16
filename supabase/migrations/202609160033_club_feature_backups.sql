-- Include every new club feature in the consistent encrypted snapshot.
BEGIN;
CREATE OR REPLACE FUNCTION public.create_backup_snapshot(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET statement_timeout='50s' AS $$
DECLARE
  v_allowed text[] := ARRAY['members','activity_log','club_events','member_history','settings','battle_history','player_tracking','brawler_snapshots','daily_stats','notifications','profiles','clubs','user_clubs','sync_runs','sync_leases','membership_change_events','notification_outbox','member_activity_state','player_brawler_state','member_reviews','admin_login_attempts','backup_snapshots','backup_chunks','sync_battle_coverage','sync_battle_gaps','capacity_samples','sync_ranked_fallback_attempts','club_sync_signals','player_profile_details','player_brawler_details','player_ranked_history','game_api_cache','recruitment_candidates','club_roster_snapshots','club_profiles','club_profile_events','member_decision_log','member_absences','club_administration_settings','recruitment_applications','recruitment_application_limits','club_goals','club_goal_members','club_goal_snapshots','club_planned_events','club_event_entries','club_event_revisions','club_rivals','club_rival_snapshots','club_rank_history'];
  v_tables jsonb := '[]'; v_sequences jsonb := '[]'; v_functions jsonb; v_enums jsonb;
  v_table record; v_sequence record; v_state record; v_columns jsonb; v_constraints jsonb;
  v_indexes jsonb; v_policies jsonb; v_grants jsonb; v_column_grants jsonb;
  v_manifest jsonb; v_chunks jsonb; v_count bigint; v_order text; v_created timestamptz;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'backup_request_id_required' USING ERRCODE='22023'; END IF;
  PERFORM set_config('TimeZone','UTC',true);
  PERFORM set_config('DateStyle','ISO, YMD',true);
  PERFORM set_config('extra_float_digits','3',true);
  IF NOT pg_try_advisory_xact_lock(184772931, 3) THEN RAISE EXCEPTION 'backup_busy' USING ERRCODE='55P03'; END IF;
  SELECT manifest INTO v_manifest FROM public.backup_snapshots WHERE id=p_request_id;
  IF FOUND THEN RETURN (SELECT jsonb_build_object('snapshot_id',id,'created_at',created_at,'status',status) FROM public.backup_snapshots WHERE id=p_request_id); END IF;
  -- Admission takes the shared mutex until its lease commits. Holding the
  -- exclusive side here means no unseen/new live lease can appear after this read.
  -- Existing snapshot replays above do not capture data or need table locks.
  IF EXISTS(SELECT 1 FROM public.sync_leases WHERE run_id IS NOT NULL AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'backup_sync_active' USING ERRCODE='55P03';
  END IF;
  DELETE FROM public.backup_snapshots WHERE expires_at < clock_timestamp();
  IF (SELECT count(*) FROM public.backup_snapshots WHERE status='ready') >= 2 THEN
    RAISE EXCEPTION 'backup_pending_exports' USING ERRCODE='55P03';
  END IF;
  -- A new app table must be consciously added to the snapshot allowlist.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND NOT c.relname=ANY(v_allowed)
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype='e')) THEN
    RAISE EXCEPTION 'backup_unlisted_public_relation' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY(v_allowed) AND (c.relkind <> 'r' OR c.relispartition)) THEN
    RAISE EXCEPTION 'backup_unsupported_relation' USING ERRCODE='22023';
  END IF;
  -- NOWAIT bounds interference with ingestion. All locks are acquired before
  -- any schema/data reads, in a deterministic order, and held to commit.
  FOR v_table IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(v_allowed)
      AND c.relname NOT IN ('backup_snapshots','backup_chunks') ORDER BY c.relname
  LOOP EXECUTE format('LOCK TABLE public.%I IN SHARE MODE NOWAIT',v_table.relname); END LOOP;
  v_created := clock_timestamp();
  INSERT INTO public.backup_snapshots(id,created_at) VALUES(p_request_id,v_created);

  FOR v_table IN SELECT c.*,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(v_allowed) ORDER BY c.relname
  LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'nullable',NOT a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
      'collation',CASE WHEN a.attcollation<>0 AND a.attcollation<>t.typcollation THEN a.attcollation::regcollation::text END) ORDER BY a.attnum),'[]')
      INTO v_columns FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=v_table.oid AND a.attnum>0 AND NOT a.attisdropped;
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),
      'external_schema',CASE WHEN confrelid<>0 THEN (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=confrelid) END) ORDER BY conname),'[]')
      INTO v_constraints FROM pg_constraint WHERE conrelid=v_table.oid;
    SELECT coalesce(jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text),'[]') INTO v_indexes
      FROM pg_index i WHERE i.indrelid=v_table.oid AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid);
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,
      'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END) FROM unnest(p.polroles) r),
      'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]')
      INTO v_policies FROM pg_policy p WHERE p.polrelid=v_table.oid;
    SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') INTO v_grants
      FROM aclexplode(coalesce(v_table.relacl,acldefault('r',v_table.relowner))) a;
    SELECT coalesce(jsonb_agg(jsonb_build_object('column',c.attname,'role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') INTO v_column_grants
      FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid=v_table.oid AND c.attnum>0 AND NOT c.attisdropped;
    v_count := 0;
    IF v_table.relname NOT IN ('backup_snapshots','backup_chunks') THEN
      -- One set-based pass per table. Batches avoid a table-sized string_agg;
      -- binary splitting also supports very large rows and UTF8 characters.
      SELECT string_agg(format('t.%I',a.attname),',' ORDER BY k.ordinality) INTO v_order
        FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=v_table.oid AND i.indisprimary;
      v_order := coalesce(v_order,'t.ctid');
      EXECUTE format($copy$
        WITH lines AS (
          SELECT row_number() OVER(ORDER BY %s) AS rn,to_jsonb(t)::text || E'\n' AS line FROM public.%I t
        ), batches AS (
          SELECT (rn-1)/500 AS batch,convert_to(string_agg(line,'' ORDER BY rn),'UTF8') AS bytes FROM lines GROUP BY (rn-1)/500
        ), pieces AS (
          SELECT batch,part,substring(bytes FROM part FOR 524288) AS bytes FROM batches
          CROSS JOIN LATERAL generate_series(1,octet_length(bytes),524288) part
        ) INSERT INTO public.backup_chunks(snapshot_id,table_name,chunk_index,payload,byte_count,sha256)
          SELECT $1,$2,(row_number() OVER(ORDER BY batch,part)-1)::integer,
            replace(encode(bytes,'base64'),E'\n',''),octet_length(bytes),encode(sha256(bytes),'hex') FROM pieces
      $copy$,v_order,v_table.relname) USING p_request_id,v_table.relname;
      EXECUTE format('SELECT count(*) FROM public.%I',v_table.relname) INTO v_count;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('index',chunk_index,'bytes',byte_count,'sha256',sha256) ORDER BY chunk_index),'[]')
      INTO v_chunks FROM public.backup_chunks WHERE snapshot_id=p_request_id AND table_name=v_table.relname;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('name',v_table.relname,'owner',v_table.owner,'columns',v_columns,
      'constraints',v_constraints,'indexes',v_indexes,'policies',v_policies,'grants',v_grants,'column_grants',v_column_grants,
      'rls',v_table.relrowsecurity,'force_rls',v_table.relforcerowsecurity,'replica_identity',v_table.relreplident,
      'row_count',v_count,'chunks',v_chunks,'data_excluded',v_table.relname IN ('backup_snapshots','backup_chunks'),
      'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) ORDER BY t.tgname),'[]')
        FROM pg_trigger t WHERE t.tgrelid=v_table.oid AND NOT t.tgisinternal)));
  END LOOP;
  FOR v_sequence IN SELECT c.*,s.*,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_sequence s ON s.seqrelid=c.oid WHERE n.nspname='public' ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT last_value::text,is_called FROM public.%I',v_sequence.relname) INTO v_state;
    v_sequences := v_sequences || jsonb_build_array(jsonb_build_object('name',v_sequence.relname,'owner',v_sequence.owner,
      'type',format_type(v_sequence.seqtypid,NULL),'start',v_sequence.seqstart::text,'increment',v_sequence.seqincrement::text,
      'min',v_sequence.seqmin::text,'max',v_sequence.seqmax::text,'cache',v_sequence.seqcache::text,'cycle',v_sequence.seqcycle,
      'last_value',v_state.last_value,'is_called',v_state.is_called,
      'owned_by',(SELECT jsonb_build_object('table',t.relname,'column',a.attname,'identity',a.attidentity) FROM pg_depend d
        JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
        WHERE d.classid='pg_class'::regclass AND d.objid=v_sequence.oid AND d.deptype IN ('a','i') LIMIT 1),
      'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') FROM aclexplode(coalesce(v_sequence.relacl,acldefault('s',v_sequence.relowner))) a)));
  END LOOP;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'identity',p.oid::regprocedure::text,
    'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
    'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) ORDER BY p.oid::regprocedure::text),'[]')
    INTO v_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e');
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.typname,'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)) ORDER BY t.typname),'[]')
    INTO v_enums FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e';
  v_manifest := jsonb_build_object('format','brawl-backup-v1','snapshot_id',p_request_id,'created_at',v_created,
    'server_version',current_setting('server_version'),'encoding','UTF8','tables',v_tables,'sequences',v_sequences,'functions',v_functions,'enums',v_enums,
    'extension_inventory',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)),'[]') FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql'),
    -- Provider-installed extensions are inventory, not automatically restore
    -- requirements. Include only catalog dependencies of public app objects.
    'extensions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)),'[]')
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql' AND EXISTS (
        SELECT 1 FROM pg_depend dependency JOIN pg_depend extension_object
          ON extension_object.classid=dependency.refclassid AND extension_object.objid=dependency.refobjid
          AND extension_object.refclassid='pg_extension'::regclass AND extension_object.refobjid=e.oid AND extension_object.deptype='e'
        WHERE NOT EXISTS(SELECT 1 FROM pg_depend own WHERE own.classid=dependency.classid AND own.objid=dependency.objid AND own.deptype='e') AND (
          (dependency.classid='pg_attrdef'::regclass AND EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE d.oid=dependency.objid AND ns.nspname='public')) OR
          (dependency.classid='pg_class'::regclass AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE c.oid=dependency.objid AND ns.nspname='public')) OR
          (dependency.classid='pg_proc'::regclass AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE p.oid=dependency.objid AND ns.nspname='public')) OR
          (dependency.classid='pg_constraint'::regclass AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace ns ON ns.oid=c.connamespace WHERE c.oid=dependency.objid AND ns.nspname='public')) OR
          (dependency.classid='pg_type'::regclass AND EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace WHERE t.oid=dependency.objid AND ns.nspname='public')) OR
          (dependency.classid='pg_policy'::regclass AND EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE p.oid=dependency.objid AND ns.nspname='public'))
        ))),
    'publications',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',pubname,'table',tablename,'columns',attnames,'row_filter',rowfilter)),'[]') FROM pg_publication_tables WHERE schemaname='public'),
    'schema', (SELECT jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'grants',
      (SELECT coalesce(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a))
      FROM pg_namespace n WHERE n.nspname='public'),
    'external_dependencies',(SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('schema',referenced.nspname,
      'object',pg_describe_object(d.classid,d.objid,d.objsubid),'dependency',pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid))),'[]')
      FROM pg_depend d CROSS JOIN LATERAL (
        SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE d.refclassid='pg_proc'::regclass AND p.oid=d.refobjid
        UNION ALL SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE d.refclassid='pg_class'::regclass AND c.oid=d.refobjid
        UNION ALL SELECT n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE d.refclassid='pg_type'::regclass AND t.oid=d.refobjid
      ) referenced WHERE referenced.nspname NOT IN ('public','pg_catalog','information_schema')
      AND NOT EXISTS(SELECT 1 FROM pg_depend extension_object WHERE extension_object.classid=d.refclassid AND extension_object.objid=d.refobjid AND extension_object.deptype='e')
      AND (
        (d.classid='pg_policy'::regclass AND EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE p.oid=d.objid AND n.nspname='public')) OR
        (d.classid='pg_attrdef'::regclass AND EXISTS(SELECT 1 FROM pg_attrdef a JOIN pg_class c ON c.oid=a.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.oid=d.objid AND n.nspname='public')) OR
        (d.classid='pg_class'::regclass AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=d.objid AND n.nspname='public')) OR
        (d.classid='pg_proc'::regclass AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=d.objid AND n.nspname='public')) OR
        (d.classid='pg_constraint'::regclass AND EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.oid=d.objid AND n.nspname='public')) OR
        (d.classid='pg_type'::regclass AND EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.oid=d.objid AND n.nspname='public'))
      )),
    'default_grants',(SELECT coalesce(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'type',d.defaclobjtype,
      'schema',n.nspname,'role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace=0 OR n.nspname='public'));
  IF octet_length(v_manifest::text)>3000000 THEN RAISE EXCEPTION 'backup_manifest_too_large' USING ERRCODE='54000'; END IF;
  UPDATE public.backup_snapshots SET manifest=v_manifest WHERE id=p_request_id;
  RETURN jsonb_build_object('snapshot_id',p_request_id,'created_at',v_created,'status','ready');
END;
$$;
REVOKE ALL ON FUNCTION public.create_backup_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_backup_snapshot(uuid) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
