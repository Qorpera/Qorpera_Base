-- 20260930445000: step 5a, the coding machine's read set (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Reads").
-- With root in the guest, one session can read through another session's mount on the same machine, so a read is the
-- machine's, not one session's. The machine read set replaces the per-session carry of qorpera_folder_view_open.
-- 1. qorpera_coding_machine_reads and qorpera_coding_machine_read_records hold the machine's pairs and released reads.
--    They live with the machine's disk: the machine's removal drops them, and qorpera_replace_coding_machine_disk (the
--    executor's call when it recreates the disk, refused while a session is attached) empties them.
-- 2. A coding view's release writes the machine's set and fans each read out to every turn leased on the machine, taking
--    each turn's job KEY SHARE in id order, so no turn completes with a read it was never given. The machine row FOR
--    SHARE orders the release against a turn taking the set in.
-- 3. A turn takes the machine's set in at its lease: qorpera_folder_read_wake for a turn whose session is on a machine,
--    and qorpera_authorize_coding_machine_run when it moves the session's turn onto a machine.
-- 4. Every coding view's commit rechecks its own read set, the machine's and its leased turn's at rank 10, as a run's
--    read set is rechecked, but writes none: the order is session, machine, read set, and the commit takes its session
--    last.
-- 5. A coding view no longer carries its session's previous view's reads: the machine's set holds them.
-- Every patched body names this migration (20260930445000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.s5a_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5a anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. The machine's read set. ------------------------------------------------------------------------------------------

-- The machine's pairs, as a view's (qorpera_folder_view_reads).
create table public.qorpera_coding_machine_reads (
	coding_machine_id uuid not null references public.qorpera_coding_machines(id) on delete cascade,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	grant_id uuid,
	resource_revision bigint not null,
	grant_revision bigint,
	updated_at timestamptz not null default clock_timestamp(),
	check ((grant_id is null) = (grant_revision is null))
);
create unique index qorpera_coding_machine_reads_key on public.qorpera_coding_machine_reads
	(coding_machine_id, resource_id, grant_id) nulls not distinct;

-- The machine's released reads, one record per release and resource, as a view's (qorpera_folder_view_read_records).
create table public.qorpera_coding_machine_read_records (
	coding_machine_id uuid not null references public.qorpera_coding_machines(id) on delete cascade,
	release_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	reads jsonb not null check (jsonb_typeof(reads) = 'array'),
	output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (coding_machine_id, release_id, resource_id)
);

alter table public.qorpera_coding_machine_reads enable row level security;
alter table public.qorpera_coding_machine_read_records enable row level security;
revoke all on public.qorpera_coding_machine_reads, public.qorpera_coding_machine_read_records
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A session's machine and a worker's dispatched turns are looked up on every coding release.
create index qorpera_coding_sessions_machine on public.qorpera_coding_sessions (vm_allocation_id) where vm_allocation_id is not null;
create index qorpera_wake_occurrences_worker_dispatch on public.qorpera_wake_occurrences (source_id)
	where source_kind = 'worker-dispatch';

-- 2. The machine's turns and its read set. ----------------------------------------------------------------------------

-- The turns leased on a machine now: the leased turn of each session that runs there (as qorpera_folder_view_live_run
-- finds a coding view's turn).
create function public.qorpera_coding_machine_turns(p_machine_id uuid)
returns table (run_id uuid, job_id uuid, worker_id uuid) language sql stable security definer set search_path = '' as $$
	select r.id, j.id, s.worker_id
	from public.qorpera_coding_sessions s
	join public.qorpera_wake_occurrences o on o.wake_kind = 'agent' and o.source_kind = 'worker-dispatch' and o.source_id = s.worker_id
	join public.qorpera_execution_runs r on r.id = o.run_id
	join public.qorpera_runner_jobs j on j.id = r.job_id
	where s.vm_allocation_id = p_machine_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp()
$$;

-- The machine's pairs, written as qorpera_folder_view_write_read_set writes a view's.
create function public.qorpera_coding_machine_write_read_set(p_environment_id uuid, p_machine_id uuid, p_upserts jsonb,
	p_restamps jsonb, p_deletes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item record;
begin
	for v_item in
		select 'upsert' as op, (u ->> 'resourceId')::uuid as resource_id, (u ->> 'grantId')::uuid as grant_id,
			min((u ->> 'resourceRevision')::bigint) as rrev, min((u ->> 'grantRevision')::bigint) as grev, null::bigint as old_rrev,
			null::bigint as old_grev
		from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) u group by 2, 3
		union all
		select 'restamp', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, (u ->> 'resourceRevision')::bigint,
			(u ->> 'grantRevision')::bigint, (u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_restamps, '[]'::jsonb)) u
		union all
		select 'delete', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, null, null,
			(u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) u
		order by 2, 3 nulls first, 1 desc
	loop
		if v_item.op = 'upsert' then
			insert into public.qorpera_coding_machine_reads(coding_machine_id, environment_id, resource_id, grant_id, resource_revision,
				grant_revision)
			values (p_machine_id, p_environment_id, v_item.resource_id, v_item.grant_id, v_item.rrev, v_item.grev)
			on conflict (coding_machine_id, resource_id, grant_id) do update set
				resource_revision = least(public.qorpera_coding_machine_reads.resource_revision, excluded.resource_revision),
				grant_revision = least(public.qorpera_coding_machine_reads.grant_revision, excluded.grant_revision),
				updated_at = clock_timestamp();
		elsif v_item.op = 'restamp' then
			update public.qorpera_coding_machine_reads set resource_revision = v_item.rrev, grant_revision = v_item.grev,
				updated_at = clock_timestamp()
			where coding_machine_id = p_machine_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		else
			delete from public.qorpera_coding_machine_reads
			where coding_machine_id = p_machine_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		end if;
	end loop;
end $$;

-- What a coding view, its machine or its leased turn read still holds, checked as qorpera_folder_run_reads_current
-- checks a run's: a moved pair re-resolves the paths it covers, and a path no longer readable refuses. Nothing is
-- written. The order is session, machine, read set: a session's holder takes the machine
-- (qorpera_authorize_coding_machine_run, qorpera_keep_coding_attachments, qorpera_folder_read_wake), and a release holds
-- the machine while it writes the view's set, the machine's and its turns'. A commit takes its session last (the anchor
-- step), so it holds no read-set row: a moved pair stays as recorded and is checked again, until the turn's own
-- re-check, a release or a new disk writes it.
create function public.qorpera_coding_reads_hold(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_run_id uuid,
	p_machine_id uuid, p_view_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_row record; v_prefixes text[]; v_ok boolean; v_moved integer := 0;
begin
	for v_row in
		select rr.resource_id, rr.grant_id, rr.resource_revision, rr.grant_revision,
			r.id is not null as resource_exists, r.authority_revision as current_rrev, r.path as resource_path,
			(rr.grant_id is null and r.scope is distinct from 'company_rules') as grant_missing,
			g.revision as current_grev,
			(g.id is not null and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())) as grant_live
		from (select t.resource_id, t.grant_id, t.resource_revision, t.grant_revision from public.qorpera_folder_run_reads t
				where t.run_id = p_run_id
			union all
			select m.resource_id, m.grant_id, m.resource_revision, m.grant_revision from public.qorpera_coding_machine_reads m
				where m.coding_machine_id = p_machine_id
			union all
			select v.resource_id, v.grant_id, v.resource_revision, v.grant_revision from public.qorpera_folder_view_reads v
				where v.view_id = p_view_id) rr
		left join public.qorpera_company_path_resources r on r.id = rr.resource_id
		left join public.qorpera_company_path_grants g on g.id = rr.grant_id
		order by rr.resource_id, rr.grant_id nulls first
	loop
		if v_row.resource_exists and v_row.current_rrev = v_row.resource_revision and not v_row.grant_missing
			and (v_row.grant_id is null or (v_row.grant_live and v_row.current_grev = v_row.grant_revision)) then continue; end if;
		v_moved := v_moved + 1;
		if not v_row.resource_exists then
			v_prefixes := null;
		elsif v_row.grant_missing
			or (v_row.grant_id is not null and (not v_row.grant_live or v_row.current_grev is distinct from v_row.grant_revision)) then
			v_prefixes := array[public.qorpera_folder_key(v_row.resource_path)];
		else
			select array_agg(distinct c.prefix) into v_prefixes from public.qorpera_folder_authority_changes c
			where c.environment_id = p_environment_id and c.resource_id = v_row.resource_id and c.revision > v_row.resource_revision;
			v_prefixes := coalesce(v_prefixes, array[public.qorpera_folder_key(v_row.resource_path)]);
		end if;
		select coalesce(bool_and(a.ok), true) into v_ok
		from public.qorpera_folder_paths_authority(p_environment_id, p_profile_id, p_actor, array(
			select distinct x ->> 'path'
			from (select t.resource_id, t.reads from public.qorpera_folder_run_read_records t
					where t.run_id = p_run_id and t.resource_id <> '00000000-0000-0000-0000-000000000000'::uuid
				union all
				select m.resource_id, m.reads from public.qorpera_coding_machine_read_records m
					where m.coding_machine_id = p_machine_id
				union all
				select v.resource_id, v.reads from public.qorpera_folder_view_read_records v
					where v.view_id = p_view_id) rec, jsonb_array_elements(rec.reads) x
			where (v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix)))) a;
		if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
	end loop;
	return v_moved;
