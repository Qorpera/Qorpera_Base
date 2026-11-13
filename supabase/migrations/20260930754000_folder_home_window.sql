-- The agent's home: a folder window per run (slice 3 of lanes/agent-box-20261113/HOME-PLAN.md). A home is a company
-- machine on which the model works with its own shell and file tools; P1 found that a write through its mount becomes a
-- folder version but is credited to the run that started the machine, and that the mount shows the company-wide view
-- rather than the run's. This migration builds the window that fixes both.
--
-- 1. The window (view kind home_window): one view that belongs to exactly one run, on one home machine's placement and
--    boot. Its machine_id is the placement's id, as a test machine's is. One open window per machine and run; a company-
--    wide view of the same machine (test_machine) still has one open view per machine of its own, and opening it closes
--    the windows.
-- 2. It resolves through its own run, never company-wide and never detached: everything it lists, reads and releases is
--    decided for the run's own read rights (qorpera_folder_actor_allowed through qorpera_folder_run_resolve), and every
--    read released under it is recorded as that run's read, as a read through the run's own tools is. So the home shows
--    the run's folder, not the company's, and a read outside the run's rights fails in the folder service.
-- 3. The calls (qorpera_folder_home_calls): the relay opens one per native call on the window, naming the call's own
--    run operation receipt (logical key "home_call:…"), and closes it when the call ends. A change the window saves
--    while a call is open carries that call id in its unit's credits, and the commit records them (credits), so the
--    change is credited to the command that made it and carries that command's receipt, as a write through machine_run
--    does. A change with no call open is the run's own alone and credits nothing.
-- 4. A window opens only on a disk that has never held the company-wide view and was never used without the folder
--    check: otherwise the disk may hold bytes this run may not read, and the refusal says so in plain words
--    ("qorpera.home-window/new-disk"), so the session is not started.
--
-- What it does NOT change: a test machine's own company-wide view, its command windows and its credits (20260930420000,
-- 20260930421000) work exactly as before; the credit blocks of qorpera_folder_commit are narrowed to that kind and the
-- window gets its own.
--
-- Exact-text patches: each fails unless the function has the text given exactly once; a function with several patches
-- is replaced once, after the last. Body marker "20260930754000".

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_folder_home_calls') is not null then
		raise exception 'Home folder windows (20260930754000) are already applied'; end if;
end $$;

create temporary table folder_home_window_defs (fn regprocedure not null, def text not null);
create function pg_temp.folder_home_window_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text;
begin
	select def into v_definition from pg_temp.folder_home_window_defs where fn = p_function;
	if v_definition is null then
		v_definition := pg_get_functiondef(p_function);
		insert into pg_temp.folder_home_window_defs(fn, def) values (p_function, v_definition);
	end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	update pg_temp.folder_home_window_defs set def = replace(v_definition, p_old, p_new) where fn = p_function;
end
$patch$;
create function pg_temp.folder_home_window_apply() returns void language plpgsql as $apply$
declare v_fn regprocedure; v_def text; v_context text;
begin
	for v_fn, v_def in select fn, def from pg_temp.folder_home_window_defs loop
		begin
			execute v_def;
		exception when others then
			-- A short message: the statement's own text would be the whole function.
			get stacked diagnostics v_context = pg_exception_context;
			raise exception '% does not compile after the patches: % (%)', v_fn, sqlerrm, split_part(v_context, E'\n', 1);
		end;
	end loop;
	drop table pg_temp.folder_home_window_defs;
end
$apply$;

-- 1. The window -------------------------------------------------------------------------------------------------------

