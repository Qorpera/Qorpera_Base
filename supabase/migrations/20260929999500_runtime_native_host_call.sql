-- G2-1: the guest's native host calls the database without the service-role key (the coordinator's G2, 2026-10-02;
-- inventory outputs/G2-SERVICE-KEY-INVENTORY-20261002.md). Inert until a native host uses it (G2-2).
--
-- Today the native host beside the model, in every runner guest and exec-host slot, calls ~90 functions with the
-- service-role key. Most are scoped only by ids it sends (p_binding and similar), and SQL trusts the caller's role.
-- So a guest that is broken out of can act for any company. This adds the entry point the native host can call
-- with the publishable key instead, in two statement budgets (see 4):
--   qorpera_native_host_call(p_job_id, p_job_lease_token, p_name, p_args)       8 s
--   qorpera_native_host_call_long(p_job_id, p_job_lease_token, p_name, p_args)  25 s, the lease validator only
-- 1. It checks the runner job's lease token first, by the job's primary key and with no lock: the job is an
--    agent turn's (its type and capability), leased, its lease is current, and the token's sha256 is the job's lease_token_sha256 (the runner
--    unit in the same guest holds the token; its hash is set at claim and cleared at the end). Every refusal is
--    one 42501 "native host call is refused".
-- 2. It allows only the calls listed in qorpera_native_host_calls (changed by migrations only; no API role reads
--    or writes it), each with a scope rule that ties the call's arguments to that job's run: binding (p_binding),
--    lease (p_job_id and p_run_id), run (p_run_id), identity (p_compute_identity_id), profile (p_profile_id),
--    folder (p_environment_id and p_actor), environment (p_environment_id), proposal (a proposal this run left),
--    none (no arguments); a proposal is a qorpera_company_path_proposals row of this run and environment.
--    Whatever the scope, p_job_id, p_run_id, p_environment_id, p_profile_id and
--    p_compute_identity_id must be this run's, p_binding must name this job and run, and p_actor must be this
--    job's kind 'run' actor (never 'platform' or 'member').
-- 3. It calls the one public function of that name (named plain inputs, a single scalar or void result) by its
--    declared argument names: identifiers through %I, types from the catalog (format_type), every value through
--    USING, read from the JSON as PostgREST reads an RPC's arguments. It runs as the platform's own service caller
--    on the function's own RPC path for that call (request.jwt.claims, request.jwt.claim.role and request.path, set
--    with set_config and restored; the shared company readers choose their lock strength by request.path), so
--    every listed function runs as today, and its errors reach the caller unchanged (no handler). The result comes
--    back as jsonb, as PostgREST returns a scalar; a void call returns null where PostgREST answered 204, which a
--    supabase-js caller reads as the same null.
-- 4. Each call keeps the statement budget it has today: PostgREST applies the called function's statement_timeout to
--    the request, which is now the entry point's. The list names each call's entry point (budget): the lease
--    validator's own 25 s through qorpera_native_host_call_long, everything else authenticator's 8 s. Both share
--    one body, qorpera_native_host_dispatch, which no role can call.
-- The listed functions stay unreachable with the publishable key. The office VM's calls, the login guest's
-- capability-bound calls and the native host's calls between jobs are later G2 steps.
--
-- Locks: none added. The checks read the job, run and proposal without locks, before the called function takes
-- its own (the authorization-before-lock pattern of 20260928319750, 20260928329660 and 20260928339820).

set local lock_timeout = '3s';

