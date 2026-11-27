set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_folder_sweep_upload_intents_cron(integer)') is not null then
		raise exception 'Company storage cleanup and perf (20260930928000) is already applied';
	end if;
	if to_regprocedure('public.qorpera_folder_sweep_upload_intents(integer)') is null
		or to_regprocedure('public.qorpera_folder_object_release(uuid,text[])') is null
		or to_regprocedure('public.qorpera_folder_gc_company(uuid)') is null
		or to_regprocedure('public.qorpera_folder_object_rooted(uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_code_care_step(text,text,uuid,text,text,uuid,text)') is null
		or to_regprocedure('public.qorpera_company_file_json(public.qorpera_company_files)') is null
		or to_regprocedure('public.qorpera_surface_archive_coding_workers(uuid[],text)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_session_cleanup(uuid,uuid)') is null then
		raise exception 'Company storage cleanup and perf (20260930928000) requires prior folder GC, code care, and surface cleanup migrations';
	end if;
end $$;

create temporary table cscp_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc as p
where p.pronamespace = 'public'::regnamespace;

create function pg_temp.cscp_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	if coalesce(cardinality(p_edits), 0) = 0 or cardinality(p_edits) % 2 <> 0 then
		raise exception '20260930928000 invalid edits for %', p_target;
	end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930928000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 120);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

create function public.qorpera_folder_sweep_upload_intents_cron(p_limit integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_intent_ids uuid[];
	v_profiles uuid[] := '{}';
	v_shas text[] := '{}';
	v_expires timestamptz[] := '{}';
	v_swept integer := 0;
	v_queued integer := 0;
	v_skipped integer := 0;
	v_fallback boolean := false;
	v_id uuid;
	v_intent public.qorpera_folder_upload_intents%rowtype;
	v_item_queued integer;
	v_fallback_limit integer;
begin
	if p_limit is null or p_limit < 1 or p_limit > 10000 then
		raise exception 'p_limit must be between 1 and 10000' using errcode = '22023';
	end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder intent sweep needs read committed isolation' using errcode = '25000';
	end if;
	if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.folder-intent-sweep', 0)) then
		return jsonb_build_object(
			'schema', 'qorpera.folder-intent-sweep/v1',
			'busy', true,
			'fallback', false,
			'swept', 0,
			'queued', 0,
			'skipped', 0,
			'more', false
		);
	end if;
	begin
		select coalesce(array_agg(locked.id), '{}'::uuid[]) into v_intent_ids
		from (
			select i.id
			from public.qorpera_folder_upload_intents i
			where i.expires_at < clock_timestamp() - interval '1 hour'
			order by i.expires_at, i.id
			limit p_limit
			for update skip locked
		) locked;
		if cardinality(v_intent_ids) = 0 then
			return jsonb_build_object(
				'schema', 'qorpera.folder-intent-sweep/v1',
				'busy', false,
				'fallback', false,
				'swept', 0,
				'queued', 0,
				'skipped', 0,
				'more', false
			);
		end if;
		select
			coalesce(array_agg(cand.profile_id order by cand.profile_id, cand.sha256 collate "C"), '{}'::uuid[]),
			coalesce(array_agg(cand.sha256 order by cand.profile_id, cand.sha256 collate "C"), '{}'::text[]),
			coalesce(array_agg(cand.max_expires_at order by cand.profile_id, cand.sha256 collate "C"), '{}'::timestamptz[])
		into v_profiles, v_shas, v_expires
		from (
			select o.profile_id, o.sha256, max(i.expires_at) as max_expires_at
			from public.qorpera_folder_upload_intent_objects o
			join public.qorpera_folder_upload_intents i on i.id = o.intent_id
			where o.intent_id = any(v_intent_ids)
				and public.qorpera_folder_gc_company(o.profile_id)
			group by o.profile_id, o.sha256
		) cand;
		delete from public.qorpera_folder_upload_intents
		where id = any(v_intent_ids);
		get diagnostics v_swept = row_count;
		if cardinality(v_profiles) > 0 then
			with inserted as (
				insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
				select c.profile_id, c.sha256, c.unreferenced_since
				from unnest(v_profiles, v_shas, v_expires) as c(profile_id, sha256, unreferenced_since)
				where exists (
					select 1 from public.qorpera_profile_objects po
					where po.profile_id = c.profile_id and po.sha256 = c.sha256
				)
					and not public.qorpera_folder_object_rooted(c.profile_id, c.sha256, null)
				order by c.profile_id, c.sha256 collate "C"
				on conflict (profile_id, sha256) do update
				set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since)
				returning 1
			)
			select count(*)::integer into v_queued from inserted;
		end if;
	exception when lock_not_available or deadlock_detected or foreign_key_violation then
		v_fallback := true;
		v_swept := 0;
		v_queued := 0;
		v_skipped := 0;
		v_fallback_limit := least(p_limit, 100);
		for v_id in
			select i.id
			from public.qorpera_folder_upload_intents i
			where i.expires_at < clock_timestamp() - interval '1 hour'
			order by i.expires_at, i.id
			limit v_fallback_limit
		loop
			begin
				select * into v_intent
				from public.qorpera_folder_upload_intents
				where id = v_id and expires_at < clock_timestamp() - interval '1 hour'
				for update skip locked;
				if not found then
					continue;
				end if;
				v_shas := '{}';
				if public.qorpera_folder_gc_company(v_intent.profile_id) then
					select coalesce(array_agg(o.sha256 order by o.sha256 collate "C"), '{}'::text[])
					into v_shas
					from public.qorpera_folder_upload_intent_objects o
					where o.intent_id = v_intent.id;
				end if;
				delete from public.qorpera_folder_upload_intents where id = v_intent.id;
				if cardinality(v_shas) > 0 then
					with inserted as (
						insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
						select v_intent.profile_id, s.sha256, v_intent.expires_at
						from unnest(v_shas) as s(sha256)
						where exists (
							select 1 from public.qorpera_profile_objects po
							where po.profile_id = v_intent.profile_id and po.sha256 = s.sha256
						)
							and not public.qorpera_folder_object_rooted(v_intent.profile_id, s.sha256, null)
						order by s.sha256 collate "C"
						on conflict (profile_id, sha256) do update
						set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since)
						returning 1
					)
					select count(*)::integer into v_item_queued from inserted;
					v_queued := v_queued + v_item_queued;
				end if;
				v_swept := v_swept + 1;
			exception when lock_not_available or deadlock_detected or foreign_key_violation then
				v_skipped := v_skipped + 1;
			end;
		end loop;
	end;
	return jsonb_build_object(
		'schema', 'qorpera.folder-intent-sweep/v1',
		'busy', false,
		'fallback', v_fallback,
		'swept', v_swept,
		'queued', v_queued,
		'skipped', v_skipped,
		'more', case when v_fallback then (v_swept + v_skipped) = v_fallback_limit or v_skipped > 0 else v_swept = p_limit end
	);
