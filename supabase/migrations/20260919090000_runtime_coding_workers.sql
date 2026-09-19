-- Coding is a separate durable delegation, not an office desktop or in-house wake.
-- No executor or repository is enabled by this migration. API roles never write
-- these tables; service deployment must explicitly provision both capabilities.
create table public.qorpera_coding_executors (
	environment_id uuid primary key references public.qorpera_company_files(environment_id) on delete restrict,
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	enabled boolean not null default false
);
create table public.qorpera_coding_repository_grants (
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	staff_agent_id uuid not null,
	repository jsonb not null,
	enabled boolean not null default false,
	primary key(environment_id,staff_agent_id,repository)
);
create table public.qorpera_coding_workers (
	id uuid primary key default extensions.gen_random_uuid(),
	company_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	parent_agent_id uuid not null,
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	repository jsonb not null,
	branch text not null unique,
	vm_id uuid unique,
	version bigint not null default 1 check(version > 0),
	turn integer not null default 1 check(turn > 0),
	state text not null default 'queued' check(state in
		('queued','provisioning','ready','running','waiting','completed','failed','cancelled','recovery-required')),
	dispatch jsonb not null,
	pull_request jsonb,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_coding_requests (
	id uuid primary key default extensions.gen_random_uuid(),
	worker_id uuid not null references public.qorpera_coding_workers(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	operation_key text not null,
	receipt_id uuid not null unique references public.qorpera_run_operation_receipts(id) on delete restrict,
	kind text not null check(kind in ('dispatch','followup','cancel')),
	turn integer not null,
	input jsonb not null,
	response jsonb not null,
	status text not null default 'queued' check(status in ('queued','leased','completed','recovery-required')),
	lease_token uuid,
	lease_owner text,
	lease_until timestamptz,
	result jsonb,
	created_at timestamptz not null default clock_timestamp(),
	unique(run_id,operation_key)
);
create unique index qorpera_coding_one_active_request on public.qorpera_coding_requests(worker_id)
	where status in ('queued','leased');
create table public.qorpera_coding_completions (
	id uuid primary key default extensions.gen_random_uuid(),
	request_id uuid not null unique references public.qorpera_coding_requests(id) on delete restrict,
	worker_id uuid not null references public.qorpera_coding_workers(id) on delete restrict,
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	payload jsonb not null,
	created_at timestamptz not null default clock_timestamp()
);
-- This is an explicit durable listener outbox. There is intentionally no
-- arbitrary "delivered" acknowledgement: parent wake delivery needs a real
-- authoritative receipt when that integration is installed.

create function public.qorpera_coding_repository_valid(p_repository jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_repository) = 'object'
		and p_repository - array['host','owner','name','baseBranch'] = '{}'::jsonb
		and p_repository ->> 'host' = 'github.com'
		and jsonb_typeof(p_repository -> 'owner') = 'string'
		and p_repository ->> 'owner' ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
		and jsonb_typeof(p_repository -> 'name') = 'string'
		and p_repository ->> 'name' ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$'
		and jsonb_typeof(p_repository -> 'baseBranch') = 'string'
		and p_repository ->> 'baseBranch' ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
		and p_repository ->> 'baseBranch' not like '%..%'
		and not exists(select 1 from unnest(string_to_array(p_repository ->> 'baseBranch','/')) part
			where part='' or left(part,1)='.' or right(part,1)='.' or right(part,5)='.lock'),false)
$$;
alter table public.qorpera_coding_repository_grants add check(public.qorpera_coding_repository_valid(repository));
alter table public.qorpera_coding_workers add check(public.qorpera_coding_repository_valid(repository));

create function public.qorpera_coding_worker_json(p_worker public.qorpera_coding_workers)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-worker/v1','id',p_worker.id,
		'companyId',p_worker.company_id,'parentAgentId',p_worker.parent_agent_id,'parentRunId',p_worker.parent_run_id,
		'repository',p_worker.repository,'branch',p_worker.branch,'vmId',p_worker.vm_id,
		'version',p_worker.version,'state',p_worker.state,'turn',p_worker.turn,'pullRequest',p_worker.pull_request)
$$;
create function public.qorpera_coding_worker_identity_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
	if (new.id,new.company_id,new.environment_id,new.parent_agent_id,new.parent_run_id,new.repository,new.branch,new.dispatch,new.created_at)
		is distinct from (old.id,old.company_id,old.environment_id,old.parent_agent_id,old.parent_run_id,old.repository,old.branch,old.dispatch,old.created_at)
		or (old.vm_id is not null and new.vm_id is distinct from old.vm_id)
		or new.version <> old.version + 1 or new.turn not between old.turn and old.turn + 1 then
		raise exception 'Coding worker identity is immutable' using errcode='42501'; end if;
	return new;
