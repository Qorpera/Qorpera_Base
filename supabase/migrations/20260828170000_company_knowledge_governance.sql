-- Step 6: opt-in schema annotations on existing path resources, derived
-- semantic proofs on existing immutable-file proofs, and skill load events
-- in the existing run ledger. Explicitly approved preservation is enforced
-- by the shared GC roots; there is no new body store or invented expiry.

alter table public.qorpera_company_path_resources
	add column knowledge_kind text check (knowledge_kind in ('memory','skills')),
	add column knowledge_retention_policy jsonb,
	add check (knowledge_kind is null or (path <> '' and path_match = 'subtree'));
alter table public.qorpera_verified_company_file_objects
	add column knowledge_metadata jsonb check (knowledge_metadata is null or (
		jsonb_typeof(knowledge_metadata) = 'object' and pg_column_size(knowledge_metadata) <= 2048));

create function public.qorpera_company_knowledge_closed(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_value) = 'object' and p_value ?& p_keys
		and p_value - p_keys = '{}'::jsonb,false)
$$;

create function public.qorpera_company_knowledge_text(p_value jsonb,p_max_bytes integer,p_identifier boolean default false)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(jsonb_typeof(p_value) = 'string' and octet_length(p_value #>> '{}') <= p_max_bytes
		and btrim(p_value #>> '{}',E' \t\n\r\f' || chr(11) ||
			U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
		and (not p_identifier or (p_value #>> '{}') !~ U&'[\0001-\001F\007F-\009F]'),false)
$$;

create function public.qorpera_company_knowledge_retention_policy_valid(p_policy jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select public.qorpera_company_knowledge_closed(p_policy,array['id','version','history'])
		and public.qorpera_company_knowledge_text(p_policy -> 'id',256,true)
		and public.qorpera_company_knowledge_text(p_policy -> 'version',256,true)
		and coalesce(p_policy ->> 'history' = 'preserve',false)
$$;
alter table public.qorpera_company_path_resources add constraint qorpera_company_knowledge_retention_policy_check
	check (knowledge_retention_policy is null or (knowledge_kind is not null
		and public.qorpera_company_knowledge_retention_policy_valid(knowledge_retention_policy)));

-- Validates the same closed memory/Markdown schemas as the service parsers.
-- Only metadata needed to enforce schema/scope and loaded versions survives;
-- bodies and historical content remain exclusively in the Company File.
create function public.qorpera_company_knowledge_metadata(p_kind text,p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_data jsonb; v_front text[]; v_body text; v_schema text;
	v_year integer; v_month integer; v_day integer; v_days integer;
begin
	if p_text is null or octet_length(p_text) not between 1 and 32768 or p_kind is null
		or p_kind not in ('memory','skills') then
		raise exception 'Company knowledge object is invalid' using errcode = '22023'; end if;
	if p_kind = 'memory' then
		v_data := p_text::jsonb;
		v_schema := 'qorpera.company-memory/v1';
	else
		v_front := regexp_match(p_text,E'^(---\r?\n(.*?)\r?\n---\r?\n)','s');
		if v_front is null or octet_length(v_front[1]) > 4096 then
			raise exception 'Company skill front matter is invalid' using errcode = '22023'; end if;
		v_data := v_front[2]::jsonb;
		v_body := substr(p_text,char_length(v_front[1])+1);
		v_schema := 'qorpera.company-skill/v1';
	end if;
	if jsonb_typeof(v_data) is distinct from 'object' or v_data ->> 'schema' is distinct from v_schema then
		raise exception 'Company knowledge schema is invalid' using errcode = '22023'; end if;
	if v_data ->> 'state' = 'forgotten' then
		if not public.qorpera_company_knowledge_closed(v_data,array['schema','state','previousVersion','reason','retentionPolicy'])
			or not public.qorpera_company_knowledge_text(v_data -> 'previousVersion',256,true)
			or not public.qorpera_company_knowledge_text(v_data -> 'reason',512)
			or not public.qorpera_company_knowledge_retention_policy_valid(v_data -> 'retentionPolicy')
			or (p_kind = 'skills' and v_body <> '') then
			raise exception 'Company knowledge tombstone is invalid' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.knowledge-proof/v1','kind',p_kind,'state','forgotten',
			'previousVersion',v_data -> 'previousVersion','retentionPolicy',v_data -> 'retentionPolicy');
	end if;
	if v_data ->> 'state' is distinct from 'active' then
		raise exception 'Company knowledge state is invalid' using errcode = '22023'; end if;
	if p_kind = 'memory' then
		if jsonb_typeof(v_data -> 'kind') is distinct from 'string'
			or v_data ->> 'kind' not in ('fact','agent_profile','agent_log')
			or not public.qorpera_company_knowledge_closed(v_data,array['schema','state','kind','title','text'] ||
				case when v_data ->> 'kind' = 'agent_log' then array['date'] else array[]::text[] end)
			or not public.qorpera_company_knowledge_text(v_data -> 'title',256)
			or not public.qorpera_company_knowledge_text(v_data -> 'text',16384) then
			raise exception 'Company memory content is invalid' using errcode = '22023'; end if;
		if v_data ->> 'kind' = 'agent_log' then
			if jsonb_typeof(v_data -> 'date') is distinct from 'string' or v_data ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
				raise exception 'Company memory date is invalid' using errcode = '22023'; end if;
			v_year := substr(v_data ->> 'date',1,4)::integer;
			v_month := substr(v_data ->> 'date',6,2)::integer;
			v_day := substr(v_data ->> 'date',9,2)::integer;
			v_days := case when v_month = 2 then case when v_year % 4 = 0 and (v_year % 100 <> 0 or v_year % 400 = 0) then 29 else 28 end
				when v_month in (4,6,9,11) then 30 else 31 end;
			if v_month not between 1 and 12 or v_day not between 1 and v_days then
				raise exception 'Company memory date is invalid' using errcode = '22023'; end if;
		end if;
		return jsonb_build_object('schema','qorpera.knowledge-proof/v1','kind',p_kind,'state','active','objectKind',v_data -> 'kind');
	end if;
	if not public.qorpera_company_knowledge_closed(v_data,array['schema','state','name','useWhen','bodySha256','bodyBytes'])
		or not public.qorpera_company_knowledge_text(v_data -> 'name',128,true)
		or not public.qorpera_company_knowledge_text(v_data -> 'useWhen',1024)
		or not public.qorpera_company_knowledge_text(to_jsonb(v_body),24576)
		or jsonb_typeof(v_data -> 'bodySha256') is distinct from 'string'
		or v_data ->> 'bodySha256' is distinct from encode(extensions.digest(convert_to(v_body,'utf8'),'sha256'),'hex')
		or jsonb_typeof(v_data -> 'bodyBytes') is distinct from 'number'
		or v_data -> 'bodyBytes' is distinct from to_jsonb(octet_length(v_body)) then
		raise exception 'Company skill content is invalid' using errcode = '22023'; end if;
	return jsonb_build_object('schema','qorpera.knowledge-proof/v1','kind',p_kind,'state','active',
		'name',v_data -> 'name','useWhen',v_data -> 'useWhen',
		'bodySha256',v_data -> 'bodySha256','bodyBytes',v_data -> 'bodyBytes');
exception when invalid_text_representation or untranslatable_character then
	raise exception 'Company knowledge encoding is invalid' using errcode = '22023';
end
$$;

create function public.qorpera_verify_company_knowledge_file(p_profile_id uuid,p_manifest_sha256 text,p_kind text,p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_proof public.qorpera_verified_company_file_objects%rowtype; v_metadata jsonb;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company File verifier authority is required' using errcode = '42501'; end if;
	v_metadata := public.qorpera_company_knowledge_metadata(p_kind,p_text);
	perform public.qorpera_lock_profile_gc_fence(p_profile_id);
	if public.qorpera_profile_gc_deletion_active(p_profile_id) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	select * into v_proof from public.qorpera_verified_company_file_objects
	where profile_id = p_profile_id and manifest_sha256 = p_manifest_sha256 and verifier_version = 1 for update;
	if not found or v_proof.bytes <> octet_length(p_text)
		or v_proof.file_sha256 <> encode(extensions.digest(convert_to(p_text,'utf8'),'sha256'),'hex')
		or not public.qorpera_company_path_file_available(p_profile_id,jsonb_build_object('manifestSha256',p_manifest_sha256,
			'fileSha256',v_proof.file_sha256,'bytes',v_proof.bytes,'mediaType',v_proof.media_type)) then
		raise exception 'Company knowledge bytes are not verified' using errcode = '55000'; end if;
	if v_proof.knowledge_metadata is not null and v_proof.knowledge_metadata <> v_metadata then
		raise exception 'Company knowledge verification differs' using errcode = '23505'; end if;
	update public.qorpera_verified_company_file_objects set knowledge_metadata = v_metadata
	where profile_id = p_profile_id and manifest_sha256 = p_manifest_sha256 and verifier_version = 1;
end
$$;

-- Only immediate, recognized object names are schema managed. Other files
-- remain ordinary Company File content; the bounded service scanner skips them.
create function public.qorpera_company_knowledge_entry(p_environment_id uuid,p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_profile uuid; v_metadata jsonb; v_name text;
begin
	if p_entry is null or p_entry = 'null'::jsonb then return null; end if;
	select * into v_resource from public.qorpera_company_path_resources
	where environment_id = p_environment_id and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
		regexp_replace(p_entry ->> 'path','/[^/]+$','')),'sha256')
		and knowledge_kind is not null;
	if not found then return null; end if;
	if v_resource.path <> regexp_replace(p_entry ->> 'path','/[^/]+$','') then
		raise exception 'Company knowledge collection path is not canonical' using errcode = '22023'; end if;
	v_name := substr(p_entry ->> 'path',char_length(v_resource.path)+2);
	if v_name !~ (case when v_resource.knowledge_kind = 'memory'
		then '^[a-z0-9][a-z0-9_-]{0,63}\.json$' else '^[a-z0-9][a-z0-9_-]{0,63}\.md$' end) then return null; end if;
	select profile_id into strict v_profile from public.qorpera_company_files where environment_id = p_environment_id;
	select knowledge_metadata into v_metadata from public.qorpera_verified_company_file_objects
	where profile_id = v_profile and manifest_sha256 = p_entry #>> '{file,manifestSha256}' and verifier_version = 1;
	if p_entry ->> 'kind' is distinct from 'file' or p_entry -> 'executable' is distinct from 'false'::jsonb
		or v_metadata ->> 'schema' is distinct from 'qorpera.knowledge-proof/v1'
		or v_metadata ->> 'kind' is distinct from v_resource.knowledge_kind
		or not public.qorpera_company_path_file_available(v_profile,p_entry -> 'file') then
		raise exception 'Company File collection requires verified knowledge content' using errcode = '22023'; end if;
	-- The current shared authority model has no agent-private audience. Profile
	-- and log schemas exist, but cannot be admitted under a shared/member scope.
	if v_metadata ->> 'objectKind' in ('agent_profile','agent_log') then
		raise exception 'Agent-private Company File authority is not implemented' using errcode = '42501'; end if;
	return v_metadata;
end
$$;

-- Schema registration is a human-authorized resource revision. It deliberately
-- invalidates old version-bound grants; the caller must explicitly regrant.
-- The optional policy is approval for a future preserve operation, not an
-- automatic hold on every collection write. Removing/changing approval never
-- releases preservation already committed in the immutable revision ledger.
-- Adoption verifies existing objects without converting or purging anything.
create function public.qorpera_set_company_knowledge_schema(
	p_environment_id uuid,p_path text,p_kind text,p_expected_version uuid,p_retention_policy jsonb default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_current public.qorpera_company_path_resources%rowtype; v_result jsonb;
	v_entry public.qorpera_company_path_entries%rowtype; v_metadata jsonb;
begin
	perform public.qorpera_company_path_actor(p_environment_id,null);
	select * into v_current from public.qorpera_company_path_resources where environment_id = p_environment_id and path = p_path;
	if not found or p_path = '' or v_current.path_match <> 'subtree'
		or (p_kind is not null and p_kind not in ('memory','skills'))
		or (p_retention_policy is not null and (p_kind is null
			or not public.qorpera_company_knowledge_retention_policy_valid(p_retention_policy))) then
		raise exception 'Company File collection resource is invalid' using errcode = '22023'; end if;
	v_result := public.qorpera_set_company_path_resource(p_environment_id,p_path,v_current.path_match,
		v_current.scope,v_current.policy,p_expected_version);
	update public.qorpera_company_path_resources set knowledge_kind = p_kind,
		knowledge_retention_policy = p_retention_policy where id = v_current.id;
	if p_kind is not null then
		for v_entry in select * from public.qorpera_company_path_entries where environment_id = p_environment_id
			and entry is not null and public.qorpera_company_path_key(regexp_replace(path,'/[^/]+$','')) = public.qorpera_company_path_key(p_path) loop
			v_metadata := public.qorpera_company_knowledge_entry(p_environment_id,v_entry.entry);
			if v_metadata ->> 'state' = 'forgotten' and not exists (
				select 1 from public.qorpera_company_path_revisions revision where revision.environment_id = p_environment_id
					and revision.change ->> 'version' = v_entry.version::text
					and revision.change #> '{plan,entry}' = v_entry.entry
					and revision.change #>> '{knowledgeRetention,schema}' = 'qorpera.knowledge-retention/v1') then
				raise exception 'Company knowledge preservation was not committed' using errcode = '55000'; end if;
		end loop;
	end if;
	return v_result;
end
$$;

-- The host's policy reference and file metadata cannot grant retention
-- authority. The exact collection resource owns the human-approved reference.
create function public.qorpera_company_knowledge_retention_policy(p_environment_id uuid,p_path text,p_policy jsonb)
returns public.qorpera_company_path_resources language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype;
begin
	select * into v_resource from public.qorpera_company_path_resources
	where environment_id = p_environment_id and path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
		regexp_replace(p_path,'/[^/]+$','')),'sha256');
	if not found or v_resource.path <> regexp_replace(p_path,'/[^/]+$','')
		or v_resource.knowledge_kind is null or v_resource.revoked_at is not null
		or v_resource.knowledge_retention_policy is null or v_resource.knowledge_retention_policy is distinct from p_policy then
		raise exception 'Company knowledge retention policy is not approved' using errcode = '42501'; end if;
	return v_resource;
end
$$;

alter function public.qorpera_company_path_plan(jsonb,jsonb,boolean,boolean) rename to qorpera_company_path_plan_before_knowledge;
create function public.qorpera_company_path_plan(p_actor jsonb,p_plan jsonb,p_check_version boolean,p_check_bytes boolean default true)
returns public.qorpera_company_path_resources language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype; v_metadata jsonb;
begin
	v_resource := public.qorpera_company_path_plan_before_knowledge(p_actor,p_plan,p_check_version,p_check_bytes);
	if p_check_bytes then
		v_metadata := public.qorpera_company_knowledge_entry((p_actor ->> 'environmentId')::uuid,p_plan -> 'entry');
		if v_metadata ->> 'state' = 'forgotten' then
			if v_metadata ->> 'previousVersion' is distinct from p_plan ->> 'expectedVersion' then
				raise exception 'Company knowledge tombstone version changed' using errcode = '40001'; end if;
			perform public.qorpera_company_knowledge_retention_policy((p_actor ->> 'environmentId')::uuid,
				p_plan ->> 'path',v_metadata -> 'retentionPolicy');
		end if;
	end if;
	return v_resource;
end
$$;

create function public.qorpera_enforce_company_knowledge_entry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_company_knowledge_entry(new.environment_id,new.entry);
	return new;
end
$$;
create trigger qorpera_company_knowledge_entry_guard
	before insert or update of environment_id,path,entry on public.qorpera_company_path_entries
	for each row execute function public.qorpera_enforce_company_knowledge_entry();

-- Version lineage is authoritative in the existing private revision ledger.
-- Lookup uses opaque versions, never timestamps or current collection state.
create unique index qorpera_company_path_revision_version
	on public.qorpera_company_path_revisions(environment_id,(change ->> 'version'));
create index qorpera_company_path_revision_preservation
	on public.qorpera_company_path_revisions(environment_id) where change ? 'knowledgeRetention';

-- Governed objects fit the shared codec's single-chunk contract (<=32 KiB).
-- Verify that invariant before using immutable entry hashes as durable roots.
-- Larger pre-adoption history needs an explicit migration, not guessed roots.
create function public.qorpera_company_knowledge_history_entry(p_profile_id uuid,p_path text,p_entry jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_proof public.qorpera_verified_company_file_objects%rowtype; v_objects jsonb;
begin
	if p_entry is null or p_entry = 'null'::jsonb then return; end if;
	if not public.qorpera_company_path_entry_valid(p_entry) or p_entry ->> 'path' is distinct from p_path then
		raise exception 'Company knowledge historical entry is invalid' using errcode = '55000'; end if;
	if p_entry ->> 'kind' = 'directory' then return; end if;
	if (p_entry #>> '{file,bytes}')::bigint > 32768
		or not public.qorpera_company_path_file_available(p_profile_id,p_entry -> 'file') then
		raise exception 'Company knowledge historical objects are unavailable or unsupported' using errcode = '55000'; end if;
	select * into strict v_proof from public.qorpera_verified_company_file_objects where profile_id = p_profile_id
		and manifest_sha256 = p_entry #>> '{file,manifestSha256}' and verifier_version = 1;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select jsonb_build_object('sha256',v_proof.manifest_sha256,'bytes',v_proof.manifest_bytes) as object
		union select jsonb_build_object('sha256',v_proof.file_sha256,'bytes',v_proof.bytes) where v_proof.bytes > 0
	) closure;
	if v_proof.objects is distinct from v_objects then
		raise exception 'Company knowledge historical closure is unsupported' using errcode = '55000'; end if;
end
$$;

-- Publication already holds the shared profile GC fence and Company File
-- lock. Attach retention to its immutable revision in that same transaction;
-- a proposal, failed publication or receipt rollback cannot create a hold.
create function public.qorpera_company_knowledge_preserve_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_metadata jsonb; v_profile uuid; v_resource public.qorpera_company_path_resources%rowtype;
	v_revision public.qorpera_company_path_revisions%rowtype; v_path text := new.change #>> '{plan,path}';
	v_version text := new.change #>> '{plan,expectedVersion}'; v_parent uuid := new.parent_snapshot_id;
	v_origin jsonb; v_tree jsonb; v_entry jsonb;
	v_has_history boolean := false; v_terminal boolean := false; v_origin_required boolean := true;
begin
	if new.change ? 'knowledgeRetention' then
		raise exception 'Company knowledge preservation is computed at publication' using errcode = '22023'; end if;
	v_metadata := public.qorpera_company_knowledge_entry(new.environment_id,new.change #> '{plan,entry}');
	if v_metadata ->> 'state' is distinct from 'forgotten' then return new; end if;
	if v_version is null or v_version is distinct from v_metadata ->> 'previousVersion' then
		raise exception 'Company knowledge tombstone version changed' using errcode = '40001'; end if;
	v_resource := public.qorpera_company_knowledge_retention_policy(new.environment_id,v_path,v_metadata -> 'retentionPolicy');
	select profile_id into strict v_profile from public.qorpera_company_files where environment_id = new.environment_id;
	perform public.qorpera_lock_profile_gc_fence(v_profile);
	if public.qorpera_profile_gc_deletion_active(v_profile) then
		raise exception 'Company File storage is busy' using errcode = '40001'; end if;
	perform public.qorpera_company_knowledge_history_entry(v_profile,v_path,new.change #> '{plan,entry}');
	-- UNION terminates corrupt cycles without a quadratic growing seen-array.
	-- A prior committed hold is a durable checkpoint: only the new segment
	-- needs byte/proof validation; old proof-cache eviction cannot release it.
	for v_revision in with recursive history as (
		select * from public.qorpera_company_path_revisions
		where environment_id = new.environment_id and change ->> 'version' = v_version
		union
		select previous.* from history current_revision
		join public.qorpera_company_path_revisions previous on previous.environment_id = new.environment_id
			and previous.change ->> 'version' = current_revision.change #>> '{plan,expectedVersion}'
		where current_revision.change #>> '{knowledgeRetention,schema}' is distinct from 'qorpera.knowledge-retention/v1'
	) select * from history loop
		v_has_history := true;
		if v_revision.change #>> '{plan,path}' is distinct from v_path then
			raise exception 'Company knowledge history path differs' using errcode = '55000'; end if;
		if v_revision.change #>> '{knowledgeRetention,schema}' = 'qorpera.knowledge-retention/v1' then
			if v_revision.change #>> '{knowledgeRetention,path}' is distinct from v_path
				or v_revision.change #> '{knowledgeRetention,throughVersion}' is distinct from v_revision.change #> '{plan,expectedVersion}' then
				raise exception 'Company knowledge preservation checkpoint differs' using errcode = '55000'; end if;
			v_terminal := true;
			v_origin_required := false;
		else
			perform public.qorpera_company_knowledge_history_entry(v_profile,v_path,v_revision.change #> '{plan,entry}');
			if v_revision.change #>> '{plan,expectedVersion}' is null then
				v_terminal := true;
				v_origin_required := false;
			elsif not exists (select 1 from public.qorpera_company_path_revisions previous
				where previous.environment_id = new.environment_id
					and previous.change ->> 'version' = v_revision.change #>> '{plan,expectedVersion}') then
				v_terminal := true;
				v_parent := v_revision.parent_snapshot_id;
				v_version := v_revision.change #>> '{plan,expectedVersion}';
			end if;
		end if;
	end loop;
	if v_has_history and not v_terminal then
		raise exception 'Company knowledge history is cyclic' using errcode = '55000'; end if;
	if v_origin_required then
		-- An enrolled initial version predates the path-operation ledger.
		-- Capture its exact descriptor before the parent-tree cache can age.
		select cache.manifest into v_tree from public.qorpera_company_snapshots snapshot
		join public.qorpera_company_path_tree_cache cache on cache.profile_id = snapshot.profile_id
			and cache.sha256 = snapshot.tree_manifest_sha256 and cache.bytes = snapshot.tree_manifest_bytes
		where snapshot.id = v_parent and snapshot.profile_id = v_profile
			and snapshot.environment_id = new.environment_id and snapshot.tree_contract_version = 3;
		if not found then
			raise exception 'Company knowledge history origin is unavailable' using errcode = '55000'; end if;
		select value into v_entry from jsonb_array_elements(v_tree -> 'entries') where value ->> 'path' = v_path;
		if not found then
			raise exception 'Company knowledge history origin is missing' using errcode = '55000'; end if;
		v_origin := jsonb_build_object('version',v_version,'entry',v_entry);
		perform public.qorpera_company_knowledge_history_entry(v_profile,v_path,v_entry);
	end if;
	new.change := new.change || jsonb_build_object('knowledgeRetention',jsonb_build_object(
		'schema','qorpera.knowledge-retention/v1','path',v_path,'policy',v_metadata -> 'retentionPolicy',
		'resourceId',v_resource.id,'resourceVersion',v_resource.version,
		'throughVersion',new.change #> '{plan,expectedVersion}','origin',v_origin));
	return new;
end
$$;
create trigger qorpera_company_knowledge_preservation
	before insert on public.qorpera_company_path_revisions
	for each row execute function public.qorpera_company_knowledge_preserve_revision();

-- Preserve only these path versions' manifests/bodies and their revision
-- descriptors. Whole historical company snapshots may still age normally.
-- No proof cache, current tombstone, policy or schema registration controls
-- an already-committed hold. Releasing one requires a separate policy design.
alter function public.qorpera_company_additional_retained_object_hashes(uuid)
	rename to qorpera_company_retained_extras_before_knowledge;
create function public.qorpera_company_additional_retained_object_hashes(p_profile_id uuid)
returns table (object_sha256 text) language sql stable security definer set search_path = '' as $$
	with recursive history as (
		select revision.environment_id,revision.change from public.qorpera_company_path_revisions revision
		join public.qorpera_company_files file on file.environment_id = revision.environment_id
		where file.profile_id = p_profile_id and revision.change ? 'knowledgeRetention'
		union
		select previous.environment_id,previous.change from history retained
		join public.qorpera_company_path_revisions previous on previous.environment_id = retained.environment_id
			and previous.change ->> 'version' = retained.change #>> '{plan,expectedVersion}'
			and previous.change #>> '{plan,path}' = retained.change #>> '{plan,path}'
	), entries as (
		select change #> '{plan,entry}' as entry from history
		union select change #> '{knowledgeRetention,origin,entry}' from history
	)
	select object_sha256 from public.qorpera_company_retained_extras_before_knowledge(p_profile_id)
	union select entry #>> '{file,manifestSha256}' from entries where entry ->> 'kind' = 'file'
	union select entry #>> '{file,fileSha256}' from entries where entry ->> 'kind' = 'file'
		and (entry #>> '{file,bytes}')::bigint > 0
$$;

create function public.qorpera_company_knowledge_collection(p_actor jsonb,p_collection jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_resource public.qorpera_company_path_resources%rowtype;
begin
	if not public.qorpera_company_knowledge_closed(p_collection,array['id','path','kind','scope'])
		or jsonb_typeof(p_collection -> 'id') is distinct from 'string' or p_collection ->> 'id' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
		or jsonb_typeof(p_collection -> 'path') is distinct from 'string'
		or not public.qorpera_company_path_valid(p_collection ->> 'path')
		or p_collection ->> 'kind' is null or p_collection ->> 'kind' not in ('memory','skills')
		or p_collection -> 'scope' is distinct from '{"kind":"company_shared"}'::jsonb then
		raise exception 'Company knowledge collection is unsupported' using errcode = '42501'; end if;
	v_resource := public.qorpera_company_path_require(p_actor,p_collection ->> 'path','read');
	if v_resource.path is distinct from p_collection ->> 'path' or v_resource.path_match <> 'subtree'
		or v_resource.knowledge_kind is distinct from p_collection ->> 'kind' or v_resource.scope <> 'company_shared' then
		raise exception 'Company knowledge collection registration changed' using errcode = '42501'; end if;
end
$$;

-- Same atomic source-fence request, with canonical collection/scope checks.
-- The original five-argument RPC remains for ordinary native path callers.
create function public.qorpera_retain_company_path_sources(
	p_environment_id uuid,p_binding jsonb,p_paths text[],p_sources jsonb,p_retained text[],p_collections jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_collection jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Company File preparation authority is required' using errcode = '42501'; end if;
	if jsonb_typeof(p_collections) is distinct from 'array' or pg_column_size(p_collections) > 131072 then
		raise exception 'Company knowledge collection bound is invalid' using errcode = '22023'; end if;
	if jsonb_array_length(p_collections) > 16 then
		raise exception 'Company knowledge collection bound is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	for v_collection in select value from jsonb_array_elements(p_collections) loop
		perform public.qorpera_company_knowledge_collection(v_actor,v_collection);
	end loop;
	perform public.qorpera_retain_company_path_sources(p_environment_id,p_binding,p_paths,p_sources,p_retained);
end
$$;

alter table public.qorpera_execution_run_events drop constraint qorpera_execution_run_events_event_type_check;
alter table public.qorpera_execution_run_events add constraint qorpera_execution_run_events_event_type_check check (event_type in (
	'queued','orchestrator_claimed','runner_assigned','runner_started','lease_renewed','infrastructure_retry','completed','failed',
	'cancelled','review_pending','provider_session_bound','recovery_released','recovery_discarded','skill_loaded'
));
create unique index qorpera_execution_run_events_skill_load
	on public.qorpera_execution_run_events (run_id,(payload ->> 'loadKey')) where event_type = 'skill_loaded';

-- Skill-load audit records do not transition run lifecycle status. Preserve the
-- existing descriptor and all pre-Step-6 event semantics for its callers.
create or replace function public.qorpera_execution_run_json(p_run public.qorpera_execution_runs)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'run_id', p_run.id,
		'profile_id', p_run.profile_id,
		'environment_id', p_run.environment_id,
		'source_kind', p_run.source_kind,
		'source_id', p_run.source_id,
		'session_id', p_run.session_id,
		'job_id', p_run.job_id,
		'substrate_version_id', p_run.substrate_version_id,
		'company_snapshot_id', p_run.company_snapshot_id,
		'staff_agent_id', p_run.staff_agent_id,
		'staff_version', p_run.staff_version,
		'model_provider', p_run.model_provider,
		'model_id', p_run.model_id,
		'model_selection', p_run.model_selection,
		'model_mapping_version', p_run.model_mapping_version,
		'input_ids', to_jsonb(p_run.input_ids),
		'sponsor_binding_id', p_run.sponsor_binding_id,
		'sponsor_version', p_run.sponsor_version,
		'required_capability', p_run.required_capability,
		'job_type', p_run.job_type,
		'payload_sha256', p_run.payload_sha256,
		'publication_mode', p_run.publication_mode,
		'review_policy_key', p_run.review_policy_key,
		'reviewer_staff_ids', to_jsonb(p_run.reviewer_staff_ids),
		'logical_computer_id', p_run.logical_computer_id,
		'compute_identity_id', p_run.compute_identity_id,
		'compute_identity_ownership_kind', (
			select identity.ownership_kind from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_user_id', (
			select identity.owner_user_id from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'compute_identity_owner_scope_key', (
			select identity.owner_scope_key from public.qorpera_member_compute_identities as identity
			where identity.id = p_run.compute_identity_id
		),
		'worker_class', p_run.worker_class,
		'requested_by_user_id', p_run.requested_by_user_id,
		'sponsored_by_user_id', p_run.sponsored_by_user_id,
		'transcript_start_sequence', p_run.transcript_start_sequence,
		'status', coalesce((
			select event.event_type from public.qorpera_execution_run_events as event
			where event.run_id = p_run.id and event.event_type <> 'skill_loaded'
			order by event.id desc limit 1
		), 'queued'),
		'created_by_user_id', p_run.created_by_user_id,
		'created_at', p_run.created_at,
		'deadline_at', p_run.deadline_at
	)
$$;

-- Private shared implementation. Replay never inserts; recording is idempotent
-- by the exact load identity and bound to the admitted run, current scope,
-- current version, catalog metadata and verified body digest. Platform bundle bytes are pinned
-- and checked by the trusted host; this event confers no runtime authority.
create function public.qorpera_company_skill_load(p_environment_id uuid,p_binding jsonb,p_record jsonb,p_assert_only boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_run jsonb; v_reference jsonb; v_source jsonb; v_key text;
	v_entry public.qorpera_company_path_entries%rowtype; v_metadata jsonb; v_existing jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_binding is null then
		raise exception 'Company skill recorder authority is required' using errcode = '42501'; end if;
	if not public.qorpera_company_knowledge_closed(p_record,array['schema','loadKey','run','reference','source','name','useWhen','bodySha256','bodyBytes'])
		or pg_column_size(p_record) > 16384 or p_record ->> 'schema' is distinct from 'qorpera.skill-load/v1'
		or not public.qorpera_company_knowledge_text(p_record -> 'name',128,true)
		or not public.qorpera_company_knowledge_text(p_record -> 'useWhen',1024)
		or jsonb_typeof(p_record -> 'loadKey') is distinct from 'string' or p_record ->> 'loadKey' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_record -> 'bodySha256') is distinct from 'string' or p_record ->> 'bodySha256' !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(p_record -> 'bodyBytes') is distinct from 'number' or p_record ->> 'bodyBytes' !~ '^[1-9][0-9]{0,4}$' then
		raise exception 'Company skill load record is invalid' using errcode = '22023'; end if;
	if (p_record ->> 'bodyBytes')::integer > 24576 then
		raise exception 'Company skill load record is invalid' using errcode = '22023'; end if;
	v_run := p_record -> 'run'; v_reference := p_record -> 'reference'; v_source := p_record -> 'source';
	v_actor := public.qorpera_company_path_actor(p_environment_id,p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
	if not public.qorpera_company_knowledge_closed(v_run,array['companyId','environmentId','runId','runtimeBundleVersion'])
		or v_run -> 'companyId' is distinct from v_actor -> 'companyId'
		or v_run -> 'environmentId' is distinct from v_actor -> 'environmentId'
		or v_run -> 'runId' is distinct from v_actor -> 'runId'
		or not public.qorpera_company_knowledge_text(v_run -> 'runtimeBundleVersion',256,true)
		or jsonb_typeof(v_reference -> 'id') is distinct from 'string' or v_reference ->> 'id' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
		or not public.qorpera_company_knowledge_text(v_source -> 'version',256,true)
		or v_source ->> 'trust' is distinct from 'untrusted_data' or v_source ->> 'authority' is distinct from 'none' then
		raise exception 'Company skill load does not match the admitted run' using errcode = '42501'; end if;
	if v_reference ->> 'kind' = 'company' then
		if not public.qorpera_company_knowledge_closed(v_reference,array['kind','collectionId','id'])
			or jsonb_typeof(v_reference -> 'collectionId') is distinct from 'string' or v_reference ->> 'collectionId' !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
			or not public.qorpera_company_knowledge_closed(v_source,array['kind','companyId','environmentId','collectionId','objectId','path','version','scope','trust','authority'])
			or v_source ->> 'kind' is distinct from 'company_file' or v_source -> 'companyId' is distinct from v_run -> 'companyId'
			or v_source -> 'environmentId' is distinct from v_run -> 'environmentId'
			or v_source -> 'collectionId' is distinct from v_reference -> 'collectionId' or v_source -> 'objectId' is distinct from v_reference -> 'id'
			or jsonb_typeof(v_source -> 'path') is distinct from 'string'
			or v_source ->> 'path' is distinct from regexp_replace(v_source ->> 'path','/[^/]+$','') || '/' || (v_reference ->> 'id') || '.md'
			or v_source ->> 'version' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
			raise exception 'Company skill source is invalid' using errcode = '22023'; end if;
		perform public.qorpera_company_knowledge_collection(v_actor,jsonb_build_object('id',v_reference -> 'collectionId',
			'path',regexp_replace(v_source ->> 'path','/[^/]+$',''),'kind','skills','scope',v_source -> 'scope'));
		perform public.qorpera_company_path_require(v_actor,v_source ->> 'path','read');
		select * into v_entry from public.qorpera_company_path_entries where environment_id = p_environment_id and path = v_source ->> 'path';
		if not found or v_entry.entry is null or v_entry.version::text <> v_source ->> 'version' then
			raise exception 'Company skill source changed' using errcode = '40001'; end if;
		v_metadata := public.qorpera_company_knowledge_entry(p_environment_id,v_entry.entry);
		if v_metadata ->> 'state' is distinct from 'active' or v_metadata ->> 'kind' is distinct from 'skills'
			or v_metadata -> 'name' is distinct from p_record -> 'name'
			or v_metadata -> 'useWhen' is distinct from p_record -> 'useWhen'
			or v_metadata -> 'bodySha256' is distinct from p_record -> 'bodySha256'
			or v_metadata -> 'bodyBytes' is distinct from p_record -> 'bodyBytes' then
			raise exception 'Company skill load content differs' using errcode = '22023'; end if;
		perform public.qorpera_company_path_remember_read(v_actor,v_source ->> 'path');
	elsif v_reference ->> 'kind' = 'platform' then
		if not public.qorpera_company_knowledge_closed(v_reference,array['kind','id'])
			or not public.qorpera_company_knowledge_closed(v_source,array['kind','runtimeBundleVersion','path','version','scope','trust','authority'])
			or v_source ->> 'kind' is distinct from 'runtime_bundle' or v_source -> 'runtimeBundleVersion' is distinct from v_run -> 'runtimeBundleVersion'
			or v_source ->> 'path' is distinct from 'skills/' || (v_reference ->> 'id')
			or v_source -> 'scope' is distinct from '{"kind":"platform"}'::jsonb then
			raise exception 'Platform skill source is invalid' using errcode = '22023'; end if;
	else raise exception 'Company skill reference is invalid' using errcode = '22023'; end if;
	v_key := encode(extensions.digest(convert_to(array_to_string(array['qorpera.skill-load/v1',v_run ->> 'companyId',
		v_run ->> 'environmentId',v_run ->> 'runId',v_run ->> 'runtimeBundleVersion',v_reference ->> 'kind',
		coalesce(v_reference ->> 'collectionId',''),v_reference ->> 'id',v_source ->> 'version',p_record ->> 'bodySha256'],E'\n'),'utf8'),'sha256'),'hex');
	if v_key <> p_record ->> 'loadKey' then raise exception 'Company skill load key differs' using errcode = '22023'; end if;
	if exists (select 1 from public.qorpera_execution_run_events where run_id = (v_actor ->> 'runId')::uuid and event_type = 'skill_loaded'
		and payload #> '{run,runtimeBundleVersion}' is distinct from v_run -> 'runtimeBundleVersion') then
		raise exception 'Recorded runtime bundle version changed' using errcode = '40001'; end if;
	select payload into v_existing from public.qorpera_execution_run_events
	where run_id = (v_actor ->> 'runId')::uuid and event_type = 'skill_loaded' and payload ->> 'loadKey' = v_key;
	if found then
		if v_existing <> p_record then raise exception 'Company skill load record differs' using errcode = '23505'; end if;
	elsif p_assert_only then
		raise exception 'Company skill load was not durably recorded' using errcode = '55000';
	else
		if (select count(*) from public.qorpera_execution_run_events where run_id = (v_actor ->> 'runId')::uuid and event_type = 'skill_loaded') >= 64 then
			raise exception 'Company skill load record bound exceeded' using errcode = '54000'; end if;
		insert into public.qorpera_execution_run_events(run_id,event_type,payload) values ((v_actor ->> 'runId')::uuid,'skill_loaded',p_record);
	end if;
	perform public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_company_path_assert_context(v_actor);
end
$$;

create function public.qorpera_record_company_skill_load(p_environment_id uuid,p_binding jsonb,p_record jsonb)
returns void language sql security definer set search_path = '' as $$
	select public.qorpera_company_skill_load(p_environment_id,p_binding,p_record,false)
$$;
create function public.qorpera_assert_company_skill_load(p_environment_id uuid,p_binding jsonb,p_record jsonb)
returns void language sql security definer set search_path = '' as $$
	select public.qorpera_company_skill_load(p_environment_id,p_binding,p_record,true)
$$;

revoke all on function public.qorpera_company_knowledge_closed(jsonb,text[]),
	public.qorpera_company_knowledge_retention_policy_valid(jsonb),
	public.qorpera_company_knowledge_text(jsonb,integer,boolean),public.qorpera_company_knowledge_metadata(text,text),
	public.qorpera_verify_company_knowledge_file(uuid,text,text,text),public.qorpera_company_knowledge_entry(uuid,jsonb),
	public.qorpera_set_company_knowledge_schema(uuid,text,text,uuid,jsonb),
	public.qorpera_company_knowledge_retention_policy(uuid,text,jsonb),
	public.qorpera_company_knowledge_history_entry(uuid,text,jsonb),public.qorpera_company_knowledge_preserve_revision(),
	public.qorpera_company_retained_extras_before_knowledge(uuid),public.qorpera_company_additional_retained_object_hashes(uuid),
	public.qorpera_company_path_plan_before_knowledge(jsonb,jsonb,boolean,boolean),
	public.qorpera_company_path_plan(jsonb,jsonb,boolean,boolean),public.qorpera_enforce_company_knowledge_entry(),
	public.qorpera_company_knowledge_collection(jsonb,jsonb),public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[],jsonb),
	public.qorpera_company_skill_load(uuid,jsonb,jsonb,boolean),public.qorpera_record_company_skill_load(uuid,jsonb,jsonb),
	public.qorpera_assert_company_skill_load(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_set_company_knowledge_schema(uuid,text,text,uuid,jsonb) to authenticated;
grant execute on function public.qorpera_verify_company_knowledge_file(uuid,text,text,text),
	public.qorpera_retain_company_path_sources(uuid,jsonb,text[],jsonb,text[],jsonb),
	public.qorpera_record_company_skill_load(uuid,jsonb,jsonb),public.qorpera_assert_company_skill_load(uuid,jsonb,jsonb) to service_role;
