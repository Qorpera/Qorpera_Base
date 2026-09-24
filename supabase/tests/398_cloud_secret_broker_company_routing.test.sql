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

-- Grants outlive their issuer only through a re-share. An admin shares a
-- company Google Drive connection; demoting that admin kills the grants (the
-- kernel rechecks the issuer at every call); another admin's re-share re-issues
-- them under the caller; a later hire gets them from a current owner; Stop
-- sharing takes them away again.
insert into auth.users(id,email) values ('39800000-0000-4000-8000-000000000004','routing-admin@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('29000000-0000-4000-8000-000000000010','39800000-0000-4000-8000-000000000004',
	'routing-admin@example.test','Admin','admin');
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('39800000-0000-4000-8000-000000000051','29000000-0000-4000-8000-000000000010',
	'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000040','company',null,
	'google_drive','primary','Google Drive account',1,'39800000-0000-4000-8000-000000000004');

create function pg_temp.routing_drive_tools()
returns integer language plpgsql as $$
declare v_count integer;
begin
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	select count(*) into v_count
	from jsonb_array_elements(public.qorpera_list_native_connector_tools(current_setting('qorpera_test.path_binding')::jsonb))
		as tool
	where tool ->> 'connectorId' = 'google_drive';
	reset role;
	return v_count;
end
$$;
create function pg_temp.routing_drive_live()
returns integer language plpgsql as $$
declare v_count integer;
begin
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	select (item ->> 'activeGrantCount')::integer into v_count
	from jsonb_array_elements(public.qorpera_list_cloud_secret_connections(
		'29000000-0000-4000-8000-000000000010','29000000-0000-4000-8000-000000000020')) as item
	where item ->> 'secretId' = '39800000-0000-4000-8000-000000000051';
	reset role;
	return v_count;
end
$$;
create function pg_temp.routing_share(p_user uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.path_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_grant_cloud_connector('29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000051');
	reset role;
	return v_result;
end
$$;

do $$
declare v_result jsonb; v_count integer;
begin
	v_result := pg_temp.routing_share('39800000-0000-4000-8000-000000000004');
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 4 then raise exception 'The shared Drive connection gave % tools, not 4',v_count; end if;
	-- The admin who shared it is demoted: the grants stay rows but no longer hold.
	update public.qorpera_profile_members set role = 'contributor'
	where profile_id = '29000000-0000-4000-8000-000000000010' and user_id = '39800000-0000-4000-8000-000000000004';
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 0 then raise exception 'A demoted issuer''s grants still gave % tools',v_count; end if;
	-- The page counts live grants only, so the dead share reads as not shared.
	if pg_temp.routing_drive_live() <> 0 then
		raise exception 'The connection list still counts the demoted issuer''s grants';
	end if;
	-- Another admin (the owner) shares it again: the dead grants are re-issued.
	v_result := pg_temp.routing_share('29000000-0000-4000-8000-000000000001');
	if (v_result ->> 'grantsIssued')::integer < 4 then
		raise exception 'The re-share did not re-issue the dead grants: %',v_result;
	end if;
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 4 then raise exception 'The re-share restored % tools, not 4',v_count; end if;
	if pg_temp.routing_drive_live() < 4 then
		raise exception 'The connection list does not count the re-issued grants';
	end if;
	if exists (select 1 from public.qorpera_cloud_secret_operation_grants
		where secret_id = '39800000-0000-4000-8000-000000000051' and status = 'active'
			and issued_by_user_id <> '29000000-0000-4000-8000-000000000001') then
		raise exception 'A grant of the demoted issuer is still active';
	end if;
	if (select count(*) from public.qorpera_cloud_secret_audit_events
		where secret_id = '39800000-0000-4000-8000-000000000051' and event_type = 'grant_revoked') < 4 then
		raise exception 'The re-issued grants left no revocation trail';
	end if;
	-- Sharing again with live grants issues nothing.
	if (pg_temp.routing_share('29000000-0000-4000-8000-000000000001') ->> 'grantsIssued')::integer <> 0 then
		raise exception 'A live share was re-issued';
	end if;
end
$$;

-- A hire by a contributor, after the connecting admin was demoted: the grants
-- come from a current owner, so they hold.
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('29000000-0000-4000-8000-000000000010','39800000-0000-4000-8000-000000000031','Newcomer','Support','Help customers.',
	'green','round','active','setup','openai','gpt-native',clock_timestamp(),clock_timestamp(),'29000000-0000-4000-8000-000000000002');
do $$
begin
	if (select count(*) from public.qorpera_cloud_secret_operation_grants
		where staff_agent_id = '39800000-0000-4000-8000-000000000031' and secret_id = '39800000-0000-4000-8000-000000000051'
			and status = 'active' and issued_by_user_id = '29000000-0000-4000-8000-000000000001') <> 4 then
		raise exception 'The new hire''s grants were not issued by a current owner';
	end if;
end
$$;

-- Stop sharing: every grant of the connection is revoked and new hires get nothing.
do $$
declare v_result jsonb; v_count integer;
begin
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	begin
		perform public.qorpera_unshare_cloud_connector('29000000-0000-4000-8000-000000000010',
			'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000051');
		raise exception 'A contributor stopped sharing a company connection';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	v_result := public.qorpera_unshare_cloud_connector('29000000-0000-4000-8000-000000000010',
		'29000000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000051');
	reset role;
	if (v_result ->> 'grantsRevoked')::integer < 8 or (v_result ->> 'availableToAllAgents')::boolean then
		raise exception 'Stop sharing left grants or the all-agents mark: %',v_result;
	end if;
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 0 then raise exception 'Stop sharing left % tools',v_count; end if;
	if exists (select 1 from public.qorpera_cloud_secret_operation_grants
		where secret_id = '39800000-0000-4000-8000-000000000051' and status = 'active')
		or (select available_to_all_agents from public.qorpera_cloud_secrets
			where id = '39800000-0000-4000-8000-000000000051') then
		raise exception 'Stop sharing left the connection shared';
	end if;
end
$$;
insert into public.qorpera_profile_staff(profile_id,staff_agent_id,display_name,role,charter,
	appearance_color,appearance_shape,employment_status,lifecycle_state,model_provider,model_id,created_at,updated_at,updated_by_user_id)
values ('29000000-0000-4000-8000-000000000010','39800000-0000-4000-8000-000000000032','Later','Support','Help customers.',
	'green','round','active','setup','openai','gpt-native',clock_timestamp(),clock_timestamp(),'29000000-0000-4000-8000-000000000001');
do $$
begin
	if exists (select 1 from public.qorpera_cloud_secret_operation_grants
		where staff_agent_id = '39800000-0000-4000-8000-000000000032' and secret_id = '39800000-0000-4000-8000-000000000051') then
		raise exception 'A hire after Stop sharing received the connection';
	end if;
end
$$;

rollback;
