-- @fixture 656_folder_core_run_wakes.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- 20260930569000: a coworker message to an agent hired a moment ago, before its converge gave it the default grant on
-- the company's shared root and its first run, is refused 55000 'Coworker recipient is still starting' and keeps no
-- receipt; the runtime asks again. Once the agent has its grant, the same message goes. A recipient that has its grant
-- and still cannot read what the sender's run read is refused as before (656 part 5 has the rest of that check).

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020';
	c_c constant uuid := '56900000-0000-4000-8000-0000000000c1';
	h jsonb := pg_temp.human(); b jsonb := h -> 'binding'; p jsonb := h -> 'actor'; v jsonb; v_res uuid;
begin
	-- A's run reads a file of the shared root, which every agent with the default grant may read.
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'plan-569', jsonb_build_array(
		jsonb_build_object('op','write','path','plan-569.txt','file',pg_temp.stage('plan')))), 1, 'saved');
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('plan-569.txt', p) -> 'entry'));
	-- C, hired a moment ago: active, with no grant and no first run yet (its converge has not run).
	perform pg_temp.fx(format($f$insert into public.qorpera_profile_staff(profile_id, staff_agent_id, display_name, role, charter,
		appearance_color, appearance_shape, employment_status, lifecycle_state, created_at, updated_at, updated_by_user_id)
		values ('63400000-0000-4000-8000-000000000010', %L, 'Agent C', 'Marketing', 'Test.', 'red', 'round', 'active', 'active',
			statement_timestamp(), statement_timestamp(), '63400000-0000-4000-8000-000000000001')$f$, c_c));
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L, false)', b, c_c, 'start-569', 'Start on your first todo.'),
		'55000', 'Coworker recipient is still starting');
	if exists (select 1 from public.qorpera_run_operation_receipts where run_id = (p ->> 'runId')::uuid
		and logical_operation_key = 'coworker:start-569') then raise exception 'A message to a starting hire keeps no receipt'; end if;

	-- The converge gave C its default grant on the shared root: the same message, with the same key, goes.
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), (pg_temp.root()).id, 'staff_agent', c_c, array['read','write']);
	v := pg_temp.cw(b, c_c, 'start-569', 'Start on your first todo.', false);
	if v ->> 'schema' <> 'qorpera.coworker-send/v1' or v ->> 'recipientStaffId' <> c_c::text then
		raise exception 'The message to the started hire is sent: %', v; end if;

	-- A recipient with its grant that cannot read what the run read is refused as before.
	v_res := public.qorpera_folder_set_resource(c_env, pg_temp.member(1), 'ledger-569', 'subtree', 'company_shared', 'normal')
		->> 'resourceId';
	perform public.qorpera_folder_grant(c_env, pg_temp.member(1), v_res, 'staff_agent', '63400000-0000-4000-8000-0000000000a1',
		array['read']);
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'ledger-569', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','ledger-569'),
		jsonb_build_object('op','write','path','ledger-569/q3.txt','file',pg_temp.stage('q3')))), 2, 'saved');
	perform pg_temp.release(p, extensions.gen_random_uuid(), jsonb_build_array(pg_temp.read('ledger-569/q3.txt', p) -> 'entry'));
	perform pg_temp.raises_like(format('select pg_temp.cw(%L, %L, %L, %L, false)', b, c_c, 'ledger-569', 'See the ledger'),
		'42501', 'Coworker audience cannot receive this context');
end $$;

rollback;
