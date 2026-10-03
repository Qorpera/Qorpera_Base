-- Company folder core, C1b-2: authority changes under concurrency (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md,
-- section C1b-2 §1 and §3). Other connections race real commits, mutators and rechecks. The fixture is committed so
-- they can see it, and removed at the end. Waits are detected with pg_blocking_pids, never by wall-clock time.

insert into auth.users(id,email) values ('63500000-0000-4000-8000-000000000001','authority-race-owner@example.test'),
	('63500000-0000-4000-8000-000000000002','authority-race-member@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('63500000-0000-4000-8000-000000000010','Folder authority race fixture','63500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000001','authority-race-owner@example.test','Owner','owner'),
	('63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-000000000002','authority-race-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('63500000-0000-4000-8000-000000000020','63500000-0000-4000-8000-000000000010','Environment',1,'63500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter, appearance_color, appearance_shape,
	employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id) values
	('63500000-0000-4000-8000-000000000010','63500000-0000-4000-8000-0000000000a1','Agent A','QA','Test.','green','round','active','active',
		statement_timestamp(), statement_timestamp(), '63500000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.qorpera_folder_enable('63500000-0000-4000-8000-000000000020');
-- The runs' sponsor (binding id = agent A's id): a company login, which pays for any member's work (20260928230000).
set session_replication_role = replica;
insert into public.qorpera_provider_connections(id, profile_id, client_connection_id, provider, created_by_user_id)
values ('63500000-0000-4000-8000-0000000000b3', '63500000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), 'openai', '63500000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_bindings(id, profile_id, client_binding_id, created_by_user_id)
values ('63500000-0000-4000-8000-0000000000a1', '63500000-0000-4000-8000-000000000010', extensions.gen_random_uuid(), '63500000-0000-4000-8000-000000000001');
insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id, provider_connection_version,
	created_by_user_id)
values ('63500000-0000-4000-8000-0000000000a1', 1, 'company_service_account', '63500000-0000-4000-8000-0000000000b3', 1, '63500000-0000-4000-8000-000000000001');
set session_replication_role = origin;

-- Verified version-2 bytes for a text, as the object gateway leaves them: the platform stages them (C1D §9.3).
create function pg_temp.manifest_v2(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/plain","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;
-- Opens an intent for a manifest as the actor, confirms each object the open did not report present (the manifest's
-- chunks and the manifest itself, by hash and size, as the gateway does once it has stored them), and seals it.
create function pg_temp.seal_v2(p_env uuid, p_actor jsonb, p_manifest text) returns jsonb language plpgsql as $$
declare v_open jsonb := public.qorpera_folder_open_upload(p_env, p_actor, p_manifest); v_object jsonb;
begin
	for v_object in select c from jsonb_array_elements(p_manifest::jsonb -> 'chunks') c
		union all select jsonb_build_object('sha256', encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'),
			'bytes', octet_length(convert_to(p_manifest, 'utf8'))) loop
		if not (v_open -> 'present') ? (v_object ->> 'sha256') then
			perform public.qorpera_folder_confirm_object(p_env, p_actor, (v_open ->> 'intentId')::uuid, v_object ->> 'sha256',
				(v_object ->> 'bytes')::bigint);
		end if;
	end loop;
	return public.qorpera_folder_seal_upload(p_env, p_actor, (v_open ->> 'intentId')::uuid);
end $$;
-- The files pg_temp.stage made, which were version 1 before C5 and so exempt from possession.
create temp table fixture_files(manifest_sha256 text primary key, manifest_text text not null);
-- The platform stages the text in each folder-v2 environment of the company (an intent is one environment's).
create function pg_temp.stage(p_text text) returns jsonb language plpgsql as $$
declare v_env uuid; v_seal jsonb; v_manifest text := pg_temp.manifest_v2(p_text);
begin
	for v_env in select environment_id from public.qorpera_company_files where profile_id = '63500000-0000-4000-8000-000000000010'
		and core = 'folder-v2' order by environment_id loop
		v_seal := pg_temp.seal_v2(v_env, '{"kind":"platform"}', v_manifest);
		if v_seal ->> 'state' is distinct from 'sealed' then raise exception 'Fixture staging: %', v_seal; end if;
	end loop;
	if v_seal is null then raise exception 'Fixture staging: the company has no folder-v2 environment'; end if;
	insert into pg_temp.fixture_files values (v_seal -> 'file' ->> 'manifestSha256', v_manifest) on conflict do nothing;
	return v_seal -> 'file';
end $$;
-- A version-2 file is held to possession (C1D §3): before an actor other than the platform commits units, it stages
-- each of their files pg_temp.stage made itself, as its own upload would, unless it holds an unexpired sealed intent
-- for it already. A file a test stages any other way is left alone, so tests of possession itself (762) are not
-- touched. An actor that may not stage (42501) or a stopped company (55000) is left to the commit's own refusal; any
-- other error is a fixture defect and surfaces.
create function pg_temp.possess(p_env uuid, p_actor jsonb, p_units jsonb) returns void language plpgsql as $$
declare v_manifest text;
begin
	if p_actor ->> 'kind' is not distinct from 'platform' or jsonb_typeof(p_units) is distinct from 'array' then return; end if;
	for v_manifest in select distinct s.manifest_text from jsonb_array_elements(p_units) u
		cross join lateral (select u -> 'file' as f union all select c -> 'file' from jsonb_array_elements(
			case when jsonb_typeof(u -> 'contents') = 'array' then u -> 'contents' else '[]'::jsonb end) c) refs
		join pg_temp.fixture_files s on s.manifest_sha256 = refs.f ->> 'manifestSha256'
		where not exists (select 1 from public.qorpera_folder_upload_intents i where i.environment_id = p_env
			and i.manifest_sha256 = s.manifest_sha256 and i.state = 'sealed' and i.expires_at > clock_timestamp()
			and i.actor_kind = p_actor ->> 'kind' and i.scope_id = public.qorpera_folder_upload_scope(p_actor)) loop
		begin
			perform pg_temp.seal_v2(p_env, p_actor, v_manifest);
		exception when insufficient_privilege or object_not_in_prerequisite_state then null;
		end;
	end loop;
end $$;

-- A hand-built leased human run of agent A for the member (see 633), committed. Returns the run actor.
create function pg_temp.run() returns jsonb language plpgsql as $$
declare
	v_profile uuid := '63500000-0000-4000-8000-000000000010'; v_env uuid := '63500000-0000-4000-8000-000000000020';
	v_staff uuid := '63500000-0000-4000-8000-0000000000a1'; v_requester uuid := '63500000-0000-4000-8000-000000000002';
	v_run uuid := extensions.gen_random_uuid(); v_job uuid := extensions.gen_random_uuid(); v_wake uuid := extensions.gen_random_uuid();
	v_runner uuid := extensions.gen_random_uuid(); v_assignment uuid := extensions.gen_random_uuid();
	v_session uuid; v_input uuid := extensions.gen_random_uuid();
begin
	set local session_replication_role = replica;
	select id into v_session from public.qorpera_shared_sessions where profile_id = v_profile and staff_agent_id = v_staff::text and status = 'open';
	if v_session is null then
		insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version)
		values (extensions.gen_random_uuid(), v_profile, v_env, 'Agent thread', v_requester, v_staff::text, 1) returning id into v_session;
	end if;
	insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
		runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
	values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_staff, repeat('b', 64), v_run);
	insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
		job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
	values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
		v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '1 hour', v_run);
	insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
		company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
		payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
		audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids)
	values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
		v_staff, 1, v_staff, 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester, 'openai', 'gpt-test',
		'provider_default', 'company', v_staff, repeat('b', 64), v_session, array[v_input]);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
		wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
		sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
	values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
		v_run, 'materialized', v_staff, 1, v_requester, v_staff, 1, v_session, v_wake, array[v_staff],
		jsonb_build_object('inputIds', jsonb_build_array(v_input)));
	set local session_replication_role = origin;
	return jsonb_build_object('kind','run','runId',v_run,'jobId',v_job,'runnerId',v_runner,'assignmentId',v_assignment);
