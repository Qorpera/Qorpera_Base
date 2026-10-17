-- @fixture 628_runtime_company_machines.test.sql until "-- 4. Full: the next machine waits in line, unplaced, with its place and its reason."
-- Company machines without a repository disk (20260930506000, F3 step 6, slice 6e, part 1). A coding session's work is
-- in the company folder, so a machine gets no repository folder and is tied to no repository's node: no
-- repository_worker_id, no 'repository' in its view, no repositoryWorker in machine_start, and a v2 binding. The
-- binding text keeps the v1 key order for the v1 executor's custody of its retired placements (6e-1's rollout).
-- The retirement of the v1 placements the migration finds is scripts/test-company-machine-v2-retire.mjs.
-- At this point of 628: node A (machine-a, executor mx-a) holds build-a, placed and starting.
select pg_temp.base_claims('service_role');

-- 1. No repository column, and no function about the repository disk or the v1 binding (but the binding text).
do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from pg_catalog.pg_attribute
		where attrelid = 'public.qorpera_company_machines'::regclass and attname = 'repository_worker_id' and not attisdropped),
		'A machine has no repository');
	perform pg_temp.base_assert(not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
		where n.nspname not in ('pg_catalog', 'information_schema')
			and (position('repository_worker_id' in p.prosrc) > 0 or position('lxd-company-machine/v1' in p.prosrc) > 0
				or (position('repositoryWorker' in p.prosrc) > 0
					and p.oid <> 'public.qorpera_company_machine_binding_text(jsonb)'::regprocedure))),
		'No function names the repository disk or the v1 binding');
end $$;

-- 2. A placement is v2, without the repository key; the machine's view has no repository.
do $$
declare v_place public.qorpera_company_machine_placements := pg_temp.mc_placement('build-a');
begin
	perform pg_temp.base_assert(v_place.binding ->> 'schema' = 'qorpera.lxd-company-machine/v2'
		and not v_place.binding ? 'repositoryWorkerId'
		and not exists (select 1 from public.qorpera_company_machine_placements
			where binding ->> 'schema' is distinct from 'qorpera.lxd-company-machine/v2' and retired_at is null and removed_at is null),
		'Every current placement is v2: ' || v_place.binding::text);
	perform pg_temp.base_assert(not public.qorpera_company_machine_view(pg_temp.mc_machine('build-a')) ? 'repository',
		'The view has no repository');
end $$;

-- 3. machine_start refuses repositoryWorker as any other argument it does not know.
do $$
declare v_args jsonb := '{"name":"repo","purpose":"Build the repository","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}';
begin
	perform pg_temp.base_error(format($sql$select public.qorpera_native_machine_start(%L,%L,'authorize')$sql$, pg_temp.mc_binding(),
		pg_temp.mc_start_envelope('repo', v_args || '{"repositoryWorker":"worker-1"}')), '42501');
	perform pg_temp.base_assert(public.qorpera_native_machine_start(pg_temp.mc_binding(), pg_temp.mc_start_envelope('repo', v_args),
		'authorize') ->> 'state' = 'authorized', 'The same start without it is authorized');
end $$;

-- 4. The binding text of a v1 binding (from the node release before 6e-1) is still the v1 executor's: its custody of a
--    retired v1 placement matches until that executor deletes the instance.
do $$
begin
	perform pg_temp.base_assert(public.qorpera_company_machine_binding_text(jsonb_build_object('schema','qorpera.lxd-company-machine/v1',
		'machineId','00000000-0000-4000-8000-000000000002','placementId','00000000-0000-4000-8000-000000000005',
		'companyId','00000000-0000-4000-8000-000000000003',
		'environmentId','00000000-0000-4000-8000-000000000004','providerId','machine-node','providerPolicySha256',repeat('a',64),
		'project','machines','imageFingerprint',repeat('b',64),'bootstrapSha256',repeat('c',64),'storagePool','machines',
		'network','qagent0','cpus',8,'memoryBytes',34359738368,'rootDiskBytes',107374182400,'repositoryWorkerId',null))
		= '{"schema":"qorpera.lxd-company-machine/v1","machineId":"00000000-0000-4000-8000-000000000002",'
			|| '"placementId":"00000000-0000-4000-8000-000000000005","companyId":"00000000-0000-4000-8000-000000000003",'
			|| '"environmentId":"00000000-0000-4000-8000-000000000004","providerId":"machine-node","providerPolicySha256":"' || repeat('a',64)
			|| '","project":"machines","imageFingerprint":"' || repeat('b',64) || '","bootstrapSha256":"' || repeat('c',64)
			|| '","storagePool":"machines","network":"qagent0","cpus":8,"memoryBytes":34359738368,"rootDiskBytes":107374182400,"repositoryWorkerId":null}',
		'The v1 binding text is unchanged');
end $$;
rollback;
