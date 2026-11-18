-- @fixture 1268_claude_code_worker_dispatch.test.sql until "-- The checks start here"

insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
select pg_temp.c4_login('12900000-0000-4000-8000-0000000000c1', pg_temp.c4_owner_id(), 'canary-usage-sealed-1') \g /dev/null
do $$
declare v_alice jsonb := pg_temp.c4_alice(); v_result jsonb; v_binding jsonb; v_wake public.qorpera_wake_occurrences%rowtype;
	v_i integer;
begin
	v_result := pg_temp.c4_dispatch(v_alice, 'cu-dispatch-1', 'QorperaOS/agents/alice/todos/onboarding/pdf',
		pg_temp.c4_brief('12900000-0000-4000-8000-0000000000b1'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the dispatch: ' || v_result::text);
	v_result := pg_temp.c4_dispatch(v_alice, 'cu-dispatch-2', 'QorperaOS/agents/alice/todos/onboarding/notes',
		pg_temp.c4_brief('12900000-0000-4000-8000-0000000000b2', 'codex', 'Read the notes'));
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'saved', 'the plain dispatch: ' || v_result::text);
	perform pg_temp.base_assert((pg_temp.c4_worker('12900000-0000-4000-8000-0000000000b2')).harness is null
		and (pg_temp.c4_worker('12900000-0000-4000-8000-0000000000b2')).claude_login_id is null,
		'the plain dispatch asks for Codex, so Claude first leaves it a Codex worker');
	perform pg_temp.c4_drain();
	perform pg_temp.base_materialize();
	select * into strict v_wake from public.qorpera_wake_occurrences
	where id = (pg_temp.c4_worker('12900000-0000-4000-8000-0000000000b1')).occurrence_id;
	for v_i in 1..2 loop
		v_binding := pg_temp.base_start(null);
		perform set_config(case when (v_binding ->> 'runId')::uuid = v_wake.run_id then 'qorpera_test.cu_binding'
			else 'qorpera_test.cu_plain_binding' end, v_binding::text, false);
	end loop;
	perform pg_temp.base_assert(current_setting('qorpera_test.cu_binding', true) is not null
		and current_setting('qorpera_test.cu_plain_binding', true) is not null, 'both runs started');
end $$;

create function pg_temp.cu_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then return sqlstate;
end $$;
create function pg_temp.cu_login() returns public.qorpera_claude_logins language sql as $$
	select * from public.qorpera_claude_logins where id = '12900000-0000-4000-8000-0000000000c1'
$$;
create function pg_temp.cu_request(p_capability text) returns public.qorpera_native_account_refresh_requests
language sql as $$
	select * from public.qorpera_native_account_refresh_requests where capability_sha256 = p_capability
$$;
create function pg_temp.cu_usage(p_at text, p_used numeric, p_model boolean default false) returns jsonb language sql as $$
	select jsonb_build_object('observedAt', p_at, 'windows', jsonb_build_array(
		jsonb_build_object('id', 'five_hour', 'label', '5 hours', 'usedPercent', p_used, 'resetAt', '2026-11-17T13:00:00Z'),
		jsonb_build_object('id', 'seven_day', 'label', 'Weekly', 'usedPercent', 50))
		|| case when p_model then jsonb_build_array(jsonb_build_object('id', 'seven_day_model', 'label', 'Weekly · Fable',
			'usedPercent', 9)) else '[]'::jsonb end)
$$;
create function pg_temp.cu_resets(p_at text) returns jsonb language sql as $$
	select jsonb_build_object('observedAt', p_at, 'entries', jsonb_build_array(jsonb_build_object('kind', 'full', 'left', 3,
		'refills', '5-hour and weekly limits', 'weekStays', '2026-11-20T11:00:00.000Z', 'useBy', '2026-12-01T11:00:00.000Z',
		'usable', 'now')))
$$;
create function pg_temp.cu_now() returns text language sql as $$
	select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.cu_begin(p_capability text, p_force boolean default true, p_kind text default null) returns jsonb
language sql as $$
	select public.qorpera_begin_claude_login_read('92400000-0000-4000-8000-000000000010', extensions.gen_random_uuid(),
		p_capability, p_force, p_kind)
$$;
create function pg_temp.cu_describe(p_request uuid, p_capability text) returns jsonb language sql as $$
	select public.qorpera_describe_claude_login_read('12680000-0000-4000-8000-000000000040', repeat('c', 64), p_request,
		p_capability)
$$;
create function pg_temp.cu_record(p_request uuid, p_capability text, p_usage jsonb, p_resets jsonb, p_reset jsonb)
returns jsonb language sql as $$
	select public.qorpera_record_claude_login_read('12680000-0000-4000-8000-000000000040', repeat('c', 64), p_request,
		p_capability, p_usage, p_resets, p_reset)
$$;
create function pg_temp.cu_claim(p_request uuid, p_capability text,
	p_claim uuid default '12900000-0000-4000-8000-0000000000aa') returns boolean language sql as $$
	select public.qorpera_claim_claude_login_reset('12680000-0000-4000-8000-000000000040', repeat('c', 64), p_request,
		p_capability, p_claim)
$$;
create function pg_temp.cu_complete(p_request uuid, p_capability text) returns boolean language sql as $$
	select public.qorpera_complete_model_login_account_refresh('12680000-0000-4000-8000-000000000040', repeat('c', 64),
		p_request, p_capability)
$$;
grant execute on function pg_temp.cu_state(text), pg_temp.cu_usage(text, numeric, boolean), pg_temp.cu_resets(text),
	pg_temp.cu_now(), pg_temp.cu_begin(text, boolean, text), pg_temp.cu_describe(uuid, text),
	pg_temp.cu_record(uuid, text, jsonb, jsonb, jsonb), pg_temp.cu_claim(uuid, text, uuid), pg_temp.cu_complete(uuid, text),
	pg_temp.base_assert(boolean, text)
	to qorpera_secret_broker, service_role, authenticated;

do $$
declare v_role text;
begin
	foreach v_role in array array['anon', 'service_role', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role,
			'public.qorpera_begin_claude_login_read(uuid,uuid,text,boolean,text)', 'execute'), v_role || ' begins a read');
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role,
			'public.qorpera_describe_claude_login_read(uuid,text,uuid,text)', 'execute')
			and not has_function_privilege(v_role, 'public.qorpera_claim_claude_login_reset(uuid,text,uuid,text,uuid)', 'execute')
			and not has_function_privilege(v_role,
				'public.qorpera_record_claude_login_read(uuid,text,uuid,text,jsonb,jsonb,jsonb)', 'execute'),
			v_role || ' calls the vault''s Claude reads');
	end loop;
	foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
		perform pg_temp.base_assert(not has_function_privilege(v_role, 'public.qorpera_record_claude_run_usage(jsonb,jsonb)',
			'execute'), v_role || ' records a run''s usage');
	end loop;
	perform pg_temp.base_assert(has_function_privilege('authenticated',
			'public.qorpera_begin_claude_login_read(uuid,uuid,text,boolean,text)', 'execute')
		and has_function_privilege('qorpera_secret_broker',
			'public.qorpera_record_claude_login_read(uuid,text,uuid,text,jsonb,jsonb,jsonb)', 'execute')
		and has_function_privilege('service_role', 'public.qorpera_record_claude_run_usage(jsonb,jsonb)', 'execute'),
		'the Claude usage grants');
	perform pg_temp.base_assert((select scope from public.qorpera_native_host_calls
		where name = 'qorpera_record_claude_run_usage') = 'binding', 'the run host''s call has its entry point');
