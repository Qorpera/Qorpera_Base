-- Summary trees M1b-4b-3 (RUNTIME-AGENT-MEMORY-TREE.md §5.4, §7.1; contract §6, §7): a company run's admission in two
-- calls, in the contract's own order (admitted → composing → running).
-- * qorpera_begin_native_company_execution_v3 admits the run before any provider work: the binary, the bundle, the
--   reasoning policy and the exact tool catalog, with every check of v2 except the context's. It keeps the admission
--   for the run's lease and writes no launch and no runner_started.
-- * Composing then runs on that admission: the settle (the compactor's calls) and the context it composes. The memory
--   calls need no launch, so they work here.
-- * qorpera_bind_native_company_context binds the composed context's hash and bytes, once: it takes the admission of
--   the run's lease and hands it, with the context, to v2, which checks it all again against the run and writes the
--   launch and runner_started. The thread starts only after it. A run whose settle fails ends, or is tried again,
--   without a launch.
-- v2 is unchanged: the coding wrapper (qorpera_begin_native_coding_execution) keeps calling it.

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_native_execution_admissions') is not null then
		raise exception 'M1b-4b-3 (20260930300100) is already applied'; end if;
	if to_regclass('public.qorpera_memory_compactions') is null
		or to_regprocedure('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)') is null
		or to_regprocedure('public.qorpera_company_run_actor(uuid,jsonb)') is null then
		raise exception 'M1b-4b-3 (20260930300100) needs M1b-4b-2 (20260930300000)'; end if;
end $$;

-- One admission per run, of the lease that admitted it; the bind takes it.
create table public.qorpera_native_execution_admissions (
	run_id uuid primary key references public.qorpera_execution_runs(id) on delete cascade,
	lease_id uuid not null,
	binary_sha256 text not null check (binary_sha256 ~ '^[0-9a-f]{64}$'),
	runtime_bundle_sha256 text not null,
	reasoning_policy_sha256 text not null check (reasoning_policy_sha256 ~ '^[0-9a-f]{64}$'),
	tool_catalog_text text not null check (octet_length(tool_catalog_text) between 1 and 1048576),
	tool_catalog_sha256 text generated always as (encode(extensions.digest(tool_catalog_text, 'sha256'), 'hex')) stored,
	created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_native_execution_admissions enable row level security;
revoke all on public.qorpera_native_execution_admissions from public, anon, authenticated, service_role;

-- v2's checks in v2's order, without the context's (20260922151000, with 20260924130000's bounds and 20260928279470's
-- run actor).
create function public.qorpera_begin_native_company_execution_v3(
	p_binding jsonb, p_binary_sha256 text, p_runtime_bundle_sha256 text, p_reasoning_policy_sha256 text,
	p_tool_catalog_text text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930300100 (M1b-4b-3)
declare v_actor jsonb; v_run public.qorpera_execution_runs%rowtype; v_manifest jsonb; v_catalog jsonb; v_catalog_sha text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_manifest := public.qorpera_execution_runtime_manifest(v_run);
	if p_runtime_bundle_sha256 is distinct from v_run.runtime_bundle_sha256
		or p_binary_sha256 is distinct from v_manifest ->> 'nativeBinarySha256'
		or not public.qorpera_manifest_allows_reasoning_effort(v_manifest, v_run.reasoning_effort)
		or p_reasoning_policy_sha256 is distinct from v_run.reasoning_policy_sha256
		or p_reasoning_policy_sha256 is distinct from
			encode(extensions.digest(convert_to((v_manifest -> 'modelPolicy')::text, 'utf8'), 'sha256'), 'hex') then
		raise exception 'Native executable policy differs from the admitted run' using errcode = '42501'; end if;
	if p_tool_catalog_text is null or octet_length(p_tool_catalog_text) not between 1 and 1048576 then
		raise exception 'Native launch provenance is invalid' using errcode = '22023'; end if;
	v_catalog := p_tool_catalog_text::jsonb;
	if jsonb_typeof(v_catalog) is distinct from 'object'
		or v_catalog - array['type','name','description','tools'] <> '{}'::jsonb
		or v_catalog ->> 'type' is distinct from 'namespace' or v_catalog ->> 'name' is distinct from 'qorpera'
		or jsonb_typeof(v_catalog -> 'description') is distinct from 'string'
		or jsonb_typeof(v_catalog -> 'tools') is distinct from 'array' then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_catalog -> 'tools') < 1
		or exists(select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'type' is distinct from 'function'
				or coalesce(tool ->> 'name', '') !~ '^[a-z][a-z0-9_]{0,63}$'
				or jsonb_typeof(tool -> 'description') is distinct from 'string'
				or tool #>> '{inputSchema,type}' is distinct from 'object'
				or tool #> '{inputSchema,additionalProperties}' is distinct from 'false'::jsonb
				or tool - array['type','name','description','inputSchema'] <> '{}'::jsonb)
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool)
			<> jsonb_array_length(v_catalog -> 'tools') then
		raise exception 'Native catalog provenance is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_run_actor(v_run.environment_id, p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if exists(select 1 from public.qorpera_execution_run_events where run_id = v_run.id
		and event_type = 'runner_started' and payload ->> 'schema' = 'qorpera.native-company-execution-start/v1')
		and not public.qorpera_run_native_start_superseded(v_run.id) then
		raise exception 'Earlier native execution requires reconciliation' using errcode = '55000'; end if;
	-- A later lease of the run admits it again; the earlier lease's admission is gone with it.
	insert into public.qorpera_native_execution_admissions(run_id, lease_id, binary_sha256, runtime_bundle_sha256,
		reasoning_policy_sha256, tool_catalog_text)
	values (v_run.id, (p_binding ->> 'leaseId')::uuid, p_binary_sha256, v_run.runtime_bundle_sha256,
		v_run.reasoning_policy_sha256, p_tool_catalog_text)
	on conflict (run_id) do update set lease_id = excluded.lease_id, binary_sha256 = excluded.binary_sha256,
		runtime_bundle_sha256 = excluded.runtime_bundle_sha256, reasoning_policy_sha256 = excluded.reasoning_policy_sha256,
		tool_catalog_text = excluded.tool_catalog_text, created_at = clock_timestamp()
	returning tool_catalog_sha256 into v_catalog_sha;
	return jsonb_build_object('schema', 'qorpera.native-company-execution-admission/v1',
		'runId', v_run.id, 'jobId', v_run.job_id, 'leaseId', p_binding ->> 'leaseId', 'binarySha256', p_binary_sha256,
		'runtimeBundleSha256', v_run.runtime_bundle_sha256, 'reasoningEffort', v_run.reasoning_effort,
		'reasoningPolicySha256', v_run.reasoning_policy_sha256, 'toolCatalogSha256', v_catalog_sha);
