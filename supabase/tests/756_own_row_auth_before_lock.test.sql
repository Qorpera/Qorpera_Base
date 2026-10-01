-- @fixture 608_company_file_writer_fence.test.sql until "-- 4. A rebase takes the fence"
-- 20260929750000: a caller the function refuses is refused before it locks the row. Cancelling and retrying an
-- artifact cleanup plan, accepting, rejecting and rebasing a company proposal, configuring a shared session's
-- execution and asking for a turn in it locked the row their argument names FOR UPDATE before they checked the
-- caller's role in its company, so anyone signed in (and, for the cleanup plan and the session, anyone with the
-- publishable key) who knew the id could queue for that row. Here a second connection holds the row FOR UPDATE.
-- Someone outside the company, a caller with the publishable key only, and a member without the role the function
-- asks, call each function and are refused at once, with the error they got before; so is a call for an id nobody
-- has. The owner calls it too, waits for the row, and then lands. On the previous function text every refused call
-- for an id that exists waited. Last, an admin who passes the plain check and loses their membership while the call
-- waits for the row is still refused: the locked check after the lock stays. Races use 602's committed fixture
-- (608's proposal on its plain company, 300's session); this test's rows go with the fixture at the end.

-- Someone outside both companies, an admin each check in 5 adds and removes, and a contributor of the plain company.
-- Two cleanup plans of the path company, one waiting and one failed, and a second open proposal of the plain company
-- (fixture rows: triggers and key checks off; the proposal names no real snapshot, so its rejection returns no
-- proposal view, and the test reads the row instead).
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
		status,object_count,storage_bytes,last_error,created_by_user_id)
	values ('75600000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000010','75600000-0000-4000-8000-000000000011',
			'75600000-0000-4000-8000-000000000012','75600000-0000-4000-8000-000000000013','75600000-0000-4000-8000-000000000014',
			'waiting',1,42,null,'30000000-0000-4000-8000-000000000001'),
		('75600000-0000-4000-8000-000000000015','30000000-0000-4000-8000-000000000010','75600000-0000-4000-8000-000000000017',
			'75600000-0000-4000-8000-000000000012','75600000-0000-4000-8000-000000000013','75600000-0000-4000-8000-000000000016',
			'failed',1,42,'Storage refused the delete','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_proposals(id,profile_id,environment_id,client_proposal_id,base_snapshot_id,proposal_snapshot_id,
		execution_kind,execution_id,execution_claimant_id,trail_end_sequence,reason,title,created_by_user_id)
	values ('75600000-0000-4000-8000-000000000030',current_setting('qorpera_test.fence_profile')::uuid,
		current_setting('qorpera_test.fence_environment')::uuid,'75600000-0000-4000-8000-000000000031',
		current_setting('qorpera_test.fence_first')::uuid,'75600000-0000-4000-8000-000000000032','turn',
		'75600000-0000-4000-8000-000000000033','75600000-0000-4000-8000-000000000034',0,'conflict','Proposal to reject',
		'60700000-0000-4000-8000-000000000001');
end $$;

create function pg_temp.own_claims(p_user uuid, p_role text default 'authenticated') returns jsonb language sql as $$
	select jsonb_build_object('role', p_role, 'sub', p_user)
$$;
-- The holder keeps the row FOR UPDATE while one call runs; a caller the function refuses gets `p_message` at once.
create function pg_temp.own_refused(p_hold text, p_claims jsonb, p_call text, p_message text, p_label text,
	p_state text default '42501') returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = p_state
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
create function pg_temp.own_removed(p_hold text, p_profile uuid, p_call text, p_message text, p_label text,
	p_state text default '42501', p_role text default 'authenticated') returns void language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', format($q$begin; set local session_replication_role = replica;
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values (%L,'75600000-0000-4000-8000-000000000002','own-row-admin@example.test','Admin','admin'); commit$q$, p_profile));
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.lock_as('lock_first', pg_temp.own_claims('75600000-0000-4000-8000-000000000002', p_role));
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
	perform pg_temp.wake_assert(v_outcome ->> 'state' = p_state and v_outcome ->> 'error' = p_message,
		p_label || ': an admin removed while the call waited for the row is refused: ' || v_outcome::text);
end
$$;
create function pg_temp.own_plan(p_function text, p_plan uuid) returns text language sql as $$
	select format('select public.%I(%L)', p_function, p_plan)