end $$;

-- A turn takes in its machine's read set (rule 1): the machine's latest record of each path, placed under the turn's
-- run as one release of the machine (its id from the run and the machine), so the run's recheck finds the paths. A
-- read the run can no longer place refuses (42501): the machine moves its sessions to a new disk (5g). Taking it in
-- again adds the paths to the same release and keeps the ones filed before: the turn read them, though the machine's
-- set may no longer hold them (a new disk). A path filed again keeps its newer entry.
create function public.qorpera_coding_machine_take_in(p_environment_id uuid, p_profile_id uuid, p_machine_id uuid,
	p_run_id uuid, p_actor jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_reads jsonb; v_pairs jsonb;
begin
	select coalesce(jsonb_agg(latest.x order by public.qorpera_folder_key(latest.x ->> 'path')), '[]'::jsonb) into v_reads
	from (select distinct on (x ->> 'path') x from public.qorpera_coding_machine_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.coding_machine_id = p_machine_id
		order by x ->> 'path', rec.created_at desc, rec.release_id) latest;
	if jsonb_array_length(v_reads) = 0 then return 0; end if;
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, p_profile_id, p_actor, v_reads);
	perform public.qorpera_folder_write_read_set(p_environment_id, p_run_id, v_pairs -> 'upserts', null, null);
	insert into public.qorpera_folder_run_read_records as kept(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select p_run_id, md5('coding-machine:' || p_run_id::text || ':' || p_machine_id::text)::uuid, p_environment_id,
		(f -> 'authority' ->> 'resourceId')::uuid, jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
	from jsonb_array_elements(v_pairs -> 'filed') f group by 4
	on conflict (run_id, release_id, resource_id) do update set reads = (
		select jsonb_agg(e.x order by public.qorpera_folder_key(e.x ->> 'path'))
		from (select distinct on (pair.x ->> 'path') pair.x
			from (select x, 0 as older from jsonb_array_elements(excluded.reads) x
				union all select x, 1 from jsonb_array_elements(kept.reads) x) pair
			order by pair.x ->> 'path', pair.older) e);
	return jsonb_array_length(v_reads);
end $$;

-- 3. Releases. ----------------------------------------------------------------------------------------------------

-- A coding view's release writes the machine's set and fans out to every turn leased on the machine (rule 1).
select pg_temp.s5a_patch('public.qorpera_folder_record_view_release(uuid,uuid,jsonb,uuid,jsonb,text,text)', array[
	$old$	v_early jsonb; v_run_actor jsonb; v_late_run jsonb; v_pairs jsonb; v_result jsonb;$old$,
	$new$	v_early jsonb; v_run_actor jsonb; v_late_run jsonb; v_pairs jsonb; v_result jsonb;
	v_machine uuid; v_machine_jobs uuid[]; v_turns uuid[]; v_unlocked boolean; v_turn uuid;$new$,
	$old$		if v_run_actor is not null then
			perform 1 from public.qorpera_runner_jobs where id = (v_run_actor ->> 'jobId')::uuid and run_id = (v_run_actor ->> 'runId')::uuid
			for key share;$old$,
	$new$		-- 20260930445000 (step 5a): a coding view's reads are its machine's and reach every turn leased on the machine,
		-- each such turn's job KEY SHARE first, in id order (the view's own turn among them).
		select machine_id into v_machine from public.qorpera_folder_views where id = v_view_id and kind = 'coding_session';
		if v_machine is not null then
			select coalesce(array_agg(locked.id order by locked.id), '{}') into v_machine_jobs
			from (select j.id from public.qorpera_runner_jobs j
				where j.id in (select t.job_id from public.qorpera_coding_machine_turns(v_machine) t) order by j.id for key share) locked;
		end if;
		if v_run_actor is not null then
			perform 1 from public.qorpera_runner_jobs where id = (v_run_actor ->> 'jobId')::uuid and run_id = (v_run_actor ->> 'runId')::uuid
			for key share;$new$,
	$old$		v_run_actor := v_late_run;
		if v_run_actor is not null then
			perform public.qorpera_folder_run_enter(p_environment_id, p_profile_id, v_run_actor);
		end if;$old$,
	$new$		v_run_actor := v_late_run;
		if v_run_actor is not null then
			perform public.qorpera_folder_run_enter(p_environment_id, p_profile_id, v_run_actor);
		end if;
		-- 20260930445000 (step 5a): the machine row FOR SHARE, which a turn taking in the machine's set holds FOR NO KEY
		-- UPDATE and a session moving onto the machine FOR UPDATE. Every turn leased on the machine now must be one whose
		-- job is held above; a turn leased since refuses as retryable.
		if v_machine is not null then
			perform 1 from public.qorpera_coding_machines where id = v_machine for share;
			select array_agg(t.run_id order by t.run_id), coalesce(bool_or(t.job_id <> all (v_machine_jobs)), false)
			into v_turns, v_unlocked from public.qorpera_coding_machine_turns(v_machine) t;
			if v_unlocked then
				raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder view changed',
					'details', 'folder_view_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
			end if;
		end if;$new$,
	$old$	if v_run_actor is not null then
		-- The run's records are keyed by release id too: an id the run already used is refused, never half-filed.
		if exists (select 1 from public.qorpera_folder_run_releases where run_id = (v_run_actor ->> 'runId')::uuid and release_id = p_release_id)
			or exists (select 1 from public.qorpera_folder_run_read_records
				where run_id = (v_run_actor ->> 'runId')::uuid and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_folder_write_read_set(p_environment_id, (v_run_actor ->> 'runId')::uuid, v_pairs -> 'upserts', null, null);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select (v_run_actor ->> 'runId')::uuid, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	end if;$old$,
	$new$	-- 20260930445000 (step 5a): a coding view's reads go to its machine's set, under the same release id.
	if v_machine is not null then
		if exists (select 1 from public.qorpera_coding_machine_read_records where coding_machine_id = v_machine and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_coding_machine_write_read_set(p_environment_id, v_machine, v_pairs -> 'upserts', null, null);
		insert into public.qorpera_coding_machine_read_records(coding_machine_id, release_id, environment_id, resource_id, reads,
			output_sha256)
		select v_machine, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	end if;
	-- The view's run, and (20260930445000) every turn leased on its machine, in id order.
	for v_turn in select distinct turn.id from unnest(coalesce(v_turns, '{}') || (v_run_actor ->> 'runId')::uuid) turn(id)
		where turn.id is not null order by turn.id loop
		-- The run's records are keyed by release id too: an id the run already used is refused, never half-filed.
		if exists (select 1 from public.qorpera_folder_run_releases where run_id = v_turn and release_id = p_release_id)
			or exists (select 1 from public.qorpera_folder_run_read_records where run_id = v_turn and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_folder_write_read_set(p_environment_id, v_turn, v_pairs -> 'upserts', null, null);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select v_turn, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	end loop;$new$
]);

-- 4. A turn takes the machine's set in. -----------------------------------------------------------------------------

-- At its lease, when the wake is read.
select pg_temp.s5a_patch('public.qorpera_folder_read_wake(jsonb)', array[
	$old$	v_p31_release uuid;$old$,
	$new$	v_p31_release uuid; v_machine uuid;$new$,
	$old$	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');$old$,
	$new$	-- 20260930445000 (step 5a): a coding turn takes in its machine's read set at its lease (rule 1). The session KEY
	-- SHARE waits out a run authority in flight, which holds it FOR UPDATE and takes the set in itself; the machine FOR
	-- NO KEY UPDATE waits out releases in flight on the machine, which hold it FOR SHARE and fan out to this turn.
	if v_wake.wake_kind = 'agent' and v_wake.source_kind = 'worker-dispatch' then
		select vm_allocation_id into v_machine from public.qorpera_coding_sessions where worker_id = v_wake.source_id for key share;
		if v_machine is not null then
			perform 1 from public.qorpera_coding_machines where id = v_machine for no key update;
			perform public.qorpera_coding_machine_take_in(v_run.environment_id, v_run.profile_id, v_machine, v_run.id, v_tool -> 'resolved');
		end if;
	end if;
	perform public.qorpera_folder_run_reads_current(v_run.environment_id, v_run.profile_id, v_tool -> 'resolved');$new$
]);

-- When run authority moves a session (and its leased turn) onto a machine.
select pg_temp.s5a_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', array[
	$old$	if v_session.vm_allocation_id is distinct from v_machine.id then
		update public.qorpera_coding_sessions set vm_allocation_id = v_machine.id, updated_at = clock_timestamp() where worker_id = v_worker.id;
	end if;$old$,
	$new$	if v_session.vm_allocation_id is distinct from v_machine.id then
		update public.qorpera_coding_sessions set vm_allocation_id = v_machine.id, updated_at = clock_timestamp() where worker_id = v_worker.id;
		-- 20260930445000 (step 5a): a turn already leased moves with its session and takes in the machine's read set
		-- here, under the machine FOR UPDATE above; a turn leased later takes it in when it reads its wake.
		perform public.qorpera_coding_machine_take_in(v_worker.environment_id, v_worker.profile_id, v_machine.id, turn.run_id,
			public.qorpera_folder_run_reader(v_worker.profile_id, turn.run_id))
		from public.qorpera_coding_machine_turns(v_machine.id) turn where turn.worker_id = v_worker.id order by turn.run_id;
	end if;$new$
]);


-- 5. Commits recheck it. ----------------------------------------------------------------------------------------

select pg_temp.s5a_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)', array[
	$old$		perform public.qorpera_folder_view_reads_current(p_environment_id, v_file.profile_id, v_view.id, v_auth_actor);$old$,
	$new$		-- 20260930445000 (step 5a): a coding view's own read set and its machine's, under the view's actor, checked
		-- without writing.
		if v_view.kind = 'coding_session' then
			perform public.qorpera_coding_reads_hold(p_environment_id, v_file.profile_id, v_auth_actor, null, v_view.machine_id,
				v_view.id);
		else
			perform public.qorpera_folder_view_reads_current(p_environment_id, v_file.profile_id, v_view.id, v_auth_actor);
		end if;$new$,
	$old$			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, v_turn_run));$old$,
	$new$			-- 20260930445000 (step 5a): checked without writing, as the machine's set is.
			perform public.qorpera_coding_reads_hold(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, v_turn_run), v_turn_run, null, null);$new$
]);


