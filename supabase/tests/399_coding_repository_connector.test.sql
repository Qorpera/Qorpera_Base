-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- Bundle v88: the coding executor reaches the repository through the company's
-- GitHub connection. The company's secret broker asks the kernel for the
-- sealed envelope of one leased coding session; the kernel answers only for a
-- live lease held by the named executor, the session's own repository, an
-- agent with a repository grant, and a company-owned GitHub connection sealed
-- by that broker on which the agent holds a live grant. Company connections are
-- always shared: the capture below shares it with every agent, and there is no
-- Stop sharing. Real dispatch, claim and capture; synthetic envelope bytes.

select pg_temp.path_claims('service_role');
select set_config('qorpera_test.parent_binding',current_setting('qorpera_test.wake_binding'),true);
create function pg_temp.todo(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_todo(current_setting('qorpera_test.parent_binding')::jsonb,p_request)
$$;
create function pg_temp.worker(p_request jsonb) returns jsonb language sql as $$
	select public.qorpera_manage_agent_worker(current_setting('qorpera_test.parent_binding')::jsonb,p_request)
$$;
create function pg_temp.worker_id() returns uuid language sql as $$
	select id from public.qorpera_runtime_workers where worker_key = 'repo-credential'
$$;
create function pg_temp.used_events() returns bigint language sql as $$
	select count(*) from public.qorpera_cloud_secret_audit_events where event_type = 'repository_credential_used'
$$;

-- 1. No member can stop sharing any more, and only the broker login may ask for
--    a repository credential.
select pg_temp.wake_assert(to_regprocedure('public.qorpera_unshare_cloud_connector(uuid,uuid,uuid)') is null,
	'Stop sharing is still callable');
select pg_temp.wake_assert(not has_table_privilege('authenticated','public.qorpera_cloud_secrets','UPDATE')
	and not has_table_privilege('anon','public.qorpera_cloud_secrets','UPDATE'),
	'A member can change a connection row directly');
do $$
declare v_role text;
begin
	foreach v_role in array array['anon','authenticated','service_role'] loop
		if has_function_privilege(v_role,
				'public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)','EXECUTE')
			or has_function_privilege(v_role,'public.qorpera_share_company_connection(uuid,uuid)','EXECUTE') then
			raise exception 'Repository credential or share helper exposed to %',v_role;
		end if;
	end loop;
	if not has_function_privilege('qorpera_secret_broker',
			'public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)','EXECUTE')
		or has_function_privilege('qorpera_secret_broker','public.qorpera_share_company_connection(uuid,uuid)','EXECUTE') then
		raise exception 'Repository credential privileges differ';
	end if;
end
$$;

-- 2. A coding session: executor, repository grant, dispatch (as in 396).
select pg_temp.wake_public_send(current_setting('qorpera_test.parent_binding')::jsonb,'progress','repo-credential-ack');
select pg_temp.todo('{"action":"upsert","operationKey":"todo-r1","todoKey":"repo-credential","title":"Fix the flaky test"}');
select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-test',true,array['codex']);
select public.qorpera_set_coding_repository_grant('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000030',
	'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}',true);
select pg_temp.worker('{"action":"dispatch","operationKey":"r1","todoKey":"repo-credential","workerKey":"repo-credential",
	"title":"Fix the flaky test","goal":"Make the composer test deterministic.","definitionOfDone":"CI is green.","access":"read",
	"species":"coding","harness":"codex","repository":{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}}');

-- 3. The company's broker, and another company's broker on the same origin.
insert into auth.users(id,email) values ('39900000-0000-4000-8000-000000000001','coding-other-owner@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('39900000-0000-4000-8000-000000000010','Other company','39900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('39900000-0000-4000-8000-000000000010','39900000-0000-4000-8000-000000000001',
	'coding-other-owner@example.test','Other owner','owner');
insert into public.qorpera_cloud_secret_broker_authorities(id,profile_id,service_origin,key_id,capability_sha256) values
	('39900000-0000-4000-8000-000000000040','30000000-0000-4000-8000-000000000010',
		'https://secrets.qorpera.test','company-kek-1',repeat('c',64)),
	('39900000-0000-4000-8000-000000000041','39900000-0000-4000-8000-000000000010',
		'https://secrets.qorpera.test','other-kek-1',repeat('e',64));

-- 4. The owner connects the company's GitHub account. Sealing it shares it with
--    every active agent in the same transaction, under the owner.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.github_capture',public.qorpera_begin_cloud_secret_capture(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','company',null,
	'github','primary','Company GitHub')::text,true);
