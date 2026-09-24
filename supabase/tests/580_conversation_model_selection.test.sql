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
	v_message text; v_detail text; v_retired text;
begin
	v_result := public.qorpera_get_session_model(v_session);
	if v_result ->> 'model_id' <> 'gpt-native' or (v_result ->> 'version')::bigint <> 0 then
		raise exception 'conversation should initially inherit its agent model'; end if;
	if v_result ->> 'reasoning_effort' <> 'low' then
		raise exception 'conversation should initially run at the bundle default effort'; end if;
	v_result := public.qorpera_set_session_model(v_session,'gpt-6-sol',0);
	if v_result <> jsonb_build_object('session_id',v_session,'model_id','gpt-6-sol','reasoning_effort','low',
		'version',1) then
		raise exception 'conversation model selection did not persist'; end if;
	begin
		perform public.qorpera_set_session_model(v_session,'gpt-6-astra',0);
		raise exception 'stale conversation version accepted';
	exception when sqlstate 'PGRST' then
		get stacked diagnostics v_message = message_text,v_detail = pg_exception_detail;
		if v_message::jsonb ->> 'code' <> 'QRC01' or v_detail::jsonb <> '{"status":409,"headers":{}}'::jsonb then
			raise exception 'conversation conflict did not use the application conflict envelope'; end if;
	end;
	begin
		perform public.qorpera_set_session_model(v_session,'arbitrary-model',1);
		raise exception 'unsupported conversation model accepted';
	exception when invalid_parameter_value then null; end;
	foreach v_retired in array array['gpt-5.6-sol','gpt-5.6-terra'] loop
		begin
			perform public.qorpera_set_session_model(v_session,v_retired,1);
			raise exception 'retired conversation model accepted';
		exception when invalid_parameter_value then null; end;
	end loop;
	begin
		perform public.qorpera_set_session_model(v_session,'gpt-6-sol',1,'max');
		raise exception 'unsupported conversation effort accepted';
	exception when invalid_parameter_value then null; end;
	v_result := public.qorpera_set_session_model(v_session,'gpt-6-luna',1,'high');
	if v_result ->> 'model_id' <> 'gpt-6-luna' or v_result ->> 'reasoning_effort' <> 'high'
		or (v_result ->> 'version')::bigint <> 2 then
		raise exception 'conversation effort selection did not persist'; end if;
	-- A client that predates effort changes only the model and keeps the effort.
	perform public.qorpera_set_session_model(v_session,'gpt-6-astra',2);
	perform public.qorpera_set_session_model(v_session,'gpt-6-luna',3);
	v_result := public.qorpera_get_session_model(v_session);
	if v_result ->> 'model_id' <> 'gpt-6-luna' or v_result ->> 'reasoning_effort' <> 'high' then
		raise exception 'conversation model update was not readable or dropped the effort'; end if;
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
	if v_result.model_id <> 'gpt-6-luna' or v_result.model_selection <> 'session_override'
		or v_result.model_mapping_version is not null then
		raise exception 'agent room delivery ignored conversation model'; end if;
	v_run.source_kind := 'session_turn';
	insert into model_selection_runs select (v_run).* returning * into v_result;
	if v_result.model_id <> 'gpt-6-luna' then raise exception 'attended run ignored conversation model'; end if;
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

