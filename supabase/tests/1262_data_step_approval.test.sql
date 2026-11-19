-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930764000 on 924's real native run of Alice's: a data pass that carries a member's yes to a held step. The run
-- gets one only for a review that is this agent's data_apply, asked on a card, answered Allow by a member and used by
-- this very run, whose arguments name the database asked for and an `allow`; the gateway's redeem then answers that
-- `allow`. A reviewer's own allow, an unanswered card, a denial, another run's approval, another agent's, another
-- tool's, another database's and arguments without an `allow` all get no pass (42501, the same words). A plain pass
-- answers no `allow`, as before. The pass's own refusals stand. Only the service role makes one; the native host lists it.

create function pg_temp.da_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.da_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.da_binding() returns jsonb language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb
$$;
create function pg_temp.da_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId') from pg_temp.da_binding() b
$$;
-- The gateway's redeem, as the publishable key's role calls it.
create function pg_temp.da_redeem(p_pass text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('anon');
	v := public.qorpera_data_pass_redeem(p_pass);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- An approved pass as the service role asks for it (the native host's dispatch runs the call as the service role).
create function pg_temp.da_pass(p_database text, p_review uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	v := public.qorpera_run_data_pass_approved('92400000-0000-4000-8000-000000000020', pg_temp.da_actor(), p_database,
		p_review);
	return v;
end $$;
create function pg_temp.da_allow(p_step text default '002-clear') returns text language sql immutable as $$
	select p_step || '.' || repeat('a', 64) || '.' || repeat('b', 64)
$$;
-- A review of the base run's agent, as the kernel keeps one. p_state: 'approved' (a member's Allow, used by the run
-- p_used), 'unused' (a member's Allow no run used yet), 'waiting' (an unanswered card), 'denied' (a member's Deny),
-- 'reviewer' (the reviewer's own allow, in this run).
create function pg_temp.da_review(p_id uuid, p_state text, p_arguments text, p_tool text default 'data_apply',
	p_used uuid default null, p_agent uuid default null, p_answered_by uuid default '92400000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v_run public.qorpera_execution_runs%rowtype; v_ask boolean := p_state <> 'reviewer';
	v_answer text := case p_state when 'approved' then 'allow_once' when 'unused' then 'always_allow'
		when 'denied' then 'deny' end;
begin
	select run.* into strict v_run from public.qorpera_execution_runs as run
	where run.id = (pg_temp.da_binding() ->> 'runId')::uuid;
	insert into public.qorpera_action_reviews(id, profile_id, run_id, call_id, staff_agent_id, requester_user_id, tool_name,
		effect, argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, approver_user_id,
		answer, answered_by_user_id, answered_at, consumed_at, consumed_run_id)
	values (p_id, v_run.profile_id, v_run.id, 'call_' || replace(p_id::text, '-', ''),
		coalesce(p_agent, v_run.staff_agent_id), v_run.requested_by_user_id, p_tool, 'destructive', repeat('3', 64),
		jsonb_build_object('title', 'Apply a database step that destroys data', 'arguments', p_arguments),
		case when v_ask then 'ask' else 'allow' end, 'none', 'A step that destroys data runs only on a member''s yes.',
		'test', case when v_ask then 'member' end, case when v_ask then v_run.requested_by_user_id end,
		v_answer, case when v_answer is not null then p_answered_by end,
		case when v_answer is not null then clock_timestamp() end,
		case when p_state = 'approved' then clock_timestamp() end,
		case when p_state = 'approved' then coalesce(p_used, v_run.id) end);
	return p_id;
end $$;
create function pg_temp.da_arguments(p_database text default 'shop', p_allow text default pg_temp.da_allow())
returns text language sql as $$
	select jsonb_build_object('allow', p_allow, 'database', p_database)::text
$$;

-- The company's databases: shop with two steps, and stock.
select pg_temp.base_commit('{"kind":"platform"}', 'data-approval-seed', jsonb_build_array(
	jsonb_build_object('op', 'mkdir', 'path', 'data'),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\nname = "Shop"\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/shop/tables'),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/001-orders.sql',
		'file', pg_temp.base_stage(E'create table orders (id int primary key, amount int);\n')),
	jsonb_build_object('op', 'write', 'path', 'data/shop/tables/002-clear.sql',
		'file', pg_temp.base_stage(E'delete from orders where amount = 0;\n')),
	jsonb_build_object('op', 'mkdir', 'path', 'data/stock'),
	jsonb_build_object('op', 'write', 'path', 'data/stock/database.toml',
		'file', pg_temp.base_stage(E'format = "qorpera.database/v1"\n')))) \g /dev/null
select pg_temp.base_claims('service_role');

-- 1. The grants and the native host's list; the passes' new column takes only an allow.
do $$ begin
	if has_function_privilege('anon', 'public.qorpera_run_data_pass_approved(uuid,jsonb,text,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_run_data_pass_approved(uuid,jsonb,text,uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_run_data_pass_approved(uuid,jsonb,text,uuid)', 'EXECUTE')
		then raise exception '1: qorpera_run_data_pass_approved has the wrong grants'; end if;
	if not has_function_privilege('anon', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_data_pass_redeem(text)', 'EXECUTE') then
		raise exception '1: qorpera_data_pass_redeem has the wrong grants'; end if;
	if has_table_privilege('service_role', 'public.qorpera_data_passes', 'select')
		or has_table_privilege('service_role', 'public.qorpera_data_passes', 'update') then
		raise exception '1: an API role reaches the passes table'; end if;
	perform pg_temp.da_same((select scope || ' ' || budget from public.qorpera_native_host_calls
		where name = 'qorpera_run_data_pass_approved'), 'folder standard', '1: the native host''s list');
	-- The plain pass is as it was: its three inputs, and the one function of its name the host can call.
	perform pg_temp.da_same((select count(*) from pg_proc where pronamespace = 'public'::regnamespace
		and proname in ('qorpera_run_data_pass', 'qorpera_run_data_pass_approved'))::text, '2', '1: one function a name');
end $$;

-- 2. A member's Allow that this run used: through the native host's entry point with the job's lease token, the pass
--    is made as a plain one is and carries the review's allow; the redeem answers it, once.
select set_config('qorpera_test.da_token', 'da1262-lease-token-0123456789abcdef', false);
update public.qorpera_runner_jobs
set lease_token_sha256 = encode(extensions.digest(convert_to(current_setting('qorpera_test.da_token'), 'utf8'), 'sha256'), 'hex')
where id = (pg_temp.da_binding() ->> 'jobId')::uuid;
select pg_temp.da_review('92400000-0000-4000-8000-0000000a0001', 'approved', pg_temp.da_arguments()) \g /dev/null
do $$
declare v_made jsonb; v_redeemed jsonb; v_plain jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"anon"}', true);
	perform set_config('request.path', '/rpc/qorpera_native_host_call', true);
	v_made := public.qorpera_native_host_call((pg_temp.da_binding() ->> 'jobId')::uuid,
		current_setting('qorpera_test.da_token'), 'qorpera_run_data_pass_approved', jsonb_build_object(
			'p_environment_id', '92400000-0000-4000-8000-000000000020', 'p_actor', pg_temp.da_actor(), 'p_database', 'shop',
			'p_review_id', '92400000-0000-4000-8000-0000000a0001'));
	perform set_config('request.path', '', true);
	perform pg_temp.da_same(v_made ->> 'schema', 'qorpera.data-pass/v1', '2: the pass''s schema');
	perform pg_temp.da_same(v_made ->> 'files', '3', '2: the files kept');
	perform pg_temp.da_same((select allow from public.qorpera_data_passes
		where pass_sha256 = extensions.digest(v_made ->> 'pass', 'sha256')), pg_temp.da_allow(), '2: the row''s allow');
	v_redeemed := pg_temp.da_redeem(v_made ->> 'pass');
	perform pg_temp.da_same((v_redeemed - 'files')::text, jsonb_build_object('schema', 'qorpera.data-pass-redeemed/v1',
		'kind', 'run', 'environmentId', '92400000-0000-4000-8000-000000000020', 'runId', pg_temp.da_binding() ->> 'runId',
		'staffAgentId', '92400000-0000-4000-8000-000000000030', 'requesterUserId', '92400000-0000-4000-8000-000000000001',
		'database', 'shop', 'allow', pg_temp.da_allow())::text, '2: what the pass kept');
	perform pg_temp.da_same(jsonb_array_length(v_redeemed -> 'files')::text, '3', '2: the files redeemed');
	perform pg_temp.da_same(pg_temp.da_redeem(v_made ->> 'pass')::text, null, '2: a redeemed pass');
	-- The same approval serves this run again (an apply that asks twice): a second pass carries it too.
	perform pg_temp.da_same(pg_temp.da_redeem(pg_temp.da_pass('shop', '92400000-0000-4000-8000-0000000a0001') ->> 'pass')
		->> 'allow', pg_temp.da_allow(), '2: a second pass of the same run');
	-- A plain pass names no allow, and answers what it answered before.
	perform pg_temp.base_claims('service_role');
	v_plain := pg_temp.da_redeem(public.qorpera_run_data_pass('92400000-0000-4000-8000-000000000020', pg_temp.da_actor(),
		'shop') ->> 'pass');
	perform pg_temp.da_same((v_plain ? 'allow')::text, 'false', '2: a plain pass''s allow');
	perform pg_temp.da_same((select string_agg(k, ' ' order by k) from jsonb_object_keys(v_plain) k),
		'database environmentId files kind requesterUserId runId schema staffAgentId', '2: a plain pass''s keys');
	perform pg_temp.da_same(jsonb_array_length(v_plain -> 'files')::text, '3', '2: a plain pass''s files');
	perform pg_temp.da_same((select count(*) from public.qorpera_data_passes where allow is null)::text, '1',
		'2: the plain pass''s row has none');
end $$;
select pg_temp.base_claims('service_role');

-- 3. No pass without a member's yes that this run used, for this database, with an allow. The same words for each.
do $$
declare v_case record; v_refused constant text :=
	'42501 DATA_APPROVAL_REQUIRED: a step that destroys data is applied only after a member approves it on a card';
	v_other_run constant uuid := '92400000-0000-4000-8000-0000000a00ff';
begin
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0002', 'reviewer', pg_temp.da_arguments());
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0003', 'waiting', pg_temp.da_arguments());
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0004', 'denied', pg_temp.da_arguments());
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0005', 'unused', pg_temp.da_arguments());
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0006', 'approved', pg_temp.da_arguments(), 'data_apply',
		v_other_run);
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0007', 'approved', pg_temp.da_arguments(), 'data_change');
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0008', 'approved', pg_temp.da_arguments(), 'company_delete');
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0009', 'approved', pg_temp.da_arguments('stock'));
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000a', 'approved', '{"database":"shop"}');
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000b', 'approved',
		pg_temp.da_arguments('shop', '002-clear'));
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000c', 'approved',
		pg_temp.da_arguments('shop', pg_temp.da_allow() || 'c'));
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000d', 'approved', 'database=shop allow=' || pg_temp.da_allow());
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000e', 'approved', '["shop"]');
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a000f', 'approved',
		jsonb_build_object('allow', jsonb_build_array(pg_temp.da_allow()), 'database', 'shop')::text);
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0010', 'approved', pg_temp.da_arguments(), 'data_apply',
		null, '92400000-0000-4000-8000-0000000a00aa');
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0011', 'approved', pg_temp.da_arguments(), 'data_apply',
		null, null, null);
	for v_case in select * from (values
		('92400000-0000-4000-8000-0000000a0002'::uuid, 'the reviewer''s own allow'),
		('92400000-0000-4000-8000-0000000a0003', 'a card no one answered'),
		('92400000-0000-4000-8000-0000000a0004', 'a member''s Deny'),
		('92400000-0000-4000-8000-0000000a0005', 'an Allow no run used'),
		('92400000-0000-4000-8000-0000000a0006', 'an Allow another run used'),
		('92400000-0000-4000-8000-0000000a0007', 'data_change''s approval'),
		('92400000-0000-4000-8000-0000000a0008', 'company_delete''s approval'),
		('92400000-0000-4000-8000-0000000a0009', 'an approval for another database'),
		('92400000-0000-4000-8000-0000000a000a', 'arguments without an allow'),
		('92400000-0000-4000-8000-0000000a000b', 'an allow that is only a step''s name'),
		('92400000-0000-4000-8000-0000000a000c', 'an allow with more after it'),
		('92400000-0000-4000-8000-0000000a000d', 'arguments that are not JSON'),
		('92400000-0000-4000-8000-0000000a000e', 'arguments that are no object'),
		('92400000-0000-4000-8000-0000000a000f', 'an allow that is no text'),
		('92400000-0000-4000-8000-0000000a0010', 'another agent''s approval'),
		('92400000-0000-4000-8000-0000000a0011', 'an Allow with no member behind it'),
		('92400000-0000-4000-8000-0000000a0099', 'a review that is not there')) as c(id, what) loop
		perform pg_temp.da_same(pg_temp.da_state(format('select pg_temp.da_pass(%L, %L)', 'shop', v_case.id)), v_refused,
			'3: ' || v_case.what);
	end loop;
	-- An approval for stock opens no pass for shop, and the other way round; for its own database it does.
	perform pg_temp.da_same(pg_temp.da_state(format('select pg_temp.da_pass(%L, %L)', 'stock',
		'92400000-0000-4000-8000-0000000a0001')), v_refused, '3: shop''s approval for stock');
	perform pg_temp.da_same(pg_temp.da_redeem(pg_temp.da_pass('stock', '92400000-0000-4000-8000-0000000a0009') ->> 'pass')
		->> 'allow', pg_temp.da_allow(), '3: stock''s approval for stock');
	-- No refused call left a pass behind.
	perform pg_temp.da_same((select count(*) from public.qorpera_data_passes)::text, '4', '3: the passes made so far');
