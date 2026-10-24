-- 20260930533000: one Stop ends a whole chain of agent work (2026-10-22 amendment, item 4; contract 14.6).
--
-- A member's Stop in a conversation (qorpera_cancel_session_run, 20260926183100) ended one run. A loop between two agents
-- went on through the other agent's wake: Alice's run messages Bob, Bob's run answers Alice, and stopping either run left
-- the other's queued wake to carry the loop. Every run of a chain has a wake whose causal_root_id the pin trigger sets: a
-- member's post, a routine's slot, a first run and a card answer start a new root (their own wake); a coworker message, a
-- worker's start and report, a machine event and a file change a run made carry their parent run's root.
--
-- 1. qorpera_stopped_chains records a stopped root: who stopped it, the run they named, when.
-- 2. The conversation Stop takes the chain's lock (an advisory lock on the profile and root) before it locks the job it
--    names, so two Stops of one chain run one after the other instead of each holding a job the other needs. After the
--    member's own cancel (who may stop is unchanged) it calls qorpera_stop_run_chain:
--    a. it records the root;
--    b. it cancels every wake of the root still queued that no one holds (a coworker message that has not woken anyone,
--       a worker's start not yet run); one the materializer holds is refused by it (3);
--    c. it cancels every other live run of the root through the cancel's own terminal step and audit, recording the
--       member, but only a run the member could stop alone (they may write its conversation, and they created its job
--       or are an owner or admin);
--    d. it withdraws the held messages a run of the chain sent that no live run has read (they would be read at the
--       recipient's next wake); the pair transcript keeps them;
--    e. it adds one session_info event, qorpera.chain-stopped/v1, to each open conversation where a run of the chain
--       raised a card, naming the cards: they stay open and the web says their chain was stopped.
--    A Stop on a run that already ended still ends its chain when the member may stop that run; a retried Stop finds
--    nothing left to cancel and adds no second note.
-- 3. The chain stays stopped: the pin trigger cancels a new wake whose root is stopped at admission (as the company pause
--    does). A wake admitted beside a Stop, before its record was visible, meets the materializer, the one step that
--    makes wakes runs: its update takes the chain's lock shared without waiting. While a Stop holds the lock the update
--    raises 55P03 and the materializer leaves the wake queued for its next pass; once the Stop committed, a stopped root
--    raises 42501 and the materializer cancels the wake with the reason. A materializer that took the lock first holds
--    it until it commits, so the Stop waits for it and then finds the new run in (c). The materializer never waits on
--    a Stop, and a Stop takes the lock before any other, so neither waits on the other in a cycle.
--    The steps that carry a parent run's machine events and check-ins (qorpera_folder_parent_continuation) and its
--    office start (qorpera_folder_office_wakes_company) treat a parent whose chain was stopped as stopped, so they put
--    their items away instead of trying a wake that admission cancels on every pass.
-- 4. An outside action already sent keeps its receipt: nothing here touches run receipts, the mail outbox or effects.
-- 5. An answer to a card of a stopped chain starts a new reviewed run instead of reviving the stopped one:
--    qorpera_answer_action_review wakes the agent whenever the card's run has ended (before, an answer given within the
--    holder's 10 s heartbeat went to a holder that no longer runs), and qorpera_wake_origin gives the approval's run no
--    origin when the card's chain was stopped, so its review reads the answer, not the stopped chain's request.
-- A worker's own Stop (qorpera_cancel_worker_run, 2026-10-03) still ends that run alone, and its parent hears.
--
-- The edited functions are patched in place through their current text, so each keeps its ACL. Deploy order: either; the
-- web reads the new event when it exists.

set local lock_timeout = '3s';

create table public.qorpera_stopped_chains (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	causal_root_id uuid not null,
	stopped_run_id uuid not null references public.qorpera_execution_runs(id) on delete cascade,
	stopped_by_user_id uuid references auth.users(id) on delete set null,
	stopped_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, causal_root_id)
);
alter table public.qorpera_stopped_chains enable row level security;
revoke all on table public.qorpera_stopped_chains from public, anon, authenticated, service_role;

-- The chain's wakes and runs, by root.
create index qorpera_wake_occurrences_causal_root on public.qorpera_wake_occurrences(profile_id, causal_root_id)
	where causal_root_id is not null;

-- The chain's lock: a Stop takes it before any job lock, the materializer takes it shared without waiting.
create function public.qorpera_causal_chain_key(p_profile_id uuid, p_root uuid)
returns bigint language sql immutable set search_path = '' as $$
	select pg_catalog.hashtextextended('qorpera.causal-chain:' || p_profile_id::text || ':' || p_root::text, 0)
$$;
create function public.qorpera_causal_chain_stopped(p_profile_id uuid, p_root uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_root is not null and exists (select 1 from public.qorpera_stopped_chains stopped
		where stopped.profile_id = p_profile_id and stopped.causal_root_id = p_root)
$$;
create function public.qorpera_run_chain_stopped(p_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences wake
		where wake.run_id = p_run_id and public.qorpera_causal_chain_stopped(wake.profile_id, wake.causal_root_id))
$$;

-- Ends the chain of the run a member just stopped (or tried to stop after it ended), as that member. Called by the
-- conversation Stop once its own checks passed; answers what it did, or null for a run with no chain.
create function public.qorpera_stop_run_chain(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid(); v_wake public.qorpera_wake_occurrences%rowtype; v_role public.qorpera_profile_role;
	v_reason constant text := 'A member stopped this chain of agent work';
	v_recorded boolean; v_wakes integer; v_jobs uuid[]; v_job_id uuid; v_job public.qorpera_runner_jobs%rowtype;
	v_runs uuid[];
	v_held integer; v_notes integer := 0; v_card record;
begin
	select wake.* into v_wake from public.qorpera_wake_occurrences wake where wake.run_id = p_run_id;
	if v_user is null or v_wake.causal_root_id is null then return null; end if;
	-- The Stop took it before its job; taken again it is the same lock.
	perform pg_advisory_xact_lock(public.qorpera_causal_chain_key(v_wake.profile_id, v_wake.causal_root_id));
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = v_wake.profile_id and member.user_id = v_user;
	-- a. The root, first: from here on the chain admits nothing new.
	insert into public.qorpera_stopped_chains(profile_id, causal_root_id, stopped_run_id, stopped_by_user_id)
	values (v_wake.profile_id, v_wake.causal_root_id, p_run_id, v_user) on conflict do nothing;
	v_recorded := found;
	-- b. Its wakes still queued. One a step holds (the materializer making it a run) is left to it: the materializer
	-- refuses it, or it took the chain's lock first and the Stop found its run already.
	update public.qorpera_wake_occurrences set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = v_reason
	where id in (select wake.id from public.qorpera_wake_occurrences wake
		where wake.profile_id = v_wake.profile_id and wake.causal_root_id = v_wake.causal_root_id and wake.status = 'queued'
		order by wake.id for update skip locked);
	get diagnostics v_wakes = row_count;
	-- c. Its other live runs, each one the member could stop alone, in job order.
	select array_agg(s.id order by s.id) into v_jobs from (
		select job.id from public.qorpera_wake_occurrences wake
		join public.qorpera_execution_runs run on run.id = wake.run_id
		join public.qorpera_runner_jobs job on job.id = run.job_id and job.run_id = run.id
		where wake.profile_id = v_wake.profile_id and wake.causal_root_id = v_wake.causal_root_id
			and job.profile_id = v_wake.profile_id and job.status in ('queued', 'leased')
			and v_role in ('owner', 'admin', 'contributor')
			and (v_role in ('owner', 'admin') or job.created_by_user_id = v_user)
			and (job.session_id is null or public.qorpera_can_write_session(job.session_id))
		order by job.id for update of job) s;
	foreach v_job_id in array coalesce(v_jobs, '{}'::uuid[]) loop
		select job.* into strict v_job from public.qorpera_runner_jobs job where job.id = v_job_id;
		continue when v_job.status not in ('queued', 'leased');
		perform public.qorpera_terminalize_runner_attempt(v_job.id, 'cancelled', v_reason, false);
		perform public.qorpera_append_runner_audit(v_job.profile_id, v_job.runner_id, v_job.id, 'job_cancelled',
			jsonb_build_object('chainRootId', v_wake.causal_root_id, 'stoppedRunId', p_run_id), v_user);
	end loop;
	-- d. Held messages a run of the chain sent that no live run has read.
	select array_agg(wake.run_id) into v_runs from public.qorpera_wake_occurrences wake
	where wake.profile_id = v_wake.profile_id and wake.causal_root_id = v_wake.causal_root_id and wake.run_id is not null;
	delete from public.qorpera_pending_peer_messages pending
	using public.qorpera_session_events event
	where pending.profile_id = v_wake.profile_id and event.event_id = pending.event_id
		and event.session_id = pending.pair_session_id
		and (event.body #>> '{entry,delivery,runId}') = any(v_runs::text[])
		and (pending.delivered_run_id is null or exists (select 1 from public.qorpera_execution_runs run
			join public.qorpera_runner_jobs job on job.id = run.job_id
			where run.id = pending.delivered_run_id and job.status in ('failed', 'cancelled')));
	get diagnostics v_held = row_count;
	-- e. The chain's cards stay open; each open conversation that holds some is told, once.
	if v_recorded then
		for v_card in select event.session_id, jsonb_agg(event.event_id order by event.sequence) as card_ids
			from public.qorpera_session_events event
			join public.qorpera_shared_sessions session on session.id = event.session_id and session.status = 'open'
			where event.execution_kind = 'run' and event.execution_id = any(v_runs)
				and event.event_type in ('interaction_request', 'authorization_request')
			group by event.session_id order by event.session_id
		loop
			perform public.qorpera_append_kernel_session_event(v_card.session_id, extensions.gen_random_uuid(), 'session_info',
				v_user, jsonb_build_object('schema', 'qorpera.chain-stopped/v1', 'cardIds', v_card.card_ids,
					'stoppedRunId', p_run_id, 'stoppedByUserId', v_user));
			v_notes := v_notes + 1;
		end loop;
	end if;
	return jsonb_build_object('chainRootId', v_wake.causal_root_id, 'recorded', v_recorded,
		'cancelledRuns', coalesce(cardinality(v_jobs), 0), 'cancelledWakes', v_wakes, 'withdrawnMessages', v_held,
		'cardNotes', v_notes);
end
$$;
revoke all on function public.qorpera_causal_chain_key(uuid, uuid), public.qorpera_causal_chain_stopped(uuid, uuid),
	public.qorpera_run_chain_stopped(uuid), public.qorpera_stop_run_chain(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 3. The materializer's update of a wake with an older root (one with a parent run): the chain's lock shared, without
-- waiting (55P03 leaves the wake queued for the next pass), then a stopped root refuses (42501 cancels it).
create function public.qorpera_refuse_stopped_chain_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if old.status = 'queued' and new.status = 'materialized' and new.parent_run_id is not null
		and new.causal_root_id is not null then
		if not pg_try_advisory_xact_lock_shared(public.qorpera_causal_chain_key(new.profile_id, new.causal_root_id)) then
			raise exception 'A member is stopping this chain of agent work' using errcode = '55P03'; end if;
		if public.qorpera_causal_chain_stopped(new.profile_id, new.causal_root_id) then
			raise exception 'A member stopped this chain of agent work' using errcode = '42501'; end if;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_refuse_stopped_chain_run() from public, anon, authenticated, service_role;
create trigger qorpera_wake_chain_stopped before update of status on public.qorpera_wake_occurrences
	for each row execute function public.qorpera_refuse_stopped_chain_run();

create function pg_temp.chain_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Chain Stop patch differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- 2. The conversation Stop takes the chain's lock before the job it names, and ends the run's chain.
select pg_temp.chain_patch('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)',
	$old$	select job.* into v_job
	from public.qorpera_runner_jobs as job$old$,
	$new$	-- 20260930533000: the run's chain lock first, so two Stops of one chain never hold a job the other waits for.
	perform pg_advisory_xact_lock(public.qorpera_causal_chain_key(wake.profile_id, wake.causal_root_id))
	from public.qorpera_execution_runs as run join public.qorpera_wake_occurrences as wake on wake.run_id = run.id
	where run.id = p_run_id and run.session_id = v_session.id and run.profile_id = v_session.profile_id
		and wake.causal_root_id is not null;
	select job.* into v_job
	from public.qorpera_runner_jobs as job$new$);
select pg_temp.chain_patch('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)',
	$old$	return jsonb_build_object('session_id', p_session_id, 'run_id', p_run_id, 'status', v_job.status);$old$,
	$new$	-- 20260930533000 (2026-10-22 amendment, item 4): one Stop ends the run's whole chain. A late click, on a run that
	-- ended first, still ends it: the cancel above is not redirected, but the chain is the member's to stop. A retry
	-- finds nothing left to end.
	perform public.qorpera_stop_run_chain(p_run_id);
	return jsonb_build_object('session_id', p_session_id, 'run_id', p_run_id, 'status', v_job.status);$new$);

-- 3. A new wake of a stopped chain is cancelled at admission, as the company pause's is.
select pg_temp.chain_patch('public.qorpera_pin_wake_occurrence()',
	$old$	-- The company pause (the operator brake) holds at admission$old$,
	$new$	-- 20260930533000: a chain a member stopped stays stopped. Only a wake with a parent run carries an older root.
	if new.status = 'queued' and new.parent_run_id is not null
		and public.qorpera_causal_chain_stopped(new.profile_id, new.causal_root_id) then
		new.status := 'cancelled'; new.finished_at := clock_timestamp();
		new.blocked_reason := 'A member stopped this chain of agent work';
		return new;
	end if;
	-- The company pause (the operator brake) holds at admission$new$);

-- 5. An answer wakes the agent once the card's run has ended; an approval of a stopped chain's card carries no origin.
select pg_temp.chain_patch('public.qorpera_answer_action_review(uuid,uuid,text,text,uuid,bigint)',
	$old$	v_wake := v_review.held_until is null or v_review.held_until < clock_timestamp();$old$,
	$new$	-- 20260930533000: a run that ended (a member stopped it or its chain) holds nothing, whatever its last heartbeat said.
	v_wake := v_review.held_until is null or v_review.held_until < clock_timestamp() or not exists (
		select 1 from public.qorpera_execution_runs run join public.qorpera_runner_jobs job on job.id = run.job_id
		where run.id = v_review.run_id and job.status in ('queued', 'leased'));$new$);
select pg_temp.chain_patch('public.qorpera_wake_origin(public.qorpera_wake_occurrences)',
	$old$		and card.staff_agent_id = p_wake.staff_agent_id and card.requested_by_user_id = p_wake.requested_by_user_id$old$,
	$new$		and card.staff_agent_id = p_wake.staff_agent_id and card.requested_by_user_id = p_wake.requested_by_user_id
		-- 20260930533000: the answer to a stopped chain's card starts new work, reviewed against the answer.
		and not public.qorpera_causal_chain_stopped(card.profile_id, card_wake.causal_root_id)$new$);

-- 3. A parent whose chain was stopped is stopped for the steps that continue it: its machine events and check-ins are put
-- away, and its office start's waiter is cancelled, instead of a wake that admission cancels on every pass.
select pg_temp.chain_patch('public.qorpera_folder_parent_continuation(uuid,text)',
	$old$		else public.qorpera_machine_revival_stopped(v_run.id) end) then return 'stopped'; end if;$old$,
	$new$		else public.qorpera_machine_revival_stopped(v_run.id) end)
		-- 20260930533000: a parent whose chain a member stopped.
		or public.qorpera_run_chain_stopped(v_run.id) then return 'stopped'; end if;$new$);
select pg_temp.chain_patch('public.qorpera_folder_office_wakes_company(uuid,integer)',
	$old$			if v_job_status in ('failed', 'cancelled') or v_intent.state = 'cancelled'$old$,
	$new$			if v_job_status in ('failed', 'cancelled') or v_intent.state = 'cancelled'
				-- 20260930533000: a parent whose chain a member stopped.
				or public.qorpera_run_chain_stopped(v_parent.id)$new$);
