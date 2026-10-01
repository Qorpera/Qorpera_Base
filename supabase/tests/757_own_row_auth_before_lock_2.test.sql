-- @fixture 608_company_file_writer_fence.test.sql until "-- 4. A rebase takes the fence"
-- 20260929820000: the rest of 756's change. Twenty-two functions locked the row their arguments name before they
-- checked the caller, so a caller they refuse could queue for that row: a runner job's model policy, a proposal review
-- retry, a retention hold's release, an operation receipt's resolution, completion and staged objects, a run
-- operation receipt's resolution (both Company File cores), a reachability graph's entries and completion (by a
-- member and by a runner), an event hook's status, an execution sponsor's, a logical computer's and a provider
-- connection's status, a company secret's grants (to agents and to one operation), rotation and revocation, a
-- member's Company File edit review, and a turn in a member's private conversation. Here a second connection holds the row FOR UPDATE. Someone outside the company, a caller with the
-- publishable key only, and a member the function does not serve call each function and are refused at once, with
-- the error they got before; so is a call for an id nobody has (no row to wait for: the error is the point). A caller
-- the function serves still waits for the row and then lands, or meets the function's next check. On the previous
-- function text every refused call for a row that exists waited. Last, a member who passes the plain check and loses
-- their membership while the call waits for the row is still refused: the locked checks stay. Races use 602's
-- committed fixture (300's path company and its runner job, run receipts, graph, binding and connection); this
-- test's rows go with the fixture at the end.

-- Someone outside the company and an admin each check in 12 adds and removes. Fixture rows of the path company
-- (triggers and key checks off): a proposal and a queued review of it, a retention hold, two operation receipts (one
-- claimed by the contributor, one by the admin), graphs the admin and the contributor are uploading, an event hook, a logical computer, a
-- provider connection the contributor owns and one the company owns, a secret broker, a company secret and the
-- owner's own secret, a member's Company File edit, and
-- the owner's private conversation. The fixture job's lease is extended past the test.
insert into auth.users(id,email) values
	('75700000-0000-4000-8000-000000000001','own-row-2-outsider@example.test'),
	('75700000-0000-4000-8000-000000000002','own-row-2-admin@example.test');
do $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_company_proposals(id,profile_id,environment_id,client_proposal_id,proposal_snapshot_id,
		execution_kind,execution_id,execution_claimant_id,trail_end_sequence,reason,title,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'75700000-0000-4000-8000-000000000011','75700000-0000-4000-8000-000000000012','turn','75700000-0000-4000-8000-000000000013',
		'75700000-0000-4000-8000-000000000013',0,'policy','Proposal under review','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_company_proposal_review_assignments(id,profile_id,proposal_id,proposal_revision,
		reviewer_staff_agent_id,reviewer_sponsor_binding_id,reviewer_sponsor_version)
	values ('75700000-0000-4000-8000-000000000014','30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000010',1,
		'75700000-0000-4000-8000-000000000015','75700000-0000-4000-8000-000000000016',1);
	insert into public.qorpera_artifact_retention_holds(id,profile_id,artifact_id,client_hold_id,reason,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000017','30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000018',
		'75700000-0000-4000-8000-000000000019','Kept for the audit','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_operation_receipts(id,profile_id,execution_kind,execution_id,claimant_id,claimed_by_user_id,
		operation_kind,input_sha256)
	values ('75700000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000010','turn','75700000-0000-4000-8000-000000000021',
			'75700000-0000-4000-8000-000000000022','30000000-0000-4000-8000-000000000002','send_mail',repeat('a',64)),
		('75700000-0000-4000-8000-000000000023','30000000-0000-4000-8000-000000000010','turn','75700000-0000-4000-8000-000000000021',
			'75700000-0000-4000-8000-000000000022','75700000-0000-4000-8000-000000000002','send_mail',repeat('b',64));
	insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
		root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000024','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'artifact','75700000-0000-4000-8000-000000000025','75700000-0000-4000-8000-000000000026',repeat('a',64),1,repeat('c',64),1,128,
		'75700000-0000-4000-8000-000000000002'),
		('75700000-0000-4000-8000-000000000039','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'artifact','75700000-0000-4000-8000-000000000043','75700000-0000-4000-8000-000000000044',repeat('a',64),1,repeat('c',64),1,128,
		'30000000-0000-4000-8000-000000000002');
	insert into public.qorpera_event_hooks(id,profile_id,environment_id,name,purpose,proof,address,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000027','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'own-row','Orders from the shop','address',repeat('h',43),'30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_logical_computers(id,profile_id,client_computer_id,display_name,template_key,template_version,
		capabilities,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000028','30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000029',
		'Own row computer','own-row','1','["agent_turn"]','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_provider_connections(id,profile_id,client_connection_id,owner_user_id,provider,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000031',
		'30000000-0000-4000-8000-000000000002','openai','30000000-0000-4000-8000-000000000002'),
		('75700000-0000-4000-8000-000000000045','30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000046',
		null,'openai','30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
	values ('75700000-0000-4000-8000-000000000032','30000000-0000-4000-8000-000000000010','https://broker.example.test','own-row',
		repeat('c',64));
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,
		purpose,current_version,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000033','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'75700000-0000-4000-8000-000000000032','company','github','own-row','The company repository',1,
		'30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,connector_id,
		secret_name,purpose,current_version,created_by_user_id)
	values ('75700000-0000-4000-8000-000000000048','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'75700000-0000-4000-8000-000000000032','member','30000000-0000-4000-8000-000000000001','github','own-row-owner',
		'The owner''s repository',1,'30000000-0000-4000-8000-000000000001');
	insert into public.qorpera_member_company_path_commands(id,environment_id,user_id,operation_key,plan,plan_sha256,
		resource_id,resource_version,protected,status)
	values ('75700000-0000-4000-8000-000000000034','30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000001',
		'own-row','{}',repeat('d',64),'75700000-0000-4000-8000-000000000035','75700000-0000-4000-8000-000000000036',false,'ready');
	insert into public.qorpera_shared_sessions(id,profile_id,environment_id,title,status,created_by_user_id,audience_kind,
		audience_user_id)
	values ('75700000-0000-4000-8000-000000000037','30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
		'Owner''s notes','open','30000000-0000-4000-8000-000000000001','member_private','30000000-0000-4000-8000-000000000001');
	update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() + interval '1 hour'
	where profile_id = '30000000-0000-4000-8000-000000000010' and status = 'leased';
