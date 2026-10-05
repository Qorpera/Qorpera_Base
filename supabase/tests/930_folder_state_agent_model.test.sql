-- @fixture 700_folder_state_vision_agents.test.sql until "-- 2. The vision: a new name"
-- Company state files: an agent's model reaches its runs on folder-v2 (20260930081000). The roster index of agent.md
-- sets the agent's model provider and id from the file's `model`, or gpt-6-astra when it names none; the provider-model
-- mapping follows; and an owner can name an API-key company account as the agent's standing account.

create function pg_temp.model_text(p_id uuid, p_name text, p_model text) returns text language sql as $$
	select format(E'---\nid: %s\nname: %s\nrole: Sales\nkind: agent\nstatus: active\n%s---\nSell.\n', p_id, p_name,
		case when p_model is null then '' else 'model: ' || p_model || E'\n' end)
$$;
create function pg_temp.model_parse(p_id uuid, p_name text, p_model text) returns jsonb language sql as $$
	select pg_temp.agent_parse(p_id, p_name) || jsonb_build_object('model', p_model)
$$;
-- The agent's model columns and its provider-model mapping, as one value.
create function pg_temp.model_of(p_id uuid) returns jsonb language sql as $$
	select jsonb_build_object('provider', s.model_provider, 'model', s.model_id,
		'mapping', (select jsonb_agg(jsonb_build_object('provider', m.provider, 'model', m.model_id) order by m.provider)
			from public.qorpera_staff_provider_models m where m.profile_id = s.profile_id and m.staff_agent_id = s.staff_agent_id))
	from public.qorpera_profile_staff s where s.profile_id = '70000000-0000-4000-8000-000000000010' and s.staff_agent_id = p_id
$$;
create function pg_temp.same(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want using errcode = 'QTF01'; end if;
end $$;

-- 1. The seeded Co-Founder names no model: it takes the default, and its mapping follows. A hire names one; edits change
-- it and a file without one goes back to the default. Every change moves the mapping; an edit that keeps it does not.
do $$
declare
	cofounder constant uuid := '70000000-0000-4000-8000-0000000000c0'; ada constant uuid := '70000000-0000-4000-8000-0000000000d1';
	r jsonb; v_mapping_version bigint;
begin
	perform pg_temp.same(pg_temp.model_of(cofounder),
		'{"provider":"openai","model":"gpt-6-astra","mapping":[{"provider":"openai","model":"gpt-6-astra"}]}', 'The seeded Co-Founder');
	r := pg_temp.commit(pg_temp.owner(), 'model-hire-1', jsonb_build_array(jsonb_build_object('op','new_folder','path','agents/ada',
		'contents', jsonb_build_array(jsonb_build_object('path','agent.md','kind','file',
			'file', pg_temp.stage(pg_temp.model_text(ada, 'Ada', 'gpt-6-sol'))),
			jsonb_build_object('path','memory','kind','folder'), jsonb_build_object('path','todos','kind','folder')),
		'structured', jsonb_build_array(pg_temp.entry('agents/ada/agent.md', 'agent', pg_temp.model_text(ada, 'Ada', 'gpt-6-sol'),
			pg_temp.model_parse(ada, 'Ada', 'gpt-6-sol'))))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.model_of(ada),
		'{"provider":"openai","model":"gpt-6-sol","mapping":[{"provider":"openai","model":"gpt-6-sol"}]}', 'A hire with a model');
	r := pg_temp.commit(pg_temp.owner(), 'model-edit-1', jsonb_build_array(pg_temp.write('agents/ada/agent.md', 'agent',
		pg_temp.model_text(ada, 'Ada', 'gpt-6-luna'), pg_temp.model_parse(ada, 'Ada', 'gpt-6-luna'), pg_temp.version('agents/ada/agent.md'))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.model_of(ada),
		'{"provider":"openai","model":"gpt-6-luna","mapping":[{"provider":"openai","model":"gpt-6-luna"}]}', 'An edit of the model');
	select version into v_mapping_version from public.qorpera_staff_provider_models
	where profile_id = '70000000-0000-4000-8000-000000000010' and staff_agent_id = ada and provider = 'openai';
	-- A rename keeps the model, and the mapping stays as it was.
	r := pg_temp.commit(pg_temp.owner(), 'model-rename-1', jsonb_build_array(pg_temp.write('agents/ada/agent.md', 'agent',
		pg_temp.model_text(ada, 'Ada Lovelace', 'gpt-6-luna'), pg_temp.model_parse(ada, 'Ada Lovelace', 'gpt-6-luna'),
		pg_temp.version('agents/ada/agent.md'))));
	perform pg_temp.expect(r, 1, 'saved');
	if (select version from public.qorpera_staff_provider_models where profile_id = '70000000-0000-4000-8000-000000000010'
		and staff_agent_id = ada and provider = 'openai') is distinct from v_mapping_version then
		raise exception 'An edit that keeps the model moved its mapping'; end if;
	r := pg_temp.commit(pg_temp.owner(), 'model-none-1', jsonb_build_array(pg_temp.write('agents/ada/agent.md', 'agent',
		pg_temp.model_text(ada, 'Ada Lovelace', null), pg_temp.model_parse(ada, 'Ada Lovelace', null),
		pg_temp.version('agents/ada/agent.md'))));
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.same(pg_temp.model_of(ada),
		'{"provider":"openai","model":"gpt-6-astra","mapping":[{"provider":"openai","model":"gpt-6-astra"}]}', 'A file without a model');
end $$;

-- 2. An owner names an API-key company account as the agent's standing account (it answered 22023 before: the agent had
-- no model of its own).
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"70000000-0000-4000-8000-000000000001"}', true) \g /dev/null
set local role authenticated;
select set_config('qorpera_test.model_connection', public.qorpera_register_provider_connection(
	'70000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000e70', null,
	'openai', 'api_key', 'codex-cli', 'vault://company/openai', 'org-fixture', 'company-api-billing', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}',
	true)::text, true) \g /dev/null
select set_config('qorpera_test.model_sponsor', public.qorpera_create_execution_sponsor_binding(
	'70000000-0000-4000-8000-000000000010', '70000000-0000-4000-8000-000000000e71', 'company_api_billing',
	(current_setting('qorpera_test.model_connection')::jsonb ->> 'connection_id')::uuid, 1, true)::text, true) \g /dev/null
select public.qorpera_configure_staff_execution_authority('70000000-0000-4000-8000-000000000010',
	'70000000-0000-4000-8000-0000000000d1', (current_setting('qorpera_test.model_sponsor')::jsonb ->> 'binding_id')::uuid, 1, null) \g /dev/null
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

do $$
begin
	if not exists (select 1 from public.qorpera_staff_execution_authorities
		where profile_id = '70000000-0000-4000-8000-000000000010' and staff_agent_id = '70000000-0000-4000-8000-0000000000d1'
			and sponsor_binding_id = (current_setting('qorpera_test.model_sponsor')::jsonb ->> 'binding_id')::uuid) then
		raise exception 'The company account is not the agent''s standing account'; end if;
end $$;

rollback;
