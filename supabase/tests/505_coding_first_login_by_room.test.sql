-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- F1 (migration 20260930543000): a new coding session starts on its owner's login with the most room left, in
-- qorpera_starter_sponsor's order for new work, after the consent and the plan rule. 924's base: Alice's run for the
-- owner (…001), on their login A (allowed to work while they are away). The owner connects login B, newer, the same
-- way. Then: the newest login used up and an older one with room: the older pays, and the rules, the sponsor, the payer
-- and the dispatched worker agree; a login without consent, of another provider, harness or member, or a company
-- account, is never chosen, even with more room; no login that may pay gives today's refusals; unknown usage comes after
-- measured room, and ties keep today's order (the newest, then the id); an existing session keeps its pinned payer
-- through an answer, a follow-up and its turn's wake while another login has more room; the plan rule stays ahead of the
-- room; and the grants.

-- The repository the agents may work in, and executor exec-505 (configured in §0).
create function pg_temp.f1_repo() returns jsonb language sql immutable as $$
	select '{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'::jsonb
$$;
-- A run's actor, as the native host's folder calls send it.
create function pg_temp.f1_actor(p_binding jsonb) returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', p_binding ->> 'runId', 'jobId', p_binding ->> 'jobId',
		'runnerId', p_binding ->> 'runnerId', 'assignmentId', p_binding ->> 'assignmentId')
$$;
create function pg_temp.f1_alice() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
-- A brief as the parser gives it, with the platform's standing texts; a coding brief names its harness and repository.
create function pg_temp.f1_brief(p_id uuid, p_harness text default 'codex', p_title text default 'Fix the login page')
returns jsonb language sql as $$
	select jsonb_build_object('kind', 'worker-brief', 'id', p_id, 'title', p_title, 'species', 'coding', 'access', 'read',
		'revival', 'batch', 'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		'followUps', 0, 'followedUpAt', null, 'goal', 'Make the login page accept a pasted code.',
		'doneWhen', 'A draft pull request that does it.', 'context', null, 'sources', '[]'::jsonb, 'followUp', null,
		'harness', p_harness, 'repository', pg_temp.f1_repo())
		|| public.qorpera_company_state_worker_standing('coding', 'read', 'batch')
$$;
-- The request manage_worker sends with a brief.
create function pg_temp.f1_request(p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_object('action', 'dispatch', 'folder', p_folder, 'title', p_brief ->> 'title', 'goal', p_brief ->> 'goal',
		'doneWhen', p_brief ->> 'doneWhen', 'context', p_brief -> 'context', 'sources', p_brief -> 'sources',
		'access', p_brief ->> 'access', 'revival', p_brief ->> 'revival', 'species', 'coding', 'harness', p_brief ->> 'harness',
		'repository', p_brief -> 'repository')
$$;
-- A file staged as the run that commits it (a version-2 file is held to possession).
create function pg_temp.f1_stage(p_binding jsonb, p_text text) returns jsonb language plpgsql as $$
declare v_seal jsonb := pg_temp.base_seal(pg_temp.f1_actor(p_binding), pg_temp.base_manifest(p_text));
begin
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'staging: ' || v_seal::text);
	return v_seal -> 'file';
end $$;
-- A structured file's entry, as the shared parser sends it; the text is the parse's, as the folder core reads no bytes.
create function pg_temp.f1_entry(p_path text, p_parse jsonb) returns jsonb language sql as $$
	select jsonb_build_object('path', p_path, 'kind', p_parse ->> 'kind', 'text', p_parse::text, 'parse', p_parse, 'parserVersion', 1)
$$;
-- A dispatch's one unit: the worker's folder with its brief (the todo's folder exists).
create function pg_temp.f1_units(p_binding jsonb, p_folder text, p_brief jsonb) returns jsonb language sql as $$
	select jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', p_folder,
		'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', pg_temp.f1_stage(p_binding, p_brief::text))),
		'structured', jsonb_build_array(pg_temp.f1_entry(p_folder || '/brief.md', p_brief))))
