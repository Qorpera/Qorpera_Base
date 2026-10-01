-- @fixture 608_company_file_writer_fence.test.sql until "-- 4. A rebase takes the fence"
-- 20260929750000: a caller the function refuses is refused before it locks the row. Cancelling an artifact cleanup
-- plan, accepting and rebasing a company proposal, and asking for a session turn locked the row their argument names
-- FOR UPDATE before they checked the caller's role in its company, so anyone signed in (and, for the cleanup plan,
-- anyone with the publishable key) who knew the id could queue for that row. Here a second connection holds the row
-- FOR UPDATE. Someone outside the company, and a member without the role the function asks, call each function and
-- are refused at once, with the error they got before; so is a call for an id nobody has. The owner calls it too,
-- waits for the row, and then lands. On the previous function text every refused call for an id that exists waited.
-- Last, a member who passes the plain check and loses their membership while the call waits for the row is still
-- refused: the locked check after the lock stays. Races use 602's committed fixture (608's proposal on its plain
-- company, 300's session); this test's rows go with the fixture at the end.

-- Someone outside both companies, an admin each check in 5 adds and removes, and a contributor of the plain company.
-- A cleanup plan of the path company that is still waiting (fixture rows: triggers and key checks off).
insert into auth.users(id,email) values
	('75600000-0000-4000-8000-000000000001','own-row-outsider@example.test'),
	('75600000-0000-4000-8000-000000000002','own-row-admin@example.test'),
	('75600000-0000-4000-8000-000000000003','own-row-contributor@example.test');
do $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values (current_setting('qorpera_test.fence_profile')::uuid,'75600000-0000-4000-8000-000000000003',
		'own-row-contributor@example.test','Contributor','contributor');
	insert into public.qorpera_artifact_gc_plans(id,profile_id,artifact_id,graph_id,restore_proof_id,client_plan_id,
		object_count,storage_bytes,created_by_user_id)
	values ('75600000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000010','75600000-0000-4000-8000-000000000011',
		'75600000-0000-4000-8000-000000000012','75600000-0000-4000-8000-000000000013','75600000-0000-4000-8000-000000000014',
		1,42,'30000000-0000-4000-8000-000000000001');
end $$;

create function pg_temp.own_claims(p_user uuid) returns jsonb language sql as $$
	select jsonb_build_object('role', 'authenticated', 'sub', p_user)
$$;
-- The holder keeps the row FOR UPDATE while one call runs; a caller the function refuses gets `p_message` at once.
create function pg_temp.own_refused(p_hold text, p_claims jsonb, p_call text, p_message text, p_label text)
returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501'
		and v_outcome ->> 'error' = p_message, p_label || ' is refused without waiting for the row: ' || v_outcome::text);
end
$$;
-- A caller the function serves still locks the row: the call waits for the holder, then lands. Its result.
create function pg_temp.own_served(p_hold text, p_claims jsonb, p_call text, p_label text)
returns jsonb language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and v_outcome ? 'result',
		p_label || ' waits for the row, then lands: ' || v_outcome::text);
	return v_outcome -> 'result';
end
$$;
-- A caller who passes the plain check locks the row: the call waits for the holder. Its result or error.
create function pg_temp.own_waits(p_hold text, p_claims jsonb, p_call text, p_label text)
returns jsonb language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true', p_label || ' waits for the row: ' || v_outcome::text);
	return v_outcome;
