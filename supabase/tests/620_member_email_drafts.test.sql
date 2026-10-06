-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member-reviewed email draft in an agent's thread on folder-v2 reaches Gmail only through its one-use capability and
-- an authenticated broker (20260925126000): a browser cannot fabricate a "sent" answer; a second send is refused while
-- one is pending, and a claimed action never executes twice; a wrong capability is refused; an expired ticket never
-- executes, even after a newer action replaced it; an ambiguous outcome (an unconfirmed receipt, or a broker lost after
-- its claim) locks the draft and is never retried (ported from snapshot-v1 in the legacy sweep). 662 §5 covers the sent
-- email's answer reaching the agent. scripts/test-email-draft-e2e.mjs seeds from this file up to the first one-line
-- jsonb do block below (its marker) and drives card …003 through the real client, broker and Gmail adapters.
create function pg_temp.ed_card(p_binding jsonb, p_event uuid) returns jsonb language sql as $$
	select public.qorpera_append_native_interaction_request((p_binding ->> 'leaseId')::uuid, (p_binding ->> 'runId')::uuid,
		(p_binding ->> 'jobId')::uuid, (p_binding ->> 'runnerId')::uuid, (p_binding ->> 'assignmentId')::uuid,
		(p_binding ->> 'credentialCapsuleId')::uuid, (p_binding ->> 'computeIdentityId')::uuid, 'openai', 'codex-cli', p_event,
		'{"schema":"qorpera.interaction/v1","surface":"draft","title":"New email","payload":{"platform":"email","connectorId":"gmail","from":"sender@example.test","to":["before@example.test"],"subject":"Before","body":"Before"}}')