alter table public.qorpera_folder_views drop constraint qorpera_folder_views_kind_check,
	add constraint qorpera_folder_views_kind_check check (kind in ('run_box','computer_desktop','computer_shell_command',
		'coding_session','test_machine','code_host','home_window')),
	drop constraint qorpera_folder_views_built_kind,
	add constraint qorpera_folder_views_built_kind check (kind in ('run_box','computer_desktop','computer_shell_command',
		'coding_session','test_machine','code_host','home_window')),
	-- A window names its run, its machine, its placement (also its machine_id) and the boot it was opened for. It carries
	-- no job, runner or lease of its own: its run's job decides whether it stands (qorpera_folder_view_valid), and a run
	-- box of the same job keeps its own one-open-view index.
	add constraint qorpera_folder_views_home_window check (kind <> 'home_window' or (run_id is not null
		and company_machine_id is not null and placement_id is not null and boot_id is not null
		and machine_id = placement_id and job_id is null and runner_id is null and client_lease_id is null
		and screen_id is null and screen_generation is null and activation_id is null and holder_run_id is null
		and holder_user_id is null and worker_id is null and attachment_token is null and shell_command_id is null)),
	drop constraint qorpera_folder_views_test_machine_kind,
	add constraint qorpera_folder_views_test_machine_kind check (kind in ('test_machine','home_window')
		or (company_machine_id is null and placement_id is null and boot_id is null));

-- One open company-wide view per machine, as before, and one open window per machine and run beside it.
drop index qorpera_folder_views_open_test_machine;
create unique index qorpera_folder_views_open_test_machine on public.qorpera_folder_views (company_machine_id)
	where state = 'open' and kind = 'test_machine';
create unique index qorpera_folder_views_open_home_window on public.qorpera_folder_views (company_machine_id, run_id)
	where state = 'open' and kind = 'home_window';

-- A commit may name a window, and a window's commit may credit its calls.
alter table public.qorpera_folder_commits drop constraint qorpera_folder_commits_view_kind_check,
	add constraint qorpera_folder_commits_view_kind_check check (view_kind in ('run_box','computer_desktop',
		'computer_shell_command','coding_session','test_machine','code_host','home_window')),
	drop constraint qorpera_folder_commits_credits,
	-- coalesce: a commit with no view (the platform's, a member's) credits nothing, as before.
	add constraint qorpera_folder_commits_credits check (credits is null
		or (coalesce(view_kind, '') in ('test_machine','home_window') and cardinality(credits) > 0
			and array_position(credits, null) is null));

-- 3. The calls ---------------------------------------------------------------------------------------------------------

-- One row per native call on a window: its id is the call's own run operation receipt (logical key "home_call:…"), so a
-- change credited to the call carries that receipt, as a machine command's id is its machine_run receipt. No foreign key
-- to the receipt: a receipt removed with its run leaves the call's history. The view's row goes with the view.
create table public.qorpera_folder_home_calls (
	call_id uuid primary key,
	view_id uuid not null references public.qorpera_folder_views(id) on delete cascade,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	run_id uuid not null,
	staff_agent_id uuid not null,
	requested_by_user_id uuid not null,
	command_head text not null check (char_length(command_head) between 1 and 300),
	started_at timestamptz not null default clock_timestamp(),
	ended_at timestamptz
);
-- The calls open on a window, in start order: the credits are read by this index.
create index qorpera_folder_home_calls_open on public.qorpera_folder_home_calls (view_id, started_at, call_id)
	where ended_at is null;
alter table public.qorpera_folder_home_calls enable row level security;
revoke all on public.qorpera_folder_home_calls from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The window stands, acts and resolves ---------------------------------------------------------------------------

-- Valid while its run's job is leased and its placement is not removed and still runs the view's boot. It needs no
-- company-wide read right: it shows its run's own folder.
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$old$,
	$new$		-- 20260930754000: a home window stands while its run's job is leased and its placement is not removed and
		-- still runs the view's boot. A retired placement keeps it, for the final publish, which closes it.
		when 'home_window' then exists (select 1 from public.qorpera_runner_jobs j
				join public.qorpera_execution_runs r on r.id = j.run_id
				where r.id = p_view.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp())
			and exists (select 1 from public.qorpera_company_machine_placements p
				where p.id = p_view.placement_id and p.machine_id = p_view.company_machine_id and p.removed_at is null
					and p.boot_id = p_view.boot_id)
		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs$new$);

-- It acts through its own run, while that run's job is leased.
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
	$old$		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$old$,
	$new$		-- 20260930754000: a home window acts through its own run, while that run's job is leased.
		when 'home_window' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,
				'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
			from public.qorpera_execution_runs r
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where r.id = p_view.run_id and j.status = 'leased' and j.lease_expires_at > clock_timestamp())
		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,$new$);

