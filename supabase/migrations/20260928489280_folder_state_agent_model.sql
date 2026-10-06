-- Company state files: an agent's model reaches its runs on folder-v2 (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md:
-- the agent.md table's `model`, the index table's agent row, and the note on the file's model; the coordinator's gap of
-- 5 October 2026, from A1's legacy ports).
-- The roster index of agent.md never set qorpera_profile_staff's model columns, so a folder-v2 agent had no model of its
-- own: a run on a native subscription took the provider's default, a run on an API-key account had none (42501 in
-- qorpera_execution_run_model_authority), and qorpera_configure_staff_execution_authority refused an API-key company
-- account as the agent's standing account (22023 'staff execution authority is unavailable').
-- * qorpera_company_state_index_agent sets model_provider 'openai' and model_id from the file's `model`, or gpt-6-astra
--   (the platform's default model, a thread's too) when the file names none. Only a change is set, as for the other
--   columns, so the provider-model mapping (qorpera_sync_staff_primary_provider_model) and the default execution
--   authority (on model_provider) run for real changes only.
-- * Agents indexed before this get the same from their current agent.md version.
-- On a native subscription, a conversation's own model choice still wins over the agent's in that conversation
-- (qorpera_execution_run_model_authority); on an API-key account the agent's model applies.
-- No lock changes: the index writes the roster row its commit already holds at rank 2. The patched body carries the
-- marker 20260930081000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.agent_model_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Agent model anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.agent_model_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure,
	$old$	v_figure text := p_parse ->> 'figure'; v_count bigint; v_sets text[];
$old$,
	$new$	v_figure text := p_parse ->> 'figure'; v_count bigint; v_sets text[];
	-- 20260930081000: the agent's model, the file's or the platform's default.
	v_model text := coalesce(p_parse ->> 'model', 'gpt-6-astra');
$new$);
select pg_temp.agent_model_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure,
	$old$			created_at, updated_at, updated_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id)$old$,
	$new$			created_at, updated_at, updated_by_user_id, folder_environment_id, folder_path, folder_path_version, folder_commit_id,
			model_provider, model_id)$new$);
select pg_temp.agent_model_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure,
	$old$			p_environment_id, p_path, p_version, p_commit_id)$old$,
	$new$			p_environment_id, p_path, p_version, p_commit_id, 'openai', v_model)$new$);
select pg_temp.agent_model_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure,
	$old$	if v_row.employment_status is distinct from p_parse ->> 'status' then v_sets := array_append(v_sets, 'employment_status = $12'); end if;
$old$,
	$new$	if v_row.employment_status is distinct from p_parse ->> 'status' then v_sets := array_append(v_sets, 'employment_status = $12'); end if;
	if v_row.model_provider is distinct from 'openai' then v_sets := array_append(v_sets, 'model_provider = $15'); end if;
	if v_row.model_id is distinct from v_model then v_sets := array_append(v_sets, 'model_id = $16'); end if;
$new$);
select pg_temp.agent_model_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure,
	$old$		p_parse ->> 'instructions', v_colour, v_figure, p_parse ->> 'status', p_profile_id, v_id;
$old$,
	$new$		p_parse ->> 'instructions', v_colour, v_figure, p_parse ->> 'status', p_profile_id, v_id, 'openai'::text, v_model;
$new$);

-- The agents indexed before: the model of their current agent.md version (its checked parse), or the default.
update public.qorpera_profile_staff s
set model_provider = 'openai', model_id = coalesce(v.structured -> 'parse' ->> 'model', 'gpt-6-astra')
from public.qorpera_folder_entries e
join public.qorpera_folder_path_versions v on v.version = e.version
where s.folder_environment_id is not null and s.folder_path is not null and s.folder_retired_at is null
	and e.environment_id = s.folder_environment_id and e.kind = 'file'
	and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
	and (s.model_provider is distinct from 'openai'
		or s.model_id is distinct from coalesce(v.structured -> 'parse' ->> 'model', 'gpt-6-astra'));

do $guard$
begin
	if strpos((select prosrc from pg_proc
		where oid = 'public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure),
		'20260930081000') = 0 then
		raise exception 'The agent model did not reach qorpera_company_state_index_agent'; end if;
end $guard$;