reset role;
select set_config('qorpera_test.github_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.github_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.github_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.github_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.github_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.github_descriptor',public.qorpera_complete_cloud_secret_capture(
	'39900000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.github_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.github_capability_sha'),
	current_setting('qorpera_test.github_envelope'),current_setting('qorpera_test.github_envelope_sha'),
	'qorpera-bot')::text,true);
reset session authorization;
select set_config('qorpera_test.github_secret',current_setting('qorpera_test.github_descriptor')::jsonb->>'secretId',true);
select pg_temp.wake_assert((select available_to_all_agents from public.qorpera_cloud_secrets
	where id = current_setting('qorpera_test.github_secret')::uuid),'The captured company connection is not shared');
select pg_temp.wake_assert((select count(*) = 21 and bool_and(issued_by_user_id = '30000000-0000-4000-8000-000000000001')
	from public.qorpera_cloud_secret_operation_grants
	where secret_id = current_setting('qorpera_test.github_secret')::uuid and status = 'active'),
	'Capture did not grant all seven GitHub operations to each of the three active agents');

-- 5. The executor claims the session (preparing: it resolves and seeds the base).
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.claim',public.qorpera_claim_coding_session('exec-test',60)::text,true);
select pg_temp.wake_assert((current_setting('qorpera_test.claim')::jsonb->>'workerId')::uuid = pg_temp.worker_id(),
	'The executor did not claim the session');

create function pg_temp.credential(p_authority uuid,p_capability text,p_owner text default 'exec-test',
	p_lease uuid default null,p_repository jsonb default null,p_worker uuid default null)
returns text language plpgsql as $$
declare v_result jsonb;
begin
	v_result := public.qorpera_authorize_coding_repository_credential(p_authority,p_capability,
		coalesce(p_worker,(current_setting('qorpera_test.claim')::jsonb->>'workerId')::uuid),
		coalesce(p_lease,(current_setting('qorpera_test.claim')::jsonb->>'leaseToken')::uuid),p_owner,
		coalesce(p_repository,'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'::jsonb));
	perform set_config('qorpera_test.credential',v_result::text,true);
	return 'authorized';
exception when others then
	return sqlstate || ':' || sqlerrm;
end
$$;
grant execute on function pg_temp.credential(uuid,text,text,uuid,jsonb,uuid) to qorpera_secret_broker;
create function pg_temp.expect(p_actual text,p_expected text,p_case text)
returns void language plpgsql as $$
begin
	if p_actual is distinct from p_expected then
		raise exception '%: expected %, got %',p_case,p_expected,p_actual;
	end if;
end
$$;
create function pg_temp.own() returns text language plpgsql as $$
declare v_result text;
begin
	set local session authorization qorpera_secret_broker;
	v_result := pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64));
	reset session authorization;
	return v_result;
end
$$;

-- 6. The happy path: the envelope of the company connection, audited once.
set local session authorization qorpera_secret_broker;
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64)),'authorized','Happy path');
reset session authorization;
do $$
declare v_answer jsonb := current_setting('qorpera_test.credential')::jsonb;
begin
	if v_answer->>'schema' <> 'qorpera.coding-repository-credential-authorization/v1'
		or (v_answer->>'secretId')::uuid <> current_setting('qorpera_test.github_secret')::uuid
		or (v_answer->>'secretVersion')::integer <> 1 or v_answer->>'keyId' <> 'company-kek-1'
		or v_answer->>'connectorId' <> 'github' or v_answer->>'credentialName' <> 'access_token'
		or (v_answer->>'companyId')::uuid <> '30000000-0000-4000-8000-000000000010'
		or (v_answer->>'environmentId')::uuid <> '30000000-0000-4000-8000-000000000020'
		or (v_answer->>'workerId')::uuid <> pg_temp.worker_id()
		or v_answer->'repository' <> '{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'::jsonb
		or decode(v_answer->>'encryptedEnvelopeBase64','base64') <> decode(current_setting('qorpera_test.github_envelope'),'base64')
		or v_answer->>'envelopeSha256' <> current_setting('qorpera_test.github_envelope_sha') then
		raise exception 'The repository credential answer differs: %',v_answer;
	end if;
	if (select count(*) from public.qorpera_cloud_secret_audit_events
		where event_type = 'repository_credential_used' and coding_worker_id = pg_temp.worker_id()
			and secret_id = current_setting('qorpera_test.github_secret')::uuid and secret_version = 1
			and connector_id = 'github' and actor_user_id is null and grant_id is null) <> 1
		or pg_temp.used_events() <> 1 then
		raise exception 'The released credential was not audited exactly once';
	end if;
	perform set_config('qorpera_test.used',pg_temp.used_events()::text,true);