-- It resolves as its run, with the run's own read rights: never company-wide (companyWide stays false) and never
-- detached (a window with no live run has ended).
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	if v_view.kind = 'run_box' or (v_view.kind in ('computer_desktop','computer_shell_command','test_machine') -- 20260930420000
			and v_run is not null) then$old$,
	$new$	if v_view.kind = 'run_box' or (v_view.kind in ('computer_desktop','computer_shell_command','test_machine', -- 20260930420000
			'home_window') -- 20260930754000
			and v_run is not null) then$new$);
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
	$old$	-- Detached: a desktop, a command (20260930183000) or a test machine (20260930420000) whose run has ended, or a
	-- coding session. The agent and member must still stand.$old$,
	$new$	-- 20260930754000: a home window is its run's and never acts detached: its run's lease lapsed between the two
	-- reads above, and the window has ended.
	if v_view.kind = 'home_window' then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	-- Detached: a desktop, a command (20260930183000) or a test machine (20260930420000) whose run has ended, or a
	-- coding session. The agent and member must still stand.$new$);

-- 1. The open ----------------------------------------------------------------------------------------------------------

select pg_temp.folder_home_window_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	v_had_view boolean := false; -- 20260930420000
$old$,
	$new$	v_had_view boolean := false; -- 20260930420000
	v_home_machine public.qorpera_company_machines%rowtype; -- 20260930754000
	v_home_placement public.qorpera_company_machine_placements%rowtype;
$new$);
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine','code_host') -- 20260930420000, 20260930446000$old$,
	$new$	if p_kind not in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine','code_host',
		'home_window') -- 20260930420000, 20260930446000, 20260930754000$new$);

-- A window of its own, like a run box: the run actor opens it, under the run check (pause, job KEY SHARE, fence,
-- principals), and it takes its agent, member and worker access from that resolution, so it can never be wider than the
-- run. An advisory lock on the machine and the run serialises this run's opens on this machine, so a second open sees
-- the first one's view; the machine and the placement are read plainly, and every later renew and commit checks the
-- boot again (qorpera_folder_view_valid, the commit's anchor step) under the machine and placement rows. It carries no
-- read set: the run's own read set, which its releases fill, is the one that counts.
select pg_temp.folder_home_window_patch('public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	if p_opener is distinct from '{"kind":"platform"}'::jsonb then
		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;$old$,
	$new$	-- 20260930754000: the run's own window on its home machine.
	if p_kind = 'home_window' then
		if jsonb_typeof(p_opener) is distinct from 'object' or p_opener ->> 'kind' is distinct from 'run'
			or p_opener - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
			or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
				where coalesce(p_opener ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
			raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;
		if p_anchor - array['companyMachineId','placementId','bootId'] <> '{}'::jsonb
			or exists (select 1 from unnest(array['companyMachineId','placementId','bootId']) f(name)
				where coalesce(p_anchor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
			raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		perform pg_advisory_xact_lock(hashtextextended('qorpera.home-window:' || (p_anchor ->> 'companyMachineId')
			|| ':' || coalesce(p_opener ->> 'runId', ''), 0));
		v_resolved := public.qorpera_folder_run_enter(p_environment_id, v_file.profile_id, p_opener);
		select * into v_home_machine from public.qorpera_company_machines where id = (p_anchor ->> 'companyMachineId')::uuid;
		select * into v_home_placement from public.qorpera_company_machine_placements
		where id = (p_anchor ->> 'placementId')::uuid;
		-- coalesce: a missing row must refuse, not compare to null.
		if not coalesce(v_home_machine.environment_id = p_environment_id and v_home_machine.removed_at is null
				and v_home_machine.desired_state = 'running' and v_home_placement.machine_id = v_home_machine.id
				and v_home_placement.retired_at is null and v_home_placement.removed_at is null
				and v_home_placement.running_at is not null and v_home_placement.boot_id = (p_anchor ->> 'bootId')::uuid
				and public.qorpera_company_machine_placement_reserved(v_home_placement.id), false) then
			raise exception 'Folder view machine is not current' using errcode = '42501'; end if;
		-- A disk that has held the company-wide view, or that a command used before any view, may hold bytes this run may
		-- not read; a window on it would show the run's folder while the shell saw more. The agent needs a fresh home.
		if v_home_placement.folder_unchecked_at is not null
			or exists (select 1 from public.qorpera_folder_views v
				where v.placement_id = v_home_placement.id and v.kind = 'test_machine') then
			raise exception 'This machine has held the company-wide folder' using errcode = '42501',
				detail = 'qorpera.home-window/new-disk'; end if;
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'superseded'
		where state = 'open' and kind = 'home_window' and company_machine_id = v_home_machine.id
			and run_id = (p_opener ->> 'runId')::uuid;
		insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id,
			worker_access, run_id, company_machine_id, placement_id, boot_id, machine_id, pass_sha256, lease_until)
		values (p_environment_id, v_file.profile_id, 'home_window', (v_resolved ->> 'staffAgentId')::uuid,
			(v_resolved ->> 'requesterUserId')::uuid, v_resolved ->> 'workerAccess', (p_opener ->> 'runId')::uuid,
			v_home_machine.id, v_home_placement.id, v_home_placement.boot_id, v_home_placement.id,
			extensions.digest(v_pass, 'sha256'), clock_timestamp() + interval '120 seconds')
		returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,
			'leaseUntil',v_view.lease_until);
	end if;

	if p_opener is distinct from '{"kind":"platform"}'::jsonb then
		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;$new$);

-- 3. The commit: a window's credits ------------------------------------------------------------------------------------

-- A window publishes a final change set, as a command's and a test machine's view do: its last boundary closes it.
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_final and coalesce(v_view_early -> 'view' ->> 'kind' not in ('computer_shell_command','test_machine'), true)
		then -- 20260930183000, 20260930420000
			raise exception 'Only a command or test machine view publishes a final change set' using errcode = '22023'; end if;$old$,
	$new$		if v_final and coalesce(v_view_early -> 'view' ->> 'kind'
				not in ('computer_shell_command','test_machine','home_window'), true)
		then -- 20260930183000, 20260930420000, 20260930754000
			raise exception 'Only a command, test machine or home window view publishes a final change set'
				using errcode = '22023'; end if;$new$);
-- Credits come from a test machine's view and from a window (20260930754000).
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_credits_unit is not null and v_view_early -> 'view' ->> 'kind' is distinct from 'test_machine' then
			raise exception 'Change set unit % is invalid', v_credits_unit using errcode = '22023'; end if;$old$,
	$new$		if v_credits_unit is not null and coalesce(v_view_early -> 'view' ->> 'kind'
				not in ('test_machine','home_window'), true) then -- 20260930754000
			raise exception 'Change set unit % is invalid', v_credits_unit using errcode = '22023'; end if;$new$);