$$;
-- The automatic review's allow of one manage_worker call, recorded as the review of exactly these units (C2 R1).
create function pg_temp.f1_review(p_binding jsonb, p_call text, p_units jsonb) returns uuid language plpgsql as $$
declare v_action uuid;
begin
	v_action := (public.qorpera_record_action_review(p_binding, jsonb_build_object('callId', p_call, 'tool', 'manage_worker',
		'effect', 'delegation', 'argumentSha256', md5(p_call) || md5(p_call),
		'action', jsonb_build_object('title', 'Start a coding session', 'target', 'fix-login', 'details', '{}'::jsonb),
		'decision', 'allow', 'ruleIds', '[]'::jsonb, 'builtIn', 'none', 'reason', 'Fixture verdict.', 'proposedRule', null,
		'reviewerModel', 'gpt-6-luna')) ->> 'reviewId')::uuid;
	return (public.qorpera_folder_record_review(p_binding, jsonb_build_object('actionReviewId', v_action, 'tool', 'manage_worker',
		'argumentSha256', md5(p_call) || md5(p_call), 'units', p_units)) ->> 'reviewId')::uuid;
end $$;
-- One worker commit by a run, as manage_worker makes it.
create function pg_temp.f1_commit(p_binding jsonb, p_key text, p_units jsonb, p_request jsonb, p_review uuid) returns jsonb
language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', pg_temp.f1_actor(p_binding), p_key,
		p_units, p_request, p_review);
end $$;
-- A dispatch by a run: its units, reviewed, under the request.
create function pg_temp.f1_dispatch(p_binding jsonb, p_key text, p_folder text, p_brief jsonb) returns jsonb language plpgsql as $$
declare v_units jsonb := pg_temp.f1_units(p_binding, p_folder, p_brief);
begin
	return pg_temp.f1_commit(p_binding, p_key, v_units, pg_temp.f1_request(p_folder, p_brief), pg_temp.f1_review(p_binding, p_key, v_units));
end $$;
-- A dispatch refused by the worker rules with exactly these words, and nothing written for the brief's worker.
create function pg_temp.f1_refused(p_result jsonb, p_brief jsonb, p_words text) returns void language plpgsql as $$
begin
	perform pg_temp.base_assert(p_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and p_result -> 'units' -> 0 ->> 'reason' = 'structured_rule'
		and p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = p_words, format('refused with "%s": %s', p_words, p_result));
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_runtime_workers where id = (p_brief ->> 'id')::uuid)
		and not exists (select 1 from public.qorpera_coding_sessions where worker_id = (p_brief ->> 'id')::uuid),
		'a refused dispatch writes nothing: ' || p_words);
end $$;
create function pg_temp.f1_worker(p_id uuid) returns public.qorpera_runtime_workers language sql as $$
	select * from public.qorpera_runtime_workers where id = p_id
$$;
create function pg_temp.f1_session(p_id uuid) returns public.qorpera_coding_sessions language sql as $$
	select * from public.qorpera_coding_sessions where worker_id = p_id
$$;
-- The owner's answer in the session's thread, as the web app sends it.
create function pg_temp.f1_answer(p_worker uuid, p_text text) returns jsonb language plpgsql as $$
declare v_view jsonb;
begin
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_view := public.qorpera_answer_coding_session(p_worker, p_text, extensions.gen_random_uuid());
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_view;
end $$;
-- The agent's follow-up of a worker: its brief with one more follow-up, under review.
create function pg_temp.f1_followup(p_binding jsonb, p_key text, p_folder text, p_text text) returns jsonb language plpgsql as $$
declare v_base jsonb := (select v.structured -> 'parse' from public.qorpera_folder_path_versions v
		where v.version = pg_temp.base_version(p_folder || '/brief.md'));
	v_brief jsonb; v_units jsonb;
begin
	v_brief := v_base || jsonb_build_object('followUps', (v_base ->> 'followUps')::integer + 1,
		'followedUpAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUp', p_text);
	v_units := jsonb_build_array(jsonb_build_object('op', 'write', 'path', p_folder || '/brief.md',
		'file', pg_temp.f1_stage(p_binding, v_brief::text), 'expectedVersion', pg_temp.base_version(p_folder || '/brief.md'),
		'structured', jsonb_build_array(pg_temp.f1_entry(p_folder || '/brief.md', v_brief))));
	return pg_temp.f1_commit(p_binding, p_key, v_units,
		jsonb_build_object('action', 'followup', 'folder', p_folder, 'resultsVersion', null, 'text', p_text),
		pg_temp.f1_review(p_binding, p_key, v_units));
end $$;

