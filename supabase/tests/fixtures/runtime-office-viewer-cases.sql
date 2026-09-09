-- Real registry/member authority; physical drain/readiness remains synthetic.
set local role service_role;
select set_config('qorpera_test.office_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
create function pg_temp.viewer_mint(p_mode text default 'watch',p_private jsonb default null) returns jsonb language sql as $$
	select public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.office_lease')::jsonb->'binding',
		(current_setting('qorpera_test.viewer_epoch')::bigint),p_mode,p_private)
$$;
create function pg_temp.viewer_redeem(p_ticket jsonb) returns jsonb language sql as $$
	select public.qorpera_redeem_runtime_office_viewer(current_setting('qorpera_test.office_scope')::jsonb,
		encode(extensions.digest(p_ticket->>'capability','sha256'),'hex'))
$$;
create function pg_temp.viewer_drain(p_takeover boolean) returns jsonb language sql as $$
	select public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
		(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,current_setting('qorpera_test.viewer_epoch')::bigint,p_takeover)
$$;
create function pg_temp.viewer_ack(p_drain jsonb) returns jsonb language sql as $$
	select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
		(p_drain#>>'{binding,screenId}')::uuid,(p_drain#>>'{binding,computerGeneration}')::bigint,
		(p_drain#>>'{binding,screenGeneration}')::bigint,(p_drain->>'epoch')::bigint,(p_drain->>'drainId')::uuid)
$$;
select set_config('qorpera_test.viewer_epoch','1',true);
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('qorpera_test.watch_ticket',pg_temp.viewer_mint()::text,true);
select pg_temp.wake_assert(length(current_setting('qorpera_test.watch_ticket')::jsonb->>'capability')=43,'bounded random ticket');
select pg_temp.wake_assert(current_setting('qorpera_test.watch_ticket')::jsonb#>>'{grant,mode}'='watch','watch is the default');
select pg_temp.wake_error($q$select pg_temp.viewer_mint('control')$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_redeem_runtime_office_viewer(jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"34000000-0000-4000-8000-000000000099"'),
	encode(extensions.digest(current_setting('qorpera_test.watch_ticket')::jsonb->>'capability','sha256'),'hex'))$q$,'42501');
select set_config('qorpera_test.watch_grant',pg_temp.viewer_redeem(current_setting('qorpera_test.watch_ticket')::jsonb)::text,true);
select pg_temp.wake_error($q$select pg_temp.viewer_redeem(current_setting('qorpera_test.watch_ticket')::jsonb)$q$,'42501');
select pg_temp.wake_assert(public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.watch_grant')::jsonb)->>'mode'='watch','current watch may refresh');
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(jsonb_set(current_setting('qorpera_test.watch_grant')::jsonb,'{memberId}','"30000000-0000-4000-8000-000000000001"'))$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.watch_grant')::jsonb,1,repeat('a',64))$q$,'42501');
reset role;

-- Membership removal/rejoin cannot revive a still-open viewer.
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000003';
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
	('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000003','path-viewer@example.test','Viewer','viewer');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.watch_grant')::jsonb)$q$,'42501');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.watch_grant')::jsonb);
reset role;
select pg_temp.wake_assert((select not drain_pending from public.qorpera_runtime_office_screens),'closing watch does not stop the desktop');

-- Ordinary member control requires an explicitly acknowledged takeover.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.viewer_mint('control')$q$,'42501');
select set_config('qorpera_test.viewer_drain',pg_temp.viewer_drain(true)::text,true);
select set_config('qorpera_test.viewer_epoch',(current_setting('qorpera_test.viewer_drain')::jsonb->>'epoch'),true);
select pg_temp.wake_error($q$select pg_temp.viewer_mint('control')$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.viewer_ack(current_setting('qorpera_test.viewer_drain')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.control_ticket',pg_temp.viewer_mint('control')::text,true);
select pg_temp.wake_assert(pg_temp.viewer_mint('control')->>'state'='refused','only one member driver, including unredeemed tickets');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.control_grant',pg_temp.viewer_redeem(current_setting('qorpera_test.control_ticket')::jsonb)::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.control_grant')::jsonb#>>'{lease,driver,kind}'='member','member control is not a native lease');
select pg_temp.wake_assert(public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.control_grant')::jsonb,1,repeat('b',64))->>'state'='admitted','input admission precedes forwarding');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.control_grant')::jsonb,1,repeat('b',64))$q$,'55000');
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.control_grant')::jsonb,3,repeat('b',64))$q$,'55000');
select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.control_grant')::jsonb,2,repeat('c',64));
reset role;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second' where mode='control';
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.control_grant')::jsonb)$q$,'42501');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.control_grant')::jsonb);
select pg_temp.wake_assert(pg_temp.office_call('acquire')->>'state'='refused','closed member socket does not prove held input drained');
reset role;
select pg_temp.wake_assert((select count(*)=1 from public.qorpera_runtime_office_viewers where mode='control' and state='draining'),'expired control retains occupancy');
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
-- Release created the next challenge. A fresh user takeover replaces it and
-- demands a new physical acknowledgement; the old ack cannot free this slot.
select set_config('qorpera_test.viewer_epoch','3',true);
select set_config('qorpera_test.old_viewer_drain',current_setting('qorpera_test.viewer_drain'),true);
select set_config('qorpera_test.viewer_drain',pg_temp.viewer_drain(true)::text,true);
select set_config('qorpera_test.viewer_epoch',(current_setting('qorpera_test.viewer_drain')::jsonb->>'epoch'),true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select pg_temp.viewer_ack(current_setting('qorpera_test.old_viewer_drain')::jsonb)$q$,'42501');
select pg_temp.viewer_ack(current_setting('qorpera_test.viewer_drain')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.new_control_ticket',pg_temp.viewer_mint('control')::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.new_control_grant',pg_temp.viewer_redeem(current_setting('qorpera_test.new_control_ticket')::jsonb)::text,true);
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.control_grant')::jsonb);
select pg_temp.viewer_ack(current_setting('qorpera_test.viewer_drain')::jsonb);
select pg_temp.wake_assert(public.qorpera_check_runtime_office_viewer(current_setting('qorpera_test.new_control_grant')::jsonb)->>'mode'='control','old cleanup/ack preserves the replacement');
reset role;

