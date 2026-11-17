-- @fixture 1246_home_exec_sessions.test.sql until "-- 1. The switch is off ---"
-- 20260930770000 (Claude Code on the agent's home, slice C4a): a plain worker that Claude Code does, on a member's word,
-- on that member's own Claude plan. On 1246's fixture (924's base: Alice's live run for the owner, a real binding; 1241's
-- machine node and executor), with the shared vault serving the company as 564 sets it up:
-- 1. The brief: a plain brief may name harness claude-code and no other; a coding brief is unchanged.
-- 2. The refusals at the dispatch, each in its words and with nothing written: harness codex on a plain worker; no
--    member behind the ask (a routine at the root of the run's chain); the member not on the Claude list; the sign-in
--    not open in the company; no active Claude login (none, or signed out); the agent's machine not running for the
--    member's work.
-- 3. The accepted dispatch: the worker row names the harness and the member's Claude login (the payer, fixed: a newer
--    sign-in later does not move it); no wake yet; the replay answers the same.
-- 4. The drain starts it with a wake that names the harness, and takes the member's lease under that wake's id; a second
--    Claude Code worker of the same member waits (not due, no wake) while the first's lease is live, and so does it while
--    the first's run is leased; when that run dies (its job failed, as the reaper fails a lost one) the second starts and
--    the lease is its; a worker cancelled before its run ends its lease too, and a plain worker beside them never waits.
-- 5. A follow-up: by the same member, it records that member's login as it is now; by another member, it is refused.
--    More Claude Code workers of that member waiting than a drain takes at once never hold back a newer plain worker.
-- 6. Nothing here is the API's: no role but the database's own may call the new functions or touch the lease table.

select pg_temp.base_claims('service_role');

-- The shared vault serves the company (564's set-up) ----------------------------------------------------------------
insert into public.qorpera_cloud_secret_broker_principals(id, service_origin, key_id, capability_sha256,
	registers_companies_created_after)
values ('12680000-0000-4000-8000-000000000050', 'https://vault.qorpera.test', 'vault-root-1', repeat('a', 64),
	'2099-01-01 00:00:00+00');
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256,
	principal_id)
values ('12680000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://vault.qorpera.test',
	'vault-root-1', repeat('c', 64), '12680000-0000-4000-8000-000000000050');
insert into public.qorpera_model_login_sign_in_companies(profile_id) values ('92400000-0000-4000-8000-000000000010');
update public.qorpera_account_model_login_settings set enabled = true;

-- BEGIN C4 HELPERS
-- The member Alice's run works for (its requester): the one whose Claude plan pays, and the name the refusals say.
create function pg_temp.c4_owner_id() returns uuid language sql stable as $$
	select run.requested_by_user_id from public.qorpera_execution_runs run
	where run.id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid
$$;
create function pg_temp.c4_name() returns text language sql stable as $$
	select display_name from public.qorpera_profile_members
	where profile_id = '92400000-0000-4000-8000-000000000010' and user_id = pg_temp.c4_owner_id()
$$;
-- A refusal's words for this member.
create function pg_temp.c4_words(p_words text) returns text language sql stable as $$
	select replace(p_words, '<member>', pg_temp.c4_name())
$$;
-- A Claude login of a member, sealed files made up (never a real sign-in), as the vault's completion writes it.
create function pg_temp.c4_login(p_id uuid, p_user uuid, p_canary text default 'canary-c4') returns uuid language plpgsql as $$
begin
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null
	where owner_user_id = p_user and status = 'active';
	insert into public.qorpera_claude_logins(id, owner_user_id, principal_id, client_connection_id, key_id, encrypted_envelope,
		envelope_sha256, provider_account_email)
	values (p_id, p_user, '12680000-0000-4000-8000-000000000050', extensions.gen_random_uuid(), 'vault-root-1',
		convert_to(p_canary, 'UTF8'), encode(extensions.digest(convert_to(p_canary, 'UTF8'), 'sha256'), 'hex'),
		'owner@example.test');
	return p_id;
end $$;
-- A run's actor, as the native host's folder calls send it.
create function pg_temp.c4_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding ->> 'runId', 'jobId', p_binding ->> 'jobId',
		'runnerId', p_binding ->> 'runnerId', 'assignmentId', p_binding ->> 'assignmentId')
