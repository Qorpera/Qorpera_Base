-- Company machines without a repository disk: F3 step 6, slice 6e, part 1 (deploy/first-node/RUNTIME-FOLDER-TEST-MACHINES.md
-- "What replaces /mnt/repository"). A coding session's work is in the company folder, at
-- /company/code/<owner>/<name>/worktrees/<workerId>, which a machine started by an agent and member who may read all
-- of it mounts. So a machine no longer gets a coding session's repository folder read-only at /mnt/repository, and is
-- no longer tied to the node whose NAS holds that session.
-- 1. machine_start no longer takes repositoryWorker: it is refused as any other unknown argument. A machine has no
--    repository_worker_id (the column goes), and its view no 'repository'.
-- 2. A placement's binding is qorpera.lxd-company-machine/v2: v1 without repositoryWorkerId. Admission, the executor's
--    pick and the node reservation no longer keep a machine on, or send it to, a repository's node: a sleeping machine
--    moves, and wakes on a node whose agent exit is down, like any other. The operator's view of a company's machines
--    gives each company machine a null codingWorkerId.
-- 3. Every current v1 placement is retired here, as a move retires one: its open commands end lost (the runs that
--    asked are told), and the machine, still wanting what it wanted, is placed again with a v2 binding. The executor
--    that knows v1 (the node release before this one) stops and deletes each retired v1 instance, as any retired one.
--    So the database goes first and the node after, once no retired v1 placement is left (the PR's "Rollout"). An
--    executor that knows only v2 refuses a v1 binding and leaves its instance alone.
-- The binding text keeps repositoryWorkerId in its key order: a v2 binding has no such key, so its text has none, and
-- the v1 executor's custody of its retired placements (which sends the v1 text) still matches. It goes once no v1
-- executor is left.
--
-- Exact-text patches: each fails unless the function has the text given exactly once.

set local lock_timeout = '3s';

do $$ begin
	if not exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_company_machines'::regclass
		and attname = 'repository_worker_id' and not attisdropped) then
		raise exception 'Company machines without a repository disk (20260930506000) are already applied'; end if;
end $$;

