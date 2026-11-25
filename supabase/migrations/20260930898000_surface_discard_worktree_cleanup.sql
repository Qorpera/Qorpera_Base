-- WHY: Automatically archive coding sessions and queue code-host worktree/branch cleanup when code_repo surface sessions are discarded.
set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_jobs') is null
		or to_regclass('public.qorpera_code_repositories') is null
		or to_regprocedure('public.qorpera_surface_cancel_coding_workers(uuid[],text)') is null
		or to_regprocedure('public.qorpera_discard_surface_session(uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_change(uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_option_group(uuid,text)') is null
		or to_regprocedure('public.qorpera_set_session_chat_open(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_discard_exploration(uuid)') is null
		or to_regprocedure('public.qorpera_choose_exploration(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_remove(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_undo_surface_change(uuid)') is null
		or to_regprocedure('public.qorpera_reply_surface_session(uuid,text,boolean)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_archive_coding_worker(public.qorpera_runtime_workers,text,uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_lock_coding_workers(uuid[])') is null then
		raise exception '20260930898000 requires prior surface and coding-session migrations';
	end if;
	if to_regprocedure('public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)') is not null then
		raise exception '20260930898000 is already applied';
	end if;
end $$;

create temporary table sdwc_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.sdwc_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930898000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930898000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_surface_jobs
	drop constraint if exists qorpera_surface_jobs_kind_check;

alter table public.qorpera_surface_jobs
	add constraint qorpera_surface_jobs_kind_check
	check (kind in ('land_change', 'undo_change', 'publish_surface', 'cleanup_session'));

-- WHY: Deleting a surface discards its sessions and queues cleanup_session jobs after archiving the surface row.
drop trigger if exists qorpera_surface_jobs_refuse_removed on public.qorpera_surface_jobs;
create trigger qorpera_surface_jobs_refuse_removed
	before insert on public.qorpera_surface_jobs
	for each row when (new.kind <> 'cleanup_session')
	execute function public.qorpera_surface_refuse_removed();

update public.qorpera_code_repositories
set retire_enabled = true
where not retire_enabled;

create function public.qorpera_surface_lock_coding_workers_for_sessions(
	p_session_ids uuid[]
)
returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_worker_ids uuid[];
begin
	if coalesce(cardinality(p_session_ids), 0) = 0 then
		return '{}'::uuid[];
	end if;
	select coalesce(array_agg(w.id order by w.id), '{}'::uuid[]) into v_worker_ids
	from public.qorpera_runtime_workers w
	join public.qorpera_coding_sessions cs on cs.worker_id = w.id
	where w.surface_backed
		and w.species = 'coding'
		and w.surface_session_id = any(p_session_ids)
		and (w.state = 'active' or cs.archived_at is null);
	if coalesce(cardinality(v_worker_ids), 0) = 0 then
		return '{}'::uuid[];
	end if;
	-- WHY: Lock coding workers and coding sessions before callers lock surface_sessions to avoid 40P01 deadlocks.
	perform public.qorpera_lock_coding_workers(v_worker_ids);
	perform 1
	from public.qorpera_coding_sessions cs
	where cs.worker_id = any(v_worker_ids)
	order by cs.worker_id
	for update;
	return v_worker_ids;
end $$;

create function public.qorpera_surface_archive_locked_coding_workers(
	p_worker_ids uuid[],
	p_reason text default 'surface_discarded'
)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_reason text := coalesce(nullif(btrim(p_reason), ''), 'surface_discarded');
	v_archived integer := 0;
begin
	if coalesce(cardinality(p_worker_ids), 0) = 0 then
		return 0;
	end if;
	for v_worker in
		select w.*
		from public.qorpera_runtime_workers w
		where w.id = any(p_worker_ids)
			and w.surface_backed
			and w.species = 'coding'
		order by w.id
	loop
		if v_worker.state = 'active' then
			perform public.qorpera_cancel_worker(v_worker, null, v_reason);
			select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
		end if;
		if public.qorpera_archive_coding_worker(v_worker, 'kernel', null, null) then
			v_archived := v_archived + 1;
		end if;
	end loop;
	return v_archived;