$$;
create function pg_temp.c4_alice() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
-- A plain brief as the parser gives it, with the platform's standing texts; Claude Code's names its harness.
create function pg_temp.c4_brief(p_id uuid, p_harness text default 'claude-code', p_title text default 'Make the onboarding PDF')
returns jsonb language sql as $$
	select jsonb_build_object('kind', 'worker-brief', 'id', p_id, 'title', p_title, 'species', 'in-house', 'access', 'write',
		'revival', 'each', 'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'followUps', 0, 'followedUpAt', null, 'goal', 'Make the onboarding PDF from the notes.',
		'doneWhen', 'A PDF in the worker''s folder.', 'context', null, 'sources', '[]'::jsonb, 'followUp', null)
		|| case when p_harness is null then '{}'::jsonb else jsonb_build_object('harness', p_harness) end
		|| public.qorpera_company_state_worker_standing('in-house', 'write', 'each')
$$;
-- The request manage_worker sends with a brief.
create function pg_temp.c4_request(p_folder text, p_brief jsonb, p_extra jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('action', 'dispatch', 'folder', p_folder, 'title', p_brief ->> 'title', 'goal', p_brief ->> 'goal',
		'doneWhen', p_brief ->> 'doneWhen', 'context', p_brief -> 'context', 'sources', p_brief -> 'sources',
		'access', p_brief ->> 'access', 'revival', p_brief ->> 'revival')
		|| case when p_brief ? 'harness' then jsonb_build_object('harness', p_brief -> 'harness') else '{}'::jsonb end
		|| p_extra
$$;
create function pg_temp.c4_stage(p_binding jsonb, p_text text) returns jsonb language plpgsql as $$
declare v_seal jsonb := pg_temp.base_seal(pg_temp.c4_actor(p_binding), pg_temp.base_manifest(p_text));
begin
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end $$;
create function pg_temp.c4_entry(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_parse ->> 'kind', 'text', p_parse::text, 'parse', p_parse, 'parserVersion', 1)
$$;
create function pg_temp.c4_units(p_binding jsonb, p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', p_folder,
		'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', pg_temp.c4_stage(p_binding, p_brief::text))),
		'structured', jsonb_build_array(pg_temp.c4_entry(p_folder || '/brief.md', p_brief))))
$$;
create function pg_temp.c4_review(p_binding jsonb, p_call text, p_units jsonb) returns uuid language plpgsql as $$
declare v_action uuid;
begin
	v_action := (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'manage_worker',
		'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Hand work to Claude Code', 'target', 'onboarding', 'details', '{}'::jsonb),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	return (public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', v_action, 'tool', 'manage_worker',
		'argumentSha256', md5(p_call) || md5(p_call), 'units', p_units)) ->> 'reviewId')::uuid;
end $$;
create function pg_temp.c4_commit(p_binding jsonb, p_key text, p_units jsonb, p_request jsonb, p_review uuid) returns jsonb
language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', pg_temp.c4_actor(p_binding), p_key,
		p_units, p_request, p_review);
end $$;
create function pg_temp.c4_dispatch(p_binding jsonb, p_key text, p_folder text, p_brief jsonb, p_extra jsonb default '{}')
returns jsonb language plpgsql as $$
declare v_units jsonb := pg_temp.c4_units(p_binding, p_folder, p_brief);
begin
	return pg_temp.c4_commit(p_binding, p_key, v_units, pg_temp.c4_request(p_folder, p_brief, p_extra),
		pg_temp.c4_review(p_binding, p_key, v_units));
end $$;
-- A dispatch refused by the worker rules with exactly these words, and nothing written for the brief's worker.
create function pg_temp.c4_refused(p_result jsonb, p_brief jsonb, p_words text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and p_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = p_words, format('refused with "%s": %s', p_words, p_result));
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_runtime_workers where id = (p_brief ->> 'id')::uuid),
		'a refused dispatch writes nothing: ' || p_words);
