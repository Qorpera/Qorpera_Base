-- Company folder core, C1d-1a: the byte path (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md).
--
-- A folder-v2 actor stages bytes under an upload intent and reads them back, and the commit locks every object it
-- newly references (core §2, §7, §8, §9). No step takes the profile row FOR UPDATE, the folder fence, company_files or
-- the job. An actor references only bytes it possesses: bytes it put, or bytes it may already read (C1D §3). Changes
-- only folder-v2 behaviour: each snapshot-v1 function touched here gets one folder-v2 line after its "begin", and the
-- definition it was written against is pinned by digest first. No real folder-v2 company exists before C1c-3, and
-- nothing calls the new entry points until C1d-1b's gateway route and runtime adapter.

-- The scheduler and wake admission never queue behind this migration's table locks.
set local lock_timeout = '3s';

-- 0. The snapshot-v1 definitions this was reviewed against --------------------------------------------------------

do $guard$
declare v_check record;
begin
	for v_check in select * from (values
		('public.qorpera_enforce_company_storage_quota()', '339d3122eed3d8f154b6a671a836dd074aaa9a6b07c47e42998fd8003c58eb59'),
		('public.qorpera_refresh_company_storage_usage()', 'f70353b583f7cf6853f57331bc9fa897eaa96251d13eb3d120838522965b5075'),
		('public.qorpera_authorize_profile_object_replication(uuid,text,bigint)',
			'483143cc9ae9e1d4b3c7eec128b047f99161632303f628df572ddc2060961beb'),
		('public.qorpera_confirm_profile_object_upload(uuid,text,bigint,text)',
			'e97bb1724e5235cd41d1f2ed6af295f17765d7ab4e87e8ad98262303714e0059')) c(target, digest)
	loop
		if encode(extensions.digest(pg_get_functiondef(v_check.target::regprocedure), 'sha256'), 'hex') <> v_check.digest then
			raise exception 'Reviewed function definition changed: %', v_check.target;
		end if;
	end loop;
end
$guard$;

-- 1. Tables -----------------------------------------------------------------------------------------------------------

-- A file a folder actor is staging (C1D §2). The actor is its kind and its scope: the run, the view, the member, or
-- the platform (a nil scope). A view's pass is never stored. Open or sealed and unexpired, an intent is a root of its
-- objects (C1d-2). Both links cascade from the company, so its purge removes these (test 715); the environment's is
-- to its folder clock, not to company_files, which no folder-v2 path locks (core §9).
create table public.qorpera_folder_upload_intents (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	actor_kind text not null check (actor_kind in ('run','view','member','platform')),
	scope_id uuid not null,
	manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	manifest_text text not null check (octet_length(manifest_text) between 1 and 32768),
	file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 268435456),
	media_type text not null check (media_type ~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'),
	executable boolean not null,
	state text not null default 'open' check (state in ('open','sealed')),
	expires_at timestamptz not null,
	created_at timestamptz not null default clock_timestamp(),
	sealed_at timestamptz,
	check ((state = 'sealed') = (sealed_at is not null))
);
create index qorpera_folder_upload_intents_profile on public.qorpera_folder_upload_intents(profile_id, expires_at);
-- The commit finds the actor's own sealed intent for a manifest.
create index qorpera_folder_upload_intents_manifest on public.qorpera_folder_upload_intents(environment_id, manifest_sha256);

-- The manifest and each chunk an intent lists, and how the actor holds each: `held`, the actor could already read it
-- when it opened the intent; `put`, the actor put its bytes under this intent (the gateway checked their hash). Seal
-- counts no other object, so an intent never vouches for bytes its actor does not possess. A chunk's put is
-- authorized by its row here alone (core §7), and GC's root check finds open intents by hash (C1d-2).
create table public.qorpera_folder_upload_intent_objects (
	intent_id uuid not null references public.qorpera_folder_upload_intents(id) on delete cascade,
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	bytes bigint not null check (bytes between 0 and 8388608),
	profile_id uuid not null,
	held boolean not null default false,
	put boolean not null default false,
	primary key (intent_id, sha256)
);
create index qorpera_folder_upload_intent_objects_hash on public.qorpera_folder_upload_intent_objects(profile_id, sha256);

-- Which version-2 manifests contain a chunk, for the download check's one indexed step (C1D §7). The company's own
-- row too, so the company purge (which follows foreign keys from qorpera_profiles) removes these with it.
create table public.qorpera_folder_file_chunks (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	chunk_sha256 text not null check (chunk_sha256 ~ '^[0-9a-f]{64}$'),
	manifest_sha256 text not null,
	primary key (profile_id, chunk_sha256, manifest_sha256),
	foreign key (profile_id, manifest_sha256) references public.qorpera_profile_objects(profile_id, sha256) on delete cascade
);

-- A folder-v2 company's stored bytes (core §2). Only the catalog trigger writes it (§5 below), with one atomic update
-- per object added or removed, seeding itself from the catalog the first time; no effect, commit or fence takes it.
create table public.qorpera_folder_storage_usage (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	bytes bigint not null default 0,
	objects bigint not null default 0,
	updated_at timestamptz not null default clock_timestamp()
);

