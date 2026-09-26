-- @fixture 335_runtime_session_queue_isolation.test.sql until "-- END QUEUE FIXTURE"
-- The system ends a proposal review's job in two places: a newer proposal
-- revision supersedes the review (qorpera_seed_company_proposal_reviews), and a
-- decided proposal closes it (qorpera_runner_proposal_wake_status). No member
-- stopped that run, so the job ends 'failed' with its reason, like any other
-- system end, and never 'cancelled', which the job table keeps for a member's
-- Stop (cancelled_at and cancelled_by_user_id).

create function pg_temp.review_job(p_proposal uuid)
returns public.qorpera_runner_jobs language sql stable as $$
	select job.* from public.qorpera_runner_jobs as job
	join public.qorpera_company_proposal_review_assignments as review on review.run_id = job.run_id
	where review.proposal_id = p_proposal and review.proposal_revision = 1
$$;

-- A review whose job is queued ('none'), or leased to a runner that has not
-- called the model yet ('idle') or has a model call in flight ('calling').
create function pg_temp.live_review(p_company jsonb, p_lease text) returns jsonb language plpgsql as $$
declare proposal uuid; job public.qorpera_runner_jobs%rowtype; claim jsonb; runner uuid := extensions.gen_random_uuid();
 assignment uuid := extensions.gen_random_uuid(); i integer;
begin
 proposal := pg_temp.queue_review(p_company);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_company_proposal_review_runs(32);
 job := pg_temp.review_job(proposal);
 perform pg_temp.queue_assert(job.status = 'queued', 'review job was not queued');
 if p_lease in ('idle', 'calling') then
  insert into public.qorpera_runners(id,profile_id,client_runner_id,display_name,runner_kind,capabilities,
   max_concurrency,status,platform,runner_version,activation_token_sha256,activation_expires_at,
   session_token_sha256,session_expires_at,registered_by_user_id,activated_at,last_seen_at)
  values(runner,job.profile_id,runner,'Review runner','qorpera_computer','["agent_turn"]',1,'active','linux-x64','0.1.0',
   repeat('c',64),statement_timestamp()+interval '1 hour',repeat('d',64),statement_timestamp()+interval '15 minutes',
   (p_company->>'owner')::uuid,statement_timestamp(),statement_timestamp());
  execute 'set local role service_role';
  for i in 1..4 loop
   claim := public.qorpera_claim_runner_job_for_orchestrator(pg_temp.queue_id(335,90),extensions.gen_random_uuid(),120);
   exit when claim->'work'->>'job_id' = job.id::text;
  end loop;
  perform pg_temp.queue_assert(claim->'work'->>'job_id' = job.id::text, 'review job was not claimable');
  perform public.qorpera_assign_runner_job(pg_temp.queue_id(335,90),(claim->>'claim_id')::uuid,runner,assignment,repeat('b',64),120);
  perform public.qorpera_accept_runner_assignment(runner,repeat('d',64),assignment,job.id,repeat('b',64));
  execute 'reset role';
  job := pg_temp.review_job(proposal);
  perform pg_temp.queue_assert(job.status = 'leased' and job.lease_token_sha256 = repeat('b',64),
   'review job was not leased');
 end if;
 if p_lease = 'calling' then
  -- A gateway call the runner reserved and has not finalized.
  insert into public.qorpera_runner_model_requests(job_id,profile_id,environment_id,runner_id,actor_user_id,
   authorized_by_user_id,client_request_id,provider,model,request_sha256,input_token_reservation,output_token_reservation)
  values(job.id,job.profile_id,job.environment_id,runner,(p_company->>'owner')::uuid,(p_company->>'owner')::uuid,
   extensions.gen_random_uuid(),'openai','gpt-test',repeat('9',64),1000,1000);
 end if;
 return jsonb_build_object('proposal',proposal,'job',job.id,'run',job.run_id,'assignment',assignment,'lease',p_lease);
end $$;