end $$;
create function pg_temp.c4_worker(p_id uuid) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = p_id
$$;
create function pg_temp.c4_lease() returns public.qorpera_claude_worker_leases language sql as $$
	select * from public.qorpera_claude_worker_leases where owner_user_id = pg_temp.c4_owner_id()
$$;
create function pg_temp.c4_drain() returns jsonb language sql as $$
	select public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32)
$$;
-- A worker's report by its own run (928's c3_results).
create function pg_temp.c4_results(p_binding jsonb, p_key text, p_folder text) returns jsonb language plpgsql as $$
declare v_parse jsonb := jsonb_build_object('kind', 'worker-results', 'outcome', 'succeeded',
	'reportedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'decision', null, 'note', null,
	'summary', 'Done.', 'needs', null, 'files', '[]'::jsonb);
begin
	return pg_temp.c4_commit(p_binding, p_key, jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/results.md',
		'file', pg_temp.c4_stage(p_binding, v_parse::text),
		'structured', jsonb_build_array(pg_temp.c4_entry(p_folder || '/results.md', v_parse)))),
		jsonb_build_object('action', 'report', 'folder', p_folder), null);
end $$;
-- The agent's follow-up of a worker: its brief with one more follow-up, under review (928's c3_followup).
create function pg_temp.c4_followup(p_binding jsonb, p_key text, p_folder text, p_text text) returns jsonb language plpgsql as $$
declare v_base jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = pg_temp.base_version(p_folder || '/brief.md'));
	v_brief jsonb; v_units jsonb; v_results uuid := pg_temp.base_version(p_folder || '/results.md');
begin
	v_brief := v_base || jsonb_build_object('followUps', (v_base ->> 'followUps')::integer + 1,
		'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', p_text);
	v_units := jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/brief.md',
		'file', pg_temp.c4_stage(p_binding, v_brief::text), 'expectedVersion', pg_temp.base_version(p_folder || '/brief.md'),
		'structured', jsonb_build_array(pg_temp.c4_entry(p_folder || '/brief.md', v_brief))))
		|| case when v_results is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('op', 'delete',
			'path', p_folder || '/results.md', 'expectedVersion', v_results)) end;
	return pg_temp.c4_commit(p_binding, p_key, v_units,
		jsonb_build_object('action', 'followup', 'folder', p_folder, 'resultsVersion', v_results, 'text', p_text),
		pg_temp.c4_review(p_binding, p_key, v_units));
end $$;
-- A run's job ends as the reaper or the runner ends it.
create function pg_temp.c4_end_job(p_run uuid, p_status text) returns void language sql as $$
	update public.qorpera_runner_jobs set status = p_status, lease_token_sha256 = null, lease_expires_at = null,
		finished_at = case when p_status in ('completed', 'failed') then clock_timestamp() end,
		result = case when p_status = 'completed' then '{}'::jsonb end,
		last_error = case when p_status = 'failed' then 'Fixture: the run ended' end,
		cancelled_at = case when p_status = 'cancelled' then clock_timestamp() end,
		cancelled_by_user_id = case when p_status = 'cancelled' then created_by_user_id end
	where run_id = p_run and status in ('queued', 'leased')
$$;
-- END C4 HELPERS

