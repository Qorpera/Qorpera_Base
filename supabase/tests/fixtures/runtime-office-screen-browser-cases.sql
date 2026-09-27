-- The screen's browser authority uses the real native lease and real member
-- viewers. Guest readiness remains synthetic, as in the other office cases.
set local role service_role;
select set_config('qorpera_test.sb_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select set_config('qorpera_test.sb_binding',(current_setting('qorpera_test.sb_lease')::jsonb->'binding')::text,true);
reset role;
create function pg_temp.sb_grant(p_opener text default null) returns jsonb language sql as $$
	select public.qorpera_office_screen_browser_grant(current_setting('qorpera_test.sb_binding')::jsonb,p_opener)
$$;
-- Members mint against the screen epoch they observed; the fixture reads it for them.
create function pg_temp.sb_observe() returns text language sql as $$
	select set_config('qorpera_test.sb_epoch',(select epoch::text from public.qorpera_runtime_office_screens
		where id=(current_setting('qorpera_test.sb_binding')::jsonb->>'screenId')::uuid),true)
$$;
create function pg_temp.sb_mint(p_mode text) returns jsonb language sql as $$
	select public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.sb_binding')::jsonb,
		current_setting('qorpera_test.sb_epoch')::bigint,p_mode)
$$;
create function pg_temp.sb_redeem(p_ticket jsonb) returns jsonb language sql as $$
	select public.qorpera_redeem_runtime_office_viewer(current_setting('qorpera_test.office_scope')::jsonb,
		encode(extensions.digest(p_ticket->>'capability','sha256'),'hex'))
$$;

-- An agent holding the screen lease: the grant is exactly the descriptor's, a
-- check records nothing and an open records the run.
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized' and (pg_temp.sb_grant()->>'validForMs')::integer=5000,'agent lease authorizes the screen browser');
select pg_temp.wake_assert(pg_temp.sb_grant()->'grant'=(select jsonb_build_object('profileId',d#>'{resources,browserProfileId}',
	'grantId',d#>'{resources,browserGrantId}','version',d#>'{resources,browserGrantVersion}')
	from (select public.qorpera_native_office_descriptor(current_setting('qorpera_test.wake_binding')::jsonb) d) described),
	'the screen browser grant is the agent''s own descriptor grant');
select pg_temp.wake_error($q$select pg_temp.sb_grant('member')$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_office_screen_browser_grant(jsonb_set(current_setting('qorpera_test.sb_binding')::jsonb,'{screenGeneration}','999'),null)$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_office_browser_opens),'checks and refusals record no open');
set local role service_role;
select pg_temp.sb_grant('agent');
reset role;
select pg_temp.wake_assert((select count(*)=1 and bool_and(opener='agent' and present_member_id is null and viewer_id is null
	and run_id=(select run_id from public.qorpera_runtime_office_screens where id=(current_setting('qorpera_test.sb_binding')::jsonb->>'screenId')::uuid))
	from public.qorpera_runtime_office_browser_opens),'an agent open records its run and no member');

-- A profile a member prepared privately still serves the agent that was lent it...
savepoint sb_member_profile;
update public.qorpera_runtime_browser_profiles set company_owned=false
	where id=(pg_temp.sb_grant()->'grant'->>'profileId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','a lent member profile still serves its agent under the lease');
select pg_temp.wake_assert(pg_temp.sb_grant('agent')->>'state'='authorized','the agent it was lent to may open it under its own lease');
-- ...while the dock never starts it, lease or not: a shared viewer's click during
-- the agent's run must not drive another member's privately prepared profile.
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;
select pg_temp.wake_assert((select count(*)=0 from public.qorpera_runtime_office_browser_opens where opener='desktop'),'a refused dock open records nothing');
rollback to savepoint sb_member_profile;
-- The same dock click on the company-owned profile during the run is fine.
savepoint sb_dock_during_run;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant('desktop')->>'state'='authorized','the dock opens the company-owned profile during an agent run');
reset role;
rollback to savepoint sb_dock_during_run;

-- The run has ended and nobody is present. A check is tolerated for at most a
-- minute after the last presence; nothing can be opened in that time, and a
-- member-lent profile gets no tolerance at all.
create function pg_temp.sb_age_presence() returns void language sql as $$
	update public.qorpera_runtime_office_browser_presence set present_at=present_at-interval '61 seconds'