end $$;

create function public.qorpera_surface_archive_coding_workers(
	p_session_ids uuid[],
	p_reason text default 'surface_discarded'
)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_worker_ids uuid[];
begin
	v_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(p_session_ids);
	return public.qorpera_surface_archive_locked_coding_workers(v_worker_ids, p_reason);
end $$;

create function public.qorpera_surface_enqueue_session_cleanup(
	p_session_id uuid,
	p_requested_by_user_id uuid default null
)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_job_id uuid;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null or v_session.state <> 'discarded' or v_session.worker_id is null then
		return null;
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
	if v_surface.id is null or v_surface.source_kind <> 'code_repo' or v_surface.repository_key is null then
		return null;
	end if;

	select j.id into v_job_id
	from public.qorpera_surface_jobs j
	where j.session_id = v_session.id
		and j.kind = 'cleanup_session'
		and j.status in ('queued', 'running')
		and j.payload ->> 'workerId' = v_session.worker_id::text
	limit 1;
	if v_job_id is not null then
		return v_job_id;
	end if;

	insert into public.qorpera_surface_jobs(
		profile_id, surface_id, session_id, kind, payload, requested_by_user_id
	)
	values (
		v_session.profile_id,
		v_session.surface_id,
		v_session.id,
		'cleanup_session',
		jsonb_build_object('workerId', v_session.worker_id),
		p_requested_by_user_id
	)
	returning id into v_job_id;

	return v_job_id;
end $$;

create function public.qorpera_surface_complete_cleanup(
	p_job_id uuid,
	p_status text,
	p_error_detail text default null,
	p_lease_token uuid default null
)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_job public.qorpera_surface_jobs%rowtype;
	v_now timestamptz := clock_timestamp();
	v_error text := left(nullif(btrim(coalesce(p_error_detail, '')), ''), 1000);
begin
	if p_status not in ('completed', 'failed') then
		raise exception 'Invalid cleanup completion status' using errcode = '22023';
	end if;

	select * into v_job from public.qorpera_surface_jobs where id = p_job_id for update;
	if v_job.id is null then raise exception 'Surface job not found' using errcode = 'P0002'; end if;
	if v_job.kind <> 'cleanup_session' then
		raise exception 'Surface job is not a cleanup job' using errcode = '22023';
	end if;
	if v_job.status <> 'running' then
		raise exception 'Surface job is not running' using errcode = '55000';
	end if;
	if v_job.lease_token is not null and p_lease_token is distinct from v_job.lease_token then
		raise exception 'Surface job lease mismatch' using errcode = '55000';
	end if;

	if p_status = 'completed' and v_job.session_id is not null then
		perform 1 from public.qorpera_surface_sessions where id = v_job.session_id for update;
		update public.qorpera_surface_sessions
		set branch_head_sha = null, updated_at = v_now
		where id = v_job.session_id and state = 'discarded';
	end if;

	update public.qorpera_surface_jobs
	set
		status = p_status,
		error_detail = case when p_status = 'failed' then v_error else null end,
		lease_expires_at = null,
		lease_token = null,
		completed_at = v_now,
		updated_at = v_now
	where id = p_job_id;

	return jsonb_build_object('jobId', p_job_id, 'status', p_status);
end $$;

