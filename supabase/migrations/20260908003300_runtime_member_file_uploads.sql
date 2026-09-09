-- Selected member uploads use the existing human command and atomic publisher.
-- The private source/manifest record binds exact immutable bytes to that intent.
create table public.qorpera_member_company_file_uploads (
 command_id uuid primary key references public.qorpera_member_company_path_commands(id) on delete cascade,
 source jsonb not null check (jsonb_typeof(source) = 'object' and pg_column_size(source) <= 2048),
 manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 2048),
 manifest_bytes bigint not null check (manifest_bytes between 1 and 2048),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_member_company_file_uploads enable row level security;
revoke all on public.qorpera_member_company_file_uploads from public,anon,authenticated,service_role;

create or replace function public.qorpera_begin_member_company_path_intent(p_environment_id uuid,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_resource public.qorpera_company_path_resources%rowtype;
	v_command public.qorpera_member_company_path_commands%rowtype; v_digest text; v_protected boolean;
begin
	v_actor := public.qorpera_company_path_actor(p_environment_id,null);
	v_resource := public.qorpera_company_path_plan(v_actor,p_plan,false,false);
	-- Private shared admission. Public wrappers distinguish text from selected
	-- binary uploads; no executable file is admitted.
	if p_plan #>> '{entry,kind}' = 'file' and ((p_plan #>> '{entry,file,bytes}')::bigint > 8388608
		or p_plan #> '{entry,executable}' <> 'false'::jsonb) then
		raise exception 'Company File input is invalid' using errcode = '22023'; end if;
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

create or replace function public.qorpera_begin_member_company_path_command(p_environment_id uuid,p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb;
begin
 v_actor := public.qorpera_company_path_actor(p_environment_id,null);
 perform public.qorpera_company_path_plan(v_actor,p_plan,false,false);
 if p_plan #>> '{entry,kind}' = 'file' and (p_plan #>> '{entry,file,bytes}')::bigint > 32768 then
  raise exception 'Company File text edit is invalid' using errcode = '22023'; end if;
 if exists(select 1 from public.qorpera_member_company_file_uploads u join public.qorpera_member_company_path_commands c on c.id=u.command_id
  where c.environment_id=p_environment_id and c.user_id=auth.uid() and c.operation_key=p_plan->>'operationKey') then
  raise exception 'Company File command is bound to an upload' using errcode='23505'; end if;
 return public.qorpera_begin_member_company_path_intent(p_environment_id,p_plan);
end
$$;

create function public.qorpera_begin_member_company_file_upload(p_environment_id uuid,p_plan jsonb,p_manifest_text text,p_source jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_manifest jsonb; v_bytes bigint; v_total bigint:=0; v_chunk jsonb; v_index integer:=0;
 v_count integer; v_command jsonb; v_old public.qorpera_member_company_path_commands%rowtype;
 v_upload public.qorpera_member_company_file_uploads%rowtype; v_name text;
begin
 v_actor := public.qorpera_company_path_actor(p_environment_id,null);
 perform public.qorpera_company_path_plan(v_actor,p_plan,false,false);
 if p_plan #>> '{entry,kind}' is distinct from 'file' or p_plan #> '{entry,executable}' is distinct from 'false'::jsonb
  or p_manifest_text is null or octet_length(p_manifest_text) not between 1 and 2048 then
  raise exception 'Invalid member upload' using errcode='22023'; end if;
 v_manifest:=p_manifest_text::jsonb; v_bytes:=(p_plan #>> '{entry,file,bytes}')::bigint;
 if v_bytes not between 0 and 8388608 or jsonb_typeof(p_source) is distinct from 'object'
  or (select array_agg(key order by key) from jsonb_object_keys(p_source) key) is distinct from array['bytes','mediaType','name','realm','sha256']
  or p_source->>'realm' is distinct from 'member_file' or p_source->'bytes' is distinct from to_jsonb(v_bytes)
  or p_source->>'sha256' is distinct from p_plan #>> '{entry,file,fileSha256}'
  or jsonb_typeof(p_source->'name') is distinct from 'string' or jsonb_typeof(p_source->'mediaType') is distinct from 'string'
  or octet_length(p_source->>'mediaType') not between 3 and 256
  or p_source->>'mediaType' !~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' then
  raise exception 'Invalid member upload source' using errcode='22023'; end if;
 v_name:=p_source->>'name';
 if octet_length(v_name) not between 1 and 255 or v_name in ('.','..') or v_name ~ '[[:cntrl:]/\\]' then
  raise exception 'Invalid member upload name' using errcode='22023'; end if;
 if jsonb_typeof(v_manifest) is distinct from 'object'
  or (select array_agg(key order by key) from jsonb_object_keys(v_manifest) key) is distinct from array['bytes','chunks','fileSha256','mediaType','schema']
  or v_manifest->>'schema' is distinct from 'qorpera.cloud-file-manifest/v1'
  or v_manifest->'bytes' is distinct from to_jsonb(v_bytes)
  or v_manifest->>'fileSha256' is distinct from p_plan #>> '{entry,file,fileSha256}'
  or v_manifest->>'mediaType' is distinct from 'application/octet-stream'
  or encode(extensions.digest(convert_to(p_manifest_text,'utf8'),'sha256'),'hex') is distinct from p_plan #>> '{entry,file,manifestSha256}'
  or jsonb_typeof(v_manifest->'chunks') is distinct from 'array' then
  raise exception 'Invalid member upload manifest' using errcode='22023'; end if;
 v_count:=jsonb_array_length(v_manifest->'chunks');
 if v_count > 2 then raise exception 'Invalid member upload chunks' using errcode='22023'; end if;
 for v_chunk in select value from jsonb_array_elements(v_manifest->'chunks') loop
  v_index:=v_index+1;
  if jsonb_typeof(v_chunk) is distinct from 'object'
   or (select array_agg(key order by key) from jsonb_object_keys(v_chunk) key) is distinct from array['bytes','sha256']
   or jsonb_typeof(v_chunk->'sha256') is distinct from 'string' or v_chunk->>'sha256' !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(v_chunk->'bytes') is distinct from 'number' or v_chunk->>'bytes' !~ '^[1-9][0-9]{0,6}$'
   or (v_chunk->>'bytes')::bigint > 4194304 or (v_index<v_count and (v_chunk->>'bytes')::bigint<>4194304) then
   raise exception 'Invalid member upload chunk' using errcode='22023'; end if;
  v_total:=v_total+(v_chunk->>'bytes')::bigint;
 end loop;
 if v_total<>v_bytes or (v_count=1 and v_manifest #>> '{chunks,0,sha256}'<>v_manifest->>'fileSha256')
  or (v_count=0 and v_manifest->>'fileSha256'<>encode(extensions.digest(''::bytea,'sha256'),'hex')) then
  raise exception 'Invalid member upload content identity' using errcode='22023'; end if;
 select * into v_old from public.qorpera_member_company_path_commands
  where environment_id=p_environment_id and user_id=auth.uid() and operation_key=p_plan->>'operationKey' for update;
 if found then
  select * into v_upload from public.qorpera_member_company_file_uploads where command_id=v_old.id;
  if not found or v_upload.source<>p_source or v_upload.manifest<>v_manifest or v_upload.manifest_bytes<>octet_length(p_manifest_text) then
   raise exception 'Member upload is bound to different work' using errcode='23505'; end if;
 end if;
 v_command:=public.qorpera_begin_member_company_path_intent(p_environment_id,p_plan);
 insert into public.qorpera_member_company_file_uploads(command_id,source,manifest,manifest_bytes)
 values((v_command->>'commandId')::uuid,p_source,v_manifest,octet_length(p_manifest_text)) on conflict do nothing;
 return v_command;
end
$$;

create or replace function public.qorpera_stage_member_company_path_object(
 p_command_id uuid,p_plan_sha256 text,p_sha256 text,p_bytes bigint,p_confirm boolean,p_tree boolean default false
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_command public.qorpera_member_company_path_commands%rowtype; v_company uuid;
 v_upload public.qorpera_member_company_file_uploads%rowtype; v_allowed boolean;
begin
 v_actor:=public.qorpera_member_company_path_command_actor(p_command_id,p_plan_sha256,p_tree);
 select * into strict v_command from public.qorpera_member_company_path_commands where id=p_command_id;
 select * into v_upload from public.qorpera_member_company_file_uploads where command_id=p_command_id;
 if found then
  v_allowed:=(p_sha256=v_command.plan #>> '{entry,file,manifestSha256}' and p_bytes=v_upload.manifest_bytes)
   or exists(select 1 from jsonb_array_elements(v_upload.manifest->'chunks') chunk where chunk->>'sha256'=p_sha256 and (chunk->>'bytes')::bigint=p_bytes);
 else
  v_allowed:=(p_sha256=v_command.plan #>> '{entry,file,fileSha256}' and p_bytes=(v_command.plan #>> '{entry,file,bytes}')::bigint)
   or (p_sha256=v_command.plan #>> '{entry,file,manifestSha256}' and p_bytes<=1024);
 end if;
 if v_command.status='applied' or p_confirm is null or p_tree is null or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
  or p_bytes is null or p_bytes not between 1 and 8388608 or (not p_tree and not coalesce(v_allowed,false)) then
  raise exception 'Company File staging identity is invalid' using errcode='22023'; end if;
 perform public.qorpera_company_path_plan(v_actor,v_command.plan,true,false);
 v_company:=(v_actor->>'companyId')::uuid;
 if exists(select 1 from public.qorpera_profile_objects where profile_id=v_company and sha256=p_sha256 and bytes<>p_bytes) then
  raise exception 'Company File object identity changed' using errcode='23505'; end if;
 if p_confirm then perform public.qorpera_confirm_profile_object_upload(v_company,p_sha256,p_bytes,'nas-object-gateway'); end if;
 return v_company;
end
$$;

alter function public.qorpera_company_additional_retained_object_hashes(uuid) rename to qorpera_company_pre_member_upload_retained_hashes;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table(object_sha256 text) language sql stable security definer set search_path='' as $$
 select * from public.qorpera_company_pre_member_upload_retained_hashes(p_profile_id)
 union
 select chunk->>'sha256' from public.qorpera_member_company_file_uploads u
 join public.qorpera_member_company_path_commands c on c.id=u.command_id
 join public.qorpera_company_files f on f.environment_id=c.environment_id
 cross join lateral jsonb_array_elements(u.manifest->'chunks') chunk
 where f.profile_id=p_profile_id and (c.expires_at>statement_timestamp() or c.created_at>statement_timestamp()-interval '30 days')
$$;

revoke all on function public.qorpera_begin_member_company_path_intent(uuid,jsonb),
 public.qorpera_begin_member_company_file_upload(uuid,jsonb,text,jsonb),
 public.qorpera_company_additional_retained_object_hashes(uuid),public.qorpera_company_pre_member_upload_retained_hashes(uuid)
 from public,anon,authenticated,service_role,qorpera_secret_broker;
grant execute on function public.qorpera_begin_member_company_file_upload(uuid,jsonb,text,jsonb) to authenticated;
do $$ declare v_owner name; begin
 select r.rolname into v_owner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 join pg_catalog.pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname='qorpera_company_retained_object_hashes';
 execute format('grant execute on function public.qorpera_company_additional_retained_object_hashes(uuid) to %I',v_owner);
end $$;