end
$$;

-- The composed context, bound once to the admission of the run's lease. v2 checks the admitted values against the
-- run again, with the context, and answers its start record; a refusal there keeps the admission for a retry.
create function public.qorpera_bind_native_company_context(p_binding jsonb, p_context_sha256 text, p_context_bytes integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 20260930300100 (M1b-4b-3)
declare v_run public.qorpera_execution_runs%rowtype; v_admission public.qorpera_native_execution_admissions%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Native execution admission is unavailable' using errcode = '42501'; end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	delete from public.qorpera_native_execution_admissions
	where run_id = v_run.id and lease_id = (p_binding ->> 'leaseId')::uuid
	returning * into v_admission;
	if not found then
		raise exception 'Native execution is not admitted' using errcode = '55000'; end if;
	return public.qorpera_begin_native_company_execution_v2(p_binding, v_admission.binary_sha256,
		v_admission.runtime_bundle_sha256, v_admission.reasoning_policy_sha256, v_admission.tool_catalog_text,
		p_context_sha256, p_context_bytes);
end
$$;

revoke all on function public.qorpera_begin_native_company_execution_v3(jsonb, text, text, text, text)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_bind_native_company_context(jsonb, text, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_begin_native_company_execution_v3(jsonb, text, text, text, text) to service_role;
grant execute on function public.qorpera_bind_native_company_context(jsonb, text, integer) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_begin_native_company_execution_v3', 'binding'),
	('qorpera_bind_native_company_context', 'binding');