end $$;

select set_config('qorpera_test.run_one', pg_temp.run()::text, false);
select set_config('qorpera_test.run_two', pg_temp.run()::text, false);
select public.qorpera_folder_commit('63500000-0000-4000-8000-000000000020', '{"kind":"platform"}', 'authority-race-setup',
	jsonb_build_array(jsonb_build_object('op','mkdir','path','shared'),
		jsonb_build_object('op','write','path','shared/a.txt','file',pg_temp.stage('alpha')),
		jsonb_build_object('op','mkdir','path','depts'), jsonb_build_object('op','mkdir','path','depts/ops'),
		jsonb_build_object('op','write','path','depts/ops/q.txt','file',pg_temp.stage('ops')),
		jsonb_build_object('op','mkdir','path','misc'), jsonb_build_object('op','write','path','misc/m.txt','file',pg_temp.stage('misc'))));

create function pg_temp.member(p_n integer) returns jsonb language sql as $$
	select jsonb_build_object('kind','member','userId','63500000-0000-4000-8000-00000000000' || p_n)
$$;
create function pg_temp.actor(p_name text) returns jsonb language sql as $$ select current_setting('qorpera_test.' || p_name)::jsonb $$;
-- A commit's SQL for another connection, as its actor, after taking possession of the actor's files in this one.
create function pg_temp.sql_commit(p_actor jsonb, p_key text, p_units jsonb) returns text language plpgsql as $$
begin
	perform pg_temp.possess('63500000-0000-4000-8000-000000000020', p_actor, p_units);
	return format('select public.qorpera_folder_commit(%L, %L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		p_actor::text, p_key, p_units::text);
end $$;
create function pg_temp.commit(p_actor jsonb, p_key text, p_units jsonb) returns jsonb language plpgsql as $$
begin
	perform pg_temp.possess('63500000-0000-4000-8000-000000000020', p_actor, p_units);
	return public.qorpera_folder_commit('63500000-0000-4000-8000-000000000020', p_actor, p_key, p_units);
end $$;
create function pg_temp.sql_mutate(p_call text, variadic p_args text[]) returns text language sql as $$
	select format('select public.qorpera_folder_%s(%s)', p_call,
		(select string_agg(quote_nullable(a), ', ' order by o) from unnest(p_args) with ordinality u(a, o)))
$$;
create function pg_temp.resolved(p_actor jsonb) returns jsonb language sql as $$
	select public.qorpera_folder_run_resolve('63500000-0000-4000-8000-000000000020', '63500000-0000-4000-8000-000000000010', p_actor)
		- 'lockTargets' - 'attribution'
$$;
create function pg_temp.release(p_actor jsonb, p_path text) returns jsonb language sql as $$
	select public.qorpera_folder_record_release('63500000-0000-4000-8000-000000000020', p_actor, extensions.gen_random_uuid(),
		jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority')),
		repeat('0', 64))
	from (select public.qorpera_folder_read('63500000-0000-4000-8000-000000000020', p_actor, p_path) -> 'entry' as e) x
$$;
create function pg_temp.result(p_conn text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	select r into v from dblink_get_result(p_conn) as t(r jsonb);
	perform * from dblink_get_result(p_conn) as t(r jsonb);
	return v;
end $$;
-- Reads a sent statement's error (state and message) or 'ok', and drains the connection.
create function pg_temp.outcome(p_conn text) returns text language plpgsql as $$
declare v_state text := 'ok';
begin
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then v_state := sqlstate || ' ' || sqlerrm;
	end;
	begin
		perform * from dblink_get_result(p_conn) as t(r text);
	exception when others then null;
	end;
	return v_state;
end $$;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['auth_one','auth_two','auth_three']) name;
select dblink_exec(name, $q$set request.jwt.claims = '{"role":"service_role"}'$q$) from unnest(array['auth_one','auth_two','auth_three']) name;
select set_config('qorpera_test.pid_' || name, pid::text, false)
from unnest(array['auth_one','auth_two','auth_three']) name, lateral dblink(name, 'select pg_backend_pid()') as t(pid integer);

create function pg_temp.waits_for(p_waiter text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_waiter)::integer)) then
			return true; end if;
		exit when clock_timestamp() > v_until;
		perform pg_sleep(0.02);
	end loop;
	return false;
