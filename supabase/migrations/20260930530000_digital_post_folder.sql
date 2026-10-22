-- Digital Post in the company folder, part 3 (deploy/first-node/RUNTIME-DIGITAL-POST.md): the object gateway writes
-- each kept letter into the company folder. The vault keeps a letter and its files in the database
-- (20260930529000) and never writes the folder; a 'kept' letter is due here. The gateway's writer claims one due letter
-- at a time (its own short lease), reads its staged files back in pieces, and commits as the platform under the claim's
-- operation key, in one change set: digital-post/ and the year's folder when they are missing, the letter's folder with
-- every file (one unit, all or nothing), and the index digital-post/letters.json at the version the claim read. Then it
-- finishes the claim: written (the staged bytes are deleted), or a problem code after which the letter backs off.
--
-- A letter's folder already in the folder (an earlier write that committed but never finished) gets only the files it
-- lacks; nothing there is overwritten. A path the letter needs that holds something else (a folder or a link where a
-- file goes, a file or a link where a folder goes) is `blocked`: nothing is written and the letter backs off, its bytes
-- kept. The index lists the newest written letters (and this one), each with the summary the vault kept; it is the
-- platform's, rewritten with every letter, so a member's edit lasts until the next letter. One letter of a company is
-- written at a time (a company's claims are serialized and a company with a live lease is passed over), so a letter is
-- written or finished before the next one reads the index.

alter table public.qorpera_digital_post_letters
	add column write_lease_owner uuid,
	add column write_lease_until timestamptz,
	add column write_attempts integer not null default 0 check (write_attempts >= 0),
	add column write_not_before timestamptz,
	add column write_problem text check (write_problem is null or write_problem ~ '^[a-z][a-z0-9_]{0,63}$');

-- A folder entry of the company's environment at a path, by its key.
create function public.qorpera_digital_post_entry(p_environment_id uuid, p_path text)
returns public.qorpera_folder_entries
language sql
stable
security definer
set search_path = ''
as $$
	select entry.* from public.qorpera_folder_entries as entry
	where entry.environment_id = p_environment_id and entry.kind <> 'claim'
		and entry.key_sha256 = extensions.digest(public.qorpera_folder_key(p_path), 'sha256')
	limit 1
$$;
revoke all on function public.qorpera_digital_post_entry(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- One due letter, leased to p_worker: where it goes, which of its folders and files the folder has already (a file's
-- version only for a file), whether a path it needs holds something else, the index's version now, and the index's
-- letters (the newest 200 written, and this one). Null when nothing is due. Only folder-v2 companies that are not being
-- deleted, and only a company none of whose letters another writer holds.
create function public.qorpera_claim_digital_post_letter_file(p_worker uuid, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_letter public.qorpera_digital_post_letters%rowtype;
	v_candidate record;
	v_now timestamptz := clock_timestamp();
	v_year text;
	v_files jsonb;
	v_index jsonb;
	v_blocked boolean;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_worker is null or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
		raise exception 'Digital Post letter claim is invalid' using errcode = '22023';
	end if;
	for v_candidate in
		select letter.id, letter.profile_id
		from public.qorpera_digital_post_letters as letter
		where letter.status = 'kept'
			and (letter.write_lease_until is null or letter.write_lease_until <= v_now)
			and (letter.write_not_before is null or letter.write_not_before <= v_now)
			and public.qorpera_environment_is_folder_v2(letter.environment_id)
			and not public.qorpera_company_deleting(letter.profile_id)
		order by letter.kept_at, letter.id
		limit 20
	loop
		-- One claim of a company at a time; then a company whose letter another writer holds is passed over. The check runs
		-- after the lock, so it sees a lease the claim before this one committed.
		perform pg_advisory_xact_lock(hashtextextended('qorpera.digital-post-write:' || v_candidate.profile_id::text, 0));
		continue when exists (
			select 1 from public.qorpera_digital_post_letters as other
			where other.profile_id = v_candidate.profile_id and other.id <> v_candidate.id and other.status = 'kept'
				and other.write_lease_until > clock_timestamp()
		);
		select letter.* into v_letter
		from public.qorpera_digital_post_letters as letter
		where letter.id = v_candidate.id and letter.status = 'kept'
			and (letter.write_lease_until is null or letter.write_lease_until <= clock_timestamp())
		for update skip locked;
		exit when v_letter.id is not null;
	end loop;
	if v_letter.id is null then
		return null;
	end if;
	update public.qorpera_digital_post_letters
	set write_lease_owner = p_worker, write_lease_until = v_now + make_interval(secs => p_lease_seconds),
		write_attempts = write_attempts + 1
	where id = v_letter.id
	returning * into v_letter;
	v_year := split_part(v_letter.folder, '/', 1) || '/' || split_part(v_letter.folder, '/', 2);
	select jsonb_agg(file.value || jsonb_build_object('version', case when entry.kind = 'file' then entry.version end)
			order by file.position),
		bool_or(entry.kind is not null and entry.kind <> 'file')
	into v_files, v_blocked
	from jsonb_array_elements(v_letter.files) with ordinality as file(value, position)
	left join lateral public.qorpera_digital_post_entry(v_letter.environment_id,
		v_letter.folder || '/' || (file.value->>'name')) as entry on true;
	v_blocked := v_blocked
		or coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, 'digital-post')).kind <> 'folder', false)
		or coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, v_year)).kind <> 'folder', false)
		or coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, v_letter.folder)).kind <> 'folder', false)
		or coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, 'digital-post/letters.json')).kind <> 'file',
			false);
	select coalesce(jsonb_agg(listed.summary order by listed.received_at desc, listed.id), '[]'::jsonb) into v_index
	from (
		select letter.summary, letter.received_at, letter.id
		from public.qorpera_digital_post_letters as letter
		where letter.profile_id = v_letter.profile_id
			and (letter.status = 'written' or letter.id = v_letter.id)
		order by letter.received_at desc, letter.id
		limit 200
	) as listed;
	return jsonb_build_object(
		'schema', 'qorpera.digital-post-letter-claim/v1',
		'letterId', v_letter.id,
		'profileId', v_letter.profile_id,
		'environmentId', v_letter.environment_id,
		'attempt', v_letter.write_attempts,
		'operationKey', 'digital-post:' || v_letter.id::text || ':' || v_letter.write_attempts::text,
		'folder', v_letter.folder,
		'rootPresent', coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, 'digital-post')).kind = 'folder', false),
		'yearPresent', coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, v_year)).kind = 'folder', false),
		'folderPresent', coalesce((public.qorpera_digital_post_entry(v_letter.environment_id, v_letter.folder)).kind = 'folder', false),
		'blocked', v_blocked,
		'files', v_files,
		'indexVersion', (select entry.version
			from public.qorpera_digital_post_entry(v_letter.environment_id, 'digital-post/letters.json') as entry
			where entry.kind = 'file'),
		'index', v_index,
		'leaseUntil', v_letter.write_lease_until
	);
