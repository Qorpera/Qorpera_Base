-- @fixture 1211_code_requests.test.sql until "-- 1. An agent asks for an undo"
-- Existing code brought into Qorpera, from GitHub or a file (migration 20260930736000). 1211's fixture (1210's helpers
-- before it): company/shop with six rows, session copies that hand commits in, exec-1170 on machine 5…5 holding the
-- company and Another company, Alice's own company run, the claim, step and finish. This file's session copies are
-- numbered from 2900.
--   1. Rights, the tables' rules, the native host's list.
--   2. The agent's call: its shape, every refusal, the company enrolled with the chosen executor's harnesses, via, the
--      request's row, asked again (in the run, in a later run, a look), a file.
--   3. The member's call: who may, its shape, asked again, busy.
--   4. The claim: the kinds, the three-argument call's default, one import a claim, nothing else of a company while its
--      import runs, the item, the lease.
--   5. The quiet wait: at the claim and at the step that first names the look, which gives its claim back; SESSIONS_OPEN.
--   6. The step keeps raw and kept once written.
--   7. The look: its shape, once, lost.
--   8. The record: the registry row, change 1, the grants of that code off, the record files' importedFrom, again, a
--      place taken.
--   9. The finish: the shapes, once recorded, looked, a request that is gone.
--  10. Afterwards: asked again, the list, the agent's read, undo's wall, a later restore, the other kinds' P0002.
--  11. The dispatch and reopen rules, (a) to (c), in their words.
--  12. Five claims: DID_NOT_FINISH; but an import that recorded its repository is claimed again past them until the
--      executor's finish ends it (the review of #1710, F2), and meanwhile it is being brought in, not in.
--  13. At the bounds: the list of a company with 200 sessions and 10 repositories, the claim with 50 queued requests.
--  14. Races on three connections (committed, removed at the end): two members ask at once; a turn that opens meets an
--      import that is asked for, both ways.

-- The agent's call, by Alice's own company run.
create function pg_temp.imp_ask(p_key text, p_owner text, p_name text, p_from jsonb, p_look boolean default false)
returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_request_code_import(pg_temp.c3_alice(), jsonb_build_object('operationKey', p_key,
		'owner', p_owner, 'name', p_name, 'from', p_from, 'look', p_look));
end $$;
create function pg_temp.imp_gh(p_repository text) returns jsonb language sql immutable as $$
	select jsonb_build_object('github', p_repository)
$$;
-- The agent's call refused with p_state p_message, or the case p_what fails.
create function pg_temp.imp_invalid(p_what text, p_request jsonb, p_state text default '22023',
	p_message text default 'Code request is invalid') returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select public.qorpera_folder_request_code_import(pg_temp.c3_alice(), %L)', p_request),
		p_state, p_message);
exception when others then raise exception '%: %', p_what, sqlerrm;
end $$;
-- The member's call, as the web makes it.
create function pg_temp.imp_member(p_user uuid, p_owner text, p_name text, p_github text) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_request_code_import(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000010', p_owner, p_name, p_github))
$$;
-- The answers.
create function pg_temp.imp_refused(p_reason text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-import/v1', 'state', 'refused', 'reason', p_reason)
$$;
create function pg_temp.imp_queued(p_id uuid) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-import/v1', 'state', 'queued', 'requestId', p_id)
$$;
-- The agent's read.
create function pg_temp.imp_read(p_id uuid) returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_folder_code_import(pg_temp.c3_alice(), p_id);
end $$;
-- The executor's claim of the kinds given; its step, look and record.
create function pg_temp.imp_claim(p_kinds text[] default array['undo','download','restore','import'],
	p_limit integer default 20) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_requests_claim('exec-1170', repeat('5', 64), p_limit, p_kinds);
	reset role;
	perform pg_temp.base_assert(v ->> 'schema' = 'qorpera.code-requests/v1', 'a claim: ' || v::text);
	return v -> 'requests';
end $$;
create function pg_temp.imp_looked(p_id uuid, p_token uuid, p_look jsonb, p_owner text default 'exec-1170')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_import_looked(p_owner, repeat('5', 64), p_id, p_token, p_look);
	reset role;
	return v;
end $$;
create function pg_temp.imp_record(p_id uuid, p_token uuid, p_imported jsonb, p_owner text default 'exec-1170')
returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_import_record(p_owner, repeat('5', 64), p_id, p_token, p_imported);
	reset role;
	return v;
end $$;
-- An executor call refused with p_state p_message, or the case p_what fails.
create function pg_temp.imp_error(p_what text, p_sql text, p_state text, p_message text) returns void language plpgsql as $$
begin
	perform pg_temp.base_error(p_sql, p_state, p_message);
exception when others then raise exception '%: %', p_what, sqlerrm;
end $$;
-- What the code host's look found, what the fetch brought (the first bundle) and the restore-shaped bundle.
create function pg_temp.imp_look(p_keys jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.code-import-look/v1', 'bytes', 207618048, 'defaultBranch', 'master',
		'mainSha', pg_temp.rec_sha('m1'), 'commits', 5210, 'firstAt', '2025-01-02T03:04:05Z', 'lastAt', '2026-11-12T10:00:00Z',
		'authors30d', 1, 'tags', '{"seen":77,"kept":77}'::jsonb, 'branches', '{"seen":1693,"kept":200}'::jsonb, 'leftOut', 3,
		'files', 4836, 'entries', 5200, 'biggest', '{"path":"docs/big.png","bytes":4000000}'::jsonb,
		'lfs', '{"pointers":0}'::jsonb, 'submodules', 0, 'refused', '{"code":null,"paths":[],"more":0}'::jsonb,
		'secrets', '{"found":1,"shown":[{"kind":"aws","path":null,"inMain":false}],"scan":{"blobs":40000,"bytes":900000000,"all":true}}'::jsonb,
		'fits', true, 'why', null) || p_keys
$$;
create function pg_temp.imp_raw() returns jsonb language sql as $$
	select jsonb_build_object('name', 'import-20261112T150000Z-0123456789ab', 'sha256', repeat('c', 64), 'bytes', 207618048,
		'defaultBranch', 'master', 'mainSha', pg_temp.rec_sha('m1'), 'refs', 1770, 'leftOut', 0)
$$;
create function pg_temp.imp_kept() returns jsonb language sql as $$
	select jsonb_build_object('name', '20261112T151000Z-0123456789ab', 'sha256', repeat('d', 64), 'bytes', 198000000,
		'refsSha256', repeat('e', 64), 'mainSha', pg_temp.rec_sha('m1'), 'refs', 279)
$$;
create function pg_temp.imp_imported(p_keys jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('schema', 'qorpera.code-import-record/v1', 'bundle', '20261112T151000Z-0123456789ab',
		'mainSha', pg_temp.rec_sha('m1'), 'files', 4836) || p_keys
$$;
create function pg_temp.imp_outcome(p_keys jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.req_outcome(jsonb_build_object('state', 'done', 'result', 'imported', 'change', 1,
		'mainSha', pg_temp.rec_sha('m1'), 'bundle', '20261112T151000Z-0123456789ab',
		'rawBundle', 'import-20261112T150000Z-0123456789ab', 'setAside', null) || p_keys)
$$;
-- An import that is not part of the case any more ends (so the company may ask for the next).
create function pg_temp.imp_end(p_id uuid) returns void language sql as $$
	update public.qorpera_code_requests set state = 'failed', lease_token = null, lease_owner = null, lease_until = null,
		finished_at = clock_timestamp(), outcome = '{"schema":"qorpera.code-request-outcome/v1","state":"failed","code":"ENDED"}'
	where id = p_id
$$;
-- A file under code/_incoming/ in the company folder, as a machine's save leaves it.
create function pg_temp.imp_file(p_path text, p_sha256 text) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_folder_entries(environment_id, path, kind, version, commit_id, manifest_sha256, file_sha256,
		bytes, media_type, executable)
	values (pg_temp.rec_here(), p_path, 'file', extensions.gen_random_uuid(), extensions.gen_random_uuid(), repeat('f', 64),
		p_sha256, 1000, 'application/octet-stream', false);
	perform set_config('session_replication_role', 'origin', true);
end $$;
-- A GitHub session copy of repository p_repository (Owner/Name), open or archived.
create function pg_temp.imp_github(p_n integer, p_repository text, p_archived boolean default false) returns uuid
language plpgsql as $$
declare v_id uuid := pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha('h' || p_n), '{}', jsonb_build_object('host', 'github.com',
	'owner', split_part(p_repository, '/', 1), 'name', split_part(p_repository, '/', 2), 'baseBranch', 'main'));
begin
	update public.qorpera_coding_sessions set phase = 'completed', lease_owner = null, lease_token = null, lease_until = null,
		archived_at = case when p_archived then clock_timestamp() end, archived_by = case when p_archived then 'member' end
	where worker_id = v_id;
	return v_id;
end $$;

-- 1. Rights, the tables' rules, the native host's list --------------------------------------------------------------
do $$
declare v_role text; v_function text; v_text text := (select string_agg(md5(i::text), '') from generate_series(1, 600) i);
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_folder_request_code_import(jsonb,jsonb)',
			'public.qorpera_folder_code_import(jsonb,uuid)', 'public.qorpera_code_requests_claim(text,text,integer,text[])',
			'public.qorpera_code_import_looked(text,text,uuid,uuid,jsonb)',
			'public.qorpera_code_import_record(text,text,uuid,uuid,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'service_role'),
				v_function || ' is the service role''s: ' || v_role);
		end loop;
		perform pg_temp.base_assert(has_function_privilege(v_role, 'public.qorpera_request_code_import(uuid,text,text,text)',
			'EXECUTE') = (v_role = 'authenticated'), 'the member''s call is a member''s only: ' || v_role);
		foreach v_function in array array['public.qorpera_code_import_maximum_bytes()',
			'public.qorpera_code_import_from_valid(jsonb)', 'public.qorpera_code_import_from_key(jsonb)',
			'public.qorpera_code_import_lock_key(uuid)', 'public.qorpera_code_import_problem(uuid,jsonb)',
			'public.qorpera_code_import_waits(public.qorpera_code_requests,timestamptz)',
			'public.qorpera_code_import_guard(public.qorpera_runtime_workers)', 'public.qorpera_code_import_path_valid(jsonb)',
			'public.qorpera_code_import_look_valid(jsonb)', 'public.qorpera_code_import_answer(uuid,text)',
			'public.qorpera_code_import_member_source(jsonb)', 'public.qorpera_code_import_member_from(jsonb)',
			'public.qorpera_code_import_ask(uuid,uuid,text,text,jsonb,boolean,text,uuid,uuid,uuid)',
			'public.qorpera_authorize_code_import_fetch(uuid,text,uuid,uuid,text)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'), v_function || ' is internal: ' || v_role);
		end loop;
	end loop;
	perform pg_temp.base_assert(to_regprocedure('public.qorpera_code_requests_claim(text,text,integer)') is null,
		'the three-argument claim is gone');
	perform pg_temp.base_assert(not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
		and proname in ('qorpera_folder_request_code_import', 'qorpera_folder_code_import', 'qorpera_request_code_import',
			'qorpera_code_requests_claim', 'qorpera_code_import_looked', 'qorpera_code_import_record',
			'qorpera_authorize_code_import_fetch', 'qorpera_code_import_ask', 'qorpera_code_import_guard')
		and not (prosecdef and proconfig = array['search_path=""'])), 'definers with an empty search path');
	perform pg_temp.base_assert((select count(*) from public.qorpera_native_host_calls where scope = 'binding'
		and budget = 'standard' and name in ('qorpera_folder_request_code_import', 'qorpera_folder_code_import')) = 2,
		'the native host''s list');
	-- A change of kind import has no main before it.
	perform pg_temp.imp_error('an import change with a main before', $q$update public.qorpera_code_changes set kind = 'import'
		where environment_id = pg_temp.rec_here() and name = 'shop' and n = 1$q$, '23514',
		'new row for relation "qorpera_code_changes" violates check constraint "qorpera_code_changes_import"');
	-- What a repository came from is an object of at most 2 KiB; a request's look at most 16 KiB; the kinds.
	perform pg_temp.imp_error('imported_from an array', $q$update public.qorpera_code_repositories set imported_from = '[]'
		where environment_id = pg_temp.rec_here() and name = 'shop'$q$, '23514', null);
	perform pg_temp.imp_error('imported_from too large', format($q$update public.qorpera_code_repositories
		set imported_from = jsonb_build_object('kind', %L) where environment_id = pg_temp.rec_here() and name = 'shop'$q$,
		left(v_text, 3000)), '23514', null);
	perform pg_temp.imp_error('a look too large', format($q$insert into public.qorpera_code_requests(environment_id, owner,
		name, profile_id, kind, input, by_kind, look) values (pg_temp.rec_here(), 'company', 'x',
		'92400000-0000-4000-8000-000000000010', 'import', '{}', 'agent', jsonb_build_object('x', %L))$q$, left(v_text, 17000)),
		'23514', null);
	perform pg_temp.imp_error('a request of another kind', $q$insert into public.qorpera_code_requests(environment_id, owner,
		name, profile_id, kind, input, by_kind) values (pg_temp.rec_here(), 'company', 'x', '92400000-0000-4000-8000-000000000010',
		'clone', '{}', 'agent')$q$, '23514', null);
