-- 20260930182000: the weekly check-in for always-on machines under one idle rule for every machine (the 2026-10-03
-- amendment, item 6). Folder-v2 only by the founder's decision of 3 October. An always-on machine is the explicit way to
-- stay up: this rule never puts it to sleep. The agent that started it is asked once a week whether it still needs it,
-- counted from the machine's start, in the conversation of the run that started it (a worker's: the conversation that
-- dispatched it), busy or not. It may stop the machine or leave it. A question is a notice, never a stop. It rides
-- 20260930098000's check-ins: one qorpera_machine_checkins row per question (the new kind 'always-on', the machine as its
-- subject), asked and delivered by the same folder drain (machine_checkins, LISTENER §9), after 20260930181000's.
-- 1. When: from the machine's start (wanted_at: its last start, by an agent or a member; a move to another node keeps
--    it), at each full week while it should run (168 hours, 336, ...). Only the latest week passed is asked: after
--    downtime or a late drain the agent is asked once, never for each week it missed.
-- 2. Who is asked: the agent that started the machine (started_by_staff_agent_id), only while it is active. Nobody is
--    asked when a member started it last (desired_by 'member'), or when that agent is no longer active (archived): the
--    machine keeps running, and the company's members see it and can stop it.
-- 3. Delivery: a question still stands only while the machine is still always-on, wanted running since the same start,
--    by an agent, and the same agent would be asked in the same conversation; one that no longer stands, or one a later
--    week replaced, is suppressed.
-- Every patched or new body names this migration (20260930182000).

set local lock_timeout = '3s';

-- 1. The kind --------------------------------------------------------------------------------------------------------

-- 'always-on': an always-on machine's weekly question.
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_machine_checkins_machine_kind_check'
		and conrelid = 'public.qorpera_machine_checkins'::regclass)) is distinct from
		'CHECK ((machine_kind = ANY (ARRAY[''computer''::text, ''machine''::text, ''coding''::text])))' then
		raise exception 'Machine check-in kinds differ from 20260930098000'; end if;
end
$$;
alter table public.qorpera_machine_checkins drop constraint qorpera_machine_checkins_machine_kind_check;
alter table public.qorpera_machine_checkins add constraint qorpera_machine_checkins_machine_kind_check
	check (machine_kind in ('computer', 'machine', 'coding', 'always-on'));

create function pg_temp.always_on_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Always-on check-in anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 2. Asking ------------------------------------------------------------------------------------------------------------

-- Who would be asked about an always-on machine, and since when: the agent that started it, in the conversation of the
-- run that started it, from its last start. Nothing for a task machine, one not wanted running, or one a member started.
create function public.qorpera_company_machine_always_on_since(p_machine public.qorpera_company_machines)
returns table (staff_agent_id uuid, conversation_run_id uuid, since timestamptz)
language sql stable security definer set search_path = '' as $$
	-- 20260930182000.
	select p_machine.started_by_staff_agent_id, p_machine.started_conversation_run_id, p_machine.wanted_at
	where p_machine.lifetime = 'always-on' and p_machine.desired_state = 'running' and p_machine.desired_by = 'agent'
		and p_machine.removed_at is null and p_machine.started_conversation_run_id is not null
$$;
revoke all on function public.qorpera_company_machine_always_on_since(public.qorpera_company_machines)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The questions due and not asked yet, in one folder-v2 environment (or all, for the due list): for each always-on
-- machine wanted running for at least a week since its last start, one question at the latest full week passed. An
-- archived agent is not asked.
create function public.qorpera_company_machine_always_on_checkins_unasked(p_environment_id uuid)
returns table (machine_id uuid, profile_id uuid, environment_id uuid, staff_agent_id uuid, conversation_run_id uuid,
	since timestamptz, mark integer)
language sql stable security definer set search_path = '' as $$
	-- 20260930182000.
	select asking.* from (
		select machine.id as machine_id, machine.profile_id, machine.environment_id, wanted.staff_agent_id, wanted.conversation_run_id,
			wanted.since, 168 * floor(extract(epoch from clock_timestamp() - wanted.since) / 604800)::integer as mark
		from public.qorpera_company_machines machine
		cross join lateral public.qorpera_company_machine_always_on_since(machine) wanted
		where (p_environment_id is null or machine.environment_id = p_environment_id)
			and machine.lifetime = 'always-on' and machine.desired_state = 'running' and machine.removed_at is null
			and machine.wanted_at <= clock_timestamp() - interval '168 hours'
			and public.qorpera_environment_is_folder_v2(machine.environment_id)
			and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = machine.profile_id
				and staff.staff_agent_id = wanted.staff_agent_id and staff.employment_status = 'active')) asking
	where not exists (select 1 from public.qorpera_machine_checkins asked where asked.machine_kind = 'always-on'
		and asked.subject_id = asking.machine_id and asked.parent_run_id = asking.conversation_run_id
		and asked.since = asking.since and asked.mark_hours = asking.mark)