-- Alice's machine runs for the owner's work (1246's home), and Alice has a todo with its folder.
select pg_temp.h1_switch(true, true) \g /dev/null
select pg_temp.h1_start('home-a') \g /dev/null
select pg_temp.h1_up('home-a', extensions.gen_random_uuid()) \g /dev/null
select pg_temp.base_commit(pg_temp.base_owner(), 'c4-todos', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/alice/todos/onboarding.md', 'todo', E'---\ntitle: The onboarding PDF\nstatus: open\n---\n',
		'{"kind":"todo","id":"12680000-0000-4000-8000-0000000000a1","title":"The onboarding PDF","status":"open","requestedBy":null,"detail":""}'),
	jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/alice/todos/onboarding'))) \g /dev/null

insert into public.qorpera_execution_host_principals(host_id, provider_adapter, orchestrator_id, credential_sha256)
values ('base-shared-host', 'process', '92400000-0000-4000-8000-000000000092', repeat('e', 64));

-- The checks start here: a test that runs after this file's fixture part stops at this line.

-- 1. The brief ---------------------------------------------------------------------------------------------------------
do $$
declare v_plain jsonb := pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b0', null);
begin
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('worker-brief', v_plain) = '[]'::jsonb,
		'1: a plain brief without a harness is as it was: ' || public.qorpera_company_state_parse_problems('worker-brief', v_plain)::text);
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('worker-brief',
		v_plain || '{"harness":"claude-code"}') = '[]'::jsonb, '1: a plain brief may name claude-code');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('worker-brief',
		v_plain || '{"harness":"codex"}') <> '[]'::jsonb, '1: a plain brief never names codex (its unsaid default)');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('worker-brief',
		v_plain || '{"harness":null}') <> '[]'::jsonb, '1: nor a null harness');
	perform pg_temp.base_assert(public.qorpera_company_state_parse_problems('worker-brief',
		v_plain || '{"harness":"claude-code","repository":{"host":"qorpera","owner":"company","name":"app","baseBranch":"main"}}')
		<> '[]'::jsonb, '1: nor a repository');
end $$;

