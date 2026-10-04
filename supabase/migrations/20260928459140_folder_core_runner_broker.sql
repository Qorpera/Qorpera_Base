-- Company folder core, C3 (P23, part 2): the runner broker's model of a folder-v2 run
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md §5.8 and §5.10).
--
-- A folder-v2 run has no Company File snapshot: its tools read and write the folder through the platform, and light
-- threads give a turn no workspace copy. The broker now describes such a run instead of refusing it (C1c-1), in the path
-- lane's shape ('company-path-v1': the runtime does not name the core, C1C §5.6) with no substrate anywhere: no version,
-- no snapshot, no proposal snapshot, no artifact index, no Company File output limits, and the job's and the run's
-- substrate and snapshot ids reported as null. A reader that needs a substrate refuses (the whole-tree lane among them);
-- an older reader refuses the nulls as malformed. Before P28 no folder-v2 run exists (its jobs and runs still require
-- both ids, and the materializer skips folder-v2), so nothing reaches this lane yet; P28's switch-on requires every host
-- to run the parsers that read it (the PR body names the builds).
-- * qorpera_folder_runner_broker_describe: the description, with the legacy body's checks that still apply (the run is
--   the job's, the sponsor binding, its version, the connection and its version are active and the company's, the
--   job's environment is its company's Company File, the assignment is accepted). A proposal review describes a proposal snapshot, which folder-v2 has none of: 0A000.
-- * qorpera_runner_broker_describe: on folder-v2 that description, in place of C1c-1's refusal.
-- * qorpera_runner_broker_list_operations and _list_artifacts read the substrate version: on folder-v2 they refuse with
--   0A000, where they answered P0002, so the reason is named. Over HTTP nothing changes: the broker maps both to 503,
--   which a runner retries for 360 s. No runner asks: this runtime refuses before it calls, and an older one refuses
--   the description first.
-- * Completion needs no change. The folder lane writes the runner's client substrate id (a deterministic id per job,
--   never null) into the results row, never the job's substrate; and a result naming no substrate passes its check against
--   a job with none (null is not distinct from null). So a run without a substrate completes once P28 lets one exist.

-- 1. Patch helpers (names unique to this migration: pg_temp lives for the whole session) ----------------------------

create function pg_temp.p23b_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'P23 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;
-- Inserts one statement as the body's first line (as C1c-1's guard did).
create function pg_temp.p23b_first_line(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if position(p_statement in v_definition) > 0 then raise exception 'P23 line is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'P23 anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;

-- 2. The description of a folder-v2 run ---------------------------------------------------------------------------

create function public.qorpera_folder_runner_broker_describe(p_runner_id uuid, p_session_token_sha256 text, p_job_id uuid,
	p_lease_token_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_job public.qorpera_runner_jobs%rowtype; v_run public.qorpera_execution_runs%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype; v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype;
	v_connection_version public.qorpera_provider_connection_versions%rowtype;
begin
	-- P23 (20260930002210): the path lane's description with no substrate. The plain job read, as the legacy body's.
	v_job := public.qorpera_runner_broker_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);
	select run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id and run.job_id = v_job.id;
	if v_run.source_kind = 'proposal_review' then
		raise exception 'This Company File path does not serve folder-v2 companies' using errcode = '0A000'; end if;
	select binding.* into strict v_binding from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = v_run.sponsor_binding_id and binding.status = 'active';
	select sponsor.* into strict v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_run.sponsor_binding_id and sponsor.version = v_run.sponsor_version;
	select connection.* into strict v_connection from public.qorpera_provider_connections as connection
	where connection.id = v_sponsor.provider_connection_id and connection.status = 'active';
	select connection_version.* into strict v_connection_version from public.qorpera_provider_connection_versions as connection_version
	where connection_version.connection_id = v_sponsor.provider_connection_id
		and connection_version.version = v_sponsor.provider_connection_version;
	if v_job.run_id is null or v_job.client_lease_id is null or v_run.profile_id <> v_job.profile_id
		or v_run.environment_id <> v_job.environment_id or v_binding.profile_id <> v_job.profile_id
		or v_connection.profile_id <> v_job.profile_id
		-- The job's environment is its company's folder-v2 Company File (the legacy body's file row).
		or not exists (select 1 from public.qorpera_company_files as file where file.profile_id = v_job.profile_id
			and file.environment_id = v_job.environment_id and file.core = 'folder-v2') then
		raise exception 'runner job authority is inconsistent' using errcode = '55000'; end if;
	if not exists (select 1 from public.qorpera_runner_assignments as assignment
		where assignment.id = v_job.client_lease_id and assignment.job_id = v_job.id and assignment.run_id = v_run.id
			and assignment.runner_id = p_runner_id and assignment.status = 'accepted') then
		raise exception 'runner job assignment is unavailable' using errcode = '55000'; end if;
	return jsonb_build_object(
		'company_runtime', 'company-path-v1',
		'job', public.qorpera_runner_job_json(v_job) || jsonb_build_object('substrate_version_id', null),
		'run', public.qorpera_execution_run_json(v_run) || jsonb_build_object('substrate_version_id', null, 'company_snapshot_id', null),
		'sponsor', jsonb_build_object(
			'binding_id', v_sponsor.binding_id,
			'version', v_sponsor.version,
			'kind', v_sponsor.sponsor_kind,
			'provider_connection_id', v_connection.id,
			'provider_connection_version', v_sponsor.provider_connection_version,
			'provider', v_connection.provider,
			'authentication_mode', v_connection_version.authentication_mode,
			'native_harness', v_connection_version.native_harness,
			'allow_autonomous', v_sponsor.allow_autonomous),
		'version', null,
		'snapshot', null,
		'proposal_snapshot', null,
		'artifact_index', null,
		'output_limits', jsonb_build_object('max_object_bytes', 8388608, 'max_object_count', 100, 'max_total_bytes', 67108864,
			'root_contract', 'qorpera.object/v1'),
		'company_file_output_limits', null);
end $$;

-- 3. Patches ------------------------------------------------------------------------------------------------------------

do $$
begin
	-- The broker describes a folder-v2 run in place of C1c-1's refusal.
	perform pg_temp.p23b_replace('public.qorpera_runner_broker_describe(uuid,text,uuid,text)',
		E'\tif public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;\n',
		E'\t-- P23 (20260930002210): a folder-v2 run is described in the path lane''s shape, with no substrate.\n'
		|| E'\tif public.qorpera_job_is_folder_v2(p_job_id) then\n'
		|| E'\t\treturn public.qorpera_folder_runner_broker_describe(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);\n'
		|| E'\tend if;\n', 1);

	-- The substrate's operations and artifacts: none on folder-v2.
	perform pg_temp.p23b_first_line('public.qorpera_runner_broker_list_operations(uuid,text,uuid,text,bigint,integer)',
		'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' '
		|| 'using errcode = ''0A000''; end if; -- P23 (20260930002210)');
	perform pg_temp.p23b_first_line('public.qorpera_runner_broker_list_artifacts(uuid,text,uuid,text,integer,integer)',
		'if public.qorpera_job_is_folder_v2(p_job_id) then raise exception ''This Company File path does not serve folder-v2 companies'' '
		|| 'using errcode = ''0A000''; end if; -- P23 (20260930002210)');

end $$;

-- 4. Privileges ------------------------------------------------------------------------------------------------------

-- Internal: reached only through qorpera_runner_broker_describe.
revoke all on function public.qorpera_folder_runner_broker_describe(uuid, text, uuid, text) from public, anon, authenticated, service_role;
