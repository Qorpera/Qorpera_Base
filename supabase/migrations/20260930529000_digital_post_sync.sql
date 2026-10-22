-- Digital Post in the company folder, part 2 (deploy/first-node/RUNTIME-DIGITAL-POST.md): the company vault fetches
-- each connected company's Digital Post letters and keeps them here until the folder writer (part 3) puts them in
-- the company folder. A company connects Digital Post with a company secret, connector id 'digital_post', field
-- 'api_key': the API key Administrativ Adgang shows for the recipient system the member set up with Qorpera as its
-- supplier. This migration gives the vault its queue and its record:
--
-- - qorpera_digital_post_syncs: one row a company, following its Digital Post secret. A connect or a new key is due
--   at once; afterwards the row is due every ten minutes, at once again while letters wait beyond one list call.
--   A key Digital Post refuses stops it until the member connects again; a Disconnect stops it.
-- - qorpera_digital_post_letters: one row a letter, keyed by the sender's message id, so a letter Digital Post
--   delivers twice is kept once. 'staging' while its files are staged, 'kept' when all are (the vault sends the
--   business receipt only then: Digital Post deletes the letter after it), 'written' once the folder writer has
--   committed it (part 3). Its summary is what the Mailbox lists.
-- - qorpera_digital_post_chunks: the staged files' bytes, in 1 MiB chunks (each vault call stays small). The folder
--   writer deletes them once the letter is written.
-- - qorpera_digital_post_held: letters the vault could not read (malformed, too large). They are never receipted, so
--   Digital Post moves them to the company's mailbox on Virk after seven days; the vault skips them meanwhile.
--
-- Only the vault's own functions reach these tables (as the broker role, with the company's authority), except one
-- member read of the connection's state. Everything goes with the company when it is deleted.

create table public.qorpera_digital_post_syncs (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	secret_id uuid not null,
	secret_version bigint not null check (secret_version > 0),
	-- waiting: connected, not fetched yet; current: the last pass took every letter it found; failed: the last pass
	-- failed and is tried again; refused: Digital Post refused the key (connect again); disconnected.
	status text not null check (status in ('waiting', 'current', 'failed', 'refused', 'disconnected')),
	due_at timestamptz,
	lease_until timestamptz,
	-- The claim that holds the lease: a late answer from an earlier claim of the same version is refused.
	lease_id uuid,
	attempts integer not null default 0 check (attempts >= 0),
	last_error text check (last_error is null or char_length(last_error) between 1 and 300),
	-- The recipient system's id, from the key (not a secret): Settings shows it.
	system_id uuid,
	fetched_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	check ((status in ('refused', 'disconnected')) = (due_at is null))
);
create index qorpera_digital_post_syncs_due on public.qorpera_digital_post_syncs (due_at) where due_at is not null;
alter table public.qorpera_digital_post_syncs enable row level security;
revoke all on public.qorpera_digital_post_syncs from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_digital_post_letters (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	message_uuid uuid not null,
	-- Digital Post's own id for the letter, as last delivered.
	memo_id uuid not null,
	status text not null check (status in ('staging', 'kept', 'written')),
	folder text not null check (folder ~ '^digital-post/[0-9]{4}/[^/]+$' and public.qorpera_company_path_valid(folder)),
	summary jsonb not null check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 16384),
	-- [{name, mediaType, bytes, sha256}], letter.md and letter.json first.
	files jsonb not null check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) between 2 and 103),
	bytes bigint not null check (bytes between 0 and 50331648),
	received_at timestamptz not null default clock_timestamp(),
	kept_at timestamptz,
	receipted_at timestamptz,
	written_at timestamptz,
	unique (profile_id, message_uuid),
	check ((status = 'staging') = (kept_at is null)),
	check ((status = 'written') = (written_at is not null))
);
create unique index qorpera_digital_post_letters_folder
	on public.qorpera_digital_post_letters (profile_id, public.qorpera_folder_key(folder));
create index qorpera_digital_post_letters_kept
	on public.qorpera_digital_post_letters (kept_at) where status = 'kept';