create table public.qorpera_native_host_calls (
	name text primary key check (name ~ '^qorpera_[a-z0-9_]{1,120}$'),
	scope text not null check (scope in ('binding','lease','run','identity','profile','folder','environment','proposal','none')),
	-- The entry point whose statement budget the call gets: 'standard' (8 s, authenticator's) or 'long' (25 s).
	budget text not null default 'standard' check (budget in ('standard', 'long'))
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
	('qorpera_native_office_capture', 'binding'),
	('qorpera_native_office_descriptor', 'binding'),
	('qorpera_native_office_operation', 'binding'),
	('qorpera_native_office_screen', 'binding'),
	('qorpera_native_office_start', 'binding'),
	('qorpera_native_office_start_descriptor', 'binding'),
	('qorpera_native_presence_forget', 'binding'),
	('qorpera_native_presence_register', 'binding'),
	('qorpera_native_presence_subject', 'environment'),
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
	('qorpera_report_worker_result', 'binding'),
	('qorpera_self_approve_organization_proposal', 'binding'),
	('qorpera_send_agent_mail', 'binding'),
	('qorpera_send_coworker_message', 'binding'),
	('qorpera_send_native_agent_message', 'lease'),
	('qorpera_submit_coding_turn', 'binding'),
	('qorpera_validate_native_provider_execution_lease', 'lease'),
	('qorpera_verify_company_path_file', 'profile'),
	('qorpera_verify_company_path_tree', 'profile');
-- The lease validator sets statement_timeout 25s for itself (20260913000100, for the host's authority monitor), and
-- PostgREST applies a called function's statement_timeout to its request: it keeps that budget through the long
-- entry point.
update public.qorpera_native_host_calls set budget = 'long' where name = 'qorpera_validate_native_provider_execution_lease';

-- The shared body of both entry points; p_budget is the entry point's, never the caller's.
create function public.qorpera_native_host_dispatch(p_job_id uuid, p_job_lease_token text, p_name text, p_args jsonb,
	p_budget text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype; v_scope text; v_budget text;
	v_function pg_catalog.pg_proc%rowtype; v_inputs text; v_columns text; v_sql text; v_result jsonb;
	v_claims text; v_claim_role text; v_path text;
begin
	-- 20260929999500: the token first, by the job's primary key, with no lock.
	if p_job_id is null or p_job_lease_token is null or octet_length(p_job_lease_token) not between 16 and 512
		or p_name is null or p_name !~ '^qorpera_[a-z0-9_]{1,120}$' or jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'native host call is refused' using errcode = '42501'; end if;
	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id;
	if not found or v_job.status <> 'leased' or v_job.job_type <> 'agent_turn' or v_job.required_capability <> 'agent_turn'
		or v_job.run_id is null
		or v_job.lease_token_sha256 is null
		or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp()
		or v_job.lease_token_sha256 <> encode(extensions.digest(convert_to(p_job_lease_token, 'utf8'), 'sha256'), 'hex') then
		raise exception 'native host call is refused' using errcode = '42501'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;
	if not found then raise exception 'native host call is refused' using errcode = '42501'; end if;

	-- A listed call in this run's scope. An argument that names a job, run, environment, company, compute identity,
	-- binding or folder actor must be this run's, whatever the call's scope.
	select calls.scope, calls.budget into v_scope, v_budget from public.qorpera_native_host_calls as calls where calls.name = p_name;
	if not found or v_budget is distinct from p_budget
		or (p_args ? 'p_job_id' and p_args ->> 'p_job_id' is distinct from v_job.id::text)
		or (p_args ? 'p_run_id' and p_args ->> 'p_run_id' is distinct from v_run.id::text)
		or (p_args ? 'p_environment_id' and p_args ->> 'p_environment_id' is distinct from v_run.environment_id::text)
		or (p_args ? 'p_profile_id' and p_args ->> 'p_profile_id' is distinct from v_run.profile_id::text)
		or (p_args ? 'p_compute_identity_id'
			and p_args ->> 'p_compute_identity_id' is distinct from v_run.compute_identity_id::text)
		or (p_args ? 'p_binding' and (p_args #>> '{p_binding,jobId}' is distinct from v_job.id::text
			or p_args #>> '{p_binding,runId}' is distinct from v_run.id::text))
		or (p_args ? 'p_actor' and (p_args #>> '{p_actor,kind}' is distinct from 'run'
			or p_args #>> '{p_actor,jobId}' is distinct from v_job.id::text
			or p_args #>> '{p_actor,runId}' is distinct from v_run.id::text))
		or (case v_scope
			when 'binding' then p_args ? 'p_binding'
			when 'lease' then p_args ?& array['p_job_id', 'p_run_id']
			when 'run' then p_args ? 'p_run_id'
			when 'identity' then p_args ? 'p_compute_identity_id'
			when 'profile' then p_args ? 'p_profile_id'
			when 'folder' then p_args ?& array['p_environment_id', 'p_actor']
			when 'environment' then p_args ? 'p_environment_id'
			when 'proposal' then p_args ->> 'p_proposal_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				and exists (select 1 from public.qorpera_company_path_proposals as proposal
					where proposal.id = (p_args ->> 'p_proposal_id')::uuid and proposal.run_id = v_run.id
						and proposal.environment_id = v_run.environment_id)
			when 'none' then p_args = '{}'::jsonb
			else false end) is not true then
		raise exception 'native host call is refused' using errcode = '42501'; end if;

	-- The one public function of that name: named plain inputs only, and a single scalar or void result.
	select p.* into v_function from pg_catalog.pg_proc as p
	where p.pronamespace = 'public'::regnamespace and p.proname = p_name;
	if not found
		or (select count(*) from pg_catalog.pg_proc as p where p.pronamespace = 'public'::regnamespace and p.proname = p_name) <> 1
		or v_function.prokind <> 'f' or v_function.proretset or v_function.proargmodes is not null
		or not (v_function.prorettype = 'void'::regtype or exists (select 1 from pg_catalog.pg_type as t
			where t.oid = v_function.prorettype and t.typtype in ('b', 'd', 'e')))
		or exists (select 1 from jsonb_object_keys(p_args) as k(key)
			where not (k.key = any(coalesce(v_function.proargnames[1:v_function.pronargs], '{}'::text[])))) then
		raise exception 'native host call is refused' using errcode = '42501'; end if;

	-- The call: identifiers through %I, types from the catalog, every value through USING, read from the JSON
	-- the way PostgREST reads an RPC's arguments (json_to_record); arguments left out take their defaults.
	select string_agg(format('%I => r.%I', a.name, a.name), ', ' order by a.position),
		string_agg(format('%I %s', a.name, pg_catalog.format_type(a.type, null)), ', ' order by a.position)
	into v_inputs, v_columns
	from unnest(v_function.proargnames[1:v_function.pronargs], v_function.proargtypes::oid[])
		with ordinality as a(name, type, position)
	where p_args ? a.name;
	v_sql := format('public.%I(%s)', p_name, coalesce(v_inputs, ''));
	v_sql := case when v_function.prorettype = 'void'::regtype then 'select ' || v_sql else format('select to_jsonb(%s)', v_sql) end
		|| case when v_inputs is null then '' else format(' from jsonb_to_record($1) as r(%s)', v_columns) end;

	-- As the platform's own service caller, on the called function's own RPC path (qorpera_company_fence_shared
	-- chooses the shared company lock by request.path), for this call only. No handler: the called function's errors
	-- reach the caller unchanged, and the transaction (or the caller's savepoint) undoes these settings with it.
	v_claims := current_setting('request.jwt.claims', true);
	v_claim_role := current_setting('request.jwt.claim.role', true);
	v_path := current_setting('request.path', true);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	perform set_config('request.jwt.claim.role', 'service_role', true);
	perform set_config('request.path', '/rpc/' || p_name, true);
	if v_function.prorettype = 'void'::regtype then
		execute v_sql using p_args;
	else
		execute v_sql into v_result using p_args;
	end if;
	perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
	perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
	perform set_config('request.path', coalesce(v_path, ''), true);
	return v_result;
end
$$;
revoke all on function public.qorpera_native_host_dispatch(uuid, text, text, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The entry points. PostgREST applies a called function's statement_timeout to its request (db-hoisted-tx-settings),
-- so each carries the budget its calls had when the native host called them directly: authenticator's 8 s, or the
-- lease validator's own 25 s. Without it a call would get the publishable key's 3 s. lock_timeout is authenticator's
-- 8 s, for the length of the call.
create function public.qorpera_native_host_call(p_job_id uuid, p_job_lease_token text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
	set statement_timeout = '8s' set lock_timeout = '8s' as $$
begin
	return public.qorpera_native_host_dispatch(p_job_id, p_job_lease_token, p_name, p_args, 'standard');
end
$$;
create function public.qorpera_native_host_call_long(p_job_id uuid, p_job_lease_token text, p_name text, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
	set statement_timeout = '25s' set lock_timeout = '8s' as $$
begin
	return public.qorpera_native_host_dispatch(p_job_id, p_job_lease_token, p_name, p_args, 'long');
end
$$;
revoke all on function public.qorpera_native_host_call(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_native_host_call_long(uuid, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_native_host_call(uuid, text, text, jsonb) to anon;
grant execute on function public.qorpera_native_host_call_long(uuid, text, text, jsonb) to anon;
