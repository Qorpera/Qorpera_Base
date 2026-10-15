-- Coding snapshots, 5h-2 (migration 20260930435000): the records of a member's repository set up on one node. The plan at
-- attach (current, waiting, failed, started), the build's lease and its finish, the node's list and a removal. A company
-- with members M (…01) and M2 (…02) and executors exec-a (node a…) and exec-b (node b…); M's sessions on acme/app (w1 and
-- w2 on exec-a, w2's repository spelled Acme/App, w3 on exec-b) and acme/other (w4 on exec-a), and M2's on acme/app (w5 on
-- exec-a). Foreign keys and triggers are off only while the workers, sessions and executors go in.
begin;

insert into auth.users(id, email) values
	('52500000-0000-4000-8000-000000000001', 'snapshot-member@example.test'),
	('52500000-0000-4000-8000-000000000002', 'snapshot-member-two@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('52500000-0000-4000-8000-000000000010', 'Coding snapshots', '52500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('52500000-0000-4000-8000-000000000010', '52500000-0000-4000-8000-000000000001', 'snapshot-member@example.test', 'M', 'owner'),
	('52500000-0000-4000-8000-000000000010', '52500000-0000-4000-8000-000000000002', 'snapshot-member-two@example.test', 'M2',
		'contributor');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('52500000-0000-4000-8000-000000000020', '52500000-0000-4000-8000-000000000010', 'Environment', 1,
	'52500000-0000-4000-8000-000000000001');

set session_replication_role = replica;
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version)
select ('52500000-0000-4000-8000-0000000000c' || n)::uuid, '52500000-0000-4000-8000-000000000010', '52500000-0000-4000-8000-000000000020',
	extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'w-525-' || n, 'coding', 'Code ' || n, 'read', 'each', '{}',
	member, extensions.gen_random_uuid(), member, extensions.gen_random_uuid(), 1
from (values (1, '52500000-0000-4000-8000-000000000001'::uuid), (2, '52500000-0000-4000-8000-000000000001'::uuid),
	(3, '52500000-0000-4000-8000-000000000001'::uuid), (4, '52500000-0000-4000-8000-000000000001'::uuid),
	(5, '52500000-0000-4000-8000-000000000002'::uuid)) as worker(n, member);
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase, lease_owner,
	lease_token, lease_until, started_at, updated_at)
select ('52500000-0000-4000-8000-0000000000c' || n)::uuid, '52500000-0000-4000-8000-000000000010',
	'52500000-0000-4000-8000-000000000020', 'codex', jsonb_build_object('host','github.com','owner',owner,'name',name,'baseBranch','main'),
	'w-525-' || n, 'preparing', executor, ('52500000-0000-4000-8000-0000000000e' || n)::uuid, clock_timestamp() + interval '1 hour',
	clock_timestamp(), clock_timestamp()
from (values (1, 'acme', 'app', 'exec-a'), (2, 'Acme', 'App', 'exec-a'), (3, 'acme', 'app', 'exec-b'), (4, 'acme', 'other', 'exec-a'),
	(5, 'acme', 'app', 'exec-a')) as session(n, owner, name, executor);
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
values ('52500000-0000-4000-8000-000000000020', 'exec-a', true, array['codex'], repeat('a', 64)),
	('52500000-0000-4000-8000-000000000020', 'exec-b', true, array['codex'], repeat('b', 64));
set session_replication_role = origin;

create function pg_temp.snap_ok(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'coding snapshots: %', p_what; end if; end
$$;
-- Runs p_sql and expects p_state (and p_message, when given); the refused statement's changes are undone.
create function pg_temp.snap_refused(p_sql text, p_state text, p_message text, p_what text) returns void language plpgsql as $$
begin
	begin execute p_sql;
	exception when others then
		if sqlstate = p_state and (p_message is null or sqlerrm = p_message) then return; end if;
		raise exception 'coding snapshots: % refused with % %, expected % %', p_what, sqlstate, sqlerrm, p_state, coalesce(p_message, '');
	end;
	raise exception 'coding snapshots: not refused: %', p_what;
end
$$;
create function pg_temp.snap_as(p_role text) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true)::text::void
$$;
-- Session n's plan on a node ('a' or 'b') for a digest and a commit, each one repeated hex digit.
create function pg_temp.snap_begin(p_session integer, p_node text, p_digest text, p_commit text) returns jsonb language sql as $$
	select public.qorpera_begin_coding_snapshot_build(('52500000-0000-4000-8000-0000000000c' || p_session)::uuid,
		('52500000-0000-4000-8000-0000000000e' || p_session)::uuid, repeat(p_node, 64), repeat(p_digest, 64), repeat(p_commit, 40))
