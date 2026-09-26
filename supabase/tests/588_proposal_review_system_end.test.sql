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
-- called the model yet ('idle'), has a model call in flight ('calling') or has
-- finished one ('called').
create function pg_temp.live_review(p_company jsonb, p_lease text) returns jsonb language plpgsql as $$
declare proposal uuid; job public.qorpera_runner_jobs%rowtype; claim jsonb; runner uuid := extensions.gen_random_uuid();
 assignment uuid := extensions.gen_random_uuid(); request uuid := extensions.gen_random_uuid(); i integer;
begin
 proposal := pg_temp.queue_review(p_company);
 perform pg_temp.queue_auth();
 perform public.qorpera_materialize_company_proposal_review_runs(32);
 job := pg_temp.review_job(proposal);
 perform pg_temp.queue_assert(job.status = 'queued', 'review job was not queued');
 if p_lease <> 'none' then
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
 if p_lease in ('calling', 'called') then
  execute 'set local role service_role';
  perform pg_temp.queue_assert(public.qorpera_runner_broker_reserve_model_request(runner,repeat('d',64),job.id,
   repeat('b',64),request,'openai','gpt-test',repeat('9',64),1000,1000)->>'state' = 'reserved',
   'gateway call was not reserved');
  if p_lease = 'called' then
   perform public.qorpera_runner_broker_finalize_model_request(runner,repeat('d',64),job.id,repeat('b',64),
    request,repeat('9',64),'completed',10,5,5,'{"output":"ok"}',null);
  end if;
  execute 'reset role';
 end if;
 return jsonb_build_object('proposal',proposal,'job',job.id,'run',job.run_id,'runner',runner,'assignment',assignment,
  'lease',p_lease);
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
 perform pg_temp.queue_auth();
 perform pg_temp.queue_assert((select status = 'rejected' from public.qorpera_company_proposals where id = p_proposal),
  'proposal was not rejected');
end $$;

-- The job ended 'failed' for its reason, fenced from its runner, and the review
-- with it; nothing reads it as a member's Stop or asks anyone to act on it.
create function pg_temp.assert_system_end(p_company jsonb, p_live jsonb, p_reason text)
returns void language plpgsql as $$
declare job public.qorpera_runner_jobs%rowtype; expected text; lease text := p_live->>'lease';
begin
 select * into strict job from public.qorpera_runner_jobs where id = (p_live->>'job')::uuid;
 -- A model call is output of the attempt: the job's error says so.
 expected := p_reason || case when lease in ('calling', 'called') then '; durable attempt output requires review' else '' end;
 perform pg_temp.queue_assert(job.status = 'failed' and job.finished_at is not null
  and job.cancelled_at is null and job.cancelled_by_user_id is null and job.last_error = expected,
  'system end of a review job is not a failure with its reason: ' || row_to_json(job)::text);
 perform pg_temp.queue_assert(job.lease_token_sha256 is null and job.lease_expires_at is null
  and job.terminal_lease_token_sha256 is not distinct from case when lease <> 'none' then repeat('b',64) end
  and job.attempt_count = case when lease <> 'none' then 1 else 0 end,
  'system end left runner authority or re-queued the review');
 -- A review run writes nothing, so the review (shown next to its reviewer) keeps the plain reason.
 perform pg_temp.queue_assert((select review.status = 'failed' and review.completed_at is not null
   and review.failure_reason = p_reason
  from public.qorpera_company_proposal_review_assignments as review where review.run_id = job.run_id),
  'review assignment did not fail with the plain reason');
 perform pg_temp.queue_assert(exists(select 1 from public.qorpera_execution_run_events
   where run_id = job.run_id and event_type = 'failed' and payload->>'error' = expected)
  and not exists(select 1 from public.qorpera_execution_run_events where run_id = job.run_id and event_type = 'cancelled'),
  'run history does not record the failure');
 -- Unknown gateway spend settles at the reserved ceiling, known spend at its cost.
 perform pg_temp.queue_assert((select status = 'settled' and actual_microusd = case lease
   when 'calling' then reserved_microusd when 'called' then 5 else 0 end
  from public.qorpera_execution_sponsor_reservations where run_id = job.run_id),
  'review budget reservation was not settled');
 perform pg_temp.queue_assert((select coalesce(jsonb_agg(payload->>'reason' order by id), '[]')
  from public.qorpera_execution_run_events where run_id = job.run_id and event_type = 'review_pending')
  = case lease when 'calling' then '["ambiguous_model_usage"]' when 'called' then '["partial_attempt_output"]'
   else '[]' end::jsonb, 'attempt output was not flagged exactly as it happened');
 perform pg_temp.queue_assert((select coalesce(jsonb_agg(status), '[]') from public.qorpera_runner_model_requests
  where job_id = job.id) = case lease when 'calling' then '["ambiguous"]' when 'called' then '["completed"]'
   else '[]' end::jsonb, 'gateway call was not quarantined, or a finished one was changed');
 if lease <> 'none' then
  perform pg_temp.queue_assert((select status = 'failed' and last_error = expected
   from public.qorpera_runner_assignments where id = (p_live->>'assignment')::uuid),
   'runner assignment stayed accepted');
  execute 'set local role service_role';
  begin
   perform public.qorpera_runner_broker_reserve_model_request((p_live->>'runner')::uuid,repeat('d',64),job.id,
    repeat('b',64),extensions.gen_random_uuid(),'openai','gpt-test',repeat('8',64),1000,1000);
   raise exception 'runner kept model authority after the system ended its review';
  exception when sqlstate 'PGRST' then
   if sqlerrm not like '%runner job lease is unavailable%' then raise; end if;
  end;
  execute 'reset role';
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

-- 6. A member rejects the proposal after its runner called the model. The
-- decided proposal shows the review with the plain reason.
savepoint closed_called;
do $$
declare a jsonb := current_setting('queue.a')::jsonb; live jsonb; shown jsonb;
begin
 live := pg_temp.live_review(a, 'called');
 perform pg_temp.reject(a, (live->>'proposal')::uuid);
 perform pg_temp.assert_system_end(a, live, 'Proposal review was closed before this assignment completed');
 select public.qorpera_company_proposal_json(proposal) -> 'reviews' into strict shown
 from public.qorpera_company_proposals as proposal where proposal.id = (live->>'proposal')::uuid;
 perform pg_temp.queue_assert(jsonb_array_length(shown) = 1 and shown->0->>'status' = 'failed'
  and shown->0->>'failure_reason' = 'Proposal review was closed before this assignment completed',
  'decided proposal does not show the review with its plain reason: ' || shown::text);
end $$;
rollback to savepoint closed_called;

rollback;
