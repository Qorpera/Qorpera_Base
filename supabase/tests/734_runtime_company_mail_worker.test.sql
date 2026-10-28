-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company mail, sending (M2b, 20260928309740), on the folder-v2 runtime base (ported from snapshot-v1 in the legacy sweep):
-- a background worker has no mouth, so it sends no email; its parent, a company agent, does. The worker is an in-house
-- worker Alice's run dispatches through the folder, started by the folder worker drain.

select pg_temp.base_claims('service_role');
create function pg_temp.mw_request() returns jsonb language sql as $$
	select jsonb_build_object('from', 'support@mail.example.test', 'to', jsonb_build_array('customer@example.org'),
		'subject', 'Prices', 'text', 'Here are the prices.')
$$;

update public.qorpera_mail_settings set domain = 'mail.example.test', enabled = true, sending = true;
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
select public.qorpera_create_company_mailbox('92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'support', 'Customer support') \g /dev/null
select pg_temp.base_claims('service_role');

-- Alice's run acknowledges its wake, sends an email itself, and dispatches an in-house worker on a todo the owner gave her.
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'mail-ack') \g /dev/null
select pg_temp.base_assert(public.qorpera_send_agent_mail(current_setting('qorpera_test.base_binding')::jsonb,
	'parent-mail', pg_temp.mw_request()) ->> 'status' = 'queued', 'The parent agent sends it');
select pg_temp.base_commit(pg_temp.base_owner(), 'mail-todo', jsonb_build_array(pg_temp.base_write('QorperaOS/agents/alice/todos/mail-scan.md',
	'todo', E'---\nid: 73400000-0000-4000-8000-0000000000d1\ntitle: Scan\nstatus: open\n---\nScan the market.\n',
	'{"kind":"todo","id":"73400000-0000-4000-8000-0000000000d1","title":"Scan","status":"open","requestedBy":null,"detail":"Scan the market."}'))) \g /dev/null
do $$
declare
	b jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_actor jsonb := jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId');
	v_folder constant text := 'QorperaOS/agents/alice/todos/mail-scan/scan';
	v_brief jsonb := jsonb_build_object('kind', 'worker-brief', 'id', '73400000-0000-4000-8000-0000000000e1', 'title', 'Scan',
		'species', 'in-house', 'access', 'read', 'revival', 'each',
		'dispatchedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'followUps', 0,
		'followedUpAt', null, 'goal', 'Scan the market.', 'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb,
		'followUp', null) || public.qorpera_company_state_worker_standing('in-house', 'read', 'each');
	v_seal jsonb; v_units jsonb; v_review uuid; v_result jsonb;
begin
	v_seal := pg_temp.base_seal(v_actor, pg_temp.base_manifest(v_brief::text));
	perform pg_temp.base_assert(v_seal ->> 'state' = 'sealed', 'The run stages the brief: ' || v_seal::text);
	v_units := jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/agents/alice/todos/mail-scan'),
		jsonb_build_object('op', 'new_folder', 'path', v_folder,
			'contents', jsonb_build_array(jsonb_build_object('path', 'brief.md', 'kind', 'file', 'file', v_seal -> 'file')),
			'structured', jsonb_build_array(jsonb_build_object('path', v_folder || '/brief.md', 'kind', 'worker-brief',
				'text', v_brief::text, 'parse', v_brief, 'parserVersion', 1))));
	insert into public.qorpera_folder_reviews(environment_id, run_id, change_set_sha256, units, decision)
	values ('92400000-0000-4000-8000-000000000020', (b ->> 'runId')::uuid, public.qorpera_folder_change_set_sha256(v_units),
		array[1, 2], 'allow')
	returning id into v_review;
	v_result := public.qorpera_folder_worker_commit('92400000-0000-4000-8000-000000000020', v_actor, 'mail-dispatch', v_units,
		jsonb_build_object('action', 'dispatch', 'folder', v_folder, 'title', 'Scan', 'goal', 'Scan the market.',
			'doneWhen', 'A list.', 'context', null, 'sources', '[]'::jsonb, 'access', 'read', 'revival', 'each'), v_review);
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(v_result -> 'units') u where u ->> 'outcome' <> 'saved'),
		'The dispatch saves: ' || v_result::text);
end
$$;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'final', 'mail-final') \g /dev/null
update public.qorpera_runner_jobs set status = 'completed', result = '{}'::jsonb, finished_at = statement_timestamp(),
	lease_token_sha256 = null, lease_expires_at = null
where run_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;

-- The folder worker drain starts the worker, the materializer makes its run, and the run starts.
do $$
declare v_drain jsonb; v_pass jsonb; v_child jsonb;
begin
	perform set_config('qorpera.folder_wake_admission', '', true);
	v_drain := public.qorpera_folder_workers_company('92400000-0000-4000-8000-000000000020', 32);
	perform pg_temp.base_assert(v_drain ->> 'state' = 'done' and (v_drain ->> 'started')::integer = 1, 'The drain starts the worker: ' || v_drain::text);
	v_pass := pg_temp.base_materialize();
	perform pg_temp.base_assert(v_pass ->> 'state' = 'done' and jsonb_array_length(v_pass -> 'run_ids') = 1, 'The worker''s run: ' || v_pass::text);
	v_child := pg_temp.base_start(null);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_runtime_workers worker
		join public.qorpera_wake_occurrences wake on wake.id = worker.occurrence_id
		where worker.profile_id = '92400000-0000-4000-8000-000000000010' and wake.source_kind = 'worker-dispatch'
			and wake.run_id = (v_child ->> 'runId')::uuid), 'The worker''s run is running');
	perform set_config('qorpera_test.child_binding', v_child::text, true);
end
$$;

-- The worker's run may not send as the company.
select pg_temp.base_error(format('select public.qorpera_send_agent_mail(%L::jsonb, %L, %L::jsonb)',
	current_setting('qorpera_test.child_binding'), 'worker-mail', pg_temp.mw_request()),
	'42501', 'Only a company agent sends mail');
select pg_temp.base_assert((select count(*) = 1 and bool_and(call_id = 'parent-mail') from public.qorpera_company_mail_outbox),
	'Only the parent''s email is queued');

rollback;
