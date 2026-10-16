-- The folder core's load test (C1e, deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §9), its fixture: run after 648's
-- committed fixture (one folder-v2 company, its login, Ada's leased human run) in the same session, so 648's pg_temp
-- helpers (stage, commit, hire, entry) serve it. scripts/load-folder-core.mjs sets loadfolder.runs, loadfolder.big
-- and loadfolder.big_paths first. It leaves, committed:
-- * loadfolder.runs: one leased human run per load agent, each acknowledged, with its actor and binding;
-- * the tree: load/shared (20 folders of 50 files), load/restricted (50 files), load/work/<agent> per agent, and
--   load/big (loadfolder.big_paths files, 500 a folder) when loadfolder.big is on;
-- * resources: load (every load agent may read and write), load/restricted (no agent, until the ACL client grants one),
--   load/big (the big run's agent may read);
-- * the big run's read set: every file under load/big, read and released (10,000 per release, the runtime's cap);
-- * GC candidates: 40 objects that lost their roots 25 hours ago (loadfolder.gc_texts), which writers write again
--   while GC claims them; the sweep has 20 intents expired over an hour ago.
-- A persisted helper in schema loadfolder builds a file's manifest as the gateway does, so the load connections can call
-- it.

create schema loadfolder;
create table loadfolder.runs(n integer primary key, agent uuid not null, handle text not null, actor jsonb not null,
	binding jsonb not null, big boolean not null default false);
create table loadfolder.gc_texts(n integer primary key, text text not null, sha256 text not null);

-- A text's version-2 manifest (one chunk), as the object gateway builds it. The load's uploads open with it, then
-- confirm and seal in calls of their own, as the gateway does.
create function loadfolder.manifest(p_text text) returns text language sql immutable as $$
	select format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"text/markdown","executable":false,"chunks":[%s]}',
		encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'), octet_length(convert_to(p_text, 'utf8')),
		case when p_text = '' then '' else format('{"sha256":"%s","bytes":%s}', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'),
			octet_length(convert_to(p_text, 'utf8'))) end)
$$;

-- The login admits every load run (its limits are 64 native leases and 128 calls a run; the runs below go in by hand).
set session_replication_role = replica;
update public.qorpera_provider_connection_versions set max_native_concurrency = 64,
	quota_policy = quota_policy || '{"max_concurrent_runs":200,"max_calls_per_run":128}', allow_autonomous = true
where connection_id = '64800000-0000-4000-8000-0000000000b3';
update public.qorpera_execution_sponsor_versions set allow_autonomous = true where binding_id = '64800000-0000-4000-8000-0000000000b1';
set session_replication_role = origin;

