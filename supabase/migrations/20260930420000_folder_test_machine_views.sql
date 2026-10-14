-- Test machine views: F3 step 6, slice 6a, part 1 (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md), which builds
-- the test_machine kind of C1b-3b (RUNTIME-COMPANY-FOLDER-C1B.md "C1b-3: views"). A company machine's boot sees the
-- company folder through one view of its own, opened by the platform (the machine executor) for the starter.
-- 1. The view, kind test_machine: its machine, placement and boot, set exactly for that kind. One open view per
--    machine. Its machine_id is the placement's id (the placement is the machine's allocation and names its instance).
-- 2. The open, for the boot the executor just recorded: the machine fence, the machine's older views, then the machine
--    and its placement FOR SHARE. The view names the starter's agent and member, who must both read the company folder's
--    root now; it acts through the starter's run while that run's job is leased, then detached as the agent (in_house),
--    company-wide as a desktop. It carries the read set of the placement's newest view: the read set lives with the disk.
-- 3. Valid while the placement is not removed, the placement still runs the view's boot and the starter's agent and
--    member still read the root. A retired placement keeps it, for the final publish ("final": true), which closes it.
-- 4. Access, on the disk's whole life: once a placement has had a view, on any boot, every machine command there
--    (start, read, cancel) needs the caller's agent and member to read the root now. A placement that never had one keeps
--    today's access, and its first command started marks it as used without that check (folder_unchecked_at; every
--    placement made before this counts as used). Such a disk never gets a view: the open refuses it for that reason, and
--    refuses for the starter's authority on a placement that had a view; both say "qorpera.test-machine/new-disk", which
--    tells the executor to move the machine to a new disk.
-- Credits per unit (part 2), the read set's fan-out to the commands' runs and the take-in (part 3) and the crashed
-- service refusal (part 4, on 5a's served_by) come later.
--
-- Exact-text patch: it fails unless the function has the text given exactly once. Body marker "20260930420000".

set local lock_timeout = '3s';

do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_folder_views'::regclass
		and attname = 'company_machine_id' and not attisdropped) then
		raise exception 'Test machine views (20260930420000) are already applied'; end if;
end $$;

create function pg_temp.folder_test_machine_views_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- Whether a company's agent and member both read its folder's root now: the company-wide view. Internal.
create function public.qorpera_folder_reads_root(p_environment_id uuid, p_profile_id uuid, p_staff_agent_id uuid,
	p_member_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_root public.qorpera_company_path_resources%rowtype; -- 20260930420000
begin
	select * into v_root from public.qorpera_company_path_resources where environment_id = p_environment_id and path = '';
	return coalesce(public.qorpera_folder_principal_allowed(p_profile_id, v_root, 'member', p_member_user_id, 'read')
		and public.qorpera_folder_principal_allowed(p_profile_id, v_root, 'staff_agent', p_staff_agent_id, 'read'), false);
end $$;
revoke all on function public.qorpera_folder_reads_root(uuid, uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 1. The view ---------------------------------------------------------------------------------------------------------

-- A test machine's view: its machine, its placement (the disk; also its machine_id) and the boot it was opened for.
-- No foreign keys: a removed machine's rows go, and the view's history stays.
alter table public.qorpera_folder_views add column company_machine_id uuid, add column placement_id uuid,
	add column boot_id uuid;
alter table public.qorpera_folder_views drop constraint qorpera_folder_views_built_kind,
	add constraint qorpera_folder_views_built_kind
		check (kind in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine')),
	add constraint qorpera_folder_views_test_machine check (kind <> 'test_machine' or (company_machine_id is not null
		and placement_id is not null and boot_id is not null and machine_id = placement_id and run_id is null
		and job_id is null and runner_id is null and client_lease_id is null and screen_id is null
		and screen_generation is null and activation_id is null and holder_run_id is null and holder_user_id is null
		and worker_id is null and attachment_token is null and shell_command_id is null)),
	add constraint qorpera_folder_views_test_machine_kind check (kind = 'test_machine'
		or (company_machine_id is null and placement_id is null and boot_id is null));
-- One open view per machine.
create unique index qorpera_folder_views_open_test_machine on public.qorpera_folder_views (company_machine_id)
	where state = 'open';
-- A placement's views, newest first: the open carries the newest one's read set, and the access check asks whether
-- the placement ever had one.
create index qorpera_folder_views_placement_history on public.qorpera_folder_views (placement_id, created_at desc)
	where placement_id is not null;

-- When a command first ran on the placement without the root-read check (it never had a view then). Every placement
-- made before this counts as used.
alter table public.qorpera_company_machine_placements add column folder_unchecked_at timestamptz;
update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp();

-- 3. Valid while its placement is not removed and runs its boot, and the starter's agent and member read the root.
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$old$,
	$new$		-- 20260930420000: a test machine's view stands while its placement is not removed and still runs the view's
		-- boot, and the starter's agent and member still read the root. A retired placement keeps it, for the final
		-- publish, which closes it.
		when 'test_machine' then exists (select 1 from public.qorpera_company_machine_placements p
				where p.id = p_view.placement_id and p.machine_id = p_view.company_machine_id and p.removed_at is null
					and p.boot_id = p_view.boot_id)
			and public.qorpera_folder_reads_root(p_view.environment_id, p_view.profile_id, p_view.staff_agent_id,
				p_view.member_user_id)
		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$new$);

-- It acts through the starter's run while the run's job is leased.
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$old$,
	$new$		-- 20260930420000: a test machine acts through its starter's run while the run's job is leased.
		when 'test_machine' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,
				'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
			from public.qorpera_company_machines m
			join public.qorpera_execution_runs r on r.id = m.started_by_run_id
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where m.id = p_view.company_machine_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp())
		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$new$);