end $$;

-- 1b. The shapes the executor reads (C1's codeImport*Of parsers), as literal JSON: a drift on either side shows here.
-- Each literal is one C1's test can take as it is. A look as codeImportLook writes it:
--   {"schema":"qorpera.code-import-look/v1","bytes":207618048,"defaultBranch":"master","mainSha":"<40 hex>",
--    "commits":5210,"firstAt":"2025-01-02T03:04:05Z","lastAt":null,"authors30d":1,"tags":{"seen":77,"kept":77},
--    "branches":{"seen":1693,"kept":200},"leftOut":3,"files":4836,"entries":5200,
--    "biggest":{"path":null,"bytes":4000000},"lfs":{"pointers":2},"submodules":0,
--    "refused":{"code":"IMPORT_USES_LFS","paths":["a.bin",null],"more":5},
--    "secrets":{"found":3,"shown":[{"kind":"env-file","path":".env","inMain":true},{"kind":"aws","path":null,"inMain":false}],
--               "scan":{"blobs":40000,"bytes":900000000,"all":false}},"fits":false,"why":"IMPORT_USES_LFS"}
-- The input of a GitHub source and of a file (qorpera_code_import_ask writes them; codeImportInputOf):
--   {"from":{"github":"Acme/Base"},"via":"connection","look":false,"maximumBytes":1073741824}
--   {"from":{"file":"code/_incoming/f1/shop.bundle","branch":"trunk"},"via":"file","look":false,"maximumBytes":1073741824,
--    "fileSha256":"<64 hex>"}
-- The kernel's recorded (codeImportProgressOf): {"change":1,"bundle":"20261112T151000Z-<12 hex>","mainSha":"<40 hex>"}
-- The outcomes (codeImportOutcomeOf; the finish takes them):
--   {"schema":"qorpera.code-request-outcome/v1","state":"done","result":"imported","change":1,"mainSha":"<40 hex>",
--    "bundle":"20261112T151000Z-<12 hex>","rawBundle":"import-20261112T150000Z-<12 hex>","setAside":null}
--   {"schema":"qorpera.code-request-outcome/v1","state":"done","result":"looked"}
--   {"schema":"qorpera.code-request-outcome/v1","state":"refused","code":"IMPORT_HISTORY_ZERO_PADDED_FILEMODE"}
--   {"schema":"qorpera.code-request-outcome/v1","state":"failed","code":"OPEN_FAILED:PLACE_AS_BEFORE"}
--   {"schema":"qorpera.code-request-outcome/v1","state":"busy"}
-- The record (codeImportRecord): {"schema":"qorpera.code-import-record/v1","bundle":"20261112T151000Z-<12 hex>",
--   "mainSha":"<40 hex>","files":4836}
-- The answers (codeImportLookedAnswer, codeImportRecordedAnswer): {"schema":"qorpera.code-import-looked/v1",
--   "state":"recorded"} or {…,"state":"lost"}; {"schema":"qorpera.code-import-recorded/v1","state":"recorded","change":1}
--   or {"schema":"qorpera.code-import-recorded/v1","state":"lost"}. The claim's item: section 4.
do $$
begin
	perform pg_temp.base_assert(public.qorpera_code_import_look_valid(('{"schema":"qorpera.code-import-look/v1",'
		'"bytes":207618048,"defaultBranch":"master","mainSha":"' || repeat('a', 40) || '","commits":5210,'
		'"firstAt":"2025-01-02T03:04:05Z","lastAt":null,"authors30d":1,"tags":{"seen":77,"kept":77},'
		'"branches":{"seen":1693,"kept":200},"leftOut":3,"files":4836,"entries":5200,"biggest":{"path":null,"bytes":4000000},'
		'"lfs":{"pointers":2},"submodules":0,"refused":{"code":"IMPORT_USES_LFS","paths":["a.bin",null],"more":5},'
		'"secrets":{"found":3,"shown":[{"kind":"env-file","path":".env","inMain":true},'
		'{"kind":"aws","path":null,"inMain":false}],"scan":{"blobs":40000,"bytes":900000000,"all":false}},'
		'"fits":false,"why":"IMPORT_USES_LFS"}')::jsonb), 'C1''s look');
	perform pg_temp.base_assert(public.qorpera_code_import_from_valid('{"github":"Acme/Base"}')
		and public.qorpera_code_import_from_valid('{"file":"code/_incoming/f1/shop.bundle","branch":"trunk"}')
		and public.qorpera_code_import_from_valid(jsonb_build_object('file', 'code/_incoming/f/' || repeat('n', 93) || '.bundle')),
		'C1''s sources');
	perform pg_temp.base_assert(public.qorpera_code_request_outcome_valid('import', ('{"schema":"qorpera.code-request-outcome/v1",'
			'"state":"done","result":"imported","change":1,"mainSha":"' || repeat('a', 40) || '","bundle":"20261112T151000Z-'
			|| repeat('a', 12) || '","rawBundle":"import-20261112T150000Z-' || repeat('a', 12) || '","setAside":null}')::jsonb)
		and public.qorpera_code_request_outcome_valid('import', '{"schema":"qorpera.code-request-outcome/v1","state":"done","result":"looked"}')
		and public.qorpera_code_request_outcome_valid('import', '{"schema":"qorpera.code-request-outcome/v1","state":"refused","code":"IMPORT_HISTORY_ZERO_PADDED_FILEMODE"}')
		and public.qorpera_code_request_outcome_valid('import', '{"schema":"qorpera.code-request-outcome/v1","state":"failed","code":"OPEN_FAILED:PLACE_AS_BEFORE"}')
		and public.qorpera_code_request_outcome_valid('import', '{"schema":"qorpera.code-request-outcome/v1","state":"busy"}'),
		'C1''s outcomes');
end $$;

-- 2. The agent's call ------------------------------------------------------------------------------------------------
-- The company's GitHub connection, sealed by its broker (no grant to Alice yet).
select pg_temp.base_claims('service_role') \g /dev/null
insert into public.qorpera_cloud_secret_broker_authorities(id, profile_id, service_origin, key_id, capability_sha256)
values ('92290000-0000-4000-8000-000000000040', '92400000-0000-4000-8000-000000000010', 'https://broker.example.test',
	'company-kek-1', repeat('9', 64));
do $$
declare v jsonb; v_request jsonb; v_id uuid; v_other uuid; q public.qorpera_code_requests%rowtype;
	e public.qorpera_coding_executors%rowtype;
	v_ok jsonb := jsonb_build_object('operationKey', 'imp-shape', 'owner', 'company', 'name', 'base',
		'from', '{"github":"Acme/Base"}'::jsonb, 'look', false);
begin
	-- Exactly its keys, each of its kind.
	perform pg_temp.imp_invalid('a key missing', v_ok - 'look');
	perform pg_temp.imp_invalid('a key more', v_ok || '{"again":true}');
	perform pg_temp.imp_invalid('an upper-case owner', v_ok || '{"owner":"Company"}');
	perform pg_temp.imp_invalid('a name ending in a dot', v_ok || '{"name":"base."}');
	perform pg_temp.imp_invalid('look not a boolean', v_ok || '{"look":"yes"}');
	perform pg_temp.imp_invalid('a bad operation key', v_ok || '{"operationKey":" x"}');
	perform pg_temp.imp_invalid('from both', v_ok || '{"from":{"github":"Acme/Base","file":"code/_incoming/f/a.bundle"}}');
	perform pg_temp.imp_invalid('from none', v_ok || '{"from":{}}');
	perform pg_temp.imp_invalid('from a string', v_ok || '{"from":"Acme/Base"}');
	perform pg_temp.imp_invalid('github with no name', v_ok || '{"from":{"github":"Acme"}}');
	perform pg_temp.imp_invalid('github with a path', v_ok || '{"from":{"github":"Acme/Base/x"}}');
	perform pg_temp.imp_invalid('a GitHub owner GitHub refuses', v_ok || '{"from":{"github":"-acme/Base"}}');
	perform pg_temp.imp_invalid('a file elsewhere', v_ok || '{"from":{"file":"code/acme/base.bundle"}}');
	perform pg_temp.imp_invalid('a file not a bundle', v_ok || '{"from":{"file":"code/_incoming/f/base.zip"}}');
	perform pg_temp.imp_invalid('a file with ..', v_ok || '{"from":{"file":"code/_incoming/f/a..b.bundle"}}');
	perform pg_temp.imp_invalid('a folder ending in a dot', v_ok || '{"from":{"file":"code/_incoming/f./a.bundle"}}');
	perform pg_temp.imp_invalid('git''s own folder', v_ok || '{"from":{"file":"code/_incoming/Repo.git/a.bundle"}}');
	perform pg_temp.imp_invalid('a name of 94', v_ok || jsonb_build_object('from', jsonb_build_object('file',
		'code/_incoming/f/' || repeat('n', 94) || '.bundle')));
	perform pg_temp.imp_invalid('a bad branch', v_ok || '{"from":{"github":"Acme/Base","branch":"a..b"}}');
	perform pg_temp.imp_invalid('a branch not a string', v_ok || '{"from":{"github":"Acme/Base","branch":1}}');
	perform pg_temp.imp_invalid('another key in from', v_ok || '{"from":{"github":"Acme/Base","look":true}}');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_requests where kind = 'import'),
		'nothing asked yet');

	-- Each refusal, in the company's own rows, and nothing written.
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-kept', 'company', 'shop', pg_temp.imp_gh('Acme/Shop'))
		= pg_temp.imp_refused('kept_here'), 'a repository is kept there');
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values ('92400000-0000-4000-8000-000000000010', null);
	-- A company being deleted: its agents' runs are paused and its members are no members (`deleting`, the call's own
	-- word, is behind both).
	perform pg_temp.imp_error('the agent of a company being deleted', $q$select pg_temp.imp_ask('imp-deleting', 'company',
		'base', pg_temp.imp_gh('Acme/Base'))$q$, '55000', 'Company execution is paused');
	perform pg_temp.imp_error('a member of a company being deleted', format('select pg_temp.imp_member(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000001', 'company', 'base', 'Acme/Base'), '42501', 'Code unavailable');
	delete from public.qorpera_company_deletions where profile_id = '92400000-0000-4000-8000-000000000010';
	-- An open GitHub session at the place, or on the GitHub repository (in any case of its letters): its copy is in use.
	perform pg_temp.imp_github(2901, 'Qorpera/Qorpera_Base');
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-open-1', 'qorpera', 'qorpera_base', pg_temp.imp_gh('Acme/Other'))
		= pg_temp.imp_refused('sessions_open'), 'a GitHub session open at the place');
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-open-2', 'company', 'base', pg_temp.imp_gh('qorpera/QORPERA_BASE'))
		= pg_temp.imp_refused('sessions_open'), 'a GitHub session open on the repository');
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
	where worker_id = pg_temp.rec_copy(2901);
	-- Another company's session is not this company's.
	perform pg_temp.imp_github(2902, 'Acme/Base');
	update public.qorpera_coding_sessions set environment_id = '91170000-0000-4000-8000-000000000020'
	where worker_id = pg_temp.rec_copy(2902);
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-file-missing', 'company', 'fromfile',
		'{"file":"code/_incoming/f1/shop.bundle"}') = pg_temp.imp_refused('file_missing'), 'the file is not there');
	-- No enabled executor; then the company with no executor row is enrolled with the chosen one, its harnesses too.
	update public.qorpera_coding_executors set enabled = false where environment_id = pg_temp.rec_here();
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-no-executor', 'company', 'base', pg_temp.imp_gh('Acme/Base'))
		= pg_temp.imp_refused('no_executor'), 'no executor');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_requests where kind = 'import'),
		'a refusal writes nothing');
	delete from public.qorpera_coding_executors where environment_id = pg_temp.rec_here();
	update public.qorpera_coding_executors set harnesses = array['codex','claude-code'], updated_at = clock_timestamp()
	where environment_id = '91170000-0000-4000-8000-000000000020';
	v := pg_temp.imp_ask('imp-enrol', 'company', 'base', pg_temp.imp_gh('Acme/Base'));
	select * into e from public.qorpera_coding_executors where environment_id = pg_temp.rec_here();
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and e.owner = 'exec-1170' and e.enabled
		and e.harnesses = array['codex','claude-code'] and e.nas_machine_id_sha256 = repeat('5', 64),
		'enrolled with the chosen executor''s harnesses: ' || v::text || ' ' || to_jsonb(e)::text);
	-- The request: the agent's, its input exactly, via public (Alice has no grant on the connection, which no secret
	-- backs yet).
	q := pg_temp.req_row((v ->> 'requestId')::uuid);
	perform pg_temp.base_assert(v = pg_temp.imp_queued(q.id) and q.kind = 'import' and q.state = 'queued'
		and q.environment_id = pg_temp.rec_here() and q.owner = 'company' and q.name = 'base'
		and q.profile_id = '92400000-0000-4000-8000-000000000010' and q.by_kind = 'agent'
		and q.by_agent_id = '92400000-0000-4000-8000-000000000030' and q.by_user_id = '92400000-0000-4000-8000-000000000001'
		and q.run_id = (pg_temp.c3_alice() ->> 'runId')::uuid and q.look is null and q.progress is null and q.attempts = 0
		and q.input = '{"from":{"github":"Acme/Base"},"via":"public","look":false,"maximumBytes":1073741824}',
		'the request: ' || to_jsonb(q)::text);
	-- The same call in the run again: the same answer (the run's receipt). From a later run (another key): the open
	-- import of that place from that source, looking or not as asked, again. Anything else is busy.
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-enrol', 'company', 'base', pg_temp.imp_gh('Acme/Base')) = v
		and pg_temp.imp_ask('imp-again', 'company', 'base', pg_temp.imp_gh('acme/base')) = v
		and pg_temp.imp_ask('imp-again-look', 'company', 'base', pg_temp.imp_gh('Acme/Base'), true) = pg_temp.imp_refused('busy')
		and pg_temp.imp_ask('imp-again-branch', 'company', 'base', '{"github":"Acme/Base","branch":"dev"}') = pg_temp.imp_refused('busy')
		and pg_temp.imp_ask('imp-other', 'company', 'other', pg_temp.imp_gh('Acme/Other')) = pg_temp.imp_refused('busy')
		and (select count(*) from public.qorpera_code_requests where kind = 'import') = 1, 'asked again');
	perform pg_temp.imp_end(q.id);

	-- Via: the connection, once a secret backs it and Alice holds a live grant on it from an owner.
	insert into public.qorpera_cloud_secrets(id, profile_id, environment_id, broker_authority_id, owner_kind, owner_user_id,
		connector_id, secret_name, purpose, current_version, created_by_user_id)
	values ('92290000-0000-4000-8000-000000000061', '92400000-0000-4000-8000-000000000010', pg_temp.rec_here(),
		'92290000-0000-4000-8000-000000000040', 'company', null, 'github', 'primary', 'GitHub account', 1,
		'92400000-0000-4000-8000-000000000001');
	v := pg_temp.imp_ask('imp-via-1', 'company', 'base', pg_temp.imp_gh('Acme/Base'));
	perform pg_temp.base_assert((pg_temp.req_row((v ->> 'requestId')::uuid)).input ->> 'via' = 'public', 'no grant: public');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_cloud_secret_operation_grants(id, profile_id, environment_id, secret_id, staff_agent_id,
		connector_id, operation_id, operation_version, tool_name, issued_by_user_id)
	values ('92290000-0000-4000-8000-000000000062', '92400000-0000-4000-8000-000000000010', pg_temp.rec_here(),
		'92290000-0000-4000-8000-000000000061', '92400000-0000-4000-8000-000000000030', 'github', 'list_repositories', 1,
		'github_list_repositories', '92400000-0000-4000-8000-000000000001');
	perform set_config('session_replication_role', 'origin', true);
	v := pg_temp.imp_ask('imp-via-2', 'company', 'base', pg_temp.imp_gh('Acme/Base'));
	perform pg_temp.base_assert((pg_temp.req_row((v ->> 'requestId')::uuid)).input ->> 'via' = 'connection', 'a grant: connection');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	-- A grant that expired, or one whose issuer is no owner or admin any more, is none.
	update public.qorpera_cloud_secret_operation_grants set created_at = created_at - interval '1 hour',
		expires_at = created_at - interval '30 minutes' where id = '92290000-0000-4000-8000-000000000062';
	v := pg_temp.imp_ask('imp-via-3', 'company', 'base', pg_temp.imp_gh('Acme/Base'));
	perform pg_temp.base_assert((pg_temp.req_row((v ->> 'requestId')::uuid)).input ->> 'via' = 'public', 'an expired grant');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	update public.qorpera_cloud_secret_operation_grants set expires_at = null,
		issued_by_user_id = '92400000-0000-4000-8000-000000000002' where id = '92290000-0000-4000-8000-000000000062';
	v := pg_temp.imp_ask('imp-via-4', 'company', 'base', pg_temp.imp_gh('Acme/Base'));
	perform pg_temp.base_assert((pg_temp.req_row((v ->> 'requestId')::uuid)).input ->> 'via' = 'public', 'an issuer demoted');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	update public.qorpera_cloud_secret_operation_grants set issued_by_user_id = '92400000-0000-4000-8000-000000000001'
	where id = '92290000-0000-4000-8000-000000000062';
	-- A file: its folder entry's bytes are named at once, and the branch asked for is kept.
	perform pg_temp.imp_file('code/_incoming/f1/shop.bundle', repeat('a', 64));
	v := pg_temp.imp_ask('imp-file', 'company', 'fromfile', '{"file":"code/_incoming/f1/shop.bundle","branch":"trunk"}');
	q := pg_temp.req_row((v ->> 'requestId')::uuid);
	perform pg_temp.base_assert(q.input = jsonb_build_object('from', '{"file":"code/_incoming/f1/shop.bundle","branch":"trunk"}'::jsonb,
		'via', 'file', 'look', false, 'maximumBytes', 1073741824, 'fileSha256', repeat('a', 64)), 'a file: ' || q.input::text);
	perform pg_temp.base_assert(pg_temp.req_list() -> 'bringing' -> 0 -> 'from' = '{"file":"shop.bundle"}',
		'a file being brought in, by its name: ' || (pg_temp.req_list() -> 'bringing')::text);
	perform pg_temp.imp_end(q.id);
