set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_data_snapshot_prune(integer)') is not null then
		raise exception 'Company data snapshot prune (20260930830000) is already applied'; end if;
end $$;

create function public.qorpera_company_data_snapshot_path(p_key text)
returns boolean language sql immutable strict set search_path = '' as $$
	select p_key ~ '^data/[a-z][a-z0-9_]{0,39}/snapshot/.+$'
$$;

create table public.qorpera_data_snapshot_prune_cursor (
	id boolean primary key default true check (id),
	created_at timestamptz not null default '-infinity',
	version uuid not null default '00000000-0000-0000-0000-000000000000',
	updated_at timestamptz not null default clock_timestamp()
);
insert into public.qorpera_data_snapshot_prune_cursor default values;

create table public.qorpera_data_snapshot_prune_held (
	version uuid primary key,
	environment_id uuid not null,
	profile_id uuid not null,
	held_at timestamptz not null default clock_timestamp(),
	checked_at timestamptz not null default clock_timestamp()
);
create index qorpera_data_snapshot_prune_held_checked on public.qorpera_data_snapshot_prune_held(checked_at, version);

alter table public.qorpera_data_snapshot_prune_cursor enable row level security;
alter table public.qorpera_data_snapshot_prune_held enable row level security;
revoke all on public.qorpera_data_snapshot_prune_cursor, public.qorpera_data_snapshot_prune_held
	from public, anon, authenticated, service_role;

create index qorpera_data_snapshot_prune_due on public.qorpera_folder_path_versions(created_at, version)
	where op in ('write', 'delete', 'move_out') and prior_version is not null
		and public.qorpera_company_data_snapshot_path(public.qorpera_folder_key(path));