$$;
revoke all on function public.qorpera_company_machine_always_on_checkins_unasked(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One folder-v2 company's always-on machines due their weekly question (at most p_limit, longest wanted first). One
-- machine's trouble never stops the others. Returns how many it asked. Its caller holds the folder fence KEY SHARE; a
-- question's parent run is locked only KEY SHARE, by its foreign key; the machine is only read.
create function public.qorpera_ask_always_on_company_machines(p_environment_id uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_wanted record; v_asked integer := 0; v_count integer;
begin
	-- 20260930182000.
	if p_environment_id is null or p_limit is null or p_limit not between 1 and 256 then
		raise exception 'Machine check-in bound is invalid' using errcode = '22023'; end if;
	for v_wanted in select * from public.qorpera_company_machine_always_on_checkins_unasked(p_environment_id) unasked
		order by unasked.since, unasked.machine_id limit p_limit loop
		begin
			-- The machine by its name, and how many weeks it has been wanted since its start.
			insert into public.qorpera_machine_checkins(profile_id, environment_id, staff_agent_id, parent_run_id, machine_kind,
				subject_id, since, mark_hours, body)
			values (v_wanted.profile_id, v_wanted.environment_id, v_wanted.staff_agent_id, v_wanted.conversation_run_id, 'always-on',
				v_wanted.machine_id, v_wanted.since, v_wanted.mark,
				jsonb_build_object('machine', (select machine.name from public.qorpera_company_machines machine
					where machine.id = v_wanted.machine_id), 'weeks', v_wanted.mark / 168))
			on conflict (machine_kind, subject_id, parent_run_id, since, mark_hours) do nothing;
			get diagnostics v_count = row_count;
			v_asked := v_asked + v_count;
		exception when check_violation or not_null_violation or foreign_key_violation or program_limit_exceeded then
			-- This question cannot be carried; the others still are.
			null;
		end;
	end loop;
	return v_asked;
end $$;
revoke all on function public.qorpera_ask_always_on_company_machines(uuid, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. Delivery ----------------------------------------------------------------------------------------------------------

-- An always-on machine's question still stands while the same agent would be asked about it in the same conversation,
-- from the same start: a stop, a member's start, a new start or its removal leave it standing no more.
select pg_temp.always_on_patch('public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)'::regprocedure,
	$old$					and busy.conversation_run_id = p_checkin.parent_run_id and busy.since = p_checkin.since) -- 20260930181000
			-- Other machines judge their questions when they ask them.
			else true end$old$,
	$new$					and busy.conversation_run_id = p_checkin.parent_run_id and busy.since = p_checkin.since) -- 20260930181000
			when 'always-on' then exists (select 1 from public.qorpera_company_machines machine
				cross join lateral public.qorpera_company_machine_always_on_since(machine) wanted
				where machine.id = p_checkin.subject_id and wanted.staff_agent_id = p_checkin.staff_agent_id
					and wanted.conversation_run_id = p_checkin.parent_run_id and wanted.since = p_checkin.since) -- 20260930182000
			-- Other machines judge their questions when they ask them.
			else true end$new$);

-- 4. The drain ---------------------------------------------------------------------------------------------------------

-- The shared drains' page: a company with an always-on machine's question to ask is due as one with a busy machine's.
select pg_temp.always_on_patch('public.qorpera_folder_machine_checkins_due(uuid,integer)'::regprocedure,
	$old$		select unasked.environment_id, unasked.profile_id from public.qorpera_company_machine_busy_checkins_unasked(null) unasked -- 20260930181000
		union$old$,
	$new$		select unasked.environment_id, unasked.profile_id from public.qorpera_company_machine_busy_checkins_unasked(null) unasked -- 20260930181000
		union
		select unasked.environment_id, unasked.profile_id from public.qorpera_company_machine_always_on_checkins_unasked(null) unasked -- 20260930182000
		union$new$);
-- The company's step asks the always-on machines' questions with the others.
select pg_temp.always_on_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$		and not exists (select 1 from public.qorpera_company_machine_busy_checkins_unasked(p_environment_id)) then -- 20260930181000$old$,
	$new$		and not exists (select 1 from public.qorpera_company_machine_busy_checkins_unasked(p_environment_id)) -- 20260930181000
		and not exists (select 1 from public.qorpera_company_machine_always_on_checkins_unasked(p_environment_id)) then -- 20260930182000$new$);
select pg_temp.always_on_patch('public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure,
	$old$			+ public.qorpera_ask_busy_company_machines(p_environment_id, 64); -- 20260930181000$old$,
	$new$			+ public.qorpera_ask_busy_company_machines(p_environment_id, 64) -- 20260930181000
			+ public.qorpera_ask_always_on_company_machines(p_environment_id, 64); -- 20260930182000$new$);

-- The patched functions may have a private owner in production: it reaches what their new text uses.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_machine_checkin_current(public.qorpera_machine_checkins)'::regprocedure,
		'public.qorpera_folder_machine_checkins_due(uuid,integer)'::regprocedure,
		'public.qorpera_folder_machine_checkins_company(uuid,integer)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Machine check-in function has an API owner'; end if;
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_machines to %I', v_owner);
			execute format('grant execute on function public.qorpera_company_machine_always_on_since(public.qorpera_company_machines), '
				'public.qorpera_company_machine_always_on_checkins_unasked(uuid), '
				'public.qorpera_ask_always_on_company_machines(uuid, integer) to %I', v_owner);
		end if;
	end loop;
end $$;