-- 0. Alice's todo, exec-505 for both harnesses with Alice's grant, and the owner's second login B -------------------
select pg_temp.base_commit(pg_temp.base_owner(), 'f1-todos', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/alice/todos/fix-login.md', 'todo', E'---\ntitle: Fix the login page\nstatus: open\n---\n',
		'{"kind":"todo","id":"50500000-0000-4000-8000-0000000000a1","title":"Fix the login page","status":"open","requestedBy":null,"detail":""}'),
	jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/alice/todos/fix-login'))) \g /dev/null
select public.qorpera_configure_coding_executor('92400000-0000-4000-8000-000000000020', 'exec-505', true,
	array['codex', 'claude-code']) \g /dev/null
select public.qorpera_set_coding_repository_grant('92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000030',
	pg_temp.f1_repo(), true) \g /dev/null
-- B, as 905 connects it: for work while away too, with its own member sponsor.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.f1_login', public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010', '50500000-0000-4000-8000-000000000051', '50500000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, 'openai', 'codex-cli', repeat('e', 64), 900)::text,
	true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.f1_connection', public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.f1_login')::jsonb ->> 'login_id')::uuid, repeat('e', 64), '50500000-0000-4000-8000-000000000060',
	'object://native-capsules/50500000-0000-4000-8000-000000000060', repeat('f', 64), 'fixture-openai-account-f1', 'personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,
	true) \g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.f1_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.f1_sponsor', public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010', '50500000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.f1_connection')::jsonb ->> 'connection_id')::uuid, 2, true)::text, true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.f1(p_key text) returns uuid language sql as $$
	select case p_key
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.f1_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.f1_sponsor')::jsonb ->> 'binding_id')::uuid end
$$;
-- A login's usage report for its version 2, fresh, with one window that much used; null: no report (unknown usage).
create function pg_temp.f1_usage(p_connection uuid, p_used numeric) returns void language sql as $$
	delete from public.qorpera_native_provider_account_metadata
	where connection_id = p_connection and connection_version = 2 and p_used is null;
	insert into public.qorpera_native_provider_account_metadata(connection_id, connection_version, provider_account_usage)
	select p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second', 'windows',
		jsonb_build_array(jsonb_build_object('id', 'primary', 'label', '5 hours', 'usedPercent', p_used)))
	where p_used is not null
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage;
$$;
-- Another login, A's rows with another owner, provider, harness or consent; newer than A and B, and unused (room 100).
create function pg_temp.f1_clone(p_id uuid, p_owner uuid, p_provider text, p_harness text, p_allow boolean,
	p_created_at timestamptz default clock_timestamp()) returns uuid language plpgsql as $$
begin
	insert into public.qorpera_provider_connections
	select (jsonb_populate_record(null::public.qorpera_provider_connections, to_jsonb(c) || jsonb_build_object('id', p_id,
		'client_connection_id', p_id, 'owner_user_id', p_owner, 'provider', p_provider, 'created_at', p_created_at))).*
	from public.qorpera_provider_connections c where c.id = pg_temp.f1('a');
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions, to_jsonb(v)
		|| jsonb_build_object('connection_id', p_id, 'native_harness', p_harness, 'allow_autonomous', p_allow))).*
	from public.qorpera_provider_connection_versions v where v.connection_id = pg_temp.f1('a') and v.version = 2;
	perform pg_temp.f1_usage(p_id, 0);
	return p_id;
end $$;
-- The login a new coding session of this member and harness starts on.
create function pg_temp.f1_login(p_owner uuid, p_harness text default 'codex') returns uuid language sql as $$
	select login.connection_id from public.qorpera_coding_owner_login('92400000-0000-4000-8000-000000000010', p_owner, p_harness) login
$$;
-- The owner's next coding session for codex starts on this login, and the rules, the sponsor and the payer agree on it.
create function pg_temp.f1_pays(p_connection uuid, p_binding uuid, p_case text) returns void language plpgsql as $$
declare v_sponsor record; v_payer uuid;
	v_problem text := public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', pg_temp.f1('aBinding'));
begin
	select * into v_sponsor from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex');
	select payer.binding_id into v_payer from public.qorpera_coding_owner_payer('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', pg_temp.f1('aBinding')) payer;
	perform pg_temp.base_assert(pg_temp.f1_login('92400000-0000-4000-8000-000000000001') = p_connection and v_problem is null
		and v_sponsor.connection_id = p_connection and v_sponsor.binding_id = p_binding and v_payer = p_binding,
		format('%s: login %s, problem %s, sponsor %s/%s, payer %s', p_case, pg_temp.f1_login('92400000-0000-4000-8000-000000000001'),
			v_problem, v_sponsor.connection_id, v_sponsor.binding_id, v_payer));