-- The download check finds the entries and path versions of a manifest.
create index qorpera_folder_entries_manifest on public.qorpera_folder_entries(environment_id, manifest_sha256)
	where kind = 'file';
create index qorpera_folder_path_versions_manifest on public.qorpera_folder_path_versions(environment_id, manifest_sha256)
	where manifest_sha256 is not null;

alter table public.qorpera_folder_upload_intents enable row level security;
alter table public.qorpera_folder_upload_intent_objects enable row level security;
alter table public.qorpera_folder_file_chunks enable row level security;
alter table public.qorpera_folder_storage_usage enable row level security;
revoke all on public.qorpera_folder_upload_intents, public.qorpera_folder_upload_intent_objects,
	public.qorpera_folder_file_chunks, public.qorpera_folder_storage_usage from anon, authenticated;

-- 2. Proofs, version 2 ---------------------------------------------------------------------------------------------

-- A version-2 manifest carries the media type and the executable bit (core §7), and so does its proof. Version 1
-- (octet-stream, no bit) stays exactly as it is. The old checks and the new null column already hold for every row, so
-- the new check is not validated here (no scan under the table lock).
alter table public.qorpera_verified_company_file_objects add column executable boolean;
alter table public.qorpera_verified_company_file_objects
	drop constraint qorpera_verified_company_file_objects_verifier_version_check,
	drop constraint qorpera_verified_company_file_objects_media_type_check,
	add constraint qorpera_verified_company_file_objects_version_check check (
		(verifier_version = 1 and media_type = 'application/octet-stream' and executable is null)
		or (verifier_version = 2 and media_type ~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
			and executable is not null)) not valid;

-- 3. Helpers ---------------------------------------------------------------------------------------------------------