end $$;
create trigger qorpera_coding_worker_identity before update on public.qorpera_coding_workers
	for each row execute function public.qorpera_coding_worker_identity_guard();

create function public.qorpera_configure_coding_executor(p_environment_id uuid,p_owner text,p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding deployment authority required' using errcode='42501'; end if;
	insert into public.qorpera_coding_executors(environment_id,owner,enabled) values(p_environment_id,p_owner,p_enabled)
	on conflict(environment_id) do update set owner=excluded.owner,enabled=excluded.enabled;
end $$;
create function public.qorpera_set_coding_repository_grant(p_environment_id uuid,p_staff_agent_id uuid,p_repository jsonb,p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding deployment authority required' using errcode='42501'; end if;
	if not exists(select 1 from public.qorpera_company_files f join public.qorpera_profile_staff s on s.profile_id=f.profile_id
		where f.environment_id=p_environment_id and s.staff_agent_id=p_staff_agent_id and s.employment_status='active') then
		raise exception 'Coding staff unavailable' using errcode='42501'; end if;
	insert into public.qorpera_coding_repository_grants(environment_id,staff_agent_id,repository,enabled)
	values(p_environment_id,p_staff_agent_id,p_repository,p_enabled)
	on conflict(environment_id,staff_agent_id,repository) do update set enabled=excluded.enabled;
end $$;

-- Background authority outlives a parent's execution lease, but never its
-- company, sponsor, actor, audience, source-path or repository authorization.
create function public.qorpera_coding_assert_delegation(p_worker public.qorpera_coding_workers,p_run_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.qorpera_execution_runs%rowtype; a jsonb; source record;
begin
	select * into strict r from public.qorpera_execution_runs where id=p_run_id;
	perform public.qorpera_lock_profile_gc_fence(r.profile_id);
	if r.profile_id <> p_worker.company_id or r.environment_id <> p_worker.environment_id or r.staff_agent_id <> p_worker.parent_agent_id
		or public.qorpera_profile_gc_deletion_active(r.profile_id) or public.qorpera_company_execution_paused(r.profile_id)
		or exists(select 1 from public.qorpera_runner_jobs where id=r.job_id and cancelled_at is not null) then
		raise exception 'Coding delegation stopped' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_staff where profile_id=r.profile_id and staff_agent_id=r.staff_agent_id
		and version=r.staff_version and employment_status='active' for share;
	if not found then raise exception 'Coding staff authority changed' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=r.profile_id and user_id=r.requested_by_user_id for share;
	if not found then raise exception 'Coding requester unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id=r.profile_id and user_id=r.sponsored_by_user_id for share;
	if not found then raise exception 'Coding sponsor unavailable' using errcode='42501'; end if;
	perform 1 from public.qorpera_execution_sponsor_bindings b
		join public.qorpera_execution_sponsor_versions s on s.binding_id=b.id and s.version=r.sponsor_version
		join public.qorpera_provider_connections c on c.id=s.provider_connection_id
		join public.qorpera_provider_connection_versions v on v.connection_id=c.id and v.version=s.provider_connection_version
		join public.qorpera_native_credential_capsules capsule on capsule.id=v.credential_capsule_id
		join public.qorpera_member_compute_identities identity on identity.id=capsule.compute_identity_id
		join public.qorpera_provider_execution_policies policy on policy.provider=c.provider
			and policy.authentication_mode=v.authentication_mode and policy.native_harness=v.native_harness
		where b.id=r.sponsor_binding_id and b.profile_id=r.profile_id and b.status='active' and c.status='active'
		and c.provider=r.model_provider and v.authorization_state='active' and v.authentication_mode='native_subscription' and v.native_harness='codex-cli'
		and c.profile_id=r.profile_id and (s.sponsor_kind<>'member_connection' or exists(
			select 1 from public.qorpera_profile_members where profile_id=r.profile_id and user_id=c.owner_user_id))
		and capsule.status='active' and identity.id=r.compute_identity_id and identity.status='active'
		and public.qorpera_provider_execution_enabled(c.provider,v.authentication_mode,v.native_harness)
		and policy.implementation_status='supported' and policy.enablement_status='enabled'
		and s.version=(select max(version) from public.qorpera_execution_sponsor_versions where binding_id=b.id)
		for share of b,c,v,capsule,identity,policy;
	if not found then raise exception 'Coding sponsor authority changed' using errcode='42501'; end if;
	-- Sponsor reservations belong to the parent turn and settle when it ends;
	-- this durable delegation checks authorization without requiring that lease.
	if not public.qorpera_execution_compute_available(r) then
		raise exception 'Coding execution authority changed' using errcode='42501'; end if;
	perform 1 from public.qorpera_coding_executors where environment_id=r.environment_id and enabled for share;
	if not found then raise exception 'Coding executor is not enabled' using errcode='42501'; end if;
	perform 1 from public.qorpera_coding_repository_grants where environment_id=r.environment_id and staff_agent_id=r.staff_agent_id
		and repository=p_worker.repository and enabled for share;
	if not found then raise exception 'Coding repository grant unavailable' using errcode='42501'; end if;
	a := jsonb_build_object('companyId',r.profile_id,'environmentId',r.environment_id,'userId',r.requested_by_user_id,
		'staffAgentId',r.staff_agent_id,'runId',r.id,'audience',r.audience_kind,'audienceUserId',r.audience_user_id);
	perform public.qorpera_company_path_assert_context(a);
	perform public.qorpera_company_path_require(a,p_worker.dispatch ->> 'todoPath','read');
	if (select count(*) from public.qorpera_company_read_observations o
		join public.qorpera_company_read_confirmations c on c.read_id=o.id
		where o.run_id=p_worker.parent_run_id and o.environment_id=p_worker.environment_id and o.kind='file'
		and o.id in (select value::uuid from jsonb_array_elements_text(p_worker.dispatch -> 'sourceReadIds')))
		<>jsonb_array_length(p_worker.dispatch -> 'sourceReadIds') then
		raise exception 'Coding source evidence unavailable' using errcode='42501'; end if;
	for source in select o.* from public.qorpera_company_read_observations o
		where o.id in (select value::text::uuid from jsonb_array_elements_text(p_worker.dispatch -> 'sourceReadIds')) loop
		perform public.qorpera_company_path_require(a,source.path,'read');
	end loop;
end $$;

create function public.qorpera_coding_parent(p_binding jsonb,p_worker_id uuid,p_require_delegation boolean default true)
returns public.qorpera_coding_workers language plpgsql security definer set search_path = '' as $$
declare r public.qorpera_execution_runs%rowtype; origin public.qorpera_execution_runs%rowtype;
	w public.qorpera_coding_workers%rowtype; a jsonb;
begin
	r := public.qorpera_native_tool_locked_run(p_binding);
	a := public.qorpera_company_path_actor(r.environment_id,p_binding);
	perform public.qorpera_assert_wake_work_allowed(r.id);
	if p_require_delegation then perform public.qorpera_company_path_assert_context(a); end if;
	select * into w from public.qorpera_coding_workers where id=p_worker_id and company_id=r.profile_id
		and environment_id=r.environment_id and parent_agent_id=r.staff_agent_id for update;
	if not found then raise exception 'Coding worker unavailable' using errcode='42501'; end if;
	select * into strict origin from public.qorpera_execution_runs where id=w.parent_run_id;
	if (r.requested_by_user_id,r.audience_kind,r.audience_user_id) is distinct from
		(origin.requested_by_user_id,origin.audience_kind,origin.audience_user_id) then
		raise exception 'Coding worker audience differs' using errcode='42501'; end if;
	if p_require_delegation then perform public.qorpera_coding_assert_delegation(w,r.id); end if;
	return w;
end $$;

create function public.qorpera_dispatch_coding_worker(p_binding jsonb,p_dispatch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.qorpera_execution_runs%rowtype; w public.qorpera_coding_workers%rowtype;
	q public.qorpera_coding_requests%rowtype; a jsonb; source record; source_id text;
	v_id uuid:=extensions.gen_random_uuid(); v_receipt uuid:=extensions.gen_random_uuid(); v_hash text; v_response jsonb;
begin
	r := public.qorpera_native_tool_locked_run(p_binding);
	a := public.qorpera_company_path_actor(r.environment_id,p_binding);
	perform public.qorpera_assert_wake_work_allowed(r.id);
	perform public.qorpera_company_path_assert_context(a);
	if r.audience_kind<>'company' then
		raise exception 'Coding completion requires a company parent audience' using errcode='42501'; end if;
	if jsonb_typeof(p_dispatch) is distinct from 'object' or octet_length(p_dispatch::text)>131072
		or p_dispatch - array['operationKey','repository','goal','definitionOfDone','context','sourceReadIds','todoPath','cancellationPolicy','completionPolicy','publication'] <> '{}'::jsonb
		or jsonb_typeof(p_dispatch -> 'operationKey') is distinct from 'string'
		or coalesce(p_dispatch ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or not public.qorpera_coding_repository_valid(p_dispatch -> 'repository')
		or jsonb_typeof(p_dispatch -> 'goal') is distinct from 'string' or btrim(p_dispatch ->> 'goal')='' or octet_length(p_dispatch ->> 'goal')>8192
		or jsonb_typeof(p_dispatch -> 'definitionOfDone') is distinct from 'string' or btrim(p_dispatch ->> 'definitionOfDone')='' or octet_length(p_dispatch ->> 'definitionOfDone')>8192
		or jsonb_typeof(p_dispatch -> 'context') is distinct from 'string' or octet_length(p_dispatch ->> 'context')>32768
		or jsonb_typeof(p_dispatch -> 'sourceReadIds') is distinct from 'array'
		or jsonb_typeof(p_dispatch -> 'todoPath') is distinct from 'string'
		or not coalesce(public.qorpera_company_path_valid(p_dispatch ->> 'todoPath',false),false)
		or p_dispatch ->> 'cancellationPolicy' is distinct from 'retain-workspace'
		or p_dispatch ->> 'completionPolicy' is distinct from 'notify-parent'
		or p_dispatch ->> 'publication' is distinct from 'draft-pr' then
		raise exception 'Coding dispatch invalid' using errcode='22023'; end if;
	if jsonb_array_length(p_dispatch -> 'sourceReadIds')>64
		or exists(select 1 from jsonb_array_elements(p_dispatch -> 'sourceReadIds') value
			where jsonb_typeof(value)<>'string' or trim(both '"' from value::text) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
		or (select count(distinct value) from jsonb_array_elements(p_dispatch -> 'sourceReadIds')) <> jsonb_array_length(p_dispatch -> 'sourceReadIds') then
		raise exception 'Coding sources invalid' using errcode='22023'; end if;
	perform public.qorpera_company_path_require(a,p_dispatch ->> 'todoPath','read');
	if not exists(select 1 from public.qorpera_company_path_entries where environment_id=r.environment_id
		and path_key_sha256=extensions.digest(public.qorpera_company_path_key(p_dispatch ->> 'todoPath'),'sha256') and entry ->> 'kind'='file') then
		raise exception 'Coding todo must be a durable Company File' using errcode='42501'; end if;
	for source_id in select value from jsonb_array_elements_text(p_dispatch -> 'sourceReadIds') loop
		select o.* into source from public.qorpera_company_read_observations o
			join public.qorpera_company_read_confirmations c on c.read_id=o.id
			where o.id=source_id::uuid and o.run_id=r.id and o.environment_id=r.environment_id and o.kind='file';
		if not found then raise exception 'Coding source read unavailable' using errcode='42501'; end if;
		perform public.qorpera_company_path_require(a,source.path,'read');
	end loop;
	select * into q from public.qorpera_coding_requests where run_id=r.id and operation_key=p_dispatch ->> 'operationKey';
	if found then
		if q.kind<>'dispatch' or q.input<>p_dispatch then raise exception 'Coding operation replay differs' using errcode='23505'; end if;
		select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
		perform public.qorpera_coding_assert_delegation(w,r.id);
		return q.response;
	end if;
	v_hash:=encode(extensions.digest(p_dispatch::text,'sha256'),'hex');
	perform public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'coding:'||(p_dispatch ->> 'operationKey'),v_hash,v_hash,false);
	insert into public.qorpera_coding_workers(id,company_id,environment_id,parent_agent_id,parent_run_id,repository,branch,dispatch)
	values(v_id,r.profile_id,r.environment_id,r.staff_agent_id,r.id,p_dispatch -> 'repository','qorpera/coding/'||v_id::text,p_dispatch) returning * into w;
	perform public.qorpera_coding_assert_delegation(w,r.id);
	v_response:=public.qorpera_coding_worker_json(w);
	insert into public.qorpera_coding_requests(worker_id,run_id,operation_key,receipt_id,kind,turn,input,response)
	values(w.id,r.id,p_dispatch ->> 'operationKey',v_receipt,'dispatch',w.turn,p_dispatch,v_response);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_hash,v_response);
	return v_response;
end $$;

create function public.qorpera_read_coding_worker(p_binding jsonb,p_worker_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin return public.qorpera_coding_worker_json(public.qorpera_coding_parent(p_binding,p_worker_id)); end $$;

create function public.qorpera_followup_coding_worker(p_binding jsonb,p_followup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.qorpera_coding_workers%rowtype; q public.qorpera_coding_requests%rowtype;
	v_receipt uuid:=extensions.gen_random_uuid(); v_hash text; v_response jsonb;
begin
	if jsonb_typeof(p_followup) is distinct from 'object' or octet_length(p_followup::text)>16384
		or p_followup - array['operationKey','workerId','expectedVersion','goal'] <> '{}'::jsonb
		or jsonb_typeof(p_followup -> 'operationKey') is distinct from 'string'
		or jsonb_typeof(p_followup -> 'workerId') is distinct from 'string'
		or coalesce(p_followup ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or jsonb_typeof(p_followup -> 'goal') is distinct from 'string' or btrim(p_followup ->> 'goal')='' or octet_length(p_followup ->> 'goal')>8192
		or jsonb_typeof(p_followup -> 'expectedVersion') is distinct from 'number'
		or coalesce(p_followup ->> 'expectedVersion','') !~ '^[1-9][0-9]{0,15}$' then
		raise exception 'Coding followup invalid' using errcode='22023'; end if;
	w:=public.qorpera_coding_parent(p_binding,(p_followup ->> 'workerId')::uuid);
	select * into q from public.qorpera_coding_requests where run_id=(p_binding ->> 'runId')::uuid and operation_key=p_followup ->> 'operationKey';
	if found then
		if q.kind<>'followup' or q.input<>p_followup then raise exception 'Coding operation replay differs' using errcode='23505'; end if;
		return q.response;
	end if;
	if w.version<>(p_followup ->> 'expectedVersion')::bigint then raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message','Coding version changed','details',null,'hint',null)::text, detail='{"status":409,"headers":{}}'; end if;
	if w.state not in ('waiting','completed','failed') or w.vm_id is null then
		raise exception 'Coding worker cannot accept followup' using errcode='55000'; end if;
	v_hash:=encode(extensions.digest(p_followup::text,'sha256'),'hex');
	perform public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'coding:'||(p_followup ->> 'operationKey'),v_hash,v_hash,false);
	update public.qorpera_coding_workers set state='queued',turn=turn+1,version=version+1,updated_at=clock_timestamp() where id=w.id returning * into w;
	v_response:=public.qorpera_coding_worker_json(w);
	insert into public.qorpera_coding_requests(worker_id,run_id,operation_key,receipt_id,kind,turn,input,response)
	values(w.id,(p_binding ->> 'runId')::uuid,p_followup ->> 'operationKey',v_receipt,'followup',w.turn,p_followup,v_response);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_hash,v_response);
	return v_response;
end $$;

create function public.qorpera_cancel_coding_worker(p_binding jsonb,p_worker_id uuid,p_expected_version bigint,p_operation_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.qorpera_coding_workers%rowtype; q public.qorpera_coding_requests%rowtype;
	v_receipt uuid:=extensions.gen_random_uuid(); v_hash text; v_response jsonb; v_input jsonb;
begin
	w:=public.qorpera_coding_parent(p_binding,p_worker_id,false);
	if coalesce(p_operation_key,'') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$' or p_expected_version is null or p_expected_version<1 then
		raise exception 'Coding cancellation invalid' using errcode='22023'; end if;
	v_input:=jsonb_build_object('workerId',p_worker_id,'expectedVersion',p_expected_version,'operationKey',p_operation_key);
	select * into q from public.qorpera_coding_requests where run_id=(p_binding ->> 'runId')::uuid and operation_key=p_operation_key;
	if found then
		if q.kind<>'cancel' or q.input<>v_input then raise exception 'Coding operation replay differs' using errcode='23505'; end if;
		return q.response;
	end if;
	if w.version<>p_expected_version then raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message','Coding version changed','details',null,'hint',null)::text, detail='{"status":409,"headers":{}}'; end if;
	if w.state='cancelled' then raise exception 'Coding worker already cancelled' using errcode='55000'; end if;
	v_hash:=encode(extensions.digest(v_input::text,'sha256'),'hex');
	perform public.qorpera_begin_native_tool_operation(p_binding,v_receipt,'coding:'||p_operation_key,v_hash,v_hash,false);
	-- Revoke a running request before enqueuing a separate stop operation. The VM
	-- remains bound; cancelled means the executor has confirmed its stop.
	update public.qorpera_coding_requests set status='recovery-required',lease_until=null
		where worker_id=w.id and status in ('queued','leased');
	update public.qorpera_coding_workers set state='recovery-required',version=version+1,updated_at=clock_timestamp() where id=w.id returning * into w;
	v_response:=public.qorpera_coding_worker_json(w);
	insert into public.qorpera_coding_requests(worker_id,run_id,operation_key,receipt_id,kind,turn,input,response)
	values(w.id,(p_binding ->> 'runId')::uuid,p_operation_key,v_receipt,'cancel',w.turn,v_input,v_response);
	perform public.qorpera_complete_native_tool_operation(p_binding,v_receipt,v_hash,v_response);
	return v_response;
end $$;

create function public.qorpera_claim_coding_request(p_owner text,p_lease_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode='42501'; end if;
	if p_lease_seconds is null or p_lease_seconds not between 30 and 300 or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' then
		raise exception 'Coding lease invalid' using errcode='22023'; end if;
	-- Worker-first locking is shared with parent steering and progress updates.
	for w in select worker.* from public.qorpera_coding_workers worker
		join public.qorpera_coding_executors e on e.environment_id=worker.environment_id and e.enabled and e.owner=p_owner
		where exists(select 1 from public.qorpera_coding_requests request where request.worker_id=worker.id
			and (request.status='queued' or (request.status='leased' and request.lease_until<=clock_timestamp())))
		order by worker.created_at limit 1 loop
		-- Match Company File actor ordering before taking worker locks. Never
		-- take a company/GC fence after another transaction holds this worker.
		perform public.qorpera_lock_profile_gc_fence(w.company_id);
		perform 1 from public.qorpera_company_files where environment_id=w.environment_id for update;
		select * into w from public.qorpera_coding_workers where id=w.id for update skip locked;
		if not found then return null; end if;
		select * into q from public.qorpera_coding_requests where worker_id=w.id and status in ('queued','leased') for update;
		if not found or (q.status='leased' and q.lease_until>clock_timestamp()) then return null; end if;
		if q.status='leased' then
			update public.qorpera_coding_requests set status='recovery-required',lease_until=null where id=q.id;
			update public.qorpera_coding_workers set state='recovery-required',version=version+1,updated_at=clock_timestamp() where id=w.id returning * into w;
			insert into public.qorpera_coding_completions(request_id,worker_id,parent_run_id,payload)
			values(q.id,w.id,q.run_id,jsonb_build_object('worker',public.qorpera_coding_worker_json(w),'reason','executor-lease-expired')) on conflict(request_id) do nothing;
			return null;
		end if;
		begin
			-- Stop operations must remain claimable after a grant is revoked.
			if q.kind<>'cancel' then perform public.qorpera_coding_assert_delegation(w,q.run_id); end if;
		exception when insufficient_privilege then
			update public.qorpera_coding_requests set status='recovery-required' where id=q.id;
			update public.qorpera_coding_workers set state='recovery-required',version=version+1,updated_at=clock_timestamp() where id=w.id returning * into w;
			insert into public.qorpera_coding_completions(request_id,worker_id,parent_run_id,payload)
			values(q.id,w.id,q.run_id,jsonb_build_object('worker',public.qorpera_coding_worker_json(w),'reason','delegation-authority-changed')) on conflict(request_id) do nothing;
			return null;
		end;
		perform 1 from public.qorpera_coding_executors where environment_id=w.environment_id and enabled and owner=p_owner for share;
		if not found then return null; end if;
		update public.qorpera_coding_requests set status='leased',lease_token=extensions.gen_random_uuid(),lease_owner=p_owner,
			lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where id=q.id returning * into q;
		return jsonb_build_object('requestId',q.id,'leaseToken',q.lease_token,'leaseUntil',q.lease_until,
			'environmentId',w.environment_id,'worker',public.qorpera_coding_worker_json(w),'dispatch',w.dispatch,'kind',q.kind,
			'goal',case when q.kind='followup' then q.input ->> 'goal' else w.dispatch ->> 'goal' end);
	end loop;
	return null;
end $$;

create function public.qorpera_coding_locked_request(p_request_id uuid,p_lease_token uuid)
returns public.qorpera_coding_requests language plpgsql security definer set search_path = '' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode='42501'; end if;
	select worker.* into w from public.qorpera_coding_workers worker join public.qorpera_coding_requests request on request.worker_id=worker.id
		where request.id=p_request_id;
	if not found then raise exception 'Coding executor lease unavailable' using errcode='42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(w.company_id);
	perform 1 from public.qorpera_company_files where environment_id=w.environment_id for update;
	select worker.* into w from public.qorpera_coding_workers worker join public.qorpera_coding_requests request on request.worker_id=worker.id
		where request.id=p_request_id for update of worker;
	select * into q from public.qorpera_coding_requests where id=p_request_id for update;
	if not found or q.status<>'leased' or q.lease_token is distinct from p_lease_token or q.lease_until<=clock_timestamp()
		or not exists(select 1 from public.qorpera_coding_executors where environment_id=w.environment_id and enabled and owner=q.lease_owner) then
		raise exception 'Coding executor lease unavailable' using errcode='42501'; end if;
	if q.kind<>'cancel' then perform public.qorpera_coding_assert_delegation(w,q.run_id); end if;
	perform 1 from public.qorpera_coding_executors where environment_id=w.environment_id and enabled and owner=q.lease_owner for share;
	if not found or q.lease_until<=clock_timestamp() then
		raise exception 'Coding executor lease unavailable' using errcode='42501'; end if;
	return q;
end $$;
create function public.qorpera_heartbeat_coding_request(p_request_id uuid,p_lease_token uuid,p_lease_seconds integer default 60)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare q public.qorpera_coding_requests%rowtype; v_until timestamptz;
begin
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	if p_lease_seconds is null or p_lease_seconds not between 30 and 300 then raise exception 'Coding lease invalid' using errcode='22023'; end if;
	update public.qorpera_coding_requests set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds) where id=q.id returning lease_until into v_until;
	return v_until;
end $$;

create function public.qorpera_record_coding_progress(p_request_id uuid,p_lease_token uuid,p_expected_version bigint,
	p_state text,p_vm_id uuid default null,p_pull_request jsonb default null,p_result jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype;
begin
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
	if w.version=p_expected_version+1 and w.state=p_state and (p_vm_id is null or w.vm_id=p_vm_id)
		and p_result is null and p_pull_request is null and q.kind<>'cancel' then
		return public.qorpera_coding_worker_json(w); end if;
	if p_expected_version is distinct from w.version then raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message','Coding version changed','details',null,'hint',null)::text, detail='{"status":409,"headers":{}}'; end if;
	if p_pull_request is not null or p_result is not null or q.kind='cancel'
		or not ((w.state='queued' and p_state in ('provisioning','running')) or (w.state='provisioning' and p_state='ready')
			or (w.state='ready' and p_state='running'))
		or (p_state in ('ready','running') and coalesce(w.vm_id,p_vm_id) is null)
		or (w.vm_id is not null and p_vm_id is not null and p_vm_id<>w.vm_id) then
		raise exception 'Coding transition invalid' using errcode='22023'; end if;
	update public.qorpera_coding_workers set state=p_state,vm_id=coalesce(vm_id,p_vm_id),version=version+1,updated_at=clock_timestamp()
		where id=w.id returning * into w;
	return public.qorpera_coding_worker_json(w);
end $$;

create function public.qorpera_complete_coding_request(p_request_id uuid,p_lease_token uuid,p_expected_version bigint,
	p_state text,p_result jsonb,p_pull_request jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare q public.qorpera_coding_requests%rowtype; w public.qorpera_coding_workers%rowtype; v_response jsonb; v_input jsonb; v_completion jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding executor authority required' using errcode='42501'; end if;
	v_input:=jsonb_build_object('expectedVersion',p_expected_version,'state',p_state,'result',p_result,'pullRequest',p_pull_request);
	select * into q from public.qorpera_coding_requests where id=p_request_id;
	if found and q.status='completed' and q.lease_token=p_lease_token then
		select payload into strict v_completion from public.qorpera_coding_completions where request_id=q.id;
		if v_completion -> 'completionInput' is distinct from v_input then raise exception 'Coding completion replay differs' using errcode='23505'; end if;
		return v_completion -> 'worker';
	end if;
	q:=public.qorpera_coding_locked_request(p_request_id,p_lease_token);
	select * into strict w from public.qorpera_coding_workers where id=q.worker_id;
	if p_expected_version is distinct from w.version then raise sqlstate 'PGRST' using message=jsonb_build_object('code','QRC01','message','Coding version changed','details',null,'hint',null)::text, detail='{"status":409,"headers":{}}'; end if;
	if p_state is null or p_state not in ('waiting','completed','failed','cancelled','recovery-required')
		or (q.kind='cancel') is distinct from (p_state='cancelled')
		or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>8192
		or p_result - array['summary','noChange','draftPrVerified'] <> '{}'::jsonb
		or (p_result ? 'noChange' and jsonb_typeof(p_result -> 'noChange') is distinct from 'boolean')
		or (p_result ? 'draftPrVerified' and jsonb_typeof(p_result -> 'draftPrVerified') is distinct from 'boolean')
		or jsonb_typeof(p_result -> 'summary') is distinct from 'string' or length(btrim(p_result ->> 'summary')) not between 1 and 4000
		or (p_state in ('completed','waiting') and w.state<>'running') then
		raise exception 'Coding result invalid' using errcode='22023'; end if;
	if p_pull_request is not null then
		if jsonb_typeof(p_pull_request) is distinct from 'object' or p_pull_request - array['url','number','headSha'] <> '{}'::jsonb
			or jsonb_typeof(p_pull_request -> 'number') is distinct from 'number' or coalesce(p_pull_request ->> 'number','') !~ '^[1-9][0-9]{0,9}$'
			or p_pull_request ->> 'url' is distinct from 'https://github.com/'||(w.repository ->> 'owner')||'/'||(w.repository ->> 'name')||'/pull/'||(p_pull_request ->> 'number')
			or coalesce(p_pull_request ->> 'headSha','') !~ '^[0-9a-f]{40}$'
			or p_result -> 'draftPrVerified' is distinct from 'true'::jsonb
			or (w.pull_request is not null and (w.pull_request ->> 'url',w.pull_request ->> 'number') is distinct from (p_pull_request ->> 'url',p_pull_request ->> 'number')) then
			raise exception 'Coding draft PR continuity invalid' using errcode='22023'; end if;
	end if;
	if p_state='completed' and p_pull_request is null and p_result -> 'noChange' is distinct from 'true'::jsonb then
		raise exception 'Coding completion requires verified draft PR or no-change' using errcode='22023'; end if;
	update public.qorpera_coding_workers set state=p_state,pull_request=coalesce(p_pull_request,pull_request),version=version+1,updated_at=clock_timestamp()
		where id=w.id returning * into w;
	v_response:=public.qorpera_coding_worker_json(w);
	update public.qorpera_coding_requests set status='completed',lease_until=null,result=p_result where id=q.id;
	insert into public.qorpera_coding_completions(request_id,worker_id,parent_run_id,payload)
	values(q.id,w.id,q.run_id,jsonb_build_object('worker',v_response,'result',p_result,'completionInput',v_input));
	return v_response;
end $$;

-- The listener can inspect durable undelivered events; claiming delivery or
-- reviving a parent is not implemented by a model polling or a fabricated ack.
create function public.qorpera_read_coding_completions(p_owner text,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding listener authority required' using errcode='42501'; end if;
	if p_limit is null or p_limit not between 1 and 100 then raise exception 'Coding listener limit invalid' using errcode='22023'; end if;
	select coalesce(jsonb_agg(event),'[]'::jsonb) into v_result from (
		select c.id,c.request_id,c.worker_id,c.parent_run_id,c.payload,c.created_at
		from public.qorpera_coding_completions c join public.qorpera_coding_workers w on w.id=c.worker_id
		join public.qorpera_coding_executors e on e.environment_id=w.environment_id and e.owner=p_owner
		order by c.created_at,c.id limit p_limit
	) event;
	return v_result;
end $$;

do $$
declare n text;
begin
	foreach n in array array['qorpera_coding_executors','qorpera_coding_repository_grants','qorpera_coding_workers','qorpera_coding_requests','qorpera_coding_completions'] loop
		execute format('alter table public.%I enable row level security',n);
		execute format('revoke all on public.%I from public,anon,authenticated,service_role',n);
	end loop;
	for n in select p.oid::regprocedure::text from pg_proc p join pg_namespace s on s.oid=p.pronamespace
		where s.nspname='public' and (p.proname like 'qorpera\_coding\_%' escape '\'
			or p.proname in ('qorpera_configure_coding_executor','qorpera_set_coding_repository_grant','qorpera_dispatch_coding_worker',
			'qorpera_read_coding_worker','qorpera_followup_coding_worker','qorpera_cancel_coding_worker','qorpera_claim_coding_request',
			'qorpera_heartbeat_coding_request','qorpera_record_coding_progress','qorpera_complete_coding_request','qorpera_read_coding_completions')) loop
		execute 'revoke all on function '||n||' from public,anon,authenticated,service_role';
	end loop;
end $$;
grant execute on function public.qorpera_configure_coding_executor(uuid,text,boolean),
	public.qorpera_set_coding_repository_grant(uuid,uuid,jsonb,boolean),
	public.qorpera_dispatch_coding_worker(jsonb,jsonb),public.qorpera_read_coding_worker(jsonb,uuid),
	public.qorpera_followup_coding_worker(jsonb,jsonb),public.qorpera_cancel_coding_worker(jsonb,uuid,bigint,text),
	public.qorpera_claim_coding_request(text,integer),public.qorpera_heartbeat_coding_request(uuid,uuid,integer),
	public.qorpera_record_coding_progress(uuid,uuid,bigint,text,uuid,jsonb,jsonb),
	public.qorpera_complete_coding_request(uuid,uuid,bigint,text,jsonb,jsonb),
	public.qorpera_read_coding_completions(text,integer) to service_role;
