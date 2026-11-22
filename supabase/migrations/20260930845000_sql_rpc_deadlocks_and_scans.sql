-- WHY: Harden hot-path SQL RPCs against AB-BA deadlocks, starvation, unbounded lock waits,
-- and index-defeating predicates via additive function replacements and targeted patches.
set local lock_timeout = '3s';

create function pg_temp.rpc_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930845000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930845000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

-- WHY: Short-circuit vault-backed identities before scanning qorpera_runtime_machine_allocations.
create or replace function public.qorpera_runtime_run_adapter_allowed(p_run public.qorpera_execution_runs, p_adapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select case
		when p_run.compute_identity_id is null then true
		when public.qorpera_compute_identity_login_in_vault(p_run.compute_identity_id) then true
		else not exists (
			select 1 from public.qorpera_runtime_machine_allocations as home
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(home)) identity_home on true
			where home.login_compute_identity_id = p_run.compute_identity_id
		)
		or exists (
			select 1 from public.qorpera_runtime_machine_allocations as home
			join lateral(select 1 where public.qorpera_runtime_identity_home_allocation(home)) identity_home on true
			where home.login_compute_identity_id = p_run.compute_identity_id
				and home.provider_adapter = p_adapter
		)
	end
$$;

-- WHY: Aggregate busy counts once per orchestrator instead of re-evaluating the busy CTE per fast node.
select pg_temp.rpc_patch('public.qorpera_runtime_run_placement(public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure, array[
$old$	with busy as (
		select claim.orchestrator_id from public.qorpera_runner_job_claims claim
		where claim.status in ('claimed', 'assigned') and claim.run_id <> p_run.id
		union all
		select latest.orchestrator_id from public.qorpera_runner_jobs job
		cross join lateral (select claim.orchestrator_id from public.qorpera_runner_job_claims claim
			where claim.run_id = job.run_id and claim.job_id = job.id and claim.status = 'accepted'
			order by claim.created_at desc, claim.id desc limit 1) latest
		where job.status = 'leased' and job.run_id <> p_run.id
	)
	select nodes.node_id into v_node
	from (select distinct (f ->> 'nodeId')::uuid node_id from jsonb_array_elements(v_fast) f) nodes
	order by nodes.node_id is not distinct from v_last_node,
		-- A last-resort node (20260930749000) ranks below every other fast host's node; the failed node still ranks last.
		coalesce((select last_resort_node.last_resort from public.qorpera_runtime_nodes last_resort_node
			where last_resort_node.id = nodes.node_id), false),
		(select count(*) from busy where busy.orchestrator_id in (select (g ->> 'orchestratorId')::uuid
		from jsonb_array_elements(v_fast) g where (g ->> 'nodeId')::uuid = nodes.node_id)), nodes.node_id
	limit 1;$old$,
$new$	with fast_hosts as materialized (
		select distinct (f ->> 'nodeId')::uuid as node_id, (f ->> 'orchestratorId')::uuid as orchestrator_id
		from jsonb_array_elements(v_fast) f
	),
	busy_by_orchestrator as materialized (
		select busy.orchestrator_id, count(*)::bigint as busy_count
		from (
			select claim.orchestrator_id from public.qorpera_runner_job_claims claim
			where claim.status in ('claimed', 'assigned') and claim.run_id <> p_run.id
			union all
			select latest.orchestrator_id from public.qorpera_runner_jobs job
			cross join lateral (select claim.orchestrator_id from public.qorpera_runner_job_claims claim
				where claim.run_id = job.run_id and claim.job_id = job.id and claim.status = 'accepted'
				order by claim.created_at desc, claim.id desc limit 1) latest
			where job.status = 'leased' and job.run_id <> p_run.id
		) busy
		group by busy.orchestrator_id
	)
	select fh.node_id into v_node
	from fast_hosts fh
	left join busy_by_orchestrator b on b.orchestrator_id = fh.orchestrator_id
	group by fh.node_id
	order by fh.node_id is not distinct from v_last_node,
		coalesce((select last_resort_node.last_resort from public.qorpera_runtime_nodes last_resort_node
			where last_resort_node.id = fh.node_id), false),
		coalesce(sum(b.busy_count), 0), fh.node_id
	limit 1;$new$
]);

