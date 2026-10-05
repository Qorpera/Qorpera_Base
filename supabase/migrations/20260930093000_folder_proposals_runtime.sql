-- Folder core P40b: the runtime side of C2-R2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8; P40a is migration
-- 20260930074000). A folder-v2 run that can raise a card lists its agent's open proposals for its member at the start of
-- the turn, and offers two tools: apply_proposal (reviewed through the gate, recorded by R1's recorder, then applied)
-- and discard_proposal. A denial of the apply closes the proposal as declined.
-- * The native host (G2) may call the run's three calls: qorpera_folder_agent_proposals and
--   qorpera_folder_apply_proposal with the folder scope (this run's environment and its run actor), and
--   qorpera_folder_close_proposal with the binding's.
-- * Observations name the two tools.
-- No table, no lock. Inert until a view saves (F3 steps 3 and 4).

set local lock_timeout = '3s';

do $$ begin if to_regprocedure('public.qorpera_folder_apply_proposal(uuid,jsonb,text,uuid,uuid,uuid)') is null then
	raise exception 'P40b requires migration 20260930074000_folder_proposals'; end if; end $$;

create function pg_temp.p40b_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'P40b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The native host may call the three for its job's run (G2-1's scopes).
insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_agent_proposals', 'folder'),
	('qorpera_folder_apply_proposal', 'folder'),
	('qorpera_folder_close_proposal', 'binding');

-- Observations name the two tools, after the company's accounts.
select pg_temp.p40b_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'company_search','company_account',$old$,
	$new$'company_search','company_account','apply_proposal','discard_proposal',$new$);

drop function pg_temp.p40b_replace(regprocedure, text, text);

do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''discard_proposal''') = 0 then
		raise exception 'P40b did not reach the observation vocabulary'; end if;
end $guard$;