revoke all on function public.qorpera_surface_complete_cleanup(uuid, text, text, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_surface_complete_cleanup(uuid, text, text, uuid)
	to service_role;

select pg_temp.sdwc_patch(
	'public.qorpera_discard_surface_session(uuid)'::regprocedure,
	array[
$old$	v_change_ids uuid[];
	v_discarded_ids uuid[] := '{}'::uuid[];
begin$old$,
$new$	v_change_ids uuid[];
	v_discarded_ids uuid[] := '{}'::uuid[];
	v_locked_worker_ids uuid[] := '{}'::uuid[];
begin$new$,
$old$	perform public.qorpera_surface_cancel_coding_workers(array[p_session_id], 'surface_discarded');$old$,
$new$	v_locked_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(array[p_session_id]);
	perform public.qorpera_surface_cancel_coding_workers(array[p_session_id], 'surface_discarded');$new$,
$old$	) or exists (
		select 1 from public.qorpera_surface_jobs j
		where j.session_id = p_session_id and j.status in ('queued', 'running')
	) then$old$,
$new$	) or exists (
		select 1 from public.qorpera_surface_jobs j
		where j.session_id = p_session_id and j.kind <> 'cleanup_session' and j.status in ('queued', 'running')
	) then$new$,
$old$	where id = p_session_id
	returning * into v_session;

	if coalesce(cardinality(v_discarded_ids), 0) > 0 then$old$,
$new$	where id = p_session_id
	returning * into v_session;

	if v_session.state = 'discarded' then
		perform public.qorpera_surface_archive_locked_coding_workers(v_locked_worker_ids, 'surface_discarded');
		perform public.qorpera_surface_enqueue_session_cleanup(p_session_id, auth.uid());
	end if;

	if coalesce(cardinality(v_discarded_ids), 0) > 0 then$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_discard_surface_change(uuid)'::regprocedure,
	array[
$old$	v_discarded_count integer := 0;
	v_survivor_ids uuid[];
begin$old$,
$new$	v_discarded_count integer := 0;
	v_survivor_ids uuid[];
	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
begin$new$,
$old$	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);

	-- WHY: Acquire session -> surface -> change locks in canonical order before silent reconciliation to avoid 40P01 deadlocks.
	perform 1 from public.qorpera_surface_sessions where id = v_lookup.session_id for update;$old$,
$new$	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);

	v_locked_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(array[v_lookup.session_id]);

	-- WHY: Acquire session -> surface -> change locks in canonical order before silent reconciliation to avoid 40P01 deadlocks.
	select (state = 'discarded') into v_was_discarded
	from public.qorpera_surface_sessions where id = v_lookup.session_id for update;$new$,
$old$	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);$old$,
$new$	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	if not coalesce(v_was_discarded, false) and v_session.state = 'discarded' then
		perform public.qorpera_surface_archive_locked_coding_workers(v_locked_worker_ids, 'surface_discarded');
		perform public.qorpera_surface_enqueue_session_cleanup(v_session.id, auth.uid());
	end if;
	return public.qorpera_surface_session_json(v_session);$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_discard_surface_option_group(uuid,text)'::regprocedure,
	array[
$old$	v_discarded_ids uuid[] := '{}'::uuid[];
begin$old$,
$new$	v_discarded_ids uuid[] := '{}'::uuid[];
	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
begin$new$,
$old$	perform public.qorpera_assert_surface_member(v_profile_id, true);

	-- WHY: Acquire session -> surface -> change locks in canonical order before silent reconciliation to avoid 40P01 deadlocks.
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;$old$,
$new$	perform public.qorpera_assert_surface_member(v_profile_id, true);

	v_locked_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(array[p_session_id]);

	-- WHY: Acquire session -> surface -> change locks in canonical order before silent reconciliation to avoid 40P01 deadlocks.
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	v_was_discarded := (v_session.state = 'discarded');$new$,
$old$	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);$old$,
$new$	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	if not coalesce(v_was_discarded, false) and v_session.state = 'discarded' then
		perform public.qorpera_surface_archive_locked_coding_workers(v_locked_worker_ids, 'surface_discarded');
		perform public.qorpera_surface_enqueue_session_cleanup(v_session.id, auth.uid());
	end if;
	return public.qorpera_surface_session_json(v_session);$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_set_session_chat_open(uuid,boolean)'::regprocedure,
	array[
$old$declare
	v_session public.qorpera_surface_sessions%rowtype;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);

	update public.qorpera_surface_sessions
	set has_active_chat = coalesce(p_open, false), updated_at = clock_timestamp()
	where id = p_session_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);
