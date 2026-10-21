-- 20260930525000: how agents start work and use the company folder (QORPERA-RUNTIME-CONTRACT.md, the 2026-10-21
-- amendment, items 5 and 6). An agent run gets two more file tools: company_edit (one exact span of one file replaced,
-- written as company_write writes: a write unit under the version the model read) and company_move (one file, link or
-- folder moved or renamed: a move unit).
-- 1. Observations name them: qorpera_record_runtime_observation takes 'company_edit' and 'company_move' as operations,
--    as the runtime's closed vocabulary (CLOUD_RUNTIME_OPERATIONS) does.
-- 2. The review recorder takes a company_move approval. The folder core reviews an in-house run's move as a deletion
--    (20260928259230), so the move commits only with a folder review, which the recorder makes from the automatic
--    review's approval of this exact call (its tool and argument digest), as it does for company_delete. company_edit
--    writes as company_write does and needs no review.
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