$$;
create function pg_temp.own_plan_row(p_plan uuid) returns text language sql as $$
	select pg_temp.lock_row('qorpera_artifact_gc_plans', 'id', p_plan)
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
create function pg_temp.own_reject(p_proposal uuid default '75600000-0000-4000-8000-000000000030') returns text language sql as $$
	select format('select public.qorpera_reject_company_proposal(%L, ''75600000-0000-4000-8000-000000000032'')', p_proposal)
$$;
create function pg_temp.own_proposal_row(p_proposal uuid default current_setting('qorpera_test.fence_proposal')::uuid) returns text
language sql as $$
	select pg_temp.lock_row('qorpera_company_proposals', 'id', p_proposal)
$$;
create function pg_temp.own_session_row() returns text language sql as $$
	select pg_temp.lock_row('qorpera_shared_sessions', 'id', '30000000-0000-4000-8000-000000000042')
$$;
-- The owner's turn in the path company's configured session, paid by the owner's connection, through either turn
-- function; and that session's execution configured again as it is.
create function pg_temp.own_turn(p_session uuid default '30000000-0000-4000-8000-000000000042',
	p_request uuid default '75600000-0000-4000-8000-000000000020', p_function text default 'qorpera_request_session_turn_v2')
returns text language sql as $$
	select format('select public.%I(%L, %L, %L, %L, ''member_connection'', %L, 1, null, %L, null,
		''managed_sandbox'', ''agent_turn'', ''agent_turn'', ''automatic'', null, ''{}'')', p_function, p_session, p_request, p_request,
		'{"schema":"qorpera.session-prompt/v1","text":"Own row","images":[]}',
		(select sponsor_binding_id from public.qorpera_session_execution_bindings where session_id = '30000000-0000-4000-8000-000000000042'),
		(select id from public.qorpera_member_compute_identities where profile_id = '30000000-0000-4000-8000-000000000010'
			and owner_user_id = '30000000-0000-4000-8000-000000000001'))
$$;
create function pg_temp.own_configure(p_session uuid default '30000000-0000-4000-8000-000000000042') returns text language sql as $$
	select format('select public.qorpera_configure_session_execution(%L, %L, 1, null, ''agent_turn'', ''agent_turn'')', p_session,
		(select sponsor_binding_id from public.qorpera_session_execution_bindings where session_id = '30000000-0000-4000-8000-000000000042'))
$$;

-- 1. Cancelling and retrying an artifact cleanup plan: owners and admins. Someone outside the company, a caller with
--    the publishable key only, the company's contributor and a plan nobody has are refused; the owner cancels the
--    waiting plan and retries the failed one.
do $$
declare v_function text; v_plan uuid;
begin
	foreach v_function in array array['qorpera_cancel_artifact_gc_plan', 'qorpera_retry_artifact_gc_plan'] loop
		v_plan := case v_function when 'qorpera_cancel_artifact_gc_plan' then '75600000-0000-4000-8000-000000000010'::uuid
			else '75600000-0000-4000-8000-000000000015'::uuid end;
		perform pg_temp.own_refused(pg_temp.own_plan_row(v_plan), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
			pg_temp.own_plan(v_function, v_plan), 'artifact cleanup requires full access', v_function || ' by someone outside the company');
		perform pg_temp.own_refused(pg_temp.own_plan_row(v_plan), '{"role":"anon"}', pg_temp.own_plan(v_function, v_plan),
			'artifact cleanup requires full access', v_function || ' with the publishable key');
		perform pg_temp.own_refused(pg_temp.own_plan_row(v_plan), pg_temp.own_claims('30000000-0000-4000-8000-000000000002'),
			pg_temp.own_plan(v_function, v_plan), 'artifact cleanup requires full access', v_function || ' by the contributor');
		perform pg_temp.own_refused(pg_temp.own_plan_row(v_plan), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
			pg_temp.own_plan(v_function, '75600000-0000-4000-8000-000000000099'), 'artifact cleanup requires full access',
			v_function || ' for a plan nobody has');
	end loop;
end $$;
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_plan_row('75600000-0000-4000-8000-000000000010'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000001'),
	pg_temp.own_plan('qorpera_cancel_artifact_gc_plan', '75600000-0000-4000-8000-000000000010'), 'The owner cancelling the plan')
	->> 'status' = 'cancelled', 'The owner cancels the waiting plan');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_plan_row('75600000-0000-4000-8000-000000000015'),
	pg_temp.own_claims('30000000-0000-4000-8000-000000000001'),
	pg_temp.own_plan('qorpera_retry_artifact_gc_plan', '75600000-0000-4000-8000-000000000015'), 'The owner retrying the plan')
	->> 'status' = 'retrying', 'The owner retries the failed plan');