end$old$,
$new$declare
	v_profile_id uuid;
	v_session public.qorpera_surface_sessions%rowtype;
	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
begin
	select profile_id into v_profile_id from public.qorpera_surface_sessions where id = p_session_id;
	if v_profile_id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_profile_id, true);

	if not coalesce(p_open, false) then
		v_locked_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(array[p_session_id]);
	end if;

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	v_was_discarded := (v_session.state = 'discarded');

	update public.qorpera_surface_sessions
	set has_active_chat = coalesce(p_open, false), updated_at = clock_timestamp()
	where id = p_session_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	if not v_was_discarded and v_session.state = 'discarded' then
		perform public.qorpera_surface_archive_locked_coding_workers(v_locked_worker_ids, 'surface_discarded');
		perform public.qorpera_surface_enqueue_session_cleanup(v_session.id, auth.uid());
	end if;
	return public.qorpera_surface_session_json(v_session);
end$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_discard_exploration(uuid)'::regprocedure,
	array[
$old$	v_discarded_ids uuid[] := '{}'::uuid[];
begin$old$,
$new$	v_discarded_ids uuid[] := '{}'::uuid[];
	v_discarded_session_id uuid;
begin$new$,
$old$	perform public.qorpera_surface_cancel_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.exploration_id = p_exploration_id),
		'surface_discarded'
	);$old$,
$new$	perform public.qorpera_surface_archive_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.exploration_id = p_exploration_id),
		'surface_discarded'
	);$new$,
$old$	update public.qorpera_surface_sessions
	set state = 'discarded', has_active_chat = false, lease_token = null, lease_expires_at = null, wake_id = null,
		closed_at = clock_timestamp(), updated_at = clock_timestamp()
	where exploration_id = p_exploration_id;$old$,
$new$	update public.qorpera_surface_sessions
	set state = 'discarded', has_active_chat = false, lease_token = null, lease_expires_at = null, wake_id = null,
		closed_at = clock_timestamp(), updated_at = clock_timestamp()
	where exploration_id = p_exploration_id;

	for v_discarded_session_id in
		select s.id from public.qorpera_surface_sessions s
		where s.exploration_id = p_exploration_id and s.state = 'discarded'
		order by s.id
	loop
		perform public.qorpera_surface_enqueue_session_cleanup(v_discarded_session_id, auth.uid());
	end loop;$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_choose_exploration(uuid,uuid)'::regprocedure,
	array[
$old$	v_discarded_ids uuid[] := '{}'::uuid[];
begin$old$,
$new$	v_discarded_ids uuid[] := '{}'::uuid[];
	v_discarded_session_id uuid;
begin$new$,
$old$		perform public.qorpera_surface_cancel_coding_workers(
			(select coalesce(array_agg(s.id), '{}'::uuid[])
			 from public.qorpera_surface_sessions s
			 where s.exploration_id = p_exploration_id and s.id <> p_session_id),
			'surface_discarded'
		);$old$,
$new$		perform public.qorpera_surface_archive_coding_workers(
			(select coalesce(array_agg(s.id), '{}'::uuid[])
			 from public.qorpera_surface_sessions s
			 where s.exploration_id = p_exploration_id and s.id <> p_session_id),
			'surface_discarded'
		);$new$,
$old$		update public.qorpera_surface_sessions
		set state = 'discarded', has_active_chat = false, lease_token = null, lease_expires_at = null, wake_id = null,
			closed_at = clock_timestamp(), updated_at = clock_timestamp()
		where exploration_id = p_exploration_id and id <> p_session_id;$old$,
$new$		update public.qorpera_surface_sessions
		set state = 'discarded', has_active_chat = false, lease_token = null, lease_expires_at = null, wake_id = null,
			closed_at = clock_timestamp(), updated_at = clock_timestamp()
		where exploration_id = p_exploration_id and id <> p_session_id;

		for v_discarded_session_id in
			select s.id from public.qorpera_surface_sessions s
			where s.exploration_id = p_exploration_id and s.id <> p_session_id and s.state = 'discarded'
			order by s.id
		loop
			perform public.qorpera_surface_enqueue_session_cleanup(v_discarded_session_id, auth.uid());
		end loop;$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_surface_remove(uuid,boolean)'::regprocedure,
	array[
$old$	v_now timestamptz := clock_timestamp();
begin$old$,
$new$	v_now timestamptz := clock_timestamp();
	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_discarded_session_ids uuid[] := '{}'::uuid[];
	v_discarded_session_id uuid;
begin$new$,
$old$	perform public.qorpera_surface_cancel_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.surface_id = p_surface_id),
		'surface_discarded'
	);$old$,
