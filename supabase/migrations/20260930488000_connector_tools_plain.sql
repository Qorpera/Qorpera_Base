-- The native host's connector tool list reads its run without the run mutex, and takes its vault rows in rank 8's
-- order (production DB slowness, 16 October 2026).
--
-- qorpera_list_native_connector_tools (20260828018000) took the run mutex through qorpera_native_tool_locked_run, and
-- then, for each of the agent's active grants in tool_name order, called qorpera_native_connector_locked_grant, which
-- takes the mutex again and then the grant and the grant's secret FOR SHARE. Two faults:
-- 1. The runtime's call of the list (describeCloudSecretTools, through path-control) gives up after 3000 ms. On
--    production on 16 October (P5 L16.2, run 5ca8ded9) the list waited on the run's budget row behind the run's start
--    steps and the run failed NATIVE_CONNECTOR_TOOLS:TIMEOUT. Without a wait the list costs about 4 ms.
-- 2. A grant, then its secret, grant by grant in tool_name order, is not rank 8's inner order (20260928459190: grants,
--    then secrets, each by id). One connection gives an agent several tools, so several grants share a secret. Where
--    the tool_name order differs from the id order, the list holds one grant FOR SHARE and waits for the next, while a
--    Disconnect (or a share, or the broker's seal) holds that next grant FOR UPDATE and waits for the first: a
--    deadlock (40P01), which the list's handler (42501 and no_data_found only) passed up as a failed step.
--
-- Now:
-- - As the entry point (the rule of 20260930487000: request.path names the list in PostgREST's form, /rpc/<name> or
--   /rest/v1/rpc/<name>, and no function but the list and the host entry is on the call stack), the list reads its run
--   through qorpera_folder_native_run_plain. Any other caller keeps qorpera_native_tool_locked_run, and a request.path
--   set by hand gains nothing inside another function.
-- - It reads the same grants as before (the agent's active grants of the run's company, at most 32 in tool_name order),
--   takes them FOR SHARE by id, then their secrets FOR SHARE by id, and keeps, in one read, each grant that
--   qorpera_native_connector_locked_grant would take: its refusal, verbatim, under not coalesce(..., false), which is
--   the null rule of its IF. It no longer calls locked_grant, which stays as it is for the broker's checks.
-- The answer is as before (the same objects in tool_name order). A caller that is neither the service role nor the
-- broker is refused by both run checks (qorpera_folder_native_actor, 42501), as before.
--
-- Why a plain read is safe here: the list reads the agent's grants, their secrets, the connector operations, the
-- agent's staff row and the company's members, and the run's profile, environment, agent and sponsor. A run's own
-- steps write none of those: members, the vault functions and the converge do, and none of them takes the mutex; the
-- run's fields change at handoff, which does not either. The list is advisory: every connector use runs locked_grant
-- again under the mutex (qorpera_assert_native_connector_operation, qorpera_authorize_cloud_secret_operation). The
-- plain run check keeps one lock, as for describe: a wake run's sponsor test takes the provider connection FOR SHARE.
--
-- What keeps the mutex: qorpera_describe_company_run_context (it reads the run's own sends and read set, which the
-- run's steps write) and qorpera_read_native_wake (a writer). The list's grants and settings are as before. DB only: no
-- caller changes.
set local lock_timeout = '3s';

create temporary table k_list_before as
select prosecdef, proconfig, provolatile, proacl, prosrc from pg_proc
where oid = 'public.qorpera_list_native_connector_tools(jsonb)'::regprocedure;

do $$
declare v_source text := (select prosrc from pg_temp.k_list_before);
begin
	if position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_source) = 0
		or position('order by grant_row.tool_name,grant_row.id limit 32' in v_source) = 0
		or position('v_grant := public.qorpera_native_connector_locked_grant(p_binding,v_grant.id);' in v_source) = 0
		or position('exception when insufficient_privilege or no_data_found then null;' in v_source) = 0
		or position('20260930' in v_source) > 0 then
		raise exception '20260930488000: qorpera_list_native_connector_tools is not the list of 20260828018000'; end if;
end $$;

create or replace function public.qorpera_list_native_connector_tools(p_binding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_context text;
	v_grants uuid[];
begin
	-- 20260930488000: as the entry point (the host's or PostgREST's request.path names the list, and no function but the
	-- host entry calls it), a plain read without the run mutex; any other caller keeps the locked run check.
	get diagnostics v_context = pg_context;
	if substring(coalesce(current_setting('request.path', true), '') from '^(?:/rest/v1)?/rpc/([a-z0-9_]+)$')
			is not distinct from 'qorpera_list_native_connector_tools'
		and v_context ~ '^PL/pgSQL function (public\.)?qorpera_list_native_connector_tools\(jsonb\) line '
		and not exists (select 1 from regexp_matches(v_context, '^(?:PL/pgSQL function |SQL function ")([^ ("]+)', 'gn') as f(name)
			where regexp_replace(f.name[1], '^public\.', '') not in ('qorpera_list_native_connector_tools',
				'qorpera_native_host_dispatch', 'qorpera_native_host_call', 'qorpera_native_host_call_long')
				and f.name[1] !~ '^(pg_temp(_[0-9]+)?\.|inline_code_block$)') then
		v_run := public.qorpera_folder_native_run_plain(p_binding);
	else
		v_run := public.qorpera_native_tool_locked_run(p_binding);
	end if;
	select array_agg(chosen.id) into v_grants from (
		select grant_row.id from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id=v_run.profile_id and grant_row.environment_id=v_run.environment_id
			and grant_row.staff_agent_id=v_run.staff_agent_id and grant_row.status='active'
		order by grant_row.tool_name,grant_row.id limit 32
	) as chosen;
	-- Rank 8's inner order (20260928459190): the grants by id, then their secrets by id.
	perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
	where grant_row.id = any(v_grants)
	order by grant_row.id for share;
	perform 1 from public.qorpera_cloud_secrets as secret
	where secret.id in (select grant_row.secret_id from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.id = any(v_grants))
	order by secret.id for share of secret;
	-- Each grant qorpera_native_connector_locked_grant would take: its refusal, verbatim (v_grant is grant_row, v_secret
	-- is secret), under its IF's null rule.
	return (
		select coalesce(jsonb_agg(jsonb_build_object(
			'schema','qorpera.native-connector-tool/v1','grantId',grant_row.id,
			'toolName',listed.tool_name,'description',listed.description,
			'inputSchema',listed.input_schema,'connectorId',listed.connector_id,
			'operationId',listed.operation_id,'operationVersion',listed.version,
			'adapterSha256',listed.adapter_sha256,'destinationOrigin',listed.destination_origin
		) order by grant_row.tool_name,grant_row.id), '[]'::jsonb)
		from public.qorpera_cloud_secret_operation_grants as grant_row
		join public.qorpera_cloud_secrets as secret on secret.id = grant_row.secret_id
		join public.qorpera_cloud_connector_operations as listed
			on listed.connector_id=grant_row.connector_id and listed.operation_id=grant_row.operation_id
				and listed.version=grant_row.operation_version
		where grant_row.id = any(v_grants) and not coalesce((
			grant_row.status <> 'active' or (grant_row.expires_at is not null and grant_row.expires_at <= clock_timestamp())
			or grant_row.profile_id <> v_run.profile_id or grant_row.environment_id <> v_run.environment_id
			or grant_row.staff_agent_id <> v_run.staff_agent_id or secret.status <> 'active'
			or secret.profile_id <> v_run.profile_id or secret.environment_id <> v_run.environment_id
			or not exists (
				select 1 from public.qorpera_cloud_connector_operations as operation
				where operation.connector_id=grant_row.connector_id and operation.operation_id=grant_row.operation_id
					and operation.version=grant_row.operation_version and operation.tool_name=grant_row.tool_name
					and operation.status='active'
			)
			or not exists (
				select 1 from public.qorpera_profile_staff as staff
				where staff.profile_id=grant_row.profile_id and staff.staff_agent_id=grant_row.staff_agent_id
					and staff.employment_status='active'
			)
			or (secret.owner_kind='company' and not exists (
				select 1 from public.qorpera_profile_members as issuer
				where issuer.profile_id=grant_row.profile_id and issuer.user_id=grant_row.issued_by_user_id
					and issuer.role in ('owner','admin')
			))
			or (secret.owner_kind='member' and (
				grant_row.issued_by_user_id <> secret.owner_user_id
				or v_run.sponsored_by_user_id is distinct from secret.owner_user_id
				or not exists (
					select 1 from public.qorpera_profile_members as owner_member
					where owner_member.profile_id=grant_row.profile_id and owner_member.user_id=secret.owner_user_id
						and owner_member.role <> 'viewer'
				)
			))
		), false)
	);
end
$$;

comment on function public.qorpera_folder_native_run_plain(jsonb) is
	'The run check of qorpera_native_tool_locked_run as plain reads: the same lookups, refusals and run row, without the '
	'run mutex (no budget row) or the locked check''s other row locks; a wake run''s sponsor test still takes the '
	'provider connection FOR SHARE. Only qorpera_describe_native_tool_authority and '
	'qorpera_list_native_connector_tools call it, each as the entry point. 20260930487000, 20260930488000.';

do $$
declare v_list pg_proc; v_before record;
begin
	select * into strict v_list from pg_proc where oid = 'public.qorpera_list_native_connector_tools(jsonb)'::regprocedure;
	select * into strict v_before from pg_temp.k_list_before;
	if position('20260930488000' in v_list.prosrc) = 0
		or position('v_run := public.qorpera_folder_native_run_plain(p_binding);' in v_list.prosrc) = 0
		or position('v_run := public.qorpera_native_tool_locked_run(p_binding);' in v_list.prosrc) = 0
		or position('qorpera_native_connector_locked_grant(' in v_list.prosrc) > 0
		or position('order by grant_row.id for share;' in v_list.prosrc) = 0
		or position('order by secret.id for share of secret;' in v_list.prosrc)
			< position('order by grant_row.id for share;' in v_list.prosrc)
		or v_list.prosecdef is distinct from v_before.prosecdef or v_list.proconfig is distinct from v_before.proconfig
		or v_list.provolatile is distinct from v_before.provolatile or v_list.proacl::text is distinct from v_before.proacl::text then
		raise exception '20260930488000: the connector tool list did not change as expected'; end if;
end $$;