end
$$;
-- The holder makes the admin a member of `p_profile` and commits; then it holds the row, the admin's call passes the
-- plain check and waits for it, and the holder removes the admin from the company and commits. The call reads the
-- role again under its lock and refuses.
create function pg_temp.own_removed(p_hold text, p_profile uuid, p_call text, p_message text, p_label text)
returns void language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', format($q$begin; set local session_replication_role = replica;
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values (%L,'75600000-0000-4000-8000-000000000002','own-row-admin@example.test','Admin','admin'); commit$q$, p_profile));
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.lock_as('lock_first', pg_temp.own_claims('75600000-0000-4000-8000-000000000002'));
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	if cardinality(pg_blocking_pids(v_pid)) = 0 then
		perform dblink_exec('lock_holder', 'rollback');
		raise exception '%: the admin''s call did not wait for the row: %', p_label, pg_temp.lock_collect('lock_first'); end if;
	perform dblink_exec('lock_holder', format($q$set local session_replication_role = replica;
		delete from public.qorpera_profile_members where profile_id = %L and user_id = '75600000-0000-4000-8000-000000000002'$q$,
		p_profile));
	perform dblink_exec('lock_holder', 'commit');
	v_outcome := pg_temp.lock_collect('lock_first');
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = p_message,
		p_label || ': an admin removed while the call waited for the row is refused: ' || v_outcome::text);
end
$$;
create function pg_temp.own_cancel(p_plan uuid default '75600000-0000-4000-8000-000000000010') returns text language sql as $$
	select format('select public.qorpera_cancel_artifact_gc_plan(%L)', p_plan)
$$;
create function pg_temp.own_rebase(p_proposal uuid default current_setting('qorpera_test.fence_proposal')::uuid) returns text
language sql as $$
	select format('select public.qorpera_rebase_company_proposal(%L, %L, %L, %L)', p_proposal,
		current_setting('qorpera_test.fence_proposed'), current_setting('qorpera_test.fence_second'),
		current_setting('qorpera_test.fence_replacement'))
$$;
create function pg_temp.own_accept(p_proposal uuid default current_setting('qorpera_test.fence_proposal')::uuid) returns text
language sql as $$
	select format('select public.qorpera_accept_company_proposal(%L, %L)', p_proposal, current_setting('qorpera_test.fence_replacement'))
$$;
-- The owner's turn in the path company's configured session, paid by the owner's connection.
create function pg_temp.own_turn(p_session uuid default '30000000-0000-4000-8000-000000000042',
	p_request uuid default '75600000-0000-4000-8000-000000000020') returns text language sql as $$
	select format('select public.qorpera_request_session_turn_v2(%L, %L, %L, %L, ''member_connection'', %L, 1, null, %L, null,
		''managed_sandbox'', ''agent_turn'', ''agent_turn'', ''automatic'', null, ''{}'')', p_session, p_request, p_request,
		'{"schema":"qorpera.session-prompt/v1","text":"Own row","images":[]}',
		(select sponsor_binding_id from public.qorpera_session_execution_bindings where session_id = '30000000-0000-4000-8000-000000000042'),
		(select id from public.qorpera_member_compute_identities where profile_id = '30000000-0000-4000-8000-000000000010'
			and owner_user_id = '30000000-0000-4000-8000-000000000001'))
$$;

-- 1. Cancelling an artifact cleanup plan: owners and admins. Someone outside the company, a caller with the
--    publishable key only, and the company's contributor are refused; the owner cancels the plan.
select pg_temp.own_refused(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_cancel(),
	'artifact cleanup requires full access', 'Cancelling another company''s cleanup plan');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	'{"role":"anon"}', pg_temp.own_cancel(),
	'artifact cleanup requires full access', 'Cancelling a cleanup plan with the publishable key');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000002'), pg_temp.own_cancel(),
	'artifact cleanup requires full access', 'The contributor cancelling the cleanup plan');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_cancel('75600000-0000-4000-8000-000000000099'),
	'artifact cleanup requires full access', 'Cancelling a cleanup plan nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000001'), pg_temp.own_cancel(), 'The owner cancelling the cleanup plan')
	->> 'status' = 'cancelled', 'The owner cancels the cleanup plan');

-- 2. Rebasing a company proposal: owners and admins. The owner's rebase lands on the current head.
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_rebase(),
	'company proposal rebase authorization is required', 'Rebasing another company''s proposal');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000003'), pg_temp.own_rebase(),
	'company proposal rebase authorization is required', 'The contributor rebasing the proposal');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_rebase('75600000-0000-4000-8000-000000000099'),
	'company proposal rebase authorization is required', 'Rebasing a proposal nobody has');