-- The load agents, hired in one commit.
select pg_temp.expect(pg_temp.commit('{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', 'load-hire',
	(select jsonb_agg(pg_temp.hire('load-' || n, ('6480a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Load ' || n) order by n)
		from generate_series(1, current_setting('loadfolder.runs')::integer) n)), 1, 'saved') \g /dev/null

-- One leased human run per load agent in its own thread, as 648's run of Ada, acknowledged (its tool calls may work).
set session_replication_role = replica;
do $$
declare
	v_profile uuid := '64800000-0000-4000-8000-000000000010'; v_env uuid := '64800000-0000-4000-8000-000000000020';
	v_requester uuid := '64800000-0000-4000-8000-000000000002'; v_runner uuid := '64800000-0000-4000-8000-0000000000f4';
	v_bundle uuid; v_bundle_sha256 text; v_policy jsonb;
	v_staff uuid; v_run uuid; v_job uuid; v_wake uuid; v_assignment uuid; v_lease uuid; v_session uuid; v_input uuid; v_event uuid;
	n integer;
begin
	-- The active runtime bundle: the context fence checks that a run's bundle is executable.
	-- With triggers off, the run's reasoning effort, policy hash and service tier are set here as its insert triggers
	-- set them (a member's Codex turn runs Fast under a bundle with fast mode).
	select bundle.id, bundle.sha256, bundle.manifest -> 'modelPolicy' into strict v_bundle, v_bundle_sha256, v_policy
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id;
	for n in 1 .. current_setting('loadfolder.runs')::integer loop
		v_staff := ('6480a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
		v_run := extensions.gen_random_uuid(); v_job := extensions.gen_random_uuid(); v_wake := extensions.gen_random_uuid();
		v_assignment := extensions.gen_random_uuid(); v_lease := extensions.gen_random_uuid(); v_session := extensions.gen_random_uuid();
		v_input := extensions.gen_random_uuid(); v_event := extensions.gen_random_uuid();
		insert into public.qorpera_shared_sessions(id, profile_id, environment_id, title, created_by_user_id, staff_agent_id, staff_version,
			audience_kind)
		values (v_session, v_profile, v_env, 'Load ' || n, v_requester, v_staff::text,
			(select version from public.qorpera_profile_staff where profile_id = v_profile and staff_agent_id = v_staff), 'company');
		insert into public.qorpera_session_inputs(id, session_id, client_input_id, author_user_id, actor_kind, kind,
			runtime_bundle_id, runtime_bundle_sha256, execution_run_id)
		values (v_input, v_session, extensions.gen_random_uuid(), v_requester, 'human', 'user_message', v_bundle, v_bundle_sha256, v_run);
		insert into public.qorpera_runner_jobs(id, profile_id, environment_id, substrate_version_id, client_job_id, required_capability,
			job_type, payload, created_by_user_id, status, runner_id, client_lease_id, lease_token_sha256, lease_expires_at, run_id)
		values (v_job, v_profile, v_env, extensions.gen_random_uuid(), extensions.gen_random_uuid(), 'agent_turn', 'agent_turn', '{}',
			v_requester, 'leased', v_runner, v_assignment, repeat('a', 64), clock_timestamp() + interval '2 hours', v_run);
		insert into public.qorpera_execution_runs(id, profile_id, environment_id, source_kind, source_id, job_id, substrate_version_id,
			company_snapshot_id, staff_agent_id, staff_version, sponsor_binding_id, sponsor_version, required_capability, job_type,
			payload_sha256, transcript_start_sequence, created_by_user_id, requested_by_user_id, model_provider, model_id, model_selection,
			audience_kind, runtime_bundle_id, runtime_bundle_sha256, session_id, input_ids, compute_identity_id, reasoning_effort,
			reasoning_policy_sha256, service_tier)
		values (v_run, v_profile, v_env, 'session_turn', v_input, v_job, extensions.gen_random_uuid(), extensions.gen_random_uuid(),
			v_staff, 1, '64800000-0000-4000-8000-0000000000b1', 1, 'agent_turn', 'agent_turn', repeat('c', 64), 0, v_requester, v_requester,
			'openai', 'gpt-test', 'provider_default', 'company', v_bundle, v_bundle_sha256, v_session, array[v_input],
			'64800000-0000-4000-8000-0000000000d1', v_policy ->> 'effort',
			encode(extensions.digest(convert_to(v_policy::text, 'utf8'), 'sha256'), 'hex'),
			case when v_policy ->> 'fastMode' = 'thread' then 'fast' end);
		insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, trigger_id, occurrence_key, scheduled_for, not_before,
			wake_kind, source_kind, source_id, run_id, status, staff_agent_id, staff_version, requested_by_user_id, sponsor_binding_id,
			sponsor_version, session_id, causal_root_id, causal_agent_ids, payload)
		values (v_wake, v_profile, v_env, 'input', v_wake::text, clock_timestamp(), clock_timestamp(), 'human', 'input', v_input,
			v_run, 'materialized', v_staff, 1, v_requester, '64800000-0000-4000-8000-0000000000b1', 1, v_session, v_wake, array[v_staff],
			jsonb_build_object('inputIds', jsonb_build_array(v_input)));
		insert into public.qorpera_runner_assignments(id, claim_id, job_id, run_id, runner_id, capability_sha256, status, expires_at, accepted_at)
		values (v_assignment, extensions.gen_random_uuid(), v_job, v_run, v_runner, repeat('e', 64), 'accepted',
			clock_timestamp() + interval '2 hours', clock_timestamp());
		insert into public.qorpera_native_provider_connection_leases(id, run_id, job_id, provider_connection_id, provider_connection_version,
			credential_capsule_id, compute_identity_id, runner_id, assignment_id, lease_token_sha256, expires_at)
		values (v_lease, v_run, v_job, '64800000-0000-4000-8000-0000000000b3', 1, '64800000-0000-4000-8000-0000000000d2',
			'64800000-0000-4000-8000-0000000000d1', v_runner, v_assignment, repeat('d', 64), clock_timestamp() + interval '2 hours');
		insert into public.qorpera_execution_sponsor_reservations(run_id, job_id, profile_id, binding_id, sponsor_version, provider_connection_id,
			provider_connection_version, period_start, reserved_microusd)
		values (v_run, v_job, v_profile, '64800000-0000-4000-8000-0000000000b1', 1, '64800000-0000-4000-8000-0000000000b3', 1,
			date_trunc('month', clock_timestamp()), 1);
		insert into public.qorpera_runner_model_policies(job_id, profile_id, environment_id, allowed_models, max_calls, max_input_tokens,
			max_output_tokens, authorized_by_user_id)
		values (v_job, v_profile, v_env, '["gpt-test"]', 32, 1000, 1000, v_requester);
		insert into public.qorpera_execution_run_budgets(run_id) values (v_run);
		-- The run's acknowledgement, as a progress send and its session event (the wake's work gate reads both), as 651.
		insert into public.qorpera_session_events(session_id, sequence, event_id, event_type, actor_user_id, body, event_hash, created_at,
			execution_kind, execution_id, execution_claimant_id, runner_assignment_id)
		values (v_session, 1, v_event, 'message', v_requester, '{"schema":"qorpera.runner-transcript-entry/v1"}', repeat('0', 64),
			statement_timestamp(), 'run', v_run, v_run, v_assignment);
		insert into public.qorpera_agent_sends(event_id, run_id, session_id, assignment_id, idempotency_key, phase, text_sha256, body_sha256)
		values (v_event, v_run, v_session, v_assignment, 'ack', 'progress', repeat('1', 64), repeat('2', 64));
		insert into loadfolder.runs(n, agent, handle, actor, binding, big) values (n, v_staff, 'load-' || n,
			jsonb_build_object('kind', 'run', 'runId', v_run, 'jobId', v_job, 'runnerId', v_runner, 'assignmentId', v_assignment),
			jsonb_build_object('leaseId', v_lease, 'runId', v_run, 'jobId', v_job, 'runnerId', v_runner, 'assignmentId', v_assignment,
				'credentialCapsuleId', '64800000-0000-4000-8000-0000000000d2', 'computeIdentityId', '64800000-0000-4000-8000-0000000000d1',
				'provider', 'openai', 'nativeHarness', 'codex-cli', 'model', 'gpt-test'),
			n = 1 and current_setting('loadfolder.big')::boolean);
	end loop;
end $$;
set session_replication_role = origin;

-- The tree, as the platform writes it. Files of one text share their bytes.
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'load-tree-0', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'load'), jsonb_build_object('op', 'mkdir', 'path', 'load/shared'),
	jsonb_build_object('op', 'mkdir', 'path', 'load/work'), jsonb_build_object('op', 'mkdir', 'path', 'load/big'))), 1, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'load-tree-' || d, jsonb_build_array(jsonb_build_object('op', 'new_folder',
	'path', 'load/shared/d' || d, 'contents', (select jsonb_agg(jsonb_build_object('path', 'f' || f || '.md', 'kind', 'file',
		'file', pg_temp.stage('Shared file ' || d || '/' || f || E'.\n'))) from generate_series(1, 50) f)))), 1, 'saved')
