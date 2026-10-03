-- @fixture 290_company_file_path_gateway.test.sql until "create function pg_temp.path_plan("
-- 20260928429988: the vault's functions refuse a missing proof. The shared vault's database login
-- (qorpera_secret_broker) serves every company, and the capability hash is the only proof that a call is for one.
-- `a <> b` and `x !~ p` are unknown, not true, when a side is NULL, and an unknown condition skipped the refusal:
-- a NULL capability, capture capability, digest, envelope or operation fact passed. Real admission, assignment and
-- native lease from the 290 fixture, a real capture ticket and a real executing effect receipt.
-- 1. Describing a capture ticket: a NULL or wrong broker capability, a NULL or wrong capture capability, and another
--    company's broker with its own real capability.
-- 2. Sealing it: the same, plus a NULL, malformed or other envelope's digest and a NULL or empty envelope, on the
--    pending ticket and again on the committed one (a repeat after a lost answer); the six-argument form too.
--    Nothing is sealed until the right call, which then seals once.
-- 3. Authorizing an agent's connector call: a NULL or wrong broker capability, another company's broker, each of the
--    five operation facts the broker pins NULL or wrong, a NULL or wrong input digest, a NULL, malformed or wrong
--    downstream digest. Nothing is audited as authorized until the right call, which hands out the envelope once.
-- Each NULL is refused with the error the wrong non-NULL value gets.

insert into auth.users(id,email) values ('80600000-0000-4000-8000-000000000001','null-safe-other-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('80600000-0000-4000-8000-000000000010','Other company','80600000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('80600000-0000-4000-8000-000000000010','80600000-0000-4000-8000-000000000001',
	'null-safe-other-owner@example.test','Other owner','owner');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('80600000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64)),
	('80600000-0000-4000-8000-000000000041','80600000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','other-kek-1',repeat('e',64));

-- Every broker call answers 'ok:<answer>' or '<sqlstate>:<message>'.
create function pg_temp.ns_try(p_sql text)
returns text language plpgsql as $$
declare v_result jsonb;
begin
	execute p_sql into v_result;
	return 'ok:' || v_result::text;
exception when others then
	return sqlstate || ':' || sqlerrm;
end
$$;
create function pg_temp.ns_expect(p_label text,p_got text,p_expected text)
returns void language plpgsql as $$
begin
	if p_got is distinct from p_expected then
		raise exception '%: expected %, got %',p_label,p_expected,p_got;
	end if;
end
$$;
grant execute on function pg_temp.ns_try(text), pg_temp.ns_expect(text,text,text) to qorpera_secret_broker;

-- 1. and 2. The owner starts a company connection's capture; the broker holds the ticket's capability.
select pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.ns_capture',public.qorpera_begin_cloud_secret_capture(
	'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020','company',null,
	'linear','primary','Company Linear connection')::text,true);
reset role;
select set_config('qorpera_test.ns_ticket',current_setting('qorpera_test.ns_capture')::jsonb->>'ticketId',true);
select set_config('qorpera_test.ns_ticket_capability',encode(extensions.digest(
	current_setting('qorpera_test.ns_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.ns_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.ns_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.ns_envelope'),'base64'),'sha256'),'hex'),true);