end $$;

-- 4. What it needs, who may ask, and the plain pass's own refusals.
do $$
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.da_same(pg_temp.da_state(format('select public.qorpera_run_data_pass_approved(%L, %L::jsonb, null, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.da_actor(), '92400000-0000-4000-8000-0000000a0001')),
		'22023 An approved data pass names a database and a review', '4: no database');
	perform pg_temp.da_same(pg_temp.da_state(format('select public.qorpera_run_data_pass_approved(%L, %L::jsonb, %L, null)',
		'92400000-0000-4000-8000-000000000020', pg_temp.da_actor(), 'shop')),
		'22023 An approved data pass names a database and a review', '4: no review');
	perform pg_temp.da_same(pg_temp.da_state($s$select public.qorpera_run_data_pass_approved(
		'92400000-0000-4000-8000-000000000020', '{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}', 'shop',
		'92400000-0000-4000-8000-0000000a0001')$s$), '22023 A data pass is for a run', '4: a member''s actor');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.da_same(pg_temp.da_state(format('select public.qorpera_run_data_pass_approved(%L, %L::jsonb, %L, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.da_actor(), 'shop', '92400000-0000-4000-8000-0000000a0001')),
		'42501 Folder core authority is required', '4: a member''s token');
	perform pg_temp.base_claims('service_role');
	-- A database that is not there has no pass, with the plain pass's words, whatever the review says.
	perform pg_temp.da_review('92400000-0000-4000-8000-0000000a0012', 'approved', pg_temp.da_arguments('nothing'));
	perform pg_temp.da_same(pg_temp.da_state(format('select pg_temp.da_pass(%L, %L)', 'nothing',
		'92400000-0000-4000-8000-0000000a0012')), 'P0002 Data pass has no such database', '4: a database that is not there');
	perform pg_temp.da_same((select count(*) from public.qorpera_data_passes)::text, '4', '4: no pass was left behind');
end $$;

set constraints all immediate;
rollback;