$$;
create function pg_temp.snap_keys(p_value jsonb) returns text language sql as $$
	select string_agg(key, ',' order by key collate "C") from jsonb_object_keys(p_value) key
$$;
create function pg_temp.snap_listed(p_node text) returns jsonb language sql as $$
	select public.qorpera_list_coding_snapshots('exec-' || p_node, repeat(p_node, 64))
$$;
create function pg_temp.snap_entry(p_node text, p_snapshot uuid) returns jsonb language sql as $$
	select entry from jsonb_array_elements(pg_temp.snap_listed(p_node)) entry where entry ->> 'snapshotId' = p_snapshot::text
$$;

-- The checks start here.

-- The executor's five functions only; the table and the helpers are nobody's.
select pg_temp.snap_ok(bool_and(has_function_privilege('service_role', name, 'execute'))
	and not bool_or(has_function_privilege('anon', name, 'execute')) and not bool_or(has_function_privilege('authenticated', name, 'execute')),
	'the executor''s functions are service_role''s')
from unnest(array['public.qorpera_begin_coding_snapshot_build(uuid,uuid,text,text,text,integer)',
	'public.qorpera_renew_coding_snapshot_build(uuid,uuid,integer)',
	'public.qorpera_finish_coding_snapshot_build(uuid,uuid,text,text,text,text)',
	'public.qorpera_list_coding_snapshots(text,text)', 'public.qorpera_record_coding_snapshot_removed(uuid,text,text)']) name;
select pg_temp.snap_ok(not bool_or(has_function_privilege(role, name, 'execute')), 'the helpers are internal')
from unnest(array['public.qorpera_coding_snapshot_view(public.qorpera_coding_snapshots)',
	'public.qorpera_coding_snapshot_plan(text,public.qorpera_coding_snapshots,jsonb,timestamptz,jsonb)',
	'public.qorpera_coding_snapshot_lock(uuid,uuid,text)']) name
cross join unnest(array['anon', 'authenticated', 'service_role']) role;
select pg_temp.snap_ok(not bool_or(has_table_privilege(role, 'public.qorpera_coding_snapshots', privilege)), 'the table is closed')
from unnest(array['anon', 'authenticated', 'service_role']) role
cross join unnest(array['select', 'insert', 'update', 'delete']) privilege;

do $$
declare v jsonb; v_build uuid; v_token uuid; v_first uuid; v_b uuid; v_other uuid; v_other_token uuid; v_two uuid; v_two_token uuid;
	v_until timestamptz;