$new$	v_locked_worker_ids := public.qorpera_surface_lock_coding_workers_for_sessions(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.surface_id = p_surface_id and s.state <> 'completed')
	);
	perform public.qorpera_surface_cancel_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.surface_id = p_surface_id),
		'surface_discarded'
	);$new$,
$old$	update public.qorpera_surface_jobs
	set
		status = 'failed',
		error_detail = 'The interface was deleted',
		lease_token = null,
		lease_expires_at = null,
		completed_at = v_now,
		updated_at = v_now
	where surface_id = p_surface_id and status in ('queued', 'running');$old$,
$new$	update public.qorpera_surface_jobs
	set
		status = 'failed',
		error_detail = 'The interface was deleted',
		lease_token = null,
		lease_expires_at = null,
		completed_at = v_now,
		updated_at = v_now
	where surface_id = p_surface_id and kind <> 'cleanup_session' and status in ('queued', 'running');$new$,
$old$	update public.qorpera_surface_sessions
	set
		state = 'discarded',
		has_active_chat = false,
		lease_token = null,
		lease_expires_at = null,
		wake_id = null,
		closed_at = v_now,
		updated_at = v_now
	where surface_id = p_surface_id and state not in ('completed', 'discarded');$old$,
$new$	with newly_discarded as (
		update public.qorpera_surface_sessions
		set
			state = 'discarded',
			has_active_chat = false,
			lease_token = null,
			lease_expires_at = null,
			wake_id = null,
			closed_at = v_now,
			updated_at = v_now
		where surface_id = p_surface_id and state not in ('completed', 'discarded')
		returning id
	)
	select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_discarded_session_ids from newly_discarded;

	perform public.qorpera_surface_archive_locked_coding_workers(v_locked_worker_ids, 'surface_discarded');
	foreach v_discarded_session_id in array v_discarded_session_ids loop
		perform public.qorpera_surface_enqueue_session_cleanup(v_discarded_session_id, auth.uid());
	end loop;$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_undo_surface_change(uuid)'::regprocedure,
	array[
$old$	if v_lookup.exploration_id is not null then
		select * into v_exploration from public.qorpera_surface_explorations where id = v_lookup.exploration_id for update;
	end if;
	select * into v_session from public.qorpera_surface_sessions where id = v_lookup.session_id for update;$old$,
$new$	if v_lookup.exploration_id is not null then
		select * into v_exploration from public.qorpera_surface_explorations where id = v_lookup.exploration_id for update;
	end if;
	-- WHY: Lock session cleanup jobs before surface_sessions to match qorpera_surface_complete_cleanup lock order.
	perform 1 from public.qorpera_surface_jobs j
	where j.session_id = v_lookup.session_id and j.kind = 'cleanup_session' and j.status in ('queued', 'running')
	order by j.id
	for update;
	select * into v_session from public.qorpera_surface_sessions where id = v_lookup.session_id for update;$new$,
$old$	if v_change.status = 'merged' then$old$,
$new$	if v_change.status = 'discarded' and v_change.kind = 'git_range' then
		if exists (
			select 1 from public.qorpera_surface_jobs j
			where j.session_id = v_session.id
				and j.kind = 'cleanup_session'
				and j.status in ('running', 'completed')
				and j.created_at >= v_change.created_at
		) then
			raise exception 'This discarded change was already cleaned up and cannot be restored' using errcode = '22023';
		end if;
		delete from public.qorpera_surface_jobs
		where session_id = v_session.id and kind = 'cleanup_session' and status = 'queued';
	end if;

	if v_change.status = 'merged' then$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
	array[
$old$	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;$old$,
$new$	-- WHY: Lock cleanup jobs before surface_sessions to match qorpera_surface_complete_cleanup lock order and block reopen during cleanup.
	perform 1 from public.qorpera_surface_jobs j
	where j.session_id = p_session_id and j.kind = 'cleanup_session' and j.status in ('queued', 'running')
	order by j.id
	for update;
	if exists (
		select 1 from public.qorpera_surface_jobs j
		where j.session_id = p_session_id and j.kind = 'cleanup_session' and j.status = 'running'
	) then
		raise exception 'Session workspace is being cleaned up; try again in a moment' using errcode = '55000';
	end if;

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;$new$,
$old$	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);$old$,
$new$	where id = p_session_id
	returning * into v_session;

	delete from public.qorpera_surface_jobs
	where session_id = p_session_id and kind = 'cleanup_session' and status = 'queued';

	return public.qorpera_surface_session_json(v_session);$new$
	]
);

