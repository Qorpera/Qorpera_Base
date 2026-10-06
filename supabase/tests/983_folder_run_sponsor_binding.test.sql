-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Who may name a login as the payer of a folder-v2 company's runs (20260820002000, narrowed by 20260928230000): an
-- authorizer cannot enroll another member's personal login, cannot turn a member's login into a company account,
-- cannot bind another member's login even with that member's unattended consent, and no binding exceeds the consent
-- its login version carries (ported from snapshot-v1 in the legacy sweep, from 150_runner_orchestrator).

-- 1. The owner cannot enroll a personal login for the contributor.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.base_error($sql$select public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010',
	'98300000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002', 'openai', 'api_key', 'openai-responses',
	'vault://member/provider/openai', 'acct_member', 'member-api-budget', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
	true)$sql$, '42501', 'personal provider connection requires owner consent');
reset role;

-- The contributor enrolls their own login, consented for unattended work.
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.sb_member_connection', public.qorpera_register_provider_connection('92400000-0000-4000-8000-000000000010',
	'98300000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002', 'openai', 'api_key', 'openai-responses',
	'vault://member/provider/openai', 'acct_member', 'member-api-budget', 'qorpera-provider-consent/v1', null,
	'{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":8}',
	true)::text, true) \g /dev/null
reset role;

select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
set local role authenticated;
-- 2. A member's login never becomes a company account.
select pg_temp.base_error(format($sql$select public.qorpera_create_execution_sponsor_binding('92400000-0000-4000-8000-000000000010',
	'98300000-0000-4000-8000-000000000002', 'company_api_billing', %L, 1, false)$sql$,
	current_setting('qorpera_test.sb_member_connection')::jsonb ->> 'connection_id'),
	'22023', 'company sponsor requires a company-owned connection');
-- 3. Only the member who owns a login binds it, even with that member's unattended consent.
select pg_temp.base_error(format($sql$select public.qorpera_create_execution_sponsor_binding('92400000-0000-4000-8000-000000000010',
	'98300000-0000-4000-8000-000000000003', 'member_connection', %L, 1, true)$sql$,
	current_setting('qorpera_test.sb_member_connection')::jsonb ->> 'connection_id'),
	'42501', 'member execution sponsor requires its owner');
-- 4. A binding cannot exceed its login version's consent: the owner's native login version 1 has no unattended consent.
select pg_temp.base_error(format($sql$select public.qorpera_create_execution_sponsor_binding('92400000-0000-4000-8000-000000000010',
	'98300000-0000-4000-8000-000000000004', 'member_connection', %L, 1, true)$sql$,
	current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id'),
	'42501', 'member execution sponsor exceeds the owner consent');
reset role;

rollback;