end $$;
create function pg_temp.finishes_unblocked(p_conn text, p_holder text) returns boolean language plpgsql as $$
declare v_until timestamptz := clock_timestamp() + interval '60 seconds';
begin
	loop
		if dblink_is_busy(p_conn) = 0 then return true; end if;
		if current_setting('qorpera_test.pid_' || p_holder)::integer = any (pg_blocking_pids(current_setting('qorpera_test.pid_' || p_conn)::integer))
			or clock_timestamp() > v_until then return false; end if;
		perform pg_sleep(0.02);
	end loop;
end $$;

-- A. A narrowing that commits while a commit is deciding is not blocked by it, and refuses it with
-- folder_authority_changed (409); a retry with the same operation key saves. For a member and for a run. The commit is
-- held at rank 1 by another connection holding the member row.
do $$
declare v_state text; v_units jsonb := '[{"op":"mkdir","path":"narrow-member"}]';
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_profile_members
		where user_id = '63500000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
	perform dblink_send_query('auth_two', pg_temp.sql_commit(pg_temp.member(2), 'narrow-member-1', v_units));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The member commit did not reach rank 1'; end if;
	perform dblink_send_query('auth_three', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, 'depts/ops', 'subtree', 'company_shared', 'normal'));
	if not pg_temp.finishes_unblocked('auth_three', 'auth_two') then raise exception 'A narrowing waited for a commit in flight'; end if;
	v_state := pg_temp.outcome('auth_three');
	if v_state <> 'ok' then raise exception 'The narrowing: %', v_state; end if;
	perform dblink_exec('auth_one', 'rollback');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like 'PGRST %"code": "QRC01"%"details": "folder_authority_changed"%' then
		raise exception 'The member commit must refuse with folder_authority_changed, got %', v_state; end if;
	if pg_temp.commit(pg_temp.member(2), 'narrow-member-1', v_units) -> 'units' -> 0 ->> 'outcome' <> 'saved' then
		raise exception 'The retry with the same operation key saves'; end if;