-- WHY: Pick one unleased candidate per company and use non-blocking advisory locks to prevent
-- multi-company starvation and AB-BA advisory-lock deadlocks across concurrent workers.
select pg_temp.rpc_patch('public.qorpera_claim_digital_post_letter_file(uuid,integer)'::regprocedure, array[
$old$	for v_candidate in
		select letter.id, letter.profile_id
		from public.qorpera_digital_post_letters as letter
		where letter.status = 'kept'
			and (letter.write_lease_until is null or letter.write_lease_until <= v_now)
			and (letter.write_not_before is null or letter.write_not_before <= v_now)
			and public.qorpera_environment_is_folder_v2(letter.environment_id)
			and not public.qorpera_company_deleting(letter.profile_id)
		order by letter.kept_at, letter.id
		limit 20
	loop
		-- One claim of a company at a time; then a company whose letter another writer holds is passed over. The check runs
		-- after the lock, so it sees a lease the claim before this one committed.
		perform pg_advisory_xact_lock(hashtextextended('qorpera.digital-post-write:' || v_candidate.profile_id::text, 0));$old$,
$new$	for v_candidate in
		select distinct_company.id, distinct_company.profile_id
		from (
			select distinct on (letter.profile_id) letter.id, letter.profile_id, letter.kept_at
			from public.qorpera_digital_post_letters as letter
			where letter.status = 'kept'
				and (letter.write_lease_until is null or letter.write_lease_until <= v_now)
				and (letter.write_not_before is null or letter.write_not_before <= v_now)
				and public.qorpera_environment_is_folder_v2(letter.environment_id)
				and not public.qorpera_company_deleting(letter.profile_id)
				and not exists (
					select 1 from public.qorpera_digital_post_letters as active
					where active.profile_id = letter.profile_id and active.status = 'kept'
						and active.write_lease_until > v_now
				)
			order by letter.profile_id, letter.kept_at, letter.id
		) as distinct_company
		order by distinct_company.kept_at, distinct_company.id
		limit 20
	loop
		continue when not pg_try_advisory_xact_lock(hashtextextended('qorpera.digital-post-write:' || v_candidate.profile_id::text, 0));$new$
]);

-- WHY: Aggregate each letter file's bytea chunks once instead of twice (up to 2x 32 MiB).
select pg_temp.rpc_patch('public.qorpera_seal_digital_post_letter(uuid,text,uuid,bigint,uuid,uuid)'::regprocedure, array[
$old$		if exists (
			select 1
			from jsonb_array_elements(v_letter.files) with ordinality as file(value, position)
			where coalesce((
				select octet_length(string_agg(chunk.content, ''::bytea order by chunk.chunk_index))::bigint = (file.value->>'bytes')::bigint
					and encode(sha256(coalesce(string_agg(chunk.content, ''::bytea order by chunk.chunk_index), ''::bytea)), 'hex')
						= file.value->>'sha256'
				from public.qorpera_digital_post_chunks as chunk
				where chunk.letter_id = v_letter.id and chunk.file_index = file.position - 1
			), false) is not true
				and not ((file.value->>'bytes')::bigint = 0
					and not exists (select 1 from public.qorpera_digital_post_chunks as chunk
						where chunk.letter_id = v_letter.id and chunk.file_index = file.position - 1)
					and file.value->>'sha256' = encode(sha256(''::bytea), 'hex'))
		) then$old$,
$new$		if exists (
			select 1
			from jsonb_array_elements(v_letter.files) with ordinality as file(value, position)
			left join lateral (
				select coalesce(string_agg(chunk.content, ''::bytea order by chunk.chunk_index), ''::bytea) as body
				from public.qorpera_digital_post_chunks as chunk
				where chunk.letter_id = v_letter.id and chunk.file_index = file.position - 1
			) as staged on true
			where octet_length(staged.body)::bigint is distinct from (file.value->>'bytes')::bigint
				or encode(sha256(staged.body), 'hex') is distinct from (file.value->>'sha256')
		) then$new$
]);

