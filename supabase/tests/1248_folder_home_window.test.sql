-- @fixture 510_folder_test_machine_views.test.sql until "-- The migration's marker is in every function it patches"
-- The agent's home: a folder window per run (20260930754000; slice 3 of lanes/agent-box-20261113/HOME-PLAN.md). A home
-- machine mounts a window that belongs to exactly one run: it resolves through that run, so it shows the run's own
-- folder and never the company's, every read released under it is the run's read, and a change it saves while a native
-- call is open carries that call's id in its credits, so the change is credited to the command that made it and to that
-- command's own receipt. A disk that has held the company-wide view takes no window. The office, machine, run and view
-- helpers are 510's, 639's and 632's; the machine command helper is 512's.

create function pg_temp.hw_open(p_anchor jsonb, p_run jsonb) returns jsonb language sql as $$
	select pg_temp.open('home_window', p_anchor, p_run)
$$;
create function pg_temp.hw_not_current(p_anchor jsonb, p_run jsonb) returns void language sql as $$
	select pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', p_anchor, p_run), '42501',
		'Folder view machine is not current')
$$;
-- The run asks for its own window through the native host call, which finds the machine's current placement and boot.
create function pg_temp.hw_ask(p_run jsonb, p_machine uuid) returns jsonb language sql as $$
	select public.qorpera_folder_home_window_open('63200000-0000-4000-8000-000000000020', p_run,
		jsonb_build_object('machineId', p_machine))
$$;
-- A call's own run operation receipt, under the home_call key, as the relay begins one before it asks.
create function pg_temp.hw_receipt(p_run jsonb, p_key text) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_run_operation_receipts(id, run_id, job_id, assignment_id, operation_kind,
		logical_operation_key, input_sha256, downstream_idempotency_sha256, status, requires_company_revision)
	values (v_id, (p_run ->> 'runId')::uuid, (p_run ->> 'jobId')::uuid, (p_run ->> 'assignmentId')::uuid, 'cloud_tool',
		'home_call:' || p_key, repeat('7', 64), repeat('8', 64), 'executing', false);
	set local session_replication_role = origin;
	return v_id;
end $$;
-- 512's: a machine command on the anchor's machine and placement, from the run.
create function pg_temp.cmd(p_anchor jsonb, p_run jsonb, p_started timestamptz) returns uuid language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id,
		command_head, notify, started_at, sent_at, requested_by_user_id)
	select v_id, (p_anchor ->> 'companyMachineId')::uuid, r.id, r.staff_agent_id, (p_anchor ->> 'placementId')::uuid,
		'npm test', false, p_started, p_started, r.requested_by_user_id
	from public.qorpera_execution_runs r where r.id = (p_run ->> 'runId')::uuid;
	set local session_replication_role = origin;
	return v_id;
end $$;
create function pg_temp.hw_call(p_view jsonb, p_run jsonb, p_call uuid, p_head text default 'ls /company')
returns jsonb language sql as $$
	select public.qorpera_folder_home_call_open('63200000-0000-4000-8000-000000000020', p_run,
		jsonb_build_object('viewId', p_view ->> 'viewId', 'callId', p_call, 'commandHead', p_head))
$$;
create function pg_temp.hw_end_call(p_view jsonb, p_run jsonb, p_call uuid) returns jsonb language sql as $$
	select public.qorpera_folder_home_call_end('63200000-0000-4000-8000-000000000020', p_run,
		jsonb_build_object('viewId', p_view ->> 'viewId', 'callId', p_call))