-- 2. Rebasing a company proposal: owners and admins. The owner's rebase lands on the current head.
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_rebase(), 'company proposal rebase authorization is required', 'Rebasing another company''s proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000003'),
	pg_temp.own_rebase(), 'company proposal rebase authorization is required', 'The contributor rebasing the proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_rebase('75600000-0000-4000-8000-000000000099'), 'company proposal rebase authorization is required',
	'Rebasing a proposal nobody has');
do $$
declare v_result jsonb := pg_temp.own_served(pg_temp.own_proposal_row(), pg_temp.fence_owner(), pg_temp.own_rebase(),
	'The owner rebasing the proposal');
begin
	perform pg_temp.wake_assert(v_result #>> '{proposal_snapshot,snapshot_id}' = current_setting('qorpera_test.fence_replacement')
		and v_result ->> 'base_snapshot_id' = current_setting('qorpera_test.fence_second'),
		'The owner''s rebase lands on the current head: ' || v_result::text);
end $$;

-- 3. Accepting and rejecting a company proposal: owners and admins. The owner's acceptance publishes the rebased
--    proposal; the owner rejects the second one.
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_accept(), 'company proposal authorization is required', 'Accepting another company''s proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000003'),
	pg_temp.own_accept(), 'company proposal authorization is required', 'The contributor accepting the proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_accept('75600000-0000-4000-8000-000000000099'), 'company proposal authorization is required',
	'Accepting a proposal nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_proposal_row(), pg_temp.fence_owner(), pg_temp.own_accept(),
	'The owner accepting the proposal') ->> 'status' = 'accepted'
	and pg_temp.fence_head(current_setting('qorpera_test.fence_environment')::uuid)::text = current_setting('qorpera_test.fence_replacement'),
	'The owner accepts the proposal and its revision is the head');
select pg_temp.own_refused(pg_temp.own_proposal_row('75600000-0000-4000-8000-000000000030'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_reject(),
	'company proposal authorization is required', 'Rejecting another company''s proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row('75600000-0000-4000-8000-000000000030'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000003'), pg_temp.own_reject(),
	'company proposal authorization is required', 'The contributor rejecting the proposal');
select pg_temp.own_refused(pg_temp.own_proposal_row('75600000-0000-4000-8000-000000000030'),
	pg_temp.own_claims('75600000-0000-4000-8000-000000000001'), pg_temp.own_reject('75600000-0000-4000-8000-000000000099'),
	'company proposal authorization is required', 'Rejecting a proposal nobody has');
select pg_temp.own_served(pg_temp.own_proposal_row('75600000-0000-4000-8000-000000000030'), pg_temp.fence_owner(),
	pg_temp.own_reject(), 'The owner rejecting the second proposal');
select pg_temp.wake_assert(exists (select 1 from public.qorpera_company_proposals proposal
	where proposal.id = '75600000-0000-4000-8000-000000000030' and proposal.status = 'rejected'
		and proposal.resolved_by_user_id = '60700000-0000-4000-8000-000000000001'), 'The owner rejects the second proposal');

-- 4. A shared session. Configuring its execution: owners and admins; someone outside the company, a caller with the
--    publishable key only, the contributor and a session nobody has are refused, and the owner configures it again.
--    Asking for a turn: owners, admins and contributors. Through the second turn function someone outside the
--    company, the viewer and a session nobody has are refused; the contributor locks the row; the owner's turn is
--    requested. The first turn function refuses a caller with the publishable key only (22023, as before) and a
--    service-role call for the viewer.
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_configure(), 'session execution configuration requires authorize access',
	'Configuring another company''s session');
select pg_temp.own_refused(pg_temp.own_session_row(), '{"role":"anon"}', pg_temp.own_configure(),
	'session execution configuration requires authorize access', 'Configuring a session with the publishable key');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000002'),
	pg_temp.own_configure(), 'session execution configuration requires authorize access', 'The contributor configuring the session');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_configure('75600000-0000-4000-8000-000000000099'), 'session execution configuration requires authorize access',
	'Configuring a session nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000001'),
	pg_temp.own_configure(), 'The owner configuring the session') ->> 'session_id' = '30000000-0000-4000-8000-000000000042',
	'The owner configures the session');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_turn(), 'session turn request is unavailable', 'A turn in another company''s session');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000003'),
	pg_temp.own_turn(), 'session turn request is unavailable', 'The viewer''s turn');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('75600000-0000-4000-8000-000000000001'),
	pg_temp.own_turn('75600000-0000-4000-8000-000000000099'), 'session turn request is unavailable', 'A turn in a session nobody has');