end $$;

select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
select pg_temp.base_assert((public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') ->> 'readable')::boolean,
	'the member''s Claude login is readable here');
select pg_temp.cu_begin(repeat('1', 64)) \g /dev/null
select pg_temp.base_assert(pg_temp.cu_state($q$select pg_temp.cu_begin(repeat('2', 64))$q$) = '55000',
	'one read at a time');
select pg_temp.base_assert(pg_temp.cu_state($q$select pg_temp.cu_begin(repeat('3', 64), true, 'full')$q$) = '55000',
	'no reset the last read did not show');
select pg_temp.base_assert(pg_temp.cu_state($q$select pg_temp.cu_begin(repeat('3', 64), true, 'lunar')$q$) = '42501',
	'no reset kind Claude Code does not have');
reset role;
select pg_temp.base_claims('service_role');
do $$
declare v_request public.qorpera_native_account_refresh_requests := pg_temp.cu_request(repeat('1', 64));
begin
	perform pg_temp.base_assert(v_request.status = 'pending' and v_request.claude_usage and v_request.claude_resets
		and v_request.claude_login_id = '12900000-0000-4000-8000-0000000000c1' and v_request.claude_reset_kind is null,
		'a forced read asks for usage and resets: ' || row_to_json(v_request)::text);
	perform pg_temp.base_assert(public.qorpera_runtime_account_refresh_gateway_choose(repeat('1', 64)) ->> 'reason'
		= 'MODEL_LOGIN_VAULT', 'the chooser sends a Claude read to the vault');
	perform set_config('qorpera_test.cu_read', v_request.id::text, false);
end $$;

set local session authorization qorpera_secret_broker;
do $$
declare v_request uuid := current_setting('qorpera_test.cu_read')::uuid; v_answer jsonb;
begin
	v_answer := pg_temp.cu_describe(v_request, repeat('1', 64));
	perform pg_temp.base_assert(v_answer ->> 'state' = 'open' and v_answer ->> 'claudeLoginId' = '12900000-0000-4000-8000-0000000000c1'
		and (v_answer ->> 'usage')::boolean and (v_answer ->> 'resets')::boolean and v_answer -> 'reset' = 'null'::jsonb
		and decode(v_answer ->> 'encryptedEnvelopeBase64', 'base64') = convert_to('canary-usage-sealed-1', 'UTF8'),
		'the vault opens the login for the read: ' || v_answer::text);
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_describe(%L, repeat('9', 64))$q$, v_request))
		= '42501', 'another capability reads nothing');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_record(%L, repeat('1', 64), %L, null, null)$q$,
		v_request, jsonb_build_object('observedAt', pg_temp.cu_now(), 'windows', jsonb_build_array(jsonb_build_object(
			'id', 'five_hour', 'label', '5 hours', 'usedPercent', 140))))) = '22023', 'a usage out of shape');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_record(%L, repeat('1', 64), null, null, %L)$q$,
		v_request, '{"outcome":"reset","left":1}')) = '22023', 'no reset outcome for a read');
	perform pg_temp.cu_record(v_request, repeat('1', 64), pg_temp.cu_usage(pg_temp.cu_now(), 28, true),
		pg_temp.cu_resets(pg_temp.cu_now()), null);
	perform pg_temp.cu_complete(v_request, repeat('1', 64));
	perform pg_temp.base_assert(pg_temp.cu_describe(v_request, repeat('1', 64)) ->> 'state' = 'completed',
		'a completed read opens nothing');