end
$$;

-- A piece of a claimed letter's staged file: at most 512 KiB from p_offset within chunk p_chunk, as base64 (the
-- gateway's database answers are bounded at 1 MiB). Only the writer holding the letter's lease reads it.
create function public.qorpera_read_digital_post_chunk(p_worker uuid, p_letter_id uuid, p_file_index integer,
	p_chunk_index integer, p_offset integer, p_length integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_letter public.qorpera_digital_post_letters%rowtype;
	v_content bytea;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_worker is null or p_letter_id is null or p_file_index is null or p_chunk_index is null or p_offset is null
		or p_length is null or p_offset < 0 or p_length not between 1 and 524288 then
		raise exception 'Digital Post chunk read is invalid' using errcode = '22023';
	end if;
	select letter.* into v_letter from public.qorpera_digital_post_letters as letter where letter.id = p_letter_id;
	if v_letter.id is null or v_letter.status <> 'kept' or v_letter.write_lease_owner is distinct from p_worker
		or v_letter.write_lease_until is null or v_letter.write_lease_until <= clock_timestamp() then
		raise exception 'Digital Post letter is not leased' using errcode = '55000';
	end if;
	select substring(chunk.content from p_offset + 1 for p_length) into v_content
	from public.qorpera_digital_post_chunks as chunk
	where chunk.letter_id = p_letter_id and chunk.file_index = p_file_index and chunk.chunk_index = p_chunk_index;
	if v_content is null or (octet_length(v_content) = 0 and p_offset > 0) then
		raise exception 'Digital Post chunk is not staged' using errcode = 'P0002';
	end if;
	return jsonb_build_object('schema', 'qorpera.digital-post-chunk-piece/v1',
		'content', translate(encode(v_content, 'base64'), E'\n', ''));
end
$$;

-- Ends p_worker's claim of a letter: without a problem the letter is in the folder (written; its staged bytes are
-- deleted); with one, it backs off (a minute, doubling to an hour). A claim another worker took over since is answered
-- finished false.
create function public.qorpera_finish_digital_post_letter_file(p_worker uuid, p_letter_id uuid, p_problem text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_letter public.qorpera_digital_post_letters%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501';
	end if;
	if p_worker is null or p_letter_id is null
		or (p_problem is not null and p_problem !~ '^[a-z][a-z0-9_]{0,63}$') then
		raise exception 'Digital Post letter finish is invalid' using errcode = '22023';
	end if;
	select letter.* into v_letter from public.qorpera_digital_post_letters as letter where letter.id = p_letter_id
	for update;
	if v_letter.id is null or v_letter.status <> 'kept' or v_letter.write_lease_owner is distinct from p_worker then
		return jsonb_build_object('schema', 'qorpera.digital-post-letter-finish/v1', 'finished', false);
	end if;
	if p_problem is null then
		delete from public.qorpera_digital_post_chunks where letter_id = p_letter_id;
		update public.qorpera_digital_post_letters
		set status = 'written', written_at = clock_timestamp(), write_lease_owner = null, write_lease_until = null,
			write_attempts = 0, write_problem = null, write_not_before = null
		where id = p_letter_id;
	else
		update public.qorpera_digital_post_letters
		set write_lease_owner = null, write_lease_until = null, write_problem = p_problem,
			write_not_before = clock_timestamp()
				+ least(interval '1 minute' * power(2, least(greatest(write_attempts - 1, 0), 6)), interval '1 hour')
		where id = p_letter_id;
	end if;
	return jsonb_build_object('schema', 'qorpera.digital-post-letter-finish/v1', 'finished', true);
end
$$;

revoke all on function public.qorpera_claim_digital_post_letter_file(uuid, integer),
	public.qorpera_read_digital_post_chunk(uuid, uuid, integer, integer, integer, integer),
	public.qorpera_finish_digital_post_letter_file(uuid, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_digital_post_letter_file(uuid, integer),
	public.qorpera_read_digital_post_chunk(uuid, uuid, integer, integer, integer, integer),
	public.qorpera_finish_digital_post_letter_file(uuid, uuid, text) to service_role;
