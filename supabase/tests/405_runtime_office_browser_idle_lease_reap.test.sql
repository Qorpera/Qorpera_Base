-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- 20260927100000: the company computer keeps running between runs.
-- 1. A browser check with nobody entitled present answers 'idle' with the grant
--    (the browser stays open, its egress relay carries no traffic) instead of
--    closing the browser; opens, member-prepared profiles and takeovers still
--    refuse, and presence still answers 'authorized'.
-- 2. The supervisor status reaps a screen lease that expired at least 30
--    seconds ago without a release, exactly as its release would: a drain
--    challenge first when agent work is unresolved, then the lease is cleared.
-- Real native authority and office RPCs; only guest readiness is synthetic, as
-- in fixtures/runtime-office-registry-cases.sql.

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.office',public.qorpera_register_runtime_office(
	'30000000-0000-4000-8000-000000000020','34000000-0000-4000-8000-000000000001',repeat('a',64),repeat('b',64),2)::text,true);
select set_config('qorpera_test.office_scope',(current_setting('qorpera_test.office')::jsonb-'state')::text,true);
reset role;
create function pg_temp.office_call(p_action text,p_lease jsonb default null)
returns jsonb language sql as $$
	select public.qorpera_native_office_screen(current_setting('qorpera_test.wake_binding')::jsonb,
		current_setting('qorpera_test.office_scope')::jsonb,p_action,p_lease)
$$;
-- Synthetic guest readiness only. This is not a provider or Linux test.
update public.qorpera_runtime_offices set state='active'
where id=(current_setting('qorpera_test.office')::jsonb->>'companyComputerId')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select set_config('qorpera_test.binding',(current_setting('qorpera_test.office_lease')::jsonb->'binding')::text,true);
reset role;

create function pg_temp.browser(p_opener text default null) returns jsonb language sql as $$
	select public.qorpera_office_screen_browser_grant(current_setting('qorpera_test.binding')::jsonb,p_opener)
$$;
create function pg_temp.screen() returns public.qorpera_runtime_office_screens language sql as $$
	select * from public.qorpera_runtime_office_screens where id=(current_setting('qorpera_test.binding')::jsonb->>'screenId')::uuid
$$;
create function pg_temp.age_presence() returns void language sql as $$
	update public.qorpera_runtime_office_browser_presence set present_at=present_at-interval '61 seconds'
$$;
create function pg_temp.ack(p_drain jsonb) returns jsonb language sql as $$
	select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.binding')::jsonb->>'screenId')::uuid,
		(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint,
		(current_setting('qorpera_test.binding')::jsonb->>'screenGeneration')::bigint,
		(p_drain->>'epoch')::bigint,(p_drain->>'drainId')::uuid)
$$;

-- 1. The browser between runs.
set local role service_role;
select set_config('qorpera_test.present',pg_temp.browser()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.present')::jsonb->>'state'='authorized'
	and current_setting('qorpera_test.present')::jsonb ? 'grant','the agent lease is presence: authorized');
select pg_temp.office_call('release',current_setting('qorpera_test.office_lease')::jsonb);
select pg_temp.wake_assert(pg_temp.browser()->>'state'='authorized','a check within the minute after the run is still tolerated');
reset role;
select pg_temp.age_presence();
set local role service_role;
select pg_temp.wake_assert(pg_temp.browser()=jsonb_build_object('state','idle','grant',current_setting('qorpera_test.present')::jsonb->'grant','validForMs',5000),
	'nobody present after the minute: idle, with the same grant');
select pg_temp.wake_error($q$select pg_temp.browser('desktop')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.browser('agent')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.browser('member')$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_office_browser_opens),'idle and refused opens record nothing');
select pg_temp.wake_assert((select present_at<clock_timestamp()-interval '60 seconds' from public.qorpera_runtime_office_browser_presence),
	'an idle check writes no presence');

