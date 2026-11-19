do $$ begin
	if to_regclass('public.qorpera_home_outdated_images') is not null then
		raise exception '20260930811000 is already applied'; end if;
	if to_regprocedure('public.qorpera_claude_worker_resolve(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_company_machine_member_sleep_due(public.qorpera_company_machines,timestamptz,integer)') is null
		or to_regprocedure('public.qorpera_authorize_home_session(jsonb,jsonb,uuid)') is null then
		raise exception '20260930811000 needs Claude-first workers (20260930787000), member machine sleep (20260930759000) and the home';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.cw_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930811000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

create table public.qorpera_home_outdated_images (
	image_fingerprint text primary key check (image_fingerprint ~ '^[0-9a-f]{64}$')
);
alter table public.qorpera_home_outdated_images enable row level security;
revoke all on public.qorpera_home_outdated_images from public, anon, authenticated, service_role, qorpera_secret_broker;
insert into public.qorpera_home_outdated_images(image_fingerprint) values
	('084efd24d0f5c635e0e95ecec317abf4e61e21d6ee5e45595e6e88dd762d6a93'),
	('87fa4954e1a86685599dea1d1deae830e6ad59937462c6db8da4bb4281734389'),
	('91d433c0654112371a5cd74c12f81e3055ecc16f4e7eb4a83b9bc731e0dde1f6'),
	('c03bca32da877807666628909a370f18d5bf4af3f0caf6a6aec4c50db24a679b'),
	('9721cd75de76216a9adfdd092e1e95125664ce7a7a95ae0a2459670a22671696');

alter table public.qorpera_runtime_workers
	add column claude_machine_id uuid references public.qorpera_company_machines(id) on delete set null,
	add column claude_machine_since timestamptz,
	add constraint qorpera_runtime_workers_claude_machine check (claude_machine_since is null or harness_default);

alter table public.qorpera_runtime_worker_events
	drop constraint qorpera_runtime_worker_events_kind_check,
	add constraint qorpera_runtime_worker_events_kind_check check (kind in ('dispatched','followup','reported','ended',
		'cancelled','accepted','rejected','undeliverable','fell_back','machine_woken'));

create function public.qorpera_company_machine_home_outdated(p_machine public.qorpera_company_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_home_outdated_images image
		where image.image_fingerprint = (public.qorpera_company_machine_placement(p_machine.id)).binding ->> 'imageFingerprint')
$$;

create function public.qorpera_claude_worker_member_problem(p_profile_id uuid, p_run_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_member uuid; v_name text;
begin
	select run.* into v_run from public.qorpera_execution_runs run where run.id = p_run_id and run.profile_id = p_profile_id;
	v_member := v_run.requested_by_user_id;
	if v_run.id is null or v_member is null
		or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = v_member)
		or (exists (select 1 from public.qorpera_wake_occurrences wake where wake.run_id = v_run.id)
			and not exists (select 1 from public.qorpera_wake_occurrences wake
				join public.qorpera_wake_occurrences root on root.id = wake.causal_root_id
				where wake.run_id = v_run.id and root.wake_kind <> 'routine')) then
		return 'Claude Code works on a member''s word, and no member asked for this work: dispatch this worker without Claude Code';
	end if;
	v_name := public.qorpera_claude_worker_member_name(p_profile_id, v_member);
	if not exists (select 1 from public.qorpera_claude_sign_in_members allowed where allowed.user_id = v_member) then
		return format('Claude Code is not open for %s yet: dispatch this worker without Claude Code', v_name); end if;
	if not public.qorpera_claude_sign_in_open(p_profile_id, v_member) then
		return 'Claude Code is not open in this company yet: dispatch this worker without Claude Code'; end if;
	if not exists (select 1 from public.qorpera_claude_logins login where login.owner_user_id = v_member
		and login.status = 'active') then
		return format('Claude Code needs %1$s''s own Claude sign-in. Ask %1$s to sign in to Claude in Settings, Model accounts, '
			|| 'or dispatch this worker without Claude Code.', v_name); end if;
	return null;
end $$;

