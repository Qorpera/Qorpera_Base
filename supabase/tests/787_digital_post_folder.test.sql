-- @fixture 704_folder_state_connections.test.sql until "-- 1. The company, and the platform writing its first connection file"
-- Digital Post in the company folder, part 3 (migration 20260930530000): a kept letter is due to the object gateway's
-- writer, which claims it (its own lease), reads its staged files back in pieces, commits the letter's folder and the
-- index as the platform under the claim's operation key, and finishes: the letter is written and its staged bytes go.
-- The next letter's claim finds the folders and the index's version; a problem backs off; a claim another writer took
-- over is finished false. Here one session plays the vault (rows as part 2 leaves them) and the writer (through the
-- folder core's commit), on 704's folder-v2 company.

create function pg_temp.dp_check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then raise exception 'Failed: %', p_what; end if;
end $$;
create function pg_temp.dp_refused(p_sql text, p_state text) returns void language plpgsql as $$
begin
	begin execute p_sql; exception when others then
		if sqlstate = p_state then return; end if;
		raise exception 'Expected %, got %: %', p_state, sqlstate, sqlerrm;
	end;
	raise exception 'Not refused: %', p_sql;
end $$;
-- A letter as the vault leaves it once sealed (part 2): its summary, its files, and their bytes in 1 MiB chunks.
create function pg_temp.dp_letter(p_id uuid, p_message uuid, p_received timestamptz, p_pdf bytea) returns void
language plpgsql as $$
declare
	v_folder text := 'digital-post/2026/2026-10-22 Skattestyrelsen - Brev (' || p_message || ')';
	v_files jsonb := jsonb_build_array(
		jsonb_build_object('name', 'letter.md', 'mediaType', 'text/markdown', 'bytes', 6,
			'sha256', encode(sha256(convert_to('# Brev', 'UTF8')), 'hex')),
		jsonb_build_object('name', 'letter.json', 'mediaType', 'application/json', 'bytes', 2,
			'sha256', encode(sha256(convert_to('{}', 'UTF8')), 'hex')),
		jsonb_build_object('name', 'brev.pdf', 'mediaType', 'application/pdf', 'bytes', octet_length(p_pdf),
			'sha256', encode(sha256(p_pdf), 'hex')));
begin
	insert into public.qorpera_digital_post_letters (id, profile_id, environment_id, message_uuid, memo_id, status, folder,
		summary, files, bytes, received_at, kept_at)
	values (p_id, '70400000-0000-4000-8000-000000000010', '70400000-0000-4000-8000-000000000020', p_message,
		extensions.gen_random_uuid(), 'kept', v_folder,
		jsonb_build_object('messageUuid', p_message, 'folder', v_folder, 'title', 'Brev', 'sender', 'Skattestyrelsen',
			'senderId', '19552101', 'created', '2026-10-21T23:30:00Z', 'received', p_received, 'mandatory', false,
			'legalNotification', false, 'replyBy', null, 'caseId', null, 'files', 1, 'text', true, 'snippet', 'Hej'),
		v_files, 8 + octet_length(p_pdf), p_received, p_received);
	insert into public.qorpera_digital_post_chunks (letter_id, file_index, chunk_index, content) values
		(p_id, 0, 0, convert_to('# Brev', 'UTF8')),
		(p_id, 1, 0, convert_to('{}', 'UTF8')),
		(p_id, 2, 0, substring(p_pdf from 1 for 1048576));
	if octet_length(p_pdf) > 1048576 then
		insert into public.qorpera_digital_post_chunks (letter_id, file_index, chunk_index, content)
		values (p_id, 2, 1, substring(p_pdf from 1048577));
	end if;
end $$;
create function pg_temp.dp_claim(p_worker uuid default '78700000-0000-4000-8000-00000000000a') returns jsonb language sql as $$
	select public.qorpera_claim_digital_post_letter_file(p_worker, 60)
$$;
create function pg_temp.dp_read(p_letter uuid, p_file integer, p_chunk integer, p_offset integer, p_length integer,
	p_worker uuid default '78700000-0000-4000-8000-00000000000a') returns bytea language sql as $$
	select decode(public.qorpera_read_digital_post_chunk(p_worker, p_letter, p_file, p_chunk, p_offset, p_length)
		->> 'content', 'base64')
$$;
create function pg_temp.dp_finish(p_letter uuid, p_problem text default null,
	p_worker uuid default '78700000-0000-4000-8000-00000000000a') returns boolean language sql as $$
	select (public.qorpera_finish_digital_post_letter_file(p_worker, p_letter, p_problem) ->> 'finished')::boolean
$$;
create function pg_temp.dp_letter_row(p_id uuid) returns public.qorpera_digital_post_letters language sql as $$
	select * from public.qorpera_digital_post_letters where id = p_id
$$;
-- The writer's commit for a claim: the folders it lacks, the letter's folder whole, the index.
create function pg_temp.dp_commit(p_claim jsonb) returns jsonb language plpgsql as $$
declare
	v_units jsonb := '[]'::jsonb;
	v_year text := split_part(p_claim ->> 'folder', '/', 1) || '/' || split_part(p_claim ->> 'folder', '/', 2);
begin
	if not (p_claim ->> 'rootPresent')::boolean then
		v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', 'digital-post'));
	end if;
	if not (p_claim ->> 'yearPresent')::boolean then
		v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'mkdir', 'path', v_year));
	end if;
	v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', p_claim ->> 'folder',
		'contents', (select jsonb_agg(jsonb_build_object('path', file.value ->> 'name', 'kind', 'file',
			'file', pg_temp.stage(file.value ->> 'name')) order by file.position)
			from jsonb_array_elements(p_claim -> 'files') with ordinality as file(value, position))));
	v_units := v_units || jsonb_build_array(jsonb_build_object('op', 'write', 'path', 'digital-post/letters.json',
		'file', pg_temp.stage(jsonb_build_object('letters', p_claim -> 'index')::text))
		|| case when p_claim -> 'indexVersion' = 'null'::jsonb then '{}'::jsonb
			else jsonb_build_object('expectedVersion', p_claim ->> 'indexVersion') end);
	return public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', pg_temp.platform(),
		p_claim ->> 'operationKey', v_units);