-- 2. The refusals: each in its words, and nothing written --------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_brief jsonb; v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf';
begin
	-- Harness codex on a plain worker: the model's codex is dropped by the tool; the database refuses it if sent.
	v_brief := pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b1', null);
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-codex', v_folder, v_brief, '{"harness":"codex"}'), v_brief,
		'Worker species is invalid');
	v_brief := pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b1');
	-- Not on the Claude list.
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-list', v_folder, v_brief), v_brief,
		pg_temp.c4_words('Claude Code is not open for <member> yet: dispatch this worker without Claude Code'));
	insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
	-- On the list, but Claude sign-in is not open in this company (account logins off).
	update public.qorpera_account_model_login_settings set enabled = false;
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-open', v_folder, v_brief), v_brief,
		'Claude Code is not open in this company yet: dispatch this worker without Claude Code');
	update public.qorpera_account_model_login_settings set enabled = true;
	-- No Claude login.
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-none', v_folder, v_brief), v_brief,
		pg_temp.c4_words('Claude Code needs <member>''s own Claude sign-in. Ask <member> to sign in to Claude in Settings, Model accounts, or dispatch this worker without Claude Code.'));
	-- A signed-out login is none.
	perform pg_temp.c4_login('12680000-0000-4000-8000-0000000000c0', pg_temp.c4_owner_id());
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where id = '12680000-0000-4000-8000-0000000000c0';
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-revoked', v_folder, v_brief), v_brief,
		pg_temp.c4_words('Claude Code needs <member>''s own Claude sign-in. Ask <member> to sign in to Claude in Settings, Model accounts, or dispatch this worker without Claude Code.'));
	perform pg_temp.c4_login('12680000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id());
	-- The agent's machine not available for the member's work (the company's home switched off).
	perform pg_temp.h1_switch(true, false);
	perform pg_temp.c4_refused(pg_temp.c4_dispatch(v_alice, 'c4-refuse-home', v_folder, v_brief), v_brief,
		pg_temp.c4_words('Claude Code works on your own machine, and none is running for <member>''s work now: start your machine, or dispatch this worker without Claude Code'));
	perform pg_temp.h1_switch(true, true);
	perform pg_temp.base_assert(public.qorpera_claude_worker_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000030', (v_alice ->> 'runId')::uuid) is null, '2: with all of it, nothing is in the way');
end $$;

-- No member behind the ask: a routine at the root of the run's chain. Its root wake is made a routine's for this check
-- only (the guards and the identity check that keep a wake's kind set aside), then everything is put back. A run so
-- changed no longer passes the folder's own wake checks, so the rules' reading is asked directly: the rules refuse with
-- exactly what it answers (section 2's other refusals go through the same branch).
savepoint c4_routine;
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_routine_identity;
set local session_replication_role = replica;
update public.qorpera_wake_occurrences set wake_kind = 'routine' where id = (select wake.causal_root_id
	from public.qorpera_wake_occurrences wake where wake.run_id = (pg_temp.c4_alice() ->> 'runId')::uuid);
set local session_replication_role = origin;
select pg_temp.base_assert(public.qorpera_claude_worker_problem('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000030', (pg_temp.c4_alice() ->> 'runId')::uuid)
	= 'Claude Code works on a member''s word, and no member asked for this work: dispatch this worker without Claude Code',
	'2: a routine at the root of the chain: no member''s word') \g /dev/null
rollback to savepoint c4_routine;
select pg_temp.base_assert(public.qorpera_claude_worker_problem('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000030', (pg_temp.c4_alice() ->> 'runId')::uuid) is null,
	'2: put back, the member''s word is there again') \g /dev/null
-- And a run of another company is nobody's word here.
select pg_temp.base_assert(public.qorpera_claude_worker_problem(extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000030', (pg_temp.c4_alice() ->> 'runId')::uuid)
	= 'Claude Code works on a member''s word, and no member asked for this work: dispatch this worker without Claude Code',
	'2: another company''s run') \g /dev/null

-- 3. The accepted dispatch: the payer recorded, no wake yet, the replay the same -----------------------------------------
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf';
	v_brief jsonb := pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b1'); v_units jsonb; v_request jsonb; v_review uuid;
	v_result jsonb; v_again jsonb; w public.qorpera_runtime_workers%rowtype;
begin
	v_units := pg_temp.c4_units(v_alice, v_folder, v_brief);
	v_request := pg_temp.c4_request(v_folder, v_brief);
	v_review := pg_temp.c4_review(v_alice, 'c4-dispatch-1', v_units);
	v_result := pg_temp.c4_commit(v_alice, 'c4-dispatch-1', v_units, v_request, v_review);
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '3: the dispatch saves: ' || v_result::text);
	w := pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.species = 'in-house' and w.harness = 'claude-code'
		and w.claude_login_id = '12680000-0000-4000-8000-0000000000c1' and w.requested_by_user_id = pg_temp.c4_owner_id()
		and w.state = 'active' and w.occurrence_id is null and w.owner_user_id is null and w.owner_sponsor_binding_id is null,
		'3: the worker names the harness and the member''s login: ' || to_jsonb(w)::text);
	perform pg_temp.base_assert((select v.structured -> 'parse' ->> 'harness' from public.qorpera_folder_path_versions v
		where v.version = w.folder_brief_version) = 'claude-code', '3: its brief names the harness');
	v_again := pg_temp.c4_commit(v_alice, 'c4-dispatch-1', v_units, v_request, v_review);
	perform pg_temp.base_assert((v_again ->> 'replay')::boolean and v_again - 'replay' = v_result - 'replay',
		'3: the replay answers the first commit: ' || v_again::text);
	-- The payer is fixed: the member signs in again, and the worker still names the login it was dispatched on (C4b's open
	-- then refuses it: that login is signed out).
	perform pg_temp.c4_login('12680000-0000-4000-8000-0000000000c2', pg_temp.c4_owner_id());
	perform pg_temp.base_assert((pg_temp.c4_worker(w.id)).claude_login_id = '12680000-0000-4000-8000-0000000000c1',
		'3: a newer sign-in does not move a dispatched worker''s payer');
	-- (For the checks below the dispatched login is the active one again.)
	update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
		encrypted_envelope = null, envelope_sha256 = null where id = '12680000-0000-4000-8000-0000000000c2';
	update public.qorpera_claude_logins set status = 'active', revoked_at = null, key_id = 'vault-root-1',
		encrypted_envelope = convert_to('canary-c4', 'UTF8'),
		envelope_sha256 = encode(extensions.digest(convert_to('canary-c4', 'UTF8'), 'sha256'), 'hex')
	where id = '12680000-0000-4000-8000-0000000000c1';
end $$;

-- 4. The drain: the wake names the harness; one Claude Code run per member ------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_drain jsonb; v_pass jsonb; v_run jsonb; w public.qorpera_runtime_workers%rowtype;
	w2 public.qorpera_runtime_workers%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	l public.qorpera_claude_worker_leases%rowtype; v_result jsonb;
begin
	v_drain := pg_temp.c4_drain();
	w := pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'started')::integer = 1 and w.occurrence_id is not null,
		'4: the drain starts it: ' || v_drain::text);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.occurrence_id;
	perform pg_temp.base_assert(v_wake.status = 'queued' and v_wake.source_kind = 'worker-dispatch'
		and v_wake.payload ->> 'harness' = 'claude-code' and v_wake.payload ->> 'species' = 'in-house',
		'4: its wake names the harness: ' || v_wake.payload::text);
	l := pg_temp.c4_lease();
	perform pg_temp.base_assert(l.worker_id = w.id and l.wake_id = w.occurrence_id and public.qorpera_claude_worker_lease_live(l),
		'4: the member''s lease is the worker''s, under its wake: ' || to_jsonb(l)::text);
	-- A second Claude Code worker of the same member, and a plain one beside it.
	v_result := pg_temp.c4_dispatch(v_alice, 'c4-dispatch-2', 'QorperaOS/agents/alice/todos/onboarding/slides',
		pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b2', p_title => 'Make the slides'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4: the second dispatch: ' || v_result::text);
	v_result := pg_temp.c4_dispatch(v_alice, 'c4-dispatch-3', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b3', null, 'Read the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4: the plain dispatch: ' || v_result::text);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((v_drain ->> 'started')::integer = 1 and (v_drain ->> 'skipped')::integer = 0
		and not public.qorpera_folder_worker_due(pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b2'))
		and (pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b3')).occurrence_id is not null
		and (pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b2')).occurrence_id is null
		and not exists (select 1 from public.qorpera_wake_occurrences where source_id = '12680000-0000-4000-8000-0000000000b2'),
		'4: the plain worker starts; the second Claude Code worker waits, with no wake: ' || v_drain::text);
	perform pg_temp.base_assert((pg_temp.c4_lease()).wake_id = w.occurrence_id, '4: the lease stays the first''s');
	-- A take that raced past the due check (another company's drain read the worker as due first) does not take over a
	-- live lease.
	perform pg_temp.base_assert(not public.qorpera_claude_worker_lease_take(
		pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b2'), extensions.gen_random_uuid())
		and (pg_temp.c4_lease()).wake_id = w.occurrence_id, '4: a live lease is never taken over');
	-- The first's run: materialized and leased, the lease still holds and the second still waits.
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences where id = w.occurrence_id;
	perform pg_temp.base_assert(v_wake.run_id is not null, '4: the first worker''s wake has a run: ' || v_pass::text);
	perform set_config('qorpera_test.c4_first_run', v_wake.run_id::text, false);
	perform pg_temp.base_assert(public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()), '4: a materialized run holds it');
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b2')).occurrence_id is null,
		'4: still waiting while the first''s run goes on: ' || v_drain::text);
	-- That run dies: its job is failed (as the reaper fails a lost run). The lease ends with the job itself, also while
	-- nothing has marked the wake yet (the job's triggers set aside here, so the wake still reads materialized); the
	-- second starts.
	set local session_replication_role = replica;
	perform pg_temp.c4_end_job(v_wake.run_id, 'failed');
	set local session_replication_role = origin;
	perform pg_temp.base_assert((select status from public.qorpera_wake_occurrences where id = v_wake.id) = 'materialized',
		'4: the wake is not marked yet');
	perform pg_temp.base_assert(not public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()), '4: a dead run holds nothing');
	v_drain := pg_temp.c4_drain();
	w2 := pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b2');
	perform pg_temp.base_assert(w2.occurrence_id is not null and (pg_temp.c4_lease()).wake_id = w2.occurrence_id
		and (pg_temp.c4_lease()).worker_id = w2.id and public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()),
		'4: the second starts and the lease is its: ' || v_drain::text || ' ' || to_jsonb(pg_temp.c4_lease())::text);
	-- A third waits for the second; the second is cancelled before its run: its wake ends, and the third starts.
	v_result := pg_temp.c4_dispatch(v_alice, 'c4-dispatch-4', 'QorperaOS/agents/alice/todos/onboarding/cover',
		pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b4', p_title => 'Make the cover'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '4: the third dispatch: ' || v_result::text);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b4')).occurrence_id is null,
		'4: the third waits for the second: ' || v_drain::text);
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder',
		'QorperaOS/agents/alice/todos/onboarding/slides', 'operationKey', 'c4-cancel-2'));
	perform pg_temp.base_assert(not public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()),
		'4: a cancelled worker''s wake holds nothing');
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b4')).occurrence_id is not null
		and (pg_temp.c4_lease()).worker_id = '12680000-0000-4000-8000-0000000000b4', '4: the third starts: ' || v_drain::text);
	-- Its run is stopped (its job cancelled): the lease ends with the job.
	v_pass := pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences
	where id = (pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b4')).occurrence_id;
	perform pg_temp.base_assert(v_wake.run_id is not null, '4: the third''s wake has a run: ' || v_pass::text);
	perform pg_temp.c4_end_job(v_wake.run_id, 'cancelled');
	perform pg_temp.base_assert(not public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()), '4: a stopped run holds nothing');
	-- The take itself: only a Claude Code worker takes one.
	perform pg_temp.base_error(format('select public.qorpera_claude_worker_lease_take(w, %L) from public.qorpera_runtime_workers w where w.id = %L',
		extensions.gen_random_uuid(), '12680000-0000-4000-8000-0000000000b3'), '22023');
