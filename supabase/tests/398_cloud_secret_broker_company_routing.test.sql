-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Runtime Step 7 (bundle v87) on a folder-v2 company (ported from snapshot-v1 in the legacy sweep): a connection's
-- grants hold only through a current owner or admin. On 924's folder-v2 company, with Alice's real run (claim, runner,
-- assignment and native lease); the secret rows stand in for completed captures.
-- 1. The run's own broker, with a live grant and a sealed version, still gets no effect without a begun effect receipt,
--    and nothing is audited as authorized. (Another company's broker on the same origin is refused in 806 §3.)
-- 2. The admin shares a company Google Drive connection; demoting that admin (folder-v2's member role change) kills the
--    grants: the run loses the Drive tools and the connection list counts no live grant. The owner's re-share re-issues
--    them under the owner, with a revocation trail; a second share issues nothing.
-- 3. A contributor's hire, after the admin's demotion, receives the shared connection through grants issued by the owner.

insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('39800000-0000-4000-8000-000000000040','92400000-0000-4000-8000-000000000010',
		'https://company41-node-01.tailbb15c7.ts.net:10000','company-kek-1',repeat('c',64));
-- The run's company holds a company-owned Gmail connection, sealed by its own broker, granted to the run's agent (Alice)
-- by the owner.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('39800000-0000-4000-8000-000000000050','92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000040','company',null,
	'gmail','primary','Gmail account',1,'92400000-0000-4000-8000-000000000001');
-- Its sealed version, so the begun receipt is the only thing the call lacks.
insert into public.qorpera_cloud_secret_versions(secret_id,version,broker_authority_id,key_id,encrypted_envelope,
	envelope_sha256,created_by_user_id)
values ('39800000-0000-4000-8000-000000000050',1,'39800000-0000-4000-8000-000000000040','company-kek-1','\x0102',
	encode(extensions.digest('\x0102'::bytea,'sha256'),'hex'),'92400000-0000-4000-8000-000000000001');
insert into public.qorpera_cloud_secret_operation_grants(id,profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '39800000-0000-4000-8000-000000000060','92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000050',
	'92400000-0000-4000-8000-000000000030',operation.connector_id,operation.operation_id,operation.version,
	operation.tool_name,'92400000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations as operation
where operation.connector_id = 'gmail' and operation.operation_id = 'search_messages' and operation.status = 'active';
select set_config('qorpera_test.routing_adapter',(select adapter_sha256 from public.qorpera_cloud_connector_operations
	where connector_id = 'gmail' and operation_id = 'search_messages' and status = 'active'),true);

-- The run acknowledges its wake, as every run does before connector work.
select pg_temp.base_claims('service_role');
set local role service_role;
do $$
begin
	perform pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','routing-ack');
end $$;
reset role;

create function pg_temp.routing_authorize(p_authority uuid,p_capability text)
returns text language plpgsql as $$
begin
	perform public.qorpera_authorize_cloud_secret_operation(p_authority,p_capability,
		current_setting('qorpera_test.base_binding')::jsonb,'39800000-0000-4000-8000-000000000070',
		repeat('a',64),repeat('b',64),'39800000-0000-4000-8000-000000000060','gmail','search_messages',1,
		current_setting('qorpera_test.routing_adapter'),'https://gmail.googleapis.com');
	return 'authorized';
exception when others then
	return sqlstate || ':' || sqlerrm;
end
$$;
grant execute on function pg_temp.routing_authorize(uuid,text) to qorpera_secret_broker;

-- 1. The run's own broker, with no effect receipt begun.
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.routing_own',
	pg_temp.routing_authorize('39800000-0000-4000-8000-000000000040',repeat('c',64)),true);
reset session authorization;

do $$
begin
	-- The run's own broker passes the grant, ownership and operation checks and stops at the effect receipt the run never
	-- began (the grant and the version exist, so only the receipt lookup finds no row).
	if current_setting('qorpera_test.routing_own') <> 'P0002:query returned no rows' then
		raise exception 'The run''s own broker did not reach the receipt check: %',current_setting('qorpera_test.routing_own');
	end if;
	if exists (select 1 from public.qorpera_cloud_secret_audit_events
		where secret_id = '39800000-0000-4000-8000-000000000050' and event_type = 'effect_authorized') then
		raise exception 'A refused operation was audited as authorized';
	end if;
end
$$;

-- 2. Grants outlive their issuer only through a re-share. The admin (…004) shares a company Google Drive connection;
-- demoting that admin kills the grants (the kernel rechecks the issuer at every call); the owner's re-share re-issues
-- them under the owner.
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
	connector_id,secret_name,purpose,current_version,created_by_user_id)
values ('39800000-0000-4000-8000-000000000051','92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000040','company',null,
	'google_drive','primary','Google Drive account',1,'92400000-0000-4000-8000-000000000004');

create function pg_temp.routing_drive_tools()
returns integer language plpgsql as $$
declare v_count integer;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	select count(*) into v_count
	from jsonb_array_elements(public.qorpera_list_native_connector_tools(current_setting('qorpera_test.base_binding')::jsonb))
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
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	select (item ->> 'activeGrantCount')::integer into v_count
	from jsonb_array_elements(public.qorpera_list_cloud_secret_connections(
		'92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000020')) as item
	where item ->> 'secretId' = '39800000-0000-4000-8000-000000000051';
	reset role;
	return v_count;
end
$$;
create function pg_temp.routing_share(p_user uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated',p_user);
	set local role authenticated;
	v_result := public.qorpera_grant_cloud_connector('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020','39800000-0000-4000-8000-000000000051');
	reset role;
	return v_result;
end
$$;
-- The owner demotes the admin to contributor, as the members page does (850 §D).
create function pg_temp.routing_demote()
returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_update_profile_member_role('92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000004','contributor');
	reset role;
end
$$;

do $$
declare v_result jsonb; v_count integer;
begin
	v_result := pg_temp.routing_share('92400000-0000-4000-8000-000000000004');
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 4 then raise exception 'The shared Drive connection gave % tools, not 4',v_count; end if;
	-- The admin who shared it is demoted: the grants no longer hold.
	perform pg_temp.routing_demote();
	v_count := pg_temp.routing_drive_tools();
	if v_count <> 0 then raise exception 'A demoted issuer''s grants still gave % tools',v_count; end if;
	-- The page counts live grants only, so the dead share reads as not shared.
	if pg_temp.routing_drive_live() <> 0 then
		raise exception 'The connection list still counts the demoted issuer''s grants';
	end if;
	-- The owner shares it again: the dead grants are re-issued.
	v_result := pg_temp.routing_share('92400000-0000-4000-8000-000000000001');
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
			and issued_by_user_id <> '92400000-0000-4000-8000-000000000001') then
		raise exception 'A grant of the demoted issuer is still active';
	end if;
	if (select count(*) from public.qorpera_cloud_secret_audit_events
		where secret_id = '39800000-0000-4000-8000-000000000051' and event_type = 'grant_revoked') < 4 then
		raise exception 'The re-issued grants left no revocation trail';
	end if;
	-- Sharing again with live grants issues nothing.
	if (pg_temp.routing_share('92400000-0000-4000-8000-000000000001') ->> 'grantsIssued')::integer <> 0 then
		raise exception 'A live share was re-issued';
	end if;
end
$$;

-- 3. A hire by the contributor (…002) through its agent.md commit, after the connecting admin was demoted: the follow-up
-- queue gives it the shared connection through grants from a current owner, so they hold.
select pg_temp.base_claims('service_role');
select pg_temp.base_commit('{"kind":"member","userId":"92400000-0000-4000-8000-000000000002"}','routing-hire',
	jsonb_build_array(pg_temp.base_hire('newcomer','39800000-0000-4000-8000-000000000031','Newcomer'))) \g /dev/null
do $$
begin
	if (select count(*) from public.qorpera_cloud_secret_operation_grants
		where staff_agent_id = '39800000-0000-4000-8000-000000000031' and secret_id = '39800000-0000-4000-8000-000000000051'
			and status = 'active' and issued_by_user_id = '92400000-0000-4000-8000-000000000001') <> 4 then
		raise exception 'The new hire''s grants were not issued by a current owner';
	end if;
end
$$;

rollback;
