-- @fixture 887_folder_core_listener.test.sql until "-- 2. Matching: exact and subtree"

create function pg_temp.fb_actor(w public.qorpera_wake_occurrences) returns jsonb language sql as $$
	select public.qorpera_folder_listener_actor(w.profile_id, w.staff_agent_id, w.requested_by_user_id, w.session_id)
$$;
create function pg_temp.fb_queued() returns public.qorpera_wake_occurrences language sql as $$
	select * from public.qorpera_wake_occurrences where routine_id = '88700000-0000-4000-8000-0000000000e1'
		and source_kind = 'company-file' and status = 'queued'
	order by created_at desc limit 1
$$;
create function pg_temp.fb_seqs(w public.qorpera_wake_occurrences) returns bigint[] language sql as $$
	select array[(w.payload ->> 'seq')::bigint] || coalesce(array(select (f.value ->> 'seq')::bigint
		from jsonb_array_elements(coalesce(w.payload -> 'folded', '[]'::jsonb)) as f order by (f.value ->> 'seq')::bigint),
		'{}'::bigint[])
$$;
create temp table fb_seqs (n integer primary key, seq bigint not null);
update public.qorpera_folder_file_wake_settings set settle_seconds = 60, ceiling_seconds = 300;

do $$
declare r jsonb; v_n integer; v_path text;
begin
	for v_n in 1..38 loop
		v_path := 'docs/s' || lpad((case when v_n <= 30 then v_n else v_n - 30 end)::text, 2, '0') || '.md';
		r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'burst-' || lpad(v_n::text, 4, '0'), jsonb_build_array(
			pg_temp.put(v_path, 'draft ' || v_n))));
		insert into fb_seqs values (v_n, (r ->> 'seq')::bigint);
		perform pg_temp.is(pg_temp.listen() ->> 'state', 'done', 'a listener step after change set ' || v_n);
	end loop;
end $$;

do $$
declare w public.qorpera_wake_occurrences := pg_temp.fb_queued(); v_read jsonb; v_paths text[];
begin
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '1',
		'38 change sets in a burst under the watch wake the routine once');
	perform pg_temp.is(pg_temp.fb_seqs(w)::text, (select array_agg(seq order by n) from fb_seqs)::text,
		'the wake names every change set of the burst, first in seq and the rest folded');
	if w.occurrence_key <> 'file:' || (select seq from fb_seqs where n = 1) || ':1'
		or w.source_id::text <> w.payload ->> 'commitId' then
		raise exception 'The wake keeps its first change set''s key and commit: %', to_jsonb(w); end if;
	if w.not_before <= clock_timestamp() or w.not_before > w.scheduled_for + interval '5 minutes' then
		raise exception 'It settles a minute after the last change, at most five after the first: % / %', w.not_before,
			w.scheduled_for; end if;
	perform pg_temp.is(jsonb_array_length(w.payload -> 'versions')::text, '21', 'at most 21 versions are kept');
	perform pg_temp.is(w.payload ->> 'more', '9', 'the other paths are counted');
	v_read := public.qorpera_folder_file_wake_changes(w, pg_temp.fb_actor(w));
	select array_agg(c ->> 'path' order by c ->> 'path') into v_paths from jsonb_array_elements(v_read -> 'changes') as c;
	if v_read ->> 'seq' <> (select seq from fb_seqs where n = 1)::text or v_read ->> 'commitId' <> w.source_id::text
		or jsonb_array_length(v_read -> 'changes') <> 21 or (v_read ->> 'more')::integer <> 9
		or cardinality(v_paths) <> cardinality(array(select distinct unnest(v_paths))) then
		raise exception 'The run reads each changed path once, in the v1 envelope: %', v_read; end if;
	if not exists (select 1 from jsonb_array_elements(v_read -> 'changes') as c
			where c ->> 'path' = 'docs/s08.md' and (c ->> 'version')::uuid = pg_temp.version('docs/s08.md')) then
		raise exception 'A file saved twice shows at its newest version: %', v_read; end if;
	if (v_read -> 'changes' -> 20 ->> 'path') <> 'docs/s08.md' or (v_read -> 'changes' -> 13 ->> 'path') <> 'docs/s01.md'
		or (v_read -> 'changes' -> 0 ->> 'path') <> 'docs/s09.md' then
		raise exception 'A file saved again moves to the end of the burst''s list: %', v_read; end if;
end $$;

do $$
declare w public.qorpera_wake_occurrences := pg_temp.fb_queued(); r jsonb; v_n integer; v_follow public.qorpera_wake_occurrences;
begin
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set status = 'materialized', run_id = extensions.gen_random_uuid() where id = w.id;
	set local session_replication_role = origin;
	for v_n in 39..44 loop
		r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'burst-' || lpad(v_n::text, 4, '0'), jsonb_build_array(
			pg_temp.put('docs/late' || v_n || '.md', 'late ' || v_n))));
		perform pg_temp.listen();
	end loop;
	v_follow := pg_temp.fb_queued();
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '2',
		'while the first wake runs, one follow-up collects what is saved meanwhile');
	perform pg_temp.is(cardinality(pg_temp.fb_seqs(v_follow))::text, '6', 'the follow-up names its six change sets');
	set local session_replication_role = replica;
	update public.qorpera_wake_occurrences set scheduled_for = clock_timestamp() - interval '10 minutes' where id = v_follow.id;
	set local session_replication_role = origin;
	r := pg_temp.saved(pg_temp.commit(pg_temp.owner(), 'burst-0045', jsonb_build_array(pg_temp.put('docs/late45.md', 'x'))));
	perform pg_temp.listen();
	v_follow := pg_temp.fb_queued();
	if v_follow.not_before <> v_follow.scheduled_for + interval '5 minutes' then
		raise exception 'A steady stream still runs five minutes after its first change: %', to_jsonb(v_follow); end if;
	perform pg_temp.is(pg_temp.fw_count('88700000-0000-4000-8000-0000000000e1')::text, '2', 'still one follow-up');
end $$;

do $$
declare w public.qorpera_wake_occurrences := pg_temp.fb_queued();
begin
	begin
		update public.qorpera_wake_occurrences set payload = payload || '{"more":999}'::jsonb where id = w.id;
		raise exception 'A wake''s payload changed outside the listener';
	exception when insufficient_privilege then
		if sqlerrm <> 'Admitted wake identity is immutable' then raise; end if;
	end;
	perform set_config('qorpera.folder_file_wake_fold', w.id::text, true);
	begin
		update public.qorpera_wake_occurrences set payload = payload || jsonb_build_object('seq', 1) where id = w.id;
		raise exception 'A fold changed the wake''s first change set';
	exception when insufficient_privilege then
		if sqlerrm <> 'Admitted wake identity is immutable' then raise; end if;
	end;
	perform set_config('qorpera.folder_file_wake_fold', '', true);
	if has_function_privilege('authenticated', 'public.qorpera_folder_file_wake_folded(jsonb,bigint,uuid,jsonb,integer)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_folder_file_wake_commits(public.qorpera_wake_occurrences)', 'EXECUTE') then
		raise exception 'The fold helpers are nobody''s to call'; end if;
end $$;

set constraints all immediate;
rollback;