do $$
declare v_result jsonb := pg_temp.own_served(pg_temp.lock_row('qorpera_company_proposals', 'id',
	current_setting('qorpera_test.fence_proposal')::uuid), pg_temp.fence_owner(), pg_temp.own_rebase(), 'The owner rebasing the proposal');
begin
	perform pg_temp.wake_assert(v_result #>> '{proposal_snapshot,snapshot_id}' = current_setting('qorpera_test.fence_replacement')
		and v_result ->> 'base_snapshot_id' = current_setting('qorpera_test.fence_second'),
		'The owner''s rebase lands on the current head: ' || v_result::text);
end $$;

-- 3. Accepting a company proposal: owners and admins. The owner's acceptance publishes the rebased proposal.
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_accept(),
	'company proposal authorization is required', 'Accepting another company''s proposal');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000003'), pg_temp.own_accept(),
	'company proposal authorization is required', 'The contributor accepting the proposal');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_accept('75600000-0000-4000-8000-000000000099'),
	'company proposal authorization is required', 'Accepting a proposal nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.lock_row('qorpera_company_proposals', 'id',
	current_setting('qorpera_test.fence_proposal')::uuid), pg_temp.fence_owner(), pg_temp.own_accept(), 'The owner accepting the proposal')
	->> 'status' = 'accepted'
	and pg_temp.fence_head(current_setting('qorpera_test.fence_environment')::uuid)::text = current_setting('qorpera_test.fence_replacement'),
	'The owner accepts the proposal and its revision is the head');

-- 4. Asking for a turn in a shared session: owners, admins and contributors. Someone outside the company and the
--    viewer are refused; the contributor locks the row; the owner's turn is requested.
select pg_temp.own_refused(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_turn(),
	'session turn request is unavailable', 'A turn in another company''s session');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000003'), pg_temp.own_turn(),
	'session turn request is unavailable', 'The viewer''s turn');
select pg_temp.own_refused(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_turn('75600000-0000-4000-8000-000000000099'),
	'session turn request is unavailable', 'A turn in a session nobody has');
-- The contributor passes the plain check and waits for the row; their turn is refused after it, for the owner's
-- connection it names.
select pg_temp.wake_assert(pg_temp.own_waits(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000002'), pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000022'),
	'The contributor''s turn') ->> 'error' = 'session turn sponsor is unavailable', 'The contributor''s turn is refused for the sponsor');
do $$
declare v_result jsonb := pg_temp.own_served(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000001'), pg_temp.own_turn(), 'The owner''s turn');
begin
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_session_turn_requests request
		where request.id = (v_result ->> 'turn_request_id')::uuid and request.session_id = '30000000-0000-4000-8000-000000000042'
			and request.client_request_id = '75600000-0000-4000-8000-000000000020'
			and request.requested_by_user_id = '30000000-0000-4000-8000-000000000001'),
		'The owner''s turn is requested: ' || v_result::text);
end $$;

-- 5. The locked checks stay: an admin removed from the company while their call waits for the row is refused.
select pg_temp.own_removed(pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', '75600000-0000-4000-8000-000000000010'),
	'30000000-0000-4000-8000-000000000010', pg_temp.own_cancel(), 'artifact cleanup requires full access', 'Cancelling the cleanup plan');
select pg_temp.own_removed(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	current_setting('qorpera_test.fence_profile')::uuid, pg_temp.own_rebase(), 'company proposal rebase authorization is required',
	'Rebasing the proposal');
select pg_temp.own_removed(pg_temp.lock_row('qorpera_company_proposals', 'id', current_setting('qorpera_test.fence_proposal')::uuid),
	current_setting('qorpera_test.fence_profile')::uuid, pg_temp.own_accept(), 'company proposal authorization is required',
	'Accepting the proposal');
select pg_temp.own_removed(pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042'),
	'30000000-0000-4000-8000-000000000010', pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000021'),
	'session turn request is unavailable', 'A turn in the session');

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