begin
	-- A. Only the executor, with a session's lease, on its own node, with well-formed input.
	perform pg_temp.snap_as('authenticated');
	perform pg_temp.snap_refused($q$select pg_temp.snap_begin(1, 'a', '1', '1')$q$, '42501', 'Coding executor authority required',
		'a member begins');
	perform pg_temp.snap_refused($q$select pg_temp.snap_listed('a')$q$, '42501', 'Coding snapshot custody required', 'a member lists');
	perform pg_temp.snap_as('service_role');
	perform pg_temp.snap_refused($q$select pg_temp.snap_begin(1, 'a', 'A', '1')$q$, '22023', 'Coding snapshot input invalid',
		'an upper-case digest');
	perform pg_temp.snap_refused($q$select pg_temp.snap_begin(1, 'a', '1', 'g')$q$, '22023', 'Coding snapshot input invalid',
		'a commit that is not hex');
	perform pg_temp.snap_refused($q$select public.qorpera_begin_coding_snapshot_build('52500000-0000-4000-8000-0000000000c1',
		'52500000-0000-4000-8000-0000000000e1', repeat('a', 64), repeat('1', 64), repeat('1', 40), 29)$q$, '22023',
		'Coding snapshot input invalid', 'a lease too short');
	perform pg_temp.snap_refused($q$select public.qorpera_begin_coding_snapshot_build('52500000-0000-4000-8000-0000000000c1',
		'52500000-0000-4000-8000-0000000000e2', repeat('a', 64), repeat('1', 64), repeat('1', 40))$q$, '42501',
		'Coding session lease unavailable', 'another session''s lease');
	perform pg_temp.snap_refused($q$select pg_temp.snap_begin(1, 'b', '1', '1')$q$, '42501', 'Coding snapshot node unavailable',
		'exec-a''s session on node b');
	update public.qorpera_coding_executors set enabled = false where owner = 'exec-a';
	perform pg_temp.snap_refused($q$select pg_temp.snap_begin(1, 'a', '1', '1')$q$, '42501', 'Coding snapshot node unavailable',
		'a disabled executor');
	update public.qorpera_coding_executors set enabled = true where owner = 'exec-a';
	perform pg_temp.snap_ok(not exists (select 1 from public.qorpera_coding_snapshots), 'no refusal left a row');

	-- B. The first attach on node a: no snapshot yet, a build starts.
	v := pg_temp.snap_begin(1, 'a', '1', '1');
	perform pg_temp.snap_ok(pg_temp.snap_keys(v) = 'build,failure,schema,snapshot,state,waitingUntil'
		and v ->> 'schema' = 'qorpera.coding-snapshot-plan/v1' and v ->> 'state' = 'started' and v -> 'snapshot' = 'null'
		and v -> 'failure' = 'null' and v -> 'waitingUntil' = 'null' and pg_temp.snap_keys(v -> 'build') = 'buildId,leaseToken,leaseUntil',
		'the first attach starts a build: ' || v::text);
	v_build := (v -> 'build' ->> 'buildId')::uuid; v_token := (v -> 'build' ->> 'leaseToken')::uuid;
	perform pg_temp.snap_ok((select repository = 'acme/app' and member_user_id = '52500000-0000-4000-8000-000000000001' and owner = 'exec-a'
		and machine_id_sha256 = repeat('a', 64) and setup_digest = repeat('1', 64) and commit_sha = repeat('1', 40) and state = 'building'
		and lease_until = (v -> 'build' ->> 'leaseUntil')::timestamptz from public.qorpera_coding_snapshots where id = v_build),
		'the build is M''s acme/app on node a');

	-- C. One build at a time per member and repository, on any node: the same repository (spelled Acme/App) and node b wait.
	v := pg_temp.snap_begin(2, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'waiting' and v -> 'build' = 'null' and v -> 'snapshot' = 'null'
		and (v ->> 'waitingUntil')::timestamptz = (select lease_until from public.qorpera_coding_snapshots where id = v_build),
		'Acme/App waits for the build: ' || v::text);
	perform pg_temp.snap_ok(pg_temp.snap_begin(3, 'b', '1', '1') ->> 'state' = 'waiting', 'node b waits for the build');
	-- Another repository of the member, and another member's same repository, build beside it.
	v := pg_temp.snap_begin(4, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'started', 'acme/other builds beside it');
	v_other := (v -> 'build' ->> 'buildId')::uuid; v_other_token := (v -> 'build' ->> 'leaseToken')::uuid;
	v := pg_temp.snap_begin(5, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'started', 'M2''s acme/app builds beside it');
	v_two := (v -> 'build' ->> 'buildId')::uuid; v_two_token := (v -> 'build' ->> 'leaseToken')::uuid;

	-- D. The lease: renewed with its token only; the finish checks its input and its token.
	v_until := public.qorpera_renew_coding_snapshot_build(v_build, v_token, 60);
	perform pg_temp.snap_ok(v_until > clock_timestamp() + interval '50 seconds'
		and v_until = (select lease_until from public.qorpera_coding_snapshots where id = v_build), 'renewed');
	perform pg_temp.snap_refused(format('select public.qorpera_renew_coding_snapshot_build(%L, %L)', v_build, v_other_token),
		'42501', 'Coding snapshot build lease unavailable', 'a renewal with another token');
	perform pg_temp.snap_refused(format('select public.qorpera_renew_coding_snapshot_build(%L, %L, 301)', v_build, v_token),
		'22023', 'Coding snapshot input invalid', 'a lease too long');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L)', v_build, v_token, 'ready'),
		'22023', 'Coding snapshot input invalid', 'ready without an image');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L, %L)', v_build, v_token,
		'ready', repeat('f', 64), 'BROKEN'), '22023', 'Coding snapshot input invalid', 'ready with a failure');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L)', v_build, v_token, 'failed'),
		'22023', 'Coding snapshot input invalid', 'failed without a code');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L, %L)', v_build, v_token,
		'failed', repeat('f', 64), 'BROKEN'), '22023', 'Coding snapshot input invalid', 'failed with an image');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, null, %L)', v_build, v_token,
		'failed', 'broken'), '22023', 'Coding snapshot input invalid', 'a lower-case code');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_build, v_token,
		'retired', repeat('f', 64)), '22023', 'Coding snapshot input invalid', 'an outcome that is not one');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, null, %L, %L)', v_build, v_token,
		'failed', 'BROKEN', repeat('x', 65537)), '22023', 'Coding snapshot input invalid', 'a log over 64 KiB');
	-- 64 KiB as a JSON string, where an escape character takes six bytes: 10927 bytes of text, one byte over as JSON.
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, null, %L, %L)', v_build, v_token,
		'failed', 'BROKEN', repeat(chr(27), 10922) || 'xxxxx'), '22023', 'Coding snapshot input invalid', 'a log over 64 KiB as JSON');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_build, v_other_token,
		'ready', repeat('f', 64)), '42501', 'Coding snapshot build lease unavailable', 'a finish with another token');

	-- E. Ready: the node's snapshot. Sent again, the same answer; any other finish is refused.
	v := public.qorpera_finish_coding_snapshot_build(v_build, v_token, 'ready', repeat('f', 64), null, 'built' || E'\n');
	perform pg_temp.snap_ok(v = jsonb_build_object('schema','qorpera.coding-snapshot-build/v1','buildId',v_build,'state','ready'),
		'ready: ' || v::text);
	perform pg_temp.snap_ok(public.qorpera_finish_coding_snapshot_build(v_build, v_token, 'ready', repeat('f', 64), null, 'again') = v,
		'a ready sent again');
	perform pg_temp.snap_ok((select lease_until is null and finished_at is not null and log = 'built' || E'\n'
		from public.qorpera_coding_snapshots where id = v_build), 'the replay changed nothing');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_build, v_token,
		'ready', repeat('e', 64)), '42501', 'Coding snapshot build lease unavailable', 'a ready with another image');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, null, %L)', v_build, v_token,
		'failed', 'BROKEN'), '42501', 'Coding snapshot build lease unavailable', 'a failure after ready');
	perform pg_temp.snap_refused(format('select public.qorpera_renew_coding_snapshot_build(%L, %L)', v_build, v_token),
		'42501', 'Coding snapshot build lease unavailable', 'a renewal after ready');
	v_first := v_build;

	-- F. The same digest and commit on node a: current, from either session.
	v := pg_temp.snap_begin(1, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'current' and v -> 'build' = 'null' and v -> 'failure' = 'null'
		and v -> 'snapshot' = jsonb_build_object('snapshotId',v_first,'setupDigest',repeat('1', 64),'commitSha',repeat('1', 40),
			'imageFingerprint',repeat('f', 64),'builtAt',(select finished_at from public.qorpera_coding_snapshots where id = v_first)),
		'current on node a: ' || v::text);
	perform pg_temp.snap_ok(pg_temp.snap_begin(2, 'a', '1', '1') ->> 'state' = 'current', 'Acme/App is current too');

	-- G. Node b has none of its own (never copied): it builds, and may hold the same image fingerprint as node a.
	v := pg_temp.snap_begin(3, 'b', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'snapshot' = 'null', 'node b builds its own: ' || v::text);
	v_b := (v -> 'build' ->> 'buildId')::uuid;
	perform public.qorpera_finish_coding_snapshot_build(v_b, (v -> 'build' ->> 'leaseToken')::uuid, 'ready', repeat('f', 64));
	perform pg_temp.snap_ok(pg_temp.snap_begin(3, 'b', '1', '1') -> 'snapshot' ->> 'snapshotId' = v_b::text
		and pg_temp.snap_begin(1, 'a', '1', '1') -> 'snapshot' ->> 'snapshotId' = v_first::text, 'each node starts from its own');

	-- H. A new commit on the default branch refreshes it; a failed build keeps the old snapshot and comes back with its log.
	v := pg_temp.snap_begin(1, 'a', '1', '2');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'snapshot' ->> 'snapshotId' = v_first::text,
		'a new commit builds, the old snapshot meanwhile: ' || v::text);
	v_build := (v -> 'build' ->> 'buildId')::uuid; v_token := (v -> 'build' ->> 'leaseToken')::uuid;
	v := public.qorpera_finish_coding_snapshot_build(v_build, v_token, 'failed', null, 'INSTALL_FAILED', 'npm ERR! ***' || E'\n');
	perform pg_temp.snap_ok(v ->> 'state' = 'failed', 'failed: ' || v::text);
	perform pg_temp.snap_ok(public.qorpera_finish_coding_snapshot_build(v_build, v_token, 'failed', null, 'INSTALL_FAILED') = v,
		'a failure sent again');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, null, %L)', v_build, v_token,
		'failed', 'OTHER'), '42501', 'Coding snapshot build lease unavailable', 'a failure with another code');
	v := pg_temp.snap_begin(2, 'a', '1', '2');
	perform pg_temp.snap_ok(v ->> 'state' = 'failed' and v -> 'build' = 'null' and v -> 'snapshot' ->> 'snapshotId' = v_first::text
		and v -> 'failure' = jsonb_build_object('buildId',v_build,'code','INSTALL_FAILED','log','npm ERR! ***' || E'\n',
			'finishedAt',(select finished_at from public.qorpera_coding_snapshots where id = v_build)),
		'the failure stands, with its log, until the commit or setup changes: ' || v::text);
	-- Node b has not tried that commit: it builds.
	v := pg_temp.snap_begin(3, 'b', '1', '2');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'snapshot' ->> 'snapshotId' = v_b::text, 'node b tries the commit');
	perform public.qorpera_finish_coding_snapshot_build((v -> 'build' ->> 'buildId')::uuid, (v -> 'build' ->> 'leaseToken')::uuid,
		'abandoned', null, 'BUILDER_LOST');

	-- I. A new setup refreshes it; the new snapshot retires the old one on that node only.
	v := pg_temp.snap_begin(1, 'a', '2', '2');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'snapshot' ->> 'snapshotId' = v_first::text, 'a new setup builds');
	v_build := (v -> 'build' ->> 'buildId')::uuid; v_token := (v -> 'build' ->> 'leaseToken')::uuid;
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_build, v_token,
		'ready', repeat('f', 64)), '55000', 'Coding snapshot image is already recorded', 'an image node a holds for another snapshot');
	perform public.qorpera_finish_coding_snapshot_build(v_build, v_token, 'ready', repeat('d', 64));
	perform pg_temp.snap_ok((select state = 'retired' and retired_at is not null and removed_at is null
		from public.qorpera_coding_snapshots where id = v_first), 'node a''s old snapshot is retired');
	perform pg_temp.snap_ok((select state = 'ready' from public.qorpera_coding_snapshots where id = v_b), 'node b''s stays');
	v := pg_temp.snap_begin(2, 'a', '2', '2');
	perform pg_temp.snap_ok(v ->> 'state' = 'current' and v -> 'snapshot' ->> 'snapshotId' = v_build::text, 'current again');
	perform pg_temp.snap_ok(public.qorpera_finish_coding_snapshot_build(v_first, (select lease_token from public.qorpera_coding_snapshots
		where id = v_first), 'ready', repeat('f', 64)) ->> 'state' = 'retired', 'a ready sent again after its retirement');

	-- J. A lease that lapsed: the build can neither renew nor finish, is not listed, and the next attach gives it up and
	-- starts again. An abandoned build is tried again at once.
	update public.qorpera_coding_snapshots set lease_until = clock_timestamp() - interval '1 second' where id = v_other;
	perform pg_temp.snap_refused(format('select public.qorpera_renew_coding_snapshot_build(%L, %L)', v_other, v_other_token),
		'42501', 'Coding snapshot build lease unavailable', 'a lapsed renewal');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_other, v_other_token,
		'ready', repeat('c', 64)), '42501', 'Coding snapshot build lease unavailable', 'a lapsed finish');
	perform pg_temp.snap_ok(pg_temp.snap_entry('a', v_other) is null, 'a lapsed build is not listed');
	v := pg_temp.snap_begin(4, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'build' ->> 'buildId' <> v_other::text, 'acme/other starts again');
	perform pg_temp.snap_ok((select state = 'abandoned' and failure = 'LEASE_EXPIRED' and lease_until is null and finished_at is not null
		from public.qorpera_coding_snapshots where id = v_other), 'the lapsed build was given up');
	perform pg_temp.snap_refused(format('select public.qorpera_finish_coding_snapshot_build(%L, %L, %L, %L)', v_other, v_other_token,
		'ready', repeat('c', 64)), '42501', 'Coding snapshot build lease unavailable', 'a finish after it was given up');
	-- Its log is exactly 64 KiB as a JSON string.
	perform public.qorpera_finish_coding_snapshot_build((v -> 'build' ->> 'buildId')::uuid, (v -> 'build' ->> 'leaseToken')::uuid,
		'abandoned', null, 'BUILDER_LOST', repeat(chr(27), 10922) || 'xxxx');
	perform pg_temp.snap_ok((select octet_length(to_jsonb(log)::text) = 65538 from public.qorpera_coding_snapshots
		where id = (v -> 'build' ->> 'buildId')::uuid), 'a log of 64 KiB as JSON is kept');
	perform pg_temp.snap_ok(pg_temp.snap_begin(4, 'a', '1', '1') ->> 'state' = 'started', 'an abandoned build is tried again');

	-- K. The node's list: what may be on it, and what is due for removal. Removal is recorded for a due one only.
	v := pg_temp.snap_entry('a', v_first);
	perform pg_temp.snap_ok(pg_temp.snap_keys(v) = 'builtAt,commitSha,imageFingerprint,leaseUntil,removeDue,schema,setupDigest,snapshotId,startedAt,state'
		and v ->> 'schema' = 'qorpera.coding-snapshot-state/v1' and v ->> 'state' = 'retired' and (v ->> 'removeDue')::boolean
		and v ->> 'imageFingerprint' = repeat('f', 64), 'the retired snapshot is due: ' || v::text);
	v := pg_temp.snap_entry('a', v_build);
	perform pg_temp.snap_ok(v ->> 'state' = 'ready' and not (v ->> 'removeDue')::boolean, 'the ready one is kept');
	v := pg_temp.snap_entry('a', v_two);
	perform pg_temp.snap_ok(v ->> 'state' = 'building' and not (v ->> 'removeDue')::boolean and v -> 'imageFingerprint' = 'null'
		and v -> 'leaseUntil' <> 'null', 'a running build is listed: ' || v::text);
	perform pg_temp.snap_ok(pg_temp.snap_entry('a', v_b) is null and pg_temp.snap_entry('b', v_b) is not null
		and jsonb_array_length(pg_temp.snap_listed('b')) = 1, 'each node lists its own');
	perform pg_temp.snap_ok(not exists (select 1 from jsonb_array_elements(pg_temp.snap_listed('a')) entry
		where entry ->> 'state' in ('failed', 'abandoned')), 'no failed or abandoned build is listed');
	perform pg_temp.snap_refused(format('select public.qorpera_record_coding_snapshot_removed(%L, %L, %L)', v_first, 'exec-b',
		repeat('b', 64)), '42501', 'Coding snapshot custody required', 'another node removes it');
	perform pg_temp.snap_refused(format('select public.qorpera_record_coding_snapshot_removed(%L, %L, %L)', v_build, 'exec-a',
		repeat('a', 64)), '55000', 'Coding snapshot is not due for removal', 'the ready one is removed');
	v := public.qorpera_record_coding_snapshot_removed(v_first, 'exec-a', repeat('a', 64));
	perform pg_temp.snap_ok(pg_temp.snap_keys(v) = 'removedAt,schema,snapshotId' and v ->> 'schema' = 'qorpera.coding-snapshot-removed/v1'
		and (v ->> 'snapshotId')::uuid = v_first and v -> 'removedAt' <> 'null', 'removal answers: ' || v::text);
	perform pg_temp.snap_ok(public.qorpera_record_coding_snapshot_removed(v_first, 'exec-a', repeat('a', 64)) = v,
		'removal sent again gets the same answer');
	perform pg_temp.snap_ok((select removed_at is not null and state = 'retired' from public.qorpera_coding_snapshots where id = v_first)
		and pg_temp.snap_entry('a', v_first) is null, 'removed, once, and no longer listed');
	-- Its image fingerprint is free again on node a.
	v := pg_temp.snap_begin(1, 'a', '3', '3');
	perform public.qorpera_finish_coding_snapshot_build((v -> 'build' ->> 'buildId')::uuid, (v -> 'build' ->> 'leaseToken')::uuid,
		'ready', repeat('f', 64));
	perform pg_temp.snap_ok(pg_temp.snap_begin(1, 'a', '3', '3') ->> 'state' = 'current', 'the removed image''s fingerprint is free');

	-- L. A member who left: the list retires their ready snapshot before it names it due. A member who comes back before
	-- the image is removed builds again (the image is never current after it), and the removal is still recorded.
	perform public.qorpera_finish_coding_snapshot_build(v_two, v_two_token, 'ready', repeat('9', 64));
	perform pg_temp.snap_ok(not (pg_temp.snap_entry('a', v_two) ->> 'removeDue')::boolean
		and pg_temp.snap_begin(5, 'a', '1', '1') ->> 'state' = 'current', 'M2''s snapshot is kept and current while M2 is a member');
	set local session_replication_role = replica;
	delete from public.qorpera_profile_members where profile_id = '52500000-0000-4000-8000-000000000010'
		and user_id = '52500000-0000-4000-8000-000000000002';
	set local session_replication_role = origin;
	perform pg_temp.snap_ok((select state = 'ready' from public.qorpera_coding_snapshots where id = v_two), 'ready until a list');
	v := pg_temp.snap_entry('a', v_two);
	perform pg_temp.snap_ok(v ->> 'state' = 'retired' and (v ->> 'removeDue')::boolean, 'M2 left: the list retires it, due: ' || v::text);
	perform pg_temp.snap_ok((select state = 'retired' and retired_at is not null and removed_at is null
		from public.qorpera_coding_snapshots where id = v_two), 'the retirement is recorded before the image goes');
	set local session_replication_role = replica;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values ('52500000-0000-4000-8000-000000000010',
		'52500000-0000-4000-8000-000000000002', 'snapshot-member-two@example.test', 'M2', 'contributor');
	set local session_replication_role = origin;
	v := pg_temp.snap_begin(5, 'a', '1', '1');
	perform pg_temp.snap_ok(v ->> 'state' = 'started' and v -> 'snapshot' = 'null', 'M2 came back: a new build, not the old image: ' || v::text);
	perform pg_temp.snap_ok((pg_temp.snap_entry('a', v_two) ->> 'removeDue')::boolean, 'still due after M2 came back');
	perform public.qorpera_record_coding_snapshot_removed(v_two, 'exec-a', repeat('a', 64));
	perform pg_temp.snap_ok((select state = 'retired' and removed_at is not null from public.qorpera_coding_snapshots where id = v_two),
		'removed');
end
$$;

rollback;