-- 6. A coding view no longer carries its session's reads. ---------------------------------------------------------

select pg_temp.s5a_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', array[
	$old$	-- The machine's previous view, open or not (locked above): its read set follows the machine while the machine runs
	-- on (§6). A desktop carries it within one seat assignment and one power-on (the same generation and activation); a
	-- coding session while it stays on the same machine. A restart, a seat changing agent or a move to another machine
	-- starts clean: that is also the way out for a machine whose programs saw a file that has since been narrowed.$old$,
	$new$	-- The machine's previous view, open or not (locked above): its read set follows the machine while the machine runs
	-- on (§6). A desktop carries it within one seat assignment and one power-on (the same generation and activation), a
	-- test machine within one placement. A restart or a seat changing agent starts clean: that is also the way out for a
	-- machine whose programs saw a file that has since been narrowed. 20260930445000 (step 5a): a coding session carries
	-- nothing of its own; its reads are its machine's (qorpera_coding_machine_reads).$new$,
	$old$	where (p_kind = 'computer_desktop' and newest.screen_generation = v_screen.generation and newest.activation_id = v_activation)
		or (p_kind = 'coding_session' and newest.machine_id = v_machine) or p_kind = 'test_machine'; -- 20260930420000$old$,
	$new$	where (p_kind = 'computer_desktop' and newest.screen_generation = v_screen.generation and newest.activation_id = v_activation)
		or p_kind = 'test_machine'; -- 20260930420000$new$
]);

