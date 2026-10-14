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
declare v_root public.qorpera_company_path_resources%rowtype;
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