from generate_series(1, 20) d \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'load-tree-restricted', jsonb_build_array(jsonb_build_object('op', 'new_folder',
	'path', 'load/restricted', 'contents', (select jsonb_agg(jsonb_build_object('path', 'r' || f || '.md', 'kind', 'file',
		'file', pg_temp.stage('Restricted file ' || f || E'.\n'))) from generate_series(1, 50) f)))), 1, 'saved') \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'load-tree-work', (select jsonb_agg(jsonb_build_object('op', 'mkdir',
	'path', 'load/work/' || handle) order by n) from loadfolder.runs)), 1, 'saved') \g /dev/null
select pg_temp.stage(E'Big file.\n') \g /dev/null
select pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'load-big-' || b, jsonb_build_array(jsonb_build_object('op', 'new_folder',
	'path', 'load/big/b' || b, 'contents', (select jsonb_agg(jsonb_build_object('path', 'f' || f || '.md', 'kind', 'file',
		'file', pg_temp.stage(E'Big file.\n'))) from generate_series(1, 500) f)))), 1, 'saved')
from generate_series(1, current_setting('loadfolder.big_paths')::integer / 500) b where current_setting('loadfolder.big')::boolean \g /dev/null

-- The resources: load (every load agent reads and writes), load/restricted (no grant yet), load/big (the big agent).
select public.qorpera_folder_set_resource('64800000-0000-4000-8000-000000000020',
	'{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}', path, 'subtree', 'company_shared', 'normal')