-- It resolves as its live run, else detached as the agent; company-wide, as a desktop.
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$		'companyWide', v_view.kind in ('computer_desktop','computer_shell_command'));$old$,
	$new$		'companyWide', v_view.kind in ('computer_desktop','computer_shell_command','test_machine')); -- 20260930420000$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	if v_view.kind = 'run_box' or (v_view.kind in ('computer_desktop','computer_shell_command') and v_run is not null) then$old$,
	$new$	if v_view.kind = 'run_box' or (v_view.kind in ('computer_desktop','computer_shell_command','test_machine') -- 20260930420000
			and v_run is not null) then$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	-- Detached: a desktop or a command (20260930183000) whose run has ended, or a coding session. The agent and member
	-- must still stand.$old$,
	$new$	-- Detached: a desktop, a command (20260930183000) or a test machine (20260930420000) whose run has ended, or a
	-- coding session. The agent and member must still stand.$new$);

-- 2. The open ---------------------------------------------------------------------------------------------------------

select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	v_command public.qorpera_runtime_office_shell_commands%rowtype; -- 20260930183000
$old$,
	$new$	v_command public.qorpera_runtime_office_shell_commands%rowtype; -- 20260930183000
	v_company_machine public.qorpera_company_machines%rowtype; v_placement public.qorpera_company_machine_placements%rowtype;
	v_had_view boolean := false; -- 20260930420000