-- WHY: Use key_sha256 PK lookup on qorpera_folder_entries, skip busy cursor ticks, and lock
-- surviving profiles in id order FOR KEY SHARE SKIP LOCKED before queueing GC rows.
select pg_temp.rpc_patch('public.qorpera_folder_git_versions_expire(integer)'::regprocedure, array[
$old$	v_queued integer := 0;
begin
	if p_limit is null or p_limit not between 1 and 10000 then
		raise exception 'The expiry''s limit is invalid' using errcode = '22023'; end if;
	select * into v_cursor from public.qorpera_folder_git_expiry for update;$old$,
$new$	v_queued integer := 0; v_open_profiles uuid[];
begin
	if p_limit is null or p_limit not between 1 and 10000 then
		raise exception 'The expiry''s limit is invalid' using errcode = '22023'; end if;
	select * into v_cursor from public.qorpera_folder_git_expiry for update skip locked;
	if not found then
		return jsonb_build_object('schema', 'qorpera.folder-git-expiry/v1', 'scanned', 0, 'expired', 0,
			'queued', 0, 'busy', true); end if;$new$,
$old$		with gone as (
			delete from public.qorpera_folder_path_versions as version
			where version.version = any(v_ended) and not exists (select 1 from public.qorpera_folder_entries as entry
				where entry.environment_id = version.environment_id and entry.version = version.version)
			returning version.environment_id, version.manifest_sha256)
		select count(*)::integer, coalesce(jsonb_agg(distinct jsonb_build_object('profile', file.profile_id,
				'manifest', gone.manifest_sha256))
			filter (where gone.manifest_sha256 is not null and file.profile_id is not null), '[]')
		into v_expired, v_gone
		from gone left join public.qorpera_company_files as file on file.environment_id = gone.environment_id;
		insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
		select hash.profile_id, hash.sha256, clock_timestamp() from (
			select (gone ->> 'profile')::uuid as profile_id, gone ->> 'manifest' as sha256
			from jsonb_array_elements(v_gone) as gone
			union
			select chunk.profile_id, chunk.chunk_sha256 from jsonb_array_elements(v_gone) as gone
			join public.qorpera_folder_file_chunks as chunk on chunk.profile_id = (gone ->> 'profile')::uuid
				and chunk.manifest_sha256 = gone ->> 'manifest') as hash
		where public.qorpera_folder_gc_company(hash.profile_id)
			and exists (select 1 from public.qorpera_profile_objects as object where object.profile_id = hash.profile_id
				and object.sha256 = hash.sha256)
		order by hash.profile_id, hash.sha256 collate "C"
		on conflict (profile_id, sha256) do update
		set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
		get diagnostics v_queued = row_count;$old$,
$new$		with gone as (
			delete from public.qorpera_folder_path_versions as version
			where version.version = any(v_ended) and not exists (select 1 from public.qorpera_folder_entries as entry
				where entry.environment_id = version.environment_id and entry.key_sha256 = version.key_sha256
					and entry.version = version.version)
			returning version.environment_id, version.manifest_sha256)
		select count(*)::integer, coalesce(jsonb_agg(distinct jsonb_build_object('profile', file.profile_id,
				'manifest', gone.manifest_sha256))
			filter (where gone.manifest_sha256 is not null and file.profile_id is not null), '[]')
		into v_expired, v_gone
		from gone left join public.qorpera_company_files as file on file.environment_id = gone.environment_id;
		if jsonb_array_length(v_gone) > 0 then
			select coalesce(array_agg(locked.id order by locked.id), '{}') into v_open_profiles
			from (
				select p.id from public.qorpera_profiles p
				where p.id in (select distinct (g ->> 'profile')::uuid from jsonb_array_elements(v_gone) g)
				order by p.id for key share skip locked
			) locked;
			if cardinality(v_open_profiles) > 0 then
				insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
				select hash.profile_id, hash.sha256, clock_timestamp() from (
					select (gone ->> 'profile')::uuid as profile_id, gone ->> 'manifest' as sha256
					from jsonb_array_elements(v_gone) as gone
					union
					select chunk.profile_id, chunk.chunk_sha256 from jsonb_array_elements(v_gone) as gone
					join public.qorpera_folder_file_chunks as chunk on chunk.profile_id = (gone ->> 'profile')::uuid
						and chunk.manifest_sha256 = gone ->> 'manifest') as hash
				where hash.profile_id = any(v_open_profiles)
					and public.qorpera_folder_gc_company(hash.profile_id)
					and exists (select 1 from public.qorpera_profile_objects as object where object.profile_id = hash.profile_id
						and object.sha256 = hash.sha256)
				order by hash.profile_id, hash.sha256 collate "C"
				on conflict (profile_id, sha256) do update
				set unreferenced_since = greatest(public.qorpera_folder_object_gc.unreferenced_since, excluded.unreferenced_since);
				get diagnostics v_queued = row_count;
			end if;
		end if;$new$
]);
alter function public.qorpera_folder_git_versions_expire(integer) set lock_timeout = '2s';