end $$;

do $$
declare v jsonb := pg_temp.actor('run_one'); v_state text; v_units jsonb := '[{"op":"mkdir","path":"narrow-run"}]';
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_profile_members
		where user_id = '63500000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
	perform dblink_send_query('auth_two', pg_temp.sql_commit(v, 'narrow-run-1', v_units));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The run commit did not reach rank 1'; end if;
	perform dblink_send_query('auth_three', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, 'depts/ops', 'exact', 'company_shared', 'normal'));
	if not pg_temp.finishes_unblocked('auth_three', 'auth_two') then raise exception 'A narrowing waited for a run commit in flight'; end if;
	v_state := pg_temp.outcome('auth_three');
	if v_state <> 'ok' then raise exception 'The narrowing: %', v_state; end if;
	perform dblink_exec('auth_one', 'rollback');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like 'PGRST %folder_authority_changed%' then
		raise exception 'The run commit must refuse with folder_authority_changed, got %', v_state; end if;
	if pg_temp.commit(v, 'narrow-run-1', v_units) -> 'units' -> 0 ->> 'outcome' <> 'saved' then
		raise exception 'The run retry with the same operation key saves'; end if;
end $$;

-- B. A widening in the same window aborts nothing.
do $$
declare v_state text; r jsonb;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', $q$select 1 from public.qorpera_profile_members
		where user_id = '63500000-0000-4000-8000-000000000002' for update$q$) as t(x integer);
	perform dblink_send_query('auth_two', pg_temp.sql_commit(pg_temp.member(2), 'widen-member-1', '[{"op":"mkdir","path":"widen"}]'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The commit did not reach rank 1'; end if;
	perform dblink_send_query('auth_three', format('select public.qorpera_folder_grant(%L, %L, r.id, %L, %L, %L) from public.qorpera_company_path_resources r
		where r.environment_id = %L and r.path = %L', '63500000-0000-4000-8000-000000000020', pg_temp.member(1), 'staff_agent',
		'63500000-0000-4000-8000-0000000000a1', array['read','write'], '63500000-0000-4000-8000-000000000020', 'depts/ops'));
	if not pg_temp.finishes_unblocked('auth_three', 'auth_two') then raise exception 'A widening waited for a commit in flight'; end if;
	v_state := pg_temp.outcome('auth_three');
	if v_state <> 'ok' then raise exception 'The widening: %', v_state; end if;
	perform dblink_exec('auth_one', 'rollback');
	v_state := pg_temp.outcome('auth_two');
	if v_state <> 'ok' then raise exception 'A widening aborts nothing, got %', v_state; end if;
	if not exists (select 1 from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020'
		and key_text = 'widen') then raise exception 'The commit beside a widening saved'; end if;
end $$;

-- C. The clock orders authority: a revoke in flight while a commit holds the clock is ordered after that commit. A
-- commit that decided before the revoke and waits too is ordered either way: before the revoke it saves with the
-- lower clock value; after it, it refuses, and its retry saves. (It already holds the clock row KEY SHARE through
-- its foreign keys, so PostgreSQL wakes it with the revoke rather than behind it.)
do $$
declare v_state text; v_units jsonb := '[{"op":"mkdir","path":"after-revoke"}]'; v_grant uuid; r jsonb; v_revoke_seq bigint;
begin
	select g.id into v_grant from public.qorpera_company_path_grants g join public.qorpera_company_path_resources r on r.id = g.resource_id
	where r.environment_id = '63500000-0000-4000-8000-000000000020' and r.path = 'depts/ops' and g.revoked_at is null;
	-- A member's commit holds the clock until its transaction ends.
	perform dblink_exec('auth_one', 'begin');
	select t.r into r from dblink('auth_one', pg_temp.sql_commit(pg_temp.member(2), 'holds-clock-1', '[{"op":"mkdir","path":"holds-clock"}]'))
		as t(r jsonb);
	if r -> 'units' -> 0 ->> 'outcome' <> 'saved' then raise exception 'The clock holder: %', r; end if;
	perform dblink_send_query('auth_two', pg_temp.sql_mutate('revoke', '63500000-0000-4000-8000-000000000020', pg_temp.member(1)::text,
		(select resource_id::text from public.qorpera_company_path_grants where id = v_grant), v_grant::text));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The revoke did not queue on the clock'; end if;
	perform dblink_send_query('auth_three', pg_temp.sql_commit(pg_temp.member(2), 'after-revoke-1', v_units));
	if not pg_temp.waits_for('auth_three', 'auth_one') then raise exception 'The commit did not wait for the clock holder'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state <> 'ok' then raise exception 'The revoke: %', v_state; end if;
	v_state := pg_temp.outcome('auth_three');
	v_revoke_seq := (select max(seq) from public.qorpera_folder_journal where environment_id = '63500000-0000-4000-8000-000000000020'
		and kind = 'authority');
	if v_revoke_seq <= (select seq from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020'
		and operation_key = 'holds-clock-1') then raise exception 'The revoke is ordered after the commit holding the clock'; end if;
	if v_state = 'ok' then
		if (select seq from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020'
			and operation_key = 'after-revoke-1') > v_revoke_seq then
			raise exception 'A commit that saved after a narrowing it decided before'; end if;
	elsif v_state not like 'PGRST %folder_authority_changed%' then
		raise exception 'A commit ordered after the revoke refuses, got %', v_state;
	elsif pg_temp.commit(pg_temp.member(2), 'after-revoke-1', v_units) -> 'units' -> 0 ->> 'outcome' <> 'saved' then
		raise exception 'The retry after the revoke saves'; end if;
end $$;

-- D. A recheck re-stamps with the values it captured: a narrowing that commits between its capture and its re-stamp is
-- not stamped as checked, and the next recheck catches it. The re-stamp is held by another connection holding the row.
select pg_temp.release(pg_temp.actor('run_two'), 'shared/a.txt');
select public.qorpera_folder_set_resource('63500000-0000-4000-8000-000000000020', pg_temp.member(1), 'misc', 'subtree', 'company_shared', 'normal');
do $$
declare v jsonb := pg_temp.actor('run_two'); v_state text;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format('select 1 from public.qorpera_folder_run_reads where run_id = %L for update',
		v ->> 'runId')) as t(x integer);
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_run_reads_current(%L, %L, %L)',
		'63500000-0000-4000-8000-000000000020', '63500000-0000-4000-8000-000000000010', pg_temp.resolved(v)));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The re-stamp did not wait for the row'; end if;
	-- The narrowing: a resource over shared/, which agent A has no grant on.
	perform dblink_send_query('auth_three', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, 'shared', 'subtree', 'company_shared', 'normal'));
	if not pg_temp.finishes_unblocked('auth_three', 'auth_two') then raise exception 'The narrowing waited for a recheck'; end if;
	v_state := pg_temp.outcome('auth_three');
	if v_state <> 'ok' then raise exception 'The narrowing: %', v_state; end if;
	perform dblink_exec('auth_one', 'rollback');
	v_state := pg_temp.outcome('auth_two');
	if v_state <> 'ok' then raise exception 'The first recheck passed before the narrowing: %', v_state; end if;
	begin
		perform public.qorpera_folder_run_reads_current('63500000-0000-4000-8000-000000000020', '63500000-0000-4000-8000-000000000010',
			pg_temp.resolved(v));
		raise exception 'The next recheck must catch the narrowing' using errcode = 'QTF02';
	exception when sqlstate '42501' then null;
	end;