-- A profile a member prepared privately is never kept idle for anybody.
savepoint idle_member_profile;
update public.qorpera_runtime_browser_profiles set company_owned=false
	where id=(current_setting('qorpera_test.present')::jsonb#>>'{grant,profileId}')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser()$q$,'42501');
reset role;
rollback to savepoint idle_member_profile;

-- A revoked grant ends the browser, idle or not.
savepoint idle_revoked;
update public.qorpera_runtime_browser_grants set state='revoked'
	where id=(current_setting('qorpera_test.present')::jsonb#>>'{grant,grantId}')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser()$q$,'42501');
reset role;
rollback to savepoint idle_revoked;

-- A member's takeover: refused while draining (shared surface) and after the
-- drain is acknowledged (the takeover itself), though the screen stays up.
savepoint idle_takeover;
-- Members request against the screen epoch they observed; the test reads it for them.
select set_config('qorpera_test.epoch',(pg_temp.screen()).epoch::text,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.takeover',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.binding')::jsonb->>'screenId')::uuid,
	(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint,
	(current_setting('qorpera_test.binding')::jsonb->>'screenGeneration')::bigint,
	current_setting('qorpera_test.epoch')::bigint,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.browser()$q$,'42501');
select pg_temp.ack(current_setting('qorpera_test.takeover')::jsonb);
select pg_temp.wake_assert(public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.binding')::jsonb)->>'state'='authorized',
	'the drained takeover screen is still up');
select pg_temp.wake_error($q$select pg_temp.browser()$q$,'42501');
reset role;
rollback to savepoint idle_takeover;

-- The agent's next run is presence again: authorized, and recorded.
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(pg_temp.browser()=current_setting('qorpera_test.present')::jsonb,'the next lease authorizes the same browser');
reset role;
select pg_temp.wake_assert((select present_at>clock_timestamp()-interval '60 seconds' from public.qorpera_runtime_office_browser_presence),
	'presence is recorded again');

-- 2. A lease that expired without a release.
create function pg_temp.supervisor() returns jsonb language sql as $$
	select public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.binding')::jsonb->>'computerGeneration')::bigint)
$$;
create function pg_temp.revision() returns bigint language sql as $$
	select revision from public.qorpera_runtime_offices where id=(current_setting('qorpera_test.binding')::jsonb->>'companyComputerId')::uuid
$$;
-- A member shares the desktop (an issued shared ticket): an ordinary release
-- does not end it, a drain does.
select set_config('qorpera_test.epoch',(pg_temp.screen()).epoch::text,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.shared',public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.binding')::jsonb,
	current_setting('qorpera_test.epoch')::bigint,'shared')::text,true);
reset role;
select pg_temp.path_claims('service_role');
create function pg_temp.shared_state() returns text language sql as $$
	select state from public.qorpera_runtime_office_viewers where id=(current_setting('qorpera_test.shared')::jsonb#>>'{grant,viewerSessionId}')::uuid
$$;
select pg_temp.wake_assert(pg_temp.shared_state()='issued','the shared ticket is live');

-- Expired, but for less than 30 seconds: left alone.
update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()-interval '20 seconds' where id=(pg_temp.screen()).id;
select set_config('qorpera_test.revision',pg_temp.revision()::text,true);
set local role service_role;
select pg_temp.wake_assert(pg_temp.supervisor()->'drains'='[]'::jsonb,'a young expired lease is no drain');
select pg_temp.wake_assert(pg_temp.office_call('acquire')='{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb,'a young expired lease still occupies the screen');
reset role;
select pg_temp.wake_assert((pg_temp.screen()).lease_id::text=current_setting('qorpera_test.office_lease')::jsonb->>'leaseId'
	and (pg_temp.screen()).epoch=current_setting('qorpera_test.epoch')::bigint and pg_temp.revision()=current_setting('qorpera_test.revision')::bigint,
	'a young expired lease is untouched');

-- Expired for over 30 seconds with no unresolved work: cleared under a new
-- epoch, no drain, the shared desktop untouched, the screen free again.
update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()-interval '31 seconds' where id=(pg_temp.screen()).id;
select set_config('qorpera_test.shared_epoch',(pg_temp.screen()).shared_viewer_epoch::text,true);
set local role service_role;
select set_config('qorpera_test.reaped',pg_temp.supervisor()::text,true);
reset role;
select pg_temp.wake_assert(current_setting('qorpera_test.reaped')::jsonb->'drains'='[]'::jsonb
	and (current_setting('qorpera_test.reaped')::jsonb->>'revision')::bigint=current_setting('qorpera_test.revision')::bigint+1
	and pg_temp.revision()=current_setting('qorpera_test.revision')::bigint+1,'the reap raises the revision once and sets no drain');
select pg_temp.wake_assert((select lease_id is null and run_id is null and lease_expires_at is null and grant_version is null and native_binding is null
	and power='open' and not drain_pending and drain_id is null and epoch=current_setting('qorpera_test.epoch')::bigint+1
	and shared_viewer_epoch=current_setting('qorpera_test.shared_epoch')::bigint from pg_temp.screen()),'the abandoned lease is released under a new epoch');
select pg_temp.wake_assert(pg_temp.shared_state()='issued','a reap without a drain does not end the shared desktop');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.office_call('check',current_setting('qorpera_test.office_lease')::jsonb)$q$,'42501');
select pg_temp.wake_assert((pg_temp.supervisor()->>'revision')::bigint=current_setting('qorpera_test.revision')::bigint+1,'nothing is reaped twice');
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.office_lease')::jsonb->>'leaseId' is not null,'the agent acquires its screen again');
reset role;

-- Expired for over 30 seconds with unresolved agent work: the drain challenge
-- is set first, returned in the same answer, and ends the shared desktop.
set local role service_role;
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress');
select set_config('qorpera_test.envelope',jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
	'principals',(public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.wake_binding')::jsonb)->'identity')
		-array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
	'operation',jsonb_build_object('tool','computer_shell','toolVersion','qorpera.company-computer-tools/v2',
		'logicalOperationKey','abandoned-effect','requiresCompanyRevision',false,'arguments',jsonb_build_object('kind','shell','command','sleep 600','timeoutMs',1000),
		'target',jsonb_build_object('realm','company_computer','binding',current_setting('qorpera_test.office_lease')::jsonb->'binding',
			'resources',public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb)->'resources')))::text,true);
