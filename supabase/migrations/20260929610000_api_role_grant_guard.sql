-- Found by running the SQL suite with production's function default privileges
-- (supabase/tests/platform-function-defaults.sql):
-- * qorpera_list_staff_execution_activity is a member RPC (granted to authenticated, 20260922010000), and
--   test 586 pins that anon cannot execute it. The platform default gave anon EXECUTE anyway. Its body
--   already refuses a caller who is not a member of the company (42501), so this removes a grant, not a leak.
-- * The three CHECK constraint validators that 20260929570000 left to service_role (which may write the
--   constrained tables, and PostgreSQL checks EXECUTE on a CHECK's functions as the writing role) had that
--   grant from the platform default only. Grant it by name, so it holds if the default changes or a
--   validator is re-created; test 749 pins it.
set local lock_timeout = '3s';

revoke execute on function public.qorpera_list_staff_execution_activity(uuid) from anon;

grant execute on function
	public.qorpera_provider_quota_policy_valid(jsonb),
	public.qorpera_runner_capabilities_valid(jsonb),
	public.qorpera_uuid_array_is_unique(uuid[])
	to service_role;
