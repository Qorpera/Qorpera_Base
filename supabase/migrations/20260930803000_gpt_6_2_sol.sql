do $$ begin
	if strpos(pg_get_functiondef('public.qorpera_get_session_model(uuid)'::regprocedure), 'gpt-6.2-sol') > 0 then
		raise exception '20260930803000 is already applied'; end if;
	if to_regprocedure('public.qorpera_model_policy_thread_efforts(jsonb)') is null
		or to_regprocedure('public.qorpera_member_may_pick_claude(uuid,uuid)') is null then
		raise exception '20260930803000 needs conversation models (20260930784000) and GPT extra high (20260930788000)';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.sol_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930803000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_session_models drop constraint qorpera_session_models_model_id_check;

update public.qorpera_session_models
set model_id = 'gpt-6.2-sol', version = version + 1, updated_at = clock_timestamp()
where model_id = 'gpt-6.1-sol';

alter table public.qorpera_session_models
	add constraint qorpera_session_models_model_id_check check (model_id in ('gpt-6-astra','gpt-6.2-sol','gpt-6-sol',
		'gpt-6-luna','claude-fable-5-2','claude-opus-5-5'));

select pg_temp.sol_replace('public.qorpera_set_session_model(uuid,text,bigint,text)',
	$old$p_model_id not in ('gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna',$old$,
	$new$p_model_id not in ('gpt-6-astra','gpt-6.2-sol','gpt-6-sol','gpt-6-luna',$new$);

select pg_temp.sol_replace('public.qorpera_get_session_model(uuid)',
	$old$else coalesce(v_model,'gpt-6-astra') end,$old$,
	$new$else coalesce(v_model,'gpt-6.2-sol') end,$new$);
select pg_temp.sol_replace('public.qorpera_get_session_model(uuid)',
	$old$from (select '["gpt-6-astra","gpt-6.1-sol"]'::jsonb$old$,
	$new$from (select '["gpt-6-astra","gpt-6.2-sol"]'::jsonb$new$);

select pg_temp.sol_replace('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)',
	$old$v_model text := coalesce(p_parse ->> 'model', 'gpt-6-astra');$old$,
	$new$v_model text := coalesce(p_parse ->> 'model', 'gpt-6.2-sol');$new$);

update public.qorpera_profile_staff s
set model_id = 'gpt-6.2-sol'
from public.qorpera_folder_entries e
join public.qorpera_folder_path_versions v on v.version = e.version
where s.folder_environment_id is not null and s.folder_path is not null and s.folder_retired_at is null
	and s.model_provider = 'openai' and s.model_id = 'gpt-6-astra'
	and e.environment_id = s.folder_environment_id and e.kind = 'file'
	and e.key_sha256 = extensions.digest(public.qorpera_folder_key(s.folder_path), 'sha256')
	and v.structured -> 'parse' ->> 'model' is null;

do $guard$
begin
	if strpos(pg_get_functiondef('public.qorpera_set_session_model(uuid,text,bigint,text)'::regprocedure), 'gpt-6.2-sol') = 0
		or strpos(pg_get_functiondef('public.qorpera_company_state_index_agent(uuid,uuid,uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure),
			'gpt-6.2-sol') = 0
		or strpos(pg_get_functiondef('public.qorpera_get_session_model(uuid)'::regprocedure), 'gpt-6.1-sol') > 0
		or exists (select 1 from public.qorpera_session_models where model_id = 'gpt-6.1-sol') then
		raise exception 'GPT-6.2 Sol did not reach the conversation and agent models'; end if;
end $guard$;