end
$$;

-- 7. Refusals, none of which writes an audit event.
set local session authorization qorpera_secret_broker;
-- Wrong executor, a lease this executor does not hold, another repository,
-- a malformed repository.
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64),'exec-other'),
	'42501:coding session lease is unavailable','Wrong executor owner');
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64),'exec-test',
	'39900000-0000-4000-8000-000000000099'),'42501:coding session lease is unavailable','Wrong lease token');
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64),'exec-test',null,
	'{"host":"github.com","owner":"Qorpera","name":"Other","baseBranch":"master"}'),
	'42501:coding repository differs from the session','Another repository');
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64),'exec-test',null,
	'{"host":"gitlab.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}'),
	'22023:coding repository credential request is invalid','A repository outside GitHub');
-- Another company's broker, however the request reached it; a forged capability.
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000041',repeat('e',64)),
	'42501:coding session is unavailable to this broker','Another company''s broker');
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('e',64)),
	'42501:cloud secret broker authority is unavailable','Forged broker capability');
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64),'exec-test',null,null,
	'39900000-0000-4000-8000-000000000098'),'42501:coding session is unavailable to this broker','Unknown session');
reset session authorization;
-- Anyone but the broker login.
select pg_temp.expect(pg_temp.credential('39900000-0000-4000-8000-000000000040',repeat('c',64)),
	'42501:cloud secret broker authority is required','Not the broker login');

-- The lease expired; the session is not claimed; the model turn is running.
update public.qorpera_coding_sessions set lease_until = clock_timestamp() - interval '1 second' where worker_id = pg_temp.worker_id();
select pg_temp.expect(pg_temp.own(),'42501:coding session lease is unavailable','Expired lease');
update public.qorpera_coding_sessions set lease_until = clock_timestamp() + interval '60 seconds' where worker_id = pg_temp.worker_id();
update public.qorpera_coding_sessions set phase = 'queued', lease_owner = null, lease_token = null, lease_until = null
where worker_id = pg_temp.worker_id();
select pg_temp.expect(pg_temp.own(),'42501:coding session lease is unavailable','Unclaimed session');
update public.qorpera_coding_sessions set phase = 'running', lease_owner = 'exec-test',
	lease_token = (current_setting('qorpera_test.claim')::jsonb->>'leaseToken')::uuid,
	lease_until = clock_timestamp() + interval '60 seconds'
where worker_id = pg_temp.worker_id();
select pg_temp.expect(pg_temp.own(),'42501:coding session lease is unavailable','Model turn running');
-- Publishing (push and draft PR) is served like preparing.
update public.qorpera_coding_sessions set phase = 'publishing' where worker_id = pg_temp.worker_id();
select pg_temp.expect(pg_temp.own(),'authorized','Publishing');
select set_config('qorpera_test.used',pg_temp.used_events()::text,true);

-- The executor is disabled; the agent's repository grant is withdrawn.
select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-test',false,array['codex']);
select pg_temp.expect(pg_temp.own(),'42501:coding executor is unavailable','Executor disabled');
select public.qorpera_configure_coding_executor('30000000-0000-4000-8000-000000000020','exec-test',true,array['codex']);
select public.qorpera_set_coding_repository_grant('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000030',
	'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}',false);
select pg_temp.expect(pg_temp.own(),'42501:coding repository grant is unavailable','No repository grant');
select public.qorpera_set_coding_repository_grant('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000030',
	'{"host":"github.com","owner":"Qorpera","name":"Qorpera_Base","baseBranch":"master"}',true);
select pg_temp.expect(pg_temp.own(),'authorized','Repository grant restored');

-- The agent's grants on the connection are revoked (one by one; there is no
-- Stop sharing): refused. The owner's share call repairs exactly the missing
-- grants and the agent is served again.
select set_config('qorpera_test.agent_grants',(select jsonb_agg(id)::text from public.qorpera_cloud_secret_operation_grants
	where secret_id = current_setting('qorpera_test.github_secret')::uuid
		and staff_agent_id = '30000000-0000-4000-8000-000000000030' and status = 'active'),true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare v_grant text;
begin
	for v_grant in select jsonb_array_elements_text(current_setting('qorpera_test.agent_grants')::jsonb) loop
		perform public.qorpera_revoke_cloud_secret_grant('30000000-0000-4000-8000-000000000010',v_grant::uuid);
	end loop;
end
$$;
reset role;
select pg_temp.expect(pg_temp.own(),'42501:company GitHub connection is unavailable to this agent','Revoked grants');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.repair',public.qorpera_grant_cloud_connector('30000000-0000-4000-8000-000000000010',
	'30000000-0000-4000-8000-000000000020',current_setting('qorpera_test.github_secret')::uuid)::text,true);