create or replace function public.qorpera_claude_worker_problem(p_profile_id uuid, p_staff_agent_id uuid, p_run_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_problem text := public.qorpera_claude_worker_member_problem(p_profile_id, p_run_id); v_member uuid;
begin
	if v_problem is not null then return v_problem; end if;
	select run.requested_by_user_id into v_member from public.qorpera_execution_runs run where run.id = p_run_id;
	if not public.qorpera_claude_worker_home(p_profile_id, p_staff_agent_id, v_member, p_run_id) then
		return format('Claude Code works on your own machine, and none is running for %s''s work now: start your machine, '
			|| 'or dispatch this worker without Claude Code', public.qorpera_claude_worker_member_name(p_profile_id, v_member));
	end if;
	return null;
end $$;

create function public.qorpera_claude_worker_machine_wakeable(p_profile_id uuid, p_staff_agent_id uuid, p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_claude_worker_member_problem(p_profile_id, p_run_id) is null
		and public.qorpera_company_home_allowed(p_profile_id) and public.qorpera_company_machines_available()
		and not public.qorpera_company_at_zero(p_profile_id, clock_timestamp())
		and coalesce(public.qorpera_folder_reads_root(public.qorpera_profile_environment(p_profile_id), p_profile_id,
			p_staff_agent_id, (select run.requested_by_user_id from public.qorpera_execution_runs run where run.id = p_run_id)), false)
$$;

select pg_temp.cw_replace('public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$and public.qorpera_company_machine_reserved(machine))$old$,
	$new$and public.qorpera_company_machine_reserved(machine)
				and not public.qorpera_company_machine_home_outdated(machine))$new$);

select pg_temp.cw_replace('public.qorpera_company_home_available(jsonb)'::regprocedure,
	$old$order by machine.last_used_at desc nulls last, machine.created_at desc limit 1;$old$,
	$new$order by public.qorpera_company_machine_home_outdated(machine), machine.last_used_at desc nulls last,
		machine.created_at desc limit 1;$new$);

select pg_temp.cw_replace('public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)'::regprocedure,
	$old$and public.qorpera_claude_worker_problem(p_profile_id, p_staff_agent_id, p_run_id) is null$old$,
	$new$and (public.qorpera_claude_worker_problem(p_profile_id, p_staff_agent_id, p_run_id) is null
			or public.qorpera_claude_worker_machine_wakeable(p_profile_id, p_staff_agent_id, p_run_id))$new$);

select pg_temp.cw_replace('public.qorpera_claude_worker_resolve(uuid,uuid,uuid)'::regprocedure,
	$old$claude_login_id = v_login,$old$,
	$new$claude_login_id = v_login, claude_machine_id = null, claude_machine_since = null,$new$);

create function public.qorpera_claude_worker_machine_for(p_worker public.qorpera_runtime_workers)
returns public.qorpera_company_machines language sql stable security definer set search_path = '' as $$
	select machine from public.qorpera_company_machines machine
	where machine.profile_id = p_worker.profile_id and machine.started_by_staff_agent_id = p_worker.staff_agent_id
		and machine.removed_at is null and machine.desired_state <> 'deleted'
		and public.qorpera_claude_worker_on_home(machine, p_worker.staff_agent_id, p_worker.requested_by_user_id)
		and not public.qorpera_company_machine_home_outdated(machine)
	order by public.qorpera_company_machine_state(machine) = 'running' desc, machine.desired_state = 'running' desc,
		machine.last_used_at desc, machine.created_at desc, machine.id
	limit 1
$$;

create function public.qorpera_claude_worker_machine_outcome(p_worker public.qorpera_runtime_workers)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype;
begin
	if public.qorpera_claude_worker_home(p_worker.profile_id, p_worker.staff_agent_id, p_worker.requested_by_user_id,
		p_worker.steering_run_id) then
		return 'running'; end if;
	select * into v_machine from public.qorpera_company_machines where id = p_worker.claude_machine_id;
	return case
		when clock_timestamp() >= p_worker.claude_machine_since + interval '5 minutes' then 'limit'
		when v_machine.id is null or v_machine.removed_at is not null or v_machine.desired_state = 'deleted' then 'gone'
		when v_machine.desired_state <> 'running' then 'stopped'
		when v_machine.last_error like 'start:%' and v_machine.last_error_at >= p_worker.claude_machine_since then 'failed'
		when public.qorpera_company_machine_home_outdated(v_machine) then 'outdated'
		when public.qorpera_company_at_zero(p_worker.profile_id, clock_timestamp()) then 'hours' end;
end $$;

create function public.qorpera_claude_worker_machine_waits(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(p_worker.harness = 'claude-code' and p_worker.harness_default and p_worker.occurrence_id is null
		and p_worker.claude_machine_since is not null and public.qorpera_claude_worker_machine_outcome(p_worker) is null, false)
$$;

create function public.qorpera_claude_worker_machine_fall_back(p_worker public.qorpera_runtime_workers, p_outcome text,
	p_words text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype; v_woken jsonb; v_words text;
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_worker.profile_id::text, 0));
	select * into v_machine from public.qorpera_company_machines where id = p_worker.claude_machine_id for update;
	select event.body into v_woken from public.qorpera_runtime_worker_events event
	where event.worker_id = p_worker.id and event.sequence = p_worker.sequence and event.kind = 'machine_woken'
	order by event.created_at desc limit 1;
	if p_outcome = 'limit' and v_machine.id is not null and v_machine.removed_at is null
		and v_machine.desired_state = 'running' and public.qorpera_company_machine_state(v_machine) <> 'running'
		and v_woken ->> 'wantedAt' = to_jsonb(v_machine.wanted_at) #>> '{}'
		and cardinality(v_machine.notify_run_ids) = 0
		and not exists (select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
			where run.id = v_machine.taken_by_run_id and job.status in ('queued', 'leased'))
		and not exists (select 1 from public.qorpera_runtime_workers other where other.id <> p_worker.id
			and other.claude_machine_id = v_machine.id and public.qorpera_claude_worker_machine_waits(other)) then
		perform public.qorpera_set_company_machine_desired(v_machine, 'stopped', 'kernel');
	end if;
	v_words := coalesce(p_words, format(case p_outcome
		when 'limit' then '%s''s machine for Claude Code did not start within 5 minutes'
		when 'hours' then 'the company has no computer hours left to start %s''s machine for Claude Code'
		else '%s''s machine for Claude Code could not start' end,
		public.qorpera_claude_worker_member_name(p_worker.profile_id, p_worker.requested_by_user_id)));
	update public.qorpera_runtime_workers
	set harness = null, claude_login_id = null, claude_model = null, claude_effort = null,
		claude_fallback_sequence = sequence, updated_at = clock_timestamp()
	where id = p_worker.id;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
	values (p_worker.id, p_worker.sequence, 'fell_back', jsonb_build_object('reason', 'no_machine', 'words', v_words,
		'changed', '[]'::jsonb, 'machine', p_outcome, 'machineId', p_worker.claude_machine_id,
		'waitedMs', case when p_worker.claude_machine_since is not null
			then floor(extract(epoch from clock_timestamp() - p_worker.claude_machine_since) * 1000)::bigint end));
end $$;

create function public.qorpera_claude_worker_machine_name(p_profile_id uuid, p_staff_agent_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_slug text; v_name text; v_number integer := 1;
begin
	select replace(replace(replace(replace(replace(replace(replace(lower(staff.display_name),
		'æ', 'ae'), 'ø', 'oe'), 'å', 'aa'), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss') into v_slug
	from public.qorpera_profile_staff staff where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id;
	v_slug := translate(coalesce(v_slug, ''), 'àáâãāèéêëēìíîïòóôõōùúûūýÿñçčšž', 'aaaaaeeeeeiiiiooooouuuuyynccsz');
	v_slug := btrim(left(btrim(regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g'), '-'), 31), '-');
	if v_slug = '' then v_slug := 'agent'; end if;
	v_name := v_slug || '-home';
	while exists (select 1 from public.qorpera_company_machines machine
		where machine.profile_id = p_profile_id and machine.name = v_name and machine.removed_at is null) loop
		v_number := v_number + 1;
		if v_number > 999 then raise exception 'MACHINE_NAME_UNAVAILABLE' using errcode = 'P0F10'; end if;
		v_name := v_slug || '-home-' || v_number;
	end loop;
	return v_name;
end $$;

create function public.qorpera_claude_worker_machine_wait(p_worker public.qorpera_runtime_workers)
returns text language plpgsql security definer set search_path = '' as $$
declare
	c_cpus constant integer := 2;
	c_memory_gib constant bigint := 4;
	c_disk_gib constant bigint := 40;
	v_outcome text; v_machine public.qorpera_company_machines%rowtype; v_admission jsonb; v_woke boolean := false;
	v_new boolean := false; v_member text; v_problem text;
begin
	if p_worker.harness is distinct from 'claude-code' or not p_worker.harness_default or p_worker.occurrence_id is not null then
		return 'ready'; end if;
	if p_worker.claude_machine_since is not null then
		v_outcome := public.qorpera_claude_worker_machine_outcome(p_worker);
		if v_outcome is null then return 'waiting'; end if;
		if v_outcome = 'running' then return 'ready'; end if;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_worker.profile_id::text, 0));
		v_outcome := public.qorpera_claude_worker_machine_outcome(p_worker);
		if v_outcome is null then return 'waiting'; end if;
		if v_outcome = 'running' then return 'ready'; end if;
		perform public.qorpera_claude_worker_machine_fall_back(p_worker, v_outcome);
		return 'fell_back';
	end if;
	if public.qorpera_claude_worker_home(p_worker.profile_id, p_worker.staff_agent_id, p_worker.requested_by_user_id,
		p_worker.steering_run_id) then
		return 'ready'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_worker.profile_id::text, 0));
	if not public.qorpera_claude_worker_machine_wakeable(p_worker.profile_id, p_worker.staff_agent_id, p_worker.steering_run_id) then
		v_problem := public.qorpera_claude_worker_member_problem(p_worker.profile_id, p_worker.steering_run_id);
		perform public.qorpera_claude_worker_machine_fall_back(p_worker,
			case when v_problem is not null then 'member'
				when public.qorpera_company_at_zero(p_worker.profile_id, clock_timestamp()) then 'hours' else 'unavailable' end,
			v_problem);
		return 'fell_back';
	end if;
	begin
		v_machine := public.qorpera_claude_worker_machine_for(p_worker);
		if v_machine.id is null then
			v_member := left(btrim(regexp_replace(public.qorpera_claude_worker_member_name(p_worker.profile_id,
				p_worker.requested_by_user_id), '[\x00-\x1f\x7f]+', ' ', 'g')), 200);
			insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
				started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
				desired_state, desired_by, notify_run_ids)
			values (extensions.gen_random_uuid(), p_worker.profile_id, p_worker.environment_id,
				public.qorpera_claude_worker_machine_name(p_worker.profile_id, p_worker.staff_agent_id),
				'Started for Claude Code work ' || v_member || ' asked for.', p_worker.staff_agent_id, null, null,
				p_worker.requested_by_user_id, c_cpus, c_memory_gib * 1073741824, c_disk_gib * 1073741824, 'standard', 'task',
				'running', 'agent', '{}'::uuid[])
			returning * into v_machine;
			v_new := true;
			v_woke := true;
		elsif v_machine.desired_state <> 'running' then
			update public.qorpera_company_machines set desired_state = 'running', desired_by = 'agent', wanted_at = clock_timestamp(),
				updated_at = clock_timestamp()
			where id = v_machine.id;
			update public.qorpera_company_machine_placements set stop_authorized_at = null
			where id = (public.qorpera_company_machine_placement(v_machine.id)).id;
			v_woke := true;
		end if;
		v_admission := public.qorpera_admit_company_machine(v_machine.id);
		if v_admission ->> 'reason' in ('MACHINE_TOO_LARGE', 'MACHINES_UNAVAILABLE', 'COMPUTER_HOURS_EXHAUSTED', 'COMPANY_PAUSED',
			'MACHINE_NOT_WAITING') then
			raise exception '%', v_admission ->> 'reason' using errcode = 'P0F10'; end if;
	exception
		when sqlstate 'P0F10' then
			perform public.qorpera_claude_worker_machine_fall_back(p_worker,
				case when sqlerrm = 'COMPUTER_HOURS_EXHAUSTED' then 'hours' else 'refused' end);
			return 'fell_back';
		when lock_not_available or deadlock_detected or query_canceled then
			raise;
		when others then
			perform public.qorpera_claude_worker_machine_fall_back(p_worker, 'refused');
			return 'fell_back';
	end;
	select * into strict v_machine from public.qorpera_company_machines where id = v_machine.id;
	update public.qorpera_runtime_workers set claude_machine_id = v_machine.id, claude_machine_since = clock_timestamp(),
		updated_at = clock_timestamp()
	where id = p_worker.id;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, body)
	values (p_worker.id, p_worker.sequence, 'machine_woken', jsonb_build_object('machineId', v_machine.id, 'machine', v_machine.name,
		'new', v_new, 'woke', v_woke,
		'wantedAt', case when public.qorpera_company_machine_state(v_machine) <> 'running' then v_machine.wanted_at end,
		'state', public.qorpera_company_machine_state(v_machine),
		'waitingFor', case when v_admission ->> 'state' = 'refused' then v_admission ->> 'reason' end));
	return case when public.qorpera_claude_worker_home(p_worker.profile_id, p_worker.staff_agent_id,
		p_worker.requested_by_user_id, p_worker.steering_run_id) then 'ready' else 'waiting' end;
end $$;

select pg_temp.cw_replace('public.qorpera_folder_worker_due(public.qorpera_runtime_workers)'::regprocedure,
	$old$				and not public.qorpera_claude_worker_waits(p_worker))$old$,
	$new$				and not public.qorpera_claude_worker_waits(p_worker)
				and not public.qorpera_claude_worker_machine_waits(p_worker))$new$);

select pg_temp.cw_replace('public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
	$old$						v_start := extensions.gen_random_uuid();
						if v_worker.harness = 'claude-code' then$old$,
	$new$						if v_worker.harness_default and v_worker.harness = 'claude-code' then
							if public.qorpera_claude_worker_machine_wait(v_worker) = 'waiting' then continue; end if;
							select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
						end if;
						v_start := extensions.gen_random_uuid();
						if v_worker.harness = 'claude-code' then$new$);

create function public.qorpera_company_machine_claude_at_work(p_machine public.qorpera_company_machines,
	p_placement public.qorpera_company_machine_placements)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_home_sessions session
		join public.qorpera_execution_runs run on run.id = session.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id
		where session.placement_id = p_placement.id and session.boot_id = p_placement.boot_id and session.closed_at is null
			and session.machine_id = p_machine.id and job.status in ('queued', 'leased')
			and (public.qorpera_run_worker(session.run_id)).harness = 'claude-code')
