-- G2-1: the guest's native host calls the database without the service-role key (the coordinator's G2, 2026-10-02;
-- inventory outputs/G2-SERVICE-KEY-INVENTORY-20261002.md). Inert until a native host uses it (G2-2).
--
-- Today the native host beside the model, in every runner guest and exec-host slot, calls ~90 functions with the
-- service-role key. Most are scoped only by ids it sends (p_binding and similar), and SQL trusts the caller's role.
-- So a guest that is broken out of can act for any company. This adds one entry point the native host can call
-- with the publishable key instead:
--   qorpera_native_host_call(p_job_id, p_job_lease_token, p_name, p_args)
-- 1. It checks the runner job's lease token first, with no lock: the job is leased, its lease is current, and the
--    token's sha256 is the job's lease_token_sha256 (the runner unit in the same guest holds the token; its hash
--    is set at claim and cleared at the end). Every refusal is one 42501.
-- 2. It allows only the calls listed in qorpera_native_host_calls, each with a scope rule that ties the call's
--    arguments to that job's run: binding (p_binding's jobId and runId), lease (p_job_id, p_run_id), run
--    (p_run_id), identity (p_compute_identity_id), profile (p_profile_id), folder (p_environment_id and a
--    kind 'run' actor of this job), environment (p_environment_id), proposal (a proposal this run left), none
--    (no arguments).
-- 3. It calls the function by its declared argument names, as the platform's own service caller for this one
--    transaction (request.jwt.claims and request.jwt.claim.role, set with set_config and restored), so every
--    listed function runs exactly as it does today; and it returns its result as jsonb.
-- The listed functions stay unreachable with the publishable key. The office VM's calls and the login guest's
-- capability-bound calls are later G2 steps.
--
-- Locks: none added. The checks read the job, run and proposal without locks, before the called function takes
-- its own (the authorization-before-lock pattern of 20260928319750, 20260928329660 and 20260928339820).

set local lock_timeout = '3s';