reset role;
select pg_temp.wake_assert((current_setting('qorpera_test.repair')::jsonb->>'grantsIssued')::integer = 7,
	'The share call did not repair exactly the seven revoked grants');
select pg_temp.expect(pg_temp.own(),'authorized','Repaired grants');

-- Disconnecting the connection revokes it with every grant: refused.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_cloud_secret('30000000-0000-4000-8000-000000000010',
	current_setting('qorpera_test.github_secret')::uuid);
reset role;
select pg_temp.expect(pg_temp.own(),'42501:company GitHub connection is unavailable to this agent','Disconnected connection');

-- A member's own GitHub secret never serves a coding session, even with a grant
-- row for the agent: repository access is the company's.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.personal_capture',public.qorpera_begin_cloud_secret_capture(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020','member',
	'30000000-0000-4000-8000-000000000001','github','primary','My GitHub')::text,true);
reset role;
select set_config('qorpera_test.personal_capability_sha',encode(extensions.digest(
	current_setting('qorpera_test.personal_capture')::jsonb->>'captureCapability','sha256'),'hex'),true);
select set_config('qorpera_test.personal_envelope',encode(extensions.gen_random_bytes(256),'base64'),true);
select set_config('qorpera_test.personal_envelope_sha',encode(extensions.digest(
	decode(current_setting('qorpera_test.personal_envelope'),'base64'),'sha256'),'hex'),true);
set local session authorization qorpera_secret_broker;
select set_config('qorpera_test.personal_descriptor',public.qorpera_complete_cloud_secret_capture(
	'39900000-0000-4000-8000-000000000040',repeat('c',64),
	(current_setting('qorpera_test.personal_capture')::jsonb->>'ticketId')::uuid,
	current_setting('qorpera_test.personal_capability_sha'),
	current_setting('qorpera_test.personal_envelope'),current_setting('qorpera_test.personal_envelope_sha'),
	'my-login')::text,true);
reset session authorization;
select pg_temp.wake_assert(not exists (select 1 from public.qorpera_cloud_secret_operation_grants
	where secret_id = (current_setting('qorpera_test.personal_descriptor')::jsonb->>'secretId')::uuid)
	and not (select available_to_all_agents from public.qorpera_cloud_secrets
		where id = (current_setting('qorpera_test.personal_descriptor')::jsonb->>'secretId')::uuid),
	'A member''s own secret was shared on capture');
insert into public.qorpera_cloud_secret_operation_grants(profile_id,environment_id,secret_id,staff_agent_id,
	connector_id,operation_id,operation_version,tool_name,issued_by_user_id)
select '30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000020',
	(current_setting('qorpera_test.personal_descriptor')::jsonb->>'secretId')::uuid,'30000000-0000-4000-8000-000000000030',
	operation.connector_id,operation.operation_id,operation.version,operation.tool_name,'30000000-0000-4000-8000-000000000001'
from public.qorpera_cloud_connector_operations as operation
where operation.connector_id = 'github' and operation.operation_id = 'list_repositories' and operation.status = 'active';
select pg_temp.expect(pg_temp.own(),'42501:company GitHub connection is unavailable to this agent','Member-owned secret only');

-- Every release was audited once; no refusal was.
select pg_temp.wake_assert(pg_temp.used_events() = 4
	and (select count(distinct coding_worker_id) = 1 from public.qorpera_cloud_secret_audit_events
		where event_type = 'repository_credential_used'),
	'Repository credential audit differs from the four releases');

-- 8. Health receipt retention (bundle v88): each observation prunes its node's
--    receipts observed more than seven days ago, at most 500 per call. Recent
--    receipts, other nodes' receipts and every latest row stay.
insert into public.qorpera_runtime_nodes(id,machine_id_sha256,label,version,cpu_millis,memory_bytes,
	headroom_cpu_millis,headroom_memory_bytes,standard_cpu_millis,standard_memory_bytes,enabled)
values ('39900000-0000-4000-8000-000000000501',repeat('1',64),'retention-a',1,8000,8589934592,1000,1073741824,1000,1073741824,true),
	('39900000-0000-4000-8000-000000000502',repeat('2',64),'retention-b',1,8000,8589934592,1000,1073741824,1000,1073741824,true);
insert into public.qorpera_runtime_node_inventory_policies(node_id,policy,policy_sha256)
select node.id,'{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb,
	encode(extensions.digest(('{"schema":"qorpera.runtime-node-inventory-policy/v1"}'::jsonb)::text,'sha256'),'hex')
