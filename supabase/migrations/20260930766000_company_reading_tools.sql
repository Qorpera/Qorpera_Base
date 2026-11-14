-- 20260930766000: the Co-Founder keeps the company's reading of itself, and a role can end (the founder, 14 November
-- 2026: "I think the company's stage is more fluent than a set value, but I also do think there needs to be some form
-- of awareness about the state/stage of the company. It should feel like the company is conscious almost.").
--
-- Two new tools of the runtime (packages/runtime/src/cloud-folder-reading.ts, cloud-folder-hiring.ts):
-- * update_reading writes QorperaOS/vision/reading.md (the kind 'reading', 20260930765000) through the folder core under
--   the call's receipt. Saving the reading is plain, the company's bookkeeping: no review, nothing else here.
-- * end_role sets an agent's agent.md to status archived. A status change is delegation (20260928259310), so the save
--   carries the automatic review's approval of the call, which the review recorder now takes from end_role as it takes
--   hire_agent's.
-- So the closed list of tool operations a run's observations may name gains both names, after make_picture
-- (20260930746000), and the review recorder's list of tools that write reviewed change sets gains end_role, after
-- company_move (20260930525000). Both are anchored on one line each, so a later migration that anchors on the same
-- line puts its names beside these, whichever is applied first.

create function pg_temp.reading_tools_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930766000' in v_definition) > 0 then
		raise exception '20260930766000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930766000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.reading_tools_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930746000 */'make_picture',$old$,
	$new$/* 20260930746000 */'make_picture',/* 20260930766000 */'update_reading','end_role',$new$);

select pg_temp.reading_tools_replace('public.qorpera_folder_record_review(jsonb,jsonb)'::regprocedure,
	$old$'company_move' /* 20260930525000 */)$old$,
	$new$'company_move' /* 20260930525000 */, 'end_role' /* 20260930766000 */)$new$);

drop function pg_temp.reading_tools_replace(regprocedure, text, text);