create table public.qorpera_native_host_calls (
	name text primary key check (name ~ '^qorpera_[a-z0-9_]{1,120}$'),
	scope text not null check (scope in ('binding','lease','run','identity','profile','folder','environment','proposal','none'))
);
revoke all on public.qorpera_native_host_calls from public, anon, authenticated, service_role;
alter table public.qorpera_native_host_calls enable row level security;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_add_agent_review_rule', 'binding'),
	('qorpera_append_native_interaction_request', 'lease'),
	('qorpera_apply_company_path_approval', 'proposal'),
	('qorpera_apply_company_path_approval_v3', 'proposal'),
	('qorpera_assert_company_path_reads', 'binding'),
	('qorpera_assert_native_connector_operation', 'binding'),
	('qorpera_assert_native_office_captures', 'binding'),
	('qorpera_assert_wake_completion', 'run'),
	('qorpera_assert_wake_work_allowed', 'run'),
	('qorpera_authorize_coding_turn', 'binding'),
	('qorpera_await_action_review', 'binding'),
	('qorpera_begin_action_review', 'binding'),
	('qorpera_begin_native_coding_execution', 'binding'),
	('qorpera_begin_native_company_execution_v2', 'binding'),
	('qorpera_begin_native_tool_operation', 'binding'),
	('qorpera_check_company_path_mutation', 'binding'),
	('qorpera_commit_company_path_mutation', 'binding'),
	('qorpera_company_machines_available', 'none'),
	('qorpera_company_presence_scope', 'binding'),
	('qorpera_complete_native_tool_operation', 'binding'),
	('qorpera_confirm_agent_todo_publication', 'binding'),
	('qorpera_confirm_company_path_read', 'binding'),
	('qorpera_decide_agent_routine', 'binding'),
	('qorpera_describe_agent_open_work', 'binding'),
	('qorpera_describe_company_run_context', 'binding'),
	('qorpera_describe_native_tool_authority', 'binding'),
	('qorpera_fence_native_context', 'binding'),
	('qorpera_folder_agent_routines', 'folder'),
	('qorpera_folder_agent_todos', 'folder'),
	('qorpera_folder_commit', 'folder'),
	('qorpera_folder_complete_run_receipt', 'binding'),
	('qorpera_folder_list', 'folder'),
	('qorpera_folder_open_upload', 'folder'),
	('qorpera_folder_read', 'folder'),
	('qorpera_folder_record_release', 'folder'),
	('qorpera_folder_record_review', 'binding'),
	('qorpera_folder_renew_upload', 'folder'),
	('qorpera_folder_seal_upload', 'folder'),
	('qorpera_list_agent_event_hooks', 'binding'),
	('qorpera_list_company_paths', 'binding'),
	('qorpera_list_company_paths_v2', 'binding'),
	('qorpera_list_native_connector_tools', 'binding'),
	('qorpera_list_native_provider_account_refreshes', 'identity'),
	('qorpera_manage_agent_routine', 'binding'),
	('qorpera_manage_agent_sidebar', 'binding'),
	('qorpera_manage_agent_todo', 'binding'),
	('qorpera_manage_agent_worker', 'binding'),
	('qorpera_native_company_file_write', 'binding'),
	('qorpera_native_company_file_write_source', 'binding'),
	('qorpera_native_machine_manage', 'binding'),
	('qorpera_native_machine_start', 'binding'),
	('qorpera_native_office_browser_grant', 'binding'),
	('qorpera_native_office_capture', 'binding'),
	('qorpera_native_office_descriptor', 'binding'),
	('qorpera_native_office_file_export', 'binding'),
	('qorpera_native_office_file_import', 'binding'),
	('qorpera_native_office_operation', 'binding'),
	('qorpera_native_office_screen', 'binding'),
	('qorpera_native_office_start', 'binding'),
	('qorpera_native_office_start_descriptor', 'binding'),
	('qorpera_native_presence_forget', 'binding'),
	('qorpera_native_presence_register', 'binding'),
	('qorpera_native_presence_subject', 'environment'),
	('qorpera_office_screen_browser_grant', 'binding'),
	('qorpera_prepare_company_path_approval', 'proposal'),
	('qorpera_prepare_company_path_mutation', 'binding'),
	('qorpera_prepare_routine_login', 'binding'),
	('qorpera_read_agent_event', 'binding'),
	('qorpera_read_coding_turn_context', 'binding'),
	('qorpera_read_company_path', 'binding'),
	('qorpera_read_company_path_v2', 'binding'),
	('qorpera_read_company_run_context', 'binding'),
	('qorpera_read_native_office_capture', 'binding'),
	('qorpera_read_native_wake', 'binding'),
	('qorpera_record_action_review', 'binding'),
	('qorpera_record_coding_context_view', 'binding'),
	('qorpera_record_native_context_view', 'binding'),
	('qorpera_record_native_provider_account_metadata', 'identity'),
	('qorpera_record_provider_usage_signal', 'binding'),
	('qorpera_record_runtime_observation_batch', 'run'),
	('qorpera_record_runtime_screen_event', 'binding'),
	('qorpera_report_worker_result', 'binding'),
	('qorpera_runtime_wake_policy', 'run'),
	('qorpera_self_approve_organization_proposal', 'binding'),
	('qorpera_send_agent_mail', 'binding'),
	('qorpera_send_coworker_message', 'binding'),
	('qorpera_send_native_agent_message', 'lease'),
	('qorpera_submit_coding_turn', 'binding'),
	('qorpera_validate_native_provider_execution_lease', 'lease'),
	('qorpera_verify_company_path_file', 'profile'),
	('qorpera_verify_company_path_tree', 'profile');