end $$;
-- The fixture's runner job, its runner and assignment; a run receipt of the path company; its graph, binding and
-- connection.
select set_config('qorpera_test.own_job', job.id::text, false), set_config('qorpera_test.own_runner', job.runner_id::text, false),
	set_config('qorpera_test.own_assignment', assignment.id::text, false)
from public.qorpera_runner_jobs job join public.qorpera_runner_assignments assignment
	on assignment.job_id = job.id and assignment.status = 'accepted'
where job.profile_id = '30000000-0000-4000-8000-000000000010' and job.status = 'leased';
select set_config('qorpera_test.own_run_receipt', min(receipt.id::text), false)
from public.qorpera_run_operation_receipts receipt join public.qorpera_execution_runs run on run.id = receipt.run_id
where run.profile_id = '30000000-0000-4000-8000-000000000010';
select set_config('qorpera_test.own_binding', binding.id::text, false) from public.qorpera_execution_sponsor_bindings binding
where binding.profile_id = '30000000-0000-4000-8000-000000000010';
select set_config('qorpera_test.own_connection', connection.id::text, false) from public.qorpera_provider_connections connection
where connection.profile_id = '30000000-0000-4000-8000-000000000010' and connection.owner_user_id = '30000000-0000-4000-8000-000000000001';
select pg_temp.wake_assert(current_setting('qorpera_test.own_job', true) is not null
	and current_setting('qorpera_test.own_run_receipt', true) is not null and current_setting('qorpera_test.own_binding', true) is not null
	and current_setting('qorpera_test.own_connection', true) is not null, 'The fixture has a leased job, a run receipt, a binding and a connection');

create function pg_temp.own_claims(p_user uuid, p_role text default 'authenticated') returns jsonb language sql as $$
	select jsonb_build_object('role', p_role, 'sub', p_user)
$$;
create function pg_temp.own_outsider() returns jsonb language sql as $$
	select pg_temp.own_claims('75700000-0000-4000-8000-000000000001')
$$;
create function pg_temp.own_owner() returns jsonb language sql as $$
	select pg_temp.own_claims('30000000-0000-4000-8000-000000000001')
$$;
create function pg_temp.own_contributor() returns jsonb language sql as $$
	select pg_temp.own_claims('30000000-0000-4000-8000-000000000002')
$$;
create function pg_temp.own_viewer() returns jsonb language sql as $$
	select pg_temp.own_claims('30000000-0000-4000-8000-000000000003')
$$;
-- An error's message; a 409 for the gateway (sqlstate PGRST) carries it inside its JSON.
create function pg_temp.own_message(p_outcome jsonb) returns text language sql as $$
	select case when p_outcome ->> 'state' = 'PGRST' then (p_outcome ->> 'error')::jsonb ->> 'message' else p_outcome ->> 'error' end
$$;
-- The holder keeps the row FOR UPDATE while one call runs; a caller the function refuses gets `p_message` at once.
create function pg_temp.own_refused(p_hold text, p_claims jsonb, p_call text, p_message text, p_label text,
	p_state text default '42501') returns void language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = p_state
		and pg_temp.own_message(v_outcome) = p_message, p_label || ' is refused without waiting for the row: ' || v_outcome::text);
end
$$;
-- A caller the function serves locks the row: the call waits for the holder, then lands (its result) or meets the
-- function's next check (`p_message`, its error).
create function pg_temp.own_served(p_hold text, p_claims jsonb, p_call text, p_label text, p_message text default null)
returns jsonb language plpgsql as $$
declare v_outcome jsonb := pg_temp.lock_single(p_hold, p_call, p_claims);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true' and case when p_message is null then v_outcome ? 'result'
		else pg_temp.own_message(v_outcome) = p_message end, p_label || ' waits for the row, then '
		|| coalesce('is refused with "' || p_message || '"', 'lands') || ': ' || v_outcome::text);
	return v_outcome -> 'result';
end
$$;
-- The holder makes the admin a member of the path company and commits; then it holds the row, the admin's call passes
-- the plain check and waits for it, and the holder removes the admin from the company and commits. The call reads the
-- caller again under its lock and refuses.
create function pg_temp.own_removed(p_hold text, p_call text, p_message text, p_label text) returns void language plpgsql as $$
declare v_pid integer := current_setting('qorpera_test.lock_first_pid')::integer; v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', $q$begin; set local session_replication_role = replica;
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values ('30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000002','own-row-2-admin@example.test','Admin','admin');
		commit$q$);
	perform dblink_exec('lock_holder', 'begin');
	perform * from dblink('lock_holder', p_hold) as held(held integer);
	perform pg_temp.lock_as('lock_first', pg_temp.own_claims('75700000-0000-4000-8000-000000000002'));
	perform dblink_send_query('lock_first', p_call);
	for attempt in 1..200 loop
		exit when cardinality(pg_blocking_pids(v_pid)) > 0 or dblink_is_busy('lock_first') = 0;
		perform pg_sleep(0.025);
	end loop;
	if cardinality(pg_blocking_pids(v_pid)) = 0 then
		perform dblink_exec('lock_holder', 'rollback');
		raise exception '%: the admin''s call did not wait for the row: %', p_label, pg_temp.lock_collect('lock_first'); end if;
	perform dblink_exec('lock_holder', $q$set local session_replication_role = replica;
		delete from public.qorpera_profile_members
		where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '75700000-0000-4000-8000-000000000002'$q$);
	perform dblink_exec('lock_holder', 'commit');
	v_outcome := pg_temp.lock_collect('lock_first');
	perform pg_temp.wake_assert(v_outcome ->> 'state' = '42501' and v_outcome ->> 'error' = p_message,
		p_label || ': an admin removed while the call waited for the row is refused: ' || v_outcome::text);
