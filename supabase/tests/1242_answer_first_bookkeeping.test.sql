-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930748000 (the answer first, then the bookkeeping): after its final send a run may still begin the folder receipts
-- of its own bookkeeping, `update_wall`, `manage_todo`, `organize_apps` and `organize_sidebar` (each a company revision,
-- keyed `<tool>:...` as the runtime keys every receipt), and nothing else. On 924's run of Alice's, in her thread:
-- 1. Before the final: a bookkeeping receipt and any other receipt begin, as before.
-- 2. After the final: each of the four tools' revisions begins; the mark it set for the gate is gone when the begin
--    answers, so nothing later in the same transaction is let through by it.
-- 3. After the final, still refused "Wake public output is already final": any other tool's receipt; one of the four's
--    receipt that is not a company revision; a key that only looks like one (another prefix first, a longer name, a
--    kernel effect's `coworker:`); a mark that names another run; and the second send ("already final").
-- 4. The gate's other checks stand after the final for the four: a paused company refuses them.
-- 5. Settings, owners, grants and the markers.
-- Each begin is rolled back right after it answers (one unresolved operation per run). Everything is rolled back at the end.

-- A receipt's begin as the runtime makes it, for Alice's run: 'ok:<state>' or '<sqlstate>:<message>', and rolled back.
create function pg_temp.af_begin(p_key text, p_revision boolean default true) returns text language plpgsql as $$
declare v_answer text;
begin
	begin
		v_answer := 'ok:' || (public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
			extensions.gen_random_uuid(), p_key, repeat('a', 64), repeat('b', 64), p_revision) ->> 'state')
			|| case when coalesce(current_setting('qorpera.after_answer', true), '') = '' then '' else ' (mark left)' end;
		raise sqlstate 'P0F98';
	exception
		when sqlstate 'P0F98' then null;
		when others then v_answer := sqlstate || ':' || sqlerrm;
	end;
	return v_answer;
end $$;
-- The wake's work gate itself for Alice's run, with a mark naming a run (or none): 'ok' or '<sqlstate>:<message>'.
create function pg_temp.af_gate(p_mark text) returns text language plpgsql as $$
declare v_answer text := 'ok';
begin
	begin
		perform set_config('qorpera.after_answer', coalesce(p_mark, ''), true);
		perform public.qorpera_assert_wake_work_allowed((current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid);
		raise sqlstate 'P0F98';
	exception
		when sqlstate 'P0F98' then null;
		when others then v_answer := sqlstate || ':' || sqlerrm;
	end;
	return v_answer;
end $$;
create function pg_temp.af_run() returns text language sql as $$
	select current_setting('qorpera_test.base_binding')::jsonb ->> 'runId'
$$;

select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'af-ack') is not null;
reset role;
select pg_temp.base_claims('service_role');

-- 1. Before the final ----------------------------------------------------------------------------------------------------------
select pg_temp.base_assert(pg_temp.af_begin('update_wall:wall:call_1') = 'ok:executing'
	and pg_temp.af_begin('company_write:k1') = 'ok:executing' and pg_temp.af_begin('company_write:k2', false) = 'ok:executing',
	'1: before the final a bookkeeping receipt and any other begin: ' || pg_temp.af_begin('update_wall:wall:call_1') || ', '
	|| pg_temp.af_begin('company_write:k1'));

-- The final send: the member has the answer.
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'af-final') is not null;
reset role;
select pg_temp.base_claims('service_role');
select pg_temp.base_assert((select count(*) from public.qorpera_agent_sends where run_id = pg_temp.af_run()::uuid
	and phase = 'final') = 1, '1: the run has its final send');

-- 2. After the final: the four tools' revisions -------------------------------------------------------------------------------
select pg_temp.base_assert((select bool_and(pg_temp.af_begin(key) = 'ok:executing') from unnest(array[
		'update_wall:wall:call_2', 'manage_todo:todo:t1', 'organize_apps:apps-layout:call_3', 'organize_sidebar:sidebar:call_4']) key),
	'2: after the final each bookkeeping tool''s revision begins, and the mark is gone when it answers: '
	|| (select string_agg(pg_temp.af_begin(key), ', ') from unnest(array['update_wall:wall:call_2', 'manage_todo:todo:t1',
		'organize_apps:apps-layout:call_3', 'organize_sidebar:sidebar:call_4']) key));
