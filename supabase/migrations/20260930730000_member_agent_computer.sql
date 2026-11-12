-- 20260930730000: a member starts a desktop computer for an agent that has none (Jonas, 12 Nov 2026, from the computer
-- window of an agent with no machine: "opening the computer still produces this window with the message implying I cant
-- manually start a desktop computer, instead of just starting one"). One press makes ONE machine exactly as the agent's
-- own machine_start with desktop true and its defaults makes it (2 cpus, 4 GiB, 40 GiB of disk, lifetime task, the
-- standard image, through the same admission), with the agent as the one it is started by and the member as the one who
-- asked; the window then turns its screen on as a member's start of a desktop does (20260930714000).
--
-- * qorpera_member_start_agent_computer(profile, agent), for authenticated: owners, admins and contributors
--   (qorpera_can_write_profile, as a member's wake of a machine). The agent must be the company's, on staff
--   (employment_status active) and not deleted (else AGENT_UNAVAILABLE: an archived or deleted agent's folder view is
--   refused, so its machine would run without the company folder). lifecycle_state is not read: every agent the company
--   folder hires is made 'setup' and nothing on folder-v2 moves it (the desktop registry's field, 20260818000000), so it
--   tells nothing. Under the company's machine lock (the folder fence, the member's row, then the company's machines
--   one at a time, as every start and wake): a machine of the agent's (started by it, or whose screen it drove last) big
--   enough for a desktop and not being deleted is answered as it is (`existing`; the window wakes it), nothing new; at
--   most one new machine per agent a minute (START_TOO_SOON); else the machine is made, admitted as machine_start admits
--   it (qorpera_admit_company_machine: placed at once on a node with room, else it waits in line for room or hours as
--   any wanted machine; MACHINE_TOO_LARGE and MACHINES_UNAVAILABLE refuse and keep nothing), and answered (`started`).
--   Its name is the agent's name made a machine name plus "-desktop" (a number added when taken); its purpose says the
--   member started it from the computer window. The size lives in this function's three constants: the runtime's
--   CLOUD_MACHINE_DESKTOP_LEAST (2 cpus, 4 GiB) and machine_start's default disk (40 GiB) in
--   packages/runtime/src/cloud-machine-tools.ts; packages/runtime's test reads them here, so the two cannot drift apart.
-- * A machine no run started: started_by_run_id and started_by_receipt_id may now be null, together (a member's press
--   has neither). Every reader of them was read for a null:
--   - the conversation trigger leaves started_conversation_run_id and started_session_id null;
--   - the machine's view answers startedBy.runId null; a session's machines and the operators' compute requests list it
--     without a run; machine_start never finds it by a receipt;
--   - a folder view of it acts as its agent and member, company-wide, as one whose starter's run has ended
--     (qorpera_folder_view_live_run has no starter run to act through; worker access null, as any non-worker run's);
--   - qorpera_folder_commit, below; the busy and always-on check-ins have no starting conversation to ask (an agent's
--     command keeps its own), hence the idle rule below.
-- * qorpera_folder_commit, a save through such a machine's folder view: the check that a detached test machine's
--   starter's run still reads what it read (what that run read may be on the disk) has no starter run here. What a run
--   read reaches this disk through the commands the run started on it (machine_run): a run's own reads are not in the
--   view's read set, and a release through the view while the command ran lands in that run's read set too. So each run
--   with a command on this placement's disk is checked as a starter is, its read set under its own authority, in run id
--   order. A machine an agent started keeps exactly its check.
-- * The idle rule for a machine no run started: a busy record moves its last use only while a command whose
--   conversation the busy check-in asks runs on its placement. Busy outside such a command (a page left spinning on the
--   desktop) asks no one, so it no longer keeps the machine awake: it sleeps after its quiet window without use (a
--   command, an agent's screen call, a member's look or hold), busy or not. Machines agents started are unchanged.
-- Every new or patched body names this migration (20260930730000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_member_start_agent_computer(uuid,uuid)') is not null then
		raise exception '20260930730000 is already applied'; end if;
	if to_regprocedure('public.qorpera_member_machine_desktop_start_begin(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_review_member_name(uuid,uuid)') is null then
		raise exception '20260930730000 needs a member''s start of a desktop (20260930714000)'; end if;
end $$;

-- The column change and the check lock the machines: never queue behind a long transaction.
set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.member_agent_computer_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930730000' in v_definition) > 0 then
		raise exception '20260930730000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930730000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930730000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. A machine no run started ------------------------------------------------------------------------------------------------

alter table public.qorpera_company_machines
	alter column started_by_run_id drop not null,
	alter column started_by_receipt_id drop not null,
	add constraint qorpera_company_machines_started_by_run check ((started_by_run_id is null) = (started_by_receipt_id is null));
comment on column public.qorpera_company_machines.started_by_run_id is
	'The run whose machine_start made the machine; null for one a member started (20260930730000), with started_by_receipt_id.';

-- 2. A member's start of a computer for an agent -------------------------------------------------------------------------------

create function public.qorpera_member_start_agent_computer(p_profile_id uuid, p_staff_agent_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	-- The size of a desktop computer, as machine_start with desktop true and its defaults makes it: the runtime's
	-- CLOUD_MACHINE_DESKTOP_LEAST and default disk (packages/runtime/src/cloud-machine-tools.ts; its test reads these).
	c_cpus constant integer := 2;
	c_memory_gib constant bigint := 4;
	c_disk_gib constant bigint := 40;
	v_now timestamptz; v_staff public.qorpera_profile_staff%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_environment uuid; v_slug text; v_name text; v_member text; v_number integer := 1; v_admission jsonb;
begin
	-- 20260930730000
	if auth.uid() is null or p_profile_id is null or p_staff_agent_id is null then
		raise exception 'Computer start is invalid' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	-- The one lock order of the company's machines (qorpera_member_manage_company_machine's): the folder fence, the member's
	-- row KEY SHARE and their write access read again (a removal or a demotion that committed meanwhile refuses here),
	-- then the company's machines one at a time. Two presses, two tabs or two members at once make one computer: the
	-- second waits here and finds the first's.
	perform public.qorpera_folder_machine_fence(p_profile_id);
	perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = auth.uid() for key share;
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_profile_id::text, 0));
	v_now := clock_timestamp();
	select * into v_staff from public.qorpera_profile_staff
	where profile_id = p_profile_id and staff_agent_id = p_staff_agent_id for key share;
	if v_staff.staff_agent_id is null then
		raise exception 'Agent is unavailable' using errcode = '42501'; end if;
	-- Off staff or deleted: its folder view is refused, so a machine of it would run without the company folder.
	if v_staff.deleted_at is not null or v_staff.employment_status <> 'active' then
		return jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'refused',
			'reason', 'AGENT_UNAVAILABLE'); end if;
	-- A machine of the agent's already big enough for a desktop, as the window lists the agent's machines: it, nothing new.
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.profile_id = p_profile_id and machine.removed_at is null and machine.desired_state <> 'deleted'
		and (machine.started_by_staff_agent_id = p_staff_agent_id or machine.screen_staff_agent_id = p_staff_agent_id)
		and machine.cpus >= c_cpus and machine.memory_bytes >= c_memory_gib * 1073741824
	order by public.qorpera_company_machine_state(machine) = 'running' desc, machine.created_at desc, machine.id
	limit 1;
	if v_machine.id is not null then
		return jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'existing',
			'machine', jsonb_build_object('machineId', v_machine.id, 'name', v_machine.name,
				'state', public.qorpera_company_machine_state(v_machine))); end if;
	-- At most one new computer per agent a minute (one deleted meanwhile counts).
	if exists (select 1 from public.qorpera_company_machines as machine
		where machine.profile_id = p_profile_id and machine.started_by_staff_agent_id = p_staff_agent_id
			and machine.started_by_run_id is null and machine.created_at > v_now - interval '1 minute') then
		return jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'refused',
			'reason', 'START_TOO_SOON'); end if;
	-- The company's environment, the one its agents' runs work in.
	v_environment := public.qorpera_profile_environment(p_profile_id);
	if v_environment is null or not exists (select 1 from public.qorpera_company_files as file
		where file.environment_id = v_environment and file.profile_id = p_profile_id and file.core = 'folder-v2') then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	-- The agent's name as a machine name: lowercase, Danish and accented letters spelt plain, anything else a dash, at most
	-- 28 characters (room for "-desktop" and a number), "agent" when nothing is left; a number added when taken.
	v_slug := replace(replace(replace(replace(replace(replace(replace(lower(v_staff.display_name),
		'æ', 'ae'), 'ø', 'oe'), 'å', 'aa'), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
	v_slug := translate(v_slug, 'àáâãāèéêëēìíîïòóôõōùúûūýÿñçčšž', 'aaaaaeeeeeiiiiooooouuuuyynccsz');
	v_slug := btrim(left(btrim(regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g'), '-'), 28), '-');
	if v_slug = '' then v_slug := 'agent'; end if;
	v_name := v_slug || '-desktop';
	while exists (select 1 from public.qorpera_company_machines as machine
		where machine.profile_id = p_profile_id and machine.name = v_name and machine.removed_at is null) loop
		v_number := v_number + 1;
		if v_number > 999 then raise exception 'Computer name is unavailable' using errcode = '55000'; end if;
		v_name := v_slug || '-desktop-' || v_number;
	end loop;
	v_member := left(btrim(regexp_replace(coalesce(public.qorpera_review_member_name(p_profile_id, auth.uid()), ''),
		'[\x00-\x1f\x7f]+', ' ', 'g')), 200);
	if v_member = '' then v_member := 'a member'; end if;
	-- A refusal the window can say leaves no machine behind (machine_start's own rule).
	begin
		insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id,
			started_by_run_id, started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime,
			desired_state, desired_by, notify_run_ids)
		values (extensions.gen_random_uuid(), p_profile_id, v_environment, v_name,
			'Desktop computer started by ' || v_member || ' from the computer window.', p_staff_agent_id, null, null, auth.uid(),
			c_cpus, c_memory_gib * 1073741824, c_disk_gib * 1073741824, 'standard', 'task', 'running', 'member', '{}'::uuid[])
		returning * into v_machine;
		v_admission := public.qorpera_admit_company_machine(v_machine.id);
		if v_admission ->> 'reason' in ('MACHINE_TOO_LARGE', 'MACHINES_UNAVAILABLE') then
			raise exception '%', v_admission ->> 'reason' using errcode = 'P0F10'; end if;
	exception when sqlstate 'P0F10' then
		return jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'refused', 'reason', sqlerrm);
	end;
	select * into strict v_machine from public.qorpera_company_machines where id = v_machine.id;
	return jsonb_build_object('schema', 'qorpera.member-agent-computer/v1', 'state', 'started',
		'machine', jsonb_build_object('machineId', v_machine.id, 'name', v_machine.name,
			'state', public.qorpera_company_machine_state(v_machine)));
end
$$;
revoke all on function public.qorpera_member_start_agent_computer(uuid, uuid)
	from public, anon, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_member_start_agent_computer(uuid, uuid) to authenticated;

-- 3. A save through the folder view of a machine no run started ---------------------------------------------------------------

-- The detached test machine's check (20260930420000) of what a run may have put on the disk: the starter's run for a
-- machine an agent started (as it was); every run with a command on this disk for one a member started.
do $$ begin execute pg_temp.member_agent_computer_patched(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	array[$old$		elsif v_view.kind = 'test_machine' then
			-- 20260930420000: a detached test machine: what its starter's run read may be on the disk.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, (select machine.started_by_run_id
					from public.qorpera_company_machines machine where machine.id = v_view.company_machine_id)));$old$,
	$new$		elsif v_view.kind = 'test_machine' then
			-- 20260930420000: a detached test machine: what its starter's run read may be on the disk.
			-- 20260930730000: a machine a member started has no starter run; what a run read reaches its disk through the
			-- commands the run started there, so each run with a command on this disk is checked as a starter is, in id order.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, reader.run_id))
			from (select machine.started_by_run_id as run_id from public.qorpera_company_machines machine
					where machine.id = v_view.company_machine_id and machine.started_by_run_id is not null
				union
				select command.run_id from public.qorpera_company_machine_commands command
				join public.qorpera_company_machines machine on machine.id = command.machine_id
				where command.machine_id = v_view.company_machine_id and command.placement_id = v_view.placement_id
					and machine.started_by_run_id is null
				order by 1) reader;$new$]); end $$;

-- 4. The idle rule for a machine no run started -------------------------------------------------------------------------------

do $$ begin execute pg_temp.member_agent_computer_patched(
	'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)'::regprocedure,
	array[$old$	if p_busy then update public.qorpera_company_machines set last_used_at = clock_timestamp(), busy_at = clock_timestamp()
		where id = v_machine.id; end if; -- 20260930181000$old$,
	$new$	-- 20260930730000: a machine no run started has no starting conversation for the busy check-in to ask: busy moves its
	-- last use only while a command whose conversation is asked runs on this placement, so it sleeps without use.
	if p_busy then update public.qorpera_company_machines set busy_at = clock_timestamp(),
		last_used_at = case when started_by_run_id is not null or exists (select 1
			from public.qorpera_company_machine_commands command where command.machine_id = v_machine.id
				and command.placement_id = v_placement.id and command.ended_at is null and command.conversation_run_id is not null)
			then clock_timestamp() else last_used_at end
		where id = v_machine.id; end if; -- 20260930181000$new$]); end $$;

-- 5. The deploy guard: every new or patched body carries the marker, and the patched ones keep theirs ------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_member_start_agent_computer(uuid,uuid)',
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930730000') = 0 then
			raise exception '20260930730000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure), '20260930420000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_record_company_machine_commands(uuid,text,text,text,uuid,jsonb,boolean)'::regprocedure),
			'20260930181000') = 0 then
		raise exception '20260930730000: a patched body lost its earlier marker'; end if;
end $guard$;

drop function pg_temp.member_agent_computer_patched(regprocedure, text[]);