-- Reuse the private handoff authority; only that profile's member can view/type.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.viewer_drain',pg_temp.viewer_drain(false)::text,true);
select set_config('qorpera_test.viewer_epoch',(current_setting('qorpera_test.viewer_drain')::jsonb->>'epoch'),true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.viewer_ack(current_setting('qorpera_test.viewer_drain')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_register_runtime_browser_profile(current_setting('qorpera_test.office_scope')::jsonb,'34000000-0000-4000-8000-000000000071');
select set_config('qorpera_test.viewer_privacy',public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
	'34000000-0000-4000-8000-000000000071',(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,0,true)::text,true);
select set_config('qorpera_test.viewer_epoch',(current_setting('qorpera_test.viewer_privacy')::jsonb#>>'{drains,0,epoch}'),true);
select pg_temp.wake_error($q$select pg_temp.viewer_mint('control',current_setting('qorpera_test.viewer_privacy')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.viewer_ack(current_setting('qorpera_test.viewer_privacy')::jsonb#>'{drains,0}');
select public.qorpera_ack_runtime_office_privacy(current_setting('qorpera_test.viewer_privacy')::jsonb);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.viewer_mint()$q$,'42501');
select pg_temp.wake_error($q$select pg_temp.viewer_mint('control',current_setting('qorpera_test.viewer_privacy')::jsonb)$q$,'42501');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.viewer_mint()$q$,'42501');
select set_config('qorpera_test.private_ticket',pg_temp.viewer_mint('control',current_setting('qorpera_test.viewer_privacy')::jsonb)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.private_grant',pg_temp.viewer_redeem(current_setting('qorpera_test.private_ticket')::jsonb)::text,true);
select pg_temp.wake_assert(current_setting('qorpera_test.private_grant')::jsonb#>>'{privateSignIn,challengeId}'=current_setting('qorpera_test.viewer_privacy')::jsonb->>'challengeId','private viewer bound to exact handoff');
select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.private_grant')::jsonb,1,repeat('d',64));
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.qorpera_request_runtime_office_privacy(current_setting('qorpera_test.office_scope')::jsonb,
	'34000000-0000-4000-8000-000000000071',(current_setting('qorpera_test.office_lease')::jsonb#>>'{binding,screenId}')::uuid,1,false);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_admit_runtime_office_viewer_input(current_setting('qorpera_test.private_grant')::jsonb,2,repeat('e',64))$q$,'42501');
select public.qorpera_release_runtime_office_viewer(current_setting('qorpera_test.private_grant')::jsonb);
reset role;
select pg_temp.wake_assert(not has_table_privilege('service_role','public.qorpera_runtime_office_viewers','SELECT,INSERT,UPDATE,DELETE'),'private ticket ledger');
select pg_temp.wake_assert(not has_table_privilege('authenticated','public.qorpera_runtime_office_viewer_inputs','SELECT,INSERT,UPDATE,DELETE'),'no member raw input audit');
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_admit_runtime_office_viewer_input(jsonb,bigint,text)','EXECUTE'),'only trusted gateway admits input');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_ack_runtime_office_drain_v1(jsonb,uuid,bigint,bigint,bigint,uuid)','EXECUTE'),'no old drain bypass');