end $$;

-- 3. The member's call -------------------------------------------------------------------------------------------------
do $$
declare v jsonb; q public.qorpera_code_requests%rowtype; v_user uuid;
begin
	-- Owners and admins only; anybody else, a call with no member, another company: refused.
	foreach v_user in array array['92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000003',
		'92400000-0000-4000-8000-000000000005']::uuid[] loop
		perform pg_temp.imp_error('not an owner or admin', format('select pg_temp.imp_member(%L, %L, %L, %L)', v_user, 'company',
			'base', 'Acme/Base'), '42501', 'Code unavailable');
	end loop;
	perform pg_temp.imp_error('nobody', format('select pg_temp.req_as(null, %L)', $q$public.qorpera_request_code_import(
		'92400000-0000-4000-8000-000000000010', 'company', 'base', 'Acme/Base')$q$), '42501', 'Code unavailable');
	perform pg_temp.imp_error('another company', format('select pg_temp.req_as(%L, %L)', '92400000-0000-4000-8000-000000000001',
		$q$public.qorpera_request_code_import('91170000-0000-4000-8000-000000000010', 'company', 'base', 'Acme/Base')$q$),
		'42501', 'Code unavailable');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.imp_error('the service role', $q$select public.qorpera_request_code_import(
		'92400000-0000-4000-8000-000000000010', 'company', 'base', 'Acme/Base')$q$, '42501', 'Code unavailable');
	-- Its shape.
	perform pg_temp.imp_error('an upper-case place', format('select pg_temp.imp_member(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000001', 'Company', 'base', 'Acme/Base'), '22023', 'Code import request is invalid');
	perform pg_temp.imp_error('a GitHub address', format('select pg_temp.imp_member(%L, %L, %L, %L)',
		'92400000-0000-4000-8000-000000000001', 'company', 'base', 'github.com/Acme/Base'), '22023', 'Code import request is invalid');
	perform pg_temp.imp_error('no GitHub', format('select pg_temp.imp_member(%L, %L, %L, null)',
		'92400000-0000-4000-8000-000000000001', 'company', 'base'), '22023', 'Code import request is invalid');
	-- Queued: the member's, never a look; via the connection (an owner may use the company's).
	v := pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company', 'base', 'Acme/Base');
	q := pg_temp.req_row((v ->> 'requestId')::uuid);
	perform pg_temp.base_assert(v = pg_temp.imp_queued(q.id) and q.by_kind = 'member'
		and q.by_user_id = '92400000-0000-4000-8000-000000000001' and q.by_agent_id is null and q.run_id is null
		and q.input = '{"from":{"github":"Acme/Base"},"via":"connection","look":false,"maximumBytes":1073741824}',
		'the member''s request: ' || to_jsonb(q)::text);
	-- A secret that was revoked is no connection.
	begin
		update public.qorpera_cloud_secrets set status = 'revoked', revoked_at = clock_timestamp()
		where id = '92290000-0000-4000-8000-000000000061';
		perform pg_temp.imp_end(q.id);
		perform pg_temp.base_assert((pg_temp.req_row((pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company',
			'base', 'Acme/Base') ->> 'requestId')::uuid)).input ->> 'via' = 'public', 'a revoked secret: public');
		raise exception 'put back' using errcode = 'QT229';
	exception when sqlstate 'QT229' then null;
	end;
	-- Asked again, by an admin too: the same; another place: busy; the agent's call for the same: the same.
	perform pg_temp.base_assert(pg_temp.imp_member('92400000-0000-4000-8000-000000000004', 'company', 'base', 'ACME/base') = v
		and pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company', 'other', 'Acme/Base') = pg_temp.imp_refused('busy')
		and pg_temp.imp_ask('imp-member-same', 'company', 'base', pg_temp.imp_gh('Acme/Base')) = v, 'the member asks again');
	perform pg_temp.imp_end(q.id);
end $$;