alter table public.qorpera_digital_post_letters enable row level security;
revoke all on public.qorpera_digital_post_letters from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_digital_post_chunks (
	letter_id uuid not null references public.qorpera_digital_post_letters(id) on delete cascade,
	file_index integer not null check (file_index between 0 and 102),
	chunk_index integer not null check (chunk_index between 0 and 47),
	content bytea not null check (octet_length(content) between 1 and 1048576),
	primary key (letter_id, file_index, chunk_index)
);
alter table public.qorpera_digital_post_chunks enable row level security;
revoke all on public.qorpera_digital_post_chunks from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_digital_post_held (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	memo_id uuid not null,
	reason text not null check (char_length(reason) between 1 and 300),
	held_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, memo_id)
);
alter table public.qorpera_digital_post_held enable row level security;
revoke all on public.qorpera_digital_post_held from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The sync follows the company's Digital Post secret: a connect or a new key is due now; a Disconnect stops it. A
-- company has one recipient system, so one connection; connecting again replaces the key.
create function public.qorpera_digital_post_sync_follow_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if new.connector_id <> 'digital_post' or new.owner_kind <> 'company' then
		return new;
	end if;
	if new.status = 'active' then
		insert into public.qorpera_digital_post_syncs as sync
			(profile_id, environment_id, secret_id, secret_version, status, due_at)
		values (new.profile_id, new.environment_id, new.id, new.current_version, 'waiting', clock_timestamp())
		on conflict (profile_id) do update
		set environment_id = excluded.environment_id, secret_id = excluded.secret_id,
			secret_version = excluded.secret_version, status = 'waiting', due_at = clock_timestamp(),
			lease_until = null, lease_id = null, attempts = 0, last_error = null, system_id = null,
			updated_at = clock_timestamp()
		where sync.secret_id <> excluded.secret_id or sync.secret_version <> excluded.secret_version
			or sync.status in ('refused', 'disconnected');
	else
		update public.qorpera_digital_post_syncs
		set status = 'disconnected', due_at = null, lease_until = null, lease_id = null, updated_at = clock_timestamp()
		where profile_id = new.profile_id and secret_id = new.id;
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_digital_post_sync_follow_secret()
	from public, anon, authenticated, service_role, qorpera_secret_broker;
create trigger qorpera_digital_post_sync_follow_secret
	after insert or update of status, current_version on public.qorpera_cloud_secrets
	for each row execute function public.qorpera_digital_post_sync_follow_secret();