from unnest(array['load', 'load/restricted', 'load/big']) path \g /dev/null
select public.qorpera_folder_grant('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}',
	(select id from public.qorpera_company_path_resources where environment_id = '64800000-0000-4000-8000-000000000020' and path = 'load'),
	'staff_agent', agent, array['read', 'write'])
from loadfolder.runs order by n \g /dev/null
select public.qorpera_folder_grant('64800000-0000-4000-8000-000000000020', '{"kind":"member","userId":"64800000-0000-4000-8000-000000000001"}',
	(select id from public.qorpera_company_path_resources where environment_id = '64800000-0000-4000-8000-000000000020' and path = 'load/big'),
	'staff_agent', agent, array['read'])
from loadfolder.runs where big \g /dev/null

-- The big run's read set: every file under load/big, released 10,000 at a time (the runtime's cap). One read gives the
-- receipt every one of them carries (one resource, one grant); their versions come from the folder.
do $$
declare v_run loadfolder.runs%rowtype; v_receipt jsonb; v_chunk jsonb;
begin
	select * into v_run from loadfolder.runs where big;
	if not found then return; end if;
	v_receipt := public.qorpera_folder_read('64800000-0000-4000-8000-000000000020', v_run.actor, 'load/big/b1/f1.md') -> 'entry' -> 'authority';
	if v_receipt is null then raise exception 'The big run cannot read load/big'; end if;
	for v_chunk in
		select jsonb_agg(jsonb_build_object('path', e.path, 'version', e.version, 'authority', v_receipt) order by e.n)
		from (select entry.path, entry.version, (row_number() over (order by entry.key_text) - 1) / 10000 as chunk,
				row_number() over (order by entry.key_text) as n
			from public.qorpera_folder_entries entry
			where entry.environment_id = '64800000-0000-4000-8000-000000000020' and entry.kind = 'file'
				and entry.key_text like 'load/big/%') e
		group by e.chunk order by e.chunk
	loop
		perform public.qorpera_folder_record_release('64800000-0000-4000-8000-000000000020', v_run.actor,
			extensions.gen_random_uuid(), v_chunk, repeat('0', 64));
	end loop;
end $$;