-- 4. The claim ---------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_item jsonb; v_import uuid; v_other uuid; v_undo uuid; q public.qorpera_code_requests%rowtype;
begin
	perform pg_temp.base_error($q$select pg_temp.imp_claim('{}')$q$, '22023', 'Code request kinds invalid');
	perform pg_temp.base_error($q$select pg_temp.imp_claim(array['import','clone'])$q$, '22023', 'Code request kinds invalid');
	perform pg_temp.base_error($q$select pg_temp.imp_claim(array['import',null])$q$, '22023', 'Code request kinds invalid');
	perform pg_temp.base_error($q$select pg_temp.imp_claim(null)$q$, '22023', 'Code request kinds invalid');
	-- An import of this company, then one of Another company (exec-1170 holds both).
	v_import := (pg_temp.imp_ask('imp-claim', 'company', 'base', pg_temp.imp_gh('Acme/Base')) ->> 'requestId')::uuid;
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id)
	values ('91170000-0000-4000-8000-000000000020', 'other', 'thing', '91170000-0000-4000-8000-000000000010', 'import',
		'{"from":{"github":"Other/Thing"},"via":"public","look":false,"maximumBytes":1073741824}', 'member',
		'92400000-0000-4000-8000-000000000001')
	returning id into v_other;
	-- The kinds an old executor names (the three-argument call: its default) never take an import.
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_requests_claim(p_owner => 'exec-1170', p_machine_id_sha256 => repeat('5', 64), p_limit => 20);
	reset role;
	perform pg_temp.base_assert(v -> 'requests' = '[]'::jsonb and (pg_temp.req_row(v_import)).state = 'queued',
		'an old executor''s claim: ' || v::text);
	perform pg_temp.base_assert(pg_temp.imp_claim(array['undo','download','restore']) = '[]'::jsonb, 'no import asked for');
	-- A made download whose time is over is removed only by a claim that takes downloads.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, finished_at,
		expires_at, outcome)
	values (pg_temp.rec_here(), 'company', 'shop', '92400000-0000-4000-8000-000000000010', 'download',
		'{"file":"files","fileName":"shop-old.zip"}', 'done', 'member', clock_timestamp() - interval '8 days',
		clock_timestamp() - interval '1 day', '{"path":"code/company/shop/downloads/shop-old.zip","bytes":1}')
	returning id into v_undo;
	perform set_config('qorpera_test.imp_removal', v_undo::text, false);
	perform pg_temp.base_assert(pg_temp.imp_claim(array['undo','restore']) = '[]'::jsonb, 'no removal without downloads');
	-- One open import a company, whoever asks it.
	perform pg_temp.imp_error('a second open import', $q$insert into public.qorpera_code_requests(environment_id, owner, name,
		profile_id, kind, input, by_kind) values (pg_temp.rec_here(), 'company', 'second', '92400000-0000-4000-8000-000000000010',
		'import', '{}', 'member')$q$, '23505',
		'duplicate key value violates unique constraint "qorpera_code_requests_one_import"');
	-- One import a claim.
	v := pg_temp.imp_claim(array['import']);
	v_item := v -> 0;
	q := pg_temp.req_row(v_import);
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v_item = jsonb_build_object('requestId', v_import,
			'token', q.lease_token, 'leaseUntil', q.lease_until, 'companyId', '92400000-0000-4000-8000-000000000010',
			'environmentId', pg_temp.rec_here(), 'owner', 'company', 'name', 'base', 'kind', 'import', 'input', q.input,
			'progress', null, 'looked', null)
		and q.state = 'running' and q.attempts = 1
		and q.lease_until between clock_timestamp() + interval '14 minutes' and clock_timestamp() + interval '15 minutes'
		and (pg_temp.req_row(v_other)).state = 'queued', 'one import, its item, 15 minutes: ' || v::text);
	-- The next claim takes the other company's.
	v := pg_temp.imp_claim(array['import']);
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v -> 0 ->> 'requestId' = v_other::text, 'the next import');
	perform pg_temp.imp_end(v_other);
	-- While this company's import runs, none of its other requests is claimed; another company's are.
	v_undo := (pg_temp.req_undo('imp-undo', 6) ->> 'requestId')::uuid;
	perform pg_temp.base_assert(pg_temp.imp_claim() = '[]'::jsonb and (pg_temp.req_row(v_undo)).state = 'queued',
		'an undo waits for the import, and so does the removal');
	-- The import's lease runs out: a claim of undos alone takes the undo then; it goes back in the queue for the cases
	-- below.
	perform pg_temp.req_lapse(v_import);
	v := pg_temp.imp_claim(array['undo']);
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v -> 0 ->> 'requestId' = v_undo::text,
		'an import whose lease ran out holds nothing back: ' || v::text);
	update public.qorpera_code_requests set state = 'queued', lease_token = null, lease_owner = null, lease_until = null,
		attempts = 0 where id = v_undo;
	-- Claimed again, the import comes first (the older), and so the undo still waits. Once it ended, the undo is claimed.
	v := pg_temp.imp_claim();
	perform pg_temp.base_assert(jsonb_array_length(v) = 1 and v -> 0 ->> 'requestId' = v_import::text
		and (pg_temp.req_row(v_undo)).state = 'queued', 'after the lease: ' || v::text);
	perform pg_temp.imp_end(v_import);
	v := pg_temp.imp_claim();
	perform pg_temp.base_assert(jsonb_array_length(v) = 2 and v -> 0 ->> 'requestId' = v_undo::text
		and v -> 1 ->> 'work' = 'remove' and v -> 1 ->> 'requestId' = current_setting('qorpera_test.imp_removal'),
		'the undo and the removal: ' || v::text);
	perform pg_temp.req_finish(v_undo, (v -> 0 ->> 'token')::uuid, pg_temp.req_outcome(jsonb_build_object('state', 'done',
		'result', 'nothing', 'mainSha', pg_temp.rec_sha('c5'))));
end $$;

-- 5 to 9. One import through its life: the quiet wait, the step, the look, the record, the finish ------------------------
-- Alice brings Qorpera/Qorpera_Base in as company/base. Its GitHub session 2901 is archived (section 2).
do $$
declare v jsonb; v_id uuid; v_item jsonb; v_token uuid; q public.qorpera_code_requests%rowtype; r public.qorpera_code_repositories%rowtype;
	c public.qorpera_code_changes%rowtype; v_progress jsonb;
begin
	v_id := (pg_temp.imp_ask('imp-life', 'company', 'base', pg_temp.imp_gh('Qorpera/Qorpera_Base')) ->> 'requestId')::uuid;
	perform set_config('qorpera_test.imp_life', v_id::text, false);
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text, 'the import is claimed');
	-- The fetch (no quiet needed: it runs in the executor alone).
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, '{"step":"fetch"}') ->> 'state' = 'go', 'the fetch goes');
	-- The step that first names the look waits for quiet: back in the queue with what it brought and the word, its claim
	-- given back, its lease ended (the finish that follows is lost).
	v := pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw()));
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-request-step/v1","state":"busy"}' and q.state = 'queued'
		and q.attempts = 0 and q.lease_token is null
		and q.progress = jsonb_build_object('step', 'fetch', 'raw', pg_temp.imp_raw(), 'waiting', 'SESSIONS_BUSY'),
		'the look waits: ' || to_jsonb(q)::text);
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"busy"}'))
		= '{"schema":"qorpera.code-request-finish/v1","state":"lost"}', 'the finish after it is lost');
	-- The claim waits too, and uses up no claim; it says why.
	perform pg_temp.base_assert(pg_temp.imp_claim(array['import']) = '[]'::jsonb and (pg_temp.req_row(v_id)).attempts = 0
		and (pg_temp.req_row(v_id)).progress ->> 'waiting' = 'SESSIONS_BUSY', 'the claim waits');
	-- Quiet, but a GitHub session of that code is open (on the repository it brings in, at another place).
	perform pg_temp.req_quiet();
	update public.qorpera_coding_sessions set archived_at = null, archived_by = null where worker_id = pg_temp.rec_copy(2901);
	perform pg_temp.base_assert(pg_temp.imp_claim(array['import']) = '[]'::jsonb
		and (pg_temp.req_row(v_id)).progress ->> 'waiting' = 'SESSIONS_OPEN' and (pg_temp.req_row(v_id)).attempts = 0,
		'an open GitHub session of that code');
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
	where worker_id = pg_temp.rec_copy(2901);
	-- And an open GitHub copy at the place itself.
	perform pg_temp.imp_github(2903, 'Company/Base');
	perform pg_temp.base_assert(pg_temp.imp_claim(array['import']) = '[]'::jsonb
		and (pg_temp.req_row(v_id)).progress ->> 'waiting' = 'SESSIONS_OPEN', 'an open GitHub session at the place');
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'member'
	where worker_id = pg_temp.rec_copy(2903);
	-- Quiet: claimed (one claim), the progress handed out with it, the word gone.
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and v_item -> 'progress'
			= jsonb_build_object('step', 'fetch', 'raw', pg_temp.imp_raw()) and v_item -> 'looked' = 'null'
		and (pg_temp.req_row(v_id)).attempts = 1, 'claimed once quiet: ' || coalesce(v_item::text, 'none'));
	perform set_config('qorpera_test.imp_token', v_token::text, false);
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'look')) ->> 'state' = 'go'
		and (pg_temp.req_row(v_id)).progress = jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw()),
		'the look goes, and the step keeps raw');
	-- From there the look is let go whatever the sessions do.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = '91170000-0000-4000-8000-0000000000b1';
	perform pg_temp.base_assert(pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'look', 'raw', '{"name":"x"}'))
		->> 'state' = 'go', 'a later step of the look goes');
	perform pg_temp.req_quiet();

	-- 6. The step keeps raw and kept once written: neither changed nor taken away by the caller.
	perform pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'close', 'kept', pg_temp.imp_kept()));
	perform pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'build', 'kept', '{"name":"other"}', 'raw', null,
		'built', true));
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).progress = jsonb_build_object('step', 'build', 'built', true,
		'raw', pg_temp.imp_raw(), 'kept', pg_temp.imp_kept()), 'kept and raw stay: ' || (pg_temp.req_row(v_id)).progress::text);

	-- 7. The look: its shape exactly, at most 16,000 bytes; once (the same again is fine); the lease's; an import's.
	perform pg_temp.imp_error('a look of another schema', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look('{"schema":"x"}')), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a look with a key more', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look('{"more":1}')), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a look with a key less', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look() - 'fits'), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a path over 200 bytes', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look(jsonb_build_object('biggest', jsonb_build_object('path', repeat('p', 201), 'bytes', 1)))),
		'22023', 'Code import look invalid');
	perform pg_temp.imp_error('31 strings shown', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look(jsonb_build_object('secrets', jsonb_build_object('found', 31, 'shown', (select jsonb_agg(
			'{"kind":"aws","path":null,"inMain":true}'::jsonb) from generate_series(1, 31)),
			'scan', '{"blobs":1,"bytes":1,"all":true}'::jsonb)))), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('11 refused paths', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look(jsonb_build_object('refused', jsonb_build_object('code', 'IMPORT_USES_LFS',
			'paths', (select jsonb_agg('a.bin'::text) from generate_series(1, 11)), 'more', 0)))), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a refusal code of another form', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look('{"refused":{"code":"lfs","paths":[],"more":0}}')), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('refused with no more', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look('{"refused":{"code":null,"paths":[]}}')), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a long default branch', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look(jsonb_build_object('defaultBranch', repeat('b', 201)))), '22023', 'Code import look invalid');
	perform pg_temp.base_assert(pg_temp.imp_looked(v_id, '91210000-0000-4000-8000-0000000000ff', pg_temp.imp_look())
			= '{"schema":"qorpera.code-import-looked/v1","state":"lost"}'
		and pg_temp.imp_looked(v_id, v_token, pg_temp.imp_look(), 'exec-other')
			= '{"schema":"qorpera.code-import-looked/v1","state":"lost"}' and (pg_temp.req_row(v_id)).look is null,
		'another lease is lost');
	-- The record needs the look first.
	perform pg_temp.imp_error('a record before the look', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_imported()), '22023', 'Code import record invalid');
	perform pg_temp.base_assert(pg_temp.imp_looked(v_id, v_token, pg_temp.imp_look())
			= '{"schema":"qorpera.code-import-looked/v1","state":"recorded"}'
		and (pg_temp.req_row(v_id)).look = pg_temp.imp_look()
		and pg_temp.imp_looked(v_id, v_token, pg_temp.imp_look()) ->> 'state' = 'recorded', 'the look, and the same again');
	perform pg_temp.imp_error('another look after it', format('select pg_temp.imp_looked(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_look('{"commits":1}')), '22023', 'Code import look invalid');
	perform pg_temp.imp_error('a look of an undo', format('select pg_temp.imp_looked(%L, %L, %L)',
		(select id from public.qorpera_code_requests where kind = 'undo' limit 1), null, pg_temp.imp_look()), '22023',
		'Code import look invalid');

	-- 8. The record. Its shape, the lease's, the bundle the look made.
	perform pg_temp.imp_error('a record of another shape', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_imported('{"more":1}')), '22023', 'Code import record invalid');
	perform pg_temp.imp_error('another bundle', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_imported('{"bundle":"20261112T151000Z-aaaaaaaaaaaa"}')), '22023', 'Code import record invalid');
	perform pg_temp.imp_error('another main', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_imported(jsonb_build_object('mainSha', pg_temp.rec_sha('m2')))), '22023', 'Code import record invalid');
	perform pg_temp.base_assert(pg_temp.imp_record(v_id, '91210000-0000-4000-8000-0000000000ff', pg_temp.imp_imported())
		= '{"schema":"qorpera.code-import-recorded/v1","state":"lost"}', 'another lease');
	-- Before: Alice's grant of Qorpera/Qorpera_Base (from 1170) is on, and so are a GitHub grant at the place (an agent's
	-- copy of Company/Base) and one of another company; a grant kept in Qorpera is no GitHub one.
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled) values
		(pg_temp.rec_here(), '92400000-0000-4000-8000-000000000031', '{"host":"github.com","owner":"Company","name":"Base","baseBranch":"main"}', true),
		('91170000-0000-4000-8000-000000000020', '92400000-0000-4000-8000-000000000030', pg_temp.c3_repo(), true),
		(pg_temp.rec_here(), '92400000-0000-4000-8000-000000000031', pg_temp.own_repo('company', 'base'), true);
	perform set_config('session_replication_role', 'origin', true);
	v := pg_temp.imp_record(v_id, v_token, pg_temp.imp_imported());
	select * into r from public.qorpera_code_repositories where environment_id = pg_temp.rec_here() and name = 'base';
	select * into c from public.qorpera_code_changes where environment_id = pg_temp.rec_here() and name = 'base' and n = 1;
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-import-recorded/v1","state":"recorded","change":1}'
		and r.owner = 'company' and r.profile_id = '92400000-0000-4000-8000-000000000010' and r.care_enabled
		and r.next_care_at <= clock_timestamp() and r.main_sha = pg_temp.rec_sha('m1') and r.last_main = pg_temp.rec_sha('m1')
		and r.last_change = 1 and r.index_version > r.index_written and r.imported_at is not null
		and r.imported_from = jsonb_build_object('kind', 'github', 'repository', 'Qorpera/Qorpera_Base', 'via', 'connection',
			'branch', 'master', 'commit', pg_temp.rec_sha('m1'), 'commits', 5210), 'the registry row: ' || to_jsonb(r)::text);
	perform pg_temp.base_assert(c.kind = 'import' and c.state = 'landed' and c.main_before is null
		and c.main_after = pg_temp.rec_sha('m1') and c.request_id = v_id and c.staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and c.owner_user_id is null and c.title = 'Brought in from GitHub: Qorpera/Qorpera_Base' and c.checks_state = 'not_run'
		and c.checks is null and c.files_changed = 4836 and c.worker_id is null and c.file_written < c.file_version,
		'change 1: ' || to_jsonb(c)::text);
	perform pg_temp.base_assert(not (select g.enabled from public.qorpera_coding_repository_grants g
			where g.environment_id = pg_temp.rec_here() and g.staff_agent_id = '92400000-0000-4000-8000-000000000030'
				and g.repository = pg_temp.c3_repo())
		and not (select g.enabled from public.qorpera_coding_repository_grants g where g.environment_id = pg_temp.rec_here()
			and g.repository ->> 'owner' = 'Company' and g.repository ->> 'name' = 'Base')
		and (select g.enabled from public.qorpera_coding_repository_grants g
			where g.environment_id = '91170000-0000-4000-8000-000000000020' and g.repository = pg_temp.c3_repo())
		and (select g.enabled from public.qorpera_coding_repository_grants g where g.environment_id = pg_temp.rec_here()
			and g.repository = pg_temp.own_repo('company', 'base')), 'GitHub''s grants of that code are off, no other');
	perform pg_temp.base_assert((pg_temp.req_row(v_id)).progress -> 'recorded' = jsonb_build_object('change', 1,
		'bundle', '20261112T151000Z-0123456789ab', 'mainSha', pg_temp.rec_sha('m1')), 'what it recorded');
	-- Again, by the same request: what it recorded, and nothing more.
	perform pg_temp.base_assert(pg_temp.imp_record(v_id, v_token, pg_temp.imp_imported()) = v
		and (select count(*) from public.qorpera_code_changes where environment_id = pg_temp.rec_here() and name = 'base') = 1,
		'recorded again');
	-- The record files say what came with change 1; no other change has it.
	perform pg_temp.base_assert(pg_temp.rec_files(p_name => 'base') -> 'changes' -> 0 -> 'importedFrom' = r.imported_from
		and pg_temp.rec_files(p_name => 'base') -> 'changes' -> 0 ->> 'kind' = 'import'
		and not ((pg_temp.rec_files(p_name => 'base') -> 'changes' -> 0 ->> 'needsDiff')::boolean)
		and not exists (select 1 from jsonb_array_elements(pg_temp.rec_files(p_name => 'shop') -> 'changes') change
			where change -> 'importedFrom' <> 'null'::jsonb), 'the record files: ' || pg_temp.rec_files(p_name => 'base')::text);

	-- 9. The finish. Once recorded: only brought in (as recorded) or put off.
	perform pg_temp.imp_error('refused once recorded', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_outcome('{"state":"refused","code":"IMPORT_USES_LFS"}')), '55000', 'Code import is recorded');
	perform pg_temp.imp_error('failed once recorded', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_outcome('{"state":"failed","code":"OPEN_FAILED"}')), '55000', 'Code import is recorded');
	perform pg_temp.imp_error('looked once recorded', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_outcome('{"state":"done","result":"looked"}')), '55000', 'Code import is recorded');
	perform pg_temp.imp_error('another bundle than recorded', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome('{"bundle":"20261112T151000Z-aaaaaaaaaaaa"}')), '55000', 'Code import is not recorded');
	perform pg_temp.imp_error('another main than recorded', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome(jsonb_build_object('mainSha', pg_temp.rec_sha('m2')))), '55000', 'Code import is not recorded');
	-- The shapes.
	perform pg_temp.imp_error('a change other than 1', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome('{"change":2}')), '22023', 'Code request outcome invalid');
	perform pg_temp.imp_error('no setAside', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome() - 'setAside'), '22023', 'Code request outcome invalid');
	perform pg_temp.imp_error('a set-aside elsewhere', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome('{"setAside":"code/company/base"}')), '22023', 'Code request outcome invalid');
	perform pg_temp.imp_error('a first bundle of another name', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome('{"rawBundle":"20261112T150000Z-0123456789ab"}')), '22023', 'Code request outcome invalid');
	perform pg_temp.imp_error('a refusal code of another form', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_outcome('{"state":"refused","code":"RESTORE_X"}')), '22023', 'Code request outcome invalid');
	perform pg_temp.imp_error('a restore''s result', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_restore_outcome('20261112T151000Z-0123456789ab', 'm1')), '22023', 'Code request outcome invalid');
	v := pg_temp.req_finish(v_id, v_token, pg_temp.imp_outcome(jsonb_build_object('setAside',
		'code/_set-aside/qorpera/at-20261112T152000Z/qorpera_base')));
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(v = pg_temp.req_recorded(1) and q.state = 'done' and q.lease_token is null
		and q.finished_at is not null and q.outcome = pg_temp.imp_outcome(jsonb_build_object('setAside',
			'code/_set-aside/qorpera/at-20261112T152000Z/qorpera_base')), 'brought in: ' || to_jsonb(q)::text);
	-- A finish for a request that is gone may be an import's: lost.
	perform pg_temp.base_assert(pg_temp.req_finish('91210000-0000-4000-8000-00000000fffe', v_token, pg_temp.imp_outcome())
		= '{"schema":"qorpera.code-request-finish/v1","state":"lost"}'
		and pg_temp.req_finish('91210000-0000-4000-8000-00000000fffe', v_token,
			pg_temp.req_outcome('{"state":"refused","code":"IMPORT_USES_LFS"}'))
			= '{"schema":"qorpera.code-request-finish/v1","state":"lost"}', 'a gone request');