-- A version-2 manifest (C1D §2), checked, or null: {schema, fileSha256, bytes, mediaType, executable, chunks}, in that
-- key order with no spaces (so one file, media type and bit have one manifest hash), at most 64 chunks of 1 byte to
-- 4 MiB whose sizes add up to the file's (256 MiB), each hash with one size.
create function public.qorpera_folder_manifest(p_text text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v jsonb;
begin
	if p_text is null or octet_length(p_text) not between 1 and 32768 then return null; end if;
	begin
		v := p_text::jsonb;
	exception when others then
		return null;
	end;
	if jsonb_typeof(v) is distinct from 'object'
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(v) k)
			is distinct from array['bytes','chunks','executable','fileSha256','mediaType','schema']
		or v ->> 'schema' is distinct from 'qorpera.cloud-file-manifest/v2'
		or coalesce(v ->> 'fileSha256', '') !~ '^[0-9a-f]{64}$'
		or jsonb_typeof(v -> 'bytes') is distinct from 'number' or (v ->> 'bytes') !~ '^[0-9]{1,9}$'
		or (v ->> 'bytes')::bigint > 268435456
		or coalesce(v ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
		or jsonb_typeof(v -> 'executable') is distinct from 'boolean'
		or jsonb_typeof(v -> 'chunks') is distinct from 'array' or jsonb_array_length(v -> 'chunks') > 64
		or exists (select 1 from jsonb_array_elements(v -> 'chunks') c
			where jsonb_typeof(c) is distinct from 'object'
				or (select array_agg(k order by k collate "C") from jsonb_object_keys(c) k) is distinct from array['bytes','sha256']
				or coalesce(c ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
				or jsonb_typeof(c -> 'bytes') is distinct from 'number' or (c ->> 'bytes') !~ '^[0-9]{1,7}$'
				or (c ->> 'bytes')::bigint not between 1 and 4194304)
		or (select coalesce(sum((c ->> 'bytes')::bigint), 0) from jsonb_array_elements(v -> 'chunks') c) <> (v ->> 'bytes')::bigint
		or exists (select 1 from jsonb_array_elements(v -> 'chunks') c group by c ->> 'sha256'
			having count(distinct c ->> 'bytes') > 1) then
		return null;
	end if;
	-- The canonical text: the one spelling the runtime writes. (The media type's characters need no JSON escaping.)
	if p_text <> format('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"%s","bytes":%s,"mediaType":"%s","executable":%s,"chunks":[%s]}',
		v ->> 'fileSha256', v ->> 'bytes', v ->> 'mediaType', v ->> 'executable',
		coalesce((select string_agg(format('{"sha256":"%s","bytes":%s}', c.value ->> 'sha256', c.value ->> 'bytes'), ',' order by c.ordinality)
			from jsonb_array_elements(v -> 'chunks') with ordinality c), '')) then
		return null;
	end if;
	return v;
end $$;

-- The scope an actor stages under: its run, view or member, or the platform's nil scope; null for anything else.
create function public.qorpera_folder_upload_scope(p_actor jsonb)
returns uuid language sql immutable set search_path = '' as $$
	select case p_actor ->> 'kind'
		when 'run' then case when coalesce(p_actor ->> 'runId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then (p_actor ->> 'runId')::uuid end
		when 'view' then case when coalesce(p_actor ->> 'viewId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then (p_actor ->> 'viewId')::uuid end
		when 'member' then case when coalesce(p_actor ->> 'userId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			then (p_actor ->> 'userId')::uuid end
		when 'platform' then '00000000-0000-0000-0000-000000000000'::uuid
	end
$$;

-- An actor's check for staging (p_stop) and for downloads (C1D §3, §7): the company is folder-v2 and not being
-- deleted, the actor's plain check (qorpera_folder_read_actor: no job or fence lock; it refuses a paused company's
-- runs, as reads do), and a member's membership, which read_actor does not check. Staging also refuses once the
-- company's work is stopped (paused or being deleted), for every actor; a pause alone leaves downloads to reads' rule
-- (F1, #558). Returns {profileId, kind, scopeId, auth} (auth: read_actor's, null for the platform). Plain reads only.
create function public.qorpera_folder_upload_actor(p_environment_id uuid, p_actor jsonb, p_stop boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile uuid; v_scope uuid := public.qorpera_folder_upload_scope(p_actor); v_auth jsonb;
begin
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_stop and public.qorpera_company_execution_paused(v_profile) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	if exists (select 1 from public.qorpera_company_deletions where profile_id = v_profile) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
	if v_scope is null then raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	v_auth := public.qorpera_folder_read_actor(p_environment_id, p_actor);
	if p_actor ->> 'kind' = 'member' and not exists (select 1 from public.qorpera_profile_members
		where profile_id = v_profile and user_id = v_scope) then
		raise exception 'Company membership is required' using errcode = '42501'; end if;
	return jsonb_build_object('profileId', v_profile, 'kind', p_actor ->> 'kind', 'scopeId', v_scope, 'auth', v_auth);
end $$;

-- Whether an actor (not the platform, which reads everything) may read a hash in an environment: an entry or path
-- version of this environment has it as its manifest, or as a chunk of its version-2 manifest, and the actor may read
-- that path now (current authority, an old version too). One statement, no locks.
create function public.qorpera_folder_object_readable(p_environment_id uuid, p_profile_id uuid, p_auth jsonb, p_sha256 text)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from (select p_sha256 as manifest
			union all
			select c.manifest_sha256 from public.qorpera_folder_file_chunks c
			where c.profile_id = p_profile_id and c.chunk_sha256 = p_sha256) m
		cross join lateral (
			select e.path from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind = 'file' and e.manifest_sha256 = m.manifest
			union all
			select v.path from public.qorpera_folder_path_versions v
			where v.environment_id = p_environment_id and v.manifest_sha256 = m.manifest) p
		where public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_auth, p.path, 'read'))
$$;

-- 4. Staging ---------------------------------------------------------------------------------------------------------

-- Opens a staging intent for one file (C1D §3.1). `present` lists the objects the catalog already has that the actor
-- may already read (the platform: all), taken FOR KEY SHARE in hash order (G1) and marked held; the writer puts every
-- other one, which proves it has the bytes. So an intent is no oracle of what the company stores.
create function public.qorpera_folder_open_upload(p_environment_id uuid, p_actor jsonb, p_manifest text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_profile uuid; v_manifest jsonb; v_intent public.qorpera_folder_upload_intents%rowtype; v_present jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, true);
	v_profile := (v_actor ->> 'profileId')::uuid;
	v_manifest := public.qorpera_folder_manifest(p_manifest);
	if v_manifest is null then raise exception 'Upload manifest is invalid' using errcode = '22023'; end if;
	insert into public.qorpera_folder_upload_intents(environment_id, profile_id, actor_kind, scope_id, manifest_sha256,
		manifest_text, file_sha256, bytes, media_type, executable, expires_at)
	values (p_environment_id, v_profile, v_actor ->> 'kind', (v_actor ->> 'scopeId')::uuid,
		encode(extensions.digest(convert_to(p_manifest, 'utf8'), 'sha256'), 'hex'), p_manifest, v_manifest ->> 'fileSha256',
		(v_manifest ->> 'bytes')::bigint, v_manifest ->> 'mediaType', (v_manifest ->> 'executable')::boolean,
		clock_timestamp() + interval '15 minutes')
	returning * into v_intent;
	insert into public.qorpera_folder_upload_intent_objects(intent_id, sha256, bytes, profile_id)
	select v_intent.id, v_intent.manifest_sha256, octet_length(convert_to(p_manifest, 'utf8')), v_profile
	union
	select v_intent.id, c ->> 'sha256', (c ->> 'bytes')::bigint, v_profile from jsonb_array_elements(v_manifest -> 'chunks') c
	on conflict do nothing;
	select coalesce(jsonb_agg(p.sha256 order by p.sha256 collate "C"), '[]'::jsonb) into v_present from (
		select o.sha256 from public.qorpera_profile_objects o
		join public.qorpera_folder_upload_intent_objects i on i.intent_id = v_intent.id and i.sha256 = o.sha256 and i.bytes = o.bytes
		where o.profile_id = v_profile
			and (v_actor ->> 'kind' = 'platform'
				or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', o.sha256))
		order by o.sha256 collate "C" for key share of o) p;
	update public.qorpera_folder_upload_intent_objects set held = true
	where intent_id = v_intent.id and sha256 in (select jsonb_array_elements_text(v_present));
	return jsonb_build_object('schema', 'qorpera.folder-upload/v1', 'intentId', v_intent.id,
		'manifestSha256', v_intent.manifest_sha256, 'expiresAt', v_intent.expires_at, 'present', v_present);
end $$;

-- The intent an actor may put into: this environment's, this actor's own (kind and scope), open and unexpired, and the
-- company not stopped. Plain reads.
create function public.qorpera_folder_put_intent(p_environment_id uuid, p_actor jsonb, p_intent uuid)
returns public.qorpera_folder_upload_intents language plpgsql stable security definer set search_path = '' as $$
declare v_intent public.qorpera_folder_upload_intents%rowtype;
begin
	select * into v_intent from public.qorpera_folder_upload_intents where id = p_intent and environment_id = p_environment_id;
	if not found or v_intent.actor_kind is distinct from p_actor ->> 'kind'
		or v_intent.scope_id is distinct from public.qorpera_folder_upload_scope(p_actor)
		or v_intent.state <> 'open' or v_intent.expires_at <= clock_timestamp() then
		raise exception 'Upload intent is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_execution_paused(v_intent.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	return v_intent;
end $$;

-- Per chunk, before the gateway's NAS put (C1D §3.2): the intent and the object's row in it; no run check (core §7).
-- Returns the company, the object's place on the NAS.
create function public.qorpera_folder_authorize_object_upload(p_environment_id uuid, p_actor jsonb, p_intent uuid,
	p_sha256 text, p_bytes bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_intent public.qorpera_folder_upload_intents%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_intent := public.qorpera_folder_put_intent(p_environment_id, p_actor, p_intent);
	if not exists (select 1 from public.qorpera_folder_upload_intent_objects
		where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes) then
		raise exception 'Object is not part of this upload' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-object-upload/v1', 'profileId', v_intent.profile_id);
end $$;

-- After the gateway's NAS put, whose hash check proves the actor has the bytes (C1D §3.3): the same checks, the object
-- marked put, the soft quota (§5), then the catalog row, held KEY SHARE. A row already there with another size is
-- 23505, as today. The usage row, written by the catalog trigger, is the transaction's last lock.
create function public.qorpera_folder_confirm_object(p_environment_id uuid, p_actor jsonb, p_intent uuid, p_sha256 text,
	p_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_bytes bigint; v_stored boolean;
begin
	v_profile := (public.qorpera_folder_authorize_object_upload(p_environment_id, p_actor, p_intent, p_sha256, p_bytes)
		->> 'profileId')::uuid;
	update public.qorpera_folder_upload_intent_objects set put = true
	where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes and not put;
	if not exists (select 1 from public.qorpera_profile_objects where profile_id = v_profile and sha256 = p_sha256) then
		perform public.qorpera_folder_storage_quota_check(v_profile, p_bytes);
	end if;
	insert into public.qorpera_profile_objects(profile_id, sha256, bytes, backend)
	values (v_profile, p_sha256, p_bytes, 'nas-object-gateway')
	on conflict (profile_id, sha256) do nothing;
	v_stored := found;
	select bytes into v_bytes from public.qorpera_profile_objects where profile_id = v_profile and sha256 = p_sha256 for key share;
	if v_bytes is distinct from p_bytes then
		raise exception 'object address is already bound to a different size' using errcode = '23505'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-object/v1', 'sha256', p_sha256, 'bytes', p_bytes, 'stored', v_stored);
end $$;

-- Seals an intent into the file's version-2 proof (C1D §3.4). The actor's check again, and the intent must be its own;
-- every listed object must be held or put by this intent, and in the catalog with its size, taken KEY SHARE in hash
-- order. Idempotent: sealing a sealed intent returns its file.
create function public.qorpera_folder_seal_upload(p_environment_id uuid, p_actor jsonb, p_intent uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_intent public.qorpera_folder_upload_intents%rowtype; v_missing jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, true);
	select * into v_intent from public.qorpera_folder_upload_intents where id = p_intent and environment_id = p_environment_id;
	if not found or v_intent.actor_kind is distinct from v_actor ->> 'kind'
		or v_intent.scope_id is distinct from (v_actor ->> 'scopeId')::uuid or v_intent.expires_at <= clock_timestamp() then
		raise exception 'Upload intent is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_objects o
	join public.qorpera_folder_upload_intent_objects i on i.intent_id = v_intent.id and i.sha256 = o.sha256 and i.bytes = o.bytes
		and (i.held or i.put)
	where o.profile_id = v_intent.profile_id order by o.sha256 collate "C" for key share of o;
	select coalesce(jsonb_agg(i.sha256 order by i.sha256 collate "C"), '[]'::jsonb) into v_missing
	from public.qorpera_folder_upload_intent_objects i
	where i.intent_id = v_intent.id and (not (i.held or i.put) or not exists (select 1 from public.qorpera_profile_objects o
		where o.profile_id = v_intent.profile_id and o.sha256 = i.sha256 and o.bytes = i.bytes));
	if jsonb_array_length(v_missing) > 0 then
		return jsonb_build_object('schema', 'qorpera.folder-seal/v1', 'state', 'incomplete', 'intentId', v_intent.id,
			'missing', v_missing);
	end if;
	insert into public.qorpera_verified_company_file_objects(profile_id, manifest_sha256, verifier_version, manifest_bytes,
		file_sha256, bytes, media_type, executable, objects)
	values (v_intent.profile_id, v_intent.manifest_sha256, 2, octet_length(convert_to(v_intent.manifest_text, 'utf8')),
		v_intent.file_sha256, v_intent.bytes, v_intent.media_type, v_intent.executable,
		(select jsonb_agg(jsonb_build_object('sha256', i.sha256, 'bytes', i.bytes) order by i.sha256 collate "C")
			from public.qorpera_folder_upload_intent_objects i where i.intent_id = v_intent.id))
	on conflict (profile_id, manifest_sha256, verifier_version) do nothing;
	insert into public.qorpera_folder_file_chunks(profile_id, chunk_sha256, manifest_sha256)
	select distinct v_intent.profile_id, c ->> 'sha256', v_intent.manifest_sha256
	from jsonb_array_elements(v_intent.manifest_text::jsonb -> 'chunks') c
	on conflict do nothing;
	if v_intent.state = 'open' then
		update public.qorpera_folder_upload_intents
		set state = 'sealed', sealed_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 hour'
		where id = v_intent.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.folder-seal/v1', 'state', 'sealed', 'intentId', v_intent.id,
		'file', jsonb_build_object('manifestSha256', v_intent.manifest_sha256, 'fileSha256', v_intent.file_sha256,
			'bytes', v_intent.bytes, 'mediaType', v_intent.media_type, 'executable', v_intent.executable));
end $$;

-- Extends an open intent by 15 minutes, a sealed one by an hour, from now (C1D §3.5).
create function public.qorpera_folder_renew_upload(p_environment_id uuid, p_actor jsonb, p_intent uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb; v_intent public.qorpera_folder_upload_intents%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, true);
	update public.qorpera_folder_upload_intents
	set expires_at = clock_timestamp() + case when state = 'open' then interval '15 minutes' else interval '1 hour' end
	where id = p_intent and environment_id = p_environment_id and actor_kind = v_actor ->> 'kind'
		and scope_id = (v_actor ->> 'scopeId')::uuid and expires_at > clock_timestamp()
	returning * into v_intent;
	if not found then raise exception 'Upload intent is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-upload-renew/v1', 'intentId', v_intent.id, 'state', v_intent.state,
		'expiresAt', v_intent.expires_at);
end $$;

-- 5. Usage and the soft quota -------------------------------------------------------------------------------------------

-- A folder-v2 company's quota, read plainly (C1D §5): uploads in flight at once can pass the limit by what they
-- carry, as F2-3's 48 KiB budget can. Raises 23514 when this object would pass it.
create function public.qorpera_folder_storage_quota_check(p_profile_id uuid, p_bytes bigint)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_limit bigint;
begin
	if public.qorpera_profile_storage_is_unlimited(p_profile_id) then return; end if;
	select min(storage_limit_bytes) into v_limit from public.qorpera_company_files where profile_id = p_profile_id;
	if v_limit is not null and coalesce((select bytes from public.qorpera_folder_storage_usage where profile_id = p_profile_id), 0)
		+ p_bytes > v_limit then
		raise exception 'company storage allowance exceeded' using errcode = '23514'; end if;
end $$;

-- The quota trigger's folder-v2 branch (on storage.objects): no fence, no company_files lock. True when it decided.
create function public.qorpera_folder_storage_quota(p_bucket_id text, p_name text, p_metadata jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_identity record; v_existing bigint;
begin
	select * into v_identity from public.qorpera_profile_object_identity(p_bucket_id, p_name, p_metadata);
	if v_identity.profile_id is null or v_identity.sha256 is null or v_identity.bytes is null
		or not public.qorpera_company_is_folder_v2(v_identity.profile_id) then
		return false;
	end if;
	select bytes into v_existing from public.qorpera_profile_objects
	where profile_id = v_identity.profile_id and sha256 = v_identity.sha256;
	if v_existing is null then perform public.qorpera_folder_storage_quota_check(v_identity.profile_id, v_identity.bytes); end if;
	return true;
end $$;

-- The usage trigger's folder-v2 branch (on profile_objects): one atomic update of the change, only when bytes or the
-- object count change. The first change after a company became folder-v2 seeds the row from the catalog without the
-- change itself (two first changes at once seed the same base, and each then adds its own). True when it decided.
create function public.qorpera_folder_storage_usage_changed(p_op text, p_old public.qorpera_profile_objects,
	p_new public.qorpera_profile_objects)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_profile uuid := case when p_op = 'DELETE' then p_old.profile_id else p_new.profile_id end;
	v_bytes bigint; v_objects bigint;
begin
	if not public.qorpera_company_is_folder_v2(v_profile)
		or (p_op = 'UPDATE' and p_old.profile_id is distinct from p_new.profile_id) then
		return false;
	end if;
	v_bytes := case p_op when 'INSERT' then p_new.bytes when 'DELETE' then -p_old.bytes else p_new.bytes - p_old.bytes end;
	v_objects := case p_op when 'INSERT' then 1 when 'DELETE' then -1 else 0 end;
	if v_bytes <> 0 or v_objects <> 0 then
		if not exists (select 1 from public.qorpera_folder_storage_usage where profile_id = v_profile) then
			insert into public.qorpera_folder_storage_usage(profile_id, bytes, objects)
			select v_profile, coalesce(sum(o.bytes), 0) - v_bytes, count(*) - v_objects
			from public.qorpera_profile_objects o where o.profile_id = v_profile
			on conflict (profile_id) do nothing;
		end if;
		update public.qorpera_folder_storage_usage
		set bytes = bytes + v_bytes, objects = objects + v_objects, updated_at = clock_timestamp()
		where profile_id = v_profile;
	end if;
	return true;
end $$;

-- 6. Replication of a folder-v2 object (C1D §6): the company row KEY SHARE and the object FOR NO KEY UPDATE, the
-- strongest mode its callers need (the replica confirm's update and the mirror trigger's upsert), so no caller
-- strengthens a lock it holds; no fence and no deletion gate (C1d-2's GC needs none).
create function public.qorpera_folder_authorize_replication(p_profile_id uuid, p_sha256 text, p_bytes bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
		or p_bytes is null or p_bytes not between 0 and 8388608 then
		raise exception 'replication authority is invalid' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for key share;
	if not found then raise exception 'replication company is unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_objects
	where profile_id = p_profile_id and sha256 = p_sha256 and bytes = p_bytes for no key update;
	if not found then raise exception 'replication object is unavailable' using errcode = '42501'; end if;
	return true;
end $$;

-- 7. The download check (C1D §7) -------------------------------------------------------------------------------------

-- Whether an actor may fetch a hash: the platform any stored object of the company; anyone else an object an entry or
-- path version it may read references (qorpera_folder_object_readable). No locks. A paused company's runs are refused
-- by their read check, as reads are; members and the platform may still read. The bytes never form a read set:
-- receipts come from qorpera_folder_read.
create function public.qorpera_folder_authorize_object_download(p_environment_id uuid, p_actor jsonb, p_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb; v_profile uuid; v_bytes bigint;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Object hash is invalid' using errcode = '22023'; end if;
	v_actor := public.qorpera_folder_upload_actor(p_environment_id, p_actor, false);
	v_profile := (v_actor ->> 'profileId')::uuid;
	select o.bytes into v_bytes from public.qorpera_profile_objects o
	where o.profile_id = v_profile and o.sha256 = p_sha256
		and (v_actor ->> 'kind' = 'platform'
			or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', p_sha256));
	if v_bytes is null then raise exception 'Object is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.folder-object-download/v1', 'profileId', v_profile, 'bytes', v_bytes);
end $$;

-- 8. Commit step 6 (C1D §4) ------------------------------------------------------------------------------------------

-- Every object a change set newly references: each written or new file's manifest and each file a copy's source
-- holds (a copy over the core's subtree bound adds none: step 7 refuses it as too_large), with every object of their
-- proofs' closures (manifest and chunks). Copy sources are found by the key index: the entry itself, then its subtree
-- as a key range ('0' follows '/' in the "C" order of key_text).
create function public.qorpera_folder_unit_objects(p_environment_id uuid, p_profile_id uuid, p_units jsonb)
returns setof text language sql stable security definer set search_path = '' as $$
	with copies as materialized (
		select public.qorpera_folder_key(u ->> 'from') as k from jsonb_array_elements(p_units) u where u ->> 'op' = 'copy'
	), sources as (
		select c.k from copies c
		where (select count(*) from (select 1 from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.key_text > c.k || '/' and e.key_text < c.k || '0' limit 50001) s) <= 50000
	), manifests as (
		select u -> 'file' ->> 'manifestSha256' as manifest from jsonb_array_elements(p_units) u where u ->> 'op' = 'write'
		union
		select c -> 'file' ->> 'manifestSha256' from jsonb_array_elements(p_units) u
		cross join jsonb_array_elements(case when u ->> 'op' = 'new_folder' and jsonb_typeof(u -> 'contents') = 'array'
			then u -> 'contents' else '[]'::jsonb end) c
		where c ->> 'kind' = 'file'
		union
		select e.manifest_sha256 from sources s join public.qorpera_folder_entries e
			on e.environment_id = p_environment_id and e.kind = 'file' and e.key_text = s.k
		union
		select e.manifest_sha256 from sources s join public.qorpera_folder_entries e
			on e.environment_id = p_environment_id and e.kind = 'file' and e.key_text > s.k || '/' and e.key_text < s.k || '0'
	)
	select manifest from manifests where manifest is not null
	union
	select o ->> 'sha256' from manifests m
	join public.qorpera_verified_company_file_objects v on v.profile_id = p_profile_id and v.manifest_sha256 = m.manifest
	cross join jsonb_array_elements(v.objects) o
$$;

-- A file reference's bytes, for a write or a new folder's file: null when they hold, else 'bytes_unverified'.
-- * The proof matches (manifest, file, size). A version-2 proof's media type and executable bit must equal the
--   reference's, or the change set is malformed (22023): an entry never disagrees with its bytes.
-- * Every object of the closure is in the catalog with its size, and among the objects step 6 locked (p_locked), so
--   the unit is decided from locked rows only (core §3 step 7).
-- * Possession (C1D §3): an actor other than the platform references a version-2 file only if it sealed it itself (an
--   unexpired sealed intent of the same kind and scope in this environment) or may already read it. A version-1 proof
--   (verify_company_path_file; the SQL fixtures until C5, and nothing in production for folder-v2) is not held to it.
create function public.qorpera_folder_file_bytes_problem(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_auth jsonb,
	p_file jsonb, p_locked text[])
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_proof public.qorpera_verified_company_file_objects%rowtype;
begin
	select * into v_proof from public.qorpera_verified_company_file_objects
	where profile_id = p_profile_id and manifest_sha256 = p_file ->> 'manifestSha256' and file_sha256 = p_file ->> 'fileSha256'
		and bytes = (p_file ->> 'bytes')::bigint
	order by verifier_version desc limit 1;
	if not found then return 'bytes_unverified'; end if;
	if v_proof.verifier_version = 2 and (v_proof.media_type is distinct from p_file ->> 'mediaType'
		or v_proof.executable is distinct from (p_file ->> 'executable')::boolean) then
		raise exception 'File reference does not match its manifest' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_array_elements(v_proof.objects) o
		where not (o ->> 'sha256' = any (p_locked))
			or not exists (select 1 from public.qorpera_profile_objects s
				where s.profile_id = p_profile_id and s.sha256 = o ->> 'sha256' and s.bytes = (o ->> 'bytes')::bigint)) then
		return 'bytes_unverified'; end if;
	if v_proof.verifier_version = 2 and p_actor ->> 'kind' is distinct from 'platform'
		and not exists (select 1 from public.qorpera_folder_upload_intents i
			where i.environment_id = p_environment_id and i.manifest_sha256 = v_proof.manifest_sha256 and i.state = 'sealed'
				and i.expires_at > clock_timestamp() and i.actor_kind = p_actor ->> 'kind'
				and i.scope_id = public.qorpera_folder_upload_scope(p_actor))
		and not public.qorpera_folder_object_readable(p_environment_id, p_profile_id, p_auth, v_proof.manifest_sha256) then
		return 'bytes_unverified'; end if;
	return null;
end $$;

-- 9. Patches ---------------------------------------------------------------------------------------------------------

-- Inserts one statement at the start of a PL/pgSQL body, after its first line that is only "begin". The statement
-- must not be there yet.
create function pg_temp.c1d_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1d guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1d guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1d guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
-- Replaces exact text of a definition, exactly once.
create function pg_temp.c1d_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'C1d patch anchor not found exactly once in %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
declare
	-- The commit by name: C1c-2b gives it a receipt argument (#554), and whichever of the two lands first, there is one.
	v_commit regprocedure;
begin
	if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit') <> 1 then
		raise exception 'C1d expects exactly one qorpera_folder_commit'; end if;
	select oid::regprocedure into v_commit from pg_proc
	where pronamespace = 'public'::regnamespace and proname = 'qorpera_folder_commit';

	-- Usage and the quota (C1D §5).
	perform pg_temp.c1d_guard('public.qorpera_enforce_company_storage_quota()',
		'if public.qorpera_folder_storage_quota(new.bucket_id, new.name, new.metadata) then return new; end if;');
	perform pg_temp.c1d_guard('public.qorpera_refresh_company_storage_usage()',
		'if public.qorpera_folder_storage_usage_changed(tg_op, old, new) then return case when tg_op = ''DELETE'' then old else new end; end if;');
	-- Replication, and the old catalog insert (C1D §6).
	perform pg_temp.c1d_guard('public.qorpera_authorize_profile_object_replication(uuid,text,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) then return public.qorpera_folder_authorize_replication(p_profile_id, p_sha256, p_bytes); end if;');
	perform pg_temp.c1d_guard('public.qorpera_confirm_profile_object_upload(uuid,text,bigint,text)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;');

	-- Commit step 6 (C1D §4). The objects it locks, kept for the decision.
	perform pg_temp.c1d_replace(v_commit,
		E'v_lock record; v_invalid boolean;',
		E'v_lock record; v_invalid boolean; v_objects text[];');
	-- The objects, after the paths and before the commit row.
	perform pg_temp.c1d_replace(v_commit,
		E'\t-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.\n',
		E'\t-- Step 6. Objects (core §3, C1D §4): the manifest and every chunk of each file a write, a new folder or a copy\n'
		|| E'\t-- newly references, FOR KEY SHARE in one hash order. A unit whose objects are not all among them is refused below.\n'
		|| E'\tselect coalesce(array_agg(s.sha256), ''{}'') into v_objects from (\n'
		|| E'\t\tselect o.sha256 from public.qorpera_profile_objects o\n'
		|| E'\t\twhere o.profile_id = v_file.profile_id\n'
		|| E'\t\t\tand o.sha256 in (select public.qorpera_folder_unit_objects(p_environment_id, v_file.profile_id, p_units))\n'
		|| E'\t\torder by o.sha256 collate "C" for key share) s;\n\n'
		|| E'\t-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.\n');
	-- A new folder's files.
	perform pg_temp.c1d_replace(v_commit,
		E'\t\t\telsif exists (select 1 from jsonb_array_elements(v_unit -> ''contents'') c where c.value ->> ''kind'' = ''file''\n'
		|| E'\t\t\t\tand not exists (select 1 from public.qorpera_verified_company_file_objects v\n'
		|| E'\t\t\t\t\twhere v.profile_id = v_file.profile_id and v.manifest_sha256 = c.value -> ''file'' ->> ''manifestSha256''\n'
		|| E'\t\t\t\t\t\tand v.file_sha256 = c.value -> ''file'' ->> ''fileSha256''\n'
		|| E'\t\t\t\t\t\tand v.bytes = (c.value -> ''file'' ->> ''bytes'')::bigint)) then\n',
		E'\t\t\telsif exists (select 1 from jsonb_array_elements(v_unit -> ''contents'') c where c.value ->> ''kind'' = ''file''\n'
		|| E'\t\t\t\tand public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\t\tc.value -> ''file'', v_objects) is not null) then\n');
	perform pg_temp.c1d_replace(v_commit,
		E'\t\t-- Bytes (step 6): a written file must be verified content of this company. Its manifest object is held\n'
		|| E'\t\t-- KEY SHARE; the full reference invariants of core §8 arrive with C1d.\n',
		E'\t\t-- Bytes: a written file must be verified content of this company that its actor holds, with every object of\n'
		|| E'\t\t-- its proof in the catalog and locked by step 6 (C1D §4). A copy''s files likewise.\n');
	-- A write's file, then a copy's files.
	perform pg_temp.c1d_replace(v_commit,
		E'\t\t\telsif not exists (select 1 from public.qorpera_verified_company_file_objects\n'
		|| E'\t\t\t\twhere profile_id = v_file.profile_id and manifest_sha256 = v_file_json ->> ''manifestSha256''\n'
		|| E'\t\t\t\t\tand file_sha256 = v_file_json ->> ''fileSha256'' and bytes = (v_file_json ->> ''bytes'')::bigint) then\n'
		|| E'\t\t\t\tv_ok := false; v_reason := ''bytes_unverified'';\n'
		|| E'\t\t\telse\n'
		|| E'\t\t\t\tperform 1 from public.qorpera_profile_objects o where o.profile_id = v_file.profile_id\n'
		|| E'\t\t\t\t\tand o.sha256 = v_file_json ->> ''manifestSha256'' for key share;\n'
		|| E'\t\t\t\tif not found then v_ok := false; v_reason := ''bytes_unverified''; end if;\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\tend if;\n',
		E'\t\t\telsif public.qorpera_folder_file_bytes_problem(p_environment_id, v_file.profile_id, p_actor, v_auth_actor,\n'
		|| E'\t\t\t\tv_file_json, v_objects) is not null then\n'
		|| E'\t\t\t\tv_ok := false; v_reason := ''bytes_unverified'';\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\tend if;\n'
		|| E'\t\tif v_ok and v_op = ''copy'' and exists (select 1\n'
		|| E'\t\t\tfrom public.qorpera_folder_unit_objects(p_environment_id, v_file.profile_id, jsonb_build_array(v_unit)) h\n'
		|| E'\t\t\twhere not (h = any (v_objects))) then\n'
		|| E'\t\t\tv_ok := false; v_reason := ''bytes_unverified'';\n'
		|| E'\t\tend if;\n');
end $$;

-- 10. Grants ---------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_manifest(text), public.qorpera_folder_upload_scope(jsonb),
	public.qorpera_folder_upload_actor(uuid, jsonb, boolean), public.qorpera_folder_object_readable(uuid, uuid, jsonb, text),
	public.qorpera_folder_put_intent(uuid, jsonb, uuid),
	public.qorpera_folder_storage_quota_check(uuid, bigint), public.qorpera_folder_storage_quota(text, text, jsonb),
	public.qorpera_folder_storage_usage_changed(text, public.qorpera_profile_objects, public.qorpera_profile_objects),
	public.qorpera_folder_authorize_replication(uuid, text, bigint),
	public.qorpera_folder_unit_objects(uuid, uuid, jsonb),
	public.qorpera_folder_file_bytes_problem(uuid, uuid, jsonb, jsonb, jsonb, text[])
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_open_upload(uuid, jsonb, text),
	public.qorpera_folder_authorize_object_upload(uuid, jsonb, uuid, text, bigint),
	public.qorpera_folder_confirm_object(uuid, jsonb, uuid, text, bigint), public.qorpera_folder_seal_upload(uuid, jsonb, uuid),
	public.qorpera_folder_renew_upload(uuid, jsonb, uuid), public.qorpera_folder_authorize_object_download(uuid, jsonb, text)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_open_upload(uuid, jsonb, text),
	public.qorpera_folder_authorize_object_upload(uuid, jsonb, uuid, text, bigint),
	public.qorpera_folder_confirm_object(uuid, jsonb, uuid, text, bigint), public.qorpera_folder_seal_upload(uuid, jsonb, uuid),
	public.qorpera_folder_renew_upload(uuid, jsonb, uuid), public.qorpera_folder_authorize_object_download(uuid, jsonb, text)
	to service_role;