end $$;

create function public.qorpera_schedule_folder_intent_sweep()
returns jsonb language plpgsql set search_path = '' as $$
declare
	v_step bigint;
	v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The folder intent sweep was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.folder-intent-sweep-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-folder-intent-sweep', '*/1 * * * *', 'select public.qorpera_folder_sweep_upload_intents_cron()');
		v_clean := cron.schedule('qorpera-folder-intent-sweep-log', '31 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-folder-intent-sweep')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The folder intent sweep was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.folder-intent-sweep-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.folder-intent-sweep-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

create function public.qorpera_code_checkout_path(p_key text)
returns boolean language sql immutable strict set search_path = '' as $$
	select left(p_key, 5) = 'code/' and p_key ~ '^code/[^/]+/[^/]+/(worktrees|main|repo\.git/worktrees)/.+$'
$$;

create table public.qorpera_code_checkout_prune_cursor (
	id boolean primary key default true check (id),
	created_at timestamptz not null default '-infinity',
	version uuid not null default '00000000-0000-0000-0000-000000000000',
	updated_at timestamptz not null default clock_timestamp()
);
insert into public.qorpera_code_checkout_prune_cursor default values;

create table public.qorpera_code_checkout_prune_held (
	version uuid primary key,
	environment_id uuid not null,
	profile_id uuid not null,
	held_at timestamptz not null default clock_timestamp(),
	checked_at timestamptz not null default clock_timestamp()
);
create index qorpera_code_checkout_prune_held_checked on public.qorpera_code_checkout_prune_held(checked_at, version);