from public.qorpera_runtime_nodes as node
where node.id in ('39900000-0000-4000-8000-000000000501','39900000-0000-4000-8000-000000000502');
create function pg_temp.health(p_node uuid,p_at timestamptz) returns jsonb language sql as $$
	select jsonb_build_object('schema','qorpera.runtime-node-health/v1','nodeId',p_node,
		'machineIdSha256',(select machine_id_sha256 from public.qorpera_runtime_nodes where id = p_node),
		'policySha256',(select policy_sha256 from public.qorpera_runtime_node_inventory_policies where node_id = p_node),
		'observerPackageSha256',null,'bootId',null,'observationId',extensions.gen_random_uuid(),
		'observedAt',to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'cpu',null,'memory',null,'rootFilesystem',null,'network',null,'errors',jsonb_build_array('COLLECTION_UNCONFIRMED'))
$$;
create function pg_temp.stored_health(p_node uuid,p_age interval,p_count integer) returns void language sql as $$
	insert into public.qorpera_runtime_node_health_receipts(node_id,observation_id,observed_at,observation)
	select p_node,(h->>'observationId')::uuid,(h->>'observedAt')::timestamptz,h
	from generate_series(1,p_count) as g,
		lateral (select pg_temp.health(p_node,date_trunc('milliseconds',clock_timestamp()) - p_age - make_interval(secs => g)) as h) as made
$$;
create function pg_temp.receipts(p_node uuid,p_old boolean) returns bigint language sql as $$
	select count(*) from public.qorpera_runtime_node_health_receipts
	where node_id = p_node and (observed_at < clock_timestamp() - interval '7 days') = p_old
$$;
-- Node A: 600 receipts from eight days ago and 3 from yesterday. Node B: 5 from
-- eight days ago, the oldest of which its latest row still names.
select pg_temp.stored_health('39900000-0000-4000-8000-000000000501',interval '8 days',600);
select pg_temp.stored_health('39900000-0000-4000-8000-000000000501',interval '1 day',3);
select pg_temp.stored_health('39900000-0000-4000-8000-000000000502',interval '8 days',5);
insert into public.qorpera_runtime_node_health_latest(node_id,observation_id,observed_at)
select node_id,observation_id,observed_at from public.qorpera_runtime_node_health_receipts
where node_id = '39900000-0000-4000-8000-000000000502' order by observed_at limit 1;
select pg_temp.path_claims('service_role');
select set_config('qorpera_test.health_first',public.qorpera_observe_runtime_node_health(
	pg_temp.health('39900000-0000-4000-8000-000000000501',date_trunc('milliseconds',clock_timestamp())))::text,true);
select pg_temp.wake_assert(pg_temp.receipts('39900000-0000-4000-8000-000000000501',true) = 100
	and pg_temp.receipts('39900000-0000-4000-8000-000000000501',false) = 4,
	'One observation did not prune exactly 500 old receipts and keep the recent ones');
select pg_temp.wake_assert(pg_temp.receipts('39900000-0000-4000-8000-000000000502',true) = 5
	and (select observed_at < clock_timestamp() - interval '7 days' from public.qorpera_runtime_node_health_latest
		where node_id = '39900000-0000-4000-8000-000000000502'),
	'Another node''s receipts or latest row were touched');
select set_config('qorpera_test.health_second',public.qorpera_observe_runtime_node_health(
	pg_temp.health('39900000-0000-4000-8000-000000000501',date_trunc('milliseconds',clock_timestamp())))::text,true);
select pg_temp.wake_assert(pg_temp.receipts('39900000-0000-4000-8000-000000000501',true) = 0
	and pg_temp.receipts('39900000-0000-4000-8000-000000000501',false) = 5,
	'The second observation did not finish pruning or dropped a recent receipt');
select pg_temp.wake_assert((select observation_id = (current_setting('qorpera_test.health_second')::jsonb->>'observationId')::uuid
	from public.qorpera_runtime_node_health_latest where node_id = '39900000-0000-4000-8000-000000000501'),
	'The latest row does not name the newest observation');
-- A replay of a kept observation still answers with its original receipt.
select pg_temp.wake_assert(public.qorpera_observe_runtime_node_health((select observation
	from public.qorpera_runtime_node_health_receipts
	where observation_id = (current_setting('qorpera_test.health_first')::jsonb->>'observationId')::uuid))
	= current_setting('qorpera_test.health_first')::jsonb,'A kept receipt no longer replays');

rollback;