end $$;

-- 1. Only the gateway's service role may claim, read and finish.
do $$
declare v_role text; v_function text;
begin
	foreach v_function in array array['public.qorpera_claim_digital_post_letter_file(uuid,integer)',
		'public.qorpera_read_digital_post_chunk(uuid,uuid,integer,integer,integer,integer)',
		'public.qorpera_finish_digital_post_letter_file(uuid,uuid,text)'] loop
		foreach v_role in array array['anon', 'authenticated', 'qorpera_secret_broker'] loop
			perform pg_temp.dp_check(not has_function_privilege(v_role, v_function, 'execute'), v_role || ' may not call ' || v_function);
		end loop;
		perform pg_temp.dp_check(has_function_privilege('service_role', v_function, 'execute'), 'the gateway calls ' || v_function);
	end loop;
	perform pg_temp.dp_check(not has_function_privilege('service_role', 'public.qorpera_digital_post_entry(uuid,text)', 'execute'),
		'the entry lookup is internal');
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true) \g /dev/null
select pg_temp.dp_refused($$select pg_temp.dp_claim()$$, '42501');
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null

-- 2. A kept letter is due: the claim says what the folder lacks and lists it in the index; the pieces read back.
select pg_temp.dp_check(pg_temp.dp_claim() is null, 'nothing kept, nothing due');
select pg_temp.dp_letter('78700000-0000-4000-8000-0000000000a1', '6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a',
	'2026-10-22 06:00:00+00', decode(repeat('ab', 1048576 + 100), 'hex'));