end $$;

-- E. Two rechecks of one run take its read-set rows in one order: the second waits for the first, and neither deadlocks.
select public.qorpera_folder_grant('63500000-0000-4000-8000-000000000020', pg_temp.member(1),
	(select id from public.qorpera_company_path_resources where environment_id = '63500000-0000-4000-8000-000000000020' and path = 'depts/ops'),
	'staff_agent', '63500000-0000-4000-8000-0000000000a1', array['read']);
select pg_temp.release(pg_temp.actor('run_one'), 'depts/ops/q.txt');
select public.qorpera_folder_grant('63500000-0000-4000-8000-000000000020', pg_temp.member(1),
	(select id from public.qorpera_company_path_resources where environment_id = '63500000-0000-4000-8000-000000000020' and path = 'misc'),
	'staff_agent', '63500000-0000-4000-8000-0000000000a1', array['read']);
select pg_temp.release(pg_temp.actor('run_one'), 'misc/m.txt');
select public.qorpera_folder_set_resource('63500000-0000-4000-8000-000000000020', pg_temp.member(1), 'depts/ops', 'subtree', 'company_shared', 'normal');
select public.qorpera_folder_set_resource('63500000-0000-4000-8000-000000000020', pg_temp.member(1), 'misc', 'exact', 'company_shared', 'normal');
do $$
declare v jsonb := pg_temp.actor('run_one'); v_state text; v_sql text;
begin
	if (select count(*) from public.qorpera_folder_run_reads where run_id = (v ->> 'runId')::uuid) < 2 then
		raise exception 'The run needs two read-set rows'; end if;
	v_sql := format('select public.qorpera_folder_run_reads_current(%L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		'63500000-0000-4000-8000-000000000010', pg_temp.resolved(v));
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', v_sql) as t(n integer);
	perform dblink_send_query('auth_two', v_sql);
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second recheck did not wait for the first'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state <> 'ok' then raise exception 'Concurrent rechecks: %', v_state; end if;
end $$;

-- F. A concurrent tie between 'Østen' and 'østen' is refused once: the second call waited for the parent and finds the
-- first one's resource on its key.
do $$
declare v_state text;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020', pg_temp.member(1)::text,
		'places/Østen', 'subtree', 'company_shared', 'normal')) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, 'places/østen', 'subtree', 'company_shared', 'normal'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second call did not wait for the parent'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like '23505 %' then raise exception 'A concurrent tie must be refused, got %', v_state; end if;
	if (select count(*) from public.qorpera_company_path_resources where environment_id = '63500000-0000-4000-8000-000000000020'
		and public.qorpera_folder_key(path) = public.qorpera_folder_key('places/østen')) <> 1 then
		raise exception 'One resource on the key'; end if;
