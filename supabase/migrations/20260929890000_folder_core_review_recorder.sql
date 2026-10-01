-- Company folder core, C2 R1: the review recorder (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §2, §3).
--
-- The commit denies an in-house agent's delegation or deletion unit unless a qorpera_folder_reviews row of its run
-- covers it, bound to the change set's digest (C1B §6). The automatic review (v130) has already reviewed the tool call
-- that carries such a change, with the kernel's layering in qorpera_record_action_review and the rules of rules/. This
-- records that verdict for the one change set the call commits: this run's own allow, or a card's allow this run used,
-- with the member who gave it. One approval stands for one change set. Inert: only a folder-v2 run reaches it, and no
-- writer calls it before W4.

-- A run effect. The request is checked first, before any lock. Then the run entry (the binding, the stop, the run mutex,
-- this company's row at rank 0 KEY SHARE); the approval row after it, FOR SHARE (a used approval cannot change; the
-- share takes an answer in flight and this read one at a time); the new row last, whose foreign key takes the folder
-- clock row KEY SHARE, as the commit's do. The units are not parsed here: the commit decides each one, and the digest
-- binds them exactly as it will receive them. The writer records inside its receipt, whose begin runs the wake gate;
-- the commit runs the rank 10 recheck. The record by itself changes nothing in the company.
create function public.qorpera_folder_record_review(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tool jsonb; v_run public.qorpera_execution_runs%rowtype; v_action public.qorpera_action_reviews%rowtype;
	v_units jsonb; v_sha text; v_id uuid; v_review public.qorpera_folder_reviews%rowtype; v_card boolean;
	v_keys constant text[] := array['actionReviewId','tool','argumentSha256','units'];
begin
	if jsonb_typeof(p_request) is distinct from 'object' or not (p_request ?& v_keys) or p_request - v_keys <> '{}'::jsonb
		or coalesce(p_request ->> 'actionReviewId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or jsonb_typeof(p_request -> 'tool') is distinct from 'string'
		or coalesce(p_request ->> 'argumentSha256', '') !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_request -> 'units') is distinct from 'array'
		or jsonb_array_length(p_request -> 'units') not between 1 and 1000 then
		raise exception 'Folder review request is invalid' using errcode = '22023'; end if;
	v_tool := public.qorpera_folder_tool_run(p_binding, '[]'::jsonb);
	v_run := jsonb_populate_record(null::public.qorpera_execution_runs, v_tool -> 'run');
	v_units := p_request -> 'units';
	select review.* into v_action from public.qorpera_action_reviews as review
	where review.id = (p_request ->> 'actionReviewId')::uuid and review.profile_id = v_run.profile_id
		and review.staff_agent_id = v_run.staff_agent_id
	for share;
	-- An approval this run may act on, of this exact call (its tool and the digest of its arguments), by a tool that
	-- writes folder change sets: its own allow, or a card's allow it used (qorpera_begin_action_review and
	-- qorpera_await_action_review set consumed_run_id once). Only a delegation or a deletion stands for folder units.
	if not found or not (v_action.effect in ('delegation','destructive')
		and v_action.tool_name = p_request ->> 'tool'
		and v_action.tool_name in ('hire_agent','create_group_chat','manage_routine','decide_routine','company_delete')
		and v_action.argument_sha256 = p_request ->> 'argumentSha256'
		and ((v_action.decision = 'allow' and v_action.run_id = v_run.id)
			or (coalesce(v_action.answer, '') in ('allow_once','always_allow') and v_action.consumed_run_id is not distinct from v_run.id))) then
		raise exception 'This change has no approval in this run' using errcode = '42501'; end if;
	-- A card's allow keeps the member who gave it, so the commit records its approver (C1B §5). An answer whose member
	-- was since deleted is recorded as a plain allow.
	v_card := v_action.decision = 'ask' and v_action.answered_by_user_id is not null;
	v_sha := public.qorpera_folder_change_set_sha256(v_units);
	v_id := md5('qorpera.folder-review:' || v_action.id::text)::uuid;
	select * into v_review from public.qorpera_folder_reviews where id = v_id;
	if found then
		if v_review.change_set_sha256 <> v_sha or v_review.run_id <> v_run.id then
			raise exception 'This approval was already used for another change' using errcode = '23505'; end if;
	else
		insert into public.qorpera_folder_reviews(id, environment_id, run_id, change_set_sha256, units, decision, answer,
			answered_by_user_id, answered_at)
		values (v_id, v_run.environment_id, v_run.id, v_sha,
			array(select n from generate_series(1, jsonb_array_length(v_units)) as n order by n),
			case when v_card then 'ask' else 'allow' end, case when v_card then 'allow' end,
			case when v_card then v_action.answered_by_user_id end, case when v_card then v_action.answered_at end)
		returning * into v_review;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-review/v1', 'reviewId', v_review.id,
		'approvedBy', v_review.answered_by_user_id, 'units', cardinality(v_review.units));
end $$;

revoke all on function public.qorpera_folder_record_review(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_folder_record_review(jsonb, jsonb) to service_role;