end $$;
reset session authorization;

select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
do $$
declare v_list jsonb := public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') -> 'logins' -> 0;
	v_answer jsonb;
begin
	perform pg_temp.base_assert(jsonb_array_length(v_list -> 'usage' -> 'windows') = 3
		and v_list -> 'resets' -> 'entries' -> 0 ->> 'kind' = 'full' and v_list -> 'lastReset' = 'null'::jsonb,
		'the member lists the usage and resets: ' || v_list::text);
	v_answer := pg_temp.cu_begin(repeat('4', 64), false);
	perform pg_temp.base_assert(v_answer ->> 'status' = 'completed', 'a fresh reading answers at once: ' || v_answer::text);
	v_answer := pg_temp.cu_begin(repeat('5', 64), true, 'full');
	perform pg_temp.base_assert(v_answer ->> 'status' = 'pending', 'the member''s click asks for the reset');
end $$;
reset role;
select set_config('qorpera_test.cu_reset', (pg_temp.cu_request(repeat('5', 64))).id::text, false) \g /dev/null

set local session authorization qorpera_secret_broker;
do $$
declare v_request uuid := current_setting('qorpera_test.cu_reset')::uuid; v_answer jsonb;
begin
	v_answer := pg_temp.cu_describe(v_request, repeat('5', 64));
	perform pg_temp.base_assert(v_answer ->> 'reset' = 'full' and v_answer ->> 'resetState' = 'asked'
		and not (v_answer ->> 'usage')::boolean and not (v_answer ->> 'resets')::boolean, 'the vault reads the click: ' || v_answer::text);
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_record(%L, repeat('5', 64), null, null, %L)$q$,
		v_request, '{"outcome":"reset","left":2}')) = '22023', 'no outcome before the reset was claimed');
	perform pg_temp.base_assert(pg_temp.cu_claim(v_request, repeat('5', 64)), 'the vault claims the reset');
	perform pg_temp.base_assert(pg_temp.cu_claim(v_request, repeat('5', 64)), 'a lost answer is claimed again with its token');
	perform pg_temp.base_assert(not pg_temp.cu_claim(v_request, repeat('5', 64), '12900000-0000-4000-8000-0000000000bb'),
		'another claim is refused');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_record(%L, repeat('5', 64), null, null, %L)$q$,
		v_request, '{"outcome":"spent"}')) = '22023', 'an outcome Claude Code never gives');
	perform pg_temp.cu_record(v_request, repeat('5', 64), null, null, '{"outcome":"reset","left":2}');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_record(%L, repeat('5', 64), null, null, %L)$q$,
		v_request, '{"outcome":"failed"}')) = '22023', 'an outcome is recorded once');
	perform pg_temp.base_assert(not pg_temp.cu_claim(v_request, repeat('5', 64)), 'a used reset is not claimed again');
	perform pg_temp.base_assert(not pg_temp.cu_claim(v_request, repeat('5', 64), '12900000-0000-4000-8000-0000000000bb'),
		'nor by another claim');
	perform pg_temp.cu_complete(v_request, repeat('5', 64));