$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session') -- 20260930183000$old$,
	$new$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine') -- 20260930420000$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	else
		if coalesce(p_anchor ->> 'workerId', '')$old$,
	$new$	elsif p_kind = 'test_machine' then
		-- 20260930420000 (C1b-3b): a company machine's boot that the executor has just recorded: the machine not removed
		-- and meant to run, the anchor's placement its current one, reserved and running the anchor's boot. The machine's
		-- older views first (the open one, and the placement's newest, whose read set this view carries), which waits out
		-- their last save and release; then the machine fence, the machine and the placement FOR SHARE, in custody's
		-- order; then the checks, in new statements. The view names the starter's agent and member.
		if p_anchor - array['companyMachineId','placementId','bootId'] <> '{}'::jsonb
			or exists (select 1 from unnest(array['companyMachineId','placementId','bootId']) f(name)
				where coalesce(p_anchor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
			raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		perform 1 from public.qorpera_folder_views where company_machine_id = (p_anchor ->> 'companyMachineId')::uuid
			and (state = 'open' or id = (select v.id from public.qorpera_folder_views v
				where v.placement_id = (p_anchor ->> 'placementId')::uuid order by v.created_at desc, v.id desc limit 1))
		for update;
		perform public.qorpera_folder_machine_fence(v_file.profile_id);
		perform 1 from public.qorpera_company_machines where id = (p_anchor ->> 'companyMachineId')::uuid for share;
		perform 1 from public.qorpera_company_machine_placements where id = (p_anchor ->> 'placementId')::uuid
			and machine_id = (p_anchor ->> 'companyMachineId')::uuid for share;
		select * into v_company_machine from public.qorpera_company_machines where id = (p_anchor ->> 'companyMachineId')::uuid;
		select * into v_placement from public.qorpera_company_machine_placements where id = (p_anchor ->> 'placementId')::uuid;
		-- coalesce: a missing row must refuse, not compare to null.
		if not coalesce(v_company_machine.environment_id = p_environment_id and v_company_machine.removed_at is null
				and v_company_machine.desired_state = 'running' and v_placement.machine_id = v_company_machine.id
				and v_placement.retired_at is null and v_placement.removed_at is null and v_placement.running_at is not null
				and v_placement.boot_id = (p_anchor ->> 'bootId')::uuid
				and public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
			raise exception 'Folder view machine is not current' using errcode = '42501'; end if;
		v_staff := v_company_machine.started_by_staff_agent_id; v_member := v_company_machine.requested_by_user_id;
		v_access := (public.qorpera_run_worker(v_company_machine.started_by_run_id)).access;
		v_machine := v_placement.id;
		-- The disk's whole life: a command that ran there without the root-read check may have left anything on it, and a
		-- disk that had a view holds what its views read. Either way the executor moves the machine to a new disk.
		v_had_view := exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
		if v_placement.folder_unchecked_at is not null then
			raise exception 'Test machine disk was used without the folder check' using errcode = '42501',
				detail = 'qorpera.test-machine/new-disk'; end if;
		if v_had_view and not (exists (select 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id
					and staff_agent_id = v_staff and employment_status = 'active')
				and exists (select 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_member)
				and public.qorpera_folder_reads_root(p_environment_id, v_file.profile_id, v_staff, v_member)) then
			raise exception 'Folder view needs the company-wide view' using errcode = '42501',
				detail = 'qorpera.test-machine/new-disk'; end if;
	else
		if coalesce(p_anchor ->> 'workerId', '')$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_kind in ('computer_desktop','computer_shell_command') then -- 20260930183000$old$,
	$new$	if p_kind in ('computer_desktop','computer_shell_command','test_machine') then -- 20260930183000, 20260930420000$new$);
-- A test machine carries the read set of its placement's newest view, across boots: it lives with the disk. A new disk
-- starts clean.
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$			or (p_kind = 'coding_session' and v.worker_id = v_session.worker_id))
		order by v.created_at desc, v.id desc limit 1) newest$old$,
	$new$			or (p_kind = 'coding_session' and v.worker_id = v_session.worker_id)
			or (p_kind = 'test_machine' and v.placement_id = v_placement.id)) -- 20260930420000
		order by v.created_at desc, v.id desc limit 1) newest$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$		or (p_kind = 'coding_session' and newest.machine_id = v_machine);$old$,
	$new$		or (p_kind = 'coding_session' and newest.machine_id = v_machine) or p_kind = 'test_machine'; -- 20260930420000$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$		or (p_kind = 'coding_session' and worker_id = v_session.worker_id));$old$,
	$new$		or (p_kind = 'coding_session' and worker_id = v_session.worker_id)
		or (p_kind = 'test_machine' and company_machine_id = v_company_machine.id)); -- 20260930420000$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$		screen_id, screen_generation, activation_id, holder_run_id, holder_user_id, worker_id, attachment_token, node_id, machine_id,
		pass_sha256, lease_until)
	values (p_environment_id, v_file.profile_id, p_kind, v_staff, v_member, v_access,
		v_screen.id, v_screen.generation, v_activation, v_holder_run, v_holder_user, v_session.worker_id, v_session.attachment_token,
		v_node, v_machine, extensions.digest(v_pass, 'sha256'), clock_timestamp() + interval '120 seconds')$old$,
	$new$		screen_id, screen_generation, activation_id, holder_run_id, holder_user_id, worker_id, attachment_token, node_id, machine_id,
		company_machine_id, placement_id, boot_id, pass_sha256, lease_until) -- 20260930420000
	values (p_environment_id, v_file.profile_id, p_kind, v_staff, v_member, v_access,
		v_screen.id, v_screen.generation, v_activation, v_holder_run, v_holder_user, v_session.worker_id, v_session.attachment_token,
		v_node, v_machine, v_company_machine.id, v_placement.id, v_placement.boot_id, extensions.digest(v_pass, 'sha256'),
		clock_timestamp() + interval '120 seconds')$new$);