select set_config('qorpera_test.receipt',extensions.gen_random_uuid()::text,true);
select public.qorpera_begin_native_tool_operation(current_setting('qorpera_test.wake_binding')::jsonb,
	current_setting('qorpera_test.receipt')::uuid,'computer_shell:abandoned-effect',
	encode(extensions.digest(current_setting('qorpera_test.envelope'),'sha256'),'hex'),repeat('d',64),false);
select public.qorpera_native_office_operation(current_setting('qorpera_test.wake_binding')::jsonb,current_setting('qorpera_test.office_scope')::jsonb,
	current_setting('qorpera_test.office_lease')::jsonb,current_setting('qorpera_test.envelope'),'begin',current_setting('qorpera_test.receipt')::uuid,repeat('d',64));
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_resources where screen_id=(pg_temp.screen()).id and state='active'),
	'one unresolved agent effect');
update public.qorpera_runtime_office_screens set lease_expires_at=clock_timestamp()-interval '31 seconds' where id=(pg_temp.screen()).id;
select set_config('qorpera_test.epoch',(pg_temp.screen()).epoch::text,true);
select set_config('qorpera_test.revision',pg_temp.revision()::text,true);
set local role service_role;
select set_config('qorpera_test.reaped',pg_temp.supervisor()::text,true);
reset role;
select pg_temp.wake_assert((select lease_id is null and drain_pending and drain_id is not null and drain_acknowledged_at is null
	and epoch=current_setting('qorpera_test.epoch')::bigint+1 from pg_temp.screen()),'the abandoned lease is released behind a drain challenge');
select pg_temp.wake_assert((select bool_and(state='draining') from public.qorpera_runtime_office_resources where screen_id=(pg_temp.screen()).id),
	'the unresolved effect is draining');
select pg_temp.wake_assert(current_setting('qorpera_test.reaped')::jsonb->'drains'=jsonb_build_array(jsonb_build_object('state','draining',
	'drainId',(pg_temp.screen()).drain_id,'epoch',(pg_temp.screen()).epoch,'binding',current_setting('qorpera_test.binding')::jsonb))
	and (current_setting('qorpera_test.reaped')::jsonb->>'revision')::bigint=current_setting('qorpera_test.revision')::bigint+1,
	'the supervisor receives the new drain in the same answer');
select pg_temp.wake_assert(pg_temp.shared_state()='ended','a drain ends the shared desktop');
set local role service_role;
select pg_temp.wake_assert(pg_temp.office_call('acquire')='{"state":"refused","reason":"SCREEN_OCCUPIED"}'::jsonb,'the screen waits for the guest');
select pg_temp.ack(current_setting('qorpera_test.reaped')::jsonb#>'{drains,0}');
select pg_temp.wake_assert(pg_temp.supervisor()->'drains'='[]'::jsonb,'the acknowledged drain is gone');
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='admitted','after the guest drained, the agent has its screen again');
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_office_resources where state<>'drained'),'the acknowledgement reaps the old work');

rollback;
