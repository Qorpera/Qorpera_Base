-- 20260930525000: how agents start work and use the company folder (QORPERA-RUNTIME-CONTRACT.md, the 2026-10-21
-- amendment, items 3 and 5). An agent run gets two more file tools: company_edit (one exact span of one file replaced,
-- written as company_write writes: a write unit under the version the model read) and company_move (one file, link or
-- folder moved or renamed: a move unit).
-- 1. Observations name them: qorpera_record_runtime_observation takes 'company_edit' and 'company_move' as operations,
--    as the runtime's closed vocabulary (CLOUD_RUNTIME_OPERATIONS) does.
-- 2. The review recorder takes a company_move approval. The folder core reviews an in-house run's move as a deletion
--    (20260928259230), so the move commits only with a folder review, which the recorder makes from the automatic
--    review's approval of this exact call (its tool and argument digest), as it does for company_delete. company_edit
--    writes as company_write does and needs no review.
-- 3. A run woken by a member's answer to a card shows the card beside the answer (item 3). The card is in the run's
--    history only while it is among the conversation's 32 latest entries, so qorpera_read_company_run_card reads one
--    by its id: an interaction or authorization request of the run's own conversation, at or before its transcript
--    start, as the run's context shows a history entry, with the first 16 KiB of its text. read_context reads on
--    from there (its sha256 is the whole text's, as for every history entry). It makes the checks
--    qorpera_read_company_run_context makes (the run's lock, its actor, its read set); the native host calls it with
--    the run's binding.
-- Every inserted text names this migration (20260930525000).

set local lock_timeout = '3s';

create function pg_temp.agent_files_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930525000' in v_definition) > 0 then
		raise exception '20260930525000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930525000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The vocabulary ----------------------------------------------------------------------------------------------------

select pg_temp.agent_files_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930202000 (M1b-3) */'zoom',$old$,
	$new$/* 20260930202000 (M1b-3) */'zoom',/* 20260930525000 */'company_edit','company_move',$new$);

-- 2. The recorder ------------------------------------------------------------------------------------------------------

select pg_temp.agent_files_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$'manage_worker' /* 20260930003000 (F2-5b) */)$old$,
	$new$'manage_worker' /* 20260930003000 (F2-5b) */, 'company_move' /* 20260930525000 */)$new$);

drop function pg_temp.agent_files_replace(regprocedure, text, text);

-- 3. A card beyond the history -------------------------------------------------------------------------------------------

create function public.qorpera_read_company_run_card(p_binding jsonb, p_card_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_source jsonb;
begin
	-- 20260930525000
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_company_path_assert_context(public.qorpera_company_run_actor(v_run.environment_id, p_binding));
	if p_card_id is null or v_run.session_id is null or not exists (select 1 from public.qorpera_session_events as event
		where event.event_id = p_card_id and event.session_id = v_run.session_id
			and event.sequence <= v_run.transcript_start_sequence
			and event.event_type in ('interaction_request', 'authorization_request')) then
		raise exception 'Cloud context history is unavailable' using errcode = '42501'; end if;
	v_source := public.qorpera_company_context_source(v_run, 'history', p_card_id);
	return (v_source - 'text') || jsonb_build_object('content',
		public.qorpera_company_context_excerpt(v_source ->> 'text', 0, 16384));
end $$;
revoke all on function public.qorpera_read_company_run_card(jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_read_company_run_card(jsonb, uuid) to service_role;
insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_read_company_run_card', 'binding');