end
$$;
-- The admin, a member while the call runs: the call's result or error, and whether it waited for the row.
create function pg_temp.own_as_admin(p_hold text, p_call text) returns jsonb language plpgsql as $$
declare v_outcome jsonb;
begin
	perform dblink_exec('lock_holder', $q$begin; set local session_replication_role = replica;
		insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
		values ('30000000-0000-4000-8000-000000000010','75700000-0000-4000-8000-000000000002','own-row-2-admin@example.test','Admin','admin');
		commit$q$);
	v_outcome := pg_temp.lock_single(p_hold, p_call, pg_temp.own_claims('75700000-0000-4000-8000-000000000002'));
	perform dblink_exec('lock_holder', $q$begin; set local session_replication_role = replica;
		delete from public.qorpera_profile_members
		where profile_id = '30000000-0000-4000-8000-000000000010' and user_id = '75700000-0000-4000-8000-000000000002'; commit$q$);
	return v_outcome;
end
$$;
create function pg_temp.own_admin_waits(p_hold text, p_call text, p_label text) returns jsonb language plpgsql as $$
declare v_outcome jsonb := pg_temp.own_as_admin(p_hold, p_call);
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'true', p_label || ' waits for the row: ' || v_outcome::text);
	return v_outcome;
end
$$;
create function pg_temp.own_row(p_table text, p_id text) returns text language sql as $$
	select pg_temp.lock_row(p_table, 'id', p_id::uuid)
$$;
-- Each function's call, by its row's id.
create function pg_temp.own_policy(p_job text default current_setting('qorpera_test.own_job')) returns text language sql as $$
	select format('select public.qorpera_configure_runner_model_policy(%L, ''[{"provider":"openai","model":"gpt-native"}]'', 8, 1000, 1000)',
		p_job)
$$;
create function pg_temp.own_retry(p_review text default '75700000-0000-4000-8000-000000000014') returns text language sql as $$
	select format('select public.qorpera_retry_company_proposal_review(%L)', p_review)
$$;
create function pg_temp.own_release(p_hold text default '75700000-0000-4000-8000-000000000017') returns text language sql as $$
	select format('select public.qorpera_release_artifact_retention_hold(%L)', p_hold)
$$;
create function pg_temp.own_resolve(p_receipt text default '75700000-0000-4000-8000-000000000020') returns text language sql as $$
	select format('select public.qorpera_resolve_operation_receipt(%L, ''confirmed_not_run'', null)', p_receipt)
$$;
create function pg_temp.own_stage(p_receipt text default '75700000-0000-4000-8000-000000000020',
	p_execution text default '75700000-0000-4000-8000-000000000021', p_claimant text default '75700000-0000-4000-8000-000000000022')
returns text language sql as $$
	select format('select public.qorpera_stage_operation_receipt_objects(%L, %L, %L, %L)', p_execution, p_claimant, p_receipt,
		jsonb_build_array(jsonb_build_object('sha256', repeat('9',64), 'bytes', 128)))
$$;
create function pg_temp.own_complete(p_receipt text default '75700000-0000-4000-8000-000000000020',
	p_execution text default '75700000-0000-4000-8000-000000000021') returns text language sql as $$
	select format('select public.qorpera_complete_operation_receipt(%L, ''75700000-0000-4000-8000-000000000022'', %L, ''{"sent":true}'')',
		p_execution, p_receipt)
$$;
create function pg_temp.own_run_resolve(p_function text, p_receipt text default current_setting('qorpera_test.own_run_receipt'))
returns text language sql as $$
	select format('select public.%I(%L, ''confirmed_not_run'', null, null, null)', p_function, p_receipt)
$$;
create function pg_temp.own_append(p_graph text default '30000000-0000-4000-8000-000000000027') returns text language sql as $$
	select format('select public.qorpera_append_object_reachability_entries(%L, %L)', p_graph,
		jsonb_build_array(jsonb_build_object('sha256', repeat('a',64), 'bytes', 128)))
$$;
create function pg_temp.own_finish(p_graph text default '30000000-0000-4000-8000-000000000027') returns text language sql as $$
	select format('select public.qorpera_complete_object_reachability_graph(%L)', p_graph)
$$;
-- A runner's graph page or completion, with the fixture runner's session and lease unless another session is named.
create function pg_temp.own_runner_graph(p_function text, p_graph text default '30000000-0000-4000-8000-000000000027',
	p_session text default repeat('2',64)) returns text language sql as $$
	select format('select public.%I(%L, %L, %L, %L, %L, %L%s)', p_function, current_setting('qorpera_test.own_runner'), p_session,
		current_setting('qorpera_test.own_job'), repeat('3',64), current_setting('qorpera_test.own_assignment'), p_graph,
		case when p_function = 'qorpera_runner_append_company_revision_graph'
			then format(', %L', jsonb_build_array(jsonb_build_object('sha256', repeat('a',64), 'bytes', 128))) else '' end)
$$;
create function pg_temp.own_hook(p_hook text default '75700000-0000-4000-8000-000000000027', p_status text default 'paused')
returns text language sql as $$
	select format('select public.qorpera_set_event_hook_status(%L, %L)', p_hook, p_status)
$$;
create function pg_temp.own_status(p_function text, p_id text, p_status text default 'active') returns text language sql as $$
	select format('select public.%I(''30000000-0000-4000-8000-000000000010'', %L, %L)', p_function, p_id, p_status)
$$;
create function pg_temp.own_grant(p_secret text default '75700000-0000-4000-8000-000000000033') returns text language sql as $$
	select format('select public.qorpera_grant_cloud_connector(''30000000-0000-4000-8000-000000000010'', ''30000000-0000-4000-8000-000000000020'', %L)',
		p_secret)
$$;
create function pg_temp.own_rotate(p_owner_kind text, p_owner_user text) returns text language sql as $$
	select format('select public.qorpera_begin_cloud_secret_capture(''30000000-0000-4000-8000-000000000010'', ''30000000-0000-4000-8000-000000000020'', %L, %L, ''github'', ''own-row'', ''The company repository'', ''75700000-0000-4000-8000-000000000033'')',
		p_owner_kind, p_owner_user)
$$;
create function pg_temp.own_grant_operation(p_secret text default '75700000-0000-4000-8000-000000000033',
	p_expires timestamptz default null) returns text language sql as $$
	select format('select public.qorpera_grant_cloud_secret_operation(''30000000-0000-4000-8000-000000000010'', ''30000000-0000-4000-8000-000000000020'', %L, ''75700000-0000-4000-8000-000000000047'', ''github'', ''read_repository'', 1, %L)',
		p_secret, p_expires)