select pg_temp.sdwc_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$	v_merges jsonb := '[]'::jsonb;
	v_publishes jsonb := '[]'::jsonb;
begin$old$,
$new$	v_merges jsonb := '[]'::jsonb;
	v_publishes jsonb := '[]'::jsonb;
	v_cleanups jsonb := '[]'::jsonb;
begin$new$,
$old$			'merges', '[]'::jsonb,
			'publishes', '[]'::jsonb,
			'automations', '[]'::jsonb$old$,
$new$			'merges', '[]'::jsonb,
			'publishes', '[]'::jsonb,
			'cleanups', '[]'::jsonb,
			'automations', '[]'::jsonb$new$,
$old$	return jsonb_build_object(
		'sessions', v_sessions,
		'previews', v_previews,
		'merges', v_merges,
		'publishes', v_publishes,
		'automations', v_automations
	);$old$,
$new$	if v_lane in ('all', 'code_repo') then
		-- WHY: Claim discarded worktree cleanups only once the coding worker is idle/detached and no merge or cleanup runs on the surface.
		with candidate_cleanups as materialized (
			select distinct on (j.surface_id) j.id, j.surface_id, j.created_at
			from public.qorpera_surface_jobs j
			join public.qorpera_surfaces surf on surf.id = j.surface_id
			join public.qorpera_surface_sessions sess on sess.id = j.session_id
			where j.kind = 'cleanup_session'
				and j.status = 'queued'
				and surf.source_kind = 'code_repo'
				and surf.repository_key is not null
				and sess.state = 'discarded'
				and coalesce(j.payload ->> 'workerId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				and not public.qorpera_surface_company_paused(j.profile_id)
				and not exists (
					select 1 from public.qorpera_coding_sessions cs
					join public.qorpera_runtime_workers rw on rw.id = cs.worker_id
					where cs.worker_id = (j.payload ->> 'workerId')::uuid
						and (
							rw.state = 'active'
							or cs.attached_machine_id is not null
							or cs.vm_allocation_id is not null
							or cs.phase in ('queued', 'preparing', 'running', 'publishing', 'input_ready')
							or exists (
								select 1 from public.qorpera_coding_session_turns turn
								where turn.worker_id = cs.worker_id and turn.outcome is null
							)
						)
				)
				and not exists (
					select 1 from public.qorpera_surface_jobs running_j
					where running_j.surface_id = j.surface_id
						and running_j.kind in ('cleanup_session', 'land_change', 'undo_change')
						and running_j.status = 'running'
				)
			order by j.surface_id, j.created_at asc, j.id asc
		),
		picked as (
			select j.id
			from candidate_cleanups cc
			join public.qorpera_surface_jobs j on j.id = cc.id
			where j.status = 'queued'
			order by cc.created_at asc, cc.id asc
			limit v_cap
			for update of j skip locked
		),
		claimed as (
			update public.qorpera_surface_jobs j
			set
				status = 'running',
				attempts = j.attempts + 1,
				lease_expires_at = v_lease,
				lease_token = extensions.gen_random_uuid(),
				updated_at = v_now
			from picked
			where j.id = picked.id
			returning j.*
		)
		select coalesce(
			jsonb_agg(
				jsonb_build_object(
					'jobId', j.id,
					'surfaceId', j.surface_id,
					'sessionId', j.session_id,
					'profileId', j.profile_id,
					'environmentId', cof.environment_id,
					'leaseToken', j.lease_token,
					'sourceKind', surf.source_kind,
					'repositoryKey', surf.repository_key,
					'workerId', j.payload ->> 'workerId'
				)
				order by j.created_at asc
			),
			'[]'::jsonb
		)
		into v_cleanups
		from claimed j
		join public.qorpera_surfaces surf on surf.id = j.surface_id
		left join public.qorpera_company_cofounders cof on cof.profile_id = j.profile_id;
	end if;

	return jsonb_build_object(
		'sessions', v_sessions,
		'previews', v_previews,
		'merges', v_merges,
		'publishes', v_publishes,
		'cleanups', v_cleanups,
		'automations', v_automations
	);$new$
	]
);