$$;
set local role service_role;
select pg_temp.office_call('release',current_setting('qorpera_test.sb_lease')::jsonb);
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','a check just after the run ended is tolerated');
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.sb_grant('agent')$q$,'42501');
reset role;
savepoint sb_grace_member_profile;
-- Evaluated once: a per-row call would see the profile it just changed.
update public.qorpera_runtime_browser_profiles set company_owned=false where id=(select (pg_temp.sb_grant()->'grant'->>'profileId')::uuid);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_grace_member_profile;
select pg_temp.wake_assert((select cardinality(present_member_ids)=0 from public.qorpera_runtime_office_browser_presence),'the lease alone established this presence');
-- After the minute the company browser stays open but idle (no egress) with
-- the same grant, until somebody entitled is present again. Still nothing opens.
select set_config('qorpera_test.sb_present_grant',(pg_temp.sb_grant()->'grant')::text,true);
select pg_temp.sb_age_presence();
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()=jsonb_build_object('state','idle','grant',current_setting('qorpera_test.sb_present_grant')::jsonb,
	'validForMs',5000),'a check with nobody present after the minute answers idle with the same grant');
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.sb_grant('agent')$q$,'42501');
reset role;
savepoint sb_idle_member_profile;
update public.qorpera_runtime_browser_profiles set company_owned=false
	where id=(current_setting('qorpera_test.sb_present_grant')::jsonb->>'profileId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_idle_member_profile;
select pg_temp.wake_assert((select present_at<clock_timestamp()-interval '60 seconds' from public.qorpera_runtime_office_browser_presence),'a tolerated, idle or refused check never renews the presence');
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_browser_opens),'an idle check records no open');

-- A watching member has no input permission and therefore opens nothing.
select pg_temp.sb_observe();
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('qorpera_test.sb_watch',pg_temp.sb_mint('watch')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.sb_watch_grant',pg_temp.sb_redeem(current_setting('qorpera_test.sb_watch')::jsonb)::text,true);
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;

-- An issued but unredeemed shared ticket is not a live viewer.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sb_ticket',pg_temp.sb_mint('shared')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
select set_config('qorpera_test.sb_viewer',pg_temp.sb_redeem(current_setting('qorpera_test.sb_ticket')::jsonb)::text,true);

-- The live shared viewer of an owner: the dock opens the company browser with no run.
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','a live shared viewer with input permission authorizes the screen browser');
select pg_temp.wake_error($q$select pg_temp.sb_grant('agent')$q$,'42501');
select pg_temp.sb_grant('desktop');
reset role;
select pg_temp.wake_assert((select count(*)=1 and bool_and(run_id is null and present_member_id='30000000-0000-4000-8000-000000000001'
	and viewer_id=(current_setting('qorpera_test.sb_viewer')::jsonb->>'viewerSessionId')::uuid)
	from public.qorpera_runtime_office_browser_opens where opener='desktop'),'a desktop open records exactly the member with input who was present');

-- The launcher pressed again adds no row; a minute later it does. The column says who was present.
set local role service_role;
select pg_temp.sb_grant('desktop');
select pg_temp.sb_grant('desktop');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_browser_opens where opener='desktop'),'repeated dock opens within a minute keep one row per present member');
update public.qorpera_runtime_office_browser_opens set opened_at=opened_at-interval '61 seconds' where opener='desktop';
set local role service_role;
select pg_temp.sb_grant('desktop');
reset role;
select pg_temp.wake_assert((select count(*)=2 from public.qorpera_runtime_office_browser_opens where opener='desktop'),'a dock open a minute later is recorded again');
select pg_temp.wake_assert(exists(select 1 from information_schema.columns where table_schema='public'
	and table_name='qorpera_runtime_office_browser_opens' and column_name='present_member_id')
	and not exists(select 1 from information_schema.columns where table_schema='public'
	and table_name='qorpera_runtime_office_browser_opens' and column_name='member_id'),'the ledger names presence, not a clicker');

-- ...but a member alone never opens a profile another member prepared privately.
savepoint sb_member_alone;
update public.qorpera_runtime_browser_profiles set company_owned=false
	where id=(select profile_id from public.qorpera_runtime_office_browser_opens limit 1);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;
rollback to savepoint sb_member_alone;