end $$;
reset session authorization;

select pg_temp.base_claims('service_role');
do $$
declare v_login public.qorpera_claude_logins := pg_temp.cu_login();
begin
	perform pg_temp.base_assert(v_login.last_reset ->> 'outcome' = 'reset' and v_login.last_reset ->> 'kind' = 'full'
		and v_login.last_reset ->> 'requestId' = current_setting('qorpera_test.cu_reset') and (v_login.last_reset ->> 'left')::int = 2
		and v_login.resets is null, 'the reset is kept and the resets are read again: ' || row_to_json(v_login)::text);
	perform pg_temp.base_assert((pg_temp.cu_request(repeat('5', 64))).claude_reset_state = 'reset', 'the request says so');
end $$;

do $$
declare v_binding jsonb := current_setting('qorpera_test.cu_binding')::jsonb;
	v_plain jsonb := current_setting('qorpera_test.cu_plain_binding')::jsonb; v_answer jsonb; v_login public.qorpera_claude_logins;
begin
	v_answer := public.qorpera_record_claude_run_usage(v_binding, pg_temp.cu_usage(pg_temp.cu_now(), 64));
	v_login := pg_temp.cu_login();
	perform pg_temp.base_assert((v_answer ->> 'recorded')::boolean and (v_login.usage -> 'windows' -> 0 ->> 'usedPercent')::numeric = 64
		and v_login.usage -> 'windows' -> 2 ->> 'label' = 'Weekly · Fable',
		'a run''s reading is kept with the last per-model window: ' || v_login.usage::text);
	v_answer := public.qorpera_record_claude_run_usage(v_binding, pg_temp.cu_usage('2026-01-01T00:00:00.000Z', 1));
	perform pg_temp.base_assert(not (v_answer ->> 'recorded')::boolean
		and ((pg_temp.cu_login()).usage -> 'windows' -> 0 ->> 'usedPercent')::numeric = 64, 'an older reading changes nothing');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select public.qorpera_record_claude_run_usage(%L, %L)$q$,
		v_plain, pg_temp.cu_usage(pg_temp.cu_now(), 5))) = '42501', 'a run that is no Claude Code worker''s');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select public.qorpera_record_claude_run_usage(%L, %L)$q$,
		v_binding, pg_temp.cu_usage(pg_temp.cu_now(), 5, true))) = '22023', 'a run reports no per-model window');
	perform pg_temp.base_assert(pg_temp.cu_state(format($q$select public.qorpera_record_claude_run_usage(%L, %L)$q$,
		v_binding, pg_temp.cu_usage('2099-01-01T00:00:00.000Z', 5))) = '22023', 'a reading from the future');