do $$
declare v jsonb := pg_temp.dp_claim(); r jsonb;
begin
	perform pg_temp.dp_check(v ->> 'schema' = 'qorpera.digital-post-letter-claim/v1'
		and v ->> 'letterId' = '78700000-0000-4000-8000-0000000000a1'
		and v ->> 'profileId' = '70400000-0000-4000-8000-000000000010'
		and v ->> 'environmentId' = '70400000-0000-4000-8000-000000000020'
		and (v ->> 'attempt')::integer = 1
		and v ->> 'operationKey' = 'digital-post:78700000-0000-4000-8000-0000000000a1:1'
		and not (v ->> 'rootPresent')::boolean and not (v ->> 'yearPresent')::boolean
		and not (v ->> 'folderPresent')::boolean and v -> 'indexVersion' = 'null'::jsonb
		and jsonb_array_length(v -> 'files') = 3 and v -> 'files' -> 2 -> 'version' = 'null'::jsonb
		and jsonb_array_length(v -> 'index') = 1
		and v -> 'index' -> 0 ->> 'messageUuid' = '6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a', 'the first claim: ' || v::text);
	perform pg_temp.dp_check(pg_temp.dp_claim() is null, 'a leased letter is not claimed twice');
	-- Pieces of at most 512 KiB, only for the writer holding the lease.
	perform pg_temp.dp_check(pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 2, 1, 0, 524288)
		= decode(repeat('ab', 100), 'hex'), 'the last piece is the rest of the file');
	perform pg_temp.dp_check(pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 2, 0, 524288, 524288)
		= decode(repeat('ab', 524288), 'hex'), 'a piece from an offset');
	perform pg_temp.dp_refused($q$select pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 2, 0, 0, 524289)$q$, '22023');
	perform pg_temp.dp_refused($q$select pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 2, 5, 0, 10)$q$, 'P0002');
	perform pg_temp.dp_refused($q$select pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 2, 0, 0, 10,
		'78700000-0000-4000-8000-00000000000b')$q$, '55000');
	-- The writer: the folders, the letter's folder whole, the index, as the platform under the claim's key.
	r := pg_temp.dp_commit(v);
	perform pg_temp.expect(r, 1, 'saved');
	perform pg_temp.expect(r, 2, 'saved');
	perform pg_temp.expect(r, 3, 'saved');
	perform pg_temp.expect(r, 4, 'saved');
	perform pg_temp.dp_check(pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a1'), 'the claim finishes');
	perform pg_temp.dp_check((pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a1')).status = 'written'
		and (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a1')).written_at is not null
		and (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a1')).write_lease_owner is null
		and not exists (select 1 from public.qorpera_digital_post_chunks
			where letter_id = '78700000-0000-4000-8000-0000000000a1'), 'written, its staged bytes gone');
	perform pg_temp.dp_check(pg_temp.dp_claim() is null, 'nothing due once written');
	perform pg_temp.dp_refused($q$select pg_temp.dp_read('78700000-0000-4000-8000-0000000000a1', 0, 0, 0, 6)$q$, '55000');
end $$;

-- 3. The next letter finds the folders and the index's version, and the index lists both, newest first; a problem backs
-- off; a claim another writer took over is finished false; a folder already there is reported.
select pg_temp.dp_letter('78700000-0000-4000-8000-0000000000a2', '7a000000-0000-4000-8000-000000000002',
	'2026-10-22 07:00:00+00', '\x255044462d'::bytea);
do $$
declare v jsonb := pg_temp.dp_claim(); v_again jsonb;
begin
	perform pg_temp.dp_check((v ->> 'rootPresent')::boolean and (v ->> 'yearPresent')::boolean
		and not (v ->> 'folderPresent')::boolean
		and (v ->> 'indexVersion')::uuid = pg_temp.version('digital-post/letters.json')
		and v -> 'index' -> 0 ->> 'messageUuid' = '7a000000-0000-4000-8000-000000000002'
		and v -> 'index' -> 1 ->> 'messageUuid' = '6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a', 'the second claim: ' || v::text);
	perform pg_temp.dp_check(pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a2', 'stale'), 'a problem finishes the claim');
	perform pg_temp.dp_check((pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).status = 'kept'
		and (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).write_problem = 'stale'
		and (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).write_not_before > clock_timestamp()
		and exists (select 1 from public.qorpera_digital_post_chunks where letter_id = '78700000-0000-4000-8000-0000000000a2'),
		'a problem backs off and keeps the bytes');
	perform pg_temp.dp_check(pg_temp.dp_claim() is null, 'nothing due while backing off');
	update public.qorpera_digital_post_letters set write_not_before = clock_timestamp() - interval '1 second'
	where id = '78700000-0000-4000-8000-0000000000a2';
	v_again := pg_temp.dp_claim();
	perform pg_temp.dp_check((v_again ->> 'attempt')::integer = 2
		and v_again ->> 'operationKey' = 'digital-post:78700000-0000-4000-8000-0000000000a2:2', 'claimed again: ' || v_again::text);
	-- Another writer takes the letter over after this lease ran out: the first writer's finish changes nothing.
	update public.qorpera_digital_post_letters set write_lease_until = clock_timestamp() - interval '1 second'
	where id = '78700000-0000-4000-8000-0000000000a2';
	perform pg_temp.dp_check(pg_temp.dp_claim('78700000-0000-4000-8000-00000000000b') is not null, 'the second writer claims');
	perform pg_temp.dp_check(not pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a2'),
		'the first writer''s finish is not its own any more');
	perform pg_temp.dp_check((pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).write_lease_owner
		= '78700000-0000-4000-8000-00000000000b', 'the second writer still holds it');
	-- The letter's folder made meanwhile (an earlier commit whose finish was lost): the next claim reports it.
	perform pg_temp.expect(public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', pg_temp.platform(),
		'digital-post-test:folder-made', jsonb_build_array(jsonb_build_object('op', 'new_folder', 'path', v ->> 'folder',
			'contents', jsonb_build_array(jsonb_build_object('path', 'letter.md', 'kind', 'file', 'file', pg_temp.stage('# Brev')))))),
		1, 'saved');
	update public.qorpera_digital_post_letters set write_lease_until = clock_timestamp() - interval '1 second'
	where id = '78700000-0000-4000-8000-0000000000a2';
	v_again := pg_temp.dp_claim();
	perform pg_temp.dp_check((v_again ->> 'folderPresent')::boolean
		and (v_again -> 'files' -> 0 ->> 'version')::uuid = pg_temp.version(lower(v ->> 'folder') || '/letter.md')
		and v_again -> 'files' -> 2 -> 'version' = 'null'::jsonb, 'the folder and its one file are reported: ' || v_again::text);
end $$;
select pg_temp.dp_refused($$select public.qorpera_finish_digital_post_letter_file('78700000-0000-4000-8000-00000000000a',
	'78700000-0000-4000-8000-0000000000a2', 'Not A Code')$$, '22023');

-- 4. Where something else stands (a folder where a file goes, a link where a file goes), the claim says blocked, names no
-- version for it, and a finish with the problem keeps the letter's bytes.
do $$
declare v jsonb; v_folder text := (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).folder;
begin
	perform pg_temp.dp_check(pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a2', 'stale'), 'released');
	update public.qorpera_digital_post_letters set write_not_before = clock_timestamp() - interval '1 second'
	where id = '78700000-0000-4000-8000-0000000000a2';
	perform pg_temp.expect(public.qorpera_folder_commit('70400000-0000-4000-8000-000000000020', pg_temp.platform(),
		'digital-post-test:obstruct', jsonb_build_array(
			jsonb_build_object('op', 'mkdir', 'path', v_folder || '/brev.pdf'),
			jsonb_build_object('op', 'symlink', 'path', v_folder || '/letter.json', 'target', 'letter.md'))), 1, 'saved');
	v := pg_temp.dp_claim();
	perform pg_temp.dp_check(v ->> 'letterId' = '78700000-0000-4000-8000-0000000000a2' and (v ->> 'blocked')::boolean
		and v -> 'files' -> 0 ->> 'version' is not null and v -> 'files' -> 1 -> 'version' = 'null'::jsonb
		and v -> 'files' -> 2 -> 'version' = 'null'::jsonb, 'blocked, with no version for what is not a file: ' || v::text);
	perform pg_temp.dp_check(pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a2', 'path_taken')
		and (pg_temp.dp_letter_row('78700000-0000-4000-8000-0000000000a2')).status = 'kept'
		and exists (select 1 from public.qorpera_digital_post_chunks where letter_id = '78700000-0000-4000-8000-0000000000a2'),
		'the blocked letter keeps its bytes');
	-- Out of the way for what follows.
	update public.qorpera_digital_post_letters set write_not_before = clock_timestamp() + interval '1 day'
	where id = '78700000-0000-4000-8000-0000000000a2';
end $$;

-- 5. One letter of a company at a time: while one writer holds a letter, another writer gets none of that company's;
-- once the first is finished, the second's index lists the first.
select pg_temp.dp_letter('78700000-0000-4000-8000-0000000000a3', '7a000000-0000-4000-8000-000000000003',
	'2026-10-22 08:00:00+00', '\x255044462d33'::bytea);
select pg_temp.dp_letter('78700000-0000-4000-8000-0000000000a4', '7a000000-0000-4000-8000-000000000004',
	'2026-10-22 09:00:00+00', '\x255044462d34'::bytea);
do $$
declare v jsonb := pg_temp.dp_claim(); v_second jsonb;
begin
	perform pg_temp.dp_check(v ->> 'letterId' = '78700000-0000-4000-8000-0000000000a3', 'the older letter first: ' || v::text);
	perform pg_temp.dp_check(pg_temp.dp_claim('78700000-0000-4000-8000-00000000000b') is null,
		'another writer gets nothing of the company while the first holds a letter');
	perform pg_temp.expect(pg_temp.dp_commit(v), 1, 'saved');
	perform pg_temp.dp_check(pg_temp.dp_finish('78700000-0000-4000-8000-0000000000a3'), 'the first finishes');
	v_second := pg_temp.dp_claim('78700000-0000-4000-8000-00000000000b');
	perform pg_temp.dp_check(v_second ->> 'letterId' = '78700000-0000-4000-8000-0000000000a4'
		and v_second -> 'index' -> 0 ->> 'messageUuid' = '7a000000-0000-4000-8000-000000000004'
		and v_second -> 'index' -> 1 ->> 'messageUuid' = '7a000000-0000-4000-8000-000000000003'
		and (v_second ->> 'indexVersion')::uuid = pg_temp.version('digital-post/letters.json'),
		'the second''s index lists the first: ' || v_second::text);
end $$;

rollback;