-- Describe with these broker and capture capabilities (this company's broker unless p_authority).
create function pg_temp.ns_describe(p_broker text,p_capture text,
	p_authority text default '80600000-0000-4000-8000-000000000040')
returns text language plpgsql as $$
begin
	return pg_temp.ns_try(format('select public.qorpera_describe_cloud_secret_capture(%L,%L,%L,%L)',
		p_authority,p_broker,current_setting('qorpera_test.ns_ticket'),p_capture));
end
$$;
-- Seal with these capabilities, envelope and digest (the seven-argument form unless p_six).
create function pg_temp.ns_complete(p_broker text,p_capture text,p_envelope text,p_sha text,p_six boolean default false,
	p_authority text default '80600000-0000-4000-8000-000000000040')
returns text language plpgsql as $$
begin
	return pg_temp.ns_try(format('select public.qorpera_complete_cloud_secret_capture(%L,%L,%L,%L,%L,%L%s)',
		p_authority,p_broker,current_setting('qorpera_test.ns_ticket'),p_capture,
		p_envelope,p_sha,case when p_six then '' else ',null' end));
end
$$;
grant execute on function pg_temp.ns_describe(text,text,text), pg_temp.ns_complete(text,text,text,text,boolean,text)
	to qorpera_secret_broker;

set local session authorization qorpera_secret_broker;
do $$
declare
	c text := repeat('c',64);
	t text := current_setting('qorpera_test.ns_ticket_capability');
	e text := current_setting('qorpera_test.ns_envelope');
	s text := current_setting('qorpera_test.ns_envelope_sha');
	v_broker text := '42501:cloud secret broker authority is unavailable';
	v_capture text := '42501:cloud secret capture is unavailable';
	v_completion text := '42501:cloud secret broker completion is invalid';
begin
	perform pg_temp.ns_expect('describe, NULL broker capability',pg_temp.ns_describe(null,t),v_broker);
	perform pg_temp.ns_expect('describe, wrong broker capability',pg_temp.ns_describe(repeat('d',64),t),v_broker);
	perform pg_temp.ns_expect('describe, NULL capture capability',pg_temp.ns_describe(c,null),v_capture);
	perform pg_temp.ns_expect('describe, wrong capture capability',pg_temp.ns_describe(c,repeat('d',64)),v_capture);
	perform pg_temp.ns_expect('describe, another company''s broker',
		pg_temp.ns_describe(repeat('e',64),t,'80600000-0000-4000-8000-000000000041'),v_capture);
	-- Control: the right capabilities describe the ticket.
	if coalesce(pg_temp.ns_describe(c,t) !~ '^ok:.*"keyId": "company-kek-1"',true) then
		raise exception 'The right capabilities did not describe the ticket: %',pg_temp.ns_describe(c,t);
	end if;

	perform pg_temp.ns_expect('seal, NULL broker capability',pg_temp.ns_complete(null,t,e,s),v_completion);
	perform pg_temp.ns_expect('seal, wrong broker capability',pg_temp.ns_complete(repeat('d',64),t,e,s),v_completion);
	perform pg_temp.ns_expect('seal (six arguments), NULL broker capability',pg_temp.ns_complete(null,t,e,s,true),
		v_completion);
	perform pg_temp.ns_expect('seal, NULL envelope digest',pg_temp.ns_complete(c,t,e,null),v_completion);
	perform pg_temp.ns_expect('seal, malformed envelope digest',pg_temp.ns_complete(c,t,e,'x'),v_completion);
	perform pg_temp.ns_expect('seal, NULL envelope',pg_temp.ns_complete(c,t,null,s),v_completion);
	perform pg_temp.ns_expect('seal, empty envelope',pg_temp.ns_complete(c,t,'',s),v_completion);
	perform pg_temp.ns_expect('seal, another envelope''s digest',pg_temp.ns_complete(c,t,e,repeat('0',64)),
		'22023:encrypted secret envelope is invalid');
	perform pg_temp.ns_expect('seal, NULL capture capability',pg_temp.ns_complete(c,null,e,s),v_capture);
	perform pg_temp.ns_expect('seal, wrong capture capability',pg_temp.ns_complete(c,repeat('d',64),e,s),v_capture);
	perform pg_temp.ns_expect('seal, another company''s broker',
		pg_temp.ns_complete(repeat('e',64),t,e,s,false,'80600000-0000-4000-8000-000000000041'),v_capture);
end
$$;
reset session authorization;

do $$
begin
	if (select status from public.qorpera_cloud_secret_capture_tickets
		where id = current_setting('qorpera_test.ns_ticket')::uuid) is distinct from 'pending'
		or exists (select 1 from public.qorpera_cloud_secrets as secret
			join public.qorpera_cloud_secret_capture_tickets as ticket on ticket.secret_id = secret.id
			where ticket.id = current_setting('qorpera_test.ns_ticket')::uuid) then
		raise exception 'A refused seal changed the ticket or sealed a secret';
	end if;
end
$$;

set local session authorization qorpera_secret_broker;
do $$
declare
	c text := repeat('c',64);
	t text := current_setting('qorpera_test.ns_ticket_capability');
	e text := current_setting('qorpera_test.ns_envelope');
	s text := current_setting('qorpera_test.ns_envelope_sha');
	v_capture text := '42501:cloud secret capture is unavailable';
	v_completion text := '42501:cloud secret broker completion is invalid';
begin
	-- Control: the right call seals.
	if coalesce(pg_temp.ns_complete(c,t,e,s) !~ '^ok:.*"status": "active"',true) then
		raise exception 'The right seal was refused: %',pg_temp.ns_complete(c,t,e,s);
	end if;
	-- A repeat after a lost answer still needs every proof.
	perform pg_temp.ns_expect('repeat seal, NULL broker capability',pg_temp.ns_complete(null,t,e,s),v_completion);
	perform pg_temp.ns_expect('repeat seal, NULL envelope digest',pg_temp.ns_complete(c,t,e,null),v_completion);
	perform pg_temp.ns_expect('repeat seal, NULL envelope',pg_temp.ns_complete(c,t,null,s),v_completion);
	perform pg_temp.ns_expect('repeat seal, NULL capture capability',pg_temp.ns_complete(c,null,e,s),v_capture);
	if coalesce(pg_temp.ns_complete(c,t,e,s) !~ '^ok:.*"status": "active"',true) then
		raise exception 'The right repeat seal was refused: %',pg_temp.ns_complete(c,t,e,s);
	end if;
end
$$;
reset session authorization;

do $$
begin
	if (select count(*) from public.qorpera_cloud_secret_versions as version
		join public.qorpera_cloud_secret_capture_tickets as ticket on ticket.secret_id = version.secret_id
		where ticket.id = current_setting('qorpera_test.ns_ticket')::uuid
			and version.envelope_sha256 = current_setting('qorpera_test.ns_envelope_sha')) <> 1 then
		raise exception 'The capture was not sealed exactly once';
	end if;
end
$$;

-- 3. The run's company holds a Gmail connection sealed by its own broker and granted to the run's agent; the run
-- acknowledges its wake and begins the tool call's effect receipt, as the runtime does.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('80600000-0000-4000-8000-000000000050','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','80600000-0000-4000-8000-000000000040','company',null,
	'gmail','primary','Gmail account',1,'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,created_by_user_id)
values ('80600000-0000-4000-8000-000000000050',1,'80600000-0000-4000-8000-000000000040','company-kek-1','\x0102',
	encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '80600000-0000-4000-8000-000000000060','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','80600000-0000-4000-8000-000000000050',
	'29000000-0000-4000-8000-000000000030',operation.connector_id,operation.operation_id,operation.version,
	operation.tool_name,'29000000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations as operation
where operation.connector_id = 'gmail' and operation.operation_id = 'search_messages' and operation.status = 'active';
select set_config('qorpera_test.ns_operation',(select jsonb_build_object('version',version,'adapter',adapter_sha256,
		'origin',destination_origin,'tool',tool_name)::text
	from public.qorpera_cloud_connector_operations
	where connector_id = 'gmail' and operation_id = 'search_messages' and status = 'active'),true);

select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','null-safe-ack','Checking the mailbox.','progress');
	perform public.qorpera_begin_native_tool_operation(b,'80600000-0000-4000-8000-000000000070',
		(current_setting('qorpera_test.ns_operation')::jsonb ->> 'tool') || ':80600000-0000-4000-8000-000000000060:k1',
		repeat('a',64),repeat('b',64),false);
end $$;
reset role;

-- Authorize with this broker capability, these operation facts and these digests (this company's broker unless
-- p_authority).
create function pg_temp.ns_authorize(p_broker text,p_connector text,p_operation text,p_version bigint,p_adapter text,
	p_origin text,p_input text,p_downstream text,p_authority text default '80600000-0000-4000-8000-000000000040')
returns text language plpgsql as $$
begin
	return pg_temp.ns_try(format('select public.qorpera_authorize_cloud_secret_operation(%L,%L,%L::jsonb,%L,%L,%L,%L,'
		'%L,%L,%L,%L,%L)',
		p_authority,p_broker,current_setting('qorpera_test.path_binding'),
		'80600000-0000-4000-8000-000000000070',p_input,p_downstream,'80600000-0000-4000-8000-000000000060',
		p_connector,p_operation,p_version,p_adapter,p_origin));
end
$$;
grant execute on function pg_temp.ns_authorize(text,text,text,bigint,text,text,text,text,text) to qorpera_secret_broker;

set local session authorization qorpera_secret_broker;
do $$
declare
	o jsonb := current_setting('qorpera_test.ns_operation')::jsonb;
	c text := repeat('c',64);
	n text := 'gmail';
	p text := 'search_messages';
	v bigint := (o ->> 'version')::bigint;
	a text := o ->> 'adapter';
	d text := o ->> 'origin';
	i text := repeat('a',64);
	k text := repeat('b',64);
	v_broker text := '42501:cloud secret broker authority is unavailable';
	v_operation text := '42501:cloud secret operation differs from its grant';
	v_receipt text := '42501:cloud secret effect receipt is unavailable';
begin
	perform pg_temp.ns_expect('authorize, NULL broker capability',pg_temp.ns_authorize(null,n,p,v,a,d,i,k),v_broker);
	perform pg_temp.ns_expect('authorize, wrong broker capability',
		pg_temp.ns_authorize(repeat('d',64),n,p,v,a,d,i,k),v_broker);
	perform pg_temp.ns_expect('authorize, another company''s broker',
		pg_temp.ns_authorize(repeat('e',64),n,p,v,a,d,i,k,'80600000-0000-4000-8000-000000000041'),
		'42501:cloud secret broker does not own this envelope');
	perform pg_temp.ns_expect('authorize, NULL connector',pg_temp.ns_authorize(c,null,p,v,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, wrong connector',pg_temp.ns_authorize(c,'google_drive',p,v,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, NULL operation',pg_temp.ns_authorize(c,n,null,v,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, wrong operation',pg_temp.ns_authorize(c,n,'send_message',v,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, NULL operation version',pg_temp.ns_authorize(c,n,p,null,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, wrong operation version',pg_temp.ns_authorize(c,n,p,v + 1,a,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, NULL adapter digest',pg_temp.ns_authorize(c,n,p,v,null,d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, wrong adapter digest',
		pg_temp.ns_authorize(c,n,p,v,repeat('0',64),d,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, NULL destination',pg_temp.ns_authorize(c,n,p,v,a,null,i,k),v_operation);
	perform pg_temp.ns_expect('authorize, wrong destination',
		pg_temp.ns_authorize(c,n,p,v,a,'https://attacker.example.test',i,k),v_operation);
	perform pg_temp.ns_expect('authorize, NULL input digest',pg_temp.ns_authorize(c,n,p,v,a,d,null,k),v_receipt);
	perform pg_temp.ns_expect('authorize, wrong input digest',
		pg_temp.ns_authorize(c,n,p,v,a,d,repeat('0',64),k),v_receipt);
	perform pg_temp.ns_expect('authorize, NULL downstream digest',pg_temp.ns_authorize(c,n,p,v,a,d,i,null),v_receipt);
	perform pg_temp.ns_expect('authorize, malformed downstream digest',pg_temp.ns_authorize(c,n,p,v,a,d,i,'x'),v_receipt);
	perform pg_temp.ns_expect('authorize, wrong downstream digest',
		pg_temp.ns_authorize(c,n,p,v,a,d,i,repeat('0',64)),v_receipt);
end
$$;
reset session authorization;

do $$
begin
	if exists (select 1 from public.qorpera_cloud_secret_audit_events
		where secret_id = '80600000-0000-4000-8000-000000000050' and event_type = 'effect_authorized') then
		raise exception 'A refused operation was audited as authorized';
	end if;
end
$$;

-- Control: the right call hands out the sealed envelope, bound to the receipt and its input.
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.ns_authorized',pg_temp.ns_authorize(repeat('c',64),'gmail','search_messages',
	(current_setting('qorpera_test.ns_operation')::jsonb ->> 'version')::bigint,
	current_setting('qorpera_test.ns_operation')::jsonb ->> 'adapter',
	current_setting('qorpera_test.ns_operation')::jsonb ->> 'origin',repeat('a',64),repeat('b',64)),true);
reset session authorization;

do $$
declare v_answer jsonb;
begin
	if coalesce(current_setting('qorpera_test.ns_authorized') !~ '^ok:',true) then
		raise exception 'The right call was not authorized: %',current_setting('qorpera_test.ns_authorized');
	end if;
	v_answer := substr(current_setting('qorpera_test.ns_authorized'),4)::jsonb;
	if v_answer ->> 'secretId' is distinct from '80600000-0000-4000-8000-000000000050'
		or v_answer ->> 'receiptId' is distinct from '80600000-0000-4000-8000-000000000070'
		or v_answer ->> 'inputSha256' is distinct from repeat('a',64)
		or decode(v_answer ->> 'encryptedEnvelopeBase64','base64') is distinct from '\x0102'::bytea then
		raise exception 'The authorization answer differs: %',v_answer;
	end if;
	if (select count(*) from public.qorpera_cloud_secret_audit_events
		where secret_id = '80600000-0000-4000-8000-000000000050' and event_type = 'effect_authorized'
			and receipt_id = '80600000-0000-4000-8000-000000000070') <> 1 then
		raise exception 'The right call was not audited exactly once';
	end if;
end
$$;

rollback;