$$;
-- A mkdir that credits the calls (512's shape).
create function pg_temp.hw_mk(p_path text, variadic p_credits uuid[] default null) returns jsonb language sql as $$
	select jsonb_build_object('op','mkdir','path',p_path) || case when p_credits is null then '{}'::jsonb
		else jsonb_build_object('credits', to_jsonb(p_credits)) end
$$;
create function pg_temp.hw_found(p_path text) returns boolean language sql as $$
	select (pg_temp.read(p_path) ->> 'found')::boolean
$$;
create function pg_temp.hw_reads(p_view jsonb, p_release uuid, p_path text) returns jsonb language plpgsql as $$
declare e jsonb := pg_temp.read(p_path, pg_temp.vactor(p_view)) -> 'entry';
begin
	return public.qorpera_folder_record_release('63200000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_release,
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')),
		repeat('5', 64));
end $$;


-- 1. The marker is in every function the migration patches and in the three it adds; the calls table, its columns and
-- its privileges are there; the window's columns are whole on a window and absent from every other kind; the three
-- calls are listed for the native host; the new functions are the service role's alone.
do $$
declare f regprocedure; r name;
begin
	foreach f in array array['public.qorpera_folder_view_valid(public.qorpera_folder_views)',
		'public.qorpera_folder_view_live_run(public.qorpera_folder_views)', 'public.qorpera_folder_view_resolve(uuid,uuid,jsonb)',
		'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)', 'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)',
		'public.qorpera_folder_home_window_open(uuid,jsonb,jsonb)', 'public.qorpera_folder_home_call_open(uuid,jsonb,jsonb)',
		'public.qorpera_folder_home_call_end(uuid,jsonb,jsonb)']::regprocedure[] loop
		if strpos(pg_get_functiondef(f), '20260930754000') = 0 then raise exception '% has no marker 20260930754000', f; end if;
		foreach r in array array['anon','authenticated','qorpera_secret_broker']::name[] loop
			if f::text like '%home\_%' and has_function_privilege(r, f, 'EXECUTE') then
				raise exception '% may run %', r, f; end if;
		end loop;
		if f::text like '%home\_%' and not has_function_privilege('service_role', f, 'EXECUTE') then
			raise exception 'The service role may not run %', f; end if;
	end loop;
	if (select count(*) from information_schema.columns where table_schema = 'public'
			and table_name = 'qorpera_folder_home_calls') <> 9 then
		raise exception 'The calls table has other columns'; end if;
	if not (select relrowsecurity from pg_class where oid = 'public.qorpera_folder_home_calls'::regclass) then
		raise exception 'The calls table has no row security'; end if;
	foreach r in array array['anon','authenticated','service_role','qorpera_secret_broker']::name[] loop
		if has_table_privilege(r, 'public.qorpera_folder_home_calls', 'SELECT') then
			raise exception '% reads the calls', r; end if;
	end loop;
	if (select count(*) from public.qorpera_native_host_calls where name in ('qorpera_folder_home_window_open',
			'qorpera_folder_home_call_open','qorpera_folder_home_call_end') and scope = 'folder') <> 3 then
		raise exception 'The window calls are not listed for the native host'; end if;
	if not exists (select 1 from pg_indexes where schemaname = 'public'
			and indexname = 'qorpera_folder_views_open_home_window')
		or (select indexdef from pg_indexes where indexname = 'qorpera_folder_views_open_test_machine')
			not like '%kind = ''test_machine''%' then
		raise exception 'The window indexes'; end if;
end $$;


-- Setup: one more file under shared/. 639's base already holds the narrower secret/, which agent A holds a grant on
-- and a company-wide view may not read: it is what tells the run's own rights from the company's.
do $$
declare a jsonb := pg_temp.stage('home window');
begin
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'hw-setup', jsonb_build_array(
		jsonb_build_object('op','write','path','shared/hw.txt','file',a))), 1, 'saved');
end $$;


-- 2. The open: the run's own, on a machine that is not removed and is meant to run, on its current placement, reserved
-- and running the anchor's boot. The anchor names the machine, the placement and the boot, and nothing else.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hw-open');
	m2 uuid := pg_temp.machine(v, 'hw-other'); a jsonb := pg_temp.place(m); a2 jsonb := pg_temp.place(m2); s jsonb; s2 jsonb;
	t jsonb; r jsonb; w public.qorpera_folder_views%rowtype; f text;