create function pg_temp.company_machine_repository_patch(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text this migration expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 3. The current v1 placements, retired (under the machine and the placement, the executor's custody order) ---------

do $retire$
declare v_machine public.qorpera_company_machines%rowtype;
begin
	for v_machine in select machine.* from public.qorpera_company_machines machine
		join public.qorpera_company_machine_placements placement on placement.machine_id = machine.id
			and placement.retired_at is null and placement.removed_at is null
		where placement.binding ->> 'schema' = 'qorpera.lxd-company-machine/v1'
		order by machine.id for update of machine, placement loop
		-- Its programs stop with it; the runs that asked are told.
		perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
		update public.qorpera_company_machine_placements set retired_at = clock_timestamp()
		where machine_id = v_machine.id and retired_at is null and removed_at is null;
	end loop;
end
$retire$;

-- 1. The machine's view -------------------------------------------------------------------------------------------

select pg_temp.company_machine_repository_patch('public.qorpera_company_machine_view(public.qorpera_company_machines)'::regprocedure,
	$old$		'repository', (select jsonb_build_object('workerKey', worker.worker_key, 'title', worker.title)
			from public.qorpera_runtime_workers worker where worker.id = p_machine.repository_worker_id),
$old$,
	$new$		-- 20260930506000 (F3 6e-1): no repository; a coding session's work is in the company folder.
$new$);

-- 2. Placement: the v2 binding ------------------------------------------------------------------------------------

select pg_temp.company_machine_repository_patch('public.qorpera_place_company_machine(uuid,text,uuid)'::regprocedure,
	$old$	-- A repository lives on the NAS of the node that holds its coding session (until the company folder).
	if v_machine.repository_worker_id is not null and not exists (select 1 from public.qorpera_coding_storage_volumes volume
		where volume.worker_id = v_machine.repository_worker_id and volume.owner = v_executor.owner
			and volume.machine_id_sha256 = v_executor.machine_id_sha256) then
		return '{"state":"refused","reason":"REPOSITORY_ON_ANOTHER_NODE"}'::jsonb; end if;
	v_binding := jsonb_build_object('schema','qorpera.lxd-company-machine/v1','machineId',v_machine.id,'placementId',v_placement,
		'companyId',v_machine.profile_id,'environmentId',v_machine.environment_id) || v_executor.policy
		|| jsonb_build_object('cpus',v_machine.cpus,'memoryBytes',v_machine.memory_bytes,'rootDiskBytes',v_machine.disk_bytes,
			'repositoryWorkerId',v_machine.repository_worker_id);$old$,
	$new$	-- 20260930506000 (F3 6e-1): v2, no repository disk; a coding session's work is in the company folder.
	v_binding := jsonb_build_object('schema','qorpera.lxd-company-machine/v2','machineId',v_machine.id,'placementId',v_placement,
		'companyId',v_machine.profile_id,'environmentId',v_machine.environment_id) || v_executor.policy
		|| jsonb_build_object('cpus',v_machine.cpus,'memoryBytes',v_machine.memory_bytes,'rootDiskBytes',v_machine.disk_bytes);$new$);

-- Admission: a sleeping machine may move, and the largest sizes are any node's.
select pg_temp.company_machine_repository_patch('public.qorpera_admit_company_machine(uuid,text)'::regprocedure,
	$old$		-- Moving drops the scratch disk: only for a machine that is not running, never away from its
		-- repository's node, and not while its node may only be looking away (a node without a usable
		-- observation keeps a machine that asked for room less than five minutes ago).
		if v_placement.running_at is not null or (v_machine.repository_worker_id is not null and not v_stale)
$old$,
	$new$		-- Moving drops the scratch disk: only for a machine that is not running, and not while its node
		-- may only be looking away (a node without a usable observation keeps a machine that asked for
		-- room less than five minutes ago). 20260930506000: no machine is tied to a repository's node.
		if v_placement.running_at is not null
$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_admit_company_machine(uuid,text)'::regprocedure,
	$old$	-- Nothing fits now. Say why when it never will: no node (the repository's, when one is attached)
	-- makes a machine this large or gives machines this much disk. The largest of each size may be
	-- on different nodes.$old$,
	$new$	-- Nothing fits now. Say why when it never will: no node makes a machine this large or gives
	-- machines this much disk. The largest of each size may be on different nodes.$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_admit_company_machine(uuid,text)'::regprocedure,
	$old$
		and (v_machine.repository_worker_id is null or exists (select 1 from public.qorpera_coding_storage_volumes volume
			where volume.worker_id = v_machine.repository_worker_id and volume.owner = executor.owner
				and volume.machine_id_sha256 = executor.machine_id_sha256));$old$,
	$new$;$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_admit_company_machine(uuid,text)'::regprocedure,
	$old$
			and (v_machine.repository_worker_id is null or exists (select 1 from public.qorpera_coding_storage_volumes volume
				where volume.worker_id = v_machine.repository_worker_id and volume.owner = executor.owner
					and volume.machine_id_sha256 = executor.machine_id_sha256))) then$old$,
	$new$) then$new$);

-- machine_start: no repositoryWorker.
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$	v_worker public.qorpera_runtime_workers%rowtype; v_admission jsonb; v_keys text;$old$,
	$new$	v_admission jsonb; v_keys text;$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$
			and v_keys is distinct from 'cpus,diskGiB,lifetime,memoryGiB,name,purpose,repositoryWorker')$old$,
	$new$)$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$
			or v_args ->> 'lifetime' not in ('task','always-on')
			or (v_args ? 'repositoryWorker' and coalesce(v_args ->> 'repositoryWorker','') !~ '^[a-z0-9][a-z0-9._-]{0,79}$'))) then$old$,
	$new$
			or v_args ->> 'lifetime' not in ('task','always-on'))) then$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$		if v_args ? 'repositoryWorker' then
			select * into v_worker from public.qorpera_runtime_workers where profile_id = (v_identity ->> 'companyId')::uuid
				and environment_id = (v_identity ->> 'environmentId')::uuid and worker_key = v_args ->> 'repositoryWorker' and species = 'coding'
			order by created_at desc limit 1;
			if v_worker.id is null or not exists (select 1 from public.qorpera_coding_storage_volumes where worker_id = v_worker.id) then
				raise exception 'REPOSITORY_UNAVAILABLE: no coding session % with a repository', v_args ->> 'repositoryWorker' using errcode = 'P0F10'; end if;
		end if;
