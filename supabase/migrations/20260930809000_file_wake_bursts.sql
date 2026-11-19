do $$ begin
	if to_regprocedure('public.qorpera_folder_file_wake_folded(jsonb,bigint,uuid,jsonb,integer)') is not null then
		raise exception '20260930809000 is already applied'; end if;
	if to_regprocedure('public.qorpera_folder_listen_company(uuid,integer)') is null
		or to_regprocedure('public.qorpera_folder_file_wake_changes(public.qorpera_wake_occurrences,jsonb)') is null then
		raise exception '20260930809000 needs the folder listener (20260930020000)'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.file_wake_replace(p_function regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
				/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930809000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	begin
		execute v_definition;
	exception when others then
		raise exception '20260930809000 could not replace % (%): %', p_function, sqlstate, sqlerrm;
	end;
end $$;

create table public.qorpera_folder_file_wake_settings (
	singleton boolean primary key default true check (singleton),
	settle_seconds integer not null default 60 check (settle_seconds between 0 and 3600),
	ceiling_seconds integer not null default 300 check (ceiling_seconds between 0 and 86400)
);
insert into public.qorpera_folder_file_wake_settings (singleton) values (true);
alter table public.qorpera_folder_file_wake_settings enable row level security;
revoke all on public.qorpera_folder_file_wake_settings from public, anon, authenticated, service_role;

create function public.qorpera_folder_file_wake_due(p_first_change timestamptz)
returns timestamptz language sql stable security definer set search_path = '' as $$
	select case when settings.settle_seconds = 0 then clock_timestamp()
		else least(clock_timestamp() + make_interval(secs => settings.settle_seconds),
			p_first_change + make_interval(secs => settings.ceiling_seconds)) end
	from public.qorpera_folder_file_wake_settings as settings
$$;

create function public.qorpera_folder_file_wakes_fold()
returns boolean language sql stable security definer set search_path = '' as $$
	select settings.settle_seconds > 0 from public.qorpera_folder_file_wake_settings as settings
$$;

create function public.qorpera_folder_file_wake_folded(p_payload jsonb, p_seq bigint, p_commit_id uuid,
	p_versions jsonb, p_more integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_new jsonb := case when jsonb_typeof(p_versions) = 'array' then p_versions else '[]'::jsonb end;
	v_burst uuid[] := array[(p_payload ->> 'commitId')::uuid] || coalesce(array(select (folded.value ->> 'commitId')::uuid
		from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'folded') = 'array'
			then p_payload -> 'folded' else '[]'::jsonb end) as folded), '{}'::uuid[]);
	v_kept jsonb;
	v_more integer := coalesce((p_payload ->> 'more')::integer, 0) + greatest(coalesce(p_more, 0), 0);
	v_version text;
begin
	select coalesce(jsonb_agg(to_jsonb(old.version) order by old.n), '[]'::jsonb) into v_kept
	from jsonb_array_elements_text(case when jsonb_typeof(p_payload -> 'versions') = 'array'
		then p_payload -> 'versions' else '[]'::jsonb end) with ordinality as old(version, n)
	where not exists (select 1 from public.qorpera_folder_path_versions as stored
		join public.qorpera_folder_path_versions as newer
			on public.qorpera_folder_key(newer.path) = public.qorpera_folder_key(stored.path)
		where stored.version = old.version::uuid
			and newer.version in (select added.value::uuid from jsonb_array_elements_text(v_new) as added));
	for v_version in select added.value from jsonb_array_elements_text(v_new) as added loop
		if jsonb_array_length(v_kept) < 21 then
			v_kept := v_kept || to_jsonb(v_version);
		elsif not exists (select 1 from public.qorpera_folder_path_versions as newer
				join public.qorpera_folder_path_versions as earlier on earlier.commit_id = any(v_burst)
					and public.qorpera_folder_key(earlier.path) = public.qorpera_folder_key(newer.path)
				where newer.version = v_version::uuid) then
			v_more := v_more + 1;
		end if;
	end loop;
	return p_payload || jsonb_build_object('versions', v_kept, 'more', least(v_more, 1000),
		'folded', coalesce(p_payload -> 'folded', '[]'::jsonb)
			|| jsonb_build_array(jsonb_build_object('seq', p_seq, 'commitId', p_commit_id)));
end $$;