end $$;

-- 5. A follow-up ---------------------------------------------------------------------------------------------------------
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; w public.qorpera_runtime_workers%rowtype; v_drain jsonb;
	v_folder text := 'QorperaOS/agents/alice/todos/onboarding/pdf';
begin
	-- The first worker ended without a report (its run died): its wake ended with its run, and the drain finished it.
	update public.qorpera_wake_occurrences set status = 'failed', finished_at = coalesce(finished_at, clock_timestamp())
	where id = (pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b1')).occurrence_id and status = 'materialized';
	v_drain := pg_temp.c4_drain();
	w := pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state <> 'active', '5: the first worker has ended: ' || to_jsonb(w)::text || ' ' || v_drain::text);
	-- The member signed in again meanwhile: a follow-up on their word records the login they have now.
	perform pg_temp.c4_login('12680000-0000-4000-8000-0000000000c3', pg_temp.c4_owner_id());
	-- Another member's worker is not followed up on this member's word (its row made another's, for this check only).
	begin
		update public.qorpera_runtime_workers set requested_by_user_id = (select m.user_id from public.qorpera_profile_members m
			where m.profile_id = '92400000-0000-4000-8000-000000000010' and m.user_id <> pg_temp.c4_owner_id() order by m.user_id limit 1)
		where id = w.id;
		v_result := pg_temp.c4_followup(v_alice, 'c4-followup-other', v_folder, 'Use the new logo.');
		perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
			and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
				= 'This worker runs on another member''s Claude plan: dispatch a new worker for this work',
			'5: another member''s Claude Code worker: ' || v_result::text);
		raise exception 'c4-undo';
	exception when raise_exception then if sqlerrm <> 'c4-undo' then raise; end if;
	end;
	-- Without a login now, the follow-up is refused in the dispatch's words.
	begin
		update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
			encrypted_envelope = null, envelope_sha256 = null where id = '12680000-0000-4000-8000-0000000000c3';
		v_result := pg_temp.c4_followup(v_alice, 'c4-followup-none', v_folder, 'Use the new logo.');
		perform pg_temp.base_assert(v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
			= pg_temp.c4_words('Claude Code needs <member>''s own Claude sign-in. Ask <member> to sign in to Claude in Settings, Model accounts, or dispatch this worker without Claude Code.'),
			'5: no login, no follow-up: ' || v_result::text);
		raise exception 'c4-undo';
	exception when raise_exception then if sqlerrm <> 'c4-undo' then raise; end if;
	end;
	v_result := pg_temp.c4_followup(v_alice, 'c4-followup-1', v_folder, 'Use the new logo.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '5: the follow-up saves: ' || v_result::text);
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2 and w.harness = 'claude-code'
		and w.claude_login_id = '12680000-0000-4000-8000-0000000000c3', '5: it records the login the member has now: ' || to_jsonb(w)::text);
	v_drain := pg_temp.c4_drain();
	w := pg_temp.c4_worker(w.id);
	perform pg_temp.base_assert(w.occurrence_id is not null and (pg_temp.c4_lease()).wake_id = w.occurrence_id
		and (select payload ->> 'harness' from public.qorpera_wake_occurrences where id = w.occurrence_id) = 'claude-code',
		'5: its next run takes the lease and names the harness: ' || v_drain::text);