-- A member's next turn in a conversation runs with that conversation's model
-- and effort, through the real request and materialization path. The fixture's
-- sessions already hold a queued turn, so this one gets its own (private)
-- conversation with the same agent.
insert into public.qorpera_shared_sessions (
	id, client_session_id, profile_id, environment_id, title, status,
	created_by_user_id, staff_agent_id, staff_version, execution_scope, created_at,
	audience_kind, audience_user_id
) values (
	'58000000-0000-4000-8000-000000000040', '58000000-0000-4000-8000-000000000041',
	'16000000-0000-4000-8000-000000000010', '16000000-0000-4000-8000-000000000020',
	'Effort session', 'open', '16000000-0000-4000-8000-000000000001',
	'16000000-0000-4000-8000-000000000030', 1, '{}', statement_timestamp(),
	'member_private', '16000000-0000-4000-8000-000000000001'
);
-- The fixture's queued turn holds the connection's single concurrent run slot.
update public.qorpera_execution_sponsor_reservations
set status = 'settled', actual_microusd = 0, settled_at = clock_timestamp()
where provider_connection_id = (current_setting('qorpera_test.native_connection')::jsonb ->> 'connection_id')::uuid
	and status = 'reserved';
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
set role authenticated;
select public.qorpera_set_session_model('58000000-0000-4000-8000-000000000040','gpt-6-sol',0,'medium');
select set_config('qorpera_test.effort_turn',public.qorpera_request_session_turn_v2(
	'58000000-0000-4000-8000-000000000040',
	'58000000-0000-4000-8000-000000000070',
	'58000000-0000-4000-8000-000000000071',
	'{"schema":"qorpera.session-prompt/v1","text":"Think this one through.","images":[]}',
	'member_connection',
	(current_setting('qorpera_test.native_sponsor')::jsonb ->> 'binding_id')::uuid,
	1, null,
	(current_setting('qorpera_test.native_identity')::jsonb ->> 'compute_identity_id')::uuid,
	null, 'managed_sandbox', 'agent_turn', 'agent_turn', 'automatic', null, '{}'
)::text,false);
reset role;
select set_config('request.jwt.claims',
	'{"sub":"00000000-0000-4000-8000-000000000000","role":"service_role"}',false);
set role service_role;
select public.qorpera_materialize_session_turn_requests(32);
reset role;
do $$
declare v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb;
begin
	select * into strict v_run from public.qorpera_execution_runs
	where id = (current_setting('qorpera_test.effort_turn')::jsonb ->> 'turn_request_id')::uuid;
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if v_manifest #>> '{modelPolicy,overrides}' <> 'routine-and-thread' then
		raise exception 'active bundle does not let a conversation choose its effort'; end if;
	if v_run.source_kind <> 'session_turn' or v_run.model_id <> 'gpt-6-sol'
		or v_run.model_selection <> 'session_override' or v_run.reasoning_effort <> 'medium'
		or v_run.reasoning_policy_sha256 <> encode(extensions.digest(
			convert_to((v_manifest -> 'modelPolicy')::text,'utf8'),'sha256'),'hex') then
		raise exception 'attended run ignored the conversation model or effort'; end if;
	if exists (select 1 from public.qorpera_execution_runs where profile_id = v_run.profile_id
		and id <> v_run.id and reasoning_effort <> 'low') then
		raise exception 'conversation effort leaked into other runs'; end if;
	-- Older bundles declared routine-only overrides; a conversation effort
	-- never widened what they admitted.
	if not public.qorpera_manifest_allows_reasoning_effort(
			jsonb_set(v_manifest,'{modelPolicy,overrides}','"routine"'),'high')
		or public.qorpera_manifest_allows_reasoning_effort(
			jsonb_set(v_manifest,'{modelPolicy,overrides}','"none"'),'high')
		or public.qorpera_manifest_allows_reasoning_effort(v_manifest,'max') then
		raise exception 'effort override labels are not honoured exactly'; end if;
end $$;

-- Contributors may choose a conversation model, but viewers, former members,
-- closed sessions, and removed room members cannot mutate it.
select set_config('request.jwt.claims',
	'{"sub":"16000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
set role authenticated;
select public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-6-astra',4);
reset role;
update public.qorpera_profile_members set role = 'viewer'
where profile_id = '16000000-0000-4000-8000-000000000010' and user_id = '16000000-0000-4000-8000-000000000002';
set role authenticated;
do $$ begin
	perform public.qorpera_get_session_model(current_setting('qorpera_test.model_room_session')::uuid);
	begin
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-6-sol',5);
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
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-6-sol',5);
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
		perform public.qorpera_set_session_model(current_setting('qorpera_test.model_room_session')::uuid,'gpt-6-sol',5);
		raise exception 'closed conversation model changed';
	exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
