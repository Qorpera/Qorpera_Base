-- Runtime Step 7: connector catalog rows, OAuth account labels and company-wide
-- connector grants, company first (connections belong to the company). Synthetic identities only; no broker credential, provider
-- or ciphertext beyond random bytes standing in for an envelope.
begin;

create function pg_temp.connector_claims(p_role text,p_user uuid default null)
returns void language sql as $$
	select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;
create function pg_temp.connector_assert(p_value boolean,p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end
$$;
create function pg_temp.connector_denied(p_statement text)
returns void language plpgsql as $$
begin
	begin execute p_statement;
	exception when insufficient_privilege or invalid_parameter_value or unique_violation or no_data_found then return;
	end;
	raise exception 'Connector operation accepted unauthorized or malformed input';
end
$$;

insert into auth.users(id,email) values
	('38000000-0000-4000-8000-000000000001','connector-owner@example.test'),
	('38000000-0000-4000-8000-000000000002','connector-member@example.test'),
	('38000000-0000-4000-8000-000000000003','connector-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('38000000-0000-4000-8000-000000000010','Connector fixture','38000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000001','connector-owner@example.test','Owner','owner'),
	('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000002','connector-member@example.test','Member','contributor');
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('38000000-0000-4000-8000-000000000020','38000000-0000-4000-8000-000000000010','Environment',1,'38000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values
	('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000030','Anna','Operations','Use typed company connectors.',
		'blue','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'38000000-0000-4000-8000-000000000001'),
	('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000031','Bo','Sales','Use typed company connectors.',
		'red','round','active','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'38000000-0000-4000-8000-000000000001'),
	('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000032','Former','Retired','Archived agent.',
		'grey','round','archived','active','openai','gpt-native',clock_timestamp(),clock_timestamp(),'38000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256)
values ('38000000-0000-4000-8000-000000000040','38000000-0000-4000-8000-000000000010',
	'https://secrets.qorpera.test','company-kek-1',repeat('c',64));

-- The shipped catalog: three connectors, fifteen closed operations, tool names
-- prefixed by their connector, every schema closed.
select pg_temp.connector_assert((select count(*)=15 from public.qorpera_cloud_connector_operations
	where connector_id in ('github','gmail','google_drive') and status='active'),'Connector catalog rows are missing');
select pg_temp.connector_assert((select count(*)=7 from public.qorpera_cloud_connector_operations where connector_id='github'),
	'GitHub catalog differs');
select pg_temp.connector_assert((select count(*)=4 from public.qorpera_cloud_connector_operations where connector_id='gmail'),
	'Gmail catalog differs');
select pg_temp.connector_assert((select count(*)=4 from public.qorpera_cloud_connector_operations where connector_id='google_drive'),
	'Google Drive catalog differs');
select pg_temp.connector_assert(not exists (select 1 from public.qorpera_cloud_connector_operations
	where connector_id in ('github','gmail','google_drive') and left(tool_name,char_length(connector_id)+1)<>connector_id||'_'),
	'Connector tool names are not prefixed by their connector');
select pg_temp.connector_assert(not exists (select 1 from public.qorpera_cloud_connector_operations
	where connector_id in ('github','gmail','google_drive') and input_schema->'additionalProperties'<>'false'::jsonb),
	'Connector schema is not closed');
select pg_temp.connector_assert((select credential_name='refresh_token' from public.qorpera_cloud_connector_operations
	where connector_id='gmail' and operation_id='send_message'),'Gmail credential placement differs');
select pg_temp.connector_assert((select credential_name='access_token' and destination_origin='https://api.github.com'
	from public.qorpera_cloud_connector_operations where connector_id='github' and operation_id='get_issue'),'GitHub destination differs');

-- Privileges: the seven-argument completion belongs to the broker login only;
-- the connector grant call belongs to authenticated members; the helper to none.
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)','EXECUTE') then
			raise exception 'Seven-argument capture completion exposed to %',v_role;
		end if;
	end loop;
	foreach v_role in array array['anon','authenticated','service_role','qorpera_secret_broker'] loop
		if has_function_privilege(v_role,'public.qorpera_grant_cloud_connector_operations(uuid,uuid,uuid,uuid,uuid[])','EXECUTE') then
			raise exception 'Connector grant helper exposed to %',v_role;
		end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker','public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)','EXECUTE')
		or not has_function_privilege('authenticated','public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[])','EXECUTE')
		or has_function_privilege('anon','public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[])','EXECUTE') then
		raise exception 'Connector grant privileges differ';
	end if;
	-- Bundle v88: company connections are always shared; Stop sharing is gone.
	if to_regprocedure('public.qorpera_unshare_cloud_connector(uuid,uuid,uuid)') is not null then
		raise exception 'Stop sharing is still callable';
	end if;
end
$$;

-- Company first: an owner connects Gmail for the company; the broker completes
-- the capture with the mailbox label. The member who connected it is
-- attribution only.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.gmail_capture',public.qorpera_begin_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','company',null,
	'gmail','primary','Gmail account')::text,true);
reset role;
select set_config('qorpera_test.gmail_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.gmail_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.gmail_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.gmail_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.gmail_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.gmail_descriptor',public.qorpera_complete_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.gmail_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.gmail_capability_sha'),
	current_setting('qorpera_test.gmail_envelope'),current_setting('qorpera_test.gmail_envelope_sha'),
	'office@example.test')::text,true);
-- Labels with whitespace or control characters are refused; the label is data, never a token.
select pg_temp.connector_denied(format($q$select public.qorpera_complete_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000040',repeat('c',64),%L,%L,%L,%L,%L)$q$,
	(current_setting('qorpera_test.gmail_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.gmail_capability_sha'),
	current_setting('qorpera_test.gmail_envelope'),current_setting('qorpera_test.gmail_envelope_sha'),
	E'two words\nline'));
reset session authorization;
select pg_temp.connector_assert((current_setting('qorpera_test.gmail_descriptor')::jsonb->>'accountLabel')='office@example.test',
	'Capture completion did not record the account label');
select pg_temp.connector_assert((current_setting('qorpera_test.gmail_descriptor')::jsonb->>'connectorId')='gmail'
	and (current_setting('qorpera_test.gmail_descriptor')::jsonb->>'ownerKind')='company',
	'Descriptor connector or owner differs');
-- Always shared (bundle v88): sealing the company connection shared it with
-- every active agent, every operation, once, under the owner who connected it;
-- archived agents excluded; the connection is marked shared.
select pg_temp.connector_assert((select available_to_all_agents from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid),
	'The captured company connection is not marked shared');
select pg_temp.connector_assert((select count(*)=8 and count(distinct staff_agent_id)=2
		and bool_and(issued_by_user_id='38000000-0000-4000-8000-000000000001')
	from public.qorpera_cloud_secret_operation_grants
	where secret_id=(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid and status='active'),
	'Capture did not grant the four Gmail operations to both active agents');

-- A contributor cannot open a company connection (the kernel's owner/admin rule).
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.connector_denied($q$select public.qorpera_begin_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','company',null,
	'google_drive','primary','Google Drive account')$q$);
-- The kernel's member-owned mode still captures a member's own secret, but
-- Step 7 never shares it with the company's agents.
select set_config('qorpera_test.personal_capture',public.qorpera_begin_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','member',
	'38000000-0000-4000-8000-000000000002','gmail','primary','My Gmail')::text,true);
reset role;
select set_config('qorpera_test.personal_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.personal_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.personal_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.personal_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.personal_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.personal_descriptor',public.qorpera_complete_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.personal_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.personal_capability_sha'),
	current_setting('qorpera_test.personal_envelope'),current_setting('qorpera_test.personal_envelope_sha'),
	'me@example.test')::text,true);
reset session authorization;
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.connector_denied(format($q$select public.qorpera_grant_cloud_connector(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',%L)$q$,
	(current_setting('qorpera_test.personal_descriptor')::jsonb->>'secretId')::uuid));
reset role;
do $$
begin
	update public.qorpera_cloud_secrets set available_to_all_agents = true
	where id = (current_setting('qorpera_test.personal_descriptor')::jsonb->>'secretId')::uuid;
	raise exception 'A member-owned connection was shared with every agent';
exception when check_violation then null;
end
$$;

-- The six-argument completion still works for a Step 2 broker and returns the
-- exact legacy key set.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.github_capture',public.qorpera_begin_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020','company',null,
	'github','primary','Company GitHub')::text,true);
