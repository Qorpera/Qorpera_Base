-- Shared member input uses real native authority without taking the agent's
-- lease. Guest readiness remains synthetic, as in the existing office tests.
set local role service_role;
select set_config('qorpera_test.shared_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
create function pg_temp.shared_mint(p_mode text default 'shared') returns jsonb language sql as $$
	select public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.shared_lease')::jsonb->'binding',
		(current_setting('qorpera_test.shared_lease')::jsonb->>'epoch')::bigint,p_mode)
$$;
create function pg_temp.shared_redeem(p_ticket jsonb) returns jsonb language sql as $$
	select public.qorpera_redeem_runtime_office_viewer(current_setting('qorpera_test.office_scope')::jsonb,
		encode(extensions.digest(p_ticket->>'capability','sha256'),'hex'))
$$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.shared_mint()$q$,'42501');
select set_config('qorpera_test.shared_watch',pg_temp.shared_mint('watch')::text,true);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.shared_mint()$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.shared_ticket',pg_temp.shared_mint()::text,true);
select set_config('qorpera_test.shared_other_ticket',pg_temp.shared_mint()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.shared_ticket')::jsonb->>'state'='issued','owner opens shared input without takeover');
select pg_temp.wake_assert(not(current_setting('qorpera_test.shared_ticket')::jsonb->'grant' ? 'lease'),'shared member does not acquire an exclusive lease');
select pg_temp.wake_assert(current_setting('qorpera_test.shared_other_ticket')::jsonb->>'state'='issued','shared views do not compete for an exclusive driver');
select pg_temp.wake_error($q$select pg_temp.shared_mint('control')$q$,'42501');
reset role;
select pg_temp.wake_assert((select lease_id=(current_setting('qorpera_test.shared_lease')::jsonb->>'leaseId')::uuid
	and not drain_pending and takeover_user_id is null from public.qorpera_runtime_office_screens),'shared mint leaves the agent lease intact');
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.shared_grant',pg_temp.shared_redeem(current_setting('qorpera_test.shared_ticket')::jsonb)::text,true);
select set_config('qorpera_test.shared_other_grant',pg_temp.shared_redeem(current_setting('qorpera_test.shared_other_ticket')::jsonb)::text,true);
select set_config('qorpera_test.shared_watch_grant',pg_temp.shared_redeem(current_setting('qorpera_test.shared_watch')::jsonb)::text,true);
select pg_temp.wake_error($q$select pg_temp.shared_redeem(current_setting('qorpera_test.shared_ticket')::jsonb)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_watch_grant')::jsonb,1,repeat('a',64))$q$,'42501');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_grant')::jsonb,1,repeat('b',64))->>'state'='admitted','shared input is admitted and audited');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_grant')::jsonb,1,repeat('b',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_grant')::jsonb,3,repeat('c',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(jsonb_set(current_setting('qorpera_test.shared_grant')::jsonb,'{screenEpoch}','999'))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(jsonb_set(current_setting('qorpera_test.shared_grant')::jsonb,'{binding,screenGeneration}','999'))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(jsonb_set(current_setting('qorpera_test.shared_grant')::jsonb,'{privacyVersion}','999'))$q$,'42501');
select pg_temp.wake_assert(pg_temp.office_call('renew',current_setting('qorpera_test.shared_lease')::jsonb)->>'state'='admitted','agent renews while member shares input');
select pg_temp.office_call('release',current_setting('qorpera_test.shared_lease')::jsonb);
select pg_temp.wake_assert(public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.shared_grant')::jsonb)->>'mode'='shared','shared view survives ordinary agent release');
select set_config('qorpera_test.shared_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_grant')::jsonb,2,repeat('c',64))->>'state'='admitted','shared input survives agent reacquisition');
-- Windowed admission: one call validates the viewer and records the previous
-- window as a single contiguous ledger row. The per-packet calls above and the
-- window calls below share last_sequence.
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_watch_grant')::jsonb,1,0,null)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_watch_grant')::jsonb,1,1,repeat('1',64))$q$,'42501');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,0,null)->>'state'='admitted','an opening window validates without a ledger row');
select pg_temp.wake_assert((public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,0,null)->>'validForMs')::bigint between 1 and 1000,'a window never outlives one second');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,0,null)-'validForMs'='{"state":"admitted"}'::jsonb,'an admitted window returns only its state and validity');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,4097,repeat('1',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,-1,repeat('1',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,1,null)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,0,repeat('1',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,1,repeat('G',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,0,1,repeat('1',64))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,2,1,repeat('1',64))$q$,'55000');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,500,repeat('1',64))->>'state'='admitted','a burst is admitted and audited as one window');
-- A resend after a lost answer: the exact last row is already recorded. It is
-- validated again and answered normally, without a second row. Anything that
-- differs from that row is still a replay.
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,500,repeat('1',64))->>'state'='admitted','an exact replay of the last window is idempotent');
-- The ledger is private to its owner (the gateway only reaches it through the
-- admission functions), so read it back without the gateway role.
reset role;
select pg_temp.wake_assert((select count(*)=1 and max(last_sequence)=500 from public.qorpera_runtime_office_viewer_inputs i
	join public.qorpera_runtime_office_viewers v on v.id=i.viewer_id where v.id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid),'an idempotent resend records nothing twice');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,500,repeat('9',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,499,repeat('1',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,2,499,repeat('1',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,500,2,repeat('2',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,502,1,repeat('2',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,502,0,null)$q$,'55000');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,501,2,repeat('2',64))->>'state'='admitted','the next window continues at the previous last sequence plus one');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,1,500,repeat('1',64))$q$,'55000');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_other_grant')::jsonb,503,repeat('3',64))->>'state'='admitted','per-packet admission from an older gateway shares the sequence');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,503,1,repeat('4',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(jsonb_set(current_setting('qorpera_test.shared_other_grant')::jsonb,'{screenEpoch}','999'),504,0,null)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(jsonb_set(current_setting('qorpera_test.shared_other_grant')::jsonb,'{mode}','"control"'),504,0,null)$q$,'42501');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.shared_grant')::jsonb);
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.shared_grant')::jsonb);
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_grant')::jsonb,3,0,null)='{"state":"refused"}'::jsonb,'a released viewer is refused a new window');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_grant')::jsonb,3,repeat('d',64))$q$,'42501');
select pg_temp.wake_assert(pg_temp.office_call('check',current_setting('qorpera_test.shared_lease')::jsonb)->>'state'='admitted','closing shared view preserves current agent authority');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.shared_other_grant')::jsonb)->>'mode'='shared','closing one shared view preserves another');
reset role;
select pg_temp.wake_assert((select not drain_pending and takeover_user_id is null and epoch>shared_viewer_epoch
	from public.qorpera_runtime_office_screens),'shared epoch survives native lease churn without a drain');
