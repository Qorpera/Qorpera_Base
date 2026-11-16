do $$ begin
	if to_regprocedure('public.qorpera_model_policy_thread_efforts(jsonb)') is not null then
		raise exception '20260930788000 is already applied'; end if;
	if to_regprocedure('public.qorpera_pin_execution_claude_choice()') is null
		or to_regprocedure('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)') is null
		or to_regprocedure('public.qorpera_begin_native_company_execution_v3(jsonb,text,text,text,text)') is null then
		raise exception '20260930788000 needs conversation models (20260930784000), core work effort (20260930532000) and the native admission split (20260928559120)';
	end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.gx_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930788000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

alter table public.qorpera_session_models drop constraint qorpera_session_models_claude_effort;
alter table public.qorpera_session_models
	add constraint qorpera_session_models_model_effort check (coalesce(reasoning_effort in ('low','medium','high'), true)
		or coalesce(model_id in ('claude-fable-5-2','claude-opus-5-5'), false)
		or (reasoning_effort = 'xhigh' and model_id is not null));

alter table public.qorpera_execution_runs
	drop constraint qorpera_execution_runs_reasoning_effort_check,
	add constraint qorpera_execution_runs_reasoning_effort_check check (reasoning_effort in ('low','medium','high')
		or (reasoning_effort = 'xhigh' and source_kind in ('session_turn','room_delivery')));
alter table public.qorpera_native_execution_launches
	drop constraint qorpera_native_execution_launches_reasoning_effort_check,
	add constraint qorpera_native_execution_launches_reasoning_effort_check
		check (reasoning_effort in ('low','medium','high','xhigh'));

create function public.qorpera_model_policy_thread_efforts(p_policy jsonb)
returns jsonb language sql immutable set search_path = '' as $$
	select case when p_policy ->> 'overrides' = 'routine-and-thread'
		and jsonb_typeof(p_policy -> 'threadEfforts') = 'array' then p_policy -> 'threadEfforts' else '[]'::jsonb end
$$;
revoke all on function public.qorpera_model_policy_thread_efforts(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_active_bundle_thread_efforts()
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce((select public.qorpera_model_policy_thread_efforts(bundle.manifest -> 'modelPolicy')
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton), '[]'::jsonb)
$$;
revoke all on function public.qorpera_active_bundle_thread_efforts()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_run_allows_reasoning_effort(p_manifest jsonb, p_run public.qorpera_execution_runs)
returns boolean language sql immutable set search_path = '' as $$
	select public.qorpera_manifest_allows_reasoning_effort(p_manifest, p_run.reasoning_effort)
		or coalesce(p_run.source_kind in ('session_turn','room_delivery')
			and public.qorpera_model_policy_thread_efforts(p_manifest -> 'modelPolicy') ? p_run.reasoning_effort, false)
$$;
revoke all on function public.qorpera_run_allows_reasoning_effort(jsonb, public.qorpera_execution_runs)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.gx_replace('public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	$old$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended','claudeChoice'] <> '{}'::jsonb$old$,
	$new$		or (v_manifest -> 'modelPolicy') - array['schema','effort','overrides','allowed','fastMode','unattended','claudeChoice',
			'threadEfforts'] <> '{}'::jsonb
		or ((v_manifest -> 'modelPolicy') ? 'threadEfforts' and (
			jsonb_typeof(v_manifest #> '{modelPolicy,threadEfforts}') is distinct from 'array'
			or exists (select 1 from jsonb_array_elements(v_manifest #> '{modelPolicy,threadEfforts}') thread_effort
				where thread_effort.value is distinct from '"xhigh"'::jsonb)))$new$);

select pg_temp.gx_replace('public.qorpera_resolve_run_reasoning_effort(public.qorpera_execution_runs,jsonb)',
	$old$				and coalesce(choice.model_id not in ('claude-fable-5-2','claude-opus-5-5'), true);
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen) then v_chosen
			else v_policy ->> 'effort' end;$old$,
	$new$				and coalesce(choice.model_id not in ('claude-fable-5-2','claude-opus-5-5'), true);
		end if;
		return case when public.qorpera_manifest_allows_reasoning_effort(p_manifest, v_chosen)
				or public.qorpera_model_policy_thread_efforts(v_policy) ? v_chosen then v_chosen
			when v_chosen = 'xhigh' and public.qorpera_manifest_allows_reasoning_effort(p_manifest, 'high') then 'high'
			else v_policy ->> 'effort' end;$new$);

select pg_temp.gx_replace('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)',
	$old$public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)$old$,
	$new$public.qorpera_run_allows_reasoning_effort(v_manifest, v_run)$new$);
select pg_temp.gx_replace('public.qorpera_begin_native_company_execution_v3(jsonb,text,text,text,text)',
	$old$public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)$old$,
	$new$public.qorpera_run_allows_reasoning_effort(v_manifest, v_run)$new$);
select pg_temp.gx_replace('public.qorpera_describe_native_tool_authority(jsonb)',
	$old$public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)$old$,
	$new$public.qorpera_run_allows_reasoning_effort(v_manifest, v_run)$new$);

select pg_temp.gx_replace('public.qorpera_set_session_model(uuid,text,bigint,text)',
	$old$	if v_effort in ('xhigh','max') and coalesce(v_model not in ('claude-fable-5-2','claude-opus-5-5'), true) then
		raise exception 'Conversation effort % needs a Claude model', v_effort using errcode = '22023'; end if;$old$,
	$new$	if v_effort in ('xhigh','max') and coalesce(v_model not in ('claude-fable-5-2','claude-opus-5-5'), true)
		and not (v_effort = 'xhigh' and v_model is not null and public.qorpera_active_bundle_thread_efforts() ? 'xhigh') then
		raise exception 'Conversation effort % is not open for this model', v_effort using errcode = '22023'; end if;$new$);

select pg_temp.gx_replace('public.qorpera_get_session_model(uuid)',
	$old$		|| jsonb_build_object('models', '["gpt-6-astra","gpt-6.1-sol"]'::jsonb
			|| case when v_policy ->> 'claudeChoice' = 'thread'
				and public.qorpera_member_may_pick_claude(v_session.profile_id, auth.uid())
				then '["claude-fable-5-2","claude-opus-5-5"]'::jsonb else '[]'::jsonb end);$old$,
	$new$		|| (select jsonb_build_object('models', listed.models, 'efforts', (select jsonb_object_agg(model.id,
				case when model.id in ('claude-fable-5-2','claude-opus-5-5') then '["low","medium","high","xhigh","max"]'::jsonb
				else '["low","medium","high"]'::jsonb || public.qorpera_model_policy_thread_efforts(v_policy) end)
			from jsonb_array_elements_text(listed.models) as model(id)))
		from (select '["gpt-6-astra","gpt-6.1-sol"]'::jsonb
			|| case when v_policy ->> 'claudeChoice' = 'thread'
				and public.qorpera_member_may_pick_claude(v_session.profile_id, auth.uid())
				then '["claude-fable-5-2","claude-opus-5-5"]'::jsonb else '[]'::jsonb end as models) as listed);$new$);