$$;
-- The owner's action on a card in Bob's thread, on the owner's sponsor.
create function pg_temp.ed_prepare(p_interaction uuid, p_action uuid, p_kind text, p_ticket text) returns jsonb language sql as $$
	select public.qorpera_prepare_email_draft_action(current_setting('qorpera_test.ed_thread')::uuid, p_interaction, p_action, p_kind,
		'{"to":["edited@example.test"],"cc":[],"subject":"Edited","body":"Edited body"}', p_ticket,
		(current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 1)
$$;
create function pg_temp.ed_claim(p_action uuid, p_ticket text) returns jsonb language sql as $$
	select public.qorpera_claim_email_draft_action('62000000-0000-4000-8000-000000000001', repeat('a', 64), p_action, p_ticket)
$$;
create function pg_temp.ed_finish(p_action uuid, p_ticket text, p_result jsonb) returns jsonb language sql as $$
	select public.qorpera_finish_email_draft_action('62000000-0000-4000-8000-000000000001', repeat('a', 64), p_action, p_ticket, p_result)
$$;

select set_config('qorpera_test.ed_thread', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031')), true) \g /dev/null

-- The company's Gmail account in the vault, its broker, and Bob's grants for every Gmail operation.
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values('62000000-0000-4000-8000-000000000001','92400000-0000-4000-8000-000000000010','https://broker.example.test','test',repeat('a',64));
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,current_version,created_by_user_id,account_label)
values('62000000-0000-4000-8000-000000000002','92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000020','62000000-0000-4000-8000-000000000001','company','gmail','primary','Email',1,'92400000-0000-4000-8000-000000000001','sender@example.test');
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,envelope_sha256,created_by_user_id)
values('62000000-0000-4000-8000-000000000002',1,'62000000-0000-4000-8000-000000000001','test',decode('abcd','hex'),repeat('b',64),'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(profile_id,environment_id,secret_id,staff_agent_id,connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000020','62000000-0000-4000-8000-000000000002','92400000-0000-4000-8000-000000000031','gmail',operation_id,version,tool_name,'92400000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations where connector_id='gmail' and status='active';

-- The owner's post in Bob's thread becomes a run, which raises four email drafts for the owner.
do $$
declare v_post jsonb; v_run uuid; v_binding jsonb; v_card text;
begin
	v_post := pg_temp.base_post('92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000031',
		'Bob, draft the moving emails.');
	perform pg_temp.base_materialize();
	select run_id into strict v_run from public.qorpera_wake_occurrences where id = (v_post ->> 0)::uuid;
	perform pg_temp.base_assert(v_run is not null, 'the post is a run');
	v_binding := pg_temp.base_start(v_run);
	foreach v_card in array array['003', '012', '020', '040'] loop
		perform pg_temp.ed_card(v_binding, ('62000000-0000-4000-8000-000000000' || v_card)::uuid);
	end loop;
	-- The e2e harness finds the owner's sponsor by its client binding id.
	perform pg_temp.base_assert((select id from public.qorpera_execution_sponsor_bindings
		where profile_id = '92400000-0000-4000-8000-000000000010' and client_binding_id = '92400000-0000-4000-8000-000000000061')
		= (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid, 'the owner''s sponsor has its client binding id');
end
$$;

-- A browser cannot fabricate a "sent" answer; a second send is refused while one is pending.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare v jsonb; begin
	v := public.qorpera_get_email_draft(current_setting('qorpera_test.ed_thread')::uuid, '62000000-0000-4000-8000-000000000003');
	perform pg_temp.base_assert(v ->> 'from' = 'sender@example.test' and v ->> 'status' = 'ready', 'wrong initial state ' || v::text);
	perform pg_temp.base_error(format('select public.qorpera_answer_interaction(%L, %L, %L, %L, %L, %L, 1)',
		current_setting('qorpera_test.ed_thread'), '62000000-0000-4000-8000-000000000011', '62000000-0000-4000-8000-000000000003',
		'sent', '{}', current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id'),
		'42501', 'Gmail completion requires a provider receipt');
	v := pg_temp.ed_prepare('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004', 'send', repeat('d', 64));
	perform pg_temp.base_assert(v ->> 'status' = 'sending', 'not pending ' || v::text);
	perform pg_temp.base_error(format('select pg_temp.ed_prepare(%L, %L, %L, %L)', '62000000-0000-4000-8000-000000000003',
		'62000000-0000-4000-8000-000000000005', 'send', repeat('e', 64)), '55000', 'email action already in progress or finished');
end $$;
reset role;

-- The broker: a wrong capability is refused, and a claimed send never executes twice.
set session authorization qorpera_secret_broker;
do $$
declare v jsonb;
begin
	perform pg_temp.base_error(format('select pg_temp.ed_claim(%L, %L)', '62000000-0000-4000-8000-000000000004', repeat('e', 64)),
		'42501', 'email action unavailable');
	v := pg_temp.ed_claim('62000000-0000-4000-8000-000000000004', repeat('d', 64));
	perform pg_temp.base_assert(v -> 'execute' = 'true'::jsonb and v #>> '{content,body}' = 'Edited body', 'wrong claim ' || v::text);
	v := pg_temp.ed_claim('62000000-0000-4000-8000-000000000004', repeat('d', 64));
	perform pg_temp.base_assert(v -> 'execute' = 'false'::jsonb and not (v ? 'encryptedEnvelopeBase64'), 'second send allowed ' || v::text);
end
$$;
reset session authorization;

-- An expired ticket never executes, even after a newer action replaced it.
set local role authenticated;
select pg_temp.ed_prepare('62000000-0000-4000-8000-000000000012', '62000000-0000-4000-8000-000000000013', 'save', repeat('1', 64))
\g /dev/null
reset role;
update public.qorpera_member_email_actions set expires_at = statement_timestamp() - interval '1 minute'
where id = '62000000-0000-4000-8000-000000000013';
set session authorization qorpera_secret_broker;
do $$
declare v jsonb := pg_temp.ed_claim('62000000-0000-4000-8000-000000000013', repeat('1', 64));
begin
	perform pg_temp.base_assert(v -> 'execute' = 'false'::jsonb and v #>> '{state,status}' = 'ready' and v #>> '{state,phase}' = 'failed',
		'expired pending action unsafe ' || v::text);
end
$$;
reset session authorization;
set local role authenticated;
select pg_temp.ed_prepare('62000000-0000-4000-8000-000000000012', '62000000-0000-4000-8000-000000000014', 'save', repeat('2', 64))
\g /dev/null
select pg_temp.base_error(format('select pg_temp.ed_prepare(%L, %L, %L, %L)', '62000000-0000-4000-8000-000000000012',
	'62000000-0000-4000-8000-000000000013', 'save', repeat('1', 64)), '55000', 'email action superseded; refresh the card');
reset role;
set session authorization qorpera_secret_broker;
select pg_temp.base_error(format('select pg_temp.ed_claim(%L, %L)', '62000000-0000-4000-8000-000000000013', repeat('1', 64)),
	'55000', 'email action superseded');
reset session authorization;

-- An unconfirmed receipt locks the draft: the send is never retried.
set local role authenticated;
select pg_temp.ed_prepare('62000000-0000-4000-8000-000000000020', '62000000-0000-4000-8000-000000000015', 'send', repeat('3', 64))
\g /dev/null
reset role;
set session authorization qorpera_secret_broker;
do $$
declare v jsonb;
begin
	v := pg_temp.ed_claim('62000000-0000-4000-8000-000000000015', repeat('3', 64));
	perform pg_temp.base_assert(v -> 'execute' = 'true'::jsonb, 'the send was not claimed ' || v::text);
	v := pg_temp.ed_finish('62000000-0000-4000-8000-000000000015', repeat('3', 64), '{"status":"unconfirmed"}');
	perform pg_temp.base_assert(v ->> 'status' = 'unconfirmed', 'uncertainty hidden ' || v::text);
end
$$;
reset session authorization;
set local role authenticated;
select pg_temp.base_error(format('select pg_temp.ed_prepare(%L, %L, %L, %L)', '62000000-0000-4000-8000-000000000020',
	'62000000-0000-4000-8000-000000000016', 'send', repeat('4', 64)), '55000', 'email action already in progress or finished');
reset role;

-- A broker lost after its claim leaves the send unconfirmed: no new send, and a replayed claim never executes.
set local role authenticated;
select pg_temp.ed_prepare('62000000-0000-4000-8000-000000000040', '62000000-0000-4000-8000-000000000041', 'send', repeat('7', 64))
\g /dev/null
reset role;
set session authorization qorpera_secret_broker;
select pg_temp.base_assert(pg_temp.ed_claim('62000000-0000-4000-8000-000000000041', repeat('7', 64)) -> 'execute' = 'true'::jsonb,
	'crash fixture was not claimed');
reset session authorization;
update public.qorpera_member_email_actions set expires_at = statement_timestamp() - interval '1 minute'
where id = '62000000-0000-4000-8000-000000000041';
set local role authenticated;
select pg_temp.base_error(format('select pg_temp.ed_prepare(%L, %L, %L, %L)', '62000000-0000-4000-8000-000000000040',
	'62000000-0000-4000-8000-000000000042', 'send', repeat('8', 64)), '55000', 'email action already in progress or finished');
reset role;
set session authorization qorpera_secret_broker;
do $$
declare v jsonb := pg_temp.ed_claim('62000000-0000-4000-8000-000000000041', repeat('7', 64));
begin
	perform pg_temp.base_assert(v -> 'execute' = 'false'::jsonb and v #>> '{state,status}' = 'unconfirmed'
		and not (v ? 'encryptedEnvelopeBase64'), 'expired claim replay can resend ' || v::text);
end
$$;
reset session authorization;

rollback;