$old$,
	$new$		-- 20260930506000 (F3 6e-1): no repository disk; a coding session's work is in the company folder.
$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$image, lifetime, repository_worker_id, notify_run_ids)$old$,
	$new$image, lifetime, notify_run_ids)$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)'::regprocedure,
	$old$'standard', v_args ->> 'lifetime', v_worker.id,$old$,
	$new$'standard', v_args ->> 'lifetime',$new$);

-- The executor's pick: what it may take, and what giving up stopped disks may serve, is any machine free to come.
select pg_temp.company_machine_repository_patch('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure,
	$old$				and (here.owner = p_owner or (machine.disk_bytes <= v_disk and machine.repository_worker_id is null
					and (here.id is null or here.running_at is null))
					or (here.id is null and machine.disk_bytes <= v_disk and exists (select 1 from public.qorpera_coding_storage_volumes volume
						where volume.worker_id = machine.repository_worker_id and volume.owner = p_owner
							and volume.machine_id_sha256 = p_machine_id_sha256)))$old$,
	$new$				and (here.owner = p_owner or (machine.disk_bytes <= v_disk and (here.id is null or here.running_at is null)))$new$);
select pg_temp.company_machine_repository_patch('public.qorpera_admit_executor_machines(text,text,integer)'::regprocedure,
	$old$			and ((machine.repository_worker_id is null and (here.id is null or here.running_at is null))
				or (here.id is null and exists (select 1 from public.qorpera_coding_storage_volumes volume
					where volume.worker_id = machine.repository_worker_id and volume.owner = p_owner
						and volume.machine_id_sha256 = p_machine_id_sha256)))$old$,
	$new$			and (here.id is null or here.running_at is null)$new$);

-- The node reservation: an agent's machine's wake needs the node's exit, as its start does.
select pg_temp.company_machine_repository_patch(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure,
	$old$ -- the node's exit; a Company Computer's wake, a repository-tied machine's wake and every coding machine cannot move
 -- and pass.
 elsif p_provider_kind in ('office','machine') and (v_demand.reserved_at is null
  or (p_provider_kind='machine' and v_demand.suspended_at is not null and not exists(
   select 1 from public.qorpera_company_machine_placements placement
   join public.qorpera_company_machines machine on machine.id=placement.machine_id
   where placement.id=v_allocation.company_machine_placement_id and machine.repository_worker_id is not null)))$old$,
	$new$ -- the node's exit; a Company Computer's wake and every coding machine cannot move and pass. 20260930506000 (F3 6e-1):
 -- no agent's machine is tied to a repository's node any more.
 elsif p_provider_kind in ('office','machine') and (v_demand.reserved_at is null
  or (p_provider_kind='machine' and v_demand.suspended_at is not null))$new$);

-- The operator's view: a company machine is no coding session's.
select pg_temp.company_machine_repository_patch('public.qorpera_runtime_compute_requests(uuid,text,uuid,integer)'::regprocedure,
	$old$'codingWorkerId',m.repository_worker_id,$old$,
	$new$'codingWorkerId',null,$new$);

alter table public.qorpera_company_machines drop column repository_worker_id;

-- Nothing is left that names the repository disk or the v1 binding (but the binding text's key order, above).
do $check$
declare v_left text;
begin
	select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_left
	from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
	where n.nspname not in ('pg_catalog', 'information_schema')
		and (position('repository_worker_id' in p.prosrc) > 0 or position('lxd-company-machine/v1' in p.prosrc) > 0
			or (position('repositoryWorker' in p.prosrc) > 0
				and p.oid <> 'public.qorpera_company_machine_binding_text(jsonb)'::regprocedure));
	if v_left is not null then raise exception 'Still about the repository disk: %', v_left; end if;
	if exists (select 1 from public.qorpera_company_machine_placements
		where binding ->> 'schema' is distinct from 'qorpera.lxd-company-machine/v2' and retired_at is null and removed_at is null) then
		raise exception 'A current placement is not v2'; end if;
end
$check$;