alter table public.qorpera_code_checkout_prune_cursor enable row level security;
alter table public.qorpera_code_checkout_prune_held enable row level security;
revoke all on public.qorpera_code_checkout_prune_cursor, public.qorpera_code_checkout_prune_held
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create index qorpera_code_checkout_prune_due on public.qorpera_folder_path_versions(created_at, version)
	where op in ('write', 'delete', 'move_out') and prior_version is not null
		and public.qorpera_code_checkout_path(public.qorpera_folder_key(path));

create function public.qorpera_code_checkout_version_held(p_profile_id uuid, p_manifest_sha256 text)
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
			and not public.qorpera_code_checkout_path(o.key))
$$;

create function public.qorpera_code_checkout_prune(p_versions integer default 2000)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
	v_before constant timestamptz := clock_timestamp() - interval '7 days';
	v_cursor public.qorpera_code_checkout_prune_cursor%rowtype;
	v_row record; v_profile uuid; v_hashes text[]; v_state text;
	v_open uuid[] := '{}'; v_shut uuid[] := '{}'; v_profiles uuid[] := '{}'; v_manifests text[] := '{}';
	v_last_at timestamptz; v_last uuid; v_more boolean := false;
	v_checked integer := 0; v_read integer := 0; v_pruned integer := 0; v_held integer := 0; v_released integer := 0;
begin
	if p_versions is null or p_versions < 1 or p_versions > 10000 then
		raise exception 'p_versions must be between 1 and 10000' using errcode = '22023'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'The code checkout prune runs at read committed' using errcode = '25000'; end if;
	select * into v_cursor from public.qorpera_code_checkout_prune_cursor where id for update skip locked;
	if not found then
		return jsonb_build_object('schema', 'qorpera.code-checkout-prune/v1', 'busy', true); end if;

	for v_row in select h.version, h.environment_id, h.profile_id, v.manifest_sha256,
			(v.version is not null and not exists (
				select 1 from public.qorpera_folder_entries e
				where e.environment_id = v.environment_id and e.version = v.version
			)) as prunable
		from public.qorpera_code_checkout_prune_held h
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
		elsif not v_row.prunable or v_state = 'shut' then
			delete from public.qorpera_code_checkout_prune_held where version = v_row.version;
		elsif public.qorpera_code_checkout_version_held(v_row.profile_id, v_row.manifest_sha256) then
			update public.qorpera_code_checkout_prune_held set checked_at = clock_timestamp() where version = v_row.version;
		else
			delete from public.qorpera_folder_path_versions where version = v_row.version;
			delete from public.qorpera_code_checkout_prune_held where version = v_row.version;
			v_profiles := v_profiles || v_row.profile_id; v_manifests := v_manifests || v_row.manifest_sha256;
			v_pruned := v_pruned + 1;
		end if;
	end loop;

	for v_row in select n.created_at, n.version as later, v.version, v.environment_id, f.profile_id, v.manifest_sha256, v.bytes
		from public.qorpera_folder_path_versions n
		left join public.qorpera_folder_path_versions v on v.version = n.prior_version and v.op = 'write'
			and v.environment_id = n.environment_id and v.key_sha256 = n.key_sha256
			and not exists (
				select 1 from public.qorpera_folder_entries e
				where e.environment_id = v.environment_id and e.version = v.version
			)
		left join public.qorpera_company_files f on f.environment_id = n.environment_id
		where n.op in ('write', 'delete', 'move_out') and n.prior_version is not null
			and public.qorpera_code_checkout_path(public.qorpera_folder_key(n.path))
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
				if coalesce(v_row.bytes, 0) > 0 and public.qorpera_code_checkout_version_held(v_row.profile_id, v_row.manifest_sha256) then
					insert into public.qorpera_code_checkout_prune_held(version, environment_id, profile_id)
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
		update public.qorpera_code_checkout_prune_cursor set created_at = v_last_at, version = v_last, updated_at = clock_timestamp()
		where id;
	end if;

	if cardinality(v_profiles) > 0 then
		perform 1 from public.qorpera_folder_upload_intents i
		where i.id in (
			with pruned_hashes as (
				select x.p as profile_id, x.m as sha256 from unnest(v_profiles, v_manifests) x(p, m)
				where x.m is not null
				union
				select ch.profile_id, ch.chunk_sha256 as sha256 from unnest(v_profiles, v_manifests) x(p, m)
				join public.qorpera_folder_file_chunks ch on ch.profile_id = x.p and ch.manifest_sha256 = x.m
				where x.m is not null
			)
			select o.intent_id from pruned_hashes ph
			join public.qorpera_folder_upload_intent_objects o on o.profile_id = ph.profile_id and o.sha256 = ph.sha256
		)
		order by i.id for key share;
	end if;

	for v_profile in select distinct p from unnest(v_profiles) p order by p loop
		select coalesce(array_agg(h.sha256 order by h.sha256 collate "C"), '{}') into v_hashes from (
			select x.m as sha256 from unnest(v_profiles, v_manifests) x(p, m) where x.p = v_profile and x.m is not null
			union
			select ch.chunk_sha256 from unnest(v_profiles, v_manifests) x(p, m)
			join public.qorpera_folder_file_chunks ch on ch.profile_id = v_profile and ch.manifest_sha256 = x.m
			where x.p = v_profile) h;
		v_released := v_released + public.qorpera_folder_object_release(v_profile, v_hashes);
	end loop;

	return jsonb_build_object('schema', 'qorpera.code-checkout-prune/v1', 'checked', v_checked, 'read', v_read,
		'pruned', v_pruned, 'held', v_held, 'released', v_released, 'more', v_more);
