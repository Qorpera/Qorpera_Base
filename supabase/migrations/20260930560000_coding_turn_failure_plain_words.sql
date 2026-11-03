-- A failed coding turn reads as its own, in plain words (live company-building test, 3 Nov 2026). Every new or patched
-- body carries the marker 20260930560000.
--
-- Coding session 27038e92's second turn (run ef40b893) worked for eleven minutes in its worktree, then ChatGPT answered
-- Codex's request with its own "server overloaded" error (the host's journal: codexError=serverOverloaded), and the
-- native adapter recorded a provider_outage usage signal for the run. The turn's files were all saved in the company
-- folder (code/<owner>/<repo>/worktrees/<workerId>/), where the session's next turn finds them as they are. Yet:
-- * the agent read "The coding turn did not finish: Native provider bridge request failed (422)
--   [code=NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED]; durable attempt output requires review", and the Co-Founder
--   relayed "422 NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED" to the founder;
-- * the coding run is the Co-Founder's run (a wake of the same agent), so the conversation also showed it as
--   "An earlier run of Co-Founder did not finish", next to the coding session's own card for the same failure.
--
-- Now:
-- * qorpera_coding_turn_failure(worker, summary): a turn whose own run ended failed with a provider_outage signal for
--   the version it pays with, from an attempt that was not paused or cut off afterwards (549300's rule for usage
--   limits), reports reason provider_outage and fixed words: ChatGPT was overloaded or had a server error; usually
--   brief; the login is fine. Any other failure the executor reported with its run's error ("The coding turn did not
--   finish: ..." or a summary carrying a [code=...]) reports fixed words for the code's class instead of that text, and
--   keeps the code as its reason (the worker's result, the turn's outcome, the failed event's `code`, the view). Every
--   such summary ends by saying the files are kept and a follow-up continues from them. A login's words (551000) that
--   carry the turn's own report carry these words, not the executor's. Summaries the executor writes in plain words
--   (no submission, stopped, a refused save or push, a workspace that could not be prepared) stay as they are.
-- * qorpera_list_staff_execution_activity: a failed wake run that is a coding session's turn (its occurrence is a turn
--   row's) is no longer listed as its agent's failure. The coding session's card says why the turn failed; nothing
--   else of the activity changes (a running coding turn still reads as its agent working, and a coding run still
--   supersedes the agent's older failures, 20260930542000).
--
-- Locks: none added; both read without locks as before. Test 560 (553 §1 and §6 now expect the words).
set local lock_timeout = '3s';

-- A second run stops here, and so does a body that is not 551000's.
do $$ begin
	if position('20260930560000' in pg_get_functiondef(
			'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure)) > 0
		or position('20260930560000' in pg_get_functiondef(
			'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0 then
		raise exception 'The coding turn failure words (20260930560000) are already applied'; end if;
	if position('20260930551000' in pg_get_functiondef(
			'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure)) = 0 then
		raise exception 'qorpera_coding_turn_failure is not 20260930551000''s'; end if;
end $$;

-- What a failed coding turn reports, as {reason, summary} (20260930551000; plain words 20260930560000). p_summary is
-- the executor's.
create or replace function public.qorpera_coding_turn_failure(p_worker public.qorpera_runtime_workers, p_summary text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_state text := public.qorpera_coding_session_login_state(p_worker); v_occurrence uuid; v_usage text;
	v_wake public.qorpera_wake_occurrences%rowtype; v_job public.qorpera_runner_jobs%rowtype; v_code text; v_login text;
	v_run public.qorpera_execution_runs%rowtype; v_report text := p_summary; v_outage boolean;
	-- The same tail for every login reason: the payer never changes without the member (20260930059000).
	v_tail constant text := ' The session does not move to another login by itself: the member who owns it can choose '
		|| 'another of their logins for it on the coding session''s card in the conversation, then ask for the work again.';
	-- 20260930560000: the turn's files stay in its worktree (a present worktree is kept as it is, code-host-jobs.ts).
	v_kept constant text := ' The files the turn wrote stay in the session''s workspace as it left them; a follow-up turn '
		|| 'continues from them.';
begin
	-- 20260930551000; 20260930560000.
	select turn.occurrence_id into v_occurrence from public.qorpera_coding_session_turns as turn
	where turn.worker_id = p_worker.id and turn.sequence = p_worker.sequence;
	if v_occurrence is not null then
		select * into v_wake from public.qorpera_wake_occurrences where id = v_occurrence;
		if v_wake.run_id is not null then
			select * into v_run from public.qorpera_execution_runs where id = v_wake.run_id;
			select job.* into v_job from public.qorpera_runner_jobs as job where job.id = v_run.job_id;
		end if;
	end if;
	-- 20260930560000: the failure's own code, as before: the [code=...] of the summary or of the run's last error, else
	-- what the turn's rows say.
	v_code := coalesce(substring(p_summary from '\[code=([A-Za-z0-9_.:-]{1,120})\]'),
		substring(v_job.last_error from '\[code=([A-Za-z0-9_.:-]{1,120})\]'),
		case when v_occurrence is null then 'turn_not_begun'
			when v_wake.run_id is null then 'run_not_started'
			when v_job.status = 'completed' then 'ended_without_submission'
			when v_job.status = 'cancelled' then 'stopped'
			else 'turn_failed' end);
	-- 20260930560000: the executor's report of its run's error names machinery (the bridge, its HTTP status, the code),
	-- so the agent reads the code's class in plain words instead; its other reports are plain already.
	-- Its run failed with the model provider's outage (Codex's serverOverloaded or internalServerError, or a 5xx answer:
	-- nativeRuntimeUsageSignal), recorded for the version the run pays with by an attempt that was not paused or cut off
	-- afterwards (549300's rule for usage limits): the provider's, usually brief, and the login is fine.
	v_outage := v_job.status = 'failed' and exists (select 1 from public.qorpera_provider_connection_usage_signals as recorded
		where recorded.run_id = v_run.id and recorded.sponsor_version = v_run.sponsor_version
			and recorded.signal_kind = 'provider_outage'
			and not exists (select 1 from public.qorpera_execution_run_events as resumed
				where resumed.run_id = v_run.id and resumed.event_type in ('run_paused', 'run_cut_off')
					and resumed.payload ->> 'assignmentId' = recorded.assignment_id::text));
	if v_outage then
		v_report := 'ChatGPT was overloaded or had a server error while Codex worked, so the coding turn stopped. This is '
			|| 'usually brief, and the login that pays for it is fine.' || v_kept;
	elsif v_job.id is not null and (p_summary like 'The coding turn did not finish:%' or p_summary ~ '\[code=') then
		v_report := case
			when v_job.status = 'failed' and v_code = 'NATIVE_CODEX_TURN_COMPLETION:PROVIDER_FAILED' then
				'ChatGPT refused or could not answer Codex''s request, so the coding turn stopped. The member whose login '
				|| 'pays for this session can check that login in Settings, AI subscriptions.'
			-- The runtime's own codes that name what happened, not machinery (the web's run-failure.ts reads them so).
			when v_code = 'CODING_TURN_ENDED_WITHOUT_SUBMISSION' then
				'The coding turn ended without saving its work or asking a question.'
			when v_code = 'COMPUTER_HOURS_EXHAUSTED' then
				'The company ran out of computer hours, so the coding turn stopped. It can go on once hours are added.'
			when v_code = 'RUN_COMPLETION_REFUSED' then
				'The coding turn ended, but one of its saves did not finish, so a person must check it first.'
			when v_code ~ ':CANCELLED$' then 'Qorpera lost contact with the coding turn, so it stopped.'
			when v_code ~ '(^|:|_)(TIMEOUT|TIMED_OUT)$' then
				'One of the coding turn''s steps got no answer in time, so the turn stopped.'
			when v_code ~ ':TRANSPORT_UNAVAILABLE$' then
				'The coding turn lost its connection while it worked, so it stopped. This is usually brief.'
			when v_code ~ '^NATIVE_CREDENTIAL_DOWNLOAD(:|$)' then
				'The coding turn could not load the login that pays for it. The member whose login it is can check it '
				|| 'in Settings, AI subscriptions.'
			else 'The coding turn stopped because of a problem on Qorpera''s side.' end || v_kept;
	end if;
	-- 1. The session's login cannot pay: its next turn would fail the same way, whatever ended this one. A turn whose
	-- own run ran keeps what it reported of it after the words, when both fit.
	if v_state is not null and v_state <> 'ready' then
		v_login := case v_state
			when 'removed' then 'This coding session''s login was removed (signed out), so its turn could not run.'
			when 'disabled' then 'This coding session''s login was turned off by an owner or admin, so its turn could not run. '
				|| 'It can run again once they turn the login back on.'
			when 'needs_sign_in' then 'This coding session''s login needs a new sign-in, so its turn could not run. '
				|| 'The member can sign in to it again in Settings, AI subscriptions.'
			when 'not_allowed_away' then 'This coding session''s login no longer allows work while its member is away, so its '
				|| 'turn could not run. Once the member allows it again (Settings, AI subscriptions), they can choose it again '
				|| 'for this session on its card.'
			else 'This coding session''s login cannot pay for work right now, so its turn could not run.' end || v_tail;
		if v_wake.run_id is not null and octet_length(v_login || ' The turn''s own report: ' || v_report) <= 4000 then
			v_login := v_login || ' The turn''s own report: ' || v_report; end if;
		return jsonb_build_object('reason', 'login_' || v_state, 'summary', v_login);
	end if;
	-- 2. Its run stopped at the login's usage limit (20260930549300): those words, with the session's own place to choose.
	v_usage := public.qorpera_worker_usage_limit_text(v_occurrence);
	if v_usage is not null then
		return jsonb_build_object('reason', 'usage_limit', 'summary', replace(v_usage,
			'choose another of their logins for it (in the conversation''s Login menu)',
			'choose another of their logins for it (on the coding session''s card in the conversation)'));
	end if;
	-- 3. The wake never became a run because its payer had no authority at admission (a race with a sign-in, or a
	-- check the state above does not make): the login is the reason.
	if v_wake.id is not null and v_wake.run_id is null and v_wake.status in ('cancelled', 'failed', 'expired')
		and v_wake.blocked_reason in ('Wake execution authority is unavailable', 'Wake compute authority is unavailable') then
		return jsonb_build_object('reason', 'login_unavailable', 'summary',
			'This coding session''s login cannot pay for work right now, so its turn could not run.' || v_tail);
	end if;
	-- 4. 20260930560000: its run failed with the model provider's outage (above).
	if v_outage then return jsonb_build_object('reason', 'provider_outage', 'summary', v_report); end if;
	-- 5. Anything else: its own code, with the summary in plain words when the executor's named machinery.
	return jsonb_build_object('reason', v_code, 'summary', v_report);
end
$$;
revoke all on function public.qorpera_coding_turn_failure(public.qorpera_runtime_workers, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The activity: a coding session's turn is not its agent's failure.
create function pg_temp.coding_turn_failure_20260930560000_patch(p_function regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare
	v_definition text := pg_get_functiondef(p_function);
	v_count integer := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
begin
	if v_count <> 1 then raise exception '% source differs (anchor matches % times)', p_function, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

select pg_temp.coding_turn_failure_20260930560000_patch('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	$a1$						where occurrence.run_id = run.id and occurrence.status in ('failed', 'requires_review')
					) and not exists ($a1$,
	$r1$						where occurrence.run_id = run.id and occurrence.status in ('failed', 'requires_review')
							-- 20260930560000: a coding session's turn fails on the session's own card, not as its agent's.
							and not exists (select 1 from public.qorpera_coding_session_turns as coding
								where coding.occurrence_id = occurrence.id)
					) and not exists ($r1$);
