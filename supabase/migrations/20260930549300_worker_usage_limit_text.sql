-- A worker stopped at a usage limit tells its agent so in plain words (live company-building test, 3 Nov 2026). Every
-- patched or new body carries the marker 20260930549300.
--
-- The Co-Founder followed up a coding session whose turn then failed: the login paying for the session had reached its
-- usage limit (100% of its weekly window), and by design the work never moves to another login. The executor reports
-- such a turn as "The coding turn did not finish: Native provider bridge request failed (422)
-- [code=NATIVE_CODEX_TURN_COMPLETION:BUDGET_EXHAUSTED]", and that was all the agent read (its results.md, manage_worker
-- status and its revival), so it told the founder it might be "an account limit or an internal configuration issue"
-- needing "platform support". An in-house worker stopped the same way read "The background work ended without
-- reporting a result."
--
-- Now, when the worker's run has a usage-limit signal for the login it runs on (qorpera_record_provider_usage_signal,
-- the same test as qorpera_coding_turn_usage_limit and the run recovery's usage_limit), the report's summary is fixed
-- wording, never provider text: the login paying for this work reached its usage limit; when it resets, if known; the
-- work does not move to another login by itself; the member can choose another of their logins for it (the
-- conversation's Login menu) or wait. The reset is the signal's resets_at when it is still ahead, else the latest reset
-- of the login's usage windows that are full (qorpera_native_provider_account_metadata of the connection version the
-- signal names), else unknown and left out.
-- * qorpera_worker_usage_limit_text(occurrence): that text for a worker run's wake occurrence, or null.
-- * qorpera_complete_coding_turn: a failed turn whose own run (the turn row's occurrence, W6a) has the signal reports
--   the text as its summary: the worker's result, its `reported` event, its results.md (C3d) and its `failed` event,
--   which still carries usageLimit for the web.
-- * qorpera_folder_worker_ended: an in-house worker whose run has the signal fails with reason usage_limit and the text.
-- Other failures, and turns that never began (no run of their own), keep their summaries.
--
-- Locks: none added. The text reads the signal and the account metadata without locks; both callers already hold the
-- worker row.

set local lock_timeout = '3s';

-- The plain words for a worker run stopped at its login's usage limit, or null when the run of p_occurrence_id has no
-- usage-limit signal for the sponsor version it runs on (20260930549300).
create function public.qorpera_worker_usage_limit_text(p_occurrence_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	-- 20260930549300.
	select 'The login paying for this work reached its usage limit. '
		|| case when limit_reset.resets is null then ''
			else 'It resets on ' || to_char(limit_reset.resets at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work does not move to another login by itself: the member can choose another of their logins for it '
		|| '(in the conversation''s Login menu), or wait until the limit resets.'
	from public.qorpera_wake_occurrences as wake
	join public.qorpera_execution_runs as run on run.id = wake.run_id
	join public.qorpera_provider_connection_usage_signals as signal
		on signal.run_id = run.id and signal.sponsor_version = run.sponsor_version and signal.signal_kind = 'usage_limit'
	cross join lateral (select coalesce(
		case when signal.resets_at > statement_timestamp() then signal.resets_at end,
		(select max((window_row.value ->> 'resetAt')::timestamptz)
			from public.qorpera_native_provider_account_metadata as metadata
			cross join lateral jsonb_array_elements(case when jsonb_typeof(metadata.provider_account_usage -> 'windows') = 'array'
				then metadata.provider_account_usage -> 'windows' else '[]'::jsonb end) as window_row
			where metadata.connection_id = signal.provider_connection_id
				and metadata.connection_version = signal.provider_connection_version
				and jsonb_typeof(window_row.value -> 'usedPercent') = 'number'
				and (window_row.value ->> 'usedPercent')::numeric >= 100
				and jsonb_typeof(window_row.value -> 'resetAt') = 'string'
				and (window_row.value ->> 'resetAt')::timestamptz > statement_timestamp())) as resets) as limit_reset
	where p_occurrence_id is not null and wake.id = p_occurrence_id
$$;
revoke all on function public.qorpera_worker_usage_limit_text(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.worker_usage_text_20260930549300_patch(p_function regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare
	v_definition text := pg_get_functiondef(p_function);
	v_count integer := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
begin
	if v_count <> 1 then raise exception '% source differs (anchor matches % times)', p_function, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

-- A second run stops here, before anything changes.
do $$ begin
	if position('20260930549300' in pg_get_functiondef(
			'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure)) > 0
		or position('20260930549300' in pg_get_functiondef(
			'public.qorpera_folder_worker_ended(public.qorpera_runtime_workers,uuid,text)'::regprocedure)) > 0 then
		raise exception 'The worker usage-limit text (20260930549300) is already applied'; end if;
end $$;

-- A coding turn: its own run, which its begin made (the turn row's occurrence, W6a); a turn that never began has none.
select pg_temp.worker_usage_text_20260930549300_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a1$	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
$a1$, $r1$	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
	-- 20260930549300: a failed turn whose run stopped at its login's usage limit tells its agent so in plain words, not
	-- with the executor's summary of the provider bridge's code.
	if p_outcome = 'failed' then
		v_summary := coalesce(public.qorpera_worker_usage_limit_text((select turn.occurrence_id
			from public.qorpera_coding_session_turns as turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence)), v_summary);
	end if;
$r1$);

-- An in-house worker whose run ended without a report because its login reached its usage limit.
select pg_temp.worker_usage_text_20260930549300_patch(
	'public.qorpera_folder_worker_ended(public.qorpera_runtime_workers,uuid,text)'::regprocedure,
	$a2$		when public.qorpera_computer_hour_wake_ended_out_of_hours(p_occurrence_id) then 'out_of_computer_hours'
		else 'ended_without_report' end;
$a2$, $r2$		when public.qorpera_computer_hour_wake_ended_out_of_hours(p_occurrence_id) then 'out_of_computer_hours'
		-- 20260930549300: its run stopped at its login's usage limit.
		when public.qorpera_worker_usage_limit_text(p_occurrence_id) is not null then 'usage_limit'
		else 'ended_without_report' end;
$r2$);
select pg_temp.worker_usage_text_20260930549300_patch(
	'public.qorpera_folder_worker_ended(public.qorpera_runtime_workers,uuid,text)'::regprocedure,
	$a3$				when 'out_of_computer_hours' then 'The background work was stopped because the company is out of computer hours.'
$a3$, $r3$				when 'out_of_computer_hours' then 'The background work was stopped because the company is out of computer hours.'
				when 'usage_limit' then public.qorpera_worker_usage_limit_text(p_occurrence_id)
$r3$);