end $$;

create function public.qorpera_schedule_code_checkout_prune()
returns jsonb language plpgsql set search_path = '' as $$
declare v_step bigint; v_clean bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'The code checkout prune was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.code-checkout-prune-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_step := cron.schedule('qorpera-code-checkout-prune', '*/5 * * * *', 'select public.qorpera_code_checkout_prune()');
		v_clean := cron.schedule('qorpera-code-checkout-prune-log', '33 3 * * *',
			$q$delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'qorpera-code-checkout-prune')
				and end_time < now() - interval '1 day'$q$);
	exception when others then
		raise warning 'The code checkout prune was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.code-checkout-prune-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.code-checkout-prune-schedule/v1', 'scheduled', true,
		'jobs', jsonb_build_array(v_step, v_clean));
end $$;

select pg_temp.cscp_patch('public.qorpera_code_care_step(text,text,uuid,text,text,uuid,text)'::regprocedure, array[
$old$				and session.archived_at <= v_now - interval '168 hours' and session.attached_machine_id is null
				and worker.state <> 'active'$old$,
$new$				and (
					session.archived_at <= v_now - interval '168 hours'
					or (
						worker.surface_backed
						and session.phase not in ('queued', 'preparing', 'running', 'publishing', 'input_ready')
						and exists (
							select 1 from public.qorpera_surface_sessions ss
							where ss.id = worker.surface_session_id
								and ss.state = 'completed'
								and not ss.has_active_chat
								and ss.closed_at <= v_now - interval '24 hours'
								and not exists (
									select 1 from public.qorpera_surface_jobs sj
									where sj.session_id = ss.id and sj.status in ('queued', 'running')
								)
						)
					)
				)
				and session.attached_machine_id is null
				and worker.state <> 'active'$new$
]);

create function public.qorpera_surface_backfill_discarded_cleanups()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
	v_group record;
	v_session_id uuid;
	v_total integer := 0;
begin
	for v_group in
		select
			coalesce(w.environment_id, ss.profile_id) as group_id,
			array_agg(ss.id order by ss.id) as session_ids
		from public.qorpera_surface_sessions ss
		join public.qorpera_surfaces surf on surf.id = ss.surface_id
		left join public.qorpera_runtime_workers w on w.id = ss.worker_id
		where ss.state = 'discarded'
			and ss.worker_id is not null
			and public.qorpera_company_is_folder_v2(ss.profile_id)
			and surf.source_kind = 'code_repo'
			and surf.repository_key is not null
			and not exists (
				select 1 from public.qorpera_surface_jobs j
				where j.session_id = ss.id
					and j.kind = 'cleanup_session'
					and j.status in ('queued', 'running', 'completed')
			)
			and (
				ss.branch_head_sha is not null
				or exists (
					select 1 from public.qorpera_coding_sessions cs
					where cs.worker_id = ss.worker_id and cs.archived_at is null
				)
			)
		group by coalesce(w.environment_id, ss.profile_id)
		order by coalesce(w.environment_id, ss.profile_id)
	loop
		perform public.qorpera_surface_archive_coding_workers(v_group.session_ids, 'surface_discarded');
		foreach v_session_id in array v_group.session_ids loop
			perform public.qorpera_surface_enqueue_session_cleanup(v_session_id, null);
		end loop;
		v_total := v_total + coalesce(cardinality(v_group.session_ids), 0);
	end loop;
	return v_total;