$$;
create function pg_temp.own_revoke_secret(p_secret text default '75700000-0000-4000-8000-000000000033') returns text
language sql as $$
	select format('select public.qorpera_revoke_cloud_secret(''30000000-0000-4000-8000-000000000010'', %L)', p_secret)
$$;
create function pg_temp.own_review(p_command text default '75700000-0000-4000-8000-000000000034') returns text language sql as $$
	select format('select public.qorpera_review_member_company_path_command(%L, %L, ''reject'')', p_command, repeat('d',64))
$$;
-- A turn through qorpera_request_session_turn_v2 paid by the owner's connection, as in 756.
create function pg_temp.own_turn(p_session text, p_request text) returns text language sql as $$
	select format('select public.qorpera_request_session_turn_v2(%L, %L, %L, %L, ''member_connection'', %L, 1, null, %L, null,
		''managed_sandbox'', ''agent_turn'', ''agent_turn'', ''automatic'', null, ''{}'')', p_session, p_request, p_request,
		'{"schema":"qorpera.session-prompt/v1","text":"Own row","images":[]}',
		(select sponsor_binding_id from public.qorpera_session_execution_bindings where session_id = '30000000-0000-4000-8000-000000000042'),
		(select id from public.qorpera_member_compute_identities where profile_id = '30000000-0000-4000-8000-000000000010'
			and owner_user_id = '30000000-0000-4000-8000-000000000001'))
$$;

-- 1. A runner job's model policy: owners and admins. Someone outside the company, a caller with the publishable key
--    only, the contributor and a job nobody has are refused; the owner waits for the job and meets the policy check
--    (the fixture job is already leased).
select pg_temp.own_refused(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), pg_temp.own_outsider(),
	pg_temp.own_policy(), 'runner model policy requires authorization access', 'A model policy for another company''s job');
select pg_temp.own_refused(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), '{"role":"anon"}',
	pg_temp.own_policy(), 'runner model policy requires authorization access', 'A model policy with the publishable key');
select pg_temp.own_refused(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), pg_temp.own_contributor(),
	pg_temp.own_policy(), 'runner model policy requires authorization access', 'The contributor''s model policy');
select pg_temp.own_refused(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), pg_temp.own_outsider(),
	pg_temp.own_policy('75700000-0000-4000-8000-000000000099'), 'runner model policy requires authorization access',
	'A model policy for a job nobody has');
select pg_temp.own_served(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), pg_temp.own_owner(),
	pg_temp.own_policy(), 'The owner''s model policy', 'runner model policy is invalid');

-- 2. Retrying a proposal review: owners and admins. The owner waits for the review and meets the retry check (it is
--    queued, not failed).
select pg_temp.own_refused(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	pg_temp.own_outsider(), pg_temp.own_retry(), 'proposal review recovery requires authorize access',
	'Retrying another company''s review');
select pg_temp.own_refused(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	'{"role":"anon"}', pg_temp.own_retry(), 'proposal review recovery requires authorize access', 'Retrying a review with the publishable key');
select pg_temp.own_refused(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	pg_temp.own_contributor(), pg_temp.own_retry(), 'proposal review recovery requires authorize access', 'The contributor retrying a review');
select pg_temp.own_refused(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	pg_temp.own_outsider(), pg_temp.own_retry('75700000-0000-4000-8000-000000000099'),
	'proposal review recovery requires authorize access', 'Retrying a review nobody has');
select pg_temp.own_served(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	pg_temp.own_owner(), pg_temp.own_retry(), 'The owner retrying the review', 'proposal review retry is unavailable');

-- 3. Releasing a retention hold: owners and admins. The owner releases it.
select pg_temp.own_refused(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	pg_temp.own_outsider(), pg_temp.own_release(), 'artifact retention requires full access', 'Releasing another company''s hold');
select pg_temp.own_refused(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	'{"role":"anon"}', pg_temp.own_release(), 'artifact retention requires full access', 'Releasing a hold with the publishable key');
select pg_temp.own_refused(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	pg_temp.own_contributor(), pg_temp.own_release(), 'artifact retention requires full access', 'The contributor releasing a hold');
select pg_temp.own_refused(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	pg_temp.own_outsider(), pg_temp.own_release('75700000-0000-4000-8000-000000000099'), 'artifact retention requires full access',
	'Releasing a hold nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	pg_temp.own_owner(), pg_temp.own_release(), 'The owner releasing the hold') ->> 'released_at' is not null, 'The owner releases the hold');

-- 4. An operation receipt. Resolving it: owners and admins; the owner waits and meets the recovery check (its turn
--    is still running). Staging its objects and completing it: the member who claimed it (the contributor), with its
--    claimant. The owner (not the claimer), the viewer, someone outside the company, a wrong claimant, a receipt of
--    another execution and a receipt nobody has are refused; the contributor waits and stages (the object is not the
--    company's), then completes it.
select pg_temp.own_refused(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_outsider(), pg_temp.own_resolve(), 'operation recovery authorization is required', 'Resolving another company''s receipt');
select pg_temp.own_refused(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_contributor(), pg_temp.own_resolve(), 'operation recovery authorization is required', 'The contributor resolving a receipt');
select pg_temp.own_refused(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_outsider(), pg_temp.own_resolve('75700000-0000-4000-8000-000000000099'), 'operation recovery authorization is required',
	'Resolving a receipt nobody has');
select pg_temp.own_served(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_owner(), pg_temp.own_resolve(), 'The owner resolving the receipt', 'operation execution is still active');
do $$
declare v_case record;
begin
	for v_case in select * from (values
		(pg_temp.own_outsider(), pg_temp.own_stage(), 'Staging objects for another company''s receipt'),
		(pg_temp.own_viewer(), pg_temp.own_stage(), 'The viewer staging objects'),
		(pg_temp.own_owner(), pg_temp.own_stage(), 'The owner staging objects for the contributor''s receipt'),
		(pg_temp.own_contributor(), pg_temp.own_stage(p_claimant => '75700000-0000-4000-8000-000000000099'),
			'The contributor staging objects as another claimant'),
		(pg_temp.own_contributor(), pg_temp.own_stage(p_execution => '75700000-0000-4000-8000-000000000099'),
			'The contributor staging objects for another execution'),
		(pg_temp.own_contributor(), pg_temp.own_stage('75700000-0000-4000-8000-000000000099'), 'Staging objects for a receipt nobody has')
	) as staged(claims, call, label) loop
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
			v_case.claims, v_case.call, 'live operation receipt ownership is required', v_case.label);
	end loop;
	for v_case in select * from (values
		(pg_temp.own_outsider(), pg_temp.own_complete(), 'Completing another company''s receipt'),
		(pg_temp.own_viewer(), pg_temp.own_complete(), 'The viewer completing a receipt'),
		(pg_temp.own_owner(), pg_temp.own_complete(), 'The owner completing the contributor''s receipt'),
		(pg_temp.own_contributor(), pg_temp.own_complete(p_execution => '75700000-0000-4000-8000-000000000099'),
			'The contributor completing a receipt of another execution'),
		(pg_temp.own_contributor(), pg_temp.own_complete('75700000-0000-4000-8000-000000000099'), 'Completing a receipt nobody has')
	) as completed(claims, call, label) loop
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
			v_case.claims, v_case.call, 'operation receipt access is required', v_case.label);
	end loop;