begin
	perform pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', '{}', v), '22023', 'Folder view anchor is invalid');
	perform pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', a || '{"screenId":"63900000-0000-4000-8000-0000000000e4"}', v),
		'22023', 'Folder view anchor is invalid');
	perform pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', a || jsonb_build_object('bootId', upper(a ->> 'bootId')), v),
		'22023', 'Folder view anchor is invalid');
	-- The window is a run's: the platform does not open one, and the ask refuses an actor that is not a run.
	perform pg_temp.refused(format('select pg_temp.open(%L, %L)', 'home_window', a), '22023', 'Folder view opener is invalid');
	perform pg_temp.refused(format('select pg_temp.hw_ask(%L, %L)', '{"kind":"platform"}', m), '22023',
		'Folder view opener is invalid');
	-- Not current: an unknown machine, placement or boot, another machine's placement, then each row in turn.
	perform pg_temp.hw_not_current(a || jsonb_build_object('companyMachineId', extensions.gen_random_uuid()), v);
	perform pg_temp.hw_not_current(a || jsonb_build_object('placementId', extensions.gen_random_uuid()), v);
	perform pg_temp.hw_not_current(a || jsonb_build_object('bootId', extensions.gen_random_uuid()), v);
	perform pg_temp.hw_not_current(a || jsonb_build_object('placementId', a2 ->> 'placementId', 'bootId', a2 ->> 'bootId'), v);
	foreach f in array array[
		format('update public.qorpera_company_machines set desired_state = %L where id = %L', 'stopped', m),
		format('update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = %L', a ->> 'placementId'),
		format('update public.qorpera_company_machine_placements set running_at = null where id = %L', a ->> 'placementId'),
		format('update public.qorpera_runtime_node_demands set released_at = clock_timestamp() where allocation_id = %L', a ->> 'placementId')] loop
		begin
			perform pg_temp.fx(f);
			perform pg_temp.hw_not_current(a, v);
			-- The ask answers the same as a refusal the relay can say in plain words, never an error.
			r := pg_temp.hw_ask(v, m);
			if r ->> 'reason' is distinct from 'MACHINE_NOT_RUNNING' then
				raise exception 'The ask on a machine that is not running: %', r; end if;
			raise exception 'Undo' using errcode = 'QTF80';
		exception when sqlstate 'QTF80' then null;
		end;
	end loop;
	r := pg_temp.hw_ask(v, extensions.gen_random_uuid());
	if r ->> 'reason' is distinct from 'MACHINE_NOT_FOUND' then
		raise exception 'The ask for a machine that is not there: %', r; end if;
	-- The window: the run's agent, member and worker access, its run, and the machine's columns; its machine is the
	-- placement (the disk), and it has no job, screen or worker of its own.
	s := pg_temp.hw_open(a, v);
	w := pg_temp.view_row(s);
	if s ->> 'schema' is distinct from 'qorpera.folder-view/v1' or w.kind is distinct from 'home_window'
		or w.state is distinct from 'open' or w.staff_agent_id is distinct from '63200000-0000-4000-8000-0000000000a1'
		or w.member_user_id is distinct from '63200000-0000-4000-8000-000000000002'
		or w.run_id is distinct from (v ->> 'runId')::uuid or w.company_machine_id is distinct from m
		or w.placement_id is distinct from (a ->> 'placementId')::uuid or w.boot_id is distinct from (a ->> 'bootId')::uuid
		or w.machine_id is distinct from w.placement_id or w.job_id is not null or w.screen_id is not null
		or w.worker_id is not null or w.worker_access is distinct from (public.qorpera_run_worker((v ->> 'runId')::uuid)).access then
		raise exception 'The window: %', to_jsonb(w); end if;
	-- The folder service renews it by its pass and learns its kind and its machine (the placement).
	r := public.qorpera_folder_view_renew((s ->> 'viewId')::uuid, s ->> 'pass');
	if r ->> 'state' is distinct from 'open' or r ->> 'kind' is distinct from 'home_window'
		or r ->> 'machineId' is distinct from a ->> 'placementId' then raise exception 'Renew: %', r; end if;
	-- The columns are whole on a window and absent from every other kind.
	perform pg_temp.violates(format('update public.qorpera_folder_views set run_id = null where id = %L', s ->> 'viewId'),
		'qorpera_folder_views_home_window');
	perform pg_temp.violates(format('update public.qorpera_folder_views set job_id = %L where id = %L', v ->> 'jobId',
		s ->> 'viewId'), 'qorpera_folder_views_home_window');
	perform pg_temp.violates(format('update public.qorpera_folder_views set machine_id = %L where id = %L',
		extensions.gen_random_uuid(), s ->> 'viewId'), 'qorpera_folder_views_home_window');
	-- The ask finds the same placement and boot and opens one of its own; this run has one open window per machine, so
	-- the second supersedes the first, while another run's window opens beside it.
	s2 := pg_temp.hw_ask(v, m);
	if s2 ->> 'state' is distinct from 'open' or s2 ->> 'placementId' is distinct from a ->> 'placementId'
		or s2 ->> 'bootId' is distinct from a ->> 'bootId' or s2 ->> 'machineId' is distinct from m::text then
		raise exception 'The ask: %', s2; end if;
	if (pg_temp.view_row(s)).state is distinct from 'closed' or (pg_temp.view_row(s)).close_reason is distinct from 'superseded' then
		raise exception 'A second window of the run does not supersede the first'; end if;
	t := pg_temp.hw_open(a, v2);
	if (select count(*) from public.qorpera_folder_views where company_machine_id = m and state = 'open'
			and kind = 'home_window') <> 2 then
		raise exception 'Two runs do not each have a window on one home'; end if;
	-- The company-wide view of the same machine closes every window of it, and no window opens on that disk again.
	perform pg_temp.open('test_machine', a);
	if (select count(*) from public.qorpera_folder_views where company_machine_id = m and state = 'open'
			and kind = 'home_window') <> 0 then
		raise exception 'The company-wide view leaves a window open'; end if;
	perform pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', a, v), '42501',
		'This machine has held the company-wide folder', 'qorpera.home-window/new-disk');
	r := pg_temp.hw_ask(v, m);
	if r ->> 'reason' is distinct from 'MACHINE_HELD_COMPANY_FOLDER' then
		raise exception 'The ask on a disk that held the company-wide folder: %', r; end if;
