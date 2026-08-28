-- Human edits use the same live Company File publisher as native tools. A
-- command is an exact, expiring human intent, not a run, queue or second tree.
-- Only the cloud gateway can stage/verify bytes and apply that stored intent.
create function public.qorpera_member_company_file_mode(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_file public.qorpera_company_files%rowtype;
begin
	if auth.uid() is null or auth.role() is distinct from 'authenticated'
		or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company File access is unavailable' using errcode = '42501'; end if;
	select * into v_file from public.qorpera_company_files where profile_id = p_profile_id;
	if not found then raise exception 'Company File is not ready' using errcode = '55000'; end if;
	return jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'mode',case when v_file.path_gateway_version = 1 then 'governed' else 'legacy' end);
end
$$;

create table public.qorpera_member_company_path_commands (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete cascade,
	user_id uuid not null references auth.users(id) on delete restrict,
	operation_key text not null,
	plan jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 32768),
	plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
	resource_id uuid not null references public.qorpera_company_path_resources(id) on delete restrict,
	resource_version uuid not null,
	protected boolean not null,
	status text not null check (status in ('ready','review_required','approved','applied','rejected')),
	expires_at timestamptz not null default clock_timestamp() + interval '10 minutes',
	created_at timestamptz not null default clock_timestamp(),
	reviewed_at timestamptz,
	result jsonb,
	unique (environment_id,user_id,operation_key),
	check ((status = 'applied') = (result is not null)),
	check (not protected or status <> 'ready'),
	check (status <> 'approved' or (protected and reviewed_at is not null))
);
alter table public.qorpera_member_company_path_commands enable row level security;
revoke all on public.qorpera_member_company_path_commands from public,anon,authenticated,service_role;
create index qorpera_member_company_path_commands_pending
	on public.qorpera_member_company_path_commands(environment_id,user_id,expires_at)
	where status in ('ready','review_required','approved');

create function public.qorpera_member_company_path_command_value(p_command public.qorpera_member_company_path_commands)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('commandId',p_command.id,'environmentId',p_command.environment_id,
		'companyId',(select profile_id from public.qorpera_company_files where environment_id = p_command.environment_id),
		'plan',p_command.plan,'planSha256',p_command.plan_sha256,'state',p_command.status,
		'expiresAt',p_command.expires_at,'result',p_command.result)
$$;

create function public.qorpera_begin_member_company_path_command(p_environment_id uuid,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
	v_command public.qorpera_member_company_path_commands%rowtype; v_digest text; v_protected boolean;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,false,false);
	-- This first product editor deliberately has the same bounded text codec
	-- as company_write. It cannot create executable files or arbitrary blobs.
	if p_plan #>> '{entry,kind}' = 'file' and ((p_plan #>> '{entry,file,bytes}')::bigint > 32768
		or p_plan #> '{entry,executable}' <> 'false'::jsonb) then
		raise exception 'Company File text edit is invalid' using errcode = '22023'; end if;
	v_digest := public.qorpera_company_path_plan_digest(v_actor,p_plan);
	select * into v_command from public.qorpera_member_company_path_commands
	where environment_id = p_environment_id and user_id = auth.uid() and operation_key = p_plan ->> 'operationKey' for update;
	if found then
		if v_command.plan_sha256 <> v_digest then
			raise exception 'Company File edit identity is bound to different work' using errcode = '23505'; end if;
		if v_command.resource_id <> v_resource.id or v_command.resource_version <> v_resource.version
			or (v_command.status <> 'applied' and v_command.expires_at <= clock_timestamp()) then
			raise exception 'Company File edit authority expired or changed' using errcode = '42501'; end if;
		return public.qorpera_member_company_path_command_value(v_command);
	end if;
	perform public.qorpera_company_path_plan(v_actor,p_plan,true,false);
	if (select count(*) from public.qorpera_member_company_path_commands where environment_id = p_environment_id
		and user_id = auth.uid() and expires_at > clock_timestamp() and status in ('ready','review_required','approved')) >= 100 then
		raise exception 'Too many pending Company File edits' using errcode = '54000'; end if;
	v_protected := public.qorpera_company_path_protected(v_resource,p_plan);
	-- Protected human edits require their author's own review authority. Agent
	-- proposals have a separate team-review route; do not create unreviewable
	-- human intents or silently delegate one member's intent to another.
	if v_protected and ((v_resource.scope = 'company_shared'
		and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
		or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid())) then
		raise exception 'Company File review authority is required' using errcode = '42501'; end if;
	insert into public.qorpera_member_company_path_commands(environment_id,user_id,operation_key,plan,plan_sha256,
		resource_id,resource_version,protected,status)
	values (p_environment_id,auth.uid(),p_plan ->> 'operationKey',p_plan,v_digest,v_resource.id,v_resource.version,
		v_protected,case when v_protected then 'review_required' else 'ready' end) returning * into v_command;
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