end $$;

select pg_temp.base_assert((select b.created_at > a.created_at from public.qorpera_provider_connections a, public.qorpera_provider_connections b
		where a.id = pg_temp.f1('a') and b.id = pg_temp.f1('b'))
	and (select bool_and(v.allow_autonomous) from public.qorpera_provider_connection_versions v
		where v.connection_id in (pg_temp.f1('a'), pg_temp.f1('b')) and v.version = 2)
	and not public.qorpera_connection_is_chatgpt_plan(pg_temp.f1('a')) and not public.qorpera_connection_is_chatgpt_plan(pg_temp.f1('b')),
	'B is the owner''s newest login, and both may work while they are away');

-- 1. The login carries 543000; the sponsor still pays exactly its choice; the starter orders new work the same way ----
do $$
declare v_login text := pg_get_functiondef('public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure);
	v_sponsor text := pg_get_functiondef('public.qorpera_coding_owner_sponsor(uuid,uuid,text)'::regprocedure);
	v_starter text := pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure);
begin
	perform pg_temp.base_assert(position('20260930543000' in v_login) > 0 and position('20260930077000' in v_login) > 0
		and position('public.qorpera_native_account_remaining(connection.id, version.version)' in v_login) > 0, 'the login''s body');
	perform pg_temp.base_assert(position('20260929992000' in v_sponsor) > 0 and position('20260930077000' in v_sponsor) > 0
		and position('qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness)' in v_sponsor) > 0,
		'the sponsor pays the login''s choice');
	-- Since 20260930559000 both order by the same rank (a login that works, the room on one scale; test 559).
	perform pg_temp.base_assert(position('order by public.qorpera_native_account_rank(own.connection_id, own.connection_version)'
		in v_starter) > 0 and position('public.qorpera_native_account_rank(connection.id, version.version)' in v_login) > 0,
		'the starter''s order for new work');
end $$;

-- 2. The newest login used up, an older one with room: the older pays, and a new session is pinned to it -----------
do $$
declare v_result jsonb; w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.f1_usage(pg_temp.f1('a'), 40);
	perform pg_temp.f1_usage(pg_temp.f1('b'), 100);
	perform pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.f1('a'), 2) = 60
		and public.qorpera_native_account_remaining(pg_temp.f1('b'), 2) = 0, 'A has room left and B is used up');
	perform pg_temp.f1_pays(pg_temp.f1('a'), pg_temp.f1('aBinding'), 'the older login with room');
	v_result := pg_temp.f1_dispatch(pg_temp.f1_alice(), 'f1-dispatch-1', 'QorperaOS/agents/alice/todos/fix-login/session-1',
		pg_temp.f1_brief('50500000-0000-4000-8000-0000000000b1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch saves: ' || v_result::text);
	w := pg_temp.f1_worker('50500000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.species = 'coding' and w.owner_user_id = '92400000-0000-4000-8000-000000000001'
		and w.owner_sponsor_binding_id = pg_temp.f1('aBinding') and (pg_temp.f1_session(w.id)).phase = 'queued',
		'the session is paid by A: ' || to_jsonb(w)::text);
end $$;

-- 3. Never another login, even with more room: no consent, another provider, member or harness, a company account ---
do $$
begin
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c1', '92400000-0000-4000-8000-000000000001', 'openai', 'codex-cli', false);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c2', '92400000-0000-4000-8000-000000000001', 'anthropic', 'codex-cli', true);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c3', '92400000-0000-4000-8000-000000000002', 'openai', 'codex-cli', true);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c4', null, 'openai', 'codex-cli', true);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c5', '92400000-0000-4000-8000-000000000001', 'openai', 'claude-code', true);
	perform pg_temp.base_assert((select bool_and(c.created_at > b.created_at and public.qorpera_native_account_remaining(c.id, 2) = 100)
		from public.qorpera_provider_connections c, public.qorpera_provider_connections b
		where b.id = pg_temp.f1('b') and c.id::text like '50500000-0000-4000-8000-0000000000c%'), 'the others are newer, with all their room');
	-- The member's own login is a login like A and B (only its owner differs).
	perform pg_temp.base_assert(pg_temp.f1_login('92400000-0000-4000-8000-000000000002') = '50500000-0000-4000-8000-0000000000c3',
		'the contributor''s login is theirs');
	perform pg_temp.f1_usage(pg_temp.f1('a'), 90);
	perform pg_temp.f1_pays(pg_temp.f1('a'), pg_temp.f1('aBinding'), 'A with 10 left, beside the others');
	-- With A and B both used up, B pays, as today (the newest): no new refusal, and still none of the others.
	perform pg_temp.f1_usage(pg_temp.f1('a'), 100);
	perform pg_temp.f1_pays(pg_temp.f1('b'), pg_temp.f1('bBinding'), 'both used up');