end $$;

-- G. A narrower resource made over the path while a new resource waited for its parent: the new one refuses with
-- folder_authority_changed, and its retry narrows the new parent.
do $$
declare v_state text;
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020', pg_temp.member(1)::text,
		'area', 'subtree', 'company_shared', 'normal')) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1)::text, 'area/inner', 'subtree', 'company_shared', 'normal'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The inner resource did not wait for the root'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like 'PGRST %folder_authority_changed%' then
		raise exception 'A new resource whose parent changed refuses, got %', v_state; end if;
	perform public.qorpera_folder_set_resource('63500000-0000-4000-8000-000000000020', pg_temp.member(1), 'area/inner', 'subtree',
		'company_shared', 'normal');
	if (select authority_revision from public.qorpera_company_path_resources where environment_id = '63500000-0000-4000-8000-000000000020'
		and path = 'area') <> 2 then raise exception 'The retry narrows the new parent'; end if;
end $$;

-- H. Two grants for one agent on one resource take turns: the second replaces the first, and one grant stays live.
do $$
declare v_state text; v_res uuid;
begin
	select id into v_res from public.qorpera_company_path_resources where environment_id = '63500000-0000-4000-8000-000000000020' and path = 'area';
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1), v_res, 'staff_agent', '63500000-0000-4000-8000-0000000000a1', array['read','write'])) as t(r jsonb);
	perform dblink_send_query('auth_two', format('select public.qorpera_folder_grant(%L, %L, %L, %L, %L, %L)', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(1), v_res, 'staff_agent', '63500000-0000-4000-8000-0000000000a1', array['read']));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second grant did not wait for the first'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state <> 'ok' then raise exception 'The second grant: %', v_state; end if;
	if (select jsonb_agg(to_jsonb(permissions)) from public.qorpera_company_path_grants where resource_id = v_res
		and principal_kind = 'staff_agent' and principal_id = '63500000-0000-4000-8000-0000000000a1' and revoked_at is null)
		is distinct from '[["read"]]'::jsonb then
		raise exception 'One live grant, the second: %', (select jsonb_agg(to_jsonb(g)) from public.qorpera_company_path_grants g
			where g.resource_id = v_res); end if;