revoke all on function
	public.qorpera_surface_lock_coding_workers_for_sessions(uuid[]),
	public.qorpera_surface_archive_locked_coding_workers(uuid[], text),
	public.qorpera_surface_archive_coding_workers(uuid[], text),
	public.qorpera_surface_enqueue_session_cleanup(uuid, uuid)
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
			'public.qorpera_discard_surface_session(uuid)'::regprocedure,
			'public.qorpera_discard_surface_change(uuid)'::regprocedure,
			'public.qorpera_discard_surface_option_group(uuid,text)'::regprocedure,
			'public.qorpera_set_session_chat_open(uuid,boolean)'::regprocedure,
			'public.qorpera_discard_exploration(uuid)'::regprocedure,
			'public.qorpera_choose_exploration(uuid,uuid)'::regprocedure,
			'public.qorpera_surface_remove(uuid,boolean)'::regprocedure,
			'public.qorpera_undo_surface_change(uuid)'::regprocedure,
			'public.qorpera_reply_surface_session(uuid,text,boolean)'::regprocedure,
			'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
			'public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Discard cleanup function has an API owner: %', v_owner;
		end if;
		execute format('grant select, insert, update, delete on public.qorpera_surface_jobs to %I', v_owner);
		execute format('grant select, update on public.qorpera_surface_sessions to %I', v_owner);
		execute format('grant select on public.qorpera_surfaces, public.qorpera_coding_sessions, public.qorpera_coding_session_turns, public.qorpera_runtime_workers to %I', v_owner);
		execute format(
			'grant execute on function public.qorpera_surface_lock_coding_workers_for_sessions(uuid[]), public.qorpera_surface_archive_locked_coding_workers(uuid[], text), public.qorpera_surface_archive_coding_workers(uuid[], text), public.qorpera_surface_enqueue_session_cleanup(uuid, uuid) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join sdwc_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930898000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.sdwc_patch(regprocedure, text[]);
drop table sdwc_before;
