-- A runner a provider left pending, with no machine ever reserved for it, goes to the provider that
-- runs the attempt now (Stateless Compute step 1 follow-up, found in step 7 on 2026-09-28).
--
-- A run's attempt has one runner, provisioned under the attempt's acquisition id by the first provider
-- that acquires it. A provider provisions before it reserves a machine, and the node chooser may then
-- refuse it (NODE_NOT_PREFERRED): the runner stays pending and bound to that provider. A run whose
-- login is in the vault has no home node, so another node is often the preferred one; its provider
-- then found the runner bound elsewhere and failed every attempt with 23505 ("runner client id is
-- already bound to other compute authority"). The same held for the first provider's own retry after
-- it retired the refused acquisition: a new activation for the same pending runner was refused.
--
-- When no allocation has ever named the runner, provisioning gives the pending runner to the caller,
-- with the caller's provider adapter and a new activation, and records a registration receipt for it.
-- Activation needs a pending runner and its current activation digest (qorpera_activate_runner, under
-- the runner row's lock), so the old activation can never activate it afterwards: at worst a start
-- the old provider still made fails. The node providers (LXD and shared execution) reserve a machine
-- before they hand an activation to anything that could use it, so for them a runner without an
-- allocation is one no machine holds. A runner with an allocation (even a released one), an active or
-- revoked runner, or one of other compute authority is refused as before. Locks: the run and job rows
-- are read for share first, as before (a reservation locks the job row for update, so a rebind and a
-- reservation of the same run never interleave), then the runner row for update; the allocation check
-- reads its unique runner index; the receipt is written as the first registration's is.
do $$
declare
	v_target regprocedure := 'public.qorpera_provision_execution_runner(uuid,uuid,text,text)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text := E'\tfor update;\n\tif found then\n\t\tif v_runner.runner_kind <> ''qorpera_computer''';
	v_new text;
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Runner provisioning source differs';
	end if;
	v_new := E'\tfor update;\n'
		|| E'\t-- A pending runner no machine was ever reserved for goes to this provider (20260928235000).\n'
		|| E'\tif found and v_runner.status = ''pending''\n'
		|| E'\t\tand (v_runner.provider_adapter is distinct from p_provider_adapter\n'
		|| E'\t\t\tor v_runner.activation_token_sha256 is distinct from p_activation_token_sha256)\n'
		|| E'\t\tand v_runner.runner_kind = ''qorpera_computer''\n'
		|| E'\t\tand v_runner.logical_computer_id is not distinct from v_run.logical_computer_id\n'
		|| E'\t\tand v_runner.compute_identity_id is not distinct from v_identity.id\n'
		|| E'\t\tand v_runner.worker_class is not distinct from v_worker_class\n'
		|| E'\t\tand v_runner.template_key is not distinct from v_template_key\n'
		|| E'\t\tand v_runner.template_version is not distinct from v_template_version\n'
		|| E'\t\tand v_runner.compute_policy_sha256 is not distinct from public.qorpera_compute_policy_sha256(v_policy)\n'
		|| E'\t\tand v_runner.capabilities = v_capabilities and v_runner.max_concurrency = 1\n'
		|| E'\t\tand not exists (select 1 from public.qorpera_runtime_machine_allocations as allocation\n'
		|| E'\t\t\twhere allocation.runner_id = v_runner.id) then\n'
		|| E'\t\tupdate public.qorpera_runners\n'
		|| E'\t\tset provider_adapter = p_provider_adapter, activation_token_sha256 = p_activation_token_sha256,\n'
		|| E'\t\t\tactivation_expires_at = statement_timestamp() + interval ''15 minutes''\n'
		|| E'\t\twhere id = v_runner.id\n'
		|| E'\t\treturning * into v_runner;\n'
		|| E'\t\tperform public.qorpera_append_runner_audit(\n'
		|| E'\t\t\tv_runner.profile_id, v_runner.id, v_job.id, ''runner_registered'',\n'
		|| E'\t\t\tjsonb_build_object(\n'
		|| E'\t\t\t\t''run_id'', v_run.id,\n'
		|| E'\t\t\t\t''compute_identity_id'', v_runner.compute_identity_id,\n'
		|| E'\t\t\t\t''logical_computer_id'', v_runner.logical_computer_id,\n'
		|| E'\t\t\t\t''worker_class'', v_runner.worker_class,\n'
		|| E'\t\t\t\t''provider_adapter'', v_runner.provider_adapter,\n'
		|| E'\t\t\t\t''template_key'', v_runner.template_key,\n'
		|| E'\t\t\t\t''template_version'', v_runner.template_version,\n'
		|| E'\t\t\t\t''compute_policy_sha256'', v_runner.compute_policy_sha256,\n'
		|| E'\t\t\t\t''activation_expires_at'', v_runner.activation_expires_at,\n'
		|| E'\t\t\t\t''rebound'', true\n'
		|| E'\t\t\t), v_run.requested_by_user_id\n'
		|| E'\t\t);\n'
		|| E'\t\treturn public.qorpera_runner_json(v_runner);\n'
		|| E'\tend if;\n'
		|| E'\tif found then\n\t\tif v_runner.runner_kind <> ''qorpera_computer''';
	execute replace(v_definition, v_old, v_new);
end
$$;