end $$;

-- 9 (cont.). A look only ends looked; brought in only when it is no look; refused before anything moved; busy.
do $$
declare v_id uuid; v_item jsonb; v_token uuid; q public.qorpera_code_requests%rowtype;
begin
	v_id := (pg_temp.imp_ask('imp-look', 'company', 'looked', pg_temp.imp_gh('Acme/Looked'), true) ->> 'requestId')::uuid;
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.base_assert((v_item -> 'input' ->> 'look')::boolean, 'a look is claimed');
	perform pg_temp.imp_error('looked with no look', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.req_outcome('{"state":"done","result":"looked"}')), '22023', 'Code request outcome invalid');
	perform pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw()));
	perform pg_temp.imp_looked(v_id, v_token, pg_temp.imp_look());
	perform pg_temp.req_step(v_id, v_token, jsonb_build_object('step', 'close', 'kept', pg_temp.imp_kept()));
	perform pg_temp.imp_error('a look that records', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_imported()), '22023', 'Code import record invalid');
	perform pg_temp.imp_error('a look brought in', format('select pg_temp.req_finish(%L, %L, %L)', v_id, v_token,
		pg_temp.imp_outcome()), '55000', 'Code import is not recorded');
	-- Put off: back in the queue for two minutes, its look kept.
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"busy"}')) = pg_temp.req_recorded(null)
		and (pg_temp.req_row(v_id)).state = 'queued' and (pg_temp.req_row(v_id)).not_before > clock_timestamp() + interval '1 minute'
		and (pg_temp.req_row(v_id)).look = pg_temp.imp_look(), 'put off');
	perform pg_temp.req_now(v_id);
	-- Its look is in: it is claimed again even while the company's sessions work.
	update public.qorpera_coding_sessions set phase = 'running' where worker_id = '91170000-0000-4000-8000-0000000000b1';
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	v_token := (v_item ->> 'token')::uuid;
	perform pg_temp.req_quiet();
	perform pg_temp.base_assert(v_item -> 'looked' = pg_temp.imp_look() and v_item -> 'progress' -> 'kept' = pg_temp.imp_kept(),
		'claimed again with its look, while sessions work: ' || coalesce(v_item::text, 'none'));
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"done","result":"looked"}'))
		= pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'done'
		and (pg_temp.req_row(v_id)).outcome = pg_temp.req_outcome('{"state":"done","result":"looked"}'), 'looked');
	perform set_config('qorpera_test.imp_look', v_id::text, false);
	-- Refused with its code, before anything moved; the place keeps no row.
	v_id := (pg_temp.imp_ask('imp-refused', 'company', 'lfs', pg_temp.imp_gh('Acme/Lfs')) ->> 'requestId')::uuid;
	v_token := (pg_temp.imp_claim(array['import']) -> 0 ->> 'token')::uuid;
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, v_token, pg_temp.req_outcome('{"state":"refused","code":"IMPORT_USES_LFS"}'))
		= pg_temp.req_recorded(null) and (pg_temp.req_row(v_id)).state = 'refused'
		and not exists (select 1 from public.qorpera_code_repositories where environment_id = pg_temp.rec_here() and name = 'lfs'),
		'refused');
end $$;

-- 10. Afterwards --------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_life uuid := current_setting('qorpera_test.imp_life')::uuid; v_look uuid := current_setting('qorpera_test.imp_look')::uuid;
	v_entry jsonb; v_id uuid; v_restore uuid; v_item jsonb;
