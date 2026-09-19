-- @fixture 160_native_subscription_compute_identity.test.sql until "-- Exercise the complete cloud-only personal-subscription path."
reset role;

-- Reuse the real admitted native run, applying only the production model
-- authority trigger to independent copies so each source/session can be checked.
create temporary table model_selection_runs as select * from public.qorpera_execution_runs with no data;
create trigger model_authority before insert on model_selection_runs
for each row execute function public.qorpera_execution_run_model_authority();

select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
select set_config('qorpera_test.model_room_session',(
	select session_id::text from public.qorpera_company_rooms
	where profile_id = '16000000-0000-4000-8000-000000000010'
		and bound_staff_agent_id = '16000000-0000-4000-8000-000000000030'),false);
set role authenticated;

do $$
declare v_session uuid := current_setting('qorpera_test.model_room_session')::uuid; v_result jsonb;
begin
	v_result := public.qorpera_get_session_model(v_session);
	if v_result ->> 'model_id' <> 'gpt-native' or (v_result ->> 'version')::bigint <> 0 then
		raise exception 'conversation should initially inherit its agent model'; end if;
	v_result := public.qorpera_set_session_model(v_session,'gpt-5.6-sol',0);
	if v_result <> jsonb_build_object('session_id',v_session,'model_id','gpt-5.6-sol','version',1) then
		raise exception 'conversation model selection did not persist'; end if;
	begin
		perform public.qorpera_set_session_model(v_session,'gpt-6-astra',0);
		raise exception 'stale conversation version accepted';
	exception when serialization_failure then null; end;
	begin
		perform public.qorpera_set_session_model(v_session,'arbitrary-model',1);
		raise exception 'unsupported conversation model accepted';
	exception when invalid_parameter_value then null; end;
	perform public.qorpera_set_session_model(v_session,'gpt-5.6-terra',1);
	if public.qorpera_get_session_model(v_session) ->> 'model_id' <> 'gpt-5.6-terra' then
		raise exception 'conversation model update was not readable'; end if;
end $$;
reset role;

do $$
declare v_run public.qorpera_execution_runs%rowtype; v_result public.qorpera_execution_runs%rowtype;
	v_session uuid := current_setting('qorpera_test.model_room_session')::uuid;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where profile_id = '16000000-0000-4000-8000-000000000010'
		and staff_agent_id = '16000000-0000-4000-8000-000000000030' and source_kind = 'session_turn';
	v_run.session_id := v_session; v_run.source_kind := 'room_delivery';
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_id <> 'gpt-5.6-terra' or v_result.model_selection <> 'session_override'
		or v_result.model_mapping_version is not null then
		raise exception 'agent room delivery ignored conversation model'; end if;
	v_run.source_kind := 'session_turn';
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_id <> 'gpt-5.6-terra' then raise exception 'attended run ignored conversation model'; end if;
	v_run.source_kind := 'wake';
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_id <> 'gpt-native' or v_result.model_selection <> 'provider_mapping' then
		raise exception 'conversation model leaked into autonomous work'; end if;
	v_run.source_kind := 'session_turn'; v_run.session_id := '16000000-0000-4000-8000-000000000040';
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_id <> 'gpt-native' then raise exception 'conversation model leaked into another session'; end if;
	if exists (select 1 from public.qorpera_execution_runs where profile_id = v_run.profile_id
		and model_id <> 'gpt-native') then raise exception 'selection rewrote an admitted run'; end if;
	if not exists (select 1 from public.qorpera_staff_provider_models where profile_id = v_run.profile_id
		and staff_agent_id = v_run.staff_agent_id and provider = 'openai' and model_id = 'gpt-native') then
		raise exception 'selection rewrote the agent model'; end if;
	v_run.session_id := v_session;
	v_run.sponsor_binding_id := (current_setting('qorpera_test.anthropic_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_run.sponsor_version := 1;
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_provider <> 'anthropic' or v_result.model_id <> 'provider-default'
		or v_result.model_selection <> 'provider_default' then
		raise exception 'Codex conversation model leaked into another provider'; end if;
end $$;

-- Contributors may choose a conversation model, but viewers, former members,
-- closed sessions, and removed room members cannot mutate it.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
select public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-6-astra',2);
reset role;
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000002';
set role authenticated;
do $$ begin
	perform public.qorpera_get_session_model(current_setting('qorpera_test.model_room_session')::uuid);
	begin
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-5.6-sol',3);
		raise exception 'viewer changed conversation model';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims',
	'{"sub":"58000000-0000-4000-8000-000000000099","role":"authenticated"}',false);
set role authenticated;
do $$ begin
	begin
		perform public.qorpera_get_session_model(current_setting('qorpera_test.model_room_session')::uuid);
		raise exception 'nonmember read conversation model';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
update public.qorpera_company_room_members set status = 'removed',removed_at = clock_timestamp()
where room_id = (select id from public.qorpera_company_rooms
	where session_id = current_setting('qorpera_test.model_room_session')::uuid)
	and principal_kind = 'member' and principal_id = '16000000-0000-4000-8000-000000000001';
set role authenticated;
do $$ begin
	begin
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-5.6-sol',3);
		raise exception 'removed room member changed conversation model';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.qorpera_company_room_members set status = 'active',removed_at = null
where room_id = (select id from public.qorpera_company_rooms
	where session_id = current_setting('qorpera_test.model_room_session')::uuid)
	and principal_kind = 'member' and principal_id = '16000000-0000-4000-8000-000000000001';
update public.qorpera_shared_sessions set status = 'closed'
where id = current_setting('qorpera_test.model_room_session')::uuid;
set role authenticated;
do $$ begin
	begin
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-5.6-sol',3);
		raise exception 'closed conversation model changed';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