-- The rows qorpera_rebase_company_proposal writes for a new revision. The RPC
-- itself also needs a prepared, proven publication, which this fixture does not
-- model; the revision insert is what fires the review trigger.
create function pg_temp.revise(p_proposal uuid) returns bigint language plpgsql as $$
declare proposal public.qorpera_company_proposals%rowtype; snapshot uuid := extensions.gen_random_uuid(); revision bigint;
begin
 select * into strict proposal from public.qorpera_company_proposals where id = p_proposal;
 perform pg_temp.queue_auth(proposal.created_by_user_id);
 insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
  tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
 select snapshot,profile_id,environment_id,workspace_id,snapshot,repeat('e',64),2,3,0,0,created_by_user_id
 from public.qorpera_company_snapshots where id = proposal.proposal_snapshot_id;
 select max(existing.revision) + 1 into strict revision
 from public.qorpera_company_proposal_revisions as existing where existing.proposal_id = p_proposal;
 insert into public.qorpera_company_proposal_revisions(proposal_id,revision,base_snapshot_id,proposal_snapshot_id,
  change_kind,created_by_user_id)
 values(p_proposal,revision,proposal.base_snapshot_id,snapshot,'rebased',proposal.created_by_user_id);
 update public.qorpera_company_proposals set proposal_snapshot_id = snapshot where id = p_proposal;
 perform pg_temp.queue_auth();
 return revision;
end $$;

create function pg_temp.reject(p_company jsonb, p_proposal uuid) returns void language plpgsql as $$
declare snapshot uuid;
begin
 select proposal_snapshot_id into strict snapshot from public.qorpera_company_proposals where id = p_proposal;
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 perform public.qorpera_reject_company_proposal(p_proposal, snapshot);
 execute 'reset role';
 perform pg_temp.queue_assert((select status = 'rejected' from public.qorpera_company_proposals where id = p_proposal),
  'proposal was not rejected');
end $$;

-- The job ended 'failed' for its reason, fenced from its runner, and the review
-- with it; nothing reads it as a member's Stop or asks anyone to act on it.
create function pg_temp.assert_system_end(p_company jsonb, p_live jsonb, p_reason text)
returns void language plpgsql as $$
declare job public.qorpera_runner_jobs%rowtype; expected text; leased boolean := p_live->>'lease' <> 'none';
begin
 select * into strict job from public.qorpera_runner_jobs where id = (p_live->>'job')::uuid;
 -- A gateway call in flight is output of the attempt that someone must review.
 expected := p_reason || case when p_live->>'lease' = 'calling' then '; durable attempt output requires review' else '' end;
 perform pg_temp.queue_assert(job.status = 'failed' and job.finished_at is not null
  and job.cancelled_at is null and job.cancelled_by_user_id is null and job.last_error = expected,
  'system end of a review job is not a failure with its reason: ' || row_to_json(job)::text);
 perform pg_temp.queue_assert(job.lease_token_sha256 is null and job.lease_expires_at is null
  and job.terminal_lease_token_sha256 is not distinct from case when leased then repeat('b',64) end
  and job.attempt_count = case when leased then 1 else 0 end,
  'system end left runner authority or re-queued the review');
 perform pg_temp.queue_assert((select review.status = 'failed' and review.completed_at is not null
   and review.failure_reason = expected
  from public.qorpera_company_proposal_review_assignments as review where review.run_id = job.run_id),
  'review assignment did not fail with the job');
 perform pg_temp.queue_assert(exists(select 1 from public.qorpera_execution_run_events
   where run_id = job.run_id and event_type = 'failed' and payload->>'error' = expected)
  and not exists(select 1 from public.qorpera_execution_run_events where run_id = job.run_id and event_type = 'cancelled'),
  'run history does not record the failure');
 -- Unknown gateway spend settles at the reserved ceiling, otherwise at the usage.
 perform pg_temp.queue_assert((select status = 'settled'
   and actual_microusd = case when p_live->>'lease' = 'calling' then reserved_microusd else 0 end
  from public.qorpera_execution_sponsor_reservations where run_id = job.run_id),
  'review budget reservation was not settled');
 perform pg_temp.queue_assert((select count(*) = case when p_live->>'lease' = 'calling' then 1 else 0 end
  from public.qorpera_execution_run_events where run_id = job.run_id and event_type = 'review_pending'
   and payload->>'reason' = 'ambiguous_model_usage'), 'unknown gateway spend was not flagged exactly when a call was in flight');
 if p_live->>'lease' = 'calling' then
  perform pg_temp.queue_assert((select status = 'ambiguous' and error_code = 'gateway_outcome_unknown'
   from public.qorpera_runner_model_requests where job_id = job.id), 'in-flight gateway call was not quarantined');
 end if;
 if leased then
  perform pg_temp.queue_assert((select status = 'failed' and last_error = expected
   from public.qorpera_runner_assignments where id = (p_live->>'assignment')::uuid),
   'runner assignment stayed accepted');
 end if;
 perform pg_temp.queue_auth((p_company->>'owner')::uuid);
 execute 'set local role authenticated';
 perform pg_temp.queue_assert(not exists(
  select 1 from jsonb_array_elements(public.qorpera_list_staff_execution_activity(job.environment_id)) as activity
  where activity->>'run_id' = job.run_id::text), 'a review the system ended was listed as agent activity');
 execute 'reset role';
 perform pg_temp.queue_auth();
