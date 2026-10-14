-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Step 5a, the coding machine's read set (migration 20260930395000; deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md,
-- "Reads"). One machine with three sessions of agent A for member ...02. It proves:
-- - a coding view's release lands in the machine's set and in every turn leased on the machine (fan-out);
-- - a release id the machine has used refuses other reads, from any session's view;
-- - a turn leased later takes the machine's set in when it reads its wake;
-- - after a narrowing, every coding view on the machine refuses to save, a session that never read the file too;
-- - a reopened view carries nothing of its own, yet still refuses (the machine's set holds the read);
-- - the executor's disk call is refused while a session is attached, empties the set when none is, and needs custody;
-- - a turn's later take-in keeps what it took in before a new disk, so narrowing that read refuses the turn's recheck.
-- Not here: the take-in when run authority moves a session onto a machine (qorpera_authorize_coding_machine_run). It
-- needs 485's node, inventory and plan setup, so 485's H covers it.
-- Runs, workers and sessions are built by hand, as in 634 and 639, with 647's native rows for the wake read.

-- A coding session of agent A for member ...02, dispatched by p_parent, attached to machine ...c1 (and running there)
-- with a fresh token. Returns the view anchor.
create function pg_temp.session(p_parent jsonb) returns jsonb language plpgsql as $$
declare w uuid := pg_temp.worker('63400000-0000-4000-8000-0000000000a1', p_parent, 'coding', 'read', '63400000-0000-4000-8000-000000000002');
	tok uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, vm_allocation_id,
		attached_machine_id, attachment_token, attachment_until, attachment_turn, attached_at)
	values (w, '63400000-0000-4000-8000-000000000010', '63400000-0000-4000-8000-000000000020', 'claude-code',
		'{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', 'qorpera/' || left(w::text, 8),
		'48600000-0000-4000-8000-0000000000c1', '48600000-0000-4000-8000-0000000000c1', tok, clock_timestamp() + interval '1 hour', 1,
		clock_timestamp());
	set local session_replication_role = origin;
	return jsonb_build_object('workerId', w, 'attachmentToken', tok);