create function public.qorpera_native_host_call(p_job_id uuid, p_job_lease_token text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_scope text; v_function oid; v_names text[]; v_types oid[]; v_count integer; v_retset boolean; v_rettype oid;
	v_parts text[] := '{}'; v_name text; v_type text; v_sql text; v_result jsonb;
	v_claims text; v_claim_role text; v_in_scope boolean;
begin
	-- 20260929999500: the token first, with no lock.
	if p_job_id is null or p_job_lease_token is null or octet_length(p_job_lease_token) not between 16 and 512
		or p_name is null or jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'native host call is refused' using errcode = '42501'; end if;
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	if not found or v_job.status <> 'leased' or v_job.lease_token_sha256 is null
		or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
		or v_job.lease_token_sha256 <> encode(extensions.digest(convert_to(p_job_lease_token, 'utf8'), 'sha256'), 'hex') then
		raise exception 'native host call is refused' using errcode = '42501'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not found then raise exception 'native host call is refused' using errcode = '42501'; end if;

	-- A listed call, in this run's scope.
	select calls.scope into v_scope from public.qorpera_native_host_calls as calls where calls.name = p_name;
	if not found then raise exception 'native host call is refused' using errcode = '42501'; end if;
	v_in_scope := case v_scope
		when 'binding' then jsonb_typeof(p_args -> 'p_binding') = 'object'
			and p_args #>> '{p_binding,jobId}' = v_job.id::text and p_args #>> '{p_binding,runId}' = v_run.id::text
		when 'lease' then p_args ->> 'p_job_id' = v_job.id::text and p_args ->> 'p_run_id' = v_run.id::text
		when 'run' then p_args ->> 'p_run_id' = v_run.id::text
		when 'identity' then p_args ->> 'p_compute_identity_id' = v_run.compute_identity_id::text
		when 'profile' then p_args ->> 'p_profile_id' = v_run.profile_id::text
		when 'folder' then p_args ->> 'p_environment_id' = v_run.environment_id::text
			and jsonb_typeof(p_args -> 'p_actor') = 'object' and p_args #>> '{p_actor,kind}' = 'run'
			and p_args #>> '{p_actor,jobId}' = v_job.id::text and p_args #>> '{p_actor,runId}' = v_run.id::text
		when 'environment' then p_args ->> 'p_environment_id' = v_run.environment_id::text
		when 'proposal' then exists (select 1 from public.qorpera_company_proposals as proposal
			where proposal.id::text = p_args ->> 'p_proposal_id' and proposal.profile_id = v_run.profile_id
				and proposal.execution_kind = 'run' and proposal.execution_id = v_run.id)
		when 'none' then p_args = '{}'::jsonb
		else false end;
	if v_in_scope is not true then raise exception 'native host call is refused' using errcode = '42501'; end if;

	-- The function, by its declared argument names only.
	select p.oid, p.proargnames, p.proargtypes::oid[], p.pronargs, p.proretset, p.prorettype
	into v_function, v_names, v_types, v_count, v_retset, v_rettype
	from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.proname = p_name;
	if not found or (select count(*) from pg_catalog.pg_proc as p join pg_catalog.pg_namespace as n
		on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = p_name) <> 1
		or exists (select 1 from jsonb_object_keys(p_args) as k(key)
			where v_count = 0 or not (k.key = any(v_names[1:v_count]))) then
		raise exception 'native host call is refused' using errcode = '42501'; end if;
	for i in 1 .. v_count loop
		v_name := v_names[i];
		continue when not (p_args ? v_name);
		v_type := pg_catalog.format_type(v_types[i - 1], null); -- proargtypes is zero-based
		v_parts := v_parts || case
			when v_type = 'jsonb' then format('%I => ($1 -> %L)', v_name, v_name)
			when v_type = 'json' then format('%I => ($1 -> %L)::json', v_name, v_name)
			when v_type = 'text' then format('%I => ($1 ->> %L)', v_name, v_name)
			when v_type like '%[]' then format('%I => (select coalesce(array_agg(e.value order by e.position), ''{}'')::%s '
				|| 'from jsonb_array_elements_text($1 -> %L) with ordinality as e(value, position))', v_name, v_type, v_name)
			else format('%I => ($1 ->> %L)::%s', v_name, v_name, v_type) end;
	end loop;

	-- As the platform's own service caller, for this call only.
	v_claims := current_setting('request.jwt.claims', true);
	v_claim_role := current_setting('request.jwt.claim.role', true);
	perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
	perform set_config('request.jwt.claim.role', 'service_role', true);
	perform set_config('qorpera.native_host_job', v_job.id::text, true);
	if v_retset then
		v_sql := format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from public.%I(%s) as r', p_name,
			array_to_string(v_parts, ', '));
		execute v_sql into v_result using p_args;
	elsif v_rettype = 'void'::regtype then
		execute format('select public.%I(%s)', p_name, array_to_string(v_parts, ', ')) using p_args;
		v_result := null;
	else
		execute format('select to_jsonb(public.%I(%s))', p_name, array_to_string(v_parts, ', ')) into v_result using p_args;
	end if;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
	perform set_config('qorpera.native_host_job', '', true);
	return v_result;
end
$$;
revoke all on function public.qorpera_native_host_call(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_native_host_call(uuid, text, text, jsonb) to anon;