select pg_temp.wake_assert((select count(*)=2 from public.qorpera_runtime_office_viewer_inputs
	where viewer_id=(current_setting('qorpera_test.shared_grant')::jsonb->>'viewerSessionId')::uuid),'input ledger retains exactly the admitted sequence');
select pg_temp.wake_assert((select jsonb_agg(jsonb_build_array(sequence,packet_count,input_commitment,recorded_after_refusal) order by sequence)
	=jsonb_build_array(jsonb_build_array(1,500,repeat('1',64),false),jsonb_build_array(501,2,repeat('2',64),false),jsonb_build_array(503,null,repeat('3',64),false))
	from public.qorpera_runtime_office_viewer_inputs
	where viewer_id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid),'window ledger holds one keyed row per window and no refused range');
select pg_temp.wake_assert((select last_sequence=503 from public.qorpera_runtime_office_viewers
	where id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid),'windows advance the viewer sequence by their packet count');

-- An expired viewer gets no new window.
savepoint shared_window_expiry;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second'
	where id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid;
set local role service_role;
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,504,0,null)='{"state":"refused"}'::jsonb,'an expired viewer is refused a new window');
reset role;
rollback to savepoint shared_window_expiry;

-- A ticket minted after native lease churn still uses the stable shared epoch.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.shared_expiring',pg_temp.shared_mint()::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.shared_expiring')::jsonb#>'{grant,screenEpoch}'<>
	current_setting('qorpera_test.shared_lease')::jsonb->'epoch','shared grant epoch is independent of the observed agent epoch');
reset role;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second'
	where id=(current_setting('qorpera_test.shared_expiring')::jsonb#>>'{grant,viewerSessionId}')::uuid;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_assert(public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,1)->'drains'='[]'::jsonb,'expired shared tickets do not drain agent work');
select pg_temp.wake_assert(pg_temp.office_call('check',current_setting('qorpera_test.shared_lease')::jsonb)->>'state'='admitted','shared expiry preserves current agent authority');
reset role;

-- Admin permission is rechecked on every input, including role downgrade and
-- membership removal/rejoin, without granting new authority to plain members.
update public.qorpera_profile_members set role='admin' where profile_id='30000000-0000-4000-8000-000000000010'
	and user_id='30000000-0000-4000-8000-000000000002';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.shared_admin_ticket',pg_temp.shared_mint()::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.shared_admin_grant',pg_temp.shared_redeem(current_setting('qorpera_test.shared_admin_ticket')::jsonb)::text,true);
