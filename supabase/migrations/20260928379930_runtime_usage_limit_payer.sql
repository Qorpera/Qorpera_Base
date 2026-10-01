-- Sign in with ChatGPT, switch-on gate 2a: the usage-limit signal reaches the member, for chat and coding.
--
-- A run that reached its login's usage limit stops (20260928349910), and its recovery says so (usage_limit). The web
-- then says the work stopped at the limit. Two gaps remain:
-- 1. The web cannot tell a member's ChatGPT plan from a Codex login, so it cannot give a plan's limit in OpenAI's
--    words with a "Manage usage" link. qorpera_get_execution_run_recovery now adds paid_by_chatgpt_plan: whether the
--    run's pinned sponsor version pays with a ChatGPT plan (qorpera_sponsor_version_is_chatgpt_plan). A member who may
--    read the recovery already reads that run's sponsor binding and version in it.
-- 2. A coding turn that stopped at a usage limit failed with only the executor's summary, which carries a code and
--    no flag, so the member read "Something on Qorpera's side refused one of the session's steps". Its failed event
--    now carries usageLimit (true) and paidByChatgptPlan when the turn's run (the worker's occurrence) has a
--    usage_limit signal for its pinned sponsor version (qorpera_coding_turn_usage_limit). Other events and
--    outcomes are unchanged.
-- Codex logins: unchanged, except that a coding turn stopped at a Codex login's limit is now told as a limit.
--
-- Locks: none added. Both read rows without locks; the coding completion already holds its worker row.

set local lock_timeout = '3s';

-- What a coding turn's run tells about a usage limit: {usageLimit, paidByChatgptPlan} when the run reached its
-- login's limit, else {}.
create function public.qorpera_coding_turn_usage_limit(p_occurrence_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce((
		select jsonb_build_object('usageLimit', true,
			'paidByChatgptPlan', public.qorpera_sponsor_version_is_chatgpt_plan(run.sponsor_binding_id, run.sponsor_version))
		from public.qorpera_wake_occurrences as wake
		join public.qorpera_execution_runs as run on run.id = wake.run_id
		where wake.id = p_occurrence_id
			and exists (select 1 from public.qorpera_provider_connection_usage_signals as signal
				where signal.run_id = run.id and signal.sponsor_version = run.sponsor_version
					and signal.signal_kind = 'usage_limit')), '{}'::jsonb)
$$;
revoke all on function public.qorpera_coding_turn_usage_limit(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function pg_temp.qorpera_usage_payer_20260929993000_patch(p_function regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare
	v_definition text := pg_get_functiondef(p_function);
	v_count integer;
begin
	if position('20260929993000' in v_definition) > 0 then return; end if;
	v_count := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
	if v_count <> 1 then
		raise exception '% source differs (anchor matches % times)', p_function, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

select pg_temp.qorpera_usage_payer_20260929993000_patch('public.qorpera_get_execution_run_recovery(uuid)'::regprocedure,
	$a0$			where signal.run_id = v_run.id and signal.sponsor_version = v_run.sponsor_version
				and signal.signal_kind = 'usage_limit'),
$a0$, $r0$			where signal.run_id = v_run.id and signal.sponsor_version = v_run.sponsor_version
				and signal.signal_kind = 'usage_limit'),
		-- Whether a member's ChatGPT plan pays for this run (20260929993000): its limit is told in OpenAI's words.
		'paid_by_chatgpt_plan', public.qorpera_sponsor_version_is_chatgpt_plan(v_run.sponsor_binding_id, v_run.sponsor_version),
$r0$);
select pg_temp.qorpera_usage_payer_20260929993000_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	$a1$		jsonb_build_object('summary', v_summary, 'needs', v_needs) || case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end);
$a1$, $r1$		jsonb_build_object('summary', v_summary, 'needs', v_needs) || case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end
		-- A failed turn whose run reached its login's usage limit says so (20260929993000).
		|| case when p_outcome = 'failed' then public.qorpera_coding_turn_usage_limit(v_worker.occurrence_id) else '{}'::jsonb end);
$r1$);