begin
	-- Asked again, from a later run: what was recorded; a look of the last 30 minutes when looking again (not when the
	-- code is to come in, nor later than that); the GitHub repository elsewhere is already here; the place is kept.
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-after-1', 'company', 'base', pg_temp.imp_gh('qorpera/qorpera_base'))
			= pg_temp.imp_queued(v_life)
		and pg_temp.imp_ask('imp-after-2', 'company', 'base', pg_temp.imp_gh('Acme/Base')) = pg_temp.imp_refused('kept_here')
		and pg_temp.imp_ask('imp-after-3', 'company', 'base2', pg_temp.imp_gh('Qorpera/Qorpera_Base'))
			= pg_temp.imp_refused('already_here')
		and pg_temp.imp_ask('imp-after-4', 'company', 'looked', pg_temp.imp_gh('acme/looked'), true) = pg_temp.imp_queued(v_look)
		and pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company', 'base', 'Qorpera/Qorpera_Base')
			= pg_temp.imp_queued(v_life), 'asked again afterwards');
	-- The list: nothing being brought in (looks are not), the last import of the day that did not come in, what each
	-- repository came from. An import that came in later, or a day gone, and there is none.
	v := pg_temp.req_list();
	perform pg_temp.base_assert(v -> 'bringing' = '[]'::jsonb
		and v -> 'lastImport' = '{"owner":"company","name":"lfs","from":{"github":"Acme/Lfs"},"state":"refused","reason":"IMPORT_USES_LFS"}'
		and (select r from jsonb_array_elements(v -> 'repositories') r where r ->> 'name' = 'base')
			- 'downloads' = jsonb_build_object('owner', 'company', 'name', 'base', 'changes', 1,
				'importedFrom', '{"kind":"github","repository":"Qorpera/Qorpera_Base"}'::jsonb,
				'importedAt', (select imported_at from public.qorpera_code_repositories where name = 'base'), 'earlierChanges', 5210)
		and (select r -> 'importedFrom' from jsonb_array_elements(v -> 'repositories') r where r ->> 'name' = 'shop') = 'null',
		'the list: ' || v::text);
	update public.qorpera_code_requests set finished_at = clock_timestamp() where id = v_life;
	perform pg_temp.base_assert(pg_temp.req_list() -> 'lastImport' = 'null', 'an import came in later');
	update public.qorpera_code_requests set finished_at = clock_timestamp() - interval '25 hours'
	where kind = 'import' and state <> 'done';
	update public.qorpera_code_requests set finished_at = clock_timestamp() - interval '26 hours' where id = v_life;
	perform pg_temp.base_assert(pg_temp.req_list() -> 'lastImport' = 'null', 'a day gone');
	update public.qorpera_code_requests set state = 'failed', finished_at = clock_timestamp(),
		outcome = pg_temp.req_outcome('{"state":"failed","code":"LOOK_FAILED"}') where id = v_look;
	perform pg_temp.base_assert(pg_temp.req_list() -> 'lastImport' = 'null', 'a look that failed is no import''s end');
	update public.qorpera_code_requests set state = 'done', finished_at = clock_timestamp(),
		outcome = pg_temp.req_outcome('{"state":"done","result":"looked"}') where id = v_look;
	v := pg_temp.imp_ask('imp-after-4b', 'company', 'looked', pg_temp.imp_gh('Acme/Other'), true);
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v ->> 'requestId' <> v_look::text, 'a look of another source: a new one');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	v := pg_temp.imp_ask('imp-after-5', 'company', 'looked', pg_temp.imp_gh('Acme/Looked'));
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v ->> 'requestId' <> v_look::text, 'to come in: a new import');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	update public.qorpera_code_requests set finished_at = clock_timestamp() - interval '31 minutes' where id = v_look;
	v := pg_temp.imp_ask('imp-after-6', 'company', 'looked', pg_temp.imp_gh('Acme/Looked'), true);
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v ->> 'requestId' <> v_look::text, 'an older look: a new one');
	perform pg_temp.base_assert(pg_temp.req_list() -> 'bringing' = '[]'::jsonb, 'a look is not brought in');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	-- A file: the import that recorded it answers for the same bytes; other bytes at its place are kept_here. A file's
	-- look of the last 30 minutes answers while the file is the same bytes.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, finished_at)
	values (pg_temp.rec_here(), 'company', 'frombundle', '92400000-0000-4000-8000-000000000010', 'import',
		jsonb_build_object('from', '{"file":"code/_incoming/f2/x.bundle"}'::jsonb, 'via', 'file', 'look', false,
			'maximumBytes', 1073741824, 'fileSha256', repeat('b', 64)), 'done', 'agent', clock_timestamp())
	returning id into v_id;
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'frombundle', jsonb_build_object('kind',
		'file', 'name', 'x.bundle', 'sha256', repeat('b', 64), 'branch', 'main', 'commit', pg_temp.rec_sha('x'), 'commits', 2),
		clock_timestamp());
	insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id, kind, state, main_after, request_id, title)
	values (pg_temp.rec_here(), 'company', 'frombundle', 1, '92400000-0000-4000-8000-000000000010', 'import', 'landed',
		pg_temp.rec_sha('x'), v_id, 'Brought in from x.bundle');
	perform pg_temp.imp_file('code/_incoming/f2/x.bundle', repeat('b', 64));
	perform pg_temp.base_assert((select r -> 'importedFrom' from jsonb_array_elements(pg_temp.req_list() -> 'repositories') r
		where r ->> 'name' = 'frombundle') = '{"kind":"file","name":"x.bundle"}', 'a file''s importedFrom, by its name');
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-file-again', 'company', 'frombundle', '{"file":"code/_incoming/f2/x.bundle"}')
			= pg_temp.imp_queued(v_id)
		and pg_temp.imp_ask('imp-file-other', 'company', 'frombundle', '{"file":"code/_incoming/f1/shop.bundle"}')
			= pg_temp.imp_refused('kept_here'), 'a file asked again');
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, finished_at,
		outcome)
	values (pg_temp.rec_here(), 'company', 'lookfile', '92400000-0000-4000-8000-000000000010', 'import',
		jsonb_build_object('from', '{"file":"code/_incoming/f1/shop.bundle"}'::jsonb, 'via', 'file', 'look', true,
			'maximumBytes', 1073741824, 'fileSha256', repeat('a', 64)), 'done', 'agent', clock_timestamp(),
		pg_temp.req_outcome('{"state":"done","result":"looked"}'))
	returning id into v_id;
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-file-look', 'company', 'lookfile', '{"file":"code/_incoming/f1/shop.bundle"}',
		true) = pg_temp.imp_queued(v_id), 'a file''s look');
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_folder_entries set file_sha256 = repeat('c', 64) where environment_id = pg_temp.rec_here()
		and path = 'code/_incoming/f1/shop.bundle';
	perform set_config('session_replication_role', 'origin', true);
	v := pg_temp.imp_ask('imp-file-look-2', 'company', 'lookfile', '{"file":"code/_incoming/f1/shop.bundle"}', true);
	perform pg_temp.base_assert(v ->> 'state' = 'queued' and v ->> 'requestId' <> v_id::text, 'other bytes: a new look');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	-- Being brought in, for every member, viewers too.
	v := pg_temp.imp_member('92400000-0000-4000-8000-000000000001', 'company', 'web', 'Acme/Web');
	perform pg_temp.base_assert(pg_temp.req_list('92400000-0000-4000-8000-000000000003') -> 'bringing'
		= jsonb_build_array(jsonb_build_object('owner', 'company', 'name', 'web', 'from', '{"github":"Acme/Web"}'::jsonb, 'step', null,
			'waiting', null, 'startedAt', (pg_temp.req_row((v ->> 'requestId')::uuid)).created_at)), 'bringing: '
		|| pg_temp.req_list()::text);
	-- No download while it comes in: there is no repository yet.
	perform pg_temp.imp_error('a download of a place being brought in', format('select pg_temp.req_ask(%L, %L, %L)', 'files',
		'92400000-0000-4000-8000-000000000001', 'web'), 'P0002', 'No such repository');
	perform pg_temp.imp_error('an undo there', $q$select pg_temp.req_undo('imp-undo-web', 1, p_name => 'web')$q$, 'P0002',
		'No such change');
	perform pg_temp.imp_error('a restore there', $q$select pg_temp.req_restore('verify', '20261112T151000Z-0123456789ab',
		null, 'x', 'web')$q$, 'P0002', 'No such repository');
	perform pg_temp.imp_end((v ->> 'requestId')::uuid);
	-- The agent's read, and the request read refuses an import.
	perform pg_temp.base_assert(pg_temp.imp_read(v_life) = jsonb_build_object('schema', 'qorpera.code-import/v1',
		'requestId', v_life, 'owner', 'company', 'name', 'base', 'state', 'done', 'step', 'build', 'waiting', null,
		'look', pg_temp.imp_look(), 'result', 'imported', 'change', 1, 'code', null), 'the agent''s read: ' || pg_temp.imp_read(v_life)::text);
	perform pg_temp.imp_error('the read of another company''s', format('select pg_temp.imp_read(%L)',
		(select id from public.qorpera_code_requests where owner = 'other' and name = 'thing')), 'P0002', 'No such code import');
	perform pg_temp.imp_error('the read of an undo', format('select pg_temp.imp_read(%L)',
		(select id from public.qorpera_code_requests where kind = 'undo' limit 1)), 'P0002', 'No such code import');
	perform pg_temp.imp_error('the request read of an import', format('select pg_temp.req_read(%L)', v_life), 'P0002',
		'No such code request');
	-- Undo stops at change 1: nothing of main came before it.
	perform pg_temp.base_assert(pg_temp.req_undo('imp-undo-1', 1, p_name => 'base') = pg_temp.req_refused('wall')
		and pg_temp.req_undo('imp-undo-1-later', 1, true, p_name => 'base') = pg_temp.req_refused('wall'), 'undo of change 1');
	-- A landing on it, then a restore to its first copy: change 1 is landed still, the landing is lost.
	perform pg_temp.rec_land(2950, 'm1', 'm3', p_name => 'base');
	perform pg_temp.base_assert((select change -> 'importedFrom' from jsonb_array_elements(pg_temp.rec_files(p_name => 'base')
		-> 'changes') change where change ->> 'n' = '2') = 'null', 'a landing on code brought in has no importedFrom');
	perform pg_temp.base_assert(pg_temp.req_restore_to('20261112T151000Z-0123456789ab', 'm1', 'base', 'm3')
		= pg_temp.req_restored(3, 1, 1, 0) and pg_temp.req_rows('base') = '1:L 2:- 3:L', 'a later restore: '
		|| pg_temp.req_rows('base'));
end $$;

-- 11. The dispatch and reopen rules ------------------------------------------------------------------------------------
do $$
declare
	v_alice jsonb := pg_temp.c3_alice(); v_brief jsonb; v_result jsonb; v_id uuid; v_gh uuid := '92290000-0000-4000-8000-0000000000b1';
	v_folder text := 'QorperaOS/agents/alice/todos/fix-login/gh-1229';
	v_wait text := 'Code is being brought in at code/company/kept; wait until it is in';
begin
	perform pg_temp.base_claims('service_role');
	perform pg_temp.req_quiet();
	-- Another company's open import at code/qorpera/qorpera_base, and its repository brought in from Qorpera/Qorpera_Base:
	-- none of this company's.
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind)
	values ('91170000-0000-4000-8000-000000000020', 'qorpera', 'qorpera_base', '91170000-0000-4000-8000-000000000010', 'import',
		'{"from":{"github":"Qorpera/Qorpera_Base"},"via":"public","look":false,"maximumBytes":1073741824}', 'member');
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
	values ('91170000-0000-4000-8000-000000000020', '91170000-0000-4000-8000-000000000010', 'acme', 'origin',
		'{"kind":"github","repository":"Qorpera/Qorpera_Base","via":"public","branch":"main","commit":null,"commits":1}',
		clock_timestamp());
	-- A GitHub dispatch at a place begun in Qorpera keeps its own words.
	v_brief := pg_temp.c3_brief('92290000-0000-4000-8000-0000000000b8')
		|| '{"repository":{"host":"github.com","owner":"Company","name":"Shop","baseBranch":"main"}}';
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-gh-8', v_folder || '-8', v_brief), v_brief,
		'The company keeps a repository of its own in Qorpera at code/company/shop; use that one (host qorpera), or a GitHub repository with another owner or name');
	-- Alice's GitHub session of Qorpera/Qorpera_Base at code/qorpera/qorpera_base, which is not brought in: her grant
	-- goes back on (the record above turned it off), she dispatches it, it is cancelled and archived.
	update public.qorpera_coding_repository_grants set enabled = true where environment_id = pg_temp.rec_here()
		and repository = pg_temp.c3_repo();
	delete from public.qorpera_code_changes where environment_id = pg_temp.rec_here() and name = 'base';
	delete from public.qorpera_code_repositories where environment_id = pg_temp.rec_here() and name = 'base';
	perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'imp-gh-dispatch', v_folder, pg_temp.c3_brief(v_gh))
		-> 'units' -> 0 ->> 'outcome' = 'saved', 'the GitHub session');
	perform public.qorpera_folder_cancel_agent_worker(v_alice, jsonb_build_object('folder', v_folder,
		'operationKey', 'imp-gh-cancel'));
	update public.qorpera_coding_sessions set archived_at = clock_timestamp(), archived_by = 'kernel', phase = 'cancelled'
	where worker_id = v_gh;
	perform pg_temp.req_quiet();
	-- (b) An import of that GitHub code at code/company/kept is open.
	v_id := (pg_temp.imp_ask('imp-rules', 'company', 'kept', pg_temp.imp_gh('Qorpera/Qorpera_Base')) ->> 'requestId')::uuid;
	perform pg_temp.base_assert(v_id is not null, 'the import is open');
	-- A GitHub dispatch of that code, a dispatch kept in Qorpera at its place: refused in the import's words.
	v_brief := pg_temp.c3_brief('92290000-0000-4000-8000-0000000000b2');
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-gh-2', v_folder || '-2', v_brief), v_brief, v_wait);
	v_brief := pg_temp.own_brief('92290000-0000-4000-8000-0000000000b3', pg_temp.own_repo('company', 'kept'));
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-kept-3', v_folder || '-3', v_brief), v_brief, v_wait);
	-- The agent's follow-up of the GitHub session, and the owner's answer in its thread: refused, nothing opens.
	v_result := pg_temp.c3_followup(v_alice, 'imp-gh-followup', v_folder, 'Go on.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 ->> 'outcome' = 'refused'
		and v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message' = v_wait, 'the follow-up: ' || v_result::text);
	perform pg_temp.imp_error('the owner''s answer', format('select pg_temp.c3_answer(%L, %L)', v_gh, 'Go on.'), '55000', v_wait);
	perform pg_temp.base_assert((pg_temp.c3_session(v_gh)).archived_at is not null
		and (pg_temp.c3_worker(v_gh)).state = 'cancelled', 'the session stays archived');
	-- A turn that opens in any other way meets the same rule (qorpera_open_coding_turn).
	perform pg_temp.imp_error('a turn that opens', format('select public.qorpera_open_coding_turn(w, %L, %L, null, null)
		from public.qorpera_runtime_workers w where w.id = %L', 'agent', 'Go on.', v_gh), '55000', v_wait);
	-- (c) It is in (its registry row and record, as its record writes them).
	perform pg_temp.imp_end(v_id);
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'kept',
		'{"kind":"github","repository":"Qorpera/Qorpera_Base","via":"connection","branch":"master","commit":null,"commits":1}',
		clock_timestamp());
	v_brief := pg_temp.c3_brief('92290000-0000-4000-8000-0000000000b4');
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-gh-4', v_folder || '-4', v_brief), v_brief,
		'This code was brought into Qorpera as code/company/kept: work on it there (host qorpera)');
	v_result := pg_temp.c3_followup(v_alice, 'imp-gh-followup-2', v_folder, 'Go on.');
	perform pg_temp.base_assert(v_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message'
		= 'This code was brought into Qorpera as code/company/kept: work on it there (host qorpera)',
		'the follow-up afterwards: ' || v_result::text);
	perform pg_temp.imp_error('the owner''s answer afterwards', format('select pg_temp.c3_answer(%L, %L)', v_gh, 'Go on.'),
		'55000', 'This code was brought into Qorpera as code/company/kept: work on it there (host qorpera)');
	-- A GitHub session at the place of code brought in from a file: refused the same way.
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'acme', 'web',
		'{"kind":"file","name":"web.bundle","sha256":null,"branch":"main","commit":null,"commits":1}', clock_timestamp());
	v_brief := pg_temp.c3_brief('92290000-0000-4000-8000-0000000000b5')
		|| '{"repository":{"host":"github.com","owner":"Acme","name":"Web","baseBranch":"main"}}';
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-gh-5', v_folder || '-5', v_brief), v_brief,
		'This code was brought into Qorpera as code/acme/web: work on it there (host qorpera)');
	-- (a) The GitHub grant of Qorpera/Qorpera_Base refuses a dispatch kept in Qorpera at code/qorpera/qorpera_base only
	-- while no repository is registered there.
	v_brief := pg_temp.own_brief('92290000-0000-4000-8000-0000000000b6', pg_temp.own_repo('qorpera', 'qorpera_base'));
	perform pg_temp.c3_refused(pg_temp.c3_dispatch(v_alice, 'imp-kept-6', v_folder || '-6', v_brief), v_brief,
		'The company''s code already holds a copy of a GitHub repository at code/qorpera/qorpera_base; keep this repository in Qorpera under another owner or name');
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name, imported_from, imported_at)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'qorpera', 'qorpera_base',
		'{"kind":"file","name":"base.bundle","sha256":null,"branch":"main","commit":null,"commits":1}', clock_timestamp());
	perform pg_temp.base_assert(pg_temp.c3_dispatch(v_alice, 'imp-kept-7', v_folder || '-7', v_brief)
		-> 'units' -> 0 ->> 'outcome' = 'saved', 'a kept dispatch where code was brought in');
	update public.qorpera_code_requests set state = 'failed', finished_at = clock_timestamp()
	where environment_id = '91170000-0000-4000-8000-000000000020' and state = 'queued';
