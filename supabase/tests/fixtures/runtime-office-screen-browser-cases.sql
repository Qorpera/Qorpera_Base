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

-- No lease and nobody present: no authority, though the grant itself is current.
set local role service_role;
select pg_temp.office_call('release',current_setting('qorpera_test.sb_lease')::jsonb);
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.sb_grant('desktop')$q$,'42501');
reset role;

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

-- Liveness is rechecked every time: a viewer whose gateway stopped renewing it stops counting.
savepoint sb_expired;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second'
	where id=(current_setting('qorpera_test.sb_viewer')::jsonb->>'viewerSessionId')::uuid;
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_expired;

-- A revoked grant ends the browser for everybody, present or not.
savepoint sb_revoked;
update public.qorpera_runtime_browser_grants set state='revoked'
	where id=(select grant_id from public.qorpera_runtime_office_browser_opens limit 1);
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
reset role;
rollback to savepoint sb_revoked;

-- The viewer closing ends its authority; the agent's return restores the agent's.
set local role service_role;
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.sb_viewer')::jsonb);
select pg_temp.wake_error($q$select pg_temp.sb_grant()$q$,'42501');
select set_config('qorpera_test.sb_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(pg_temp.sb_grant()->>'state'='authorized','the agent''s next lease uses the same screen browser authority');
reset role;

select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_office_screen_browser_grant(jsonb,text)','EXECUTE'),'screen browser authority is broker only');
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_browser_opens','SELECT')
	and not has_table_privilege('authenticated','public.qorpera_runtime_office_browser_opens','SELECT'),'the open ledger is readable through no client role');