create function public.qorpera_folder_file_wake_joins(p_routine_id uuid, p_version bigint, p_planned integer)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_folder_file_wakes_fold() and (coalesce(p_planned, 0) > 0
		or exists (select 1 from public.qorpera_wake_occurrences as wake
			where wake.routine_id = p_routine_id and wake.routine_version = p_version and wake.source_kind = 'company-file'
				and wake.status = 'queued' and wake.run_id is null
				and jsonb_array_length(coalesce(wake.payload -> 'folded', '[]'::jsonb)) < 48))
$$;

create function public.qorpera_folder_file_wake_commits(p_wake public.qorpera_wake_occurrences)
returns uuid[] language sql stable security definer set search_path = '' as $$
	select array[p_wake.source_id] || coalesce(array(select (folded.value ->> 'commitId')::uuid
		from jsonb_array_elements(case when jsonb_typeof(p_wake.payload -> 'folded') = 'array'
			then p_wake.payload -> 'folded' else '[]'::jsonb end) as folded), '{}'::uuid[])
$$;

revoke all on function public.qorpera_folder_file_wake_folded(jsonb, bigint, uuid, jsonb, integer),
	public.qorpera_folder_file_wake_due(timestamptz), public.qorpera_folder_file_wakes_fold(),
	public.qorpera_folder_file_wake_commits(public.qorpera_wake_occurrences),
	public.qorpera_folder_file_wake_joins(uuid, bigint, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.file_wake_replace('public.qorpera_guard_wake_identity()', array[
	E'begin\n\t-- 20260930703000: the member\'s own recorded move',
	E'begin\n'
	|| E'\tif old.status = \'queued\' and new.status = \'queued\' and old.run_id is null and new.run_id is null\n'
	|| E'\t\tand old.source_kind = \'company-file\'\n'
	|| E'\t\tand current_setting(\'qorpera.folder_file_wake_fold\', true) = old.id::text\n'
	|| E'\t\tand (to_jsonb(new) - array[\'payload\', \'not_before\']) = (to_jsonb(old) - array[\'payload\', \'not_before\'])\n'
	|| E'\t\tand (new.payload - array[\'versions\', \'more\', \'folded\']) = (old.payload - array[\'versions\', \'more\', \'folded\']) then\n'
	|| E'\t\treturn new; end if;\n'
	|| E'\t-- 20260930703000: the member\'s own recorded move']);
select pg_temp.file_wake_replace('public.qorpera_folder_file_wake_changes(public.qorpera_wake_occurrences,jsonb)', array[
	E'\tfor v_row in select v.version, v.path, v.op, v.prior_version, v.unit_no\n',
	E'\tfor v_row in select v.version, v.path, v.op, v.prior_version, v.unit_no, v.commit_id\n',
	E'join public.qorpera_folder_path_versions v on v.version = x.version::uuid and v.commit_id = p_wake.source_id\n',
	E'join public.qorpera_folder_path_versions v on v.version = x.version::uuid\n'
	|| E'\t\t\tand v.commit_id = any(public.qorpera_folder_file_wake_commits(p_wake))\n',
	E'where o.commit_id = p_wake.source_id and o.unit_no = v_row.unit_no',
	E'where o.commit_id = v_row.commit_id and o.unit_no = v_row.unit_no']);
create index qorpera_wake_occurrences_folded_file_commits on public.qorpera_wake_occurrences
	using gin ((payload -> 'folded') jsonb_path_ops) where source_kind = 'company-file' and payload ? 'folded';

select pg_temp.file_wake_replace('public.qorpera_folder_file_wake_readable(public.qorpera_wake_occurrences)', array[
	E'and v.commit_id = p_wake.source_id\n',
	E'and v.commit_id = any(public.qorpera_folder_file_wake_commits(p_wake))\n']);

select pg_temp.file_wake_replace('public.qorpera_folder_erasure_step(integer,integer,integer)', array[
	E'join public.qorpera_wake_occurrences w on w.source_kind = \'company-file\' and w.source_id = (b ->> \'commitId\')::uuid\n',
	E'join public.qorpera_wake_occurrences w on w.source_kind = \'company-file\' and (w.source_id = (b ->> \'commitId\')::uuid\n'
	|| E'\t\t\t\tor (w.payload ? \'folded\'\n'
	|| E'\t\t\t\t\tand w.payload -> \'folded\' @> jsonb_build_array(jsonb_build_object(\'commitId\', (b ->> \'commitId\')::uuid))))\n',
	E'where w.source_kind = \'company-file\' and w.source_id = v_commit.id and w.run_id is not null\n',
	E'where w.source_kind = \'company-file\' and w.run_id is not null and (w.source_id = v_commit.id\n'
	|| E'\t\t\t\t\t\t\tor (w.payload ? \'folded\'\n'
	|| E'\t\t\t\t\t\t\t\tand w.payload -> \'folded\' @> jsonb_build_array(jsonb_build_object(\'commitId\', v_commit.id))))\n']);

select pg_temp.file_wake_replace('public.qorpera_folder_listen_company(uuid,integer)', array[
	E'or (v_routine.max_occurrences is not null and public.qorpera_routine_occurrence_count(v_routine.id)',
	E'or (v_routine.max_occurrences is not null\n'
	|| E'\t\t\t\t\t\tand not public.qorpera_folder_file_wake_joins(v_routine.id, (v_match.m ->> \'version\')::bigint,\n'
	|| E'\t\t\t\t\t\t\t(v_inserted ->> v_routine.id::text)::integer)\n'
	|| E'\t\t\t\t\t\tand public.qorpera_routine_occurrence_count(v_routine.id)',
	E'and w.occurrence_key = \'file:\' || (v_match.m ->> \'seq\') || \':\' || (v_match.m ->> \'version\')) then',
	E'and (w.occurrence_key = \'file:\' || (v_match.m ->> \'seq\') || \':\' || (v_match.m ->> \'version\')\n'
	|| E'\t\t\t\t\t\t\tor (w.routine_version = (v_match.m ->> \'version\')::bigint and w.payload -> \'folded\'\n'
	|| E'\t\t\t\t\t\t\t\t@> jsonb_build_array(jsonb_build_object(\'seq\', (v_match.m ->> \'seq\')::bigint))))) then',
	E'\t\t\t\t\tinsert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, wake_kind,\n',
	E'\t\t\t\t\tselect w.* into v_wake from public.qorpera_wake_occurrences w\n'
	|| E'\t\t\t\t\twhere w.routine_id = (v_match.m ->> \'routineId\')::uuid and w.routine_version = (v_match.m ->> \'version\')::bigint\n'
	|| E'\t\t\t\t\t\tand w.source_kind = \'company-file\' and w.status = \'queued\' and w.run_id is null\n'
	|| E'\t\t\t\t\t\tand jsonb_array_length(coalesce(w.payload -> \'folded\', \'[]\'::jsonb)) < 48\n'
	|| E'\t\t\t\t\torder by w.created_at, w.id limit 1 for update skip locked;\n'
	|| E'\t\t\t\t\tif found and public.qorpera_folder_file_wakes_fold() then\n'
	|| E'\t\t\t\t\t\tperform set_config(\'qorpera.folder_file_wake_fold\', v_wake.id::text, true);\n'
	|| E'\t\t\t\t\t\tupdate public.qorpera_wake_occurrences\n'
	|| E'\t\t\t\t\t\tset payload = public.qorpera_folder_file_wake_folded(payload, (v_match.m ->> \'seq\')::bigint,\n'
	|| E'\t\t\t\t\t\t\t\t(v_match.m ->> \'commitId\')::uuid, v_match.m -> \'versions\', (v_match.m ->> \'more\')::integer),\n'
	|| E'\t\t\t\t\t\t\tnot_before = public.qorpera_folder_file_wake_due(scheduled_for)\n'
	|| E'\t\t\t\t\t\twhere id = v_wake.id;\n'
	|| E'\t\t\t\t\t\tperform set_config(\'qorpera.folder_file_wake_fold\', \'\', true);\n'
	|| E'\t\t\t\t\telse\n'
	|| E'\t\t\t\t\tinsert into public.qorpera_wake_occurrences(id, profile_id, environment_id, routine_id, routine_version, wake_kind,\n',
	E'(v_match.m ->> \'createdAt\')::timestamptz, clock_timestamp(),',
	E'(v_match.m ->> \'createdAt\')::timestamptz,\n'
	|| E'\t\t\t\t\t\tpublic.qorpera_folder_file_wake_due((v_match.m ->> \'createdAt\')::timestamptz),',
	E'\t\t\t\t\tv_wakes := v_wakes + 1;\n',
	E'\t\t\t\t\tend if;\n\t\t\t\t\tv_wakes := v_wakes + 1;\n']);

drop function pg_temp.file_wake_replace(regprocedure, text[]);