end $$;

-- 12. Five claims ------------------------------------------------------------------------------------------------------
do $$
declare v_id uuid; v_item jsonb; q public.qorpera_code_requests%rowtype;
begin
	perform pg_temp.req_quiet();
	-- Five claims with no finish: the sixth ends it DID_NOT_FINISH, its progress kept.
	v_id := (pg_temp.imp_ask('imp-five', 'company', 'five', pg_temp.imp_gh('Acme/Five')) ->> 'requestId')::uuid;
	for i in 1..5 loop
		v_item := pg_temp.imp_claim(array['import']) -> 0;
		perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text, 'claim ' || i);
		perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, '{"step":"fetch"}');
		perform pg_temp.req_lapse(v_id);
	end loop;
	perform pg_temp.base_assert(pg_temp.imp_claim(array['import']) = '[]'::jsonb, 'the sixth claim');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'failed' and q.outcome ->> 'code' = 'DID_NOT_FINISH' and q.progress ->> 'step' = 'fetch',
		'did not finish: ' || to_jsonb(q)::text);
	-- (Until the review of #1710, F2, an import that had recorded its repository ended done at the limit, from what it
	-- recorded. But the record is made inside the job that opens the place, before the mark that closes it goes: an end
	-- then left the place closed for good. Now only the executor's finish, after that job, ends it.)
	-- Four claims cut short in the fetch; the fifth records, and its run is cut before the open job removed the mark.
	v_id := (pg_temp.imp_ask('imp-five-rec', 'company', 'fiverec', pg_temp.imp_gh('Acme/Fiverec')) ->> 'requestId')::uuid;
	for i in 1..4 loop
		v_item := pg_temp.imp_claim(array['import']) -> 0;
		perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, '{"step":"fetch"}');
		perform pg_temp.req_lapse(v_id);
	end loop;
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw()));
	perform pg_temp.imp_looked(v_id, (v_item ->> 'token')::uuid, pg_temp.imp_look());
	perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, jsonb_build_object('step', 'open', 'kept', pg_temp.imp_kept(),
		'setAside', 'code/_set-aside/company/at-20261112T152000Z/fiverec'));
	perform pg_temp.base_assert(pg_temp.imp_record(v_id, (v_item ->> 'token')::uuid, pg_temp.imp_imported()) ->> 'state' = 'recorded'
		and (pg_temp.req_row(v_id)).attempts = 5, 'the fifth claim records');
	perform pg_temp.req_lapse(v_id);
	-- The sixth claim and the seventh hand it out again, with what it recorded: no DID_NOT_FINISH, nothing ends it.
	for i in 6..7 loop
		v_item := pg_temp.imp_claim(array['import']) -> 0;
		q := pg_temp.req_row(v_id);
		perform pg_temp.base_assert(v_item ->> 'requestId' = v_id::text and q.state = 'running' and q.attempts = i
			and v_item -> 'progress' -> 'recorded' = q.progress -> 'recorded' and q.outcome is null,
			'claim ' || i || ' of a recorded import: ' || coalesce(v_item::text, 'none'));
		perform pg_temp.req_lapse(v_id);
	end loop;
	-- Meanwhile it is being brought in, not in: the list has it in bringing (at its open), not among the repositories
	-- (so no download is offered, and no GitHub copy is named there), and no import of it that did not come in; asked
	-- again, it is this request, which the agent reads as running.
	perform pg_temp.base_assert(
		not exists (select 1 from jsonb_array_elements(pg_temp.req_list() -> 'repositories') r where r ->> 'name' = 'fiverec')
		and pg_temp.req_list() -> 'bringing' = jsonb_build_array(jsonb_build_object('owner', 'company', 'name', 'fiverec',
			'from', '{"github":"Acme/Fiverec"}'::jsonb, 'step', 'open', 'waiting', null, 'startedAt', (pg_temp.req_row(v_id)).created_at))
		and not exists (select 1 from jsonb_array_elements(pg_temp.req_list() -> 'githubCopies') c where c ->> 'name' = 'fiverec')
		and coalesce(pg_temp.req_list() #>> '{lastImport,name}', '') <> 'fiverec', 'being brought in: ' || pg_temp.req_list()::text);
	perform pg_temp.base_assert(pg_temp.imp_ask('imp-five-rec-again', 'company', 'fiverec', pg_temp.imp_gh('Acme/Fiverec'))
			= pg_temp.imp_queued(v_id)
		and pg_temp.imp_read(v_id) ->> 'state' = 'running' and pg_temp.imp_read(v_id) -> 'result' = 'null', 'asked again meanwhile');
	-- The next claim's run opens the place, and its finish ends it: in, and among the repositories.
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	perform pg_temp.base_assert(pg_temp.req_finish(v_id, (v_item ->> 'token')::uuid, pg_temp.imp_outcome(jsonb_build_object(
		'setAside', 'code/_set-aside/company/at-20261112T152000Z/fiverec'))) = pg_temp.req_recorded(1), 'the finish');
	q := pg_temp.req_row(v_id);
	perform pg_temp.base_assert(q.state = 'done' and q.attempts = 8 and q.outcome = pg_temp.imp_outcome(jsonb_build_object(
			'setAside', 'code/_set-aside/company/at-20261112T152000Z/fiverec')) and q.lease_token is null
		and exists (select 1 from jsonb_array_elements(pg_temp.req_list() -> 'repositories') r where r ->> 'name' = 'fiverec')
		and pg_temp.req_list() -> 'bringing' = '[]'::jsonb, 'in: ' || to_jsonb(q)::text);
	-- A place that holds a repository by the time of the record is not this import's: 55000, nothing written.
	v_id := (pg_temp.imp_ask('imp-taken', 'company', 'taken', pg_temp.imp_gh('Acme/Taken')) ->> 'requestId')::uuid;
	v_item := pg_temp.imp_claim(array['import']) -> 0;
	perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, jsonb_build_object('step', 'look', 'raw', pg_temp.imp_raw()));
	perform pg_temp.imp_looked(v_id, (v_item ->> 'token')::uuid, pg_temp.imp_look());
	perform pg_temp.req_step(v_id, (v_item ->> 'token')::uuid, jsonb_build_object('step', 'open', 'kept', pg_temp.imp_kept()));
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'taken');
	perform pg_temp.imp_error('a place taken', format('select pg_temp.imp_record(%L, %L, %L)', v_id, v_item ->> 'token',
		pg_temp.imp_imported()), '55000', 'A repository is kept at that place already');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_code_changes where environment_id = pg_temp.rec_here()
		and name = 'taken') and not (pg_temp.req_row(v_id)).progress ? 'recorded', 'nothing written');
	perform pg_temp.imp_end(v_id);
end $$;

-- 13. At the bounds ------------------------------------------------------------------------------------------------------
-- The list of a company with 200 sessions (100 of them GitHub ones) and 10 repositories (with 20 downloads), under a
-- member's 8 s statement limit; the claim with 50 queued requests behind a running import (each looked at and passed
-- over), under the control's 30 s. Each held to a bound, measured with clock_timestamp().
do $$
declare v_at timestamptz; v_ms numeric; v jsonb; v_import uuid;
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_runtime_workers
	select (jsonb_populate_record(null::public.qorpera_runtime_workers, to_jsonb(w) || jsonb_build_object(
		'id', pg_temp.rec_copy(3000 + n), 'worker_key', 'imp-' || n, 'title', 'Session ' || n,
		'folder_path', 'QorperaOS/agents/alice/todos/fix-login/imp-' || n, 'folder_key', 'qorperaos/agents/alice/todos/fix-login/imp-' || n))).*
	from public.qorpera_runtime_workers w, generate_series(1, 200) n where w.id = '91170000-0000-4000-8000-0000000000b2';
	insert into public.qorpera_coding_sessions
	select (jsonb_populate_record(null::public.qorpera_coding_sessions, to_jsonb(s) || jsonb_build_object(
		'worker_id', pg_temp.rec_copy(3000 + n), 'branch', 'qorpera/coding/' || pg_temp.rec_copy(3000 + n)::text,
		'repository', case when n <= 100 then jsonb_build_object('host', 'github.com', 'owner', 'Bulk', 'name', 'b-' || n,
			'baseBranch', 'main') else pg_temp.own_repo('company', 'r' || (n % 10)) end))).*
	from public.qorpera_coding_sessions s, generate_series(1, 200) n where s.worker_id = '91170000-0000-4000-8000-0000000000b2';
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	select pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', 'r' || n from generate_series(0, 9) n
	on conflict do nothing;
	perform set_config('session_replication_role', 'origin', true);
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, state, by_kind, finished_at,
		expires_at, outcome)
	select pg_temp.rec_here(), 'company', 'r' || (n % 10), '92400000-0000-4000-8000-000000000010', 'download',
		jsonb_build_object('file', case when n % 2 = 0 then 'files' else 'history' end, 'fileName', 'r.zip'), 'done', 'member',
		clock_timestamp(), clock_timestamp() + interval '1 day', jsonb_build_object('path', 'code/x', 'bytes', 1)
	from generate_series(1, 20) n;
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	set local role authenticated;
	set local statement_timeout = '8s';
	v_at := clock_timestamp();
	v := public.qorpera_list_code_repositories('92400000-0000-4000-8000-000000000010');
	v_ms := extract(epoch from clock_timestamp() - v_at) * 1000;
	reset statement_timeout;
	reset role;
	perform pg_temp.base_assert(jsonb_array_length(v -> 'githubCopies') = 100 and jsonb_array_length(v -> 'repositories') >= 10,
		'the list at its bounds');
	perform pg_temp.base_assert(v_ms < 2000, format('the list took %s ms', round(v_ms)));
	raise notice 'imp bounds: the list of 200 sessions and 10 repositories took % ms', round(v_ms, 1);
	-- The claim: a running import, and 49 queued downloads of the same company behind it.
	perform pg_temp.base_claims('service_role');
	v_import := (pg_temp.imp_ask('imp-bounds', 'company', 'bounds', pg_temp.imp_gh('Acme/Bounds')) ->> 'requestId')::uuid;
	perform pg_temp.imp_claim(array['import']);
	insert into public.qorpera_code_requests(environment_id, owner, name, profile_id, kind, input, by_kind)
	select pg_temp.rec_here(), 'company', 'q' || (n % 25), '92400000-0000-4000-8000-000000000010', 'download',
		jsonb_build_object('file', case when n < 25 then 'files' else 'history' end, 'fileName', 'q' || n || '.zip'), 'member'
	from generate_series(0, 49) n;
	perform pg_temp.base_assert((select count(*) from public.qorpera_code_requests where state = 'queued'
		and profile_id = '92400000-0000-4000-8000-000000000010') = 50, 'fifty queued');
	v_at := clock_timestamp();
	v := pg_temp.imp_claim();
	v_ms := extract(epoch from clock_timestamp() - v_at) * 1000;
	perform pg_temp.base_assert(v = '[]'::jsonb, 'nothing of the company is claimed while its import runs: ' || v::text);
	perform pg_temp.base_assert(v_ms < 2000, format('the claim took %s ms', round(v_ms)));
	raise notice 'imp bounds: the claim of 50 queued requests took % ms', round(v_ms, 1);
	perform pg_temp.imp_end(v_import);