-- Liveness is rechecked every time. A viewer whose gateway stopped renewing it
-- (a network blip) is tolerated for a check, never for an open, and only for a minute.
savepoint sb_expired;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second'
	where id=(current_setting('qorpera_test.sb_viewer')::jsonb->>'viewerSessionId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','a viewer that just lapsed is tolerated for a check');
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;
select pg_temp.sb_age_presence();
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='idle','a viewer lapsed for over a minute leaves the browser idle');
reset role;
rollback to savepoint sb_expired;

-- The tolerance never outlives a revocation or a fence: the check answers idle
-- (no egress), never authorized. Each case starts from the same lapsed viewer,
-- which alone would still be tolerated.
create function pg_temp.sb_lapse() returns void language sql as $$
	update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second'
		where id=(current_setting('qorpera_test.sb_viewer')::jsonb->>'viewerSessionId')::uuid
$$;
-- The member left and rejoined (a new membership incarnation).
savepoint sb_grace_membership;
select pg_temp.sb_lapse();
insert into public.qorpera_runtime_browser_membership_revocations(profile_id,user_id,version)
	values('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001',1)
	on conflict(profile_id,user_id) do update set version=qorpera_runtime_browser_membership_revocations.version+1;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='idle','a new membership incarnation ends the tolerance');
reset role;
rollback to savepoint sb_grace_membership;
-- A fence since the presence (what a drain, takeover or screen change leaves behind).
savepoint sb_grace_fenced;
select pg_temp.sb_lapse();
update public.qorpera_runtime_office_screens set shared_viewer_epoch=shared_viewer_epoch+1
	where id=(current_setting('qorpera_test.sb_binding')::jsonb->>'screenId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='idle','a fence since the presence ends the tolerance');
reset role;
rollback to savepoint sb_grace_fenced;
-- A privacy version change since the presence.
savepoint sb_grace_privacy;
select pg_temp.sb_lapse();
update public.qorpera_runtime_offices set privacy_version=privacy_version+1
	where id=(current_setting('qorpera_test.sb_binding')::jsonb->>'companyComputerId')::uuid;
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='idle','a privacy version change ends the tolerance');
reset role;
rollback to savepoint sb_grace_privacy;
-- A real takeover request: the pending drain refuses at once, tolerance or not,
-- and the member's takeover screen keeps no idle agent browser after the drain.
savepoint sb_grace_drain;
select pg_temp.sb_lapse();
select pg_temp.sb_observe();
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.sb_drain',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'screenId')::uuid,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'computerGeneration')::bigint,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'screenGeneration')::bigint,
	current_setting('qorpera_test.sb_epoch')::bigint,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'screenId')::uuid,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'computerGeneration')::bigint,
	(current_setting('qorpera_test.sb_binding')::jsonb->>'screenGeneration')::bigint,
	(current_setting('qorpera_test.sb_drain')::jsonb->>'epoch')::bigint,(current_setting('qorpera_test.sb_drain')::jsonb->>'drainId')::uuid);
select pg_temp.wake_assert(public.qorpera_check_runtime_office_shared_surface(current_setting('qorpera_test.sb_binding')::jsonb)->>'state'='authorized','the drained takeover screen is still up');
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_grace_drain;
select pg_temp.path_claims('service_role');

-- A revoked grant ends the browser for everybody, present or not.
savepoint sb_revoked;
update public.qorpera_runtime_browser_grants set state='revoked'
	where id=(select grant_id from public.qorpera_runtime_office_browser_opens limit 1);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_revoked;

-- The viewer closing ends its authority after the short tolerance, and at once
-- for anything that would open a browser; the agent's return restores the agent's.
set local role service_role;
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.sb_viewer')::jsonb);
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','a check just after the viewer left is tolerated');
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;
select pg_temp.sb_age_presence();
set local role service_role;
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='idle','after the tolerance the browser stays idle');
select set_config('qorpera_test.sb_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','the agent''s next lease uses the same screen browser authority');
reset role;

select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE'),'screen browser authority is broker only');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_browser_opens','SELECT')
	and not has_table_privilege('authenticated','public.qorpera_runtime_office_browser_opens','SELECT')
	and not has_table_privilege('service_role','public.qorpera_runtime_office_browser_presence','UPDATE')
	and not has_table_privilege('authenticated','public.qorpera_runtime_office_browser_presence','SELECT'),'the open ledger and the presence record are reachable through no client role');