-- 3. The final publish: a test machine's last boundary before its power-off (6d) says "final" and closes the view, as a
-- command's does. Its anchor is the machine and the placement, FOR SHARE, in custody's order.
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_final and v_view_early -> 'view' ->> 'kind' is distinct from 'computer_shell_command' then -- 20260930183000
			raise exception 'Only a command view publishes a final change set' using errcode = '22023'; end if;$old$,
	$new$		if v_final and coalesce(v_view_early -> 'view' ->> 'kind' not in ('computer_shell_command','test_machine'), true)
		then -- 20260930183000, 20260930420000
			raise exception 'Only a command or test machine view publishes a final change set' using errcode = '22023'; end if;$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$					from public.qorpera_runtime_office_shell_commands command where command.id = v_view.shell_command_id)));
		elsif v_turn_run is not null then$old$,
	$new$					from public.qorpera_runtime_office_shell_commands command where command.id = v_view.shell_command_id)));
		elsif v_view.kind = 'test_machine' then
			-- 20260930420000: a detached test machine: what its starter's run read may be on the disk.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, (select machine.started_by_run_id
					from public.qorpera_company_machines machine where machine.id = v_view.company_machine_id)));
		elsif v_turn_run is not null then$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$			perform 1 from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id for share;
		end if;$old$,
	$new$			perform 1 from public.qorpera_runtime_office_shell_commands where id = v_view.shell_command_id for share;
		elsif v_view.kind = 'test_machine' then
			-- 20260930420000: the machine, then the placement, which a new boot, a retirement and a removal (the
			-- executor's custody, FOR UPDATE) wait for.
			perform 1 from public.qorpera_company_machines where id = v_view.company_machine_id for share;
			perform 1 from public.qorpera_company_machine_placements where id = v_view.placement_id for share;
		end if;$new$);
select pg_temp.folder_test_machine_views_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_view.kind = 'computer_shell_command' then
		if v_final then$old$,
	$new$	if v_view.kind in ('computer_shell_command','test_machine') then -- 20260930420000
		if v_final then$new$);

-- 4. Access, on the disk's whole life -----------------------------------------------------------------------------------

-- Every machine command on a placement that has or had a view needs the caller's agent and member to read the root;
-- a worker's run is checked as its agent. Under the machine row (FOR UPDATE), which the open waits for (FOR SHARE).
select pg_temp.folder_test_machine_views_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;
$old$,
	$new$			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;
	-- 20260930420000: what the disk's views read may be on it, on any boot.
	if exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id)
		and not public.qorpera_folder_reads_root(v_machine.environment_id, v_machine.profile_id,
			(v_identity ->> 'staffAgentId')::uuid, (v_identity ->> 'requesterUserId')::uuid) then
		raise exception 'Machine needs the company-wide view' using errcode = '42501'; end if;
$new$);
-- The first command started on a placement that never had a view marks it used without the check: no view opens there.
select pg_temp.folder_test_machine_views_patch(
	'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure,
	$old$ -- 20260929361500: the member the run works for
			returning * into v_command;
$old$,
	$new$ -- 20260929361500: the member the run works for
			returning * into v_command;
			-- 20260930420000: the open refuses this disk from now on.
			update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
			where id = v_placement.id and folder_unchecked_at is null
				and not exists (select 1 from public.qorpera_folder_views v where v.placement_id = v_placement.id);
$new$);

-- The patched functions may have a private owner in production: it reaches what their new text uses. Row locks need
-- UPDATE as well as SELECT.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Test machine view function has an API owner'; end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_folder_reads_root(uuid, uuid, uuid, uuid) to %I', v_owner);
			execute format('grant select on public.qorpera_company_machine_placements, public.qorpera_folder_views to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_machines to %I', v_owner);
		end if;
	end loop;
	-- The open and the commit take the machine and the placement FOR SHARE.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select, update on public.qorpera_company_machines, '
				'public.qorpera_company_machine_placements to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant execute on function public.qorpera_folder_machine_fence(uuid), '
				'public.qorpera_company_machine_placement_reserved(uuid) to %I', v_owner);
		end if;
	end loop;
	-- The authorization records the unchecked use on the placement.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant update on public.qorpera_company_machine_placements to %I', v_owner);
		end if;
	end loop;
end $$;