-- The company's authority, checked as every broker function checks it.
create function public.qorpera_digital_post_authority(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns public.qorpera_cloud_secret_broker_authorities
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	return v_authority;
end
$$;
revoke all on function public.qorpera_digital_post_authority(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The company's sync row, locked, when this claim (secret version and lease) still holds it.
create function public.qorpera_digital_post_leased(
	p_profile_id uuid,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid
)
returns public.qorpera_digital_post_syncs
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_sync public.qorpera_digital_post_syncs%rowtype;
begin
	select sync.* into v_sync
	from public.qorpera_digital_post_syncs as sync
	where sync.profile_id = p_profile_id
	for update;
	if v_sync.profile_id is null or v_sync.secret_id is distinct from p_secret_id
		or v_sync.secret_version is distinct from p_secret_version or v_sync.lease_id is distinct from p_lease_id
		or v_sync.lease_until is null or v_sync.lease_until <= clock_timestamp() then
		raise exception 'Digital Post sync is not leased' using errcode = '55000';
	end if;
	return v_sync;
end
$$;
revoke all on function public.qorpera_digital_post_leased(uuid, uuid, bigint, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The company's due sync, leased for fifteen minutes to this claim, with its sealed key and the letters held (not to
-- be fetched again): null when nothing is due. A secret no longer active, or sealed by another authority, stops the
-- sync here. Held letters older than eight days are forgotten: Digital Post moved them to Virk after seven.
create function public.qorpera_claim_digital_post_sync(p_broker_authority_id uuid, p_broker_capability_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row record;
	v_now timestamptz := clock_timestamp();
	v_lease uuid := extensions.gen_random_uuid();
	v_held jsonb;
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	select sync.secret_id, sync.secret_version, secret.status as secret_status, secret.current_version,
		secret.environment_id, version.key_id, version.encrypted_envelope, version.envelope_sha256,
		version.broker_authority_id as sealed_for
	into v_row
	from public.qorpera_digital_post_syncs as sync
	left join public.qorpera_cloud_secrets as secret on secret.id = sync.secret_id
	left join public.qorpera_cloud_secret_versions as version
		on version.secret_id = sync.secret_id and version.version = sync.secret_version
	where sync.profile_id = v_authority.profile_id and sync.due_at <= v_now
		and (sync.lease_until is null or sync.lease_until <= v_now)
	for update of sync skip locked;
	if not found then
		return null;
	end if;
	if v_row.secret_status is distinct from 'active' or v_row.current_version <> v_row.secret_version
		or v_row.encrypted_envelope is null or v_row.sealed_for <> v_authority.id then
		update public.qorpera_digital_post_syncs
		set status = 'disconnected', due_at = null, lease_until = null, lease_id = null, updated_at = v_now
		where profile_id = v_authority.profile_id;
		return null;
	end if;
	update public.qorpera_digital_post_syncs
	set lease_until = v_now + interval '15 minutes', lease_id = v_lease, attempts = attempts + 1, updated_at = v_now
	where profile_id = v_authority.profile_id;
	delete from public.qorpera_digital_post_held
	where profile_id = v_authority.profile_id and held_at < v_now - interval '8 days';
	select coalesce(jsonb_agg(held.memo_id order by held.memo_id), '[]'::jsonb) into v_held
	from (
		select memo_id from public.qorpera_digital_post_held
		where profile_id = v_authority.profile_id
		order by held_at desc
		limit 1000
	) as held;
	return jsonb_build_object(
		'schema', 'qorpera.digital-post-sync-claim/v1',
		'companyId', v_authority.profile_id, 'environmentId', v_row.environment_id,
		'secretId', v_row.secret_id, 'secretVersion', v_row.secret_version, 'lease', v_lease, 'keyId', v_row.key_id,
		-- Postgres breaks base64 lines at 76 characters; the claim carries one line.
		'encryptedEnvelopeBase64', translate(encode(v_row.encrypted_envelope, 'base64'), E'\n', ''),
		'envelopeSha256', v_row.envelope_sha256,
		'held', v_held
	);
end
$$;
revoke all on function public.qorpera_claim_digital_post_sync(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_digital_post_sync(uuid, text) to qorpera_secret_broker;

-- Whether a letter's summary has the shape the Mailbox and the folder's index read (digital-post-letter-files.ts,
-- DigitalPostLetterSummary).
create function public.qorpera_digital_post_summary_valid(p_summary jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select jsonb_typeof(p_summary) = 'object'
		and (select array_agg(key order by key) from jsonb_object_keys(p_summary) as key) = array[
			'caseId', 'created', 'files', 'folder', 'legalNotification', 'mandatory', 'messageUuid', 'received',
			'replyBy', 'sender', 'senderId', 'snippet', 'text', 'title']
		and coalesce(p_summary->>'messageUuid' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
		and jsonb_typeof(p_summary->'folder') = 'string'
		and jsonb_typeof(p_summary->'title') = 'string' and char_length(p_summary->>'title') between 1 and 2000
		and jsonb_typeof(p_summary->'sender') = 'string' and char_length(p_summary->>'sender') between 1 and 2000
		and jsonb_typeof(p_summary->'senderId') = 'string' and char_length(p_summary->>'senderId') between 1 and 2000
		and jsonb_typeof(p_summary->'created') = 'string' and char_length(p_summary->>'created') between 1 and 2000
		and jsonb_typeof(p_summary->'received') = 'string' and char_length(p_summary->>'received') between 1 and 64
		and jsonb_typeof(p_summary->'mandatory') = 'boolean'
		and jsonb_typeof(p_summary->'legalNotification') = 'boolean'
		and jsonb_typeof(p_summary->'text') = 'boolean'
		and jsonb_typeof(p_summary->'files') = 'number' and (p_summary->>'files') ~ '^[0-9]{1,3}$'
		and (jsonb_typeof(p_summary->'replyBy') = 'null'
			or (jsonb_typeof(p_summary->'replyBy') = 'string' and char_length(p_summary->>'replyBy') between 1 and 2000))
		and (jsonb_typeof(p_summary->'caseId') = 'null'
			or (jsonb_typeof(p_summary->'caseId') = 'string' and char_length(p_summary->>'caseId') between 1 and 2000))
		and (jsonb_typeof(p_summary->'snippet') = 'null'
			or (jsonb_typeof(p_summary->'snippet') = 'string' and char_length(p_summary->>'snippet') between 1 and 1000))
$$;
revoke all on function public.qorpera_digital_post_summary_valid(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- A letter the vault read and laid out, kept by its message id (this claim's lease only). The answer's state:
-- - 'staging': stage its files' chunks, then seal it. A letter left staging by an earlier pass starts again here.
-- - 'kept': the company already keeps it (Digital Post delivered it again): only the receipt is owed.
create function public.qorpera_keep_digital_post_letter(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_memo_id uuid,
	p_summary jsonb,
	p_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_sync public.qorpera_digital_post_syncs%rowtype;
	v_letter public.qorpera_digital_post_letters%rowtype;
	v_folder text := p_summary->>'folder';
	v_bytes bigint;
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_memo_id is null or not coalesce(public.qorpera_digital_post_summary_valid(p_summary), false)
		or v_folder is null or v_folder !~ '^digital-post/[0-9]{4}/[^/]+$'
		or not public.qorpera_company_path_valid(v_folder)
		or jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) not between 2 and 103
		or p_files->0->>'name' is distinct from 'letter.md' or p_files->1->>'name' is distinct from 'letter.json'
		or exists (
			select 1 from jsonb_array_elements(p_files) as file(value)
			where jsonb_typeof(file.value) <> 'object'
				or (select array_agg(key order by key) from jsonb_object_keys(file.value) as key)
					<> array['bytes', 'mediaType', 'name', 'sha256']
				or jsonb_typeof(file.value->'name') <> 'string' or strpos(file.value->>'name', '/') > 0
				or not public.qorpera_company_path_valid(v_folder || '/' || (file.value->>'name'))
				or coalesce(file.value->>'mediaType', '')
					!~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'
				or jsonb_typeof(file.value->'bytes') <> 'number' or (file.value->>'bytes') !~ '^[0-9]{1,8}$'
				or (file.value->>'bytes')::bigint > 33554432
				or coalesce(file.value->>'sha256', '') !~ '^[0-9a-f]{64}$'
		)
		or (select count(distinct public.qorpera_folder_key(file.value->>'name'))
			from jsonb_array_elements(p_files) as file(value)) <> jsonb_array_length(p_files) then
		raise exception 'Digital Post letter is invalid' using errcode = '22023';
	end if;
	select sum((file.value->>'bytes')::bigint) into v_bytes from jsonb_array_elements(p_files) as file(value);
	if v_bytes > 50331648 then
		raise exception 'Digital Post letter is invalid' using errcode = '22023';
	end if;
	v_sync := public.qorpera_digital_post_leased(v_authority.profile_id, p_secret_id, p_secret_version, p_lease_id);
	select letter.* into v_letter
	from public.qorpera_digital_post_letters as letter
	where letter.profile_id = v_authority.profile_id and letter.message_uuid = (p_summary->>'messageUuid')::uuid
	for update;
	if v_letter.id is not null and v_letter.status <> 'staging' then
		update public.qorpera_digital_post_letters set memo_id = p_memo_id where id = v_letter.id;
		return jsonb_build_object('schema', 'qorpera.digital-post-letter-kept/v1', 'letterId', v_letter.id,
			'state', 'kept');
	end if;
	begin
		if v_letter.id is not null then
			delete from public.qorpera_digital_post_chunks where letter_id = v_letter.id;
			update public.qorpera_digital_post_letters
			set memo_id = p_memo_id, folder = v_folder, summary = p_summary, files = p_files, bytes = v_bytes,
				received_at = clock_timestamp()
			where id = v_letter.id;
		else
			insert into public.qorpera_digital_post_letters
				(profile_id, environment_id, message_uuid, memo_id, status, folder, summary, files, bytes)
			values (v_authority.profile_id, v_sync.environment_id, (p_summary->>'messageUuid')::uuid, p_memo_id,
				'staging', v_folder, p_summary, p_files, v_bytes)
			returning * into v_letter;
		end if;
	exception when unique_violation then
		-- Another letter of the company has a folder of the same key (the same day, sender, title and id prefix).
		raise exception 'Digital Post letter folder is taken' using errcode = '23505';
	end;
	return jsonb_build_object('schema', 'qorpera.digital-post-letter-kept/v1', 'letterId', v_letter.id,
		'state', 'staging');
end
$$;
revoke all on function public.qorpera_keep_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_keep_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid, jsonb, jsonb)
	to qorpera_secret_broker;

-- One chunk of a staging letter's file (this claim's lease only): chunk n holds the file's bytes from n MiB, a full MiB
-- but for the last. Staging a chunk again replaces it.
create function public.qorpera_stage_digital_post_chunk(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_letter_id uuid,
	p_file_index integer,
	p_chunk_index integer,
	p_content bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_letter public.qorpera_digital_post_letters%rowtype;
	v_size bigint;
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	perform public.qorpera_digital_post_leased(v_authority.profile_id, p_secret_id, p_secret_version, p_lease_id);
	select letter.* into v_letter
	from public.qorpera_digital_post_letters as letter
	where letter.id = p_letter_id and letter.profile_id = v_authority.profile_id
	for share;
	if v_letter.id is null or v_letter.status <> 'staging' then
		raise exception 'Digital Post letter is not staging' using errcode = '55000';
	end if;
	v_size := (v_letter.files->p_file_index->>'bytes')::bigint;
	if p_file_index is null or p_file_index < 0 or v_size is null or p_chunk_index is null or p_chunk_index < 0
		or p_chunk_index::bigint * 1048576 >= v_size or p_content is null
		or octet_length(p_content) <> least(1048576, v_size - p_chunk_index::bigint * 1048576) then
		raise exception 'Digital Post chunk is invalid' using errcode = '22023';
	end if;
	insert into public.qorpera_digital_post_chunks (letter_id, file_index, chunk_index, content)
	values (p_letter_id, p_file_index, p_chunk_index, p_content)
	on conflict (letter_id, file_index, chunk_index) do update set content = excluded.content;
	return jsonb_build_object('schema', 'qorpera.digital-post-chunk/v1', 'staged', true);
end
$$;
revoke all on function public.qorpera_stage_digital_post_chunk(uuid, text, uuid, bigint, uuid, uuid, integer, integer, bytea)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_stage_digital_post_chunk(uuid, text, uuid, bigint, uuid, uuid, integer, integer, bytea)
	to qorpera_secret_broker;

-- A staging letter whose every file is staged whole, with the size and SHA-256 it was kept with, becomes 'kept' (this
-- claim's lease only); then the vault may receipt it. A letter already kept answers kept again.
create function public.qorpera_seal_digital_post_letter(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_letter_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_letter public.qorpera_digital_post_letters%rowtype;
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	perform public.qorpera_digital_post_leased(v_authority.profile_id, p_secret_id, p_secret_version, p_lease_id);
	select letter.* into v_letter
	from public.qorpera_digital_post_letters as letter
	where letter.id = p_letter_id and letter.profile_id = v_authority.profile_id
	for update;
	if v_letter.id is null then
		raise exception 'Digital Post letter is not staging' using errcode = '55000';
	end if;
	if v_letter.status = 'staging' then
		if exists (
			select 1
			from jsonb_array_elements(v_letter.files) with ordinality as file(value, position)
			where coalesce((
				select octet_length(string_agg(chunk.content, ''::bytea order by chunk.chunk_index))::bigint = (file.value->>'bytes')::bigint
					and encode(sha256(coalesce(string_agg(chunk.content, ''::bytea order by chunk.chunk_index), ''::bytea)), 'hex')
						= file.value->>'sha256'
				from public.qorpera_digital_post_chunks as chunk
				where chunk.letter_id = v_letter.id and chunk.file_index = file.position - 1
			), false) is not true
				and not ((file.value->>'bytes')::bigint = 0
					and not exists (select 1 from public.qorpera_digital_post_chunks as chunk
						where chunk.letter_id = v_letter.id and chunk.file_index = file.position - 1)
					and file.value->>'sha256' = encode(sha256(''::bytea), 'hex'))
		) then
			raise exception 'Digital Post letter is not staged whole' using errcode = '22023';
		end if;
		update public.qorpera_digital_post_letters set status = 'kept', kept_at = clock_timestamp()
		where id = v_letter.id;
	end if;
	return jsonb_build_object('schema', 'qorpera.digital-post-letter-kept/v1', 'letterId', v_letter.id, 'state', 'kept');
end
$$;
revoke all on function public.qorpera_seal_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_seal_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid)
	to qorpera_secret_broker;

-- A letter the vault could not read or keep (this claim's lease only), with a fixed phrase why. It is not fetched again
-- while held; Digital Post moves it to Virk.
create function public.qorpera_hold_digital_post_letter(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_memo_id uuid,
	p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_memo_id is null or v_reason is null then
		raise exception 'Digital Post hold is invalid' using errcode = '22023';
	end if;
	perform public.qorpera_digital_post_leased(v_authority.profile_id, p_secret_id, p_secret_version, p_lease_id);
	insert into public.qorpera_digital_post_held (profile_id, memo_id, reason)
	values (v_authority.profile_id, p_memo_id, v_reason)
	on conflict (profile_id, memo_id) do update set reason = excluded.reason;
	return jsonb_build_object('schema', 'qorpera.digital-post-held/v1', 'held', true);
end
$$;
revoke all on function public.qorpera_hold_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_hold_digital_post_letter(uuid, text, uuid, bigint, uuid, uuid, text)
	to qorpera_secret_broker;

-- The end of a leased pass (this claim's lease only), with the letters it receipted:
-- - current: every letter Digital Post listed was taken; due again in ten minutes.
-- - more: Digital Post listed a full page; due again in thirty seconds for the rest.
-- - failed: offered again after five minutes, doubling to two hours.
-- - refused: Digital Post refused the key; nothing is due until the member connects again.
-- A late answer (the lease ran out, or the key changed) is refused.
create function public.qorpera_finish_digital_post_sync(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_secret_id uuid,
	p_secret_version bigint,
	p_lease_id uuid,
	p_outcome text,
	p_system_id uuid,
	p_receipted jsonb,
	p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_sync public.qorpera_digital_post_syncs%rowtype;
	v_now timestamptz := clock_timestamp();
	v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
	v_authority := public.qorpera_digital_post_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_outcome is null or p_outcome not in ('current', 'more', 'failed', 'refused')
		or (p_outcome in ('failed', 'refused')) <> (v_error is not null)
		or jsonb_typeof(p_receipted) is distinct from 'array' or jsonb_array_length(p_receipted) > 1000
		or exists (select 1 from jsonb_array_elements(p_receipted) as item(value)
			where jsonb_typeof(item.value) <> 'string'
				or item.value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Digital Post sync answer is invalid' using errcode = '22023';
	end if;
	v_sync := public.qorpera_digital_post_leased(v_authority.profile_id, p_secret_id, p_secret_version, p_lease_id);
	update public.qorpera_digital_post_letters
	set receipted_at = coalesce(receipted_at, v_now)
	where profile_id = v_authority.profile_id and status <> 'staging'
		and id in (select (item.value #>> '{}')::uuid from jsonb_array_elements(p_receipted) as item(value));
	update public.qorpera_digital_post_syncs
	set status = case p_outcome when 'more' then 'current' else p_outcome end,
		due_at = case p_outcome
			when 'current' then v_now + interval '10 minutes'
			when 'more' then v_now + interval '30 seconds'
			when 'failed' then v_now + least(interval '5 minutes' * power(2, least(greatest(v_sync.attempts - 1, 0), 5)),
				interval '2 hours')
		end,
		lease_until = null,
		lease_id = null,
		attempts = case when p_outcome = 'failed' then v_sync.attempts else 0 end,
		last_error = v_error,
		system_id = coalesce(p_system_id, v_sync.system_id),
		fetched_at = case when p_outcome in ('current', 'more') then v_now else v_sync.fetched_at end,
		updated_at = v_now
	where profile_id = v_authority.profile_id
	returning * into v_sync;
	return jsonb_build_object('schema', 'qorpera.digital-post-sync-result/v1', 'status', v_sync.status,
		'dueAt', v_sync.due_at);
end
$$;
revoke all on function public.qorpera_finish_digital_post_sync(uuid, text, uuid, bigint, uuid, text, uuid, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_finish_digital_post_sync(uuid, text, uuid, bigint, uuid, text, uuid, jsonb, text)
	to qorpera_secret_broker;

-- The shared vault's served companies with a Digital Post sync due: one call a pass.
create function public.qorpera_broker_principal_digital_post_syncs_due(p_principal_id uuid, p_capability_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_due jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(due.profile_id order by due.profile_id), '[]'::jsonb) into v_due
	from (
		select sync.profile_id
		from public.qorpera_digital_post_syncs as sync
		join public.qorpera_cloud_secret_broker_authorities as authority
			on authority.profile_id = sync.profile_id and authority.principal_id = v_principal.id
				and authority.status = 'active'
		where sync.due_at <= clock_timestamp()
			and (sync.lease_until is null or sync.lease_until <= clock_timestamp())
		order by sync.due_at
		limit 1000
	) as due;
	return jsonb_build_object('schema', 'qorpera.broker-principal-digital-post-syncs/v1', 'companyIds', v_due);
end
$$;
revoke all on function public.qorpera_broker_principal_digital_post_syncs_due(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_broker_principal_digital_post_syncs_due(uuid, text) to qorpera_secret_broker;

-- A member's view of the company's Digital Post connection (Settings and the Mailbox): any member of the company,
-- viewers included, as for company mail. Fixed phrases only; never a key.
create function public.qorpera_member_digital_post(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid;
	v_sync public.qorpera_digital_post_syncs%rowtype;
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null or p_environment_id is null then
		raise exception 'Digital Post is unavailable' using errcode = '42501';
	end if;
	select environment.profile_id into v_profile_id
	from public.qorpera_company_environments as environment where environment.id = p_environment_id;
	if v_profile_id is null or public.qorpera_member_role(v_profile_id) is null then
		raise exception 'Digital Post is unavailable' using errcode = '42501';
	end if;
	select sync.* into v_sync
	from public.qorpera_digital_post_syncs as sync
	where sync.profile_id = v_profile_id and sync.environment_id = p_environment_id;
	return jsonb_build_object(
		'schema', 'qorpera.member-digital-post/v1',
		'connected', v_sync.profile_id is not null and v_sync.status <> 'disconnected',
		'status', coalesce(v_sync.status, 'disconnected'),
		'systemId', v_sync.system_id,
		'fetchedAt', v_sync.fetched_at,
		'lastError', case when v_sync.status in ('failed', 'refused') then v_sync.last_error end,
		'letters', (select count(*) from public.qorpera_digital_post_letters as letter
			where letter.profile_id = v_profile_id and letter.status <> 'staging'),
		'waitingForFolder', (select count(*) from public.qorpera_digital_post_letters as letter
			where letter.profile_id = v_profile_id and letter.status = 'kept'),
		'held', (select count(*) from public.qorpera_digital_post_held as held
			where held.profile_id = v_profile_id and held.held_at >= clock_timestamp() - interval '8 days')
	);
end
$$;
revoke all on function public.qorpera_member_digital_post(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_digital_post(uuid) to authenticated;
