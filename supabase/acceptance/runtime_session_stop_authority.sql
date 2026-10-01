-- Compare the member-visible control with actual cancellation of a leased
-- native run. Each case rolls back with the shared disposable wake fixture.
create function pg_temp.review_stop_authority(p_actor text,p_private boolean default false)
returns void language plpgsql as $$
declare
 b jsonb:=current_setting('qorpera_test.wake_binding')::jsonb;
 v_run public.qorpera_execution_runs%rowtype;
 v_creator uuid; v_actor uuid:=extensions.gen_random_uuid(); v_other_owner uuid:=extensions.gen_random_uuid();
 v_readable boolean; v_allowed boolean; v_read jsonb; v_cancel jsonb; v_job_before jsonb;
 v_read_state text; v_cancel_state text;
begin
 select * into strict v_run from public.qorpera_execution_runs where id=(b->>'runId')::uuid;
 select created_by_user_id into strict v_creator from public.qorpera_runner_jobs where id=v_run.job_id;
 -- Hand the founder role to another member. The run creator remains a
 -- contributor unless the case later downgrades or removes that membership.
 -- The new founder comes first: the last founder cannot step down (20260928248100).
 insert into auth.users(id,email) values(v_other_owner,v_other_owner::text||'@example.test');
 insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
 values(v_run.profile_id,v_other_owner,v_other_owner::text||'@example.test','Fixture owner','owner');
 update public.qorpera_profile_members set role='contributor'
 where profile_id=v_run.profile_id and user_id=v_creator;
 if p_private then
  update public.qorpera_shared_sessions set audience_kind='member_private',audience_user_id=v_creator
  where id=v_run.session_id;
 end if;
 if p_actor in ('creator','viewer_creator','removed_creator') then
  v_actor:=v_creator;
  update public.qorpera_profile_members set role=case when p_actor='viewer_creator'
   then 'viewer'::public.qorpera_profile_role else 'contributor'::public.qorpera_profile_role end
  where profile_id=v_run.profile_id and user_id=v_creator;
  if p_actor='removed_creator' then
   delete from public.qorpera_profile_members where profile_id=v_run.profile_id and user_id=v_creator;
  end if;
 elsif p_actor='owner' then
  v_actor:=v_other_owner;
 else
  insert into auth.users(id,email) values(v_actor,v_actor::text||'@example.test');
  if p_actor<>'outsider' then
   insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
   values(v_run.profile_id,v_actor,v_actor::text||'@example.test','Control reviewer',p_actor::public.qorpera_profile_role);
  end if;
 end if;
 -- Removing the sponsor's membership already terminalizes its run. Compare
 -- against that state so denied requests cannot revive or alter it.
 select to_jsonb(job) into strict v_job_before from public.qorpera_runner_jobs job where id=v_run.job_id;
 v_readable:=p_actor not in ('outsider','removed_creator')
  and (not p_private or v_actor=v_creator);
 v_allowed:=v_readable and p_actor in ('owner','admin','creator');
 perform pg_temp.path_claims('authenticated',v_actor);
 execute 'set local role authenticated';
 begin
  v_read:=public.qorpera_get_session_run_control(v_run.session_id);
 exception when others then get stacked diagnostics v_read_state=RETURNED_SQLSTATE;
 end;
 begin
  v_cancel:=public.qorpera_cancel_session_run(v_run.session_id,v_run.id);
 exception when others then get stacked diagnostics v_cancel_state=RETURNED_SQLSTATE;
 end;
 execute 'reset role';
 if v_readable then
  perform pg_temp.wake_assert(v_read_state is null and v_read#>>'{run,run_id}'=v_run.id::text
   and v_read#>>'{run,status}'='leased','Readable control identifies the actual active native run');
  perform pg_temp.wake_assert((v_read#>>'{run,can_cancel}')::boolean=v_allowed,
   'Stop visibility matches current cancellation authority');
 else
  perform pg_temp.wake_assert(v_read_state='42501' and v_read is null,
   'Outsiders and other private audiences cannot read run state');
 end if;
 if v_allowed then
  perform pg_temp.wake_assert(v_cancel_state is null and v_cancel->>'run_id'=v_run.id::text
   and v_cancel->>'status'='cancelled','An available Stop cancels that exact run');
  perform pg_temp.wake_assert((select status='cancelled' and lease_token_sha256 is null
   and cancelled_by_user_id=v_actor from public.qorpera_runner_jobs where id=v_run.job_id),
   'Cancellation clears execution authority and retains its actor');
  perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_native_provider_connection_leases
   where run_id=v_run.id and status='active'),'Cancellation releases the native lease');
 else
  perform pg_temp.wake_assert(v_cancel_state='42501' and v_cancel is null,'Unavailable Stop is also denied by the RPC');
  perform pg_temp.wake_assert((select to_jsonb(job)=v_job_before from public.qorpera_runner_jobs job where id=v_run.job_id),
   'Denied cancellation leaves the run unchanged');
 end if;
 perform pg_temp.wake_assert(not exists(select 1 from public.qorpera_agent_sends where run_id=v_run.id),
  'Cancellation does not manufacture agent output');
end $$;

select pg_temp.wake_acceptance_case('session_stop_shared_'||actor,
 format('select pg_temp.review_stop_authority(%L)',actor))
from unnest(array['owner','admin','creator','contributor','viewer','outsider','viewer_creator','removed_creator']) actor;
select pg_temp.wake_acceptance_case('session_stop_private_'||actor,
 format('select pg_temp.review_stop_authority(%L,true)',actor))
from unnest(array['owner','admin','creator','viewer_creator']) actor;