end $$;
select pg_temp.own_served(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_contributor(), pg_temp.own_stage(), 'The contributor staging objects',
	'operation receipt object is unavailable or has different bytes');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000020'),
	pg_temp.own_contributor(), pg_temp.own_complete(), 'The contributor completing the receipt') = '{"sent":true}'::jsonb,
	'The contributor completes the receipt');
select pg_temp.wake_assert(status = 'completed', 'The receipt is completed') from public.qorpera_operation_receipts
where id = '75700000-0000-4000-8000-000000000020';

-- 5. Resolving a run operation receipt: owners and admins, after the folder-v2 dispatch and in the folder-v2
--    resolution it dispatches to (granted here to callers for the race, and revoked again). The owner waits for the
--    receipt and meets the recovery check (it is completed).
select set_config('qorpera_test.own_folder_acl', proacl::text, false) from pg_proc
where oid = 'public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid)'::regprocedure;
grant execute on function public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid) to anon, authenticated;
do $$
declare v_function text;
begin
	foreach v_function in array array['qorpera_resolve_run_operation_receipt', 'qorpera_folder_resolve_run_receipt'] loop
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
			pg_temp.own_outsider(), pg_temp.own_run_resolve(v_function), 'operation recovery requires authorize access',
			v_function || ' for another company''s receipt');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
			'{"role":"anon"}', pg_temp.own_run_resolve(v_function), 'operation recovery requires authorize access',
			v_function || ' with the publishable key');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
			pg_temp.own_contributor(), pg_temp.own_run_resolve(v_function), 'operation recovery requires authorize access',
			v_function || ' by the contributor');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
			pg_temp.own_outsider(), pg_temp.own_run_resolve(v_function, '75700000-0000-4000-8000-000000000099'),
			'operation recovery requires authorize access', v_function || ' for a receipt nobody has');
		perform pg_temp.own_served(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
			pg_temp.own_owner(), pg_temp.own_run_resolve(v_function), v_function || ' by the owner', 'operation recovery is unavailable');
	end loop;
end $$;

-- 6. A reachability graph. Its entries and its completion by a member: the member who began it, while they may
--    write. Someone outside the company, a caller with the publishable key only, the contributor and the viewer (who
--    did not begin it) and a graph nobody has are refused; the owner waits and meets the upload check, then completes
--    it again; the contributor waits for the graph they began, appends its entry and meets the declaration check
--    completing it. By a runner: the runner holding the job's lease. A caller with the publishable key only, someone signed
--    in and the service role with another runner session are refused; a graph nobody has gets its 409 as before; the
--    fixture's runner waits for the graph and meets the revision check (the graph is not its run's revision).
do $$
declare v_call text; v_label text;
begin
	foreach v_call in array array[pg_temp.own_append(), pg_temp.own_finish()] loop
		v_label := case when v_call like '%append%' then 'Appending graph entries' else 'Completing the graph' end;
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			pg_temp.own_outsider(), v_call, 'object reachability requires graph-creator access', v_label || ' from outside the company');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			'{"role":"anon"}', v_call, 'object reachability requires graph-creator access', v_label || ' with the publishable key');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			pg_temp.own_contributor(), v_call, 'object reachability requires graph-creator access', v_label || ' by the contributor');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			pg_temp.own_viewer(), v_call, 'object reachability requires graph-creator access', v_label || ' by the viewer');
	end loop;
	perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
		pg_temp.own_outsider(), pg_temp.own_append('75700000-0000-4000-8000-000000000099'),
		'object reachability requires graph-creator access', 'Appending to a graph nobody has');
	perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
		pg_temp.own_outsider(), pg_temp.own_finish('75700000-0000-4000-8000-000000000099'),
		'object reachability requires graph-creator access', 'Completing a graph nobody has');
end $$;
select pg_temp.own_served(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
	pg_temp.own_owner(), pg_temp.own_append(), 'The owner appending to the completed graph', 'object reachability entry batch is invalid');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
	pg_temp.own_owner(), pg_temp.own_finish(), 'The owner completing the graph') ->> 'status' = 'complete', 'The owner completes the graph again');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_object_reachability_graphs', '75700000-0000-4000-8000-000000000039'),
	pg_temp.own_contributor(), pg_temp.own_append('75700000-0000-4000-8000-000000000039'), 'The contributor appending to their graph') = '1',
	'The contributor appends to their graph');
select pg_temp.own_served(pg_temp.own_row('qorpera_object_reachability_graphs', '75700000-0000-4000-8000-000000000039'),
	pg_temp.own_contributor(), pg_temp.own_finish('75700000-0000-4000-8000-000000000039'), 'The contributor completing their graph',
	'object reachability graph does not match its declaration');