-- The contributor passes the plain check and waits for the row; their turn is refused after it, for the owner's
-- connection it names.
select pg_temp.wake_assert(pg_temp.own_waits(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000002'),
	pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000022'), 'The contributor''s turn')
	->> 'error' = 'session turn sponsor is unavailable', 'The contributor''s turn is refused for the sponsor');
do $$
declare v_result jsonb := pg_temp.own_served(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000001'),
	pg_temp.own_turn(), 'The owner''s turn');
begin
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_session_turn_requests request
		where request.id = (v_result ->> 'turn_request_id')::uuid and request.session_id = '30000000-0000-4000-8000-000000000042'
			and request.client_request_id = '75600000-0000-4000-8000-000000000020'
			and request.requested_by_user_id = '30000000-0000-4000-8000-000000000001'),
		'The owner''s turn is requested: ' || v_result::text);
end $$;
select pg_temp.own_refused(pg_temp.own_session_row(), '{"role":"anon"}',
	pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000023', p_function => 'qorpera_request_session_turn'),
	'session turn request is invalid', 'A turn through the first function with the publishable key', '22023');
select pg_temp.own_refused(pg_temp.own_session_row(), '{"role":"anon"}',
	pg_temp.own_turn('75600000-0000-4000-8000-000000000099', '75600000-0000-4000-8000-000000000023', 'qorpera_request_session_turn'),
	'session turn request is invalid', 'A turn through the first function in a session nobody has', '22023');
select pg_temp.own_refused(pg_temp.own_session_row(), pg_temp.own_claims('30000000-0000-4000-8000-000000000003', 'service_role'),
	pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000023', p_function => 'qorpera_request_session_turn'),
	'session turn request is invalid', 'A service-role turn through the first function for the viewer', '22023');

-- 5. The locked checks stay: an admin removed from the company while their call waits for the row is refused.
select pg_temp.own_removed(pg_temp.own_plan_row('75600000-0000-4000-8000-000000000010'), '30000000-0000-4000-8000-000000000010',
	pg_temp.own_plan('qorpera_cancel_artifact_gc_plan', '75600000-0000-4000-8000-000000000010'),
	'artifact cleanup requires full access', 'Cancelling the cleanup plan');
select pg_temp.own_removed(pg_temp.own_plan_row('75600000-0000-4000-8000-000000000015'), '30000000-0000-4000-8000-000000000010',
	pg_temp.own_plan('qorpera_retry_artifact_gc_plan', '75600000-0000-4000-8000-000000000015'),
	'artifact cleanup requires full access', 'Retrying the cleanup plan');
select pg_temp.own_removed(pg_temp.own_proposal_row(), current_setting('qorpera_test.fence_profile')::uuid, pg_temp.own_rebase(),
	'company proposal rebase authorization is required', 'Rebasing the proposal');
select pg_temp.own_removed(pg_temp.own_proposal_row(), current_setting('qorpera_test.fence_profile')::uuid, pg_temp.own_accept(),
	'company proposal authorization is required', 'Accepting the proposal');
select pg_temp.own_removed(pg_temp.own_proposal_row('75600000-0000-4000-8000-000000000030'),
	current_setting('qorpera_test.fence_profile')::uuid, pg_temp.own_reject(),
	'company proposal authorization is required', 'Rejecting the second proposal');
select pg_temp.own_removed(pg_temp.own_session_row(), '30000000-0000-4000-8000-000000000010', pg_temp.own_configure(),
	'session execution configuration requires authorize access', 'Configuring the session');
select pg_temp.own_removed(pg_temp.own_session_row(), '30000000-0000-4000-8000-000000000010',
	pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000021'), 'session turn request is unavailable', 'A turn in the session');
select pg_temp.own_removed(pg_temp.own_session_row(), '30000000-0000-4000-8000-000000000010',
	pg_temp.own_turn(p_request => '75600000-0000-4000-8000-000000000024', p_function => 'qorpera_request_session_turn'),
	'session turn request is invalid', 'A service-role turn through the first function', '22023', 'service_role');

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