end $$;

-- 4. No login that may pay: today's refusals, in the rules, the sponsor and a dispatch -------------------------------
do $$
declare v_folder text := 'QorperaOS/agents/alice/todos/fix-login/session-claude';
	v_brief jsonb := pg_temp.f1_brief('50500000-0000-4000-8000-0000000000b2', 'claude-code');
begin
	-- The owner has no anthropic login with a claude-code version (c2 is codex-cli, c5 openai).
	perform pg_temp.base_assert(pg_temp.f1_login('92400000-0000-4000-8000-000000000001', 'claude-code') is null, 'no claude-code login');
	perform pg_temp.base_assert(public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'claude-code', pg_temp.f1('aBinding'))
		= 'The session owner has no active anthropic account connected for claude-code', 'the rules: no login');
	perform pg_temp.base_error($q$select * from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'claude-code')$q$, '42501',
		'The session owner has no active anthropic account connected for claude-code');
	perform pg_temp.f1_refused(pg_temp.f1_dispatch(pg_temp.f1_alice(), 'f1-claude-1', v_folder, v_brief), v_brief,
		'The session owner has no active anthropic account connected for claude-code');
	-- One that may not work while they are away, with all its room: refused, as before.
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c6', '92400000-0000-4000-8000-000000000001', 'anthropic', 'claude-code', false);
	perform pg_temp.base_assert(pg_temp.f1_login('92400000-0000-4000-8000-000000000001', 'claude-code') = '50500000-0000-4000-8000-0000000000c6'
		and public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001',
			'claude-code', pg_temp.f1('aBinding')) = 'The session owner has not allowed background work on their anthropic account',
		'the rules: no consent');
	perform pg_temp.base_error($q$select * from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'claude-code')$q$, '42501',
		'The session owner has not allowed background work on their anthropic account');
	perform pg_temp.f1_refused(pg_temp.f1_dispatch(pg_temp.f1_alice(), 'f1-claude-2', v_folder, v_brief), v_brief,
		'The session owner has not allowed background work on their anthropic account');
	-- A member without logins, and someone who is not a member.
	perform pg_temp.base_assert(public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'codex', pg_temp.f1('aBinding'))
		= 'The session owner has no active openai account connected for codex', 'the rules: the admin');
	perform pg_temp.base_error($q$select * from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004', 'codex')$q$, '42501', 'The session owner has no active openai account connected for codex');
	perform pg_temp.base_assert(public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000005', 'codex', pg_temp.f1('aBinding')) = 'The session owner is not a member of this company',
		'the rules: the outsider');
	perform pg_temp.base_error($q$select * from public.qorpera_coding_owner_sponsor('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000005', 'codex')$q$, '42501', 'The session owner is not a member of this company');
end $$;

-- 5. Unknown usage after measured room, before a used-up login; ties as today: the newest, then the id -------------
do $$
declare v_at timestamptz := clock_timestamp();
begin
	perform pg_temp.f1_usage(pg_temp.f1('a'), 90);
	perform pg_temp.f1_usage(pg_temp.f1('b'), null);
	perform pg_temp.base_assert(public.qorpera_native_account_remaining(pg_temp.f1('b'), 2) = -1, 'B reports nothing');
	perform pg_temp.f1_pays(pg_temp.f1('a'), pg_temp.f1('aBinding'), 'measured room before unknown usage');
	perform pg_temp.f1_usage(pg_temp.f1('a'), null);
	perform pg_temp.f1_usage(pg_temp.f1('b'), 100);
	perform pg_temp.f1_pays(pg_temp.f1('a'), pg_temp.f1('aBinding'), 'unknown usage before a used-up login');
	perform pg_temp.f1_usage(pg_temp.f1('a'), 50);
	perform pg_temp.f1_usage(pg_temp.f1('b'), 50);
	perform pg_temp.f1_pays(pg_temp.f1('b'), pg_temp.f1('bBinding'), 'equal room: the newest');
	perform pg_temp.f1_usage(pg_temp.f1('a'), null);
	perform pg_temp.f1_usage(pg_temp.f1('b'), null);
	perform pg_temp.f1_pays(pg_temp.f1('b'), pg_temp.f1('bBinding'), 'both unknown: the newest');
	-- Two of the owner's logins as new as each other with the same room, more than A's and B's: the lower id, whichever
	-- was written first.
	perform pg_temp.f1_usage(pg_temp.f1('a'), 50);
	perform pg_temp.f1_usage(pg_temp.f1('b'), 50);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c9', '92400000-0000-4000-8000-000000000001', 'openai', 'codex-cli', true, v_at);
	perform pg_temp.f1_clone('50500000-0000-4000-8000-0000000000c8', '92400000-0000-4000-8000-000000000001', 'openai', 'codex-cli', true, v_at);
	perform pg_temp.f1_usage('50500000-0000-4000-8000-0000000000c8', 30);
	perform pg_temp.f1_usage('50500000-0000-4000-8000-0000000000c9', 30);
	perform pg_temp.base_assert(pg_temp.f1_login('92400000-0000-4000-8000-000000000001') = '50500000-0000-4000-8000-0000000000c8',
		'equal room and age: the lower id, not ' || coalesce(pg_temp.f1_login('92400000-0000-4000-8000-000000000001')::text, 'none'));
	-- Both revoked again (no run uses them): B, as before.
	update public.qorpera_provider_connections set status = 'revoked'
	where id in ('50500000-0000-4000-8000-0000000000c8', '50500000-0000-4000-8000-0000000000c9');
	perform pg_temp.f1_pays(pg_temp.f1('b'), pg_temp.f1('bBinding'), 'revoked logins never pay');
end $$;

-- 6. An existing session keeps its payer: session 1 stays on A at its limit while B has all its room, and its next turn
-- waits for A's room ------------------------------------------------------------------------------------------------
-- The owner's coding machine is on exec-505, so the fleet picks it for the owner's sessions (as 928 §8).
set local session_replication_role = replica;
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
values ('50500000-0000-4000-8000-0000000000d1', 'member', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000001', 'exec-505', repeat('7', 64), '{}');
set local session_replication_role = origin;
do $$
declare v_alice jsonb := pg_temp.f1_alice(); v_folder text := 'QorperaOS/agents/alice/todos/fix-login/session-1'; v_result jsonb;
	v_claim jsonb; v_begin jsonb; v_wake public.qorpera_wake_occurrences%rowtype; w public.qorpera_runtime_workers%rowtype;
begin
	perform pg_temp.f1_usage(pg_temp.f1('a'), 100);
	perform pg_temp.f1_usage(pg_temp.f1('b'), 0);
	perform pg_temp.f1_pays(pg_temp.f1('b'), pg_temp.f1('bBinding'), 'new work after A''s limit');
	-- The member's answer turns session 1 on A.
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'f1-cancel-1'));
	perform pg_temp.f1_answer('50500000-0000-4000-8000-0000000000b1', 'Keep the old route.');
	w := pg_temp.f1_worker('50500000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 2 and w.owner_sponsor_binding_id = pg_temp.f1('aBinding'),
		'the answer keeps A: ' || to_jsonb(w)::text);
	-- So does the agent's follow-up.
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder, 'operationKey', 'f1-cancel-2'));
	v_result := pg_temp.f1_followup(v_alice, 'f1-followup-1', v_folder, 'Only the login route.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the follow-up: ' || v_result::text);
	w := pg_temp.f1_worker('50500000-0000-4000-8000-0000000000b1');
	perform pg_temp.base_assert(w.state = 'active' and w.sequence = 3 and w.owner_sponsor_binding_id = pg_temp.f1('aBinding')
		and (pg_temp.f1_session(w.id)).phase = 'input_ready', 'the follow-up keeps A: ' || to_jsonb(w)::text);
	-- While A is at its limit the session's next turn waits: the executor claims nothing (20260930575000).
	perform pg_temp.base_claims('service_role');
	v_claim := public.qorpera_claim_coding_session('exec-505', 60);
	perform pg_temp.base_assert(v_claim is null and (pg_temp.f1_session(w.id)).phase = 'input_ready'
		and public.qorpera_coding_session_waits_for_usage_limit(w.id),
		'a turn was claimed at its login''s usage limit: ' || coalesce(v_claim::text, 'none'));
	-- Once A has room again, the turn goes on by itself, and its wake pays with A.
	perform pg_temp.f1_usage(pg_temp.f1('a'), 40);
	v_claim := public.qorpera_claim_coding_session('exec-505', 60);
	perform pg_temp.base_assert(v_claim ->> 'workerId' = w.id::text, 'the claim: ' || coalesce(v_claim::text, 'none'));
	v_begin := public.qorpera_begin_coding_turn(w.id, (pg_temp.f1_session(w.id)).lease_token, '{}');
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_begin ->> 'occurrenceId')::uuid;
	perform pg_temp.base_assert(v_wake.source_kind = 'worker-dispatch' and v_wake.source_id = w.id
		and v_wake.sponsor_binding_id = pg_temp.f1('aBinding')
		and (pg_temp.f1_worker(w.id)).owner_sponsor_binding_id = pg_temp.f1('aBinding'), 'the turn''s wake pays with A: ' || to_jsonb(v_wake)::text);
	-- A new session starts on B.
	v_result := pg_temp.f1_dispatch(v_alice, 'f1-dispatch-2', 'QorperaOS/agents/alice/todos/fix-login/session-2',
		pg_temp.f1_brief('50500000-0000-4000-8000-0000000000b3', p_title => 'Fix the logout page'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the second dispatch: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.f1_worker('50500000-0000-4000-8000-0000000000b3')).owner_sponsor_binding_id = pg_temp.f1('bBinding')
		and (pg_temp.f1_worker('50500000-0000-4000-8000-0000000000b1')).owner_sponsor_binding_id = pg_temp.f1('aBinding'),
		'the new session on B, the first still on A');