do $$
declare v_function text;
begin
	foreach v_function in array array['qorpera_runner_append_company_revision_graph', 'qorpera_runner_complete_company_revision_graph'] loop
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			'{"role":"anon"}', pg_temp.own_runner_graph(v_function), 'runner broker authorization is invalid',
			v_function || ' with the publishable key');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			pg_temp.own_owner(), pg_temp.own_runner_graph(v_function), 'runner broker authorization is invalid',
			v_function || ' signed in as the owner');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			'{"role":"service_role"}', pg_temp.own_runner_graph(v_function, p_session => repeat('9',64)),
			'runner broker authorization is invalid', v_function || ' with another runner session');
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			'{"role":"anon"}', pg_temp.own_runner_graph(v_function, '75700000-0000-4000-8000-000000000099'),
			'runner Company File graph is unavailable', v_function || ' for a graph nobody has', 'PGRST');
		perform pg_temp.own_served(pg_temp.own_row('qorpera_object_reachability_graphs', '30000000-0000-4000-8000-000000000027'),
			'{"role":"service_role"}', pg_temp.own_runner_graph(v_function), v_function || ' by the job''s runner',
			'runner Company File revision is unavailable');
	end loop;
end $$;

-- 7. An event hook's status: owners and admins. The owner pauses it.
select pg_temp.own_refused(pg_temp.own_row('qorpera_event_hooks', '75700000-0000-4000-8000-000000000027'),
	pg_temp.own_outsider(), pg_temp.own_hook(), 'Only owners and admins can change hooks', 'Pausing another company''s hook');
select pg_temp.own_refused(pg_temp.own_row('qorpera_event_hooks', '75700000-0000-4000-8000-000000000027'),
	pg_temp.own_contributor(), pg_temp.own_hook(), 'Only owners and admins can change hooks', 'The contributor pausing the hook');
select pg_temp.own_refused(pg_temp.own_row('qorpera_event_hooks', '75700000-0000-4000-8000-000000000027'),
	pg_temp.own_outsider(), pg_temp.own_hook('75700000-0000-4000-8000-000000000099'), 'Only owners and admins can change hooks',
	'Pausing a hook nobody has');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_event_hooks', '75700000-0000-4000-8000-000000000027'),
	pg_temp.own_owner(), pg_temp.own_hook(), 'The owner pausing the hook') ->> 'status' = 'paused', 'The owner pauses the hook');

-- 8. An execution sponsor's, a logical computer's and a provider connection's status: the named company's owners and
--    admins, and a connection's owner revoking it. Someone outside the company, a caller with the publishable key only,
--    the contributor and an id nobody has are refused; the owner keeps each active. The contributor cannot disable the
--    owner's connection, nor revoke it, nor a connection nobody has, but revokes their own. The company's connection
--    has no owner: someone outside the company, the viewer and the contributor are refused revoking it (the locked
--    check let them through until 20260929790000); an admin waits for it and revokes it.
do $$
declare v_case record;
begin
	for v_case in select * from (values
		('qorpera_set_execution_sponsor_status', 'qorpera_execution_sponsor_bindings', current_setting('qorpera_test.own_binding'),
			'execution sponsor lifecycle requires authorize access'),
		('qorpera_set_logical_computer_status', 'qorpera_logical_computers', '75700000-0000-4000-8000-000000000028',
			'logical computer lifecycle requires authorize access'),
		('qorpera_set_provider_connection_status', 'qorpera_provider_connections', current_setting('qorpera_test.own_connection'),
			'provider connection lifecycle requires authorize access')
	) as status_case(function_name, table_name, row_id, message) loop
		perform pg_temp.own_refused(pg_temp.own_row(v_case.table_name, v_case.row_id), pg_temp.own_outsider(),
			pg_temp.own_status(v_case.function_name, v_case.row_id), v_case.message, v_case.function_name || ' from outside the company');
		perform pg_temp.own_refused(pg_temp.own_row(v_case.table_name, v_case.row_id), '{"role":"anon"}',
			pg_temp.own_status(v_case.function_name, v_case.row_id), v_case.message, v_case.function_name || ' with the publishable key');
		perform pg_temp.own_refused(pg_temp.own_row(v_case.table_name, v_case.row_id), pg_temp.own_contributor(),
			pg_temp.own_status(v_case.function_name, v_case.row_id, 'disabled'), v_case.message, v_case.function_name || ' by the contributor');
		perform pg_temp.own_refused(pg_temp.own_row(v_case.table_name, v_case.row_id), pg_temp.own_outsider(),
			pg_temp.own_status(v_case.function_name, '75700000-0000-4000-8000-000000000099'), v_case.message,
			v_case.function_name || ' for an id nobody has');
		perform pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row(v_case.table_name, v_case.row_id), pg_temp.own_owner(),
			pg_temp.own_status(v_case.function_name, v_case.row_id), v_case.function_name || ' by the owner') ->> 'status' = 'active',
			v_case.function_name || ': the owner keeps it active');
	end loop;
end $$;
select pg_temp.own_refused(pg_temp.own_row('qorpera_provider_connections', current_setting('qorpera_test.own_connection')),
	pg_temp.own_contributor(), pg_temp.own_status('qorpera_set_provider_connection_status', current_setting('qorpera_test.own_connection'),
		'revoked'), 'provider connection lifecycle requires authorize access', 'The contributor revoking the owner''s connection');
select pg_temp.own_refused(pg_temp.own_row('qorpera_provider_connections', current_setting('qorpera_test.own_connection')),
	pg_temp.own_contributor(), pg_temp.own_status('qorpera_set_provider_connection_status', '75700000-0000-4000-8000-000000000099',
		'revoked'), 'provider connection lifecycle requires authorize access', 'The contributor revoking a connection nobody has');
do $$
declare v_claims jsonb;
begin
	foreach v_claims in array array[pg_temp.own_outsider(), pg_temp.own_viewer(), pg_temp.own_contributor()] loop
		perform pg_temp.own_refused(pg_temp.own_row('qorpera_provider_connections', '75700000-0000-4000-8000-000000000045'), v_claims,
			pg_temp.own_status('qorpera_set_provider_connection_status', '75700000-0000-4000-8000-000000000045', 'revoked'),
			'provider connection lifecycle requires authorize access', (v_claims ->> 'sub') || ' revoking the company''s connection');
	end loop;
end $$;
select pg_temp.wake_assert(pg_temp.own_admin_waits(pg_temp.own_row('qorpera_provider_connections', '75700000-0000-4000-8000-000000000045'),
	pg_temp.own_status('qorpera_set_provider_connection_status', '75700000-0000-4000-8000-000000000045', 'revoked'),
	'An admin revoking the company''s connection') #>> '{result,status}' = 'revoked', 'An admin revokes the company''s connection');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_provider_connections', '75700000-0000-4000-8000-000000000030'),
	pg_temp.own_contributor(), pg_temp.own_status('qorpera_set_provider_connection_status', '75700000-0000-4000-8000-000000000030',
		'revoked'), 'The contributor revoking their own connection') ->> 'status' = 'revoked', 'The contributor revokes their own connection');