end $$;

select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
select pg_temp.base_assert(public.qorpera_get_native_account_refresh('92400000-0000-4000-8000-000000000010') is null,
	'a ChatGPT refresh never waits on a Claude read');
reset role;
select pg_temp.base_claims('service_role');
update public.qorpera_account_model_login_settings set enabled = false;
select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
select pg_temp.base_assert(not (public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010') ->> 'readable')::boolean,
	'with account logins off the card reads nothing');
select pg_temp.base_assert(pg_temp.cu_state($q$select pg_temp.cu_begin(repeat('7', 64))$q$) = '42501',
	'with account logins off no read begins');
reset role;
select pg_temp.base_claims('service_role');
update public.qorpera_account_model_login_settings set enabled = true;
select pg_temp.base_claims('authenticated', pg_temp.c4_owner_id());
set local role authenticated;
select pg_temp.cu_begin(repeat('8', 64)) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');
delete from public.qorpera_claude_sign_in_members where user_id = pg_temp.c4_owner_id();
select set_config('qorpera_test.cu_late', (pg_temp.cu_request(repeat('8', 64))).id::text, false) \g /dev/null
set local session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.cu_state(format($q$select pg_temp.cu_describe(%L, repeat('8', 64))$q$,
	current_setting('qorpera_test.cu_late'))) = '42501', 'a member taken off the Claude list: the vault opens nothing');
reset session authorization;
select pg_temp.base_claims('service_role');
insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.base_assert(pg_temp.cu_state($q$select pg_temp.cu_begin(repeat('6', 64))$q$) in ('42501', '55000'),
	'another member reads nothing of the owner''s Claude login');
select pg_temp.base_assert(jsonb_array_length(public.qorpera_list_claude_logins('92400000-0000-4000-8000-000000000010')
	-> 'logins') = 0, 'and lists none of it');
reset role;

select pg_temp.base_assert(position('previous.claude_login_id is null' in
		pg_get_functiondef('public.qorpera_begin_native_account_refresh(uuid,uuid,text)'::regprocedure)) > 0,
	'a ChatGPT refresh''s short cache never answers with a Claude read');
select pg_temp.base_assert((length(pg_get_functiondef('public.qorpera_begin_model_login_usage_recheck(uuid,text,text)'::regprocedure))
		- length(replace(pg_get_functiondef('public.qorpera_begin_model_login_usage_recheck(uuid,text,text)'::regprocedure),
			'recent.claude_login_id is null', ''))) / length('recent.claude_login_id is null') = 2,
	'a Claude read never holds off the daily usage recheck');