end $$;

-- 1. A newer revision supersedes a queued review. The new revision's review
-- starts normally, and the old one cannot be retried.
savepoint superseded_queued;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb; old_review uuid;
begin
 live := pg_temp.live_review(a, 'none');
 select id into strict old_review from public.qorpera_company_proposal_review_assignments
 where run_id = (live->>'run')::uuid;
 perform pg_temp.queue_assert(pg_temp.revise((live->>'proposal')::uuid) = 2, 'fixture revision is not 2');
 perform pg_temp.assert_system_end(a, live, 'Proposal review was superseded by a newer revision');
 perform pg_temp.queue_assert((select status = 'queued' from public.qorpera_company_proposal_review_assignments
  where proposal_id = (live->>'proposal')::uuid and proposal_revision = 2), 'new revision was not queued for review');
 perform public.qorpera_materialize_company_proposal_review_runs(32);
 perform pg_temp.queue_assert((select review.status = 'running' and job.status = 'queued'
  from public.qorpera_company_proposal_review_assignments as review
  join public.qorpera_runner_jobs as job on job.run_id = review.run_id
  where review.proposal_id = (live->>'proposal')::uuid and review.proposal_revision = 2),
  'new revision review did not start');
 perform pg_temp.queue_auth((a->>'owner')::uuid);
 execute 'set local role authenticated';
 begin
  perform public.qorpera_retry_company_proposal_review(old_review);
  raise exception 'superseded review was retried';
 exception when object_not_in_prerequisite_state then null;
 end;
 execute 'reset role';
end $$;
rollback to savepoint superseded_queued;

-- 2. A newer revision supersedes a review a runner has just started.
savepoint superseded_idle;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb;
begin
 live := pg_temp.live_review(a, 'idle');
 perform pg_temp.revise((live->>'proposal')::uuid);
 perform pg_temp.assert_system_end(a, live, 'Proposal review was superseded by a newer revision');
end $$;
rollback to savepoint superseded_idle;

-- 3. A newer revision supersedes a review while its runner calls the model.
savepoint superseded_calling;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb;
begin
 live := pg_temp.live_review(a, 'calling');
 perform pg_temp.revise((live->>'proposal')::uuid);
 perform pg_temp.assert_system_end(a, live, 'Proposal review was superseded by a newer revision');
end $$;
rollback to savepoint superseded_calling;

-- 4. A member rejects the proposal while its review is queued.
savepoint closed_queued;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb;
begin
 live := pg_temp.live_review(a, 'none');
 perform pg_temp.reject(a, (live->>'proposal')::uuid);
 perform pg_temp.assert_system_end(a, live, 'Proposal review was closed before this assignment completed');
end $$;
rollback to savepoint closed_queued;

-- 5. A member rejects the proposal while its runner calls the model.
savepoint closed_calling;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb;
begin
 live := pg_temp.live_review(a, 'calling');
 perform pg_temp.reject(a, (live->>'proposal')::uuid);
 perform pg_temp.assert_system_end(a, live, 'Proposal review was closed before this assignment completed');
end $$;
rollback to savepoint closed_calling;

rollback;