-- 9. A company secret. Granting it to an agent: owners and admins (the role was read first). Someone outside the
--    company, the contributor and the viewer are refused; a secret nobody has gets "query returned no rows" as before;
--    the owner and an admin wait for the secret and grant it. Granting it to one operation: the contributor, a grant
--    that has already expired and a secret nobody has are refused; the owner and an admin wait and meet the agent check
--    (no such agent). Rotating it: the contributor and an admin may capture secrets, but naming the company's secret as
--    their own is refused; the owner and an admin wait for the secret and start its rotation. The owner's own secret:
--    the contributor neither grants nor revokes it; the owner waits for it, meets the agent check, then revokes it.
--    Revoking the company's: the contributor, the viewer and a secret nobody has are refused; an admin waits and
--    revokes it.
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_outsider(), pg_temp.own_grant(), 'secret grant authority is unavailable', 'Granting another company''s secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_contributor(), pg_temp.own_grant(), 'secret grant authority is unavailable', 'The contributor granting the secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_viewer(), pg_temp.own_grant(), 'secret grant authority is unavailable', 'The viewer granting the secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_outsider(), pg_temp.own_grant('75700000-0000-4000-8000-000000000099'), 'query returned no rows',
	'Granting a secret nobody has', 'P0002');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_grant(), 'The owner granting the secret') ->> 'secretId' = '75700000-0000-4000-8000-000000000033',
	'The owner grants the secret');
select pg_temp.wake_assert(pg_temp.own_admin_waits(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_grant(), 'An admin granting the secret') #>> '{result,secretId}' = '75700000-0000-4000-8000-000000000033',
	'An admin grants the secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_contributor(), pg_temp.own_rotate('member', '30000000-0000-4000-8000-000000000002'),
	'secret rotation authority is unavailable', 'The contributor rotating the company''s secret as their own');
do $$
declare v_outcome jsonb := pg_temp.own_as_admin(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_rotate('member', '75700000-0000-4000-8000-000000000002'));
begin
	perform pg_temp.wake_assert(v_outcome ->> 'waited' = 'false' and v_outcome ->> 'state' = '42501'
		and v_outcome ->> 'error' = 'secret rotation authority is unavailable',
		'An admin rotating the company''s secret as their own is refused without waiting for the row: ' || v_outcome::text);
end $$;
select pg_temp.own_served(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_rotate('company', null), 'The owner rotating the company''s secret');
select pg_temp.own_admin_waits(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_rotate('company', null), 'An admin rotating the company''s secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_contributor(), pg_temp.own_grant_operation(), 'secret grant authority is unavailable',
	'The contributor granting the secret to an operation');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_grant_operation('75700000-0000-4000-8000-000000000099'), 'secret grant authority is unavailable',
	'Granting a secret nobody has to an operation');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_grant_operation(p_expires => statement_timestamp() - interval '1 minute'),
	'secret grant authority is unavailable', 'The owner granting the secret to an operation until a time already past');
select pg_temp.own_served(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_grant_operation(), 'The owner granting the secret to an operation', 'secret grant agent is unavailable');
select pg_temp.wake_assert(pg_temp.own_message(pg_temp.own_admin_waits(pg_temp.own_row('qorpera_cloud_secrets',
	'75700000-0000-4000-8000-000000000033'), pg_temp.own_grant_operation(), 'An admin granting the secret to an operation'))
	= 'secret grant agent is unavailable', 'An admin meets the agent check');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000048'),
	pg_temp.own_contributor(), pg_temp.own_grant_operation('75700000-0000-4000-8000-000000000048'), 'secret grant authority is unavailable',
	'The contributor granting the owner''s own secret to an operation');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000048'),
	pg_temp.own_contributor(), pg_temp.own_revoke_secret('75700000-0000-4000-8000-000000000048'), 'secret revocation is unavailable',
	'The contributor revoking the owner''s own secret');
select pg_temp.own_served(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000048'),
	pg_temp.own_owner(), pg_temp.own_grant_operation('75700000-0000-4000-8000-000000000048'),
	'The owner granting their own secret to an operation', 'secret grant agent is unavailable');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000048'),
	pg_temp.own_owner(), pg_temp.own_revoke_secret('75700000-0000-4000-8000-000000000048'), 'The owner revoking their own secret')
	->> 'status' = 'revoked', 'The owner revokes their own secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_contributor(), pg_temp.own_revoke_secret(), 'secret revocation is unavailable', 'The contributor revoking the secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_viewer(), pg_temp.own_revoke_secret(), 'secret revocation is unavailable', 'The viewer revoking the secret');
select pg_temp.own_refused(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_owner(), pg_temp.own_revoke_secret('75700000-0000-4000-8000-000000000099'), 'secret revocation is unavailable',
	'Revoking a secret nobody has');
select pg_temp.wake_assert(pg_temp.own_admin_waits(pg_temp.own_row('qorpera_cloud_secrets', '75700000-0000-4000-8000-000000000033'),
	pg_temp.own_revoke_secret(), 'An admin revoking the secret') #>> '{result,status}' = 'revoked', 'An admin revokes the secret');

-- 10. Reviewing a member's Company File edit: the member who made it. The contributor (a member: the Company File
--     actor serves them) is refused without waiting for the command; someone outside the company is refused by the
--     actor, as before. The owner waits for the command and meets its plan check.
select pg_temp.own_refused(pg_temp.own_row('qorpera_member_company_path_commands', '75700000-0000-4000-8000-000000000034'),
	pg_temp.own_contributor(), pg_temp.own_review(), 'Company File edit review is unavailable', 'The contributor reviewing the owner''s edit');
select pg_temp.own_refused(pg_temp.own_row('qorpera_member_company_path_commands', '75700000-0000-4000-8000-000000000034'),
	pg_temp.own_outsider(), pg_temp.own_review(), 'Company File authority is unavailable', 'Reviewing another company''s edit');
