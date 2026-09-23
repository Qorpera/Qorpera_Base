-- @fixture 290_company_file_path_gateway.test.sql until "create function pg_temp.path_plan("
-- Runtime Step 7 (bundle v87): all companies' secret brokers sit behind one
-- public origin, and the router picks a company's broker from the
-- `?company=<profileId>` a runner puts on `/v1/operations`. The query only
-- routes. A request that reaches another company's broker is refused by the
-- database, which authorizes every operation against the run's own grant and
-- the broker authority that owns the sealed secret. Real admission, assignment
-- and native lease from the 290 fixture; the secret row stands in for a
-- completed capture.

insert into auth.users(id,email) values ('39800000-0000-4000-8000-000000000001','routing-other-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('39800000-0000-4000-8000-000000000010','Other company','39800000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('39800000-0000-4000-8000-000000000010','39800000-0000-4000-8000-000000000001',
	'routing-other-owner@example.test','Other owner','owner');
-- Both brokers share one public origin, as in production.
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('39800000-0000-4000-8000-000000000040','29000000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64)),
	('39800000-0000-4000-8000-000000000041','39800000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','other-kek-1',repeat('e',64));
-- The run's company holds a company-owned Gmail connection, sealed by its own
-- broker, granted to the run's agent by the owner.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('39800000-0000-4000-8000-000000000050','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000040','company',null,
	'gmail','primary','Gmail account',1,'29000000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '39800000-0000-4000-8000-000000000060','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000050',
	'29000000-0000-4000-8000-000000000030',operation.connector_id,operation.operation_id,operation.version,
	operation.tool_name,'29000000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations as operation
where operation.connector_id = 'gmail' and operation.operation_id = 'search_messages' and operation.status = 'active';
select set_config('qorpera_test.routing_adapter',(select adapter_sha256 from public.qorpera_cloud_connector_operations
	where connector_id = 'gmail' and operation_id = 'search_messages' and status = 'active'),true);

-- The run acknowledges its wake, as every run does before connector work.
select pg_temp.path_claims('service_role');
set local role service_role;
do $$
declare b jsonb := current_setting('qorpera_test.path_binding')::jsonb;
begin
	perform public.qorpera_send_native_agent_message((b ->> 'leaseId')::uuid,(b ->> 'runId')::uuid,
		(b ->> 'jobId')::uuid,(b ->> 'runnerId')::uuid,(b ->> 'assignmentId')::uuid,
		(b ->> 'credentialCapsuleId')::uuid,(b ->> 'computeIdentityId')::uuid,
		'openai','codex-cli','routing-ack','Checking the mailbox.','progress');
end $$;
reset role;

create function pg_temp.routing_authorize(p_authority uuid,p_capability text)
returns text language plpgsql as $$
begin
	perform public.qorpera_authorize_cloud_secret_operation(p_authority,p_capability,
		current_setting('qorpera_test.path_binding')::jsonb,'39800000-0000-4000-8000-000000000070',
		repeat('a',64),repeat('b',64),'39800000-0000-4000-8000-000000000060','gmail','search_messages',1,
		current_setting('qorpera_test.routing_adapter'),'https://gmail.googleapis.com');
	return 'authorized';
exception when others then
	return sqlstate || ':' || sqlerrm;
end
$$;
grant execute on function pg_temp.routing_authorize(uuid,text) to qorpera_secret_broker;

set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.routing_other',
	pg_temp.routing_authorize('39800000-0000-4000-8000-000000000041',repeat('e',64)),true);
select set_config('qorpera_test.routing_own',
	pg_temp.routing_authorize('39800000-0000-4000-8000-000000000040',repeat('c',64)),true);
reset session authorization;

do $$
begin
	-- Another company's broker, however the request reached it: refused before
	-- any envelope, receipt or adapter.
	if current_setting('qorpera_test.routing_other') <> '42501:cloud secret broker does not own this envelope' then
		raise exception 'Another company''s broker was not refused: %',current_setting('qorpera_test.routing_other');
	end if;
	-- Control: the run's own broker passes the grant and ownership checks and
	-- stops only at the effect receipt this fixture never admitted.
	if current_setting('qorpera_test.routing_own') <> 'P0002:query returned no rows' then
		raise exception 'The run''s own broker did not reach the receipt check: %',current_setting('qorpera_test.routing_own');
	end if;
	if exists (select 1 from public.qorpera_cloud_secret_audit_events
		where secret_id = '39800000-0000-4000-8000-000000000050' and event_type = 'effect_authorized') then
		raise exception 'A refused operation was audited as authorized';
	end if;
end
$$;

rollback;