end $$;

-- 7. The plan rule stays ahead of the room: B, a ChatGPT plan with all its room, comes after A at its limit -----------
set local session_replication_role = replica;
insert into public.qorpera_model_logins(id, profile_id, compute_identity_id, credential_capsule_id, broker_authority_id, provider,
	native_harness, current_version, access_issued_at, access_expires_at, login_kind)
select '50500000-0000-4000-8000-0000000000e1', '92400000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid, v.credential_capsule_id,
	'50500000-0000-4000-8000-0000000000e2', 'openai', 'codex-cli', 1, clock_timestamp(), clock_timestamp() + interval '1 hour',
	'chatgpt_plan'
from public.qorpera_provider_connection_versions v
where v.connection_id = (current_setting('qorpera_test.f1_connection')::jsonb ->> 'connection_id')::uuid and v.version = 2;
set local session_replication_role = origin;
do $$
begin
	perform pg_temp.base_assert(public.qorpera_connection_is_chatgpt_plan(pg_temp.f1('b'))
		and not public.qorpera_connection_is_chatgpt_plan(pg_temp.f1('a')), 'B is a ChatGPT plan');
	perform pg_temp.f1_pays(pg_temp.f1('a'), pg_temp.f1('aBinding'), 'the plan after A at its limit');
	-- Also for work B's own run asks for, as today.
	perform pg_temp.base_assert(public.qorpera_coding_owner_problem('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000001', 'codex', pg_temp.f1('bBinding')) is null, 'the rules, for B''s run');
end $$;

-- 8. The grants: the login, the rules' check and the payer are the database's own ---------------------------------
do $$
declare v_fn text;
begin
	foreach v_fn in array array['public.qorpera_coding_owner_login(uuid,uuid,text)',
		'public.qorpera_coding_owner_problem(uuid,uuid,text,uuid)', 'public.qorpera_coding_owner_payer(uuid,uuid,text,uuid)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_fn, 'execute')
			and not has_function_privilege('authenticated', v_fn, 'execute')
			and not has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' is postgres-only');
	end loop;
	perform pg_temp.base_assert((select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
		from pg_proc p where p.oid = 'public.qorpera_coding_owner_login(uuid,uuid,text)'::regprocedure),
		'the login is a stable security definer with an empty search_path');
end $$;

rollback;