$$;

select pg_temp.cw_replace('public.qorpera_list_executor_machines(text,text)'::regprocedure,
	$old$and ((machine.lifetime = 'task'
$old$,
	$new$and ((machine.lifetime = 'task' and not public.qorpera_company_machine_claude_at_work(machine, placement)
$new$);

select pg_temp.cw_replace('public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure,
	$old$elsif v_machine.lifetime <> 'task'
$old$,
	$new$elsif v_machine.lifetime <> 'task' or public.qorpera_company_machine_claude_at_work(v_machine, v_placement)
$new$);

revoke all on function public.qorpera_company_machine_home_outdated(public.qorpera_company_machines),
	public.qorpera_claude_worker_member_problem(uuid, uuid),
	public.qorpera_claude_worker_machine_wakeable(uuid, uuid, uuid),
	public.qorpera_claude_worker_machine_for(public.qorpera_runtime_workers),
	public.qorpera_claude_worker_machine_outcome(public.qorpera_runtime_workers),
	public.qorpera_claude_worker_machine_waits(public.qorpera_runtime_workers),
	public.qorpera_claude_worker_machine_fall_back(public.qorpera_runtime_workers, text, text),
	public.qorpera_claude_worker_machine_name(uuid, uuid),
	public.qorpera_claude_worker_machine_wait(public.qorpera_runtime_workers),
	public.qorpera_company_machine_claude_at_work(public.qorpera_company_machines, public.qorpera_company_machine_placements)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_claude_worker_problem(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_claude_worker_problem(uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_company_home_available(jsonb)'::regprocedure,
		'public.qorpera_claude_worker_default_login(uuid,uuid,uuid,uuid)'::regprocedure,
		'public.qorpera_folder_worker_due(public.qorpera_runtime_workers)'::regprocedure,
		'public.qorpera_folder_workers_company(uuid,integer)'::regprocedure,
		'public.qorpera_list_executor_machines(text,text)'::regprocedure,
		'public.qorpera_authorize_executor_machine(uuid,text,text,text,text)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'A function 20260930811000 patches has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_company_machine_home_outdated(public.qorpera_company_machines), '
				'public.qorpera_claude_worker_member_problem(uuid, uuid), '
				'public.qorpera_claude_worker_machine_wakeable(uuid, uuid, uuid), '
				'public.qorpera_claude_worker_machine_waits(public.qorpera_runtime_workers), '
				'public.qorpera_claude_worker_machine_wait(public.qorpera_runtime_workers), '
				'public.qorpera_company_machine_claude_at_work(public.qorpera_company_machines, '
				'public.qorpera_company_machine_placements) to %I', v_owner);
		end if;
	end loop;
end $$;