-- One that is kept: in the same transaction, the next receipt is the gate's own question again.
do $$
declare v_begun jsonb;
begin
	v_begun := public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
		'12420000-0000-4000-8000-000000000001', 'update_wall:wall:call_5', repeat('a', 64), repeat('b', 64), true);
	perform pg_temp.base_assert(v_begun ->> 'state' = 'executing'
		and coalesce(current_setting('qorpera.after_answer', true), '') = '',
		'2: a kept bookkeeping receipt leaves no mark: ' || v_begun::text);
	perform pg_temp.base_assert(pg_temp.af_gate(null) = '55000:Wake public output is already final',
		'2: and the gate after it refuses work as before: ' || pg_temp.af_gate(null));
	perform pg_temp.base_assert((select status from public.qorpera_run_operation_receipts
		where id = '12420000-0000-4000-8000-000000000001') = 'executing', '2: the receipt is the run''s, executing');
	raise sqlstate 'P0F97';
exception when sqlstate 'P0F97' then null;
end $$;

-- 3. After the final, everything else is refused as before -------------------------------------------------------------------
select pg_temp.base_assert((select bool_and(pg_temp.af_begin(key) = '55000:Wake public output is already final')
	from unnest(array['company_write:k3', 'send_coworker_message:m1', 'manage_worker:w1', 'save_app:a1', 'machine_run:c1',
		'coworker:update_wall:x', 'worker:manage_todo:x', 'update_walls:x', 'xupdate_wall:x', 'update_wall', 'manage_todo-x:y']) key),
	'3: any other receipt, and keys that only look like the four, are refused: '
	|| (select string_agg(key || '=' || pg_temp.af_begin(key), ', ') from unnest(array['company_write:k3', 'coworker:update_wall:x',
		'update_walls:x', 'update_wall']) key));
select pg_temp.base_assert(pg_temp.af_begin('update_wall:wall:call_6', false) = '55000:Wake public output is already final'
	and pg_temp.af_begin('manage_todo:todo:t2', false) = '55000:Wake public output is already final',
	'3: one of the four''s receipt that is no company revision is refused: ' || pg_temp.af_begin('update_wall:wall:call_6', false));
select pg_temp.base_assert(pg_temp.af_gate('12420000-0000-4000-8000-0000000000ff') = '55000:Wake public output is already final'
	and pg_temp.af_gate(null) = '55000:Wake public output is already final' and pg_temp.af_gate(pg_temp.af_run()) = 'ok',
	'3: only a mark naming this run lets the gate through after the final: ' || pg_temp.af_gate('12420000-0000-4000-8000-0000000000ff'));
set local role service_role;
select pg_temp.base_error($sql$select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'af-final-2')$sql$,
	'55000', 'agent public output is already final');
select pg_temp.base_error($sql$select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'af-late')$sql$,
	'55000', 'agent public output is already final');
reset role;
select pg_temp.base_claims('service_role');

-- 4. A paused company refuses the four too -----------------------------------------------------------------------------------
do $$
begin
	insert into public.qorpera_company_execution_pauses(profile_id, paused_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(pg_temp.af_begin('update_wall:wall:call_7') like '55000:%'
		and pg_temp.af_begin('update_wall:wall:call_7') <> 'ok:executing',
		'4: a paused company refuses the bookkeeping after the final: ' || pg_temp.af_begin('update_wall:wall:call_7'));
	raise sqlstate 'P0F96';
exception when sqlstate 'P0F96' then null;
end $$;
select pg_temp.base_assert(pg_temp.af_begin('update_wall:wall:call_8') = 'ok:executing', '4: and admits it again unpaused');

-- 5. Settings, owners, grants and the markers --------------------------------------------------------------------------------
select pg_temp.base_assert((select array_to_string(proconfig, ',') like '%lock_timeout=3s%' and prosecdef from pg_proc
	where oid = 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)'::regprocedure)
	and (select prosecdef from pg_proc where oid = 'public.qorpera_assert_wake_work_allowed(uuid)'::regprocedure),
	'5: both stay definers, the begin with its 3 s lock bound (20260930541000)');
-- Their grants are the ones they had (the migration's catalog check holds every catalog field but the body): no member
-- and no caller from outside calls either.
select pg_temp.base_assert((select bool_and(not has_function_privilege(who, fn, 'execute'))
	from unnest(array['anon', 'authenticated']) who,
		unnest(array['public.qorpera_assert_wake_work_allowed(uuid)', 'public.qorpera_folder_begin_run_receipt(jsonb,uuid,text,text,text,boolean)']) fn),
	'5: no member and no anonymous caller calls the gate or the folder begin');

rollback;