end $$;

select public.qorpera_surface_backfill_discarded_cleanups();

select pg_temp.cscp_patch('public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure, array[
$old$		'retained_storage_bytes', coalesce((
			select sum(object.bytes)
			from public.qorpera_profile_objects as object
			where object.profile_id = p_file.profile_id
				and exists (
					select 1
					from public.qorpera_company_retained_object_hashes(p_file.profile_id) as retained
					where retained.object_sha256 = object.sha256
				)
		), 0),$old$,
$new$		'retained_storage_bytes', case when public.qorpera_company_is_folder_v2(p_file.profile_id) then 0::bigint else coalesce((
			select sum(object.bytes)
			from public.qorpera_profile_objects as object
			where object.profile_id = p_file.profile_id
				and exists (
					select 1
					from public.qorpera_company_retained_object_hashes(p_file.profile_id) as retained
					where retained.object_sha256 = object.sha256
				)
		), 0) end,$new$,
$old$		'object_backends', coalesce((
			select jsonb_agg(backend.backend order by backend.backend)
			from (
				select distinct object.backend
				from public.qorpera_profile_objects as object
				where object.profile_id = p_file.profile_id
			) as backend
		), '[]'::jsonb),$old$,
$new$		'object_backends', case when public.qorpera_company_is_folder_v2(p_file.profile_id) then '[]'::jsonb else coalesce((
			select jsonb_agg(backend.backend order by backend.backend)
			from (
				select distinct object.backend
				from public.qorpera_profile_objects as object
				where object.profile_id = p_file.profile_id
			) as backend
		), '[]'::jsonb) end,$new$
]);

revoke all on function
	public.qorpera_folder_sweep_upload_intents_cron(integer),
	public.qorpera_schedule_folder_intent_sweep(),
	public.qorpera_code_checkout_path(text),
	public.qorpera_code_checkout_version_held(uuid, text),
	public.qorpera_code_checkout_prune(integer),
	public.qorpera_schedule_code_checkout_prune(),
	public.qorpera_surface_backfill_discarded_cleanups()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_code_care_step(text,text,uuid,text,text,uuid,text)'::regprocedure,
			'public.qorpera_company_file_json(public.qorpera_company_files)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930928000 patched function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_surface_sessions, public.qorpera_surface_jobs to %I', v_owner);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join cscp_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930928000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.cscp_patch(regprocedure, text[]);
drop table cscp_before;

comment on function public.qorpera_folder_sweep_upload_intents_cron(integer) is
	'20260930928000: set-based pg_cron sweeper for expired folder upload intents with per-intent contention fallback.';
comment on function public.qorpera_schedule_folder_intent_sweep() is
	'20260930928000: schedules the per-minute folder upload intent sweeper and daily job log cleanup.';
comment on function public.qorpera_code_checkout_path(text) is
	'20260930928000: matches code checkout and main paths eligible for 7-day superseded history pruning.';
comment on function public.qorpera_code_checkout_version_held(uuid, text) is
	'20260930928000: returns true when a manifest is still referenced outside code checkout/main paths.';
comment on function public.qorpera_code_checkout_prune(integer) is
	'20260930928000: prunes superseded/deleted code checkout and main path versions older than 7 days and releases unrooted objects.';
comment on function public.qorpera_schedule_code_checkout_prune() is
	'20260930928000: schedules the 5-minute code checkout history pruner and daily job log cleanup.';
comment on function public.qorpera_code_care_step(text, text, uuid, text, text, uuid, text) is
	'20260930928000: retires clean worktrees for 7-day archived sessions and 24-hour closed completed surface sessions.';
comment on function public.qorpera_surface_backfill_discarded_cleanups() is
	'20260930928000: archives coding workers and enqueues cleanup_session for pre-migration discarded code_repo surface sessions.';
comment on function public.qorpera_company_file_json(public.qorpera_company_files) is
	'20260930928000: skips snapshot-v1 full-table object scans for folder-v2 companies while preserving all JSON keys.';

select public.qorpera_schedule_folder_intent_sweep();
select public.qorpera_schedule_code_checkout_prune();