-- GC candidates: 40 objects whose intents went and that lost their roots 25 hours ago (past the 24-hour grace), on the
-- gateway's backend; writers write their texts again while GC claims them.
insert into loadfolder.gc_texts(n, text, sha256)
select n, 'Collectable ' || n || E'.\n', encode(extensions.digest(convert_to('Collectable ' || n || E'.\n', 'utf8'), 'sha256'), 'hex')
from generate_series(1, 40) n;
select pg_temp.stage(text) from loadfolder.gc_texts order by n \g /dev/null
set session_replication_role = replica;
update public.qorpera_profile_objects set backend = 'nas-object-gateway'
where profile_id = '64800000-0000-4000-8000-000000000010' and sha256 in (select sha256 from loadfolder.gc_texts
	union all select encode(extensions.digest(convert_to(loadfolder.manifest(text), 'utf8'), 'sha256'), 'hex') from loadfolder.gc_texts);
delete from public.qorpera_folder_upload_intents i where exists (select 1 from public.qorpera_folder_upload_intent_objects o
	join loadfolder.gc_texts t on o.sha256 in (t.sha256, encode(extensions.digest(convert_to(loadfolder.manifest(t.text), 'utf8'), 'sha256'), 'hex'))
	where o.intent_id = i.id);
insert into public.qorpera_folder_object_gc(profile_id, sha256, unreferenced_since)
select '64800000-0000-4000-8000-000000000010', s, clock_timestamp() - interval '25 hours'
from loadfolder.gc_texts t, lateral (values (t.sha256),
	(encode(extensions.digest(convert_to(loadfolder.manifest(t.text), 'utf8'), 'sha256'), 'hex'))) v(s)
on conflict do nothing;
-- The sweep's work: 20 intents of shared files, expired over an hour ago.
update public.qorpera_folder_upload_intents set expires_at = clock_timestamp() - interval '2 hours'
where id in (select id from public.qorpera_folder_upload_intents where environment_id = '64800000-0000-4000-8000-000000000020'
	and state = 'sealed' order by created_at limit 20);
set session_replication_role = origin;

do $$
begin
	if (select count(*) from loadfolder.runs) <> current_setting('loadfolder.runs')::integer then
		raise exception 'The fixture made % of % load runs', (select count(*) from loadfolder.runs), current_setting('loadfolder.runs'); end if;
	if (select count(*) from public.qorpera_folder_object_gc where profile_id = '64800000-0000-4000-8000-000000000010') < 40 then
		raise exception 'The fixture made too few GC candidates'; end if;
end $$;
-- Every load run passes the context fence's run checks, and records its native launch (as 715's run does) before the
-- load: the context view needs the launch's provenance.
do $$
declare v_row loadfolder.runs%rowtype; v_run public.qorpera_execution_runs%rowtype; v_identity jsonb;
begin
	for v_row in select * from loadfolder.runs order by n loop
		begin
			v_identity := public.qorpera_describe_native_tool_authority(v_row.binding) -> 'identity';
			perform public.qorpera_begin_native_company_execution_v2(v_row.binding,
				(select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
				v_identity ->> 'runtimeBundleSha256', v_identity ->> 'reasoningPolicySha256',
				'{"type":"namespace","name":"qorpera","description":"Synthetic native fixture","tools":[{"type":"function","name":"read_document","description":"Read synthetic data","inputSchema":{"type":"object","additionalProperties":false}}]}',
				repeat('c', 64), 10);
		exception when others then
			select * into v_run from public.qorpera_execution_runs where id = (v_row.binding ->> 'runId')::uuid;
			raise exception 'Load run % fails the tool authority or its launch: % (effort %, policy %, manifest policy %)', v_row.n, sqlerrm,
				v_run.reasoning_effort, v_run.reasoning_policy_sha256, public.qorpera_execution_runtime_manifest(v_run) -> 'modelPolicy';
		end;
	end loop;
end $$;