-- The job locks of 20260930421000 step 7 are a test machine's: a window's credited calls are its own run's, whose job is
-- already locked as the view's live run.
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_credits_unit is not null then
			select coalesce(array_agg(distinct r.job_id), '{}') into v_job_locks$old$,
	$new$		if v_credits_unit is not null and v_view_early -> 'view' ->> 'kind' = 'test_machine' then -- 20260930754000
			select coalesce(array_agg(distinct r.job_id), '{}') into v_job_locks$new$);

-- The credited commands of a test machine stay as they were; a window's credited calls are read beside them: each call
-- open on this window, with the view's own agent and member (a window is its run's, so no unit changes the commit's
-- attribution and the authority loop below checks the same principals again), in start order.
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_credits_unit is not null then
		select coalesce(jsonb_object_agg(c.id::text, jsonb_build_object('staffAgentId', c.staff_agent_id,$old$,
	$new$	if v_credits_unit is not null and v_view.kind = 'home_window' then -- 20260930754000
		select coalesce(jsonb_object_agg(h.call_id::text, jsonb_build_object('staffAgentId', h.staff_agent_id,
				'requesterUserId', h.requested_by_user_id, 'runId', v_resolved ->> 'runId', 'stands', true)), '{}'::jsonb),
			coalesce(array_agg(h.call_id order by h.started_at, h.call_id), '{}')
		into v_credits, v_credit_ids
		from public.qorpera_folder_home_calls h
		where h.view_id = v_view.id and h.ended_at is null
			and h.call_id in (select x.id::uuid from jsonb_array_elements(p_units) u
				cross join lateral jsonb_array_elements_text(u.value -> 'credits') x(id));
		v_starter_auth := v_auth_actor;
	elsif v_credits_unit is not null then
		select coalesce(jsonb_object_agg(c.id::text, jsonb_build_object('staffAgentId', c.staff_agent_id,$new$);

-- A window's credits carry "stands" already: the staff recheck of 20260930421000 step 3 is a test machine's.
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_credits_unit is not null then
		select coalesce(jsonb_object_agg(e.key, e.value || jsonb_build_object('stands', exists (select 1$old$,
	$new$	if v_credits_unit is not null and v_view.kind = 'test_machine' then -- 20260930754000
		select coalesce(jsonb_object_agg(e.key, e.value || jsonb_build_object('stands', exists (select 1$new$);

-- The anchor step: the machine, then the placement, as a test machine's (a new boot, a retirement and a removal wait for
-- them), and a saved unit whose credited call ended while this commit waited refuses the commit.
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		elsif v_view.kind = 'test_machine' then
			-- 20260930420000: the machine, then the placement, which a new boot, a retirement and a removal (the
			-- executor's custody, FOR UPDATE) wait for.$old$,
	$new$		elsif v_view.kind in ('test_machine','home_window') then -- 20260930754000
			-- 20260930420000: the machine, then the placement, which a new boot, a retirement and a removal (the
			-- executor's custody, FOR UPDATE) wait for.$new$);
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$		if v_view.kind = 'test_machine' and exists (select 1 from jsonb_array_elements(v_outcomes) o
			cross join lateral jsonb_array_elements_text(p_units -> ((o.value ->> 'unit')::integer - 1) -> 'credits') c(id)
			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_company_machine_commands m
				where m.id = c.id::uuid and m.ended_at is null)) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;$old$,
	$new$		if v_view.kind = 'test_machine' and exists (select 1 from jsonb_array_elements(v_outcomes) o
			cross join lateral jsonb_array_elements_text(p_units -> ((o.value ->> 'unit')::integer - 1) -> 'credits') c(id)
			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_company_machine_commands m
				where m.id = c.id::uuid and m.ended_at is null)) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;
		-- 20260930754000: the same for a window, against its calls.
		if v_view.kind = 'home_window' and exists (select 1 from jsonb_array_elements(v_outcomes) o
			cross join lateral jsonb_array_elements_text(p_units -> ((o.value ->> 'unit')::integer - 1) -> 'credits') c(id)
			where o.value ->> 'outcome' = 'saved' and not exists (select 1 from public.qorpera_folder_home_calls h
				where h.call_id = c.id::uuid and h.view_id = v_view.id and h.ended_at is null)) then
			raise exception 'Folder view command has ended' using errcode = '42501'; end if;$new$);
select pg_temp.folder_home_window_patch('public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	$old$	if v_view.kind in ('computer_shell_command','test_machine') then -- 20260930420000
		if v_final then$old$,
	$new$	if v_view.kind in ('computer_shell_command','test_machine','home_window') then -- 20260930420000, 20260930754000
		if v_final then$new$);
select pg_temp.folder_home_window_apply();

-- 1. The run asks for its window -----------------------------------------------------------------------------------------

-- The run's own entry point (G2's native host calls, scope folder): the relay asks for the window before it starts a
-- session on the home, and names it to the home. `p_request` is {machineId}: the agent's own machine. The machine's
-- current placement and its boot are read here, so the caller never names them. An expected refusal is an answer, not an
-- error, so the relay can tell the model in plain words and not start the session.
create function public.qorpera_folder_home_window_open(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype; v_view jsonb; -- 20260930754000
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run'
		or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
		or jsonb_typeof(p_request) is distinct from 'object' or p_request - array['machineId'] <> '{}'::jsonb
		or coalesce(p_request ->> 'machineId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	-- The run's leased job, read plainly before any lock; the open checks it again under its locks.
	if not exists (select 1 from public.qorpera_runner_jobs j where j.id = (p_actor ->> 'jobId')::uuid
			and j.run_id = (p_actor ->> 'runId')::uuid and j.environment_id = p_environment_id and j.status = 'leased'
			and j.runner_id = (p_actor ->> 'runnerId')::uuid and j.client_lease_id = (p_actor ->> 'assignmentId')::uuid
			and j.lease_expires_at > clock_timestamp()) then
		raise exception 'Folder run is not current' using errcode = '42501'; end if;
	select * into v_machine from public.qorpera_company_machines where id = (p_request ->> 'machineId')::uuid
		and environment_id = p_environment_id and removed_at is null;
	if not found then return jsonb_build_object('schema','qorpera.folder-home-window/v1','state','refused',
		'reason','MACHINE_NOT_FOUND'); end if;
	select * into v_placement from public.qorpera_company_machine_placements where machine_id = v_machine.id
		and retired_at is null and removed_at is null and running_at is not null
	order by running_at desc, id desc limit 1;
	if not found or v_machine.desired_state <> 'running'
		or not public.qorpera_company_machine_placement_reserved(v_placement.id) then
		return jsonb_build_object('schema','qorpera.folder-home-window/v1','state','refused',
			'reason','MACHINE_NOT_RUNNING'); end if;
	if v_placement.folder_unchecked_at is not null or exists (select 1 from public.qorpera_folder_views v
			where v.placement_id = v_placement.id and v.kind = 'test_machine') then
		return jsonb_build_object('schema','qorpera.folder-home-window/v1','state','refused',
			'reason','MACHINE_HELD_COMPANY_FOLDER'); end if;
	v_view := public.qorpera_folder_view_open(p_environment_id, p_actor, 'home_window',
		jsonb_build_object('companyMachineId', v_machine.id, 'placementId', v_placement.id,
			'bootId', v_placement.boot_id));
	return jsonb_build_object('schema','qorpera.folder-home-window/v1','state','open',
		'viewId', v_view -> 'viewId', 'pass', v_view -> 'pass', 'leaseUntil', v_view -> 'leaseUntil',
		'machineId', v_machine.id, 'placementId', v_placement.id, 'bootId', v_placement.boot_id);
end $$;
revoke all on function public.qorpera_folder_home_window_open(uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_home_window_open(uuid, jsonb, jsonb) to service_role;

-- 3. The run opens and ends a call on its window -------------------------------------------------------------------------

-- A native call starts: what the window saves from now until the call ends carries the call's id in its credits.
-- `p_request` is {viewId, callId, commandHead}. The call id is the call's own run operation receipt, which the run began
-- before it asked (logical key "home_call:…"), so the change the call makes carries that receipt. Sent again with the
-- same ids it changes nothing.
create function public.qorpera_folder_home_call_open(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype; v_view public.qorpera_folder_views%rowtype;
	v_resolved jsonb; v_receipt public.qorpera_run_operation_receipts%rowtype; -- 20260930754000
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run'
		or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['viewId','callId','commandHead'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['viewId','callId']) f(name)
			where coalesce(p_request ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
		or char_length(coalesce(p_request ->> 'commandHead', '')) not between 1 and 300 then
		raise exception 'Folder call is invalid' using errcode = '22023'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_resolved := public.qorpera_folder_run_resolve(p_environment_id, v_file.profile_id, p_actor);
	-- The window, FOR KEY SHARE: closing and superseding it (FOR UPDATE) wait for this call.
	select * into v_view from public.qorpera_folder_views where id = (p_request ->> 'viewId')::uuid
		and environment_id = p_environment_id and kind = 'home_window' and state = 'open'
		and run_id = (p_actor ->> 'runId')::uuid for key share;
	if not found or not public.qorpera_folder_view_valid(v_view) then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	-- The call's own receipt: this run's, a cloud tool's, under the home_call key, and not yet resolved against another
	-- change. One receipt, one call, as machine_run's receipt is its command's id.
	select * into v_receipt from public.qorpera_run_operation_receipts where id = (p_request ->> 'callId')::uuid
		and run_id = (p_actor ->> 'runId')::uuid and operation_kind = 'cloud_tool'
		and left(logical_operation_key, length('home_call:')) = 'home_call:' and status in ('executing','completed');
	if not found then raise exception 'Folder call needs its own receipt' using errcode = '42501'; end if;
	insert into public.qorpera_folder_home_calls(call_id, view_id, environment_id, run_id, staff_agent_id,
		requested_by_user_id, command_head)
	values ((p_request ->> 'callId')::uuid, v_view.id, p_environment_id, (p_actor ->> 'runId')::uuid,
		(v_resolved ->> 'staffAgentId')::uuid, (v_resolved ->> 'requesterUserId')::uuid, p_request ->> 'commandHead')
	on conflict (call_id) do nothing;
	if not exists (select 1 from public.qorpera_folder_home_calls where call_id = (p_request ->> 'callId')::uuid
			and view_id = v_view.id and run_id = (p_actor ->> 'runId')::uuid) then
		raise exception 'Folder call belongs to another window' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.folder-home-call/v1','state','open','callId',p_request ->> 'callId');
end $$;
revoke all on function public.qorpera_folder_home_call_open(uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_home_call_open(uuid, jsonb, jsonb) to service_role;

-- The call ended: its window closes it, and what the window saves from now on no longer carries it. Sent again it
-- changes nothing, and an unknown call is answered as ended: the relay never waits on it.
create function public.qorpera_folder_home_call_end(p_environment_id uuid, p_actor jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_ended timestamptz; -- 20260930754000
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_actor) is distinct from 'object' or p_actor ->> 'kind' is distinct from 'run'
		or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or jsonb_typeof(p_request) is distinct from 'object' or p_request - array['viewId','callId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['viewId','callId']) f(name)
			where coalesce(p_request ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder call is invalid' using errcode = '22023'; end if;
	update public.qorpera_folder_home_calls set ended_at = clock_timestamp()
	where call_id = (p_request ->> 'callId')::uuid and view_id = (p_request ->> 'viewId')::uuid
		and environment_id = p_environment_id and run_id = (p_actor ->> 'runId')::uuid and ended_at is null
	returning ended_at into v_ended;
	return jsonb_build_object('schema','qorpera.folder-home-call/v1','state','ended','callId',p_request ->> 'callId',
		'closedNow', v_ended is not null);
end $$;
revoke all on function public.qorpera_folder_home_call_end(uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_folder_home_call_end(uuid, jsonb, jsonb) to service_role;

-- G2: the three are listed for the native host with scope folder, so the run's own box may make them for its own run.
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_home_window_open', 'folder'),
	('qorpera_folder_home_call_open', 'folder'),
	('qorpera_folder_home_call_end', 'folder');

-- The patched and new functions may have a private owner in production: it reaches what their text uses. Row locks need
-- UPDATE as well as SELECT.
do $$ declare v_owner name; begin
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
		'public.qorpera_folder_home_window_open(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_folder_home_call_open(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_folder_home_call_end(uuid,jsonb,jsonb)'::regprocedure)) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Home window function has an API owner'; end if;
	end loop;
	-- The window's valid check reads the run's job; the commit and the open read the calls and the machine rows.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_runner_jobs, public.qorpera_execution_runs, '
				'public.qorpera_company_machine_placements to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_folder_home_calls to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_home_call_open(uuid,jsonb,jsonb)'::regprocedure,
		'public.qorpera_folder_home_call_end(uuid,jsonb,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select, insert, update on public.qorpera_folder_home_calls to %I', v_owner);
			execute format('grant select on public.qorpera_company_files, public.qorpera_folder_views, '
				'public.qorpera_run_operation_receipts to %I', v_owner);
			execute format('grant execute on function public.qorpera_folder_run_resolve(uuid, uuid, jsonb), '
				'public.qorpera_folder_view_valid(public.qorpera_folder_views) to %I', v_owner);
		end if;
	end loop;
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_home_window_open(uuid,jsonb,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select on public.qorpera_company_files, public.qorpera_company_machines, '
				'public.qorpera_company_machine_placements, public.qorpera_folder_views, '
				'public.qorpera_runner_jobs to %I', v_owner);
			execute format('grant execute on function public.qorpera_folder_view_open(uuid, jsonb, text, jsonb), '
				'public.qorpera_company_machine_placement_reserved(uuid) to %I', v_owner);
		end if;
	end loop;
	-- The open takes the run entry and reads the machine rows; the window's row lock needs UPDATE.
	foreach v_owner in array array(select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure)) loop
		if v_owner is distinct from current_user then
			execute format('grant select, update on public.qorpera_folder_views to %I', v_owner);
		end if;
	end loop;
end $$;