end $$;

-- 5b. Many waiting: the follow-up's run holds the member's lease; 33 more Claude Code workers of that member wait (more
-- than the drain's 32), and a plain worker dispatched after them still starts on the next pass.
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; v_drain jsonb; v_i integer;
begin
	perform pg_temp.base_assert(public.qorpera_claude_worker_lease_live(pg_temp.c4_lease()), '5b: the member''s lease is held');
	for v_i in 1..33 loop
		v_result := pg_temp.c4_dispatch(v_alice, 'c4-many-' || v_i, 'QorperaOS/agents/alice/todos/onboarding/page-' || v_i,
			pg_temp.c4_brief(('12680000-0000-4000-8000-' || lpad(to_hex(4096 + v_i), 12, '0'))::uuid, p_title => 'Page ' || v_i));
		perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '5b: dispatch ' || v_i || ': ' || v_result::text);
	end loop;
	v_result := pg_temp.c4_dispatch(v_alice, 'c4-many-plain', 'QorperaOS/agents/alice/todos/onboarding/summary',
		pg_temp.c4_brief('12680000-0000-4000-8000-0000000000b9', null, 'Write the summary'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', '5b: the plain dispatch: ' || v_result::text);
	v_drain := pg_temp.c4_drain();
	perform pg_temp.base_assert((pg_temp.c4_worker('12680000-0000-4000-8000-0000000000b9')).occurrence_id is not null
		and not exists (select 1 from public.qorpera_runtime_workers w where w.harness = 'claude-code'
			and w.occurrence_id is null and w.title like 'Page %' and public.qorpera_folder_worker_due(w)),
		'5b: the plain worker starts behind 33 waiting Claude Code workers, none of them due: ' || v_drain::text);
end $$;

-- 6. Whose these are ----------------------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_claude_worker_leases', 'select,insert,update,delete') then
			raise exception '6: % touches the lease table', v_role; end if;
		foreach v_function in array array['public.qorpera_claude_worker_lease_live(public.qorpera_claude_worker_leases)',
			'public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers,uuid)',
			'public.qorpera_claude_worker_member_name(uuid,uuid)', 'public.qorpera_claude_worker_home(uuid,uuid,uuid,uuid)',
			'public.qorpera_claude_worker_waits(public.qorpera_runtime_workers)',
			'public.qorpera_claude_worker_problem(uuid,uuid,uuid)', 'public.qorpera_claude_worker_login(uuid,uuid)'] loop
			if has_function_privilege(v_role, v_function, 'execute') then
				raise exception '6: % may call %', v_role, v_function; end if;
		end loop;
	end loop;
	-- Every patched body names the migration.
	foreach v_function in array array['public.qorpera_company_state_parse_problems(text,jsonb)',
		'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)',
		'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)',
		'public.qorpera_folder_worker_dispatch_payload(public.qorpera_runtime_workers,public.qorpera_runtime_agent_todos)',
		'public.qorpera_folder_workers_company(uuid,integer)',
		'public.qorpera_folder_worker_due(public.qorpera_runtime_workers)'] loop
		if position('20260930770000' in pg_get_functiondef(v_function::regprocedure)) = 0 then
			raise exception '6: % does not name 20260930770000', v_function; end if;
	end loop;
end $$;