end $$;


-- 3. A disk a command used before any view takes no window either: the refusal says so, and the ask answers it.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hw-used-disk');
	a jsonb := pg_temp.place(m); r jsonb;
begin
	perform pg_temp.fx(format('update public.qorpera_company_machine_placements set folder_unchecked_at = clock_timestamp()
		where id = %L', a ->> 'placementId'));
	perform pg_temp.refused(format('select pg_temp.hw_open(%L, %L)', a, v), '42501',
		'This machine has held the company-wide folder', 'qorpera.home-window/new-disk');
	r := pg_temp.hw_ask(v, m);
	if r ->> 'reason' is distinct from 'MACHINE_HELD_COMPANY_FOLDER' then
		raise exception 'The ask on a disk used without the folder check: %', r; end if;
end $$;


-- 4. It is its run's: it resolves through the run, never company-wide and never detached, and its reads are the run's
-- own read rights, not the company's.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	vc jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hw-acts');
	mc uuid := pg_temp.machine(vc, 'hw-acts-wide'); s jsonb; t jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	a jsonb := pg_temp.stage('acts'); rel uuid := extensions.gen_random_uuid();
	c_narrow constant text := 'secret/s.txt';
begin
	s := pg_temp.hw_open(pg_temp.place(m), v);
	r := public.qorpera_folder_view_resolve('63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010',
		pg_temp.vactor(s));
	if r ->> 'runId' is distinct from v ->> 'runId' or r -> 'view' ->> 'kind' is distinct from 'home_window'
		or r -> 'view' -> 'companyWide' is distinct from 'false'::jsonb or r -> 'view' -> 'runActor' is distinct from v then
		raise exception 'The window resolves as its run: %', r; end if;
	-- The run's own rights: the agent holds a grant on the narrower secret/, so its window reads that file; the
	-- company-wide view of another machine, which reads the root and the rules alone, does not.
	t := pg_temp.open('test_machine', pg_temp.place(mc));
	if not (pg_temp.read(c_narrow, pg_temp.vactor(s)) ->> 'found')::boolean
		or (pg_temp.read(c_narrow, pg_temp.vactor(t)) ->> 'found')::boolean then
		raise exception 'The window shows the run''s folder, the company-wide view the company''s'; end if;
	-- Every read released under the window is the run's own read, as a read through the run's own tools is.
	r := pg_temp.hw_reads(s, rel, 'shared/hw.txt');
	if r ->> 'runId' is distinct from v ->> 'runId'
		or not exists (select 1 from public.qorpera_folder_view_read_records where view_id = (s ->> 'viewId')::uuid
			and release_id = rel)
		or not exists (select 1 from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
			and release_id = rel)
		or exists (select 1 from public.qorpera_folder_run_read_records where run_id = (vc ->> 'runId')::uuid
			and release_id = rel) then
		raise exception 'A read through the window is the run''s own read: % (view %, run %, other %)', r,
			(select count(*) from public.qorpera_folder_view_read_records where view_id = (s ->> 'viewId')::uuid
				and release_id = rel),
			(select count(*) from public.qorpera_folder_run_read_records where run_id = (v ->> 'runId')::uuid
				and release_id = rel),
			(select count(*) from public.qorpera_folder_run_read_records where run_id = (vc ->> 'runId')::uuid
				and release_id = rel); end if;
	-- A write the run may not make is denied, in the folder, and the window's commit is the run's.
	r := pg_temp.vcommit(s, 'hw-writes', jsonb_build_array(jsonb_build_object('op','write','path','shared/hw-w.txt','file',a),
		jsonb_build_object('op','write','path','QorperaOS/rules/hw.txt','file',a)));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'denied', 'denied');
	c := pg_temp.last_commit(r);
	if c.run_id is distinct from (v ->> 'runId')::uuid or c.view_kind is distinct from 'home_window'
		or c.view_id is distinct from (s ->> 'viewId')::uuid or c.credits is not null
		or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1' then
		raise exception 'The window''s commit: %', to_jsonb(c); end if;
	-- The agent loses its grants: the window stands (it needs no company-wide view) and follows the run's rights, which
	-- now read rules/ and nothing shared. The company-wide view of the other machine ends instead.
	perform pg_temp.a_grants(true);
	if not public.qorpera_folder_view_valid(pg_temp.view_row(s)) or public.qorpera_folder_view_valid(pg_temp.view_row(t)) then
		raise exception 'A window needs no company-wide view, a company-wide view does'; end if;
	if (pg_temp.read('shared/hw.txt', pg_temp.vactor(s)) ->> 'found')::boolean
		or not (pg_temp.read('QorperaOS/rules/tone.txt', pg_temp.vactor(s)) ->> 'found')::boolean then
		raise exception 'The window follows the run''s rights'; end if;
	perform pg_temp.a_grants(false);
	-- The run's turn ends: the window has ended with it, and never acts detached.
	perform pg_temp.lapse(v);
	if public.qorpera_folder_view_valid(pg_temp.view_row(s)) then raise exception 'A window outlives its run'; end if;
	perform pg_temp.refused(format('select public.qorpera_folder_view_resolve(%L, %L, %L)',
		'63200000-0000-4000-8000-000000000020', '63200000-0000-4000-8000-000000000010', pg_temp.vactor(s)), '42501',
		'Folder view has ended');
