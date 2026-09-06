-- The original launch trigger rejected every UPDATE, including the v2
-- admission entrypoint's archived replacement after a sponsor handoff. Keep
-- launch provenance immutable between handoffs and retain the exact old row
-- before accepting the fresh attempt's context and tool catalog.
create function public.qorpera_guard_native_launch_replacement()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_op <> 'UPDATE' or auth.role() is distinct from 'service_role' then
		raise exception 'Native launch provenance is immutable' using errcode = '42501';
	end if;
	if new.run_id is distinct from old.run_id
		or new.runtime_bundle_id is distinct from old.runtime_bundle_id
		or new.runtime_bundle_sha256 is distinct from old.runtime_bundle_sha256
		or new.binary_sha256 is distinct from old.binary_sha256
		or new.reasoning_effort is distinct from old.reasoning_effort
		or new.reasoning_policy_sha256 is distinct from old.reasoning_policy_sha256
		or not public.qorpera_run_native_start_superseded(old.run_id)
		or not exists (
			select 1 from public.qorpera_execution_runs run
			join public.qorpera_runner_jobs job on job.id=run.job_id and job.status='leased'
			join public.qorpera_execution_sponsor_handoffs handoff on handoff.run_id=run.id
				and handoff.job_id=job.id and handoff.binding_id=run.sponsor_binding_id
				and handoff.to_version=run.sponsor_version
			join public.qorpera_native_provider_connection_leases lease on lease.run_id=run.id
				and lease.job_id=job.id and lease.runner_id=job.runner_id
				and lease.assignment_id=job.client_lease_id and lease.status='active'
				and lease.provider_connection_id=handoff.to_connection_id
				and lease.expires_at>statement_timestamp()
			join public.qorpera_native_execution_launch_history history on history.run_id=old.run_id
				and history.runtime_bundle_id=old.runtime_bundle_id
				and history.runtime_bundle_sha256=old.runtime_bundle_sha256
				and history.binary_sha256=old.binary_sha256
				and history.reasoning_effort=old.reasoning_effort
				and history.reasoning_policy_sha256=old.reasoning_policy_sha256
				and history.tool_catalog_sha256=old.tool_catalog_sha256
				and history.context_sha256=old.context_sha256
				and history.context_bytes=old.context_bytes and history.launched_at=old.created_at
				and history.superseded_at>=handoff.created_at
			where run.id=old.run_id
		) then
		raise exception 'Native launch provenance is immutable' using errcode = '42501';
	end if;
	return new;
end $$;
revoke all on function public.qorpera_guard_native_launch_replacement() from public,anon,authenticated,service_role;

-- Fail closed if the deployed trigger differs from the expected predecessor.
do $$ begin
	if not exists (select 1 from pg_trigger where tgrelid='public.qorpera_native_execution_launches'::regclass
		and tgname='qorpera_native_execution_launches_immutable' and not tgisinternal
		and tgfoid='public.qorpera_reject_runtime_bundle_mutation()'::regprocedure
		and tgenabled='O' and tgtype=27) then
		raise exception 'Native launch guard differs from its approved upgrade source';
	end if;
end $$;
drop trigger qorpera_native_execution_launches_immutable on public.qorpera_native_execution_launches;
create trigger qorpera_native_execution_launches_immutable
before update or delete on public.qorpera_native_execution_launches
for each row execute function public.qorpera_guard_native_launch_replacement();