reset role;
select set_config('qorpera_test.github_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.github_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.github_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.github_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.github_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.github_descriptor',public.qorpera_complete_cloud_secret_capture(
	'38000000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.github_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.github_capability_sha'),
	current_setting('qorpera_test.github_envelope'),current_setting('qorpera_test.github_envelope_sha'))::text,true);
reset session authorization;
select pg_temp.connector_assert(not (current_setting('qorpera_test.github_descriptor')::jsonb ? 'accountLabel'),
	'Legacy completion leaked the new descriptor key');
select pg_temp.connector_assert((select array_agg(key order by key) from jsonb_object_keys(current_setting('qorpera_test.github_descriptor')::jsonb) as key)
	= array['connectorId','ownerKind','ownerUserId','purpose','schema','secretId','secretName','status','version'],
	'Legacy descriptor key set differs');

-- A contributor cannot share a company connection; only an owner or admin can.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.connector_denied(format($q$select public.qorpera_grant_cloud_connector(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',%L)$q$,
	(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid));
reset role;

-- The owner's share call is the idempotent repair: with every grant live it
-- issues nothing, and repeating it issues nothing either.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.gmail_grants',public.qorpera_grant_cloud_connector(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
	(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid)::text,true);
select pg_temp.connector_assert((current_setting('qorpera_test.gmail_grants')::jsonb->>'grantsIssued')::int=0
	and (current_setting('qorpera_test.gmail_grants')::jsonb->>'agentCount')::int=2
	and (current_setting('qorpera_test.gmail_grants')::jsonb->>'availableToAllAgents')::boolean,
	'The share call on a shared connection issued grants');
select pg_temp.connector_assert((public.qorpera_grant_cloud_connector(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
	(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid)->>'grantsIssued')::int=0,
	'Connector grants were duplicated');
-- Naming one agent adds nothing: the GitHub connection, sealed through the
-- six-argument Step 2 completion, was shared with every agent too.
select pg_temp.connector_assert((public.qorpera_grant_cloud_connector(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020',
	(current_setting('qorpera_test.github_descriptor')::jsonb->>'secretId')::uuid,
	array['38000000-0000-4000-8000-000000000030'::uuid])->>'grantsIssued')::int=0,
	'A shared GitHub connection was granted again');
reset role;
select pg_temp.connector_assert((select count(*)=22 from public.qorpera_cloud_secret_operation_grants
	where profile_id='38000000-0000-4000-8000-000000000010' and status='active'),'Active grant count differs');
select pg_temp.connector_assert((select available_to_all_agents from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid),'Gmail connection is not marked shared');
select pg_temp.connector_assert((select available_to_all_agents from public.qorpera_cloud_secrets
	where id=(current_setting('qorpera_test.github_descriptor')::jsonb->>'secretId')::uuid),'GitHub connection is not marked shared');

-- Every member sees the company's connections with the label, the grant state
-- and who connected them; ciphertext stays out.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.connections',public.qorpera_list_cloud_secret_connections(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020')::text,true);
reset role;
select pg_temp.connector_assert((select count(*)=2 from jsonb_array_elements(current_setting('qorpera_test.connections')::jsonb)
	as item where item->>'ownerKind'='company'),
	'Member sees a different number of company connections');