-- 7. The disk. --------------------------------------------------------------------------------------------------------

-- The executor's call before it recreates a machine's disk (rule 2): the machine's read set goes with the disk. Refused
-- while any session is attached there (the executor detaches each session first). The machine FOR NO KEY UPDATE waits
-- out releases in flight; the pairs are locked in a commit's recheck order before they go.
create function public.qorpera_replace_coding_machine_disk(p_machine_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	perform 1 from public.qorpera_coding_machines where id = v_machine.id for no key update;
	if exists (select 1 from public.qorpera_coding_sessions where attached_machine_id = v_machine.id) then
		return jsonb_build_object('schema','qorpera.coding-machine-disk/v1','machineId',v_machine.id,'state','refused',
			'reason','SESSION_ATTACHED'); end if;
	perform 1 from public.qorpera_coding_machine_reads where coding_machine_id = v_machine.id
	order by resource_id, grant_id nulls first for update;
	delete from public.qorpera_coding_machine_reads where coding_machine_id = v_machine.id;
	delete from public.qorpera_coding_machine_read_records where coding_machine_id = v_machine.id;
	return jsonb_build_object('schema','qorpera.coding-machine-disk/v1','machineId',v_machine.id,'state','emptied');
end $$;

-- 8. Grants -----------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_coding_machine_turns(uuid),
	public.qorpera_coding_machine_write_read_set(uuid, uuid, jsonb, jsonb, jsonb),
	public.qorpera_coding_reads_hold(uuid, uuid, jsonb, uuid, uuid, uuid),
	public.qorpera_coding_machine_take_in(uuid, uuid, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_replace_coding_machine_disk(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_replace_coding_machine_disk(uuid, text, text, text) to service_role;