create function public.qorpera_get_member_company_path_command(p_command_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_command public.qorpera_member_company_path_commands%rowtype; v_actor jsonb;
begin
	select * into v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	v_actor := public.qorpera_company_path_actor(v_command.environment_id,null);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.user_id is distinct from auth.uid() then
		raise exception 'Company File edit is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_company_path_require(v_actor,v_command.plan ->> 'path','read');
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

create function public.qorpera_list_member_company_path_commands(p_environment_id uuid,p_after uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_items jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid Company File page' using errcode = '22023'; end if;
	select coalesce(jsonb_agg(item order by id),'[]') into v_items from (
		select c.id,public.qorpera_member_company_path_command_value(c) as item from public.qorpera_member_company_path_commands c
		where c.environment_id = p_environment_id and c.user_id = auth.uid()
			and c.status in ('ready','review_required','approved') and c.expires_at > clock_timestamp()
			and (p_after is null or c.id > p_after)
			and public.qorpera_company_path_allowed(v_actor,c.plan ->> 'path','read')
		order by c.id limit p_limit
	) page;
	return jsonb_build_object('items',v_items,'nextAfter',case when jsonb_array_length(v_items) = p_limit then v_items -> -1 ->> 'commandId' else null end);
end
$$;

create function public.qorpera_review_member_company_path_command(p_command_id uuid,p_plan_sha256 text,p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_command public.qorpera_member_company_path_commands%rowtype; v_actor jsonb;
	v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	v_actor := public.qorpera_company_path_actor(v_command.environment_id,null);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id for update;
	if v_command.user_id is distinct from auth.uid() or v_command.plan_sha256 is distinct from p_plan_sha256
		or p_decision is null or p_decision not in ('approve','reject','skip') then
		raise exception 'Company File edit review is unavailable' using errcode = '42501'; end if;
	v_resource := public.qorpera_company_path_plan(v_actor,v_command.plan,false,false);
	if v_command.status in ('applied','rejected') then return public.qorpera_member_company_path_command_value(v_command); end if;
	if v_resource.id <> v_command.resource_id or v_resource.version <> v_command.resource_version
		or v_command.expires_at <= clock_timestamp() then
		raise exception 'Company File edit authority expired or changed' using errcode = '42501'; end if;
	if p_decision = 'approve' then
		if not v_command.protected or (v_resource.scope = 'company_shared'
			and not public.qorpera_can_authorize_profile((v_actor ->> 'companyId')::uuid))
			or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> auth.uid()) then
			raise exception 'Company File review authority is required' using errcode = '42501'; end if;
		perform public.qorpera_company_path_plan(v_actor,v_command.plan,true);
		update public.qorpera_member_company_path_commands set status = 'approved',reviewed_at = coalesce(reviewed_at,clock_timestamp())
		where id = p_command_id returning * into v_command;
	else
		-- Dismissal is a decline, never an approval or an unattended retry.
		update public.qorpera_member_company_path_commands set status = 'rejected',reviewed_at = clock_timestamp()
		where id = p_command_id returning * into v_command;
	end if;
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

-- Service identity is not a substitute for the original human. Every stage,
-- prepare and atomic apply rechecks the stored human against current policy.
create function public.qorpera_member_company_path_command_actor(p_command_id uuid,p_plan_sha256 text,p_ready boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_command public.qorpera_member_company_path_commands%rowtype; v_file public.qorpera_company_files%rowtype;
	v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype; v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File publisher authority is required' using errcode = '42501'; end if;
	select * into v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	select * into v_file from public.qorpera_company_files where environment_id = v_command.environment_id;
	if not found then raise exception 'Company File edit is unavailable' using errcode = '42501'; end if;
	perform public.qorpera_lock_profile_gc_fence(v_file.profile_id);
	select * into strict v_file from public.qorpera_company_files where environment_id = v_command.environment_id for update;
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id for update;
	select role into v_role from public.qorpera_profile_members
	where profile_id = v_file.profile_id and user_id = v_command.user_id for share;
	if not found or v_command.plan_sha256 is distinct from p_plan_sha256 or v_command.status = 'rejected'
		or v_file.path_gateway_version is distinct from 1 or v_file.head_snapshot_id is distinct from v_file.path_index_snapshot_id
		or public.qorpera_profile_gc_deletion_active(v_file.profile_id)
		or (v_command.status <> 'applied' and v_command.expires_at <= clock_timestamp())
		or (p_ready and v_command.status not in ('ready','approved','applied')) then
		raise exception 'Company File edit authority is unavailable' using errcode = '42501'; end if;
	v_actor := jsonb_build_object('companyId',v_file.profile_id,'environmentId',v_file.environment_id,
		'userId',v_command.user_id,'staffAgentId',null,'runId',null,'audience','human');
	v_resource := public.qorpera_company_path_plan(v_actor,v_command.plan,false,false);
	if v_resource.id <> v_command.resource_id or v_resource.version <> v_command.resource_version
		or (p_ready and v_command.protected and ((v_resource.scope = 'company_shared' and v_role not in ('owner','admin'))
			or (v_resource.scope = 'member_private' and v_resource.owner_user_id <> v_command.user_id))) then
		raise exception 'Company File edit policy changed' using errcode = '42501'; end if;
	return v_actor;
end
$$;

create function public.qorpera_prepare_member_company_path_command(p_command_id uuid,p_plan_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype;
begin
	v_actor := public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,true);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.status <> 'applied' then perform public.qorpera_company_path_plan(v_actor,v_command.plan,true); end if;
	return public.qorpera_member_company_path_command_value(v_command) || jsonb_build_object(
		'snapshotId',(select head_snapshot_id from public.qorpera_company_files where environment_id = v_command.environment_id),
		'entries',case when v_command.status = 'applied' then '[]'::jsonb else (select coalesce(jsonb_agg(entry order by path),'[]')
			from public.qorpera_company_path_entries where environment_id = v_command.environment_id and entry is not null) end);
end
$$;

create function public.qorpera_apply_member_company_path_command(p_command_id uuid,p_plan_sha256 text,p_expected_head uuid,p_tree_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype; v_result jsonb;
begin
	v_actor := public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,true);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.status = 'applied' then return public.qorpera_member_company_path_command_value(v_command); end if;
	v_result := public.qorpera_publish_company_path(v_actor,null,v_command.plan,p_expected_head,p_tree_sha256,null,null);
	-- Roll the head, revision and receipt back together if a lock wait/storage
	-- check consumed the last of this exact human intent's authority.
	if v_command.expires_at <= clock_timestamp() then
		raise exception 'Company File edit expired' using errcode = '42501'; end if;
	update public.qorpera_member_company_path_commands set status = 'applied',result = v_result
	where id = p_command_id returning * into v_command;
	return public.qorpera_member_company_path_command_value(v_command);
end
$$;

-- Staging can write only immutable objects for the command's company. The
-- input kind and object bytes come from the trusted gateway, never an RPC tool.
create function public.qorpera_stage_member_company_path_object(
	p_command_id uuid,p_plan_sha256 text,p_sha256 text,p_bytes bigint,p_confirm boolean,p_tree boolean default false
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype; v_company uuid;
begin
	v_actor := public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,p_tree);
	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id;
	if v_command.status = 'applied' or p_confirm is null or p_tree is null
		or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_bytes is null or p_bytes not between 1 and 8388608
		or (not p_tree and not coalesce((
			(p_sha256 = v_command.plan #>> '{entry,file,fileSha256}' and p_bytes = (v_command.plan #>> '{entry,file,bytes}')::bigint)
			or (p_sha256 = v_command.plan #>> '{entry,file,manifestSha256}' and p_bytes <= 1024)),false)) then
		raise exception 'Company File staging identity is invalid' using errcode = '22023'; end if;
	perform public.qorpera_company_path_plan(v_actor,v_command.plan,true,false);
	v_company := (v_actor ->> 'companyId')::uuid;
	if exists(select 1 from public.qorpera_profile_objects where profile_id = v_company and sha256 = p_sha256 and bytes <> p_bytes) then
		raise exception 'Company File object identity changed' using errcode = '23505'; end if;
	if p_confirm then perform public.qorpera_confirm_profile_object_upload(v_company,p_sha256,p_bytes,'nas-object-gateway'); end if;
	return v_company;
end
$$;

create function public.qorpera_list_company_path_proposals(p_environment_id uuid,p_after uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_items jsonb;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	if p_limit is null or p_limit not between 1 and 50 then raise exception 'Invalid Company File page' using errcode = '22023'; end if;
	select coalesce(jsonb_agg(item order by id),'[]') into v_items from (
		select p.id,public.qorpera_get_company_path_proposal(p.id) as item from public.qorpera_company_path_proposals p
		where p.environment_id = p_environment_id and p.status in ('open','approved') and (p_after is null or p.id > p_after)
			and public.qorpera_company_path_allowed(v_actor,p.plan ->> 'path','read')
			and not exists(select 1 from public.qorpera_company_run_read_paths r where r.run_id = p.run_id
				and not public.qorpera_company_path_allowed(v_actor,r.path,'read'))
		order by p.id limit p_limit
	) page;
	return jsonb_build_object('items',v_items,'nextAfter',case when jsonb_array_length(v_items) = p_limit then v_items -> -1 ->> 'proposalId' else null end);
end
$$;

create function public.qorpera_describe_member_company_path_proposal(p_environment_id uuid,p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_company_path_actor(p_environment_id,null);
	if not exists(select 1 from public.qorpera_company_path_proposals where id = p_proposal_id and environment_id = p_environment_id) then
		raise exception 'Company File proposal is unavailable' using errcode = '42501'; end if;
	return public.qorpera_get_company_path_proposal(p_proposal_id);
end
$$;

create function public.qorpera_stage_company_path_approval_object(
	p_proposal_id uuid,p_plan_sha256 text,p_sha256 text,p_bytes bigint,p_confirm boolean
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_company uuid;
begin
	v_actor := public.qorpera_company_path_approved_actor(p_proposal_id,p_plan_sha256);
	if p_confirm is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null or p_bytes not between 1 and 8388608 then
		raise exception 'Company File candidate identity is invalid' using errcode = '22023'; end if;
	v_company := (v_actor ->> 'companyId')::uuid;
	if exists(select 1 from public.qorpera_profile_objects where profile_id = v_company and sha256 = p_sha256 and bytes <> p_bytes) then
		raise exception 'Company File candidate identity changed' using errcode = '23505'; end if;
	if p_confirm then perform public.qorpera_confirm_profile_object_upload(v_company,p_sha256,p_bytes,'nas-object-gateway'); end if;
	return v_company;
end
$$;

create function public.qorpera_authorize_member_company_proposal_object(p_proposal_id uuid,p_plan_sha256 text,p_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_proposal jsonb; v_company uuid; v_object public.qorpera_profile_objects%rowtype;
begin
	v_proposal := public.qorpera_get_company_path_proposal(p_proposal_id);
	if v_proposal ->> 'planSha256' is distinct from p_plan_sha256 or v_proposal ->> 'state' not in ('open','approved') then
		raise exception 'Company File proposal changed' using errcode = '42501'; end if;
	select f.profile_id into v_company from public.qorpera_company_path_proposals p
	join public.qorpera_company_files f on f.environment_id = p.environment_id where p.id = p_proposal_id;
	select o.* into v_object from public.qorpera_profile_objects o where o.profile_id = v_company and o.sha256 = p_sha256
		and exists(select 1 from public.qorpera_verified_company_file_objects proof,lateral jsonb_array_elements(proof.objects) part
			where proof.profile_id = v_company and proof.verifier_version = 1
				and proof.manifest_sha256 = v_proposal #>> '{plan,entry,file,manifestSha256}'
				and proof.file_sha256 = v_proposal #>> '{plan,entry,file,fileSha256}'
				and part ->> 'sha256' = p_sha256 and (part ->> 'bytes')::bigint = o.bytes);
	if not found then raise exception 'Company File proposal content is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('companyId',v_company,'sha256',p_sha256,'bytes',v_object.bytes,'backend',v_object.backend);
end
$$;

create function public.qorpera_authorize_member_company_command_object(p_command_id uuid,p_plan_sha256 text,p_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_command jsonb; v_company uuid; v_object public.qorpera_profile_objects%rowtype;
begin
	v_command := public.qorpera_get_member_company_path_command(p_command_id);
	if v_command ->> 'planSha256' is distinct from p_plan_sha256
		or v_command ->> 'state' not in ('ready','review_required','approved')
		or (v_command ->> 'expiresAt')::timestamptz <= clock_timestamp() then
		raise exception 'Company File edit changed or expired' using errcode = '42501'; end if;
	v_company := (v_command ->> 'companyId')::uuid;
	select o.* into v_object from public.qorpera_profile_objects o where o.profile_id = v_company and o.sha256 = p_sha256
		and exists(select 1 from public.qorpera_verified_company_file_objects proof,lateral jsonb_array_elements(proof.objects) part
			where proof.profile_id = v_company and proof.verifier_version = 1
				and proof.manifest_sha256 = v_command #>> '{plan,entry,file,manifestSha256}'
				and proof.file_sha256 = v_command #>> '{plan,entry,file,fileSha256}'
				and part ->> 'sha256' = p_sha256 and (part ->> 'bytes')::bigint = o.bytes);
	if not found then raise exception 'Company File edit content is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('companyId',v_company,'sha256',p_sha256,'bytes',v_object.bytes,'backend',v_object.backend);
end
$$;

-- Preserve all earlier retention roots, adding exact pending human content.
alter function public.qorpera_company_additional_retained_object_hashes(uuid) rename to qorpera_company_pre_member_retained_object_hashes;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text) language sql stable security definer set search_path = '' as $$
	select * from public.qorpera_company_pre_member_retained_object_hashes(p_profile_id)
	union
	select part.sha from public.qorpera_member_company_path_commands c
	join public.qorpera_company_files f on f.environment_id = c.environment_id
	cross join lateral (values (c.plan #>> '{entry,file,fileSha256}'),(c.plan #>> '{entry,file,manifestSha256}')) part(sha)
	where f.profile_id = p_profile_id and part.sha is not null
		and (c.expires_at > statement_timestamp() or c.created_at > statement_timestamp() - interval '30 days')
$$;

do $$
declare v_function regprocedure;
begin
	for v_function in select p.oid::regprocedure from pg_catalog.pg_proc p
	join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any(array[
		'qorpera_member_company_file_mode','qorpera_authorize_member_company_command_object',
		'qorpera_member_company_path_command_value','qorpera_begin_member_company_path_command','qorpera_get_member_company_path_command',
		'qorpera_list_member_company_path_commands',
		'qorpera_review_member_company_path_command','qorpera_member_company_path_command_actor','qorpera_prepare_member_company_path_command',
		'qorpera_apply_member_company_path_command','qorpera_stage_member_company_path_object','qorpera_list_company_path_proposals',
		'qorpera_describe_member_company_path_proposal','qorpera_stage_company_path_approval_object',
		'qorpera_authorize_member_company_proposal_object','qorpera_company_pre_member_retained_object_hashes','qorpera_company_additional_retained_object_hashes'
	]) loop execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function); end loop;
end
$$;
grant execute on function public.qorpera_begin_member_company_path_command(uuid,jsonb),
	public.qorpera_member_company_file_mode(uuid),public.qorpera_authorize_member_company_command_object(uuid,text,text),
	public.qorpera_list_member_company_path_commands(uuid,uuid,integer),
	public.qorpera_get_member_company_path_command(uuid),public.qorpera_review_member_company_path_command(uuid,text,text),
	public.qorpera_describe_member_company_path_proposal(uuid,uuid),
	public.qorpera_list_company_path_proposals(uuid,uuid,integer),public.qorpera_authorize_member_company_proposal_object(uuid,text,text) to authenticated;
grant execute on function public.qorpera_prepare_member_company_path_command(uuid,text),
	public.qorpera_apply_member_company_path_command(uuid,text,uuid,text),
	public.qorpera_stage_company_path_approval_object(uuid,text,text,bigint,boolean),
	public.qorpera_stage_member_company_path_object(uuid,text,text,bigint,boolean,boolean) to service_role;