select pg_temp.connector_assert((select bool_and(item->>'accountLabel'='office@example.test' and (item->>'activeGrantCount')::int=8
		and (item->>'availableToAllAgents')::boolean
		and item->>'connectedByUserId'='38000000-0000-4000-8000-000000000001')
	from jsonb_array_elements(current_setting('qorpera_test.connections')::jsonb) as item
	where item->>'connectorId'='gmail' and item->>'ownerKind'='company'),
	'Gmail descriptor differs');
select pg_temp.connector_assert((select bool_and(item->'connectedByUserId'='null'::jsonb)
	from jsonb_array_elements(current_setting('qorpera_test.connections')::jsonb) as item
	where item->>'ownerKind'='member'),
	'A member-owned connection names its creator');
select pg_temp.connector_assert(position('encryptedEnvelope' in current_setting('qorpera_test.connections'))=0,
	'Descriptor exposed ciphertext');

-- A later hire receives every company connection's grants automatically. A
-- contributor's hire is issued by the member who connected the account, since
-- a company grant holds only while its issuer is an owner or admin. Archiving
-- revokes the grants again.
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000033','Newcomer','Support','Help customers.',
	'green','round','active','setup','openai','gpt-native',clock_timestamp(),clock_timestamp(),'38000000-0000-4000-8000-000000000002');
select pg_temp.connector_assert((select count(*)=4 from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id='38000000-0000-4000-8000-000000000033' and status='active' and connector_id='gmail'
		and issued_by_user_id='38000000-0000-4000-8000-000000000001'),
	'New hire did not receive the shared Gmail grants from an owner');
select pg_temp.connector_assert((select count(*)=7 from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id='38000000-0000-4000-8000-000000000033' and status='active' and connector_id='github'
		and issued_by_user_id='38000000-0000-4000-8000-000000000001'),
	'New hire did not receive the company GitHub grants');
update public.qorpera_profile_staff set employment_status='archived',updated_at=clock_timestamp()
where profile_id='38000000-0000-4000-8000-000000000010' and staff_agent_id='38000000-0000-4000-8000-000000000033';
select pg_temp.connector_assert((select count(*)=0 from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id='38000000-0000-4000-8000-000000000033' and status='active'),'Archiving left connector grants active');

-- The runtime lists the granted operations as tools, one per grant.
select pg_temp.connector_assert((select count(*)=11 from public.qorpera_cloud_secret_operation_grants
	where staff_agent_id='38000000-0000-4000-8000-000000000031' and status='active'),
	'Bo does not hold exactly the Gmail and GitHub grants');

-- Revoking the company connection fences every grant.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_cloud_secret('38000000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid);
reset role;
select pg_temp.connector_assert((select count(*)=0 from public.qorpera_cloud_secret_operation_grants
	where secret_id=(current_setting('qorpera_test.gmail_descriptor')::jsonb->>'secretId')::uuid and status='active'),
	'Revoking the connection left grants active');

-- An outsider sees nothing.
select pg_temp.connector_claims('authenticated','38000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.connector_assert(public.qorpera_list_cloud_secret_connections(
	'38000000-0000-4000-8000-000000000010','38000000-0000-4000-8000-000000000020')='[]'::jsonb,
	'Outsider discovered connections');
reset role;

rollback;