end $$;

rollback;

-- 14. Races ------------------------------------------------------------------------------------------------------------
-- A committed company of its own, removed at the end: Ann (owner) and Bob (admin); its executor exec-1229 (on machine
-- 9…9), the one coding executor of its environment; a GitHub session of acme/shop that is archived and quiet, whose
-- worker is not active. Each call that must wait is seen waiting with pg_blocking_pids; every connection gives up after
-- 20 s. Foreign keys and triggers are off only while the rows go in.
insert into auth.users(id, email) values ('12290000-0000-4000-8000-00000000000a', 'ann-1229@example.test'),
	('12290000-0000-4000-8000-00000000000b', 'bob-1229@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12290000-0000-4000-8000-000000000101', 'Import company', '12290000-0000-4000-8000-00000000000a');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12290000-0000-4000-8000-000000000101', '12290000-0000-4000-8000-00000000000a', 'ann-1229@example.test', 'Ann', 'owner'),
	('12290000-0000-4000-8000-000000000101', '12290000-0000-4000-8000-00000000000b', 'bob-1229@example.test', 'Bob', 'admin');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12290000-0000-4000-8000-000000000201', '12290000-0000-4000-8000-000000000101', 'Environment', 1,
	'12290000-0000-4000-8000-00000000000a');
set session_replication_role = replica;
insert into public.qorpera_company_files(environment_id, profile_id, canonical_workspace_id, created_by_user_id, core)
values ('12290000-0000-4000-8000-000000000201', '12290000-0000-4000-8000-000000000101', '12290000-0000-4000-8000-000000000301',
	'12290000-0000-4000-8000-00000000000a', 'folder-v2')
on conflict (environment_id) do update set core = 'folder-v2', head_snapshot_id = null, path_gateway_version = null,
	path_index_snapshot_id = null;
insert into public.qorpera_folder_fences(profile_id) values ('12290000-0000-4000-8000-000000000101') on conflict do nothing;
insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, nas_machine_id_sha256)
values ('12290000-0000-4000-8000-000000000201', 'exec-1229', true, array['codex'], repeat('9', 64));
insert into public.qorpera_runtime_workers(id, profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title, access,
	revival, dispatch, requested_by_user_id, steering_run_id, owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
	state, result, sequence)
values ('12290000-0000-4000-8000-0000000000c1', '12290000-0000-4000-8000-000000000101', '12290000-0000-4000-8000-000000000201',
	'12290000-0000-4000-8000-000000000401', '12290000-0000-4000-8000-000000000501', 'w-1229-1', 'coding', 'Code 1', 'read', 'each',
	'{}', '12290000-0000-4000-8000-00000000000a', '12290000-0000-4000-8000-000000000601', '12290000-0000-4000-8000-00000000000a',
	'12290000-0000-4000-8000-000000000701', 1, 'succeeded', '{"summary":"Done."}', 2);
insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, harness, repository, branch, phase,
	started_at, updated_at, archived_at, archived_by)
values ('12290000-0000-4000-8000-0000000000c1', '12290000-0000-4000-8000-000000000101', '12290000-0000-4000-8000-000000000201',
	'codex', '{"host":"github.com","owner":"Acme","name":"Shop","baseBranch":"main"}', 'qorpera/coding/w-1229-1', 'completed',
	clock_timestamp(), clock_timestamp(), clock_timestamp(), 'member');
set session_replication_role = origin;

select dblink_connect(name, 'dbname=' || current_database()) from unnest(array['race_hold', 'race_act', 'race_other']) name;
select set_config('qorpera_test.race_' || name || '_pid', (select pid::text from dblink('race_' || name,
	'select pg_backend_pid()') as b(pid integer)), false) from unnest(array['hold', 'act', 'other']) name \g /dev/null
select dblink_exec(name, 'set lock_timeout = ''20s''') from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null

-- Whether race_act's call waits on race_hold; false when the call ended first.
create function pg_temp.race_waits() returns boolean language plpgsql as $$
declare v_by integer := current_setting('qorpera_test.race_hold_pid')::integer;
	v_conn integer := current_setting('qorpera_test.race_act_pid')::integer;
begin
	for attempt in 1..400 loop
		if v_by = any(pg_blocking_pids(v_conn)) then return true; end if;
		exit when dblink_is_busy('race_act') = 0;
		perform pg_sleep(0.025);
	end loop;
	return false;
end $$;
-- The answer of race_act's call, or its error as {"error":<sqlstate>,"message":…}.
create function pg_temp.race_answer() returns jsonb language plpgsql as $$
declare v text; v_state text; v_message text;
begin
	begin
		select answer into v from dblink_get_result('race_act') as call(answer text);
	exception when others then
		get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
		perform * from dblink_get_result('race_act') as call(answer text);
		return jsonb_build_object('error', v_state, 'message', v_message);
	end;
	perform * from dblink_get_result('race_act') as call(answer text);
	return v::jsonb;
end $$;
-- p_conn as member p_user.
create function pg_temp.race_as(p_conn text, p_user text) returns void language plpgsql as $$
begin
	perform dblink_exec(p_conn, 'reset role');
	perform dblink_exec(p_conn, format('set request.jwt.claims = %L', jsonb_build_object('role', 'authenticated', 'sub', p_user)));
	perform dblink_exec(p_conn, 'set role authenticated');
end $$;
-- A member's call that asks for an import of Acme/<p_name> at company/<p_name>, as a connection sends it.
create function pg_temp.race_ask(p_name text) returns text language sql immutable as $$
	select format('select public.qorpera_request_code_import(%L, %L, %L, %L)::text', '12290000-0000-4000-8000-000000000101',
		'company', lower(p_name), 'Acme/' || p_name)
$$;
-- A turn that opens on the GitHub session (as a member's answer or an agent's follow-up opens it).
create function pg_temp.race_turn() returns text language sql immutable as $$
	select $q$select public.qorpera_open_coding_turn(w, 'agent', 'Go on.', null, null)::text
		from public.qorpera_runtime_workers w where w.id = '12290000-0000-4000-8000-0000000000c1'$q$
$$;

-- R1. Two members ask at once: Bob's call waits for Ann's to end, then counts it: busy (never the unique index's 23505).
do $$
declare v jsonb; v_ann jsonb;
begin
	perform pg_temp.race_as('race_hold', '12290000-0000-4000-8000-00000000000a');
	perform pg_temp.race_as('race_act', '12290000-0000-4000-8000-00000000000b');
	perform dblink_exec('race_hold', 'begin');
	select answer::jsonb into v_ann from dblink('race_hold', pg_temp.race_ask('Web')) as call(answer text);
	perform dblink_send_query('race_act', pg_temp.race_ask('Docs'));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R1: the second call did not wait for the first: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v_ann ->> 'state' is distinct from 'queued'
		or v is distinct from '{"schema":"qorpera.code-import/v1","state":"refused","reason":"busy"}'::jsonb then
		raise exception 'R1: Ann % and Bob %', v_ann, v; end if;
	update public.qorpera_code_requests set state = 'failed', finished_at = clock_timestamp()
	where profile_id = '12290000-0000-4000-8000-000000000101';
end $$;

-- R2. A turn opens on the GitHub session of acme/shop while Ann's call that brings Acme/Shop in is open: the turn waits
-- for it, then sees the import, and is refused in its words; the session stays archived.
do $$
declare v jsonb;
begin
	perform pg_temp.race_as('race_hold', '12290000-0000-4000-8000-00000000000a');
	perform dblink_exec('race_act', 'reset role');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', pg_temp.race_ask('Shop')) as call(answer text);
	perform dblink_send_query('race_act', pg_temp.race_turn());
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R2: the turn did not wait for the import''s call: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v is distinct from jsonb_build_object('error', '55000', 'message',
			'Code is being brought in at code/company/shop; wait until it is in')
		or (select archived_at from public.qorpera_coding_sessions where worker_id = '12290000-0000-4000-8000-0000000000c1') is null then
		raise exception 'R2: the turn: %', v; end if;
	update public.qorpera_code_requests set state = 'failed', finished_at = clock_timestamp()
	where profile_id = '12290000-0000-4000-8000-000000000101';
end $$;

-- R3. The other way: the turn opens first (the session open again, not committed yet); Ann's call waits for it, then sees
-- the open session: sessions_open.
do $$
declare v jsonb;
begin
	perform dblink_exec('race_hold', 'reset role');
	perform pg_temp.race_as('race_act', '12290000-0000-4000-8000-00000000000a');
	perform dblink_exec('race_hold', 'begin');
	perform * from dblink('race_hold', pg_temp.race_turn()) as call(answer text);
	perform dblink_send_query('race_act', pg_temp.race_ask('Shop'));
	if not pg_temp.race_waits() then
		perform dblink_exec('race_hold', 'rollback');
		raise exception 'R3: the call did not wait for the turn: %', pg_temp.race_answer(); end if;
	perform dblink_exec('race_hold', 'commit');
	v := pg_temp.race_answer();
	if v is distinct from '{"schema":"qorpera.code-import/v1","state":"refused","reason":"sessions_open"}'::jsonb then
		raise exception 'R3: the call: %', v; end if;
end $$;

select dblink_disconnect(name) from unnest(array['race_hold', 'race_act', 'race_other']) name \g /dev/null

-- Remove the company (526's way): the session's turns and events, then every row of the company and its environment,
-- then the company, Ann and Bob.
set session_replication_role = replica;
delete from public.qorpera_coding_session_turns where worker_id = '12290000-0000-4000-8000-0000000000c1';
delete from public.qorpera_coding_session_events where worker_id = '12290000-0000-4000-8000-0000000000c1';
do $$
declare v_table record;
begin
	for v_table in select c.table_name, c.column_name from information_schema.columns c
		join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
		where c.table_schema = 'public' and c.column_name in ('profile_id','environment_id') and c.data_type = 'uuid'
			and c.table_name <> 'qorpera_profiles' loop
		execute format('delete from public.%I where %I = $1', v_table.table_name, v_table.column_name)
		using case v_table.column_name when 'profile_id' then '12290000-0000-4000-8000-000000000101'::uuid
			else '12290000-0000-4000-8000-000000000201'::uuid end;
	end loop;
end $$;
set session_replication_role = origin;
delete from public.qorpera_profiles where id = '12290000-0000-4000-8000-000000000101';
delete from auth.users where id in ('12290000-0000-4000-8000-00000000000a', '12290000-0000-4000-8000-00000000000b');
do $$
begin
	if exists (select 1 from public.qorpera_profiles where id = '12290000-0000-4000-8000-000000000101')
		or exists (select 1 from public.qorpera_runtime_workers where id = '12290000-0000-4000-8000-0000000000c1')
		or exists (select 1 from public.qorpera_code_requests where profile_id = '12290000-0000-4000-8000-000000000101')
		or exists (select 1 from auth.users where id in ('12290000-0000-4000-8000-00000000000a', '12290000-0000-4000-8000-00000000000b')) then
		raise exception 'the import''s races left rows behind'; end if;
end $$;
