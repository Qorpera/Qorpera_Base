begin;

create function pg_temp.secret_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;
create function pg_temp.secret_assert(p_value boolean,p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end
$$;
create function pg_temp.secret_denied(p_statement text)
returns void language plpgsql as $$
begin
	begin execute p_statement;
	exception when insufficient_privilege or invalid_parameter_value or unique_violation or no_data_found then return;
	end;
	raise exception 'Cloud secret operation accepted unauthorized or malformed input';
end
$$;

insert into auth.users(id,email) values
	('30500000-0000-4000-8000-000000000001','secret-owner@example.test'),
	('30500000-0000-4000-8000-000000000002','secret-member@example.test'),
	('30500000-0000-4000-8000-000000000003','secret-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('30500000-0000-4000-8000-000000000010','Secret custody fixture','30500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000001','secret-owner@example.test','Owner','owner'),
	('30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000002','secret-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('30500000-0000-4000-8000-000000000020','30500000-0000-4000-8000-000000000010','Environment',1,'30500000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000030','Agent','Operations','Use typed company connectors.',
	'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'30500000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('30500000-0000-4000-8000-000000000040','30500000-0000-4000-8000-000000000010',
	'https://secrets.qorpera.test','company-kek-1',repeat('a',64));
insert into public.qorpera_cloud_connector_operations(connector_id,operation_id,version,tool_name,description,
	input_schema,destination_origin,credential_name,adapter_sha256)
values ('linear','issue_create',1,'linear_issue_create','Create one issue through the company-authorized Linear connection.',
	'{"type":"object","properties":{"title":{"type":"string","maxLength":256}},"required":["title"],"additionalProperties":false}',
	'https://api.linear.app','token',repeat('b',64));

do $$
declare v_role text; v_table text;
begin
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		foreach v_table in array array[
			'public.qorpera_cloud_secret_broker_authorities','public.qorpera_cloud_connector_operations',
			'public.qorpera_cloud_secrets','public.qorpera_cloud_secret_versions',
			'public.qorpera_cloud_secret_capture_tickets','public.qorpera_cloud_secret_operation_grants',
			'public.qorpera_cloud_secret_audit_events'
		] loop
			if has_table_privilege(v_role,v_table,'SELECT,INSERT,UPDATE,DELETE') then
				raise exception 'Secret custody table bypass exposed to %: %',v_role,v_table;
			end if;
		end loop;
		if has_function_privilege(v_role,'public.qorpera_native_connector_locked_grant(jsonb,uuid)','EXECUTE') then
			raise exception 'Private connector grant helper exposed to %',v_role;
		end if;
		if has_function_privilege(v_role,'public.qorpera_native_tool_locked_run(jsonb)','EXECUTE') then
			raise exception 'Private native tool binding validator exposed to %',v_role;
		end if;
		if has_function_privilege(v_role,'public.qorpera_validate_native_provider_execution_lease_before_recovery(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE') then
			raise exception 'Private base native lease validator exposed to %',v_role;
		end if;
		if has_function_privilege(v_role,'public.qorpera_runner_broker_job(uuid,text,uuid,text)','EXECUTE') then
			raise exception 'Private runner broker validator exposed to %',v_role;
		end if;
	end loop;
	if not has_function_privilege('authenticated','public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)','EXECUTE')
		or has_function_privilege('authenticated','public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)','EXECUTE')
		or has_function_privilege('service_role','public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)','EXECUTE')
		or not has_function_privilege('qorpera_secret_broker','public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)','EXECUTE')
		or not has_function_privilege('qorpera_secret_broker','public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)','EXECUTE')
		or not has_function_privilege('qorpera_secret_broker','public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)','EXECUTE')
		or has_function_privilege('qorpera_secret_broker','public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE')
		or not has_function_privilege('service_role','public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE') then
		raise exception 'Secret capture or broker function privilege differs';
	end if;
	if (select rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit
		from pg_roles where rolname='qorpera_secret_broker') then
		raise exception 'Secret broker role has unsafe role attributes';
	end if;
	if position('v_receipt.downstream_idempotency_sha256 <> p_downstream_idempotency_sha256' in
		pg_get_functiondef('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure)) = 0
		or position('left(v_receipt.logical_operation_key, char_length(v_logical_operation_prefix)) <> v_logical_operation_prefix' in
		pg_get_functiondef('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure)) = 0 then
		raise exception 'Secret effect receipt is not exact and idempotency-bound';
	end if;
	if position('if session_user <> ''qorpera_secret_broker'' then' in
		pg_get_functiondef('public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure)) = 0
		or position('if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then' in
		pg_get_functiondef('public.qorpera_native_connector_locked_grant(jsonb,uuid)'::regprocedure)) = 0
		or position('if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then' in
		pg_get_functiondef('public.qorpera_native_tool_locked_run(jsonb)'::regprocedure)) = 0
		or position('if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then' in
		pg_get_functiondef('public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure)) = 0
		or position('if auth.role() <> ''service_role'' and session_user <> ''qorpera_secret_broker'' then' in
		pg_get_functiondef('public.qorpera_validate_native_provider_execution_lease_before_recovery(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure)) = 0
		or position('if auth.role() <> ''service_role'' and session_user <> ''qorpera_secret_broker''' in
		pg_get_functiondef('public.qorpera_runner_broker_job(uuid,text,uuid,text)'::regprocedure)) = 0 then
		raise exception 'Secret broker execution is not bound to its dedicated login session';
	end if;
end
$$;

select pg_temp.secret_claims('service_role');
set local role service_role;
select pg_temp.secret_denied($q$select public.qorpera_describe_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	'30500000-0000-4000-8000-000000000099',repeat('b',64))$q$);
reset role;

-- Capture completion rechecks current member authority instead of treating a
-- still-unexpired ticket as authority after revocation.
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.revoked_capture',public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','member',
	'30500000-0000-4000-8000-000000000002','linear','revoked_before_completion','Revoked capture')::text,true);
reset role;
update public.qorpera_profile_members set role='viewer'
where profile_id='30500000-0000-4000-8000-000000000010' and user_id='30500000-0000-4000-8000-000000000002';
select set_config('qorpera_test.revoked_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.revoked_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.revoked_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.revoked_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.revoked_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select pg_temp.secret_denied(format($q$select public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),%L,%L,%L,%L)$q$,
	(current_setting('qorpera_test.revoked_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.revoked_capability_sha'),
	current_setting('qorpera_test.revoked_envelope'),
	current_setting('qorpera_test.revoked_envelope_sha')));
reset session authorization;
update public.qorpera_profile_members set role='contributor'
where profile_id='30500000-0000-4000-8000-000000000010' and user_id='30500000-0000-4000-8000-000000000002';

-- Capture binds the broker key id described to the client. A concurrent key
-- rotation cannot relabel an envelope sealed under the prior key.
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.key_bound_capture',public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','company',null,
	'linear','key_changed_before_completion','Key-bound capture')::text,true);
reset role;
update public.qorpera_cloud_secret_broker_authorities set key_id='company-kek-2'
where id='30500000-0000-4000-8000-000000000040';
select set_config('qorpera_test.key_bound_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.key_bound_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.key_bound_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.key_bound_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.key_bound_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select pg_temp.secret_denied(format($q$select public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),%L,%L,%L,%L)$q$,
	(current_setting('qorpera_test.key_bound_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.key_bound_capability_sha'),
	current_setting('qorpera_test.key_bound_envelope'),
	current_setting('qorpera_test.key_bound_envelope_sha')));
reset session authorization;
update public.qorpera_cloud_secret_broker_authorities set key_id='company-kek-1'
where id='30500000-0000-4000-8000-000000000040';

select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.secret_denied($q$select public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','company',null,
	'linear','primary','Company Linear connection')$q$);
select pg_temp.secret_assert(public.qorpera_list_cloud_secret_connections(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020')='[]'::jsonb,
	'Outsider discovered secret descriptors');

select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000002');
select pg_temp.secret_denied($q$select public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','company',null,
	'linear','primary','Company Linear connection')$q$);

select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000001');
select set_config('qorpera_test.company_capture',public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','company',null,
	'linear','primary','Company Linear connection')::text,true);
select pg_temp.secret_assert((current_setting('qorpera_test.company_capture')::jsonb->>'serviceOrigin')='https://secrets.qorpera.test',
	'Capture ticket did not target the configured cloud broker');
select pg_temp.secret_assert(not (current_setting('qorpera_test.company_capture')::jsonb ? 'encryptedEnvelope'),
	'Capture ticket exposed an envelope');
reset role;

select set_config('qorpera_test.company_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.company_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.company_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.company_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.company_envelope'),'base64'),'sha256'),'hex'),true);
select set_config('qorpera_test.replay_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.replay_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.replay_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.company_description',public.qorpera_describe_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	(current_setting('qorpera_test.company_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.company_capability_sha'))::text,true);
select pg_temp.secret_assert((current_setting('qorpera_test.company_description')::jsonb->>'keyId')='company-kek-1',
	'Broker did not receive the pinned key id');
select set_config('qorpera_test.company_descriptor',public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	(current_setting('qorpera_test.company_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.company_capability_sha'),
	current_setting('qorpera_test.company_envelope'),current_setting('qorpera_test.company_envelope_sha'))::text,true);
-- Lost broker responses are idempotent and cannot replace the committed envelope.
select pg_temp.secret_assert(public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	(current_setting('qorpera_test.company_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.company_capability_sha'),
	current_setting('qorpera_test.replay_envelope'),
	current_setting('qorpera_test.replay_envelope_sha'))->>'secretId'=
	current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId','Committed capture did not replay safely');
reset session authorization;

select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.secret_assert(jsonb_array_length(public.qorpera_list_cloud_secret_connections(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020'))=1,
	'Company connection descriptor is missing');
select pg_temp.secret_assert(position('encryptedEnvelope' in public.qorpera_list_cloud_secret_connections(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020')::text)=0,
	'Member descriptor exposed ciphertext');
-- Since bundle v88 a company connection is shared with every agent as it is
-- sealed: the capture already granted the typed operation under the owner who
-- captured it, so a second grant of the same tool is refused.
select pg_temp.secret_denied(format($q$select public.qorpera_grant_cloud_secret_operation(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020',%L,
	'30500000-0000-4000-8000-000000000030','linear','issue_create',1)$q$,
	(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid));
reset role;
select set_config('qorpera_test.company_grant',(select jsonb_build_object('grantId',grant_row.id,'toolName',grant_row.tool_name)
	from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.secret_id=(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid
		and grant_row.staff_agent_id='30500000-0000-4000-8000-000000000030' and grant_row.status='active'
		and grant_row.issued_by_user_id='30500000-0000-4000-8000-000000000001')::text,true);
select pg_temp.secret_assert((current_setting('qorpera_test.company_grant')::jsonb->>'toolName')='linear_issue_create',
	'Capture did not grant the typed operation');
set local role authenticated;

-- Rotation creates a new immutable version while the operation grant remains.
select set_config('qorpera_test.rotation',public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','company',null,
	'linear','primary','Rotated company Linear connection',
	(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid)::text,true);
reset role;
select set_config('qorpera_test.rotation_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.rotation_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.rotation')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.rotation_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.rotation_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	(current_setting('qorpera_test.rotation')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.rotation_capability_sha'),
	current_setting('qorpera_test.rotation_envelope'),
	current_setting('qorpera_test.rotation_envelope_sha'));
reset session authorization;
select pg_temp.secret_assert((select current_version=2 from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid),'Rotation did not advance current version');
select pg_temp.secret_assert((select count(*)=2 from public.qorpera_cloud_secret_versions
	where secret_id=(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid),'Rotation overwrote an immutable version');
select pg_temp.secret_assert((select status='active' from public.qorpera_cloud_secret_operation_grants
	where id=(current_setting('qorpera_test.company_grant')::jsonb->>'grantId')::uuid),'Rotation revoked the operation grant');
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_cloud_secret_grant(
	'30500000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.company_grant')::jsonb->>'grantId')::uuid);
reset role;

-- Member-owned credentials can be granted only by, and used under, that member.
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.member_capture',public.qorpera_begin_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020','member',
	'30500000-0000-4000-8000-000000000002','linear','personal','Member Linear connection')::text,true);
reset role;
select set_config('qorpera_test.member_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.member_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.member_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.member_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.member_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.member_descriptor',public.qorpera_complete_cloud_secret_capture(
	'30500000-0000-4000-8000-000000000040',repeat('a',64),
	(current_setting('qorpera_test.member_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.member_capability_sha'),
	current_setting('qorpera_test.member_envelope'),
	current_setting('qorpera_test.member_envelope_sha'))::text,true);
reset session authorization;
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.secret_denied(format($q$select public.qorpera_grant_cloud_secret_operation(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020',%L,
	'30500000-0000-4000-8000-000000000030','linear','issue_create',1)$q$,
	(current_setting('qorpera_test.member_descriptor')::jsonb->>'secretId')::uuid));
select pg_temp.secret_claims('authenticated','30500000-0000-4000-8000-000000000002');
select set_config('qorpera_test.member_grant',public.qorpera_grant_cloud_secret_operation(
	'30500000-0000-4000-8000-000000000010','30500000-0000-4000-8000-000000000020',
	(current_setting('qorpera_test.member_descriptor')::jsonb->>'secretId')::uuid,
	'30500000-0000-4000-8000-000000000030','linear','issue_create',1)::text,true);
reset role;

-- Archiving an agent revokes its grants but does not delete either company or member ciphertext.
update public.qorpera_profile_staff set employment_status='archived',updated_at=clock_timestamp(),
	updated_by_user_id='30500000-0000-4000-8000-000000000001'
where profile_id='30500000-0000-4000-8000-000000000010' and staff_agent_id='30500000-0000-4000-8000-000000000030';
select pg_temp.secret_assert((select count(*)=0 from public.qorpera_cloud_secret_operation_grants where status='active'),
	'Archived agent retained a secret grant');
select pg_temp.secret_assert((select count(*)=3 from public.qorpera_cloud_secret_versions),
	'Archived agent deleted shared credential ciphertext');

-- Removing a member revokes their credential without affecting the company credential.
delete from public.qorpera_profile_members
where profile_id='30500000-0000-4000-8000-000000000010' and user_id='30500000-0000-4000-8000-000000000002';
select pg_temp.secret_assert((select status='revoked' from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.member_descriptor')::jsonb->>'secretId')::uuid),'Removed member credential remained active');
select pg_temp.secret_assert((select status='active' from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.company_descriptor')::jsonb->>'secretId')::uuid),'Member removal revoked company credential');

select pg_temp.secret_assert(not exists(select 1 from public.qorpera_execution_runs
	where profile_id='30500000-0000-4000-8000-000000000010'),'Secret custody created agent work');
select pg_temp.secret_assert(not exists(select 1 from public.qorpera_agent_sends),'Secret custody published a message');

rollback;
