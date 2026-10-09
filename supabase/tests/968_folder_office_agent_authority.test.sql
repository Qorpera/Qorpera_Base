-- @fixture 405_runtime_office_browser_idle_lease_reap.test.sql until "-- The office checks start here"
-- The agent's authority on a folder-v2 company's Company Computer (ported from snapshot-v1 in the legacy sweep), on 405's
-- office fixture (924's company; Alice's live run holds a native screen lease). Real native, office and member RPCs; only
-- physical readiness, an idle second desktop and the guest's drain acknowledgements are synthetic.
-- 1. The owner revokes Alice: her lease no longer checks, renews or keeps the shared surface; release still works.
-- 2. After that revocation the provider's check of Alice's start refuses: the grant it names is gone.
-- 3. Her grants gate her operations: the browser grant (stale, retired) and the desktop and shell capabilities.
-- 4. A member's private sign-in drains every agent screen; the agent stays off until each drain and the exit are acknowledged.
-- 5. A member removed and re-added cannot resume the private sign-in they started.
-- 6. The closed action schema: smuggled fields, a file URL and script evaluation are invalid and refused.

create function pg_temp.aa_office() returns uuid language sql as $$
	select (current_setting('qorpera_test.binding')::jsonb->>'companyComputerId')::uuid
$$;
create function pg_temp.aa_envelope(p_args jsonb) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
		'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb)->'identity')
			-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
		'operation',jsonb_build_object('tool','computer_'||(p_args->>'kind'),'toolVersion','qorpera.company-computer-tools/v2',
			'logicalOperationKey','aa','requiresCompanyRevision',false,'arguments',p_args,
			'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
				'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)->'resources')))::text
$$;
-- An operation under the current lease, on a fresh envelope for the action or else the saved one ('begin' and 'check'
-- with the saved receipt).
create function pg_temp.aa_op(p_action text,p_args jsonb default null) returns jsonb language sql as $$
	select public.qorpera_native_office_operation(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,
		case when p_args is null then current_setting('qorpera_test.aa_envelope') else pg_temp.aa_envelope(p_args) end,p_action,
		case when p_action<>'authorize' then current_setting('qorpera_test.aa_receipt')::uuid end,
		case when p_action<>'authorize' then repeat('e',64) end)
$$;
create function pg_temp.aa_browser(p_grant jsonb) returns jsonb language sql as $$
	select public.qorpera_native_office_browser_grant(current_setting('qorpera_test.base_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,current_setting('qorpera_test.office_lease')::jsonb,p_grant)
$$;
create function pg_temp.aa_ack(p_drains jsonb) returns void language plpgsql as $$
begin
	perform public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,(d#>>'{binding,screenId}')::uuid,
		(d#>>'{binding,computerGeneration}')::bigint,(d#>>'{binding,screenGeneration}')::bigint,(d->>'epoch')::bigint,(d->>'drainId')::uuid)
	from jsonb_array_elements(p_drains) d;
end $$;
-- The contributor (…002) enters or leaves a private sign-in on Alice's screen (screen-lifecycle cases L72–74); the
-- claims stay theirs.
create function pg_temp.aa_privacy(p_private boolean) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
	if p_private then perform public.qorpera_register_runtime_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,
		'96800000-0000-4000-8000-000000000071'); end if;
	return public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
		'96800000-0000-4000-8000-000000000071',(current_setting('qorpera_test.binding')::jsonb->>'screenId')::uuid,
		(select privacy_version from public.qorpera_runtime_offices where id=pg_temp.aa_office()),p_private);
end $$;
create function pg_temp.aa_start_check() returns jsonb language sql as $$
	select public.qorpera_check_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint,'96800000-0000-4000-8000-0000000000d1',
		'96800000-0000-4000-8000-0000000000a9',repeat('c',64),repeat('d',64),'96800000-0000-4000-8000-0000000000b0',repeat('f',64))
$$;
-- The owner sets Alice's access to the computer; the claims return to the service role.
create function pg_temp.aa_access(p_version bigint,p_enabled boolean,p_caps jsonb default '["desktop","shell"]') returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
	perform public.qorpera_configure_runtime_office_access(current_setting('qorpera_test.office_scope')::jsonb,
		'92400000-0000-4000-8000-000000000030',p_version,p_enabled,p_caps);
	perform pg_temp.base_claims('service_role');
end $$;
-- Alice's run acknowledges first, as a member's wake requires before any tool (405 §2).
set local role service_role;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb,'progress','aa-ack') is not null;
reset role;

-- 1. The owner revokes Alice's access: check, the shared surface and renew refuse; release still works (registry L77–88).
savepoint aa_revoke;
select pg_temp.aa_access(1,false);
set local role service_role;
select pg_temp.base_error($q$select pg_temp.ob_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.binding')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select pg_temp.ob_call('renew',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.base_assert(pg_temp.ob_call('release',current_setting('qorpera_test.office_lease')::jsonb)='{"state":"released"}','release after revocation');
reset role;
rollback to savepoint aa_revoke;

-- 2. Alice's reserved start (an intent as her computer_start leaves it, as 893 §C) checks; once the owner revokes her, the
--    provider's check refuses (start cases L188–201). The office is back in provisioning (synthetic).
savepoint aa_start;
update public.qorpera_runtime_offices set state='provisioning' where id=pg_temp.aa_office();
set local role service_role;
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,
	'96800000-0000-4000-8000-0000000000e1','computer_start:aa',repeat('0',64),repeat('d',64),false) is not null;
reset role;
set session_replication_role = replica;
insert into public.qorpera_runtime_office_start_intents(id,office_id,computer_generation,state,requested_by_staff_agent_id,grant_id,grant_version,receipt_id)
select '96800000-0000-4000-8000-0000000000d1',office.id,office.generation,'requested',access.staff_agent_id,access.grant_id,access.version,
	'96800000-0000-4000-8000-0000000000e1'
from public.qorpera_runtime_offices office join public.qorpera_runtime_office_access access on access.office_id=office.id
	and access.staff_agent_id='92400000-0000-4000-8000-000000000030' where office.id=pg_temp.aa_office();
set session_replication_role = origin;
set local role service_role;
select public.qorpera_set_runtime_office_provider(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint,'96800000-0000-4000-8000-0000000000b0',repeat('f',64),0,true) is not null;
select pg_temp.base_assert(public.qorpera_reserve_runtime_office_start(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint,'96800000-0000-4000-8000-0000000000d1',
	'96800000-0000-4000-8000-0000000000a9',repeat('c',64),repeat('a',64),repeat('b',64),repeat('d',64),
	'96800000-0000-4000-8000-0000000000b0',repeat('f',64))->>'state'='reserved','the provider reserves Alice''s start');
select pg_temp.base_assert(pg_temp.aa_start_check()->>'state'='authorized','the provider may start Alice''s reserved intent');
reset role;
select pg_temp.aa_access(1,false);
set local role service_role;
select pg_temp.base_error('select pg_temp.aa_start_check()','42501','Office start grant unavailable');
reset role;
rollback to savepoint aa_start;

-- 3. Alice's grants gate her operations (desktop L143–175; browser-privacy L235, L303–304): the owner narrows her to the
--    desktop (a browser action, the browser screenshot and shell refuse once the company browser grant is retired, as are a
--    stale browser grant and that grant's check and snapshot in flight), disables her, then narrows her to shell.
savepoint aa_grants;
select pg_temp.aa_access(1,true,'["desktop"]');
set local role service_role;
select pg_temp.ob_call('release',current_setting('qorpera_test.office_lease')::jsonb) is not null;
select set_config('qorpera_test.office_lease',(pg_temp.ob_call('acquire')->'lease')::text,true);
select set_config('qorpera_test.aa_grant',(select jsonb_build_object('profileId',r->'browserProfileId','grantId',r->'browserGrantId',
	'version',r->'browserGrantVersion') from (select public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)->'resources' r) d)::text,true);
select pg_temp.base_assert(pg_temp.aa_browser(current_setting('qorpera_test.aa_grant')::jsonb)->>'state'='authorized','the company browser grant is current');
select pg_temp.base_error($q$select pg_temp.aa_browser(jsonb_set(current_setting('qorpera_test.aa_grant')::jsonb,'{version}','99'))$q$,'42501');
select set_config('qorpera_test.aa_envelope',pg_temp.aa_envelope('{"kind":"browser","action":"snapshot"}'),true);
select set_config('qorpera_test.aa_receipt',extensions.gen_random_uuid()::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.base_binding')::jsonb,current_setting('qorpera_test.aa_receipt')::uuid,
	'computer_browser:aa',encode(extensions.digest(current_setting('qorpera_test.aa_envelope'),'sha256'),'hex'),repeat('e',64),false) is not null;
select pg_temp.base_assert(pg_temp.aa_op('begin')->>'state'='admitted','a browser snapshot is in flight');
reset role;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
select set_config('qorpera_test.aa_retired',public.qorpera_set_runtime_browser_grant(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.aa_grant')::jsonb->>'profileId')::uuid,'92400000-0000-4000-8000-000000000030',1,1,false)::text,true);
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.aa_browser(current_setting('qorpera_test.aa_grant')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select pg_temp.aa_op('check')$q$,'42501');
select pg_temp.aa_ack(current_setting('qorpera_test.aa_retired')::jsonb->'drains');
select set_config('qorpera_test.office_lease',(pg_temp.ob_call('acquire')->'lease')::text,true);
select pg_temp.base_assert(pg_temp.aa_op('authorize','{"kind":"screenshot","surface":"desktop"}')->>'state'='authorized','desktop under a desktop grant');
select pg_temp.base_error(format('select pg_temp.aa_op(%L,%L)','authorize',a),'42501') from jsonb_array_elements(
	'[{"kind":"browser","action":"snapshot"},{"kind":"screenshot","surface":"browser"},{"kind":"shell","command":"true","timeoutMs":1000}]') a;
reset role;
-- Access disabled: the desktop refuses too.
savepoint aa_disabled;
select pg_temp.aa_access(2,false,'["desktop"]');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.aa_op('authorize','{"kind":"screenshot","surface":"desktop"}')$q$,'42501');
reset role;
rollback to savepoint aa_disabled;
-- Narrowed to shell: the issued lease is void; under a fresh one shell is allowed, the desktop and its screenshot refuse.
select pg_temp.aa_access(2,true,'["shell"]');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.ob_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.ob_call('release',current_setting('qorpera_test.office_lease')::jsonb) is not null;
select set_config('qorpera_test.office_lease',(pg_temp.ob_call('acquire')->'lease')::text,true);
select pg_temp.base_assert(pg_temp.aa_op('authorize','{"kind":"shell","command":"true","timeoutMs":1000}')->>'state'='authorized','shell under a shell grant');
select pg_temp.base_error(format('select pg_temp.aa_op(%L,%L)','authorize',a),'42501') from jsonb_array_elements(
	'[{"kind":"desktop","action":"press","key":"Enter"},{"kind":"screenshot","surface":"desktop"}]') a;
reset role;
rollback to savepoint aa_grants;

-- 4. A member's private sign-in (desktop L164–166; browser-privacy L116–138, L204–215): a newer privacy version alone voids
--    an operation under the old lease; the sign-in drains every agent screen (Bob's idle one too), and until each drain
--    and then the exit are acknowledged the agent's lease, acquire, descriptor and shared surface refuse.
savepoint aa_private;
set local role service_role;
select set_config('qorpera_test.aa_envelope',pg_temp.aa_envelope('{"kind":"screenshot","surface":"desktop"}'),true);
select pg_temp.base_assert(pg_temp.aa_op('authorize')->>'state'='authorized','a desktop screenshot before the bump');
reset role;
update public.qorpera_runtime_offices set privacy_version=privacy_version+1 where id=pg_temp.aa_office();
set local role service_role;
select pg_temp.base_error($q$select pg_temp.aa_op('authorize')$q$,'42501');
reset role;
rollback to savepoint aa_private;
insert into public.qorpera_runtime_office_screens(office_id,ordinal,staff_agent_id,generation,power)
values(pg_temp.aa_office(),2,'92400000-0000-4000-8000-000000000031',1,'open');
select set_config('qorpera_test.aa_privacy',pg_temp.aa_privacy(true)::text,true);
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select pg_temp.ob_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select pg_temp.ob_call('acquire')$q$,'42501');
select pg_temp.base_assert(public.qorpera_native_office_descriptor(current_setting('qorpera_test.base_binding')::jsonb)='{"state":"unavailable"}','no agent descriptor during the sign-in');
select pg_temp.base_assert(jsonb_array_length(current_setting('qorpera_test.aa_privacy')::jsonb->'drains')=2,'the sign-in drains the idle desktop too');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.binding')::jsonb)$q$,'42501');
select pg_temp.aa_ack(jsonb_build_array(current_setting('qorpera_test.aa_privacy')::jsonb#>'{drains,0}'));
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
select pg_temp.aa_ack(current_setting('qorpera_test.aa_privacy')::jsonb->'drains');
select pg_temp.base_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.aa_privacy')::jsonb)->>'state'='private','private after every drain');
select pg_temp.base_assert(public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.aa_privacy')::jsonb)->>'state'='authorized','the private surface opens');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.binding')::jsonb)$q$,'42501');
reset role;
select set_config('qorpera_test.aa_exit',pg_temp.aa_privacy(false)::text,true);
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.aa_exit')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select pg_temp.ob_call('acquire')$q$,'42501');
select pg_temp.aa_ack(current_setting('qorpera_test.aa_exit')::jsonb->'drains');
select pg_temp.base_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.aa_exit')::jsonb)->>'state'='shared','shared after the exit');
select pg_temp.base_assert(pg_temp.ob_call('acquire')->>'state'='admitted','the agent returns once the exit is acknowledged');
reset role;
rollback to savepoint aa_private;

-- 5. A member removed and re-added (the membership deleted with its triggers on) cannot resume the private sign-in they
--    started: private access, the private surface and its acknowledgement refuse (browser-privacy L390–402).
savepoint aa_rejoin;
select set_config('qorpera_test.aa_privacy',pg_temp.aa_privacy(true)::text,true);
select pg_temp.base_claims('service_role');
select pg_temp.aa_ack(current_setting('qorpera_test.aa_privacy')::jsonb->'drains');
select pg_temp.base_assert(public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.aa_privacy')::jsonb)->>'state'='private','the member signs in privately');
select pg_temp.base_assert(public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.aa_privacy')::jsonb)->>'state'='authorized','their private surface opens');
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000002');
select pg_temp.base_assert(public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.aa_privacy')::jsonb)->>'state'='authorized','the member may type');
delete from public.qorpera_profile_members where profile_id='92400000-0000-4000-8000-000000000010' and user_id='92400000-0000-4000-8000-000000000002';
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values('92400000-0000-4000-8000-000000000010','92400000-0000-4000-8000-000000000002','base-member@example.test','Member','contributor');
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_private_access(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
select pg_temp.base_claims('service_role');
set local role service_role;
select pg_temp.base_error($q$select public.qorpera_check_runtime_office_private_surface(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
select pg_temp.base_error($q$select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.aa_privacy')::jsonb)$q$,'42501');
reset role;
rollback to savepoint aa_rejoin;

-- 6. The closed action schema: a shell field, another display, a screenshot path, a file URL and script evaluation are
--    invalid actions, and the operation refuses each (desktop L19–21; browser-privacy L276, L278).
select set_config('qorpera_test.aa_bad','[{"kind":"desktop","action":"press","key":"Enter","shell":"bad"},
	{"kind":"desktop","action":"move","x":0,"y":0,"display":":2"},{"kind":"screenshot","surface":"desktop","path":"/private"},
	{"kind":"browser","action":"navigate","url":"file:///etc/passwd"},{"kind":"browser","action":"snapshot","evaluate":"steal()"}]',true);
select pg_temp.base_assert(public.qorpera_valid_office_desktop_action('{"kind":"desktop","action":"press","key":"Enter"}')
	and public.qorpera_valid_office_browser_action('{"kind":"browser","action":"snapshot"}'),'the validators admit sound actions');
select pg_temp.base_assert(not case when a->>'kind'='browser' then public.qorpera_valid_office_browser_action(a)
	else public.qorpera_valid_office_desktop_action(a) end,'invalid action: '||a::text) from jsonb_array_elements(current_setting('qorpera_test.aa_bad')::jsonb) a;
set local role service_role;
select pg_temp.base_assert(pg_temp.aa_op('authorize','{"kind":"desktop","action":"press","key":"Enter"}')->>'state'='authorized','a sound action is authorized');
select pg_temp.base_error(format('select pg_temp.aa_op(%L,%L)','authorize',a),'42501') from jsonb_array_elements(current_setting('qorpera_test.aa_bad')::jsonb) a;
reset role;

rollback;