-- WHY: Add redundant updated_at range bound so qorpera_coding_sessions_open index scans directly,
-- and bound worker lock waits with 1s lock_timeout matching qorpera_claim_coding_session.
select pg_temp.rpc_patch('public.qorpera_archive_quiet_coding_sessions(text)'::regprocedure, array[
$old$			and greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
				< clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds)),$old$,
$new$			and session.updated_at < clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds)
			and greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
				< clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds)),$new$,
$old$						and greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
							< clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds))$old$,
$new$						and session.updated_at < clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds)
						and greatest(session.updated_at, coalesce(session.busy_at, session.updated_at))
							< clock_timestamp() - make_interval(secs => executor.session_archive_after_seconds))$new$
]);
alter function public.qorpera_archive_quiet_coding_sessions(text) set lock_timeout = '1s';

-- WHY: Eliminate O(S^2) per-session JSONB scans and array rebuilds while holding FOR UPDATE locks.
select pg_temp.rpc_patch('public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)'::regprocedure, array[
$old$	v_worker public.qorpera_runtime_workers%rowtype; v_seen jsonb; v_refusal text; v_entries jsonb := '[]'::jsonb; v_busy boolean;$old$,
$new$	v_worker public.qorpera_runtime_workers%rowtype; v_seen jsonb; v_seen_by_worker jsonb; v_refusal text; v_entry_list jsonb[] := '{}'::jsonb[]; v_busy boolean;$new$,
$old$	for v_session in select * from public.qorpera_coding_sessions where attached_machine_id = v_machine.id order by worker_id for update loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		v_refusal := public.qorpera_coding_attachment_refusal(v_session, v_worker, v_machine);
		select entry into v_seen from jsonb_array_elements(p_observation -> 'sessions') entry where entry ->> 'workerId' = v_session.worker_id::text limit 1;$old$,
$new$	if p_observation is not null then
		select coalesce(jsonb_object_agg(first_entry.worker_id, first_entry.entry), '{}'::jsonb) into v_seen_by_worker
		from (
			select distinct on (s.entry ->> 'workerId') s.entry ->> 'workerId' as worker_id, s.entry
			from jsonb_array_elements(p_observation -> 'sessions') with ordinality as s(entry, ord)
			order by s.entry ->> 'workerId', s.ord
		) as first_entry;
	end if;
	for v_session in select * from public.qorpera_coding_sessions where attached_machine_id = v_machine.id order by worker_id for update loop
		select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		v_refusal := public.qorpera_coding_attachment_refusal(v_session, v_worker, v_machine);
		v_seen := case when v_seen_by_worker is not null then v_seen_by_worker -> v_session.worker_id::text end;$new$,
$old$		v_entries := v_entries || jsonb_build_array(case when v_refusal is null then jsonb_build_object('workerId',v_session.worker_id,'state','kept',$old$,
$new$		v_entry_list := array_append(v_entry_list, case when v_refusal is null then jsonb_build_object('workerId',v_session.worker_id,'state','kept',$new$,
$old$	return jsonb_build_object('schema','qorpera.coding-attachments/v1','machineId',v_machine.id,'sessions',v_entries);$old$,
$new$	return jsonb_build_object('schema','qorpera.coding-attachments/v1','machineId',v_machine.id,'sessions',to_jsonb(v_entry_list));$new$
]);

-- WHY: Split occurrence-key lookup from folded-commit check and include the partial GIN index predicate
-- so qorpera_wake_occurrences_folded_file_commits matches on every listener cycle.
select pg_temp.rpc_patch('public.qorpera_folder_listen_company(uuid,integer)'::regprocedure, array[
$old$				if exists (select 1 from public.qorpera_wake_occurrences w where w.routine_id = v_routine.id
						and (w.occurrence_key = 'file:' || (v_match.m ->> 'seq') || ':' || (v_match.m ->> 'version')
							or (w.routine_version = (v_match.m ->> 'version')::bigint and w.payload -> 'folded'
								@> jsonb_build_array(jsonb_build_object('seq', (v_match.m ->> 'seq')::bigint))))) then$old$,
$new$				if exists (select 1 from public.qorpera_wake_occurrences w where w.routine_id = v_routine.id
						and w.occurrence_key = 'file:' || (v_match.m ->> 'seq') || ':' || (v_match.m ->> 'version'))
					or exists (select 1 from public.qorpera_wake_occurrences w where w.routine_id = v_routine.id
						and w.source_kind = 'company-file' and w.payload ? 'folded'
						and w.routine_version = (v_match.m ->> 'version')::bigint
						and w.payload -> 'folded' @> jsonb_build_array(jsonb_build_object('seq', (v_match.m ->> 'seq')::bigint))) then$new$
]);

-- WHY: Replace index-defeating OR IN with UNION join on (profile_id, sha256) and order profiles
-- deterministically before calling qorpera_folder_object_release to prevent multi-profile deadlocks.
select pg_temp.rpc_patch('public.qorpera_memory_tree_prune(integer)'::regprocedure, array[
$old$	perform 1 from public.qorpera_folder_upload_intents i
	where i.id in (select o.intent_id from unnest(v_profiles, v_manifests) x(p, m)
		join public.qorpera_folder_upload_intent_objects o on o.profile_id = x.p
		where x.m is not null and (o.sha256 = x.m or o.sha256 in (select ch.chunk_sha256 from public.qorpera_folder_file_chunks ch
			where ch.profile_id = x.p and ch.manifest_sha256 = x.m)))
	order by i.id for key share;
	-- The bytes, in a statement after the deletes: each pruned manifest and its chunks, where nothing roots them now.
	for v_profile in select distinct p from unnest(v_profiles) p loop$old$,
$new$	if cardinality(v_profiles) > 0 then
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
	-- The bytes, in a statement after the deletes: each pruned manifest and its chunks, where nothing roots them now.
	for v_profile in select distinct p from unnest(v_profiles) p order by p loop$new$
]);

-- WHY: Replace index-defeating OR IN with UNION join on (profile_id, sha256) in data snapshot prune.
select pg_temp.rpc_patch('public.qorpera_data_snapshot_prune(integer)'::regprocedure, array[
$old$	perform 1 from public.qorpera_folder_upload_intents i
	where i.id in (select o.intent_id from unnest(v_profiles, v_manifests) x(p, m)
		join public.qorpera_folder_upload_intent_objects o on o.profile_id = x.p
		where x.m is not null and (o.sha256 = x.m or o.sha256 in (select ch.chunk_sha256 from public.qorpera_folder_file_chunks ch
			where ch.profile_id = x.p and ch.manifest_sha256 = x.m)))
	order by i.id for key share;$old$,
$new$	if cardinality(v_profiles) > 0 then
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
	end if;$new$
]);

-- WHY: Lock the parent qorpera_company_sites row FOR NO KEY UPDATE before locking child domain rows
-- so concurrent primary-domain swaps serialize instead of deadlocking or racing on the unique index.
create or replace function public.qorpera_set_primary_site_domain(p_domain_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare
	v_site_id uuid;
	v_profile_id uuid;
	v_dom public.qorpera_company_site_domains%rowtype;
	v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if p_domain_id is null then
		raise exception 'Domain is required' using errcode = '22023';
	end if;
	select dom.site_id, dom.profile_id into v_site_id, v_profile_id
	from public.qorpera_company_site_domains as dom where dom.id = p_domain_id;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	v_role := public.qorpera_member_role(v_profile_id);
	if v_role is null or v_role not in ('owner', 'admin') then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_company_sites as site where site.id = v_site_id for no key update;
	select dom.* into v_dom from public.qorpera_company_site_domains as dom
	where dom.id = p_domain_id and dom.site_id = v_site_id for update;
	if not found then
		raise exception 'Only founders and admins manage site domains' using errcode = '42501';
	end if;
	if v_dom.status not in ('dns_verified', 'tls_active') then
		raise exception 'DOMAIN_NOT_VERIFIED' using errcode = '22023';
	end if;
	update public.qorpera_company_site_domains
	set is_primary = false, updated_at = clock_timestamp()
	where site_id = v_dom.site_id and is_primary and id <> v_dom.id;
	update public.qorpera_company_site_domains
	set is_primary = true, updated_at = clock_timestamp()
	where id = v_dom.id;
	return jsonb_build_object(
		'schema', 'qorpera.company-site-domain-primary/v1',
		'id', v_dom.id,
		'siteId', v_dom.site_id,
		'hostname', v_dom.hostname
	);
end $$;

drop function pg_temp.rpc_patch(regprocedure, text[]);