end $$;


-- 5. The calls: each one is its run's, on its own window, with its own receipt; what the window saves while a call is
-- open is credited to that call, and the commit lists the calls in start order.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002');
	v2 jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hw-calls');
	m2 uuid := pg_temp.machine(v2, 'hw-calls-two'); s jsonb; s2 jsonb; r jsonb; c public.qorpera_folder_commits%rowtype;
	c_one uuid; c_two uuid; c_ended uuid; c_other uuid; c_unknown uuid := extensions.gen_random_uuid();
	o1 jsonb; o2 jsonb; d jsonb;
begin
	s := pg_temp.hw_open(pg_temp.place(m), v);
	s2 := pg_temp.hw_open(pg_temp.place(m2), v2);
	-- A call needs its own receipt of this run under the home_call key.
	perform pg_temp.refused(format('select pg_temp.hw_call(%L, %L, %L)', s, v, c_unknown), '42501',
		'Folder call needs its own receipt');
	c_one := pg_temp.hw_receipt(v, 'one');
	perform pg_temp.refused(format('select pg_temp.hw_call(%L, %L, %L)', s2, v2, c_one), '42501',
		'Folder call needs its own receipt');
	-- A window of another run is not this run's to open a call on.
	perform pg_temp.refused(format('select pg_temp.hw_call(%L, %L, %L)', s2, v, c_one), '42501', 'Folder view has ended');
	o1 := pg_temp.hw_call(s, v, c_one); o2 := pg_temp.hw_call(s, v, c_one);
	if o1 ->> 'state' is distinct from 'open' or o1 ->> 'callId' is distinct from c_one::text
		or o2 ->> 'state' is distinct from 'open'
		or (select count(*) from public.qorpera_folder_home_calls where call_id = c_one) <> 1 then
		raise exception 'A call opens, and opening it again changes nothing: % %', o1, o2; end if;
	c_two := pg_temp.hw_receipt(v, 'two'); perform pg_temp.hw_call(s, v, c_two, 'apply_patch');
	perform pg_temp.fx(format('update public.qorpera_folder_home_calls set started_at = clock_timestamp() + interval ''1 second''
		where call_id = %L', c_two));
	c_ended := pg_temp.hw_receipt(v, 'ended'); perform pg_temp.hw_call(s, v, c_ended);
	o1 := pg_temp.hw_end_call(s, v, c_ended); o2 := pg_temp.hw_end_call(s, v, c_ended);
	if o1 -> 'closedNow' is distinct from 'true'::jsonb or o2 -> 'closedNow' is distinct from 'false'::jsonb then
		raise exception 'A call ends once: % %', o1, o2; end if;
	c_other := pg_temp.hw_receipt(v2, 'other'); perform pg_temp.hw_call(s2, v2, c_other);
	-- A unit crediting an open call of this window saves; one crediting an ended call, an unknown call or another
	-- window's call is refused on its own and applies nothing. The commit lists the valid calls in start order.
	r := pg_temp.vcommit(s, 'hw-credits', jsonb_build_array(pg_temp.hw_mk('hw-one', c_one),
		pg_temp.hw_mk('hw-both', c_two, c_one), pg_temp.hw_mk('hw-ended', c_ended), pg_temp.hw_mk('hw-unknown', c_unknown),
		pg_temp.hw_mk('hw-other', c_other), pg_temp.hw_mk('hw-none')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'refused', 'command_ended'); perform pg_temp.expect(r, 4, 'refused', 'command_ended');
	perform pg_temp.expect(r, 5, 'refused', 'command_ended'); perform pg_temp.expect(r, 6, 'saved');
	if not pg_temp.hw_found('hw-one') or not pg_temp.hw_found('hw-both') or not pg_temp.hw_found('hw-none')
		or pg_temp.hw_found('hw-ended') or pg_temp.hw_found('hw-unknown') or pg_temp.hw_found('hw-other') then
		raise exception 'A refused credit applies nothing of its unit'; end if;
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[c_one, c_two] or c.view_kind is distinct from 'home_window'
		or c.run_id is distinct from (v ->> 'runId')::uuid
		or c.actor_id is distinct from '63200000-0000-4000-8000-0000000000a1' then
		raise exception 'The credited commit: %', to_jsonb(c); end if;
	-- The check on the commit row: a non-empty list of calls, on a window's or a test machine's commit alone.
	perform pg_temp.violates(format('update public.qorpera_folder_commits set credits = ''{}'' where id = %L', c.id),
		'qorpera_folder_commits_credits');
	perform pg_temp.violates(format('update public.qorpera_folder_commits set credits = array[%L::uuid, null] where id = %L',
		c_one, c.id), 'qorpera_folder_commits_credits');
	-- A credit from a view that is neither a window nor a test machine is still malformed.
	perform pg_temp.hold(v);
	d := pg_temp.open('computer_desktop', jsonb_build_object('screenId','63900000-0000-4000-8000-0000000000e4',
		'holderRunId', v ->> 'runId'));
	perform pg_temp.refused(format('select pg_temp.vcommit(%L, %L, %L)', d, 'hw-kind-1',
		jsonb_build_array(pg_temp.hw_mk('hw-kind', c_one))), '22023', 'Change set unit 1 is invalid');
	perform public.qorpera_folder_view_close((d ->> 'viewId')::uuid, d ->> 'pass');
	perform pg_temp.hold(null);
	-- A call that ends keeps what it saved: its credit stays on the commit.
	perform pg_temp.hw_end_call(s, v, c_one);
	if (select credits from public.qorpera_folder_commits where id = c.id) is distinct from array[c_one, c_two] then
		raise exception 'An ended call loses its credit'; end if;
	-- The window's final change set closes it, as a test machine's does.
	r := pg_temp.final(s, 'hw-final', jsonb_build_array(pg_temp.hw_mk('hw-last')));
	perform pg_temp.expect(r, 1, 'saved');
	if (pg_temp.view_row(s)).state is distinct from 'closed' or (pg_temp.view_row(s)).close_reason is distinct from 'closed' then
		raise exception 'A window''s final does not close it'; end if;
end $$;


-- 6. A test machine's own credits are untouched: a machine command still credits a unit on the company-wide view, and
-- the commit still lists it.
do $$
declare v jsonb := pg_temp.run('human', '63200000-0000-4000-8000-000000000002'); m uuid := pg_temp.machine(v, 'hw-regression');
	a jsonb := pg_temp.place(m); s jsonb; r jsonb; c public.qorpera_folder_commits%rowtype; cmd uuid;
begin
	s := pg_temp.open('test_machine', a);
	cmd := pg_temp.cmd(a, v, clock_timestamp() - interval '3 minutes');
	r := pg_temp.vcommit(s, 'hw-tm-credit', jsonb_build_array(pg_temp.hw_mk('hw-tm-ok', cmd), pg_temp.hw_mk('hw-tm-none')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	c := pg_temp.last_commit(r);
	if c.credits is distinct from array[cmd] or c.view_kind is distinct from 'test_machine' then
		raise exception 'A test machine''s credits changed: %', to_jsonb(c); end if;
	perform public.qorpera_folder_view_close((s ->> 'viewId')::uuid, s ->> 'pass');
end $$;
