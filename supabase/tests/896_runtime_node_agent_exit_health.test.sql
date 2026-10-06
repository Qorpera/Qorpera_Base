-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Agent exit E2d part 1 (20260930089000) on the folder-v2 base (ported from snapshot-v1 in the legacy sweep): only the
-- node observer's service role may post or read the agent exit's health, and only through the functions; no API role
-- can post it, read it or assert it.
reset role;

select pg_temp.base_assert(not has_function_privilege(r, 'public.qorpera_observe_runtime_node_agent_exit(jsonb)', 'EXECUTE')
	and not has_function_privilege(r, 'public.qorpera_runtime_node_agent_exit_ready(uuid)', 'EXECUTE')
	and not has_function_privilege(r, 'public.qorpera_assert_runtime_node_agent_exit(jsonb)', 'EXECUTE'),
	'The API role ' || r || ' can neither post nor read the agent exit''s health')
from unnest(array['anon', 'authenticated']) r;
select pg_temp.base_assert(has_function_privilege('service_role', 'public.qorpera_observe_runtime_node_agent_exit(jsonb)', 'EXECUTE')
	and has_function_privilege('service_role', 'public.qorpera_runtime_node_agent_exit_ready(uuid)', 'EXECUTE')
	and not has_table_privilege('service_role', 'public.qorpera_runtime_node_agent_exit', 'SELECT'),
	'The service role posts and asks through the functions only');
rollback;