select pg_temp.own_served(pg_temp.own_row('qorpera_member_company_path_commands', '75700000-0000-4000-8000-000000000034'),
	pg_temp.own_owner(), pg_temp.own_review(), 'The owner reviewing their edit', 'Company File mutation is invalid');

-- 11. A turn in the owner's private conversation: the contributor is refused before the lock with the audience error
--     the input append gave; the owner waits for the conversation and the turn is requested. In a company
--     conversation the contributor still waits for the row (and meets the sponsor check, as in 756).
select pg_temp.own_refused(pg_temp.own_row('qorpera_shared_sessions', '75700000-0000-4000-8000-000000000037'),
	pg_temp.own_contributor(), pg_temp.own_turn('75700000-0000-4000-8000-000000000037', '75700000-0000-4000-8000-000000000040'),
	'session write access is required', 'The contributor''s turn in the owner''s private conversation');
select pg_temp.wake_assert(pg_temp.own_served(pg_temp.own_row('qorpera_shared_sessions', '75700000-0000-4000-8000-000000000037'),
	pg_temp.own_owner(), pg_temp.own_turn('75700000-0000-4000-8000-000000000037', '75700000-0000-4000-8000-000000000041'),
	'The owner''s turn in their private conversation') ->> 'status' = 'queued', 'The owner''s private turn is requested');
select pg_temp.own_served(pg_temp.own_row('qorpera_shared_sessions', '30000000-0000-4000-8000-000000000042'),
	pg_temp.own_contributor(), pg_temp.own_turn('30000000-0000-4000-8000-000000000042', '75700000-0000-4000-8000-000000000042'),
	'The contributor''s turn in a company conversation', 'session turn sponsor is unavailable');

-- 12. The locked checks stay: an admin removed from the company while their call waits for the row is refused. The
--     admin began the uploading graph and claimed the second receipt. For the company's connection the locked check
--     is 20260929790000's (before it, the admin's revocation landed).
select pg_temp.own_removed(pg_temp.own_row('qorpera_runner_jobs', current_setting('qorpera_test.own_job')), pg_temp.own_policy(),
	'runner model policy requires authorization access', 'The model policy');
select pg_temp.own_removed(pg_temp.own_row('qorpera_company_proposal_review_assignments', '75700000-0000-4000-8000-000000000014'),
	pg_temp.own_retry(), 'proposal review recovery requires authorize access', 'Retrying the review');
select pg_temp.own_removed(pg_temp.own_row('qorpera_artifact_retention_holds', '75700000-0000-4000-8000-000000000017'),
	pg_temp.own_release(), 'artifact retention requires full access', 'Releasing the hold');
select pg_temp.own_removed(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000023'),
	pg_temp.own_resolve('75700000-0000-4000-8000-000000000023'), 'operation recovery authorization is required', 'Resolving the receipt');
select pg_temp.own_removed(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000023'),
	pg_temp.own_stage('75700000-0000-4000-8000-000000000023'), 'live operation receipt ownership is required', 'Staging the receipt''s objects');
select pg_temp.own_removed(pg_temp.own_row('qorpera_operation_receipts', '75700000-0000-4000-8000-000000000023'),
	pg_temp.own_complete('75700000-0000-4000-8000-000000000023'), 'operation receipt access is required', 'Completing the receipt');
select pg_temp.own_removed(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
	pg_temp.own_run_resolve('qorpera_resolve_run_operation_receipt'), 'operation recovery requires authorize access',
	'Resolving the run receipt');
select pg_temp.own_removed(pg_temp.own_row('qorpera_run_operation_receipts', current_setting('qorpera_test.own_run_receipt')),
	pg_temp.own_run_resolve('qorpera_folder_resolve_run_receipt'), 'operation recovery requires authorize access',
	'Resolving the run receipt in the folder-v2 resolution');
select pg_temp.own_removed(pg_temp.own_row('qorpera_object_reachability_graphs', '75700000-0000-4000-8000-000000000024'),
	pg_temp.own_append('75700000-0000-4000-8000-000000000024'), 'object reachability requires graph-creator access', 'Appending to the graph');
select pg_temp.own_removed(pg_temp.own_row('qorpera_object_reachability_graphs', '75700000-0000-4000-8000-000000000024'),
	pg_temp.own_finish('75700000-0000-4000-8000-000000000024'), 'object reachability requires graph-creator access', 'Completing the graph');
select pg_temp.own_removed(pg_temp.own_row('qorpera_event_hooks', '75700000-0000-4000-8000-000000000027'),
	pg_temp.own_hook(p_status => 'active'), 'Only owners and admins can change hooks', 'Resuming the hook');
select pg_temp.own_removed(pg_temp.own_row('qorpera_execution_sponsor_bindings', current_setting('qorpera_test.own_binding')),
	pg_temp.own_status('qorpera_set_execution_sponsor_status', current_setting('qorpera_test.own_binding')),
	'execution sponsor lifecycle requires authorize access', 'The sponsor''s status');
select pg_temp.own_removed(pg_temp.own_row('qorpera_logical_computers', '75700000-0000-4000-8000-000000000028'),
	pg_temp.own_status('qorpera_set_logical_computer_status', '75700000-0000-4000-8000-000000000028'),
	'logical computer lifecycle requires authorize access', 'The computer''s status');
select pg_temp.own_removed(pg_temp.own_row('qorpera_provider_connections', current_setting('qorpera_test.own_connection')),
	pg_temp.own_status('qorpera_set_provider_connection_status', current_setting('qorpera_test.own_connection')),
	'provider connection lifecycle requires authorize access', 'The connection''s status');
select pg_temp.own_removed(pg_temp.own_row('qorpera_provider_connections', '75700000-0000-4000-8000-000000000045'),
	pg_temp.own_status('qorpera_set_provider_connection_status', '75700000-0000-4000-8000-000000000045', 'revoked'),
	'provider connection lifecycle requires authorize access', 'Revoking the company''s connection');

-- The folder-v2 resolution is the dispatcher's again.
revoke execute on function public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid) from anon, authenticated;
select pg_temp.wake_assert(proacl::text = current_setting('qorpera_test.own_folder_acl'), 'The folder-v2 resolution''s grants are as before')
from pg_proc where oid = 'public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid)'::regprocedure;

-- Remove what this test committed.
select pg_temp.lock_order_cleanup();