select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_admin_grant')::jsonb,1,repeat('e',64));
reset role;
update public.qorpera_profile_members set role='contributor' where profile_id='30000000-0000-4000-8000-000000000010'
	and user_id='30000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_admin_grant')::jsonb,2,repeat('e',64))$q$,'42501');
reset role;
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000002';
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000002','shared-admin@example.test','Admin','admin');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.shared_admin_grant')::jsonb)$q$,'42501');
reset role;

-- Entering private sign-in immediately revokes already-active shared input.
-- Roll back this branch so takeover below tests the same live agent/viewer.
savepoint shared_privacy;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_register_runtime_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,'34000000-0000-4000-8000-000000000072');
select public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
	'34000000-0000-4000-8000-000000000072',(current_setting('qorpera_test.shared_lease')::jsonb#>>'{binding,screenId}')::uuid,0,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_other_grant')::jsonb,1,repeat('f',64))$q$,'42501');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,504,0,null)='{"state":"refused"}'::jsonb,'private sign-in refuses the next input window');
reset role;
rollback to savepoint shared_privacy;

-- Actual takeover fences shared channels immediately and cannot be bypassed
-- after physical acknowledgement or by cleanup from an old shared socket.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.shared_drain',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.shared_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,
	(current_setting('qorpera_test.shared_lease')::jsonb->>'epoch')::bigint,true)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.shared_other_grant')::jsonb,1,repeat('f',64))$q$,'42501');
-- A fence refuses the next window but keeps the audit of packets the gateway
-- had already dispatched under the previous one. Nothing further is admitted.
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,504,3,repeat('5',64))='{"state":"refused"}'::jsonb,'takeover refuses the next input window');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,504,3,repeat('5',64))='{"state":"refused"}'::jsonb,'resending the recorded window stays refused');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,504,3,repeat('6',64))$q$,'55000');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,507,0,null)='{"state":"refused"}'::jsonb,'a fenced viewer stays refused');
select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.shared_drain')::jsonb#>>'{binding,screenId}')::uuid,1,2,
	(current_setting('qorpera_test.shared_drain')::jsonb->>'epoch')::bigint,(current_setting('qorpera_test.shared_drain')::jsonb->>'drainId')::uuid);
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.shared_other_grant')::jsonb)$q$,'42501');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.shared_other_grant')::jsonb);
reset role;
select set_config('qorpera_test.shared_lease',jsonb_set(current_setting('qorpera_test.shared_lease')::jsonb,'{epoch}',current_setting('qorpera_test.shared_drain')::jsonb->'epoch')::text,true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.shared_mint()$q$,'42501');
select pg_temp.wake_assert(pg_temp.shared_mint('control')->>'state'='issued','explicit exclusive takeover still admits control');
reset role;
select pg_temp.wake_assert((select not drain_pending and takeover_user_id='30000000-0000-4000-8000-000000000001'
	from public.qorpera_runtime_office_screens),'old shared cleanup preserves acknowledged exclusive takeover');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_admit_runtime_office_viewer_input(jsonb,bigint,text)','EXECUTE'),'shared input remains gateway-only');
select pg_temp.wake_assert((select packet_count=3 and input_commitment=repeat('5',64) and recorded_after_refusal from public.qorpera_runtime_office_viewer_inputs
	where viewer_id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid and sequence=504),'a refused renewal still records the window that was already dispatched');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_admit_runtime_office_viewer_input_window(jsonb,bigint,integer,text)','EXECUTE')
	and not has_function_privilege('anon','public.qorpera_admit_runtime_office_viewer_input_window(jsonb,bigint,integer,text)','EXECUTE')
	and has_function_privilege('service_role','public.qorpera_admit_runtime_office_viewer_input_window(jsonb,bigint,integer,text)','EXECUTE'),'input windows remain gateway-only');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_fence_shared_runtime_office_viewers()','EXECUTE'),'shared epoch trigger cannot be called by the gateway');
-- Long after a viewer ended, its ledger accepts nothing more.
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_viewer_inputs
	where viewer_id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid and recorded_after_refusal),'exactly one window was recorded after refusal');
update public.qorpera_runtime_office_viewers set ended_at=clock_timestamp()-interval '11 seconds'
	where id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid and state='ended';
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,507,1,repeat('7',64))$q$,'42501');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input_window(current_setting('qorpera_test.shared_other_grant')::jsonb,507,0,null)='{"state":"refused"}'::jsonb,'a long-ended viewer is still answered with a refusal');
reset role;
select pg_temp.wake_assert((select last_sequence=506 from public.qorpera_runtime_office_viewers
	where id=(current_setting('qorpera_test.shared_other_grant')::jsonb->>'viewerSessionId')::uuid),'a closed ledger does not advance the sequence');