create function public.qorpera_data_snapshot_version_held(p_profile_id uuid, p_manifest_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_manifest_sha256 is not null and exists (
		select 1 from public.qorpera_company_files f
		cross join lateral (
			select public.qorpera_folder_key(ov.path) as key from public.qorpera_folder_path_versions ov
			where ov.environment_id = f.environment_id and ov.manifest_sha256 = p_manifest_sha256
			union all
			select oc.key_text from public.qorpera_folder_conflict_copies oc
			where oc.environment_id = f.environment_id and oc.manifest_sha256 = p_manifest_sha256) o
		where f.profile_id = p_profile_id and f.core = 'folder-v2'
			and not public.qorpera_company_data_snapshot_path(o.key))
$$;

create function public.qorpera_data_snapshot_prune(p_versions integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_before constant timestamptz := clock_timestamp() - interval '7 days';
	v_cursor public.qorpera_data_snapshot_prune_cursor%rowtype;
	v_row record; v_profile uuid; v_hashes text[]; v_state text;
	v_open uuid[] := '{}'; v_shut uuid[] := '{}'; v_profiles uuid[] := '{}'; v_manifests text[] := '{}';
	v_last_at timestamptz; v_last uuid; v_more boolean := false;
	v_checked integer := 0; v_read integer := 0; v_pruned integer := 0; v_held integer := 0; v_released integer := 0;
begin
	if p_versions is null or p_versions < 1 or p_versions > 10000 then
		raise exception 'p_versions must be between 1 and 10000' using errcode = '22023'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'The data snapshot prune runs at read committed' using errcode = '25000'; end if;
	select * into v_cursor from public.qorpera_data_snapshot_prune_cursor where id for update skip locked;
	if not found then
		return jsonb_build_object('schema', 'qorpera.data-snapshot-prune/v1', 'busy', true); end if;

	for v_row in select h.version, h.profile_id, v.manifest_sha256, v.version is not null as present
		from public.qorpera_data_snapshot_prune_held h
		left join public.qorpera_folder_path_versions v on v.version = h.version
		order by h.checked_at, h.version limit p_versions
	loop
		v_checked := v_checked + 1;
		v_state := case when v_row.profile_id = any (v_open) then 'open' when v_row.profile_id = any (v_shut) then 'shut' end;
		if v_state is null then
			perform 1 from public.qorpera_profiles where id = v_row.profile_id for key share skip locked;
			v_state := case when found and public.qorpera_folder_gc_company(v_row.profile_id) then 'open'
				when found or not exists (select 1 from public.qorpera_profiles where id = v_row.profile_id) then 'shut' end;
			if v_state = 'open' then v_open := v_open || v_row.profile_id;
			elsif v_state = 'shut' then v_shut := v_shut || v_row.profile_id; end if;
		end if;
		if v_state is null then continue;
		elsif not v_row.present or v_state = 'shut' then
			delete from public.qorpera_data_snapshot_prune_held where version = v_row.version;
		elsif public.qorpera_data_snapshot_version_held(v_row.profile_id, v_row.manifest_sha256) then
			update public.qorpera_data_snapshot_prune_held set checked_at = clock_timestamp() where version = v_row.version;
		else
			delete from public.qorpera_folder_path_versions where version = v_row.version;
			delete from public.qorpera_data_snapshot_prune_held where version = v_row.version;
			v_profiles := v_profiles || v_row.profile_id; v_manifests := v_manifests || v_row.manifest_sha256;
			v_pruned := v_pruned + 1;
		end if;
	end loop;

	for v_row in select n.created_at, n.version as later, v.version, v.environment_id, f.profile_id, v.manifest_sha256, v.bytes
		from public.qorpera_folder_path_versions n
		left join public.qorpera_folder_path_versions v on v.version = n.prior_version and v.op = 'write'
			and v.environment_id = n.environment_id and v.key_sha256 = n.key_sha256
		left join public.qorpera_company_files f on f.environment_id = n.environment_id
		where n.op in ('write', 'delete', 'move_out') and n.prior_version is not null
			and public.qorpera_company_data_snapshot_path(public.qorpera_folder_key(n.path))
			and n.created_at <= v_before and (n.created_at, n.version) > (v_cursor.created_at, v_cursor.version)
		order by n.created_at, n.version limit p_versions
	loop
		if v_row.version is not null and v_row.profile_id is not null then
			v_state := case when v_row.profile_id = any (v_open) then 'open' when v_row.profile_id = any (v_shut) then 'shut' end;
			if v_state is null then
				perform 1 from public.qorpera_profiles where id = v_row.profile_id for key share skip locked;
				v_state := case when found and public.qorpera_folder_gc_company(v_row.profile_id) then 'open'
					when found or not exists (select 1 from public.qorpera_profiles where id = v_row.profile_id) then 'shut' end;
				if v_state = 'open' then v_open := v_open || v_row.profile_id;
				elsif v_state = 'shut' then v_shut := v_shut || v_row.profile_id; end if;
			end if;
			if v_state is null then v_more := true; exit; end if;
			if v_state = 'open' then
				if coalesce(v_row.bytes, 0) > 0 and public.qorpera_data_snapshot_version_held(v_row.profile_id, v_row.manifest_sha256) then
					insert into public.qorpera_data_snapshot_prune_held(version, environment_id, profile_id)
					values (v_row.version, v_row.environment_id, v_row.profile_id) on conflict (version) do nothing;
					v_held := v_held + 1;
				else
					delete from public.qorpera_folder_path_versions where version = v_row.version;
					v_profiles := v_profiles || v_row.profile_id; v_manifests := v_manifests || v_row.manifest_sha256;
					v_pruned := v_pruned + 1;
				end if;
			end if;
		end if;
		v_read := v_read + 1; v_last_at := v_row.created_at; v_last := v_row.later;
	end loop;
	v_more := v_more or v_read = p_versions;
	if v_last is not null then
		update public.qorpera_data_snapshot_prune_cursor set created_at = v_last_at, version = v_last, updated_at = clock_timestamp()
		where id;
	end if;

	perform 1 from public.qorpera_folder_upload_intents i
	where i.id in (select o.intent_id from unnest(v_profiles, v_manifests) x(p, m)
		join public.qorpera_folder_upload_intent_objects o on o.profile_id = x.p
		where x.m is not null and (o.sha256 = x.m or o.sha256 in (select ch.chunk_sha256 from public.qorpera_folder_file_chunks ch
			where ch.profile_id = x.p and ch.manifest_sha256 = x.m)))
	order by i.id for key share;

	for v_profile in select distinct p from unnest(v_profiles) p order by p loop
		select coalesce(array_agg(h.sha256 order by h.sha256 collate "C"), '{}') into v_hashes from (
			select x.m as sha256 from unnest(v_profiles, v_manifests) x(p, m) where x.p = v_profile and x.m is not null
			union
			select ch.chunk_sha256 from unnest(v_profiles, v_manifests) x(p, m)
			join public.qorpera_folder_file_chunks ch on ch.profile_id = v_profile and ch.manifest_sha256 = x.m
			where x.p = v_profile) h;
		v_released := v_released + public.qorpera_folder_object_release(v_profile, v_hashes);
	end loop;

	return jsonb_build_object('schema', 'qorpera.data-snapshot-prune/v1', 'checked', v_checked, 'read', v_read,
		'pruned', v_pruned, 'held', v_held, 'released', v_released, 'more', v_more);
end $$;

create function public.qorpera_schedule_data_snapshot_prune()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The data snapshot prune was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.data-snapshot-prune-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-data-snapshot-prune', '*/5 * * * *', 'select public.qorpera_data_snapshot_prune()');
		v_clean := cron.schedule('qorpera-data-snapshot-prune-log', '27 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-data-snapshot-prune')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The data snapshot prune was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.data-snapshot-prune-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.data-snapshot-prune-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

revoke all on function public.qorpera_company_data_snapshot_path(text),
	public.qorpera_data_snapshot_version_held(uuid, text),
	public.qorpera_data_snapshot_prune(integer),
	public.qorpera_schedule_data_snapshot_prune()
	from public, anon, authenticated, service_role;

select public.qorpera_schedule_data_snapshot_prune();
