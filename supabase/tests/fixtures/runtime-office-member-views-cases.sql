set local role service_role;
select set_config('qorpera_test.member_lease',(pg_temp.office_call('acquire')->'lease')::text,true);
reset role;
create function pg_temp.member_status() returns jsonb language sql as $$
	select public.qorpera_runtime_office_member_status(current_setting('qorpera_test.office_scope')::jsonb)
$$;
create function pg_temp.member_cancel(p_id uuid) returns jsonb language sql as $$
	select public.qorpera_cancel_runtime_office_viewer(current_setting('qorpera_test.office_scope')::jsonb,p_id)
$$;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select set_config('qorpera_test.member_watch',public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.member_lease')::jsonb->'binding',1)::text,true);
select pg_temp.wake_assert(pg_temp.member_status()->'screens'->0->'binding'=current_setting('qorpera_test.member_lease')::jsonb->'binding','member receives exact current binding');
select pg_temp.wake_assert(pg_temp.member_status()#>>'{screens,0,driver}'='agent','watch status retains agent driver');
select pg_temp.wake_assert(jsonb_array_length(pg_temp.member_status()->'viewers')=1,'member can recover own issued view');
select pg_temp.wake_assert(pg_temp.member_status()::text not like '%capability%' and pg_temp.member_status()::text not like '%native_binding%','status has no ticket or native binding');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.wake_assert(pg_temp.member_status()->'viewers'='[]'::jsonb,'administrator cannot inspect another member tickets');
select pg_temp.wake_error($q$select pg_temp.member_cancel((current_setting('qorpera_test.member_watch')::jsonb#>>'{grant,viewerSessionId}')::uuid)$q$,'42501');
select pg_temp.wake_error($q$select public.qorpera_runtime_office_member_status(jsonb_set(current_setting('qorpera_test.office_scope')::jsonb,'{companyId}','"34000000-0000-4000-8000-000000000099"'))$q$,'42501');
reset role;

-- Revocation blocks reading, while exact cancellation remains available.
delete from public.qorpera_profile_members where profile_id='30000000-0000-4000-8000-000000000010' and user_id='30000000-0000-4000-8000-000000000003';
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.wake_error($q$select pg_temp.member_status()$q$,'42501');
select pg_temp.member_cancel((current_setting('qorpera_test.member_watch')::jsonb#>>'{grant,viewerSessionId}')::uuid);
select pg_temp.member_cancel((current_setting('qorpera_test.member_watch')::jsonb#>>'{grant,viewerSessionId}')::uuid);
reset role;
select pg_temp.wake_assert((select not drain_pending and lease_id is not null from public.qorpera_runtime_office_screens),'watch cancellation does not stop agent');

select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_drain',public.qorpera_request_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.member_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,1,true)::text,true);
select pg_temp.wake_assert(pg_temp.member_status()#>>'{screens,0,drainPending}'='true','takeover request is not readiness');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select public.qorpera_ack_runtime_office_drain(current_setting('qorpera_test.office_scope')::jsonb,
	(current_setting('qorpera_test.member_lease')::jsonb#>>'{binding,screenId}')::uuid,1,2,2,(current_setting('qorpera_test.member_drain')::jsonb->>'drainId')::uuid);
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.member_control',public.qorpera_create_runtime_office_viewer(current_setting('qorpera_test.member_lease')::jsonb->'binding',2,'control')::text,true);
reset role;
update public.qorpera_runtime_office_viewers set expires_at=clock_timestamp()-interval '1 second' where mode='control';
set local role authenticated;
select pg_temp.wake_assert(pg_temp.member_status()#>>'{viewers,0,viewerSessionId}'=current_setting('qorpera_test.member_control')::jsonb#>>'{grant,viewerSessionId}','expired unredeemed control is recoverable');
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select pg_temp.wake_error($q$select public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,2)$q$,'42501');
select set_config('qorpera_test.member_reap',public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,1)::text,true);
select pg_temp.wake_assert(jsonb_array_length(current_setting('qorpera_test.member_reap')::jsonb->'drains')=1,'runtime discovers expired input without a client');
select pg_temp.wake_assert(public.qorpera_runtime_office_supervisor_status(current_setting('qorpera_test.office_scope')::jsonb,1)->'drains'=current_setting('qorpera_test.member_reap')::jsonb->'drains','reconcile retains exact challenge without replaying expiry');
reset role;
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.member_cancel((current_setting('qorpera_test.member_control')::jsonb#>>'{grant,viewerSessionId}')::uuid);
select pg_temp.wake_assert(pg_temp.member_status()#>>'{screens,0,drainPending}'='true','cancellation requires physical drain');
select pg_temp.wake_assert(pg_temp.member_status()#>>'{viewers,0,state}'='draining','cancellation retains occupancy until acknowledgement');
reset role;
select pg_temp.wake_assert(not has_function_privilege('authenticated','public.qorpera_release_runtime_office_viewer(jsonb)','execute'),'service release is not a member entrypoint');
select pg_temp.wake_assert(not has_function_privilege('anon','public.qorpera_runtime_office_member_status(jsonb)','execute'),'anonymous status denied');
select pg_temp.wake_assert(not has_function_privilege('service_role','public.qorpera_cancel_runtime_office_viewer(jsonb,uuid)','execute'),'cancel is an authenticated member intent');
