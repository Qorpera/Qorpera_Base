-- NAS placement is immutable for the lifetime of this first storage backend.
-- An expired queue lease is NOT a storage fence. This version deliberately has
-- no writer takeover/rebind API: physical exclusion and a reviewed recovery
-- protocol are required before a successor can be introduced.
alter table public.qorpera_coding_executors add column nas_policy jsonb,
 add column nas_machine_id_sha256 text check(nas_machine_id_sha256 ~ '^[0-9a-f]{64}$');
create table public.qorpera_coding_storage_volumes (
 worker_id uuid primary key references public.qorpera_coding_workers(id) on delete restrict,
 environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
 owner text not null,
 machine_id_sha256 text not null check(machine_id_sha256 ~ '^[0-9a-f]{64}$'),
 writer_generation bigint not null check(writer_generation=1),
 binding jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_coding_storage_volumes enable row level security;
revoke all on public.qorpera_coding_storage_volumes from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_configure_coding_nas_policy(p_environment_id uuid,p_owner text,p_machine_id_sha256 text,p_policy jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare mount_path text:=p_policy->>'mountPoint'; root_path text:=p_policy->>'rootPath'; address text:=p_policy->>'serverAddress';
 existing public.qorpera_coding_executors%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Coding NAS operator authority required' using errcode='42501'; end if;
 if jsonb_typeof(p_policy) is distinct from 'object' or p_policy is distinct from jsonb_build_object(
  'schema','qorpera.coding-nas-policy/v1','mountPoint',mount_path,'rootPath',root_path,'serverAddress',address,'source',p_policy->>'source')
  or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$'
  or coalesce(address,'') !~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  or exists(select 1 from unnest(string_to_array(address,'.')) octet where octet::integer>255 or octet::integer::text<>octet)
  or coalesce(p_policy->>'source','') not like address||':/%'
  or exists(select 1 from unnest(array[mount_path,root_path,substring(p_policy->>'source' from length(address)+2)]) path
   where path is null or octet_length(path)>2048 or path !~ '^/' or path ~ '[[:space:][:cntrl:]\\]'
    or exists(select 1 from unnest(string_to_array(substring(path from 2),'/')) component where component in ('','.','..')))
  or not (root_path=mount_path or starts_with(root_path,mount_path||'/')) then
  raise exception 'Coding NAS policy invalid' using errcode='22023'; end if;
 select * into existing from public.qorpera_coding_executors where environment_id=p_environment_id and owner=p_owner for update;
 if not found then raise exception 'Coding executor unavailable' using errcode='42501'; end if;
 if exists(select 1 from public.qorpera_coding_storage_volumes where environment_id=p_environment_id and owner=p_owner)
  and (existing.nas_policy is distinct from p_policy or existing.nas_machine_id_sha256 is distinct from p_machine_id_sha256) then
  raise exception 'Coding NAS placement cannot be rebound; physical recovery required' using errcode='55000'; end if;
 update public.qorpera_coding_executors set nas_policy=p_policy,nas_machine_id_sha256=p_machine_id_sha256
  where environment_id=p_environment_id and owner=p_owner;
end $$;

-- Called only after the canonical request/company/worker locks are held. A new
-- descriptor is pinned transactionally with its machine reservation. Subsequent
-- calls must match even when a queue lease, process or node reservation changes.
create function public.qorpera_assert_coding_storage(p_worker_id uuid,p_owner text,p_storage jsonb,p_machine_id_sha256 text)
returns void language plpgsql security definer set search_path='' as $$
declare w public.qorpera_coding_workers%rowtype; executor public.qorpera_coding_executors%rowtype;
 expected jsonb; root_path text; volume public.qorpera_coding_storage_volumes%rowtype;
begin
 select * into strict w from public.qorpera_coding_workers where id=p_worker_id for update;
 select * into executor from public.qorpera_coding_executors where environment_id=w.environment_id and owner=p_owner and enabled for share;
 if executor.nas_policy is null or executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
  raise exception 'Coding NAS placement unavailable' using errcode='42501'; end if;
 root_path:=executor.nas_policy->>'rootPath';
 root_path:=root_path||'/workers/'||w.company_id::text||'/'||w.environment_id::text||'/'||w.id::text;
 expected:=jsonb_build_object('schema','qorpera.coding-storage/v1','volumeId',w.id,'workerId',w.id,
  'companyId',w.company_id,'environmentId',w.environment_id,'writerGeneration',1,'machineIdSha256',p_machine_id_sha256,
  'policy',executor.nas_policy,'dataSource',root_path||'/data','custodySource',root_path||'/guest-state',
  'dataTarget','/workspace','custodyTarget','/var/lib/qorpera-coding');
 if p_storage is distinct from expected then raise exception 'Coding NAS binding differs' using errcode='42501'; end if;
 select * into volume from public.qorpera_coding_storage_volumes where worker_id=w.id for update;
 if found then
  if volume.environment_id<>w.environment_id or volume.owner<>p_owner or volume.machine_id_sha256<>p_machine_id_sha256
   or volume.writer_generation<>1 or volume.binding is distinct from expected then
   raise exception 'Coding NAS writer cannot be replaced by a lease' using errcode='42501'; end if;
 else
  insert into public.qorpera_coding_storage_volumes(worker_id,environment_id,owner,machine_id_sha256,writer_generation,binding)
   values(w.id,w.environment_id,p_owner,p_machine_id_sha256,1,expected);
 end if;
end $$;

create function pg_temp.coding_nas_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$ declare definition text:=pg_get_functiondef(p_target); begin
 if p_old='' or (length(definition)-length(replace(definition,p_old,'')))/length(p_old)<>1 then
  raise exception 'Coding NAS integration differs: %',p_target; end if;
 execute replace(definition,p_old,p_new);
end $$;
select pg_temp.coding_nas_patch('public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)',
 $old$binding->>'schema' is distinct from 'qorpera.lxd-coding-vm/v1'$old$,
 $new$binding->>'schema' is distinct from 'qorpera.lxd-coding-vm/v2'$new$);
select pg_temp.coding_nas_patch('public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)',
 $old$binding-array['schema','workerId','allocationId','companyId','environmentId','repository']<>policy$old$,
 $new$binding-array['schema','workerId','allocationId','companyId','environmentId','repository','storage']<>policy$new$);
select pg_temp.coding_nas_patch('public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)',
 $old$if plan.worker_id is null then
   insert into public.qorpera_coding_vm_plans$old$,
 $new$perform public.qorpera_assert_coding_storage(w.id,q.lease_owner,binding->'storage',p_machine_id_sha256);
  if plan.worker_id is null then
   insert into public.qorpera_coding_vm_plans$new$);
revoke all on function public.qorpera_configure_coding_nas_policy(uuid,text,text,jsonb),public.qorpera_assert_coding_storage(uuid,text,jsonb,text)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_configure_coding_nas_policy(uuid,text,text,jsonb) to service_role;
-- Security-definer caller uses the same owner; the internal helper is never an
-- RPC granting storage authority from model-provided descriptors.