end $$;
create function pg_temp.open(p_session jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_view_open('63400000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'coding_session', p_session)
$$;
create function pg_temp.vactor(p_view jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind','view','viewId',p_view ->> 'viewId','pass',p_view ->> 'pass')
$$;
-- A save as the view: one new folder under code/, where the coding rule lets it write.
create function pg_temp.vcommit(p_view jsonb, p_key text) returns jsonb language sql as $$
	select public.qorpera_folder_commit('63400000-0000-4000-8000-000000000020', pg_temp.vactor(p_view), p_key,
		jsonb_build_array(jsonb_build_object('op','mkdir','path','code/' || p_key)), null)
$$;
-- The run's records hold the path under this release.
create function pg_temp.filed(p_run jsonb, p_release uuid, p_path text) returns boolean language sql as $$
	select exists (select 1 from public.qorpera_folder_run_read_records where run_id = (p_run ->> 'runId')::uuid
		and release_id = p_release and reads @> jsonb_build_array(jsonb_build_object('path', p_path)))
$$;
-- The machine's pairs and records, counted.
create function pg_temp.machine_rows() returns bigint language sql as $$
	select (select count(*) from public.qorpera_coding_machine_reads where coding_machine_id = '48600000-0000-4000-8000-0000000000c1')
		+ (select count(*) from public.qorpera_coding_machine_read_records where coding_machine_id = '48600000-0000-4000-8000-0000000000c1')
$$;

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_a constant uuid := '63400000-0000-4000-8000-0000000000a1'; c_member constant uuid := '63400000-0000-4000-8000-000000000002';
	c_m constant uuid := '48600000-0000-4000-8000-0000000000c1';
	p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	s1 jsonb; s2 jsonb; s3 jsonb; v1 jsonb; v2 jsonb; t1 jsonb; t2 jsonb; t3 jsonb; f jsonb; g jsonb; r jsonb; n bigint;
	rid uuid := extensions.gen_random_uuid(); v_res uuid; v_take uuid;
	s4 jsonb; s5 jsonb; v4 jsonb; v5 jsonb; t4 jsonb; b4 jsonb;
begin
	-- The machine, as its own allocation, with binding {} pinned by its digest (the disk call's custody); the agent's
	-- repository grant and the executor. Three sessions run on it.
	set local session_replication_role = replica;
	insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
		instance_sha256)
	values (c_m, 'member', c_profile, c_env, c_member, 'exec-1', repeat('8', 64), '{}',
		encode(extensions.digest(convert_to('{}', 'utf8'), 'sha256'), 'hex'));
	insert into public.qorpera_runtime_machine_allocations(id, profile_id, provider_adapter, instance_sha256, coding_machine_id, reserved_at)
	values (c_m, c_profile, 'lxd', repeat('9', 64), c_m, clock_timestamp());
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values (c_env, c_a, '{"host":"github.com","owner":"acme","name":"app","baseBranch":"main"}', true);
	insert into public.qorpera_coding_executors(environment_id, owner, enabled) values (c_env, 'exec-1', true);
	set local session_replication_role = origin;
	s1 := pg_temp.session(p); s2 := pg_temp.session(p); s3 := pg_temp.session(p);
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'machine-files', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','code'), jsonb_build_object('op','mkdir','path','mread'),
		jsonb_build_object('op','write','path','mread/f.txt','file',pg_temp.stage('file f')),
		jsonb_build_object('op','write','path','mread/g.txt','file',pg_temp.stage('file g')))), 4, 'saved');
	v1 := pg_temp.open(s1); v2 := pg_temp.open(s2);
	if exists (select 1 from public.qorpera_folder_views where id in ((v1 ->> 'viewId')::uuid, (v2 ->> 'viewId')::uuid)
		and machine_id is distinct from c_m) then
		raise exception 'Setup: both coding views are on the machine'; end if;
	-- Before any narrowing, S2's view saves.
	perform pg_temp.expect(pg_temp.vcommit(v2, 'v2-before'), 1, 'saved');

	-- 1. Fan-out. S1 and S2 each have a leased turn. F released through S1's view reaches the machine's pairs and
	-- records, and both turns' records under the release id; the answer names S1's turn.
	t1 := pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, (s1 ->> 'workerId')::uuid);
	t2 := pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, (s2 ->> 'workerId')::uuid);
	f := pg_temp.read('mread/f.txt', pg_temp.vactor(v1)) -> 'entry';
	v_res := (f -> 'authority' ->> 'resourceId')::uuid;
	r := pg_temp.release(pg_temp.vactor(v1), rid, jsonb_build_array(f), repeat('3', 64));
	if r ->> 'runId' is distinct from t1 ->> 'runId' or (r ->> 'replay')::boolean then
		raise exception 'Fan-out: the release answers for S1''s turn, got %', r; end if;
	if not exists (select 1 from public.qorpera_coding_machine_reads where coding_machine_id = c_m and resource_id = v_res)
		or not exists (select 1 from public.qorpera_coding_machine_read_records where coding_machine_id = c_m and release_id = rid
			and resource_id = v_res and output_sha256 = repeat('3', 64) and reads @> '[{"path":"mread/f.txt"}]') then
		raise exception 'Fan-out: the machine''s pairs and records hold F'; end if;
	if not pg_temp.filed(t1, rid, 'mread/f.txt') or not pg_temp.filed(t2, rid, 'mread/f.txt') then
		raise exception 'Fan-out: both turns'' records hold F under the release id'; end if;
	if not exists (select 1 from public.qorpera_folder_run_reads where run_id = (t2 ->> 'runId')::uuid and resource_id = v_res) then
		raise exception 'Fan-out: S2''s turn has F''s pair in its read set'; end if;

	-- 4. Take-in at the wake read. S3's turn, leased after the release, got nothing from it. Reading its wake files the
	-- machine's reads under the machine's release for that run, with an all-zero output.
	t3 := pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, (s3 ->> 'workerId')::uuid);
	if exists (select 1 from public.qorpera_folder_run_read_records where run_id = (t3 ->> 'runId')::uuid) then
		raise exception 'Take-in: a turn leased after the release has no records before its wake read'; end if;
	perform public.qorpera_read_native_wake(pg_temp.native(t3));
	v_take := md5('coding-machine:' || (t3 ->> 'runId') || ':' || c_m::text)::uuid;
	if not exists (select 1 from public.qorpera_folder_run_read_records where run_id = (t3 ->> 'runId')::uuid and release_id = v_take
			and resource_id = v_res and output_sha256 = repeat('0', 64) and reads @> '[{"path":"mread/f.txt"}]')
		or not exists (select 1 from public.qorpera_folder_run_reads where run_id = (t3 ->> 'runId')::uuid and resource_id = v_res) then
		raise exception 'Take-in: the wake read files the machine''s reads under release %', v_take; end if;
	if pg_temp.filed(t3, rid, 'mread/f.txt') then raise exception 'Take-in: nothing is filed under the view''s release id'; end if;

	-- The turns end, so from here on only view and machine reads can hold a save back.
	perform pg_temp.fx(format('update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() - interval ''1 second''
		where id in (%L, %L, %L)', t1 ->> 'jobId', t2 ->> 'jobId', t3 ->> 'jobId'));

	-- 3. The same release id twice. S2's view, which never used the id, releases other reads under it: the machine has
	-- used it, so it refuses, and leaves S2's view with no reads.
	g := pg_temp.read('mread/g.txt', pg_temp.vactor(v2)) -> 'entry';
	perform pg_temp.raises_like(format('select pg_temp.release(%L, %L, %L, %L)', pg_temp.vactor(v2), rid, jsonb_build_array(g),
		repeat('4', 64)), '22023', 'Release id was used for other reads');
	if exists (select 1 from public.qorpera_folder_view_reads where view_id = (v2 ->> 'viewId')::uuid) then
		raise exception 'Same release id: the refused release leaves S2''s view with no reads'; end if;

	-- 2. Recheck. mread/ narrows to a resource agent A holds no grant on. S2's view never released F, but the machine's
	-- set holds it, so its save refuses; S1's view's save refuses too.
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'mread', 'subtree', 'company_shared', 'normal');
	perform pg_temp.raises_like(format('select pg_temp.vcommit(%L, %L)', v2, 'v2-after'), '42501', 'A read is no longer readable');
	perform pg_temp.raises(format('select pg_temp.vcommit(%L, %L)', v1, 'v1-after'), '42501');

	-- 6. No per-session carry. S1's view, reopened, has no reads of its own, but its save still refuses.
	v1 := pg_temp.open(s1);
	if exists (select 1 from public.qorpera_folder_view_reads where view_id = (v1 ->> 'viewId')::uuid)
		or exists (select 1 from public.qorpera_folder_view_read_records where view_id = (v1 ->> 'viewId')::uuid) then
		raise exception 'No carry: a reopened coding view starts with no reads of its own'; end if;
	perform pg_temp.raises_like(format('select pg_temp.vcommit(%L, %L)', v1, 'v1-reopened'), '42501', 'A read is no longer readable');

	-- 7. The disk, as the executor (service_role). Refused while a session is attached, deleting nothing.
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	n := pg_temp.machine_rows();
	if n < 2 then raise exception 'Disk: the machine holds pairs and records before the call (%)', n; end if;
	r := public.qorpera_replace_coding_machine_disk(c_m, 'exec-1', '{}', repeat('8', 64));
	if r is distinct from jsonb_build_object('schema','qorpera.coding-machine-disk/v1','machineId',c_m,'state','refused',
		'reason','SESSION_ATTACHED') or pg_temp.machine_rows() <> n then
		raise exception 'Disk: refused while a session is attached, deleting nothing: %', r; end if;
	-- With every session detached: another owner has no custody (and deletes nothing); the machine's owner empties it.
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null,
		attachment_until = null, attachment_turn = null, attached_at = null where attached_machine_id = %L', c_m));
	perform pg_temp.raises_like(format('select public.qorpera_replace_coding_machine_disk(%L, %L, %L, %L)', c_m, 'exec-2', '{}',
		repeat('8', 64)), '42501', 'Coding machine custody differs');
	if pg_temp.machine_rows() <> n then raise exception 'Disk: a call without custody deletes nothing'; end if;
	r := public.qorpera_replace_coding_machine_disk(c_m, 'exec-1', '{}', repeat('8', 64));
	if r is distinct from jsonb_build_object('schema','qorpera.coding-machine-disk/v1','machineId',c_m,'state','emptied')
		or pg_temp.machine_rows() <> 0 then
		raise exception 'Disk: with no session attached the machine''s pairs and records go: %', r; end if;
	-- The turns' own records are the runs', not the disk's.
	if not pg_temp.filed(t1, rid, 'mread/f.txt') then raise exception 'Disk: the turns keep their own records'; end if;

	-- 8. A take-in keeps what the turn took in before. S4's view releases F; S4's turn, leased after, takes F in at its
	-- wake read. Every session detaches and the disk goes while that turn stays leased; S5's view releases G (F's
	-- resource), and the turn's next wake read takes G in. Its machine release holds F and G, so narrowing F refuses.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'take-files', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','mtake'), jsonb_build_object('op','mkdir','path','mtake/f'),
		jsonb_build_object('op','mkdir','path','mtake/g'),
		jsonb_build_object('op','write','path','mtake/f/f.txt','file',pg_temp.stage('take f')),
		jsonb_build_object('op','write','path','mtake/g/g.txt','file',pg_temp.stage('take g')))), 5, 'saved');
	s4 := pg_temp.session(p); v4 := pg_temp.open(s4);
	f := pg_temp.read('mtake/f/f.txt', pg_temp.vactor(v4)) -> 'entry';
	v_res := (f -> 'authority' ->> 'resourceId')::uuid;
	perform pg_temp.release(pg_temp.vactor(v4), extensions.gen_random_uuid(), jsonb_build_array(f));
	t4 := pg_temp.run(c_a, 'agent', c_member, 'worker-dispatch', p, (s4 ->> 'workerId')::uuid);
	b4 := pg_temp.native(t4);
	perform public.qorpera_read_native_wake(b4);
	v_take := md5('coding-machine:' || (t4 ->> 'runId') || ':' || c_m::text)::uuid;
	if not pg_temp.filed(t4, v_take, 'mtake/f/f.txt') then raise exception 'Keep: S4''s turn takes F in at its wake read'; end if;
	perform pg_temp.fx(format('update public.qorpera_coding_sessions set attached_machine_id = null, attachment_token = null,
		attachment_until = null, attachment_turn = null, attached_at = null where attached_machine_id = %L', c_m));
	r := public.qorpera_replace_coding_machine_disk(c_m, 'exec-1', '{}', repeat('8', 64));
	if r ->> 'state' is distinct from 'emptied' or pg_temp.machine_rows() <> 0 then
		raise exception 'Keep: the disk goes while S4''s turn stays leased: %', r; end if;
	s5 := pg_temp.session(p); v5 := pg_temp.open(s5);
	g := pg_temp.read('mtake/g/g.txt', pg_temp.vactor(v5)) -> 'entry';
	if (g -> 'authority' ->> 'resourceId')::uuid is distinct from v_res then raise exception 'Setup: F and G share a resource'; end if;
	perform pg_temp.release(pg_temp.vactor(v5), extensions.gen_random_uuid(), jsonb_build_array(g));
	perform public.qorpera_read_native_wake(b4);
	if not exists (select 1 from public.qorpera_folder_run_read_records where run_id = (t4 ->> 'runId')::uuid and release_id = v_take
			and resource_id = v_res and reads @> '[{"path":"mtake/f/f.txt"},{"path":"mtake/g/g.txt"}]') then
		raise exception 'Keep: the second take-in adds G to the machine release and keeps F'; end if;
	perform public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'mtake/f', 'subtree', 'company_shared', 'normal');
	perform pg_temp.raises_like(format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', c_env, c_profile,
		public.qorpera_folder_run_resolve(c_env, c_profile, t4) - 'lockTargets' - 'attribution'), '42501',
		'A read is no longer readable');
end $$;

rollback;