end $$;

-- I. Two private folders whose keys differ only in Unicode, where nothing covers them yet: the calls take turns on
-- the root, and the second is refused as a tie.
do $$
declare v_state text; c_private constant text := 'members/63500000-0000-4000-8000-000000000002/private';
begin
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020', pg_temp.member(2)::text,
		c_private || '/Østen', 'subtree', 'member_private', 'normal')) as t(r jsonb);
	perform dblink_send_query('auth_two', pg_temp.sql_mutate('set_resource', '63500000-0000-4000-8000-000000000020',
		pg_temp.member(2)::text, c_private || '/østen', 'subtree', 'member_private', 'normal'));
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second private folder did not wait'; end if;
	perform dblink_exec('auth_one', 'commit');
	v_state := pg_temp.outcome('auth_two');
	if v_state not like '23505 %' then raise exception 'A concurrent private tie must be refused, got %', v_state; end if;
end $$;

-- J. Two releases with one id at once: the second waits for the first and then replays its result.
do $$
declare v jsonb := pg_temp.actor('run_one'); v_sql text; v_rel uuid := extensions.gen_random_uuid(); r jsonb;
begin
	v_sql := format('select public.qorpera_folder_record_release(%L, %L, %L, %L, %L)', '63500000-0000-4000-8000-000000000020', v, v_rel,
		(select jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'version', e ->> 'version', 'authority', e -> 'authority'))
			from (select public.qorpera_folder_read('63500000-0000-4000-8000-000000000020', v, 'depts/ops/q.txt') -> 'entry' as e) x),
		repeat('0', 64));
	perform dblink_exec('auth_one', 'begin');
	perform * from dblink('auth_one', v_sql) as t(r jsonb);
	perform dblink_send_query('auth_two', v_sql);
	if not pg_temp.waits_for('auth_two', 'auth_one') then raise exception 'The second release did not wait for the first'; end if;
	perform dblink_exec('auth_one', 'commit');
	r := pg_temp.result('auth_two');
	if (r ->> 'replay')::boolean is not true then raise exception 'The second release replays: %', r; end if;
end $$;

select dblink_disconnect(name) from unnest(array['auth_one','auth_two','auth_three']) name;

-- The committed fixture leaves the shared suite database.
set session_replication_role = replica;
delete from public.qorpera_folder_authority_changes where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_reads where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_read_records where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_run_releases where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_journal where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_reviews where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_operation_keys where environment_id = '63500000-0000-4000-8000-000000000020';
delete from public.qorpera_wake_occurrences where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_runs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_runner_jobs where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_session_inputs where session_id in (select id from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010');
delete from public.qorpera_shared_sessions where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_execution_sponsor_versions where binding_id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_execution_sponsor_bindings where id = '63500000-0000-4000-8000-0000000000a1';
delete from public.qorpera_provider_connections where id = '63500000-0000-4000-8000-0000000000b3';
set session_replication_role = origin;
-- With triggers on: version-2 objects are catalog rows of the object gateway (no Storage mirror, no link to the company),
-- so they go by hand, with their proofs and chunk rows; the intents go with the company.
delete from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010';
delete from public.qorpera_profiles where id = '63500000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63500000-0000-4000-8000-000000000010/%';
delete from auth.users where id in ('63500000-0000-4000-8000-000000000001','63500000-0000-4000-8000-000000000002');
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63500000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_execution_runs where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from storage.objects where name like '63500000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63500000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '63500000-0000-4000-8000-000000000010') then
		raise exception 'The race fixture must be removed'; end if;
end $$;
