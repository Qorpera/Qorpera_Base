-- @fixture 1211_code_requests.test.sql until "-- 1. An agent asks for an undo"
-- A repository's website kept as versions and put live, or taken back, only by a member on What's new (migration
-- 20260930729000). 1211's fixture (1210's helpers before it): company/shop with six rows, session copies that hand
-- commits in, the record call, and an undo and a restore from the call that asks for it to the executor's finish. This
-- file's repositories are company/<name> for the names below, and its session copies are numbered from 1600.
--   1. Rights, the columns and their rules, the marker.
--   2. Report v3: each site on a passed landing, every invalid one, the row it keeps, a filler taken over, a replay.
--   3. The switch's site; an inheriting undo and restore copy the site; the platform's line; the failure's round.
--   4. The due list: the newest point per repository, a row taken out later, given up, switched off, not the holder.
--   5. Begin: the site and its name (wanted, taken, abandoned, derived, -2, all taken, reserved), the tenth site, a row
--      or a tree that differs, a version found again, lost.
--   6. List, missing and put: pages, every refused value, the bytes copied by digest, missing in pages, a file in
--      several parts, a part sent twice, a file that does not match; finish, and failed with its back-off.
--   7. The member's read in each state, put live (role, moved by the live version, by a change taken out, by a notice,
--      a newer point does not refuse, the switch of states, the first release), Go back (role, the chain, moved).
--   8. Prune keeps 1 + 5 + 3, and Go back stops at a pruned version.
--   9. publish_site's refusals, the Sites list before and after the first release, the list file's two keys, and a
--      member taking a code site offline.

select pg_temp.base_claims('service_role') \g /dev/null
update public.qorpera_site_settings set enabled = true;

-- A repository of this file's own, registered: company/p_name.
create function pg_temp.rel_repository(p_name text) returns void language sql as $$
	insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
	values (pg_temp.rec_here(), '92400000-0000-4000-8000-000000000010', 'company', p_name)
$$;
-- The company, its members and another company.
create function pg_temp.rel_company() returns uuid language sql immutable as $$
	select '92400000-0000-4000-8000-000000000010'::uuid
$$;
create function pg_temp.rel_admin() returns uuid language sql immutable as $$ select '92400000-0000-4000-8000-000000000004'::uuid $$;
create function pg_temp.rel_member() returns uuid language sql immutable as $$ select '92400000-0000-4000-8000-000000000002'::uuid $$;
create function pg_temp.rel_viewer() returns uuid language sql immutable as $$ select '92400000-0000-4000-8000-000000000003'::uuid $$;
create function pg_temp.rel_outsider() returns uuid language sql immutable as $$ select '92400000-0000-4000-8000-000000000005'::uuid $$;
-- The files of site p_word: {path: text}. style.css is the same in every site.
create function pg_temp.rel_texts(p_word text) returns jsonb language sql immutable as $$
	select jsonb_build_object('index.html', '<h1>' || p_word || '</h1>', 'app.js', 'console.log("' || p_word || '");',
		'style.css', 'body { margin: 0 }')
$$;
-- A file as the pass names it, and a site's files in C order.
create function pg_temp.rel_file(p_path text, p_text text) returns jsonb language sql immutable as $$
	select jsonb_build_object('path', p_path, 'bytes', octet_length(convert_to(p_text, 'utf8')),
		'sha256', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'))
$$;
create function pg_temp.rel_files(p_texts jsonb) returns jsonb language sql immutable as $$
	select coalesce(jsonb_agg(pg_temp.rel_file(t.key, t.value) order by t.key collate "C"), '[]'::jsonb)
	from jsonb_each_text(p_texts) t
$$;
-- The manifest the pass sends to begin: {"manifestSha256","files","bytes"}.
create function pg_temp.rel_manifest(p_texts jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('manifestSha256', encode(extensions.digest(convert_to(string_agg((f ->> 'path') || chr(9)
			|| (f ->> 'sha256') || chr(9) || (f ->> 'bytes'), chr(10) order by f ->> 'path' collate "C"), 'utf8'), 'sha256'), 'hex'),
		'files', count(*), 'bytes', coalesce(sum((f ->> 'bytes')::bigint), 0))
	from jsonb_array_elements(pg_temp.rel_files(p_texts)) f
$$;
-- The row's site for site p_word (its files p_texts, rel_texts' when null), with the keys given changed.
create function pg_temp.rel_site(p_word text, p_keys jsonb default '{}', p_texts jsonb default null) returns jsonb
language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', pg_temp.rec_sha('tree:' || p_word),
		'files', m -> 'files', 'bytes', m -> 'bytes', 'folder', 'dist', 'name', null, 'title', null) || p_keys
	from (select pg_temp.rel_manifest(coalesce(p_texts, pg_temp.rel_texts(p_word))) m) x
$$;
-- A report's site: made, of site p_word; or missed, with a code.
create function pg_temp.rel_made(p_word text, p_keys jsonb default '{}', p_texts jsonb default null) returns jsonb
language sql immutable as $$
	select jsonb_build_object('state', 'made', 'site', pg_temp.rel_site(p_word, p_keys, p_texts))
$$;
create function pg_temp.rel_missed(p_code text default 'SITE_BOUNDARY') returns jsonb language sql immutable as $$
	select jsonb_build_object('state', 'missed', 'code', p_code)
$$;
-- What passed, as a report's checks, for a landing that put main at commit p_after.
create function pg_temp.rel_passed(p_after text) returns jsonb language sql immutable as $$
	select jsonb_build_object('state', 'passed', 'result', jsonb_build_object('schema', 'qorpera.code-checks/v1',
		'commit', pg_temp.rec_sha(p_after), 'how', 'fast-forward', 'file', pg_temp.rec_sha('checks.json'), 'ms', 61012,
		'copyMs', 900, 'checks', '[{"name":"build","run":"npm run build","ms":38012}]'::jsonb, 'changed', null, 'tries', 1))
$$;
-- A report of schema v3 (commits as they are given), with its checks and site, and the keys given changed.
create function pg_temp.rel_report(p_state text, p_head text, p_before text, p_after text, p_checks jsonb, p_site jsonb,
	p_change jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.rec_report(p_state, p_head, p_before, p_after, jsonb_build_object('schema',
		'qorpera.code-change-report/v3', 'checks', p_checks, 'site', p_site) || p_change)
$$;
-- Session copy p_n hands in commit p_after on company/p_name, and reports that it landed on main at p_before with its
-- checks passed and the site p_site; the submission's keys given (a notice) and the report's keys given changed.
create function pg_temp.rel_land(p_n integer, p_before text, p_after text, p_site jsonb, p_name text,
	p_submission jsonb default '{}', p_report jsonb default '{}') returns jsonb language sql as $$
	select pg_temp.rec_record(pg_temp.rec_turn(p_n, 1, pg_temp.rec_sha(p_after), p_submission, pg_temp.own_repo('company', p_name)),
		pg_temp.rel_report('landed', pg_temp.rec_sha(p_after), pg_temp.rec_sha(p_before), pg_temp.rec_sha(p_after),
			pg_temp.rel_passed(p_after), p_site, p_report))
$$;
-- What row p_n of company/p_name keeps of its site.
create function pg_temp.rel_said(p_n integer, p_name text) returns jsonb language sql as $$
	select jsonb_build_object('state', c.site_state, 'site', c.site, 'problem', c.site_problem) from pg_temp.rec_row(p_n, p_name) c
$$;
create function pg_temp.rel_kept(p_state text, p_site jsonb, p_problem text default null) returns jsonb language sql immutable as $$
	select jsonb_build_object('state', p_state, 'site', p_site, 'problem', p_problem)
$$;
-- A call of the executor's: the service role, with its claims.
create function pg_temp.rel_exec(p_call text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	execute 'select ' || p_call into v;
	reset role;
	return v;
end $$;
create function pg_temp.rel_due(p_limit integer default 20, p_owner text default 'exec-1170',
	p_machine text default repeat('5', 64)) returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_sites_due(%L, %L, %s)', p_owner, p_machine, p_limit))
$$;
-- The names due now with their changes, name:change in the due list's order.
create function pg_temp.rel_due_names(p_owner text default 'exec-1170') returns text language sql as $$
	select coalesce(string_agg((due.item ->> 'name') || ':' || (due.item ->> 'change'), ',' order by due.place), '')
	from jsonb_array_elements(pg_temp.rel_due(20, p_owner) -> 'sites') with ordinality due(item, place)
$$;
create function pg_temp.rel_begin(p_name text, p_change integer, p_manifest jsonb, p_owner text default 'exec-1170')
returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_begin(%L, %L, %L, %L, %L, %s, %L)', p_owner, repeat('5', 64),
		pg_temp.rec_here(), 'company', p_name, p_change, p_manifest))
$$;
create function pg_temp.rel_list(p_version uuid, p_files jsonb, p_last boolean, p_owner text default 'exec-1170')
returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_list(%L, %L, %L, %L)', p_owner, repeat('5', 64), p_version,
		jsonb_build_object('files', p_files, 'last', p_last)))
$$;
create function pg_temp.rel_missing(p_version uuid, p_after text, p_limit integer, p_owner text default 'exec-1170')
returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_missing(%L, %L, %L, %L, %s)', p_owner, repeat('5', 64), p_version,
		p_after, p_limit))
$$;
create function pg_temp.rel_put(p_version uuid, p_parts jsonb, p_owner text default 'exec-1170') returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_put(%L, %L, %L, %L)', p_owner, repeat('5', 64), p_version,
		jsonb_build_object('parts', p_parts)))
$$;
create function pg_temp.rel_finish(p_version uuid, p_owner text default 'exec-1170') returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_finish(%L, %L, %L)', p_owner, repeat('5', 64), p_version))
$$;
create function pg_temp.rel_failed(p_name text, p_change integer, p_code text, p_owner text default 'exec-1170')
returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_code_site_failed(%L, %L, %L, %L, %L, %s, %L)', p_owner, repeat('5', 64),
		pg_temp.rec_here(), 'company', p_name, p_change, p_code))
$$;
-- A part of a file's bytes: the text's bytes from byte p_from, p_count of them (all when null).
create function pg_temp.rel_part(p_path text, p_text text, p_part integer, p_of integer, p_from integer default 0,
	p_count integer default null) returns jsonb language sql immutable as $$
	select jsonb_build_object('path', p_path, 'part', p_part, 'of', p_of, 'contentBase64', encode(substring(convert_to(p_text,
		'utf8') from p_from + 1 for coalesce(p_count, octet_length(convert_to(p_text, 'utf8')))), 'base64'))
$$;
-- Every file whole, as one part each.
create function pg_temp.rel_parts(p_texts jsonb) returns jsonb language sql immutable as $$
	select jsonb_agg(pg_temp.rel_part(t.key, t.value, 0, 1) order by t.key) from jsonb_each_text(p_texts) t
$$;
-- A whole upload of row p_change's site p_word, as the pass makes it: begin, the files in one page, the bytes still
-- missing, finish. Answers the version.
create function pg_temp.rel_upload(p_name text, p_change integer, p_word text, p_texts jsonb default null)
returns uuid language plpgsql as $$
declare v_texts jsonb := coalesce(p_texts, pg_temp.rel_texts(p_word)); v jsonb; v_version uuid;
begin
	v := pg_temp.rel_begin(p_name, p_change, pg_temp.rel_manifest(v_texts));
	perform pg_temp.base_assert(v ->> 'state' = 'uploading' and v -> 'listed' = 'false', 'the upload begins: ' || v::text);
	v_version := (v ->> 'versionId')::uuid;
	v := pg_temp.rel_list(v_version, pg_temp.rel_files(v_texts), true);
	perform pg_temp.base_assert(v ->> 'state' = 'listed', 'the files are listed: ' || v::text);
	v := pg_temp.rel_put(v_version, pg_temp.rel_parts(v_texts));
	perform pg_temp.base_assert(v ->> 'state' = 'kept', 'the bytes are kept: ' || v::text);
	v := pg_temp.rel_finish(v_version);
	perform pg_temp.base_assert(v ->> 'state' = 'ready', 'the upload is ready: ' || v::text);
	return v_version;
end $$;
-- The member's three calls, as the web makes them.
create function pg_temp.rel_read(p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_list_code_releases(%L)', pg_temp.rel_company()))
$$;
create function pg_temp.rel_page(p_name text, p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select item from jsonb_array_elements(pg_temp.rel_read(p_user) -> 'sites') item where item ->> 'name' = p_name
$$;
create function pg_temp.rel_live(p_name text, p_shown jsonb, p_user uuid default pg_temp.req_owner()) returns jsonb
language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_put_code_release_live(%L, %L, %L, %L)', pg_temp.rel_company(),
		'company', p_name, p_shown))
$$;
create function pg_temp.rel_back(p_name text, p_shown jsonb, p_user uuid default pg_temp.req_owner()) returns jsonb
language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_code_release_back(%L, %L, %L, %L)', pg_temp.rel_company(),
		'company', p_name, p_shown))
$$;
-- What a page shows, as the yes names it.
create function pg_temp.rel_shown(p_page jsonb) returns jsonb language sql immutable as $$
	select jsonb_build_object('live', p_page -> 'live' -> 'version', 'change', p_page -> 'ready' -> 'change',
		'token', p_page -> 'ready' -> 'token')
$$;
-- An owner says yes to what the page shows now.
create function pg_temp.rel_yes(p_name text) returns jsonb language sql as $$
	select pg_temp.rel_live(p_name, pg_temp.rel_shown(pg_temp.rel_page(p_name)))
$$;
create function pg_temp.rel_answer(p_version integer, p_slug text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-release/v1', 'state', 'live', 'version', p_version,
		'url', 'https://sites.qorpera.com/' || p_slug || '/')
$$;
create function pg_temp.rel_moved() returns jsonb language sql immutable as $$
	select '{"schema":"qorpera.code-release/v1","state":"moved"}'::jsonb
$$;
-- The site, a version and a release of company/p_name.
create function pg_temp.rel_site_row(p_name text) returns public.qorpera_company_sites language sql as $$
	select * from public.qorpera_company_sites where environment_id = pg_temp.rec_here() and code_owner = 'company'
		and code_name = p_name
$$;
create function pg_temp.rel_version(p_id uuid) returns public.qorpera_company_site_versions language sql as $$
	select * from public.qorpera_company_site_versions where id = p_id
$$;
create function pg_temp.rel_release(p_name text, p_n integer) returns public.qorpera_code_releases language sql as $$
	select * from public.qorpera_code_releases where environment_id = pg_temp.rec_here() and owner = 'company'
		and name = p_name and n = p_n
$$;
-- The states of company/p_name's versions, by the change each was made at: "1:kept 3:live".
create function pg_temp.rel_states(p_name text) returns text language sql as $$
	select coalesce(string_agg(version.change || ':' || version.state, ' ' order by version.change), '')
	from public.qorpera_company_site_versions version
	where version.site_id = (pg_temp.rel_site_row(p_name)).id
$$;
-- The executor ends a session copy's turn that landed commit p_after: what the agent reads.
create function pg_temp.rel_complete(p_worker uuid, p_after text) returns text language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_session_turns turn set submission = null, submission_receipt_id = null, submitted_at = null
	where turn.worker_id = p_worker and turn.sequence = (select w.sequence from public.qorpera_runtime_workers w where w.id = p_worker);
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(p_worker, pg_temp.rec_token(), 'succeeded', 'Done.', null, null, null,
		jsonb_build_array(jsonb_build_object('kind', 'landed', 'state', 'fast-forward', 'branch', 'main',
			'headSha', pg_temp.rec_sha(p_after), 'mainSha', pg_temp.rec_sha(p_after))), null, 1);
	return (select w.result ->> 'summary' from public.qorpera_runtime_workers w where w.id = p_worker);
end $$;
-- Turn p_sequence of session copy p_n ends failed with the executor's summary: its words, reason and outcome.
create function pg_temp.rel_fail(p_n integer, p_sequence integer, p_summary text) returns jsonb language plpgsql as $$
declare v_worker uuid := pg_temp.rec_turn(p_n, p_sequence, pg_temp.rec_sha('f' || p_sequence), '{}',
	pg_temp.own_repo('company', 'words'));
begin
	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_coding_session_turns turn set submission = null, submission_receipt_id = null, submitted_at = null
	where turn.worker_id = v_worker and turn.sequence = p_sequence;
	perform set_config('session_replication_role', 'origin', true);
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_complete_coding_turn(v_worker, pg_temp.rec_token(), 'failed', p_summary);
	return (select jsonb_build_object('summary', w.result ->> 'summary', 'reason', w.result ->> 'reason',
			'outcome', (select t.outcome ->> 'reason' from public.qorpera_coding_session_turns t
				where t.worker_id = w.id and t.sequence = p_sequence))
		from public.qorpera_runtime_workers w where w.id = v_worker);
end $$;

-- The change due of company/p_name now, or null.
create function pg_temp.rel_due_of(p_name text, p_owner text default 'exec-1170') returns integer language sql as $$
	select (item ->> 'change')::integer from jsonb_array_elements(pg_temp.rel_due(20, p_owner) -> 'sites') item
	where item ->> 'name' = p_name
$$;
-- Another company's site of that name: fresh (its name is taken), or two days old and never finished (abandoned).
create function pg_temp.rel_other_site(p_slug text, p_age interval default interval '0') returns void language sql as $$
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id, updated_at)
	values ('91170000-0000-4000-8000-000000000010', '91170000-0000-4000-8000-000000000020', p_slug, 'site',
		'92400000-0000-4000-8000-000000000030', clock_timestamp() - p_age)
$$;
-- The rows company/p_name's site files and parts have.
create function pg_temp.rel_rows(p_version uuid) returns text language sql as $$
	select (select count(*) from public.qorpera_company_site_files f where f.version_id = p_version) || ' files, '
		|| (select count(*) from public.qorpera_company_site_files f where f.version_id = p_version and f.content is not null)
		|| ' with bytes, ' || (select count(*) from public.qorpera_company_site_file_parts k where k.version_id = p_version) || ' parts'
$$;
-- A member's name in the company, as the list file names them.
create function pg_temp.rel_name(p_user uuid) returns text language sql as $$
	select display_name from public.qorpera_profile_members where profile_id = pg_temp.rel_company() and user_id = p_user
$$;
-- A file's bytes as they are now (read in a statement of its own, after the calls before it in the same check).
create function pg_temp.rel_content(p_version uuid, p_path text) returns bytea language sql as $$
	select content from public.qorpera_company_site_files where version_id = p_version and path = p_path
$$;
-- The answers of the upload's calls.
create function pg_temp.rel_said_list(p_state text, p_missing integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site-list/v1', 'state', p_state, 'missing', p_missing)
$$;
create function pg_temp.rel_list_refused(p_code text, p_path text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site-list/v1', 'state', 'refused', 'code', p_code, 'path', p_path)
$$;
create function pg_temp.rel_kept_parts(p_filed integer) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site-put/v1', 'state', 'kept', 'filed', p_filed)
$$;
create function pg_temp.rel_put_refused(p_path text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site-put/v1', 'state', 'refused', 'code', 'SITE_FILE_DIFFERS', 'path', p_path)
$$;
create function pg_temp.rel_begun_refused(p_code text) returns jsonb language sql immutable as $$
	select jsonb_build_object('schema', 'qorpera.code-site-begin/v1', 'state', 'refused', 'code', p_code)
$$;
-- company/up's files: rel_texts' and two more.
create function pg_temp.rel_up_texts(p_word text) returns jsonb language sql immutable as $$
	select pg_temp.rel_texts(p_word) || jsonb_build_object('a/one.js', 'export const one = 1;', 'big.txt', repeat('0123456789', 30))
$$;
-- A publish_site request for one file, as the runtime makes it.
create function pg_temp.rel_publish(p_slug text, p_source text) returns jsonb language sql immutable as $$
	select jsonb_build_object('slug', p_slug, 'source', p_source, 'files', jsonb_build_array(pg_temp.rel_file('index.html', '<p>hi</p>')),
		'manifestSha256', pg_temp.rel_manifest('{"index.html":"<p>hi</p>"}') ->> 'manifestSha256')
$$;

select pg_temp.rel_repository(name) from unnest(array['shape', 'kept', 'said', 'due', 'undone', 'given', 'off', 'slugs',
	'gift_message.app', 'api', 'taken', 'abandoned', 'full', 'tenth', 'up', 'a1-web', 'a2-moved', 'a3-chain', 'a4-prune']) name \g /dev/null

-- 1. Rights, the columns, the marker --------------------------------------------------------------------------------------
do $$
declare v_role text; v_function text; v_table text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		foreach v_function in array array['public.qorpera_code_sites_due(text,text,integer)',
			'public.qorpera_code_site_begin(text,text,uuid,text,text,integer,jsonb)',
			'public.qorpera_code_site_list(text,text,uuid,jsonb)', 'public.qorpera_code_site_missing(text,text,uuid,text,integer)',
			'public.qorpera_code_site_put(text,text,uuid,jsonb)', 'public.qorpera_code_site_finish(text,text,uuid)',
			'public.qorpera_code_site_failed(text,text,uuid,text,text,integer,text)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'service_role'),
				v_function || ' is the service role''s only: ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_list_code_releases(uuid)',
			'public.qorpera_put_code_release_live(uuid,text,text,jsonb)', 'public.qorpera_code_release_back(uuid,text,text,jsonb)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'authenticated'),
				v_function || ' is the members'' only: ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_code_site_valid(jsonb)', 'public.qorpera_code_change_site_valid(jsonb)',
			'public.qorpera_code_release_live(public.qorpera_code_repositories)',
			'public.qorpera_code_release_point(public.qorpera_code_repositories,integer,boolean)',
			'public.qorpera_code_site_slugs(text,text)', 'public.qorpera_code_site_prune(uuid)',
			'public.qorpera_code_release_index(public.qorpera_code_repositories)',
			'public.qorpera_code_site_repository(text,text,uuid)', 'public.qorpera_code_release_switch(uuid,uuid)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'), v_function || ' is closed to ' || v_role);
		end loop;
		foreach v_table in array array['public.qorpera_code_releases', 'public.qorpera_company_site_file_parts'] loop
			perform pg_temp.base_assert(not has_table_privilege(v_role, v_table, 'SELECT,INSERT,UPDATE,DELETE'),
				v_table || ' is closed to ' || v_role);
		end loop;
	end loop;
	perform pg_temp.base_assert((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
		where oid in ('public.qorpera_code_sites_due(text,text,integer)'::regprocedure,
			'public.qorpera_code_site_put(text,text,uuid,jsonb)'::regprocedure, 'public.qorpera_list_code_releases(uuid)'::regprocedure,
			'public.qorpera_put_code_release_live(uuid,text,text,jsonb)'::regprocedure)), 'definers with an empty search path');
	perform pg_temp.base_assert((select bool_and(proconfig @> array['lock_timeout=3s']) from pg_proc
		where oid in ('public.qorpera_put_code_release_live(uuid,text,text,jsonb)'::regprocedure,
			'public.qorpera_code_release_back(uuid,text,text,jsonb)'::regprocedure)), 'the member''s writes wait 3 s at most');
	-- Every repository starts with its site switched on and nothing released; no row of before says anything of a site.
	perform pg_temp.base_assert((select bool_and(r.site_enabled and r.site_id is null and r.last_release = 0
			and r.live_release is null and r.last_version = 0 and r.site_attempts = 0 and r.site_given_up is null)
		from public.qorpera_code_repositories r where r.environment_id = pg_temp.rec_here()), 'sites are on, nothing released');
	perform pg_temp.base_assert((select count(*) = 6 and bool_and(c.site_state is null and c.site is null and c.site_problem is null)
		from public.qorpera_code_changes c where c.environment_id = pg_temp.rec_here() and c.name = 'shop'), 'shop''s six rows');
	-- made carries its site and missed its problem, and nothing else does.
	for v_function in select format('(%L::text, %L::jsonb, %L::text)', bad.state, bad.site, bad.problem) from (values ('made', null::jsonb, null::text),
		('made', '{"tree":"a"}', 'SITE_BOUNDARY'), ('missed', null, null), ('missed', '{"tree":"a"}', 'SITE_BOUNDARY'),
		(null, '{"tree":"a"}', null), (null, null, 'SITE_BOUNDARY'), ('kept', null, null), ('made', '[]', null),
		('missed', null, 'site boundary'), ('made', jsonb_build_object('pad', repeat('p', 2048)), null)) bad(state, site, problem) loop
		perform pg_temp.base_error(format($q$insert into public.qorpera_code_changes(environment_id, owner, name, n, profile_id,
			kind, state, main_after, title, site_state, site, site_problem) select pg_temp.rec_here(), 'company', 'shape', 99,
			pg_temp.rel_company(), 'found', 'landed', pg_temp.rec_sha('x'), 'A row', bad.* from (values %s) bad$q$, v_function), '23514');
	end loop;
	-- Each changed body carries the marker.
	foreach v_function in array array['public.qorpera_code_checks_switch(uuid,uuid)',
		'public.qorpera_code_change_report_valid(jsonb)', 'public.qorpera_record_code_change(uuid,uuid,jsonb)',
		'public.qorpera_code_change_files(text,text,uuid,text,text,integer)',
		'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)', 'public.qorpera_code_restore_record(text,text,uuid,uuid,jsonb)',
		'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)',
		'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)', 'public.qorpera_site_publish_check(jsonb,text)',
		'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)', 'public.qorpera_site_unpublish(jsonb,text)',
		'public.qorpera_list_company_sites(uuid)', 'public.qorpera_site_abandoned(public.qorpera_company_sites)',
		'public.qorpera_unpublish_company_site(uuid)', 'public.qorpera_member_app_layout_valid(jsonb)'] loop
		perform pg_temp.base_assert(strpos(pg_get_functiondef(v_function::regprocedure), '20260930729000') > 0,
			'the marker is in ' || v_function);
	end loop;
end $$;

-- 2. Report v3 ------------------------------------------------------------------------------------------------------------
do $$
declare v_bad jsonb; v_place integer; w uuid; h text := pg_temp.rec_sha('sh'); a text := pg_temp.rec_sha('sa');
	b text := pg_temp.rec_sha('sb'); v_ok jsonb := pg_temp.rel_passed('sa'); v_site jsonb := pg_temp.rel_site('s1');
	r public.qorpera_code_changes%rowtype; q public.qorpera_code_repositories%rowtype;
	v_refusal jsonb := '{"refusal":{"code":"CODE_HOST_NAMES_DIFFER_BY_CASE","paths":["Readme.md","README.md"]}}';
begin
	-- Valid: a passed landing with no site, made (at its bounds too) or missed; every other state, and a landing with no
	-- checks file or with checks off, with none.
	perform pg_temp.base_assert(public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, 'null'))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1')))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1',
			jsonb_build_object('folder', '.', 'name', 'gift-message', 'title', repeat('å', 120)))))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1',
			jsonb_build_object('folder', repeat('d', 150) || '/' || repeat('e', 149), 'files', 500, 'bytes', 26214400,
				'name', repeat('n', 48), 'title', 'A'))))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1',
			'{"files":1,"bytes":0,"folder":"site/out_2.x"}')))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed()))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed('CODE_HOST:SITE_1')))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('unchanged', h, a, a, null, 'null'))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('conflict', h, null, null, null, 'null'))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('refused', h, null, null, null, 'null', v_refusal))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, '{"state":"none"}', 'null'))
		and public.qorpera_code_change_report_valid(pg_temp.rel_report('landed', h, b, a, '{"state":"off"}', 'null')),
		'reports that are valid');
	-- Each that is not, and the record call refuses it.
	w := pg_temp.rec_turn(1600, 1, h, '{}', pg_temp.own_repo('company', 'shape'));
	for v_bad, v_place in select bad.item, bad.place from unnest(array[
		-- A site for a state that did not land, or a landing whose checks did not pass; v3 with no site; v1 and v2 with one.
		pg_temp.rel_report('conflict', h, null, null, null, pg_temp.rel_made('s1')),
		pg_temp.rel_report('unchanged', h, a, a, null, pg_temp.rel_missed()),
		pg_temp.rel_report('refused', h, null, null, null, pg_temp.rel_made('s1'), v_refusal),
		pg_temp.rel_report('landed', h, b, a, '{"state":"none"}', pg_temp.rel_made('s1')),
		pg_temp.rel_report('landed', h, b, a, '{"state":"off"}', pg_temp.rel_missed()),
		pg_temp.rel_report('landed', h, b, a, v_ok, 'null') - 'site',
		pg_temp.rec_report('landed', h, b, a, jsonb_build_object('schema', 'qorpera.code-change-report/v2', 'checks', v_ok,
			'site', null)),
		pg_temp.rec_report('landed', h, b, a, '{"site":null}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, 'null', '{"schema":"qorpera.code-change-report/v4"}'),
		-- The site value's shape.
		pg_temp.rel_report('landed', h, b, a, v_ok, '"made"'), pg_temp.rel_report('landed', h, b, a, v_ok, '{}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, '{"state":"made"}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, '{"state":"made","site":null}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1') || '{"code":"SITE_BOUNDARY"}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, '{"state":"missed"}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed('site boundary')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed('')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed(repeat('X', 121))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_missed() || '{"site":null}'),
		pg_temp.rel_report('landed', h, b, a, v_ok, '{"state":"skipped"}'),
		-- The made site: its schema, tree, counts, folder, name and title, a key too many or too few.
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"schema":"qorpera.code-site/v2"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"tree":"abc"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', jsonb_build_object('tree', upper(pg_temp.rec_sha('t'))))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"files":0}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"files":501}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"files":"3"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"files":2.5}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"bytes":26214401}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"bytes":-1}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"bytes":null}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":""}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"/dist"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"dist/"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"a//b"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"./dist"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"a/../b"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":"a\\b"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', jsonb_build_object('folder', E'a\tb'))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', jsonb_build_object('folder', repeat('d', 301)))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"folder":null}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"name":"Gift"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"name":"api"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"name":"ab"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"name":"-gift"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"name":7}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"title":" Gift"}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"title":"Gift "}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', jsonb_build_object('title', E'Gift\nmessage'))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', jsonb_build_object('title', repeat('t', 121)))),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"title":""}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"title":7}')),
		pg_temp.rel_report('landed', h, b, a, v_ok, jsonb_build_object('state', 'made', 'site', v_site - 'title')),
		pg_temp.rel_report('landed', h, b, a, v_ok, pg_temp.rel_made('s1', '{"manifestSha256":"x"}'))])
		with ordinality bad(item, place) loop
		perform pg_temp.base_assert(not public.qorpera_code_change_report_valid(v_bad),
			'no report ' || v_place || ': ' || left(v_bad::text, 600));
		perform pg_temp.base_error(format('select pg_temp.rec_record(%L, %L)', w, v_bad), '22023', 'Code change report invalid');
	end loop;
	perform pg_temp.base_assert((pg_temp.rec_shop('shape')).last_change = 0, 'none of them wrote a row');

	-- Each kept on its row: made, missed, none; v2 and a conflict of v3 say nothing of a site.
	perform pg_temp.base_assert(pg_temp.rel_land(1601, 'x0', 'x1', pg_temp.rel_made('s1'), 'shape') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_said(1, 'shape') = pg_temp.rel_kept('made', v_site)
		and pg_temp.rel_land(1602, 'x1', 'x2', pg_temp.rel_missed(), 'shape') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.rel_said(2, 'shape') = pg_temp.rel_kept('missed', null, 'SITE_BOUNDARY')
		and pg_temp.rel_land(1603, 'x2', 'x3', 'null', 'shape') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.rel_said(3, 'shape') = pg_temp.rel_kept(null, null)
		and pg_temp.rec_record(pg_temp.rec_turn(1604, 1, pg_temp.rec_sha('x4'), '{}', pg_temp.own_repo('company', 'shape')),
			pg_temp.rec_report('landed', pg_temp.rec_sha('x4'), pg_temp.rec_sha('x3'), pg_temp.rec_sha('x4'), jsonb_build_object(
				'schema', 'qorpera.code-change-report/v2', 'checks', pg_temp.rel_passed('x4')))) = pg_temp.rec_answer('recorded', 4)
		and pg_temp.rel_said(4, 'shape') = pg_temp.rel_kept(null, null)
		and pg_temp.rec_record(pg_temp.rec_turn(1605, 1, pg_temp.rec_sha('x5'), '{}', pg_temp.own_repo('company', 'shape')),
			pg_temp.rel_report('conflict', pg_temp.rec_sha('x5'), null, null, null, 'null')) = pg_temp.rec_answer('recorded', 5)
		and pg_temp.rel_said(5, 'shape') = pg_temp.rel_kept(null, null), 'made, missed, none, v2, a conflict');
	-- In line, main somewhere else: a filler first, then the landing. Made after the job, the turn whose commit the
	-- filler ends at takes it over, with its site.
	perform pg_temp.base_assert(pg_temp.rel_land(1606, 'x6', 'x7', 'null', 'shape') = pg_temp.rec_answer('recorded', 7)
		and pg_temp.rec_is(6, 'found', 'landed', 'x4', 'x6', 'shape') and pg_temp.rel_said(6, 'shape') = pg_temp.rel_kept(null, null),
		'a filler first');
	perform pg_temp.base_assert(pg_temp.rel_land(1607, 'x4', 'x6', pg_temp.rel_made('s2'), 'shape', '{}', '{"inLine":false}')
			= pg_temp.rec_answer('adopted', 6)
		and pg_temp.rec_is(6, 'landing', 'landed', 'x4', 'x6', 'shape')
		and pg_temp.rel_said(6, 'shape') = pg_temp.rel_kept('made', pg_temp.rel_site('s2')), 'a filler taken over by v3');
	-- A replay answers the row as it is, whatever the report says of the site.
	r := pg_temp.rec_row(6, 'shape'); q := pg_temp.rec_shop('shape');
	perform pg_temp.base_assert(pg_temp.rec_record(pg_temp.rec_copy(1607), pg_temp.rel_report('landed', pg_temp.rec_sha('x6'),
			pg_temp.rec_sha('x4'), pg_temp.rec_sha('x6'), pg_temp.rel_passed('x6'), pg_temp.rel_missed(), '{"inLine":false}'))
			= pg_temp.rec_answer('replayed', 6)
		and to_jsonb(pg_temp.rec_row(6, 'shape')) = to_jsonb(r) and to_jsonb(pg_temp.rec_shop('shape')) = to_jsonb(q), 'a replay');
end $$;

-- 3. The switch, inheriting rows, the platform's line and the rounds ----------------------------------------------------------
do $$
declare w uuid := pg_temp.rec_turn(1620, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'said')); v jsonb;
	v_bundle text; v_tail text; v_line text; v_other uuid; v_nowhere uuid;
	v_site_words constant text := 'Nothing went into main: every check passed, but the site in "dist" has no index.html at its '
		|| 'top. Fix it in the code or in the checks file''s "site", and finish again.';
	v_failed constant text := 'Nothing went into main: the check "build" failed on this change. Fix the cause in the code.';
begin
	-- The switch says whether a site is kept: on, off for that repository alone, and on with no registry row.
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_checks_switch(w, pg_temp.rec_token());
	reset role;
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":true}', 'on: ' || v::text);
	update public.qorpera_code_repositories set site_enabled = false
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'said';
	v_other := pg_temp.rec_turn(1621, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'shape'));
	v_nowhere := pg_temp.rec_turn(1622, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'nowhere'));
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_checks_switch(w, pg_temp.rec_token())
		|| jsonb_build_object('other', public.qorpera_code_checks_switch(v_other, pg_temp.rec_token()) -> 'site',
			'nowhere', public.qorpera_code_checks_switch(v_nowhere, pg_temp.rec_token()) -> 'site');
	reset role;
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":false,"other":true,'
		'"nowhere":true}', 'off for said alone: ' || v::text);
	update public.qorpera_code_repositories set site_enabled = true
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'said';

	-- company/kept: change 1 made site k1, change 2 site k2. An undo of change 2 and all after it goes back to change 1's
	-- files and inherits its site; an undo of one change makes none; a restore to change 2's main inherits its site.
	perform pg_temp.base_assert(pg_temp.rel_land(1623, 'k0', 'k1', pg_temp.rel_made('k1'), 'kept') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_land(1624, 'k1', 'k2', pg_temp.rel_made('k2'), 'kept') = pg_temp.rec_answer('recorded', 2), 'kept''s changes');
	perform pg_temp.base_assert(pg_temp.req_undone('rel-undo-1', 2, true, 'k2', 'u1', '{}', 'kept') = pg_temp.req_recorded(3)
		and (pg_temp.rec_row(3, 'kept')).checks_state = 'inherited'
		and pg_temp.rel_said(3, 'kept') = pg_temp.rel_kept('made', pg_temp.rel_site('k1')),
		'andLater inherits the site: ' || pg_temp.rel_said(3, 'kept')::text);
	perform pg_temp.base_assert(pg_temp.rel_land(1625, 'u1', 'k3', pg_temp.rel_made('k3'), 'kept') = pg_temp.rec_answer('recorded', 4)
		and pg_temp.req_undone('rel-undo-2', 4, false, 'k3', 'u2', '{}', 'kept') = pg_temp.req_recorded(5)
		and pg_temp.rel_said(5, 'kept') = pg_temp.rel_kept(null, null), 'one change: none');
	v_bundle := '20261111T070000Z-' || repeat('7', 12);
	v := pg_temp.req_restore_to(v_bundle, 'k2', 'kept', 'u2');
	perform pg_temp.base_assert(v ->> 'change' = '6' and v -> 'keptThrough' = '2'
		and pg_temp.rel_said(6, 'kept') = pg_temp.rel_kept('made', pg_temp.rel_site('k2'))
		and pg_temp.req_restore_end(v_bundle, 'k2') = pg_temp.req_recorded(6), 'a restore inherits the site: ' || v::text);

	-- The platform's line after a landing: made, missed, no site. (The restore let every turn's lease go: new copies.)
	w := pg_temp.rec_turn(1628, 1, pg_temp.rec_sha('s1'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.rel_report('landed', pg_temp.rec_sha('s1'), pg_temp.rec_sha('s0'),
		pg_temp.rec_sha('s1'), pg_temp.rel_passed('s1'), pg_temp.rel_made('s1'))) = pg_temp.rec_answer('recorded', 1), 'said 1');
	v_tail := ' Its checks passed: build. Qorpera keeps its site for What''s new, where a member puts it live.';
	v_line := pg_temp.rel_complete(w, 's1');
	perform pg_temp.base_assert(right(v_line, length(v_tail)) = v_tail, 'made: ' || coalesce(v_line, 'none'));
	w := pg_temp.rec_turn(1626, 1, pg_temp.rec_sha('s2'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.rel_report('landed', pg_temp.rec_sha('s2'), pg_temp.rec_sha('s1'),
		pg_temp.rec_sha('s2'), pg_temp.rel_passed('s2'), pg_temp.rel_missed())) = pg_temp.rec_answer('recorded', 2), 'said 2');
	v_tail := ' Its checks passed: build. Qorpera could not keep its site this time (SITE_BOUNDARY); the next change that '
		|| 'goes in keeps one.';
	v_line := pg_temp.rel_complete(w, 's2');
	perform pg_temp.base_assert(right(v_line, length(v_tail)) = v_tail, 'missed: ' || coalesce(v_line, 'none'));
	w := pg_temp.rec_turn(1627, 1, pg_temp.rec_sha('s3'), '{}', pg_temp.own_repo('company', 'said'));
	perform pg_temp.base_assert(pg_temp.rec_record(w, pg_temp.rel_report('landed', pg_temp.rec_sha('s3'), pg_temp.rec_sha('s2'),
		pg_temp.rec_sha('s3'), pg_temp.rel_passed('s3'), 'null')) = pg_temp.rec_answer('recorded', 3), 'said 3');
	v_tail := '.md. Its checks passed: build.';
	v_line := pg_temp.rel_complete(w, 's3');
	perform pg_temp.base_assert(right(v_line, length(v_tail)) = v_tail, 'no site: ' || coalesce(v_line, 'none'));

	-- A refused site keeps the executor's words and its code, and counts as a round with the failed checks.
	perform pg_temp.base_assert(pg_temp.rel_fail(1629, 1, v_site_words || ' [code=CODING_CHECKS_SITE_REFUSED]')
		= jsonb_build_object('summary', v_site_words, 'reason', 'CODING_CHECKS_SITE_REFUSED',
			'outcome', 'CODING_CHECKS_SITE_REFUSED'), 'a refused site, the first round');
	perform pg_temp.base_assert(pg_temp.rel_fail(1629, 2, v_failed || ' [code=CODING_CHECKS_FAILED]')
		= jsonb_build_object('summary', v_failed || ' The checks failed for this session 2 times in a row.',
			'reason', 'CODING_CHECKS_FAILED', 'outcome', 'CODING_CHECKS_FAILED'), 'a failed check after it, the second round');
	v := pg_temp.rel_fail(1629, 3, v_site_words || ' [code=CODING_CHECKS_SITE_REFUSED]');
	perform pg_temp.base_assert(v = jsonb_build_object('summary', v_site_words || ' The checks failed for this session 3 times '
		|| 'in a row: instead of another follow-up that tries again, narrow the change or drop it.',
		'reason', 'CODING_CHECKS_SITE_REFUSED', 'outcome', 'CODING_CHECKS_SITE_REFUSED'), 'the third round: ' || v::text);
end $$;

-- publish_site makes a site holding the company's lock on making one (the review of #1686): a repository's first upload
-- waits on it before it counts the ten (1222 shows the wait; an agent's run is seen by this connection alone). Here,
-- before any upload of this file took that lock in this one transaction.
do $$
declare v jsonb; v_review uuid;
begin
	perform pg_temp.base_assert(not exists (select 1 from pg_locks lock where lock.locktype = 'advisory'
		and lock.pid = pg_backend_pid() and lock.objsubid = 1 and ((lock.classid::bigint << 32) | lock.objid::bigint)
			= hashtextextended('qorpera.company-sites:' || pg_temp.rel_company(), 0)), 'no lock before');
	v_review := extensions.gen_random_uuid();
	insert into public.qorpera_action_reviews (id, profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, answer, answered_at, consumed_at,
		consumed_run_id)
	values (v_review, pg_temp.rel_company(), (pg_temp.c3_alice() ->> 'runId')::uuid, 'rel-lock-review',
		'92400000-0000-4000-8000-000000000030', 'publish_site', 'external', repeat('c', 64), jsonb_build_object('title',
			'Publish a new password-protected website', 'target', null, 'details', '{}'::jsonb, 'arguments',
			jsonb_build_object('slug', 'brand-lock', 'source', 'product/lock')::text),
		'ask', 'access_change', 'Reviewed.', 'gpt-6-luna', 'owners_admins', 'allow_once', clock_timestamp(), clock_timestamp(),
		(pg_temp.c3_alice() ->> 'runId')::uuid);
	v := public.qorpera_site_publish_begin(pg_temp.c3_alice(), 'rel-lock-call', pg_temp.rel_publish('brand-lock', 'product/lock'),
		v_review);
	perform pg_temp.base_assert(v ->> 'mode' = 'new' and exists (select 1 from pg_locks lock where lock.locktype = 'advisory'
		and lock.pid = pg_backend_pid() and lock.objsubid = 1 and ((lock.classid::bigint << 32) | lock.objid::bigint)
			= hashtextextended('qorpera.company-sites:' || pg_temp.rel_company(), 0)), 'publish_site holds the company''s lock: ' || v::text);
	delete from public.qorpera_company_sites where slug = 'brand-lock';
end $$;

-- 4. The due list ---------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_version uuid; v_index bigint;
begin
	-- company/due: sites at changes 1 and 2, none at 3, missed at 4: the newest point, change 2, is due with its site.
	perform pg_temp.base_assert(pg_temp.rel_land(1630, 'e0', 'e1', pg_temp.rel_made('e1'), 'due') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_land(1631, 'e1', 'e2', pg_temp.rel_made('e2'), 'due') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.rel_land(1632, 'e2', 'e3', 'null', 'due') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.rel_land(1633, 'e3', 'e4', pg_temp.rel_missed(), 'due') = pg_temp.rec_answer('recorded', 4), 'due''s changes');
	v := (select item from jsonb_array_elements(pg_temp.rel_due() -> 'sites') item where item ->> 'name' = 'due');
	perform pg_temp.base_assert(v = jsonb_build_object('companyId', pg_temp.rel_company(), 'environmentId', pg_temp.rec_here(),
		'owner', 'company', 'name', 'due', 'change', 2, 'site', pg_temp.rel_site('e2'))
		and pg_temp.rel_due() ->> 'schema' = 'qorpera.code-sites-due/v1', 'due: ' || coalesce(v::text, 'none'));
	-- Uploaded, it is not due; a later change with the same files is not due either, and its begin finds that version.
	v_version := pg_temp.rel_upload('due', 2, 'e2');
	perform pg_temp.base_assert(pg_temp.rel_due_of('due') is null
		and pg_temp.rel_land(1634, 'e4', 'e5', pg_temp.rel_made('e2'), 'due') = pg_temp.rec_answer('recorded', 5)
		and pg_temp.rel_due_of('due') is null, 'uploaded');
	v := pg_temp.rel_begin('due', 5, pg_temp.rel_manifest(pg_temp.rel_texts('e2')));
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-site-begin/v1', 'state', 'ready',
		'versionId', v_version, 'slug', 'due', 'listed', true), 'found again: ' || v::text);
	-- company/undone: changes 1 to 3 with sites; then change 2 alone is taken out (row 4). Change 3 held it, so the
	-- newest point is change 1.
	perform pg_temp.base_assert(pg_temp.rel_land(1635, 'g0', 'g1', pg_temp.rel_made('g1'), 'undone') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_land(1636, 'g1', 'g2', pg_temp.rel_made('g2'), 'undone') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.rel_land(1637, 'g2', 'g3', pg_temp.rel_made('g3'), 'undone') = pg_temp.rec_answer('recorded', 3)
		and pg_temp.rel_due_of('undone') = 3, 'undone''s changes');
	perform pg_temp.base_assert(pg_temp.req_undone('rel-undo-g', 2, false, 'g3', 'g4', '{}', 'undone') = pg_temp.req_recorded(4)
		and pg_temp.rel_due_of('undone') = 1, 'a row taken out later is passed over: ' || coalesce(pg_temp.rel_due_of('undone')::text, 'none'));
	-- company/kept's restore (section 3) is its newest point: the rows it went back past are no part of it.
	perform pg_temp.base_assert(pg_temp.rel_due_of('kept') = 6, 'a restore''s row: ' || coalesce(pg_temp.rel_due_of('kept')::text, 'none'));
	-- Its pause: a repository whose pause is not over is not due.
	update public.qorpera_code_repositories set site_not_before = clock_timestamp() + interval '1 hour'
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'undone';
	perform pg_temp.base_assert(pg_temp.rel_due_of('undone') is null, 'paused');
	update public.qorpera_code_repositories set site_not_before = null
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'undone';
	-- company/given: five failed uploads of change 1 give it up (the list is written again then); a newer change is due
	-- again, and its failures count from one.
	perform pg_temp.base_assert(pg_temp.rel_land(1638, 'v0', 'v1', pg_temp.rel_made('v1'), 'given') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_due_of('given') = 1, 'given''s change');
	for i in 1..5 loop
		v_index := (pg_temp.rec_shop('given')).index_version;
		v := pg_temp.rel_failed('given', 1, 'CODE_HOST_SITE_READ_FAILED');
		perform pg_temp.base_assert(v = '{"schema":"qorpera.code-site-failed/v1","state":"recorded"}'
			and (pg_temp.rec_shop('given')).site_attempts = i and (pg_temp.rec_shop('given')).site_change = 1
			and (pg_temp.rec_shop('given')).site_problem = 'CODE_HOST_SITE_READ_FAILED'
			and (pg_temp.rec_shop('given')).site_given_up is not distinct from case when i = 5 then 1 end
			and (pg_temp.rec_shop('given')).index_version = v_index + case when i = 5 then 1 else 0 end
			and pg_temp.rel_due_of('given') is null, 'failure ' || i || ': ' || to_jsonb(pg_temp.rec_shop('given'))::text);
		update public.qorpera_code_repositories set site_not_before = null
		where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'given';
		perform pg_temp.base_assert(pg_temp.rel_due_of('given') is not distinct from case when i < 5 then 1 end,
			'after failure ' || i);
	end loop;
	perform pg_temp.base_assert(pg_temp.rel_land(1639, 'v1', 'v2', pg_temp.rel_made('v2'), 'given') = pg_temp.rec_answer('recorded', 2)
		and pg_temp.rel_due_of('given') = 2 and pg_temp.rel_failed('given', 2, 'SITE_UPLOAD_FAILED') ->> 'state' = 'recorded'
		and (pg_temp.rec_shop('given')).site_attempts = 1 and (pg_temp.rec_shop('given')).site_change = 2, 'a newer change');
	-- company/off: switched off, nothing is due.
	perform pg_temp.base_assert(pg_temp.rel_land(1640, 'o0', 'o1', pg_temp.rel_made('o1'), 'off') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_due_of('off') = 1, 'off''s change');
	update public.qorpera_code_repositories set site_enabled = false
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'off';
	perform pg_temp.base_assert(pg_temp.rel_due_of('off') is null, 'switched off');
	-- An executor that does not hold the company gets nothing; custody and the limit.
	perform pg_temp.base_assert(pg_temp.rel_due_names() <> '' and pg_temp.rel_due_names('exec-other') = '', 'not the holder');
	perform pg_temp.base_error(format('select pg_temp.rel_due(20, %L, %L)', 'exec-1170', 'not-a-machine'), '42501',
		'Coding machine custody required');
	perform pg_temp.base_error('select pg_temp.rel_due(0)', '22023', 'Code sites limit invalid');
	perform pg_temp.base_error('select pg_temp.rel_due(21)', '22023', 'Code sites limit invalid');
end $$;

-- 5. Begin: the site, its name, the tenth -------------------------------------------------------------------------------
do $$
declare v jsonb; v_version uuid; s public.qorpera_company_sites%rowtype; o public.qorpera_company_site_versions%rowtype;
	r public.qorpera_code_changes%rowtype; v_count integer; v_slug text;
	v_manifest jsonb := pg_temp.rel_manifest(pg_temp.rel_texts('l1'));
	v_limit constant text := 'SITE_LIMIT: the company has 10 sites, counting a project''s site that waits in What''s new; '
		|| 'update or unpublish one first';
begin
	-- The name the checks file asks for, free: the site is made with it, the repository's own, with a new password, and
	-- the version of the row's tree is uploading, its files not named yet.
	perform pg_temp.base_assert(pg_temp.rel_land(1650, 'l0', 'l1', pg_temp.rel_made('l1', '{"name":"shopfront","title":"Shop front"}'),
		'slugs') = pg_temp.rec_answer('recorded', 1), 'slugs'' change');
	v := pg_temp.rel_begin('slugs', 1, v_manifest);
	v_version := (v ->> 'versionId')::uuid; s := pg_temp.rel_site_row('slugs'); o := pg_temp.rel_version(v_version);
	r := pg_temp.rec_row(1, 'slugs');
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-site-begin/v1', 'state', 'uploading',
			'versionId', v_version, 'slug', 'shopfront', 'listed', false)
		and s.slug = 'shopfront' and s.kind = 'files' and s.profile_id = pg_temp.rel_company() and s.environment_id = pg_temp.rec_here()
		and s.source_path = 'code/company/slugs' and s.title = 'Shop front' and s.current_version_id is null and s.published_at is null
		and s.created_by_staff_agent_id is not distinct from r.staff_agent_id and s.published_by_user_id is null
		and (pg_temp.rec_shop('slugs')).site_id = s.id
		and (select password ~ '^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$' from public.qorpera_company_site_secrets where site_id = s.id)
		and o.site_id = s.id and o.state = 'uploading' and not o.listed and o.tree = pg_temp.rec_sha('tree:l1') and o.change = 1
		and o.main_sha = pg_temp.rec_sha('l1') and o.first_publish and o.title = 'Shop front' and o.source_path = 'code/company/slugs'
		and o.manifest_sha256 = v_manifest ->> 'manifestSha256' and o.file_count = 3 and o.total_bytes = (v_manifest ->> 'bytes')::bigint
		and o.run_id is null and o.call_id is null and o.staff_agent_id is null and o.published_at is null
		and pg_temp.rel_rows(v_version) = '0 files, 0 with bytes, 0 parts', 'the site and its version: ' || v::text);
	-- The same begin again finds it; files, size or manifest that are not the row's are refused, and so is a row that
	-- made no site, or none at all.
	perform pg_temp.base_assert(pg_temp.rel_begin('slugs', 1, v_manifest) = v
		and pg_temp.rel_begin('slugs', 1, v_manifest || '{"files":4}') = pg_temp.rel_begun_refused('SITE_TREE_DIFFERS')
		and pg_temp.rel_begin('slugs', 1, v_manifest || jsonb_build_object('bytes', (v_manifest ->> 'bytes')::integer + 1))
			= pg_temp.rel_begun_refused('SITE_TREE_DIFFERS')
		and pg_temp.rel_begin('slugs', 1, v_manifest || jsonb_build_object('manifestSha256', repeat('0', 64)))
			= pg_temp.rel_begun_refused('SITE_TREE_DIFFERS')
		and pg_temp.rel_begin('slugs', 9, v_manifest) = pg_temp.rel_begun_refused('SITE_ROW_GONE')
		and pg_temp.rel_begin('due', 4, v_manifest) = pg_temp.rel_begun_refused('SITE_ROW_GONE')
		and pg_temp.rel_begin('due', 3, v_manifest) = pg_temp.rel_begun_refused('SITE_ROW_GONE'), 'refused');
	-- Lost: an executor that does not hold the company, a repository nobody registered.
	perform pg_temp.base_assert(pg_temp.rel_begin('slugs', 1, v_manifest, 'exec-other') = '{"schema":"qorpera.code-site-begin/v1","state":"lost"}'
		and pg_temp.rel_begin('nowhere', 1, v_manifest) = '{"schema":"qorpera.code-site-begin/v1","state":"lost"}', 'lost');
	-- What the call takes.
	foreach v in array array[v_manifest - 'bytes', v_manifest || '{"more":1}', v_manifest || '{"files":"3"}',
		v_manifest || '{"files":-1}', v_manifest || '{"manifestSha256":"abc"}', '[]'::jsonb] loop
		perform pg_temp.base_error(format('select pg_temp.rel_begin(%L, 1, %L)', 'slugs', v), '22023', 'Code site begin invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.rel_begin(%L, 0, %L)', 'slugs', v_manifest), '22023', 'Code site begin invalid');
	-- A newer change's version ends the upload it overtook: one upload a site is open.
	perform pg_temp.base_assert(pg_temp.rel_land(1651, 'l1', 'l2', pg_temp.rel_made('l2', '{"name":"shopfront"}'), 'slugs')
		= pg_temp.rec_answer('recorded', 2), 'slugs'' second change');
	v := pg_temp.rel_begin('slugs', 2, pg_temp.rel_manifest(pg_temp.rel_texts('l2')));
	perform pg_temp.base_assert(v ->> 'state' = 'uploading' and v ->> 'slug' = 'shopfront' and (v ->> 'versionId')::uuid <> v_version
		and (pg_temp.rel_version(v_version)).id is null and pg_temp.rel_states('slugs') = '2:uploading', 'one upload: ' || v::text);

	-- The name the file asks for is taken (by slugs' site): the repository's name, _ and . made -.
	perform pg_temp.base_assert(pg_temp.rel_land(1652, 'n0', 'n1', pg_temp.rel_made('n1', '{"name":"shopfront"}'), 'gift_message.app')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_begin('gift_message.app', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1'))) ->> 'slug' = 'gift-message-app',
		'derived');
	-- A reserved name: -2.
	perform pg_temp.base_assert(pg_temp.rel_land(1653, 'n0', 'n1', pg_temp.rel_made('n1'), 'api') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_begin('api', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1'))) ->> 'slug' = 'api-2', 'reserved');
	-- Another company's site has the name: -2.
	perform pg_temp.rel_other_site('taken');
	perform pg_temp.base_assert(pg_temp.rel_land(1654, 'n0', 'n1', pg_temp.rel_made('n1'), 'taken') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_begin('taken', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1'))) ->> 'slug' = 'taken-2', 'taken');
	-- Another company's site that never went live has had the name for two days: the name is taken over, that site goes.
	perform pg_temp.rel_other_site('abandoned', interval '2 days');
	perform pg_temp.base_assert(pg_temp.rel_land(1655, 'n0', 'n1', pg_temp.rel_made('n1'), 'abandoned') = pg_temp.rec_answer('recorded', 1),
		'abandoned''s change');
	v := pg_temp.rel_begin('abandoned', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1')));
	perform pg_temp.base_assert(v ->> 'slug' = 'abandoned'
		and (select profile_id from public.qorpera_company_sites where slug = 'abandoned') = pg_temp.rel_company(),
		'abandoned: ' || v::text || ' ' || coalesce((select to_jsonb(site)::text from public.qorpera_company_sites site
			where slug = 'abandoned'), 'none'));
	-- Every name taken: refused, and nothing is written.
	perform pg_temp.rel_other_site(name) from (select 'full' union all select 'full-' || i from generate_series(2, 9) i) names(name);
	perform pg_temp.base_assert(pg_temp.rel_land(1656, 'n0', 'n1', pg_temp.rel_made('n1'), 'full') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_begin('full', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1'))) = pg_temp.rel_begun_refused('SITE_NAME_TAKEN')
		and (pg_temp.rec_shop('full')).site_id is null and (pg_temp.rel_site_row('full')).id is null, 'all taken');
	-- The company's tenth site: refused, nothing written; publish_site's words count a project's site that waits.
	v_count := (select count(*) from public.qorpera_company_sites where profile_id = pg_temp.rel_company());
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
	select pg_temp.rel_company(), pg_temp.rec_here(), 'filler-' || i, 'product/filler', '92400000-0000-4000-8000-000000000030'
	from generate_series(1, 10 - v_count) i;
	perform pg_temp.base_assert(pg_temp.rel_land(1657, 'n0', 'n1', pg_temp.rel_made('n1'), 'tenth') = pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_begin('tenth', 1, pg_temp.rel_manifest(pg_temp.rel_texts('n1'))) = pg_temp.rel_begun_refused('SITE_LIMIT')
		and (pg_temp.rec_shop('tenth')).site_id is null and (pg_temp.rel_site_row('tenth')).id is null, 'the tenth');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', pg_temp.c3_alice(), 'brand-new'),
		'55000', v_limit);
	delete from public.qorpera_company_sites where profile_id = pg_temp.rel_company() and slug like 'filler-%';
	-- (The sites of this section go, as a member takes them offline, so the sections after it have room.)
	delete from public.qorpera_company_sites where environment_id = pg_temp.rec_here()
		and code_name in ('slugs', 'gift_message.app', 'api', 'taken', 'abandoned');
	perform pg_temp.base_assert((select count(*) from public.qorpera_code_repositories where environment_id = pg_temp.rec_here()
		and name in ('slugs', 'gift_message.app', 'api', 'taken', 'abandoned') and site_id is null) = 5, 'the sites went');
end $$;

-- 6. List, missing, put, finish, failed -----------------------------------------------------------------------------------
do $$
declare v jsonb; v_version uuid; v_second uuid; v_texts jsonb := pg_temp.rel_up_texts('u1'); v_files jsonb;
	v_big text := repeat('0123456789', 30); v_bad jsonb; q public.qorpera_code_repositories%rowtype; v_at timestamptz;
begin
	v_files := pg_temp.rel_files(v_texts);
	perform pg_temp.base_assert(pg_temp.rel_land(1660, 'up0', 'up1', pg_temp.rel_made('u1', '{}', v_texts), 'up')
		= pg_temp.rec_answer('recorded', 1), 'up''s change');
	v_version := (pg_temp.rel_begin('up', 1, pg_temp.rel_manifest(v_texts)) ->> 'versionId')::uuid;
	-- Nothing is named yet: finish refuses, nothing is missing, no file takes a part.
	perform pg_temp.base_assert(pg_temp.rel_finish(v_version)
			= '{"schema":"qorpera.code-site-finish/v1","state":"refused","code":"SITE_UPLOAD_INCOMPLETE"}'
		and pg_temp.rel_missing(v_version, null, 100) = '{"schema":"qorpera.code-site-missing/v1","missing":[],"more":false}'
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('index.html', 'x', 0, 1))) = pg_temp.rel_put_refused('index.html'),
		'nothing named');
	-- In pages: two files, the same two again; a path named again with other values is refused, and every file goes.
	perform pg_temp.base_assert(pg_temp.rel_list(v_version, jsonb_build_array(v_files -> 0, v_files -> 1), false) = pg_temp.rel_said_list('listing', 2)
		and pg_temp.rel_list(v_version, jsonb_build_array(v_files -> 1, v_files -> 0), false) = pg_temp.rel_said_list('listing', 2)
		and pg_temp.rel_rows(v_version) = '2 files, 0 with bytes, 0 parts'
		and pg_temp.rel_list(v_version, jsonb_build_array(pg_temp.rel_file('app.js', 'other')), false)
			= pg_temp.rel_list_refused('SITE_FILE_REFUSED', 'app.js')
		and pg_temp.rel_rows(v_version) = '0 files, 0 with bytes, 0 parts', 'pages, and a file named otherwise');
	-- A file a site cannot hold or serve: refused with its path, and every file goes.
	foreach v_bad in array array[pg_temp.rel_file('.hidden.js', 'x'), pg_temp.rel_file('a b.js', 'x'),
		pg_temp.rel_file('run.exe', 'x'), pg_temp.rel_file('a/../x.txt', 'x'), pg_temp.rel_file('README', 'x'),
		pg_temp.rel_file(repeat('a', 509) || '.txt', 'x'),
		'{"path":"x.txt","bytes":10485761,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}'::jsonb,
		'{"path":"x.txt","bytes":1.5,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}',
		'{"path":"x.txt","bytes":-1,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}',
		'{"path":"x.txt","bytes":1,"sha256":"ABC"}'] loop
		perform pg_temp.base_assert(pg_temp.rel_list(v_version, jsonb_build_array(v_files -> 0, v_bad), false)
				= pg_temp.rel_list_refused('SITE_FILE_REFUSED', v_bad ->> 'path')
			and pg_temp.rel_rows(v_version) = '0 files, 0 with bytes, 0 parts', 'refused: ' || v_bad::text);
	end loop;
	-- More files than the version has; at the last page another manifest, a file short, or no index.html: refused, and
	-- every file goes.
	perform pg_temp.base_assert(pg_temp.rel_list(v_version, v_files || jsonb_build_array(pg_temp.rel_file('extra.txt', 'x')), false)
			= pg_temp.rel_list_refused('SITE_MANIFEST_DIFFERS', null)
		and pg_temp.rel_list(v_version, pg_temp.rel_files(v_texts || '{"app.js":"console.log(\"u9\");"}'), true)
			= pg_temp.rel_list_refused('SITE_MANIFEST_DIFFERS', null)
		and pg_temp.rel_list(v_version, v_files - 4, true) = pg_temp.rel_list_refused('SITE_MANIFEST_DIFFERS', null)
		and pg_temp.rel_rows(v_version) = '0 files, 0 with bytes, 0 parts' and not (pg_temp.rel_version(v_version)).listed,
		'the manifest');
	perform pg_temp.base_assert(pg_temp.rel_land(1661, 'up1', 'up2', pg_temp.rel_made('noindex', '{}', '{"home.html":"<p>no index</p>"}'),
		'up') = pg_temp.rec_answer('recorded', 2), 'a site with no index.html');
	v := pg_temp.rel_begin('up', 2, pg_temp.rel_manifest('{"home.html":"<p>no index</p>"}'));
	perform pg_temp.base_assert(pg_temp.rel_list((v ->> 'versionId')::uuid, pg_temp.rel_files('{"home.html":"<p>no index</p>"}'), true)
		= pg_temp.rel_list_refused('SITE_MANIFEST_DIFFERS', null), 'no index.html');
	-- What the call takes.
	foreach v_bad in array array['{"files":[]}'::jsonb, '{"last":true}', '{"files":[],"last":"yes"}', '{"files":{},"last":true}',
		jsonb_build_object('files', jsonb_build_array((v_files -> 0) || '{"more":1}'), 'last', false),
		jsonb_build_object('files', jsonb_build_array((v_files -> 0) - 'sha256'), 'last', false),
		jsonb_build_object('files', jsonb_build_array((v_files -> 0) || '{"path":7}'), 'last', false),
		jsonb_build_object('files', jsonb_build_array((v_files -> 0) || '{"bytes":"3"}'), 'last', false),
		jsonb_build_object('files', '["index.html"]'::jsonb, 'last', false),
		jsonb_build_object('files', (select jsonb_agg(pg_temp.rel_file('f' || i || '.txt', 'x')) from generate_series(1, 151) i),
			'last', false), '{"files":[],"last":true,"more":1}'] loop
		perform pg_temp.base_error(format('select pg_temp.rel_exec(%L)', format('public.qorpera_code_site_list(%L, %L, %L, %L)',
			'exec-1170', repeat('5', 64), v_version, v_bad)), '22023', 'Code site list invalid');
	end loop;
	-- In two pages, the second the last: listed. Named again: as it stands, nothing written.
	v_version := (pg_temp.rel_begin('up', 1, pg_temp.rel_manifest(v_texts)) ->> 'versionId')::uuid;
	perform pg_temp.base_assert(pg_temp.rel_list(v_version, v_files - 4 - 3, false) = pg_temp.rel_said_list('listing', 3)
		and pg_temp.rel_list(v_version, jsonb_build_array(v_files -> 3, v_files -> 4), true) = pg_temp.rel_said_list('listed', 5)
		and (pg_temp.rel_version(v_version)).listed
		and pg_temp.rel_list(v_version, '[]', true) = pg_temp.rel_said_list('listed', 5)
		and pg_temp.rel_list(v_version, jsonb_build_array(pg_temp.rel_file('app.js', 'other')), false) = pg_temp.rel_said_list('listed', 5)
		and pg_temp.rel_rows(v_version) = '5 files, 0 with bytes, 0 parts', 'listed');
	-- Missing, in pages of two, in C order.
	perform pg_temp.base_assert(pg_temp.rel_missing(v_version, null, 2) = jsonb_build_object('schema', 'qorpera.code-site-missing/v1',
			'missing', jsonb_build_array(jsonb_build_object('path', 'a/one.js', 'bytes', 21), jsonb_build_object('path', 'app.js',
				'bytes', octet_length('console.log("u1");'))), 'more', true)
		and pg_temp.rel_missing(v_version, 'app.js', 2) -> 'missing' = jsonb_build_array(jsonb_build_object('path', 'big.txt',
			'bytes', 300), jsonb_build_object('path', 'index.html', 'bytes', octet_length('<h1>u1</h1>')))
		and pg_temp.rel_missing(v_version, 'app.js', 2) -> 'more' = 'true'
		and pg_temp.rel_missing(v_version, 'index.html', 2) = jsonb_build_object('schema', 'qorpera.code-site-missing/v1',
			'missing', jsonb_build_array(jsonb_build_object('path', 'style.css', 'bytes', octet_length('body { margin: 0 }'))), 'more', false)
		and pg_temp.rel_missing(v_version, 'style.css', 100) -> 'missing' = '[]', 'missing in pages');
	perform pg_temp.base_error(format('select pg_temp.rel_missing(%L, null, 0)', v_version), '22023', 'Code site missing invalid');
	perform pg_temp.base_error(format('select pg_temp.rel_missing(%L, null, 101)', v_version), '22023', 'Code site missing invalid');

	-- big.txt in three parts of 100 bytes, out of order and one of them twice: written once it has them all.
	perform pg_temp.base_assert(pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('big.txt', v_big, 2, 3, 200, 100)))
			= pg_temp.rel_kept_parts(0)
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('big.txt', v_big, 0, 3, 0, 100),
			pg_temp.rel_part('big.txt', v_big, 0, 3, 0, 100))) = pg_temp.rel_kept_parts(0)
		and pg_temp.rel_rows(v_version) = '5 files, 0 with bytes, 2 parts'
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('big.txt', v_big, 1, 3, 100, 100))) = pg_temp.rel_kept_parts(1)
		and pg_temp.rel_rows(v_version) = '5 files, 1 with bytes, 0 parts'
		and pg_temp.rel_content(v_version, 'big.txt') = convert_to(v_big, 'utf8'), 'a file in three parts');
	-- A file whose bytes do not match (its size, another digest): refused, its parts go.
	perform pg_temp.base_assert(pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('app.js', 'console.log("u9");', 0, 1)))
			= pg_temp.rel_put_refused('app.js')
		and pg_temp.rel_rows(v_version) = '5 files, 1 with bytes, 0 parts', 'a file that does not match');
	-- Parts counted otherwise than those kept; more bytes than the file has; a path that is no file of it.
	perform pg_temp.base_assert(pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('index.html', '<h1>u1</h1>', 0, 2, 0, 5)))
			= pg_temp.rel_kept_parts(0)
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('index.html', '<h1>u1</h1>', 1, 3, 5)))
			= pg_temp.rel_put_refused('index.html')
		and pg_temp.rel_rows(v_version) = '5 files, 1 with bytes, 0 parts'
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('style.css', 'body { margin: 0 } and more', 0, 2)))
			= pg_temp.rel_put_refused('style.css')
		and pg_temp.rel_put(v_version, jsonb_build_array(pg_temp.rel_part('nope.js', 'x', 0, 1))) = pg_temp.rel_put_refused('nope.js')
		and pg_temp.rel_rows(v_version) = '5 files, 1 with bytes, 0 parts', 'refused parts');
	-- What the call takes.
	foreach v_bad in array array['[]'::jsonb, jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 1) || '{"contentBase64":"###"}'),
		jsonb_build_array(pg_temp.rel_part('app.js', 'x', 1, 1)), jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 0)),
		jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 129)), jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 1) || '{"more":1}'),
		jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 1) - 'of'), jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 1) || '{"path":7}'),
		jsonb_build_array(pg_temp.rel_part('app.js', 'x', 0, 1) || '{"part":"0"}'),
		jsonb_build_array(pg_temp.rel_part('app.js', repeat('a', 131073), 0, 1)),
		(select jsonb_agg(pg_temp.rel_part('app.js', 'x', 0, 1)) from generate_series(1, 501))] loop
		perform pg_temp.base_error(format('select pg_temp.rel_put(%L, %L)', v_version, v_bad), '22023', 'Code site put invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.rel_exec(%L)', format('public.qorpera_code_site_put(%L, %L, %L, %L)',
		'exec-1170', repeat('5', 64), v_version, '{"parts":[],"more":1}')), '22023', 'Code site put invalid');
	-- The rest in one call: written.
	perform pg_temp.base_assert(pg_temp.rel_put(v_version, pg_temp.rel_parts(v_texts - 'big.txt')) = pg_temp.rel_kept_parts(4)
		and pg_temp.rel_rows(v_version) = '5 files, 5 with bytes, 0 parts' and pg_temp.rel_missing(v_version, null, 100) -> 'missing' = '[]',
		'the rest');
	-- finish: ready, the failed uploads forgotten, the list written again. Then as it stands.
	update public.qorpera_code_repositories set site_problem = 'SITE_UPLOAD_FAILED', site_attempts = 2, site_change = 1,
		site_not_before = clock_timestamp() + interval '1 hour'
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'up';
	q := pg_temp.rec_shop('up');
	perform pg_temp.base_assert(pg_temp.rel_finish(v_version) = '{"schema":"qorpera.code-site-finish/v1","state":"ready","pruned":0}'
		and (pg_temp.rel_version(v_version)).state = 'ready' and (pg_temp.rel_version(v_version)).published_at is null
		and (pg_temp.rec_shop('up')).site_problem is null and (pg_temp.rec_shop('up')).site_attempts = 0
		and (pg_temp.rec_shop('up')).site_change is null and (pg_temp.rec_shop('up')).site_not_before is null
		and (pg_temp.rec_shop('up')).index_version = q.index_version + 1, 'finished');
	perform pg_temp.base_assert(pg_temp.rel_finish(v_version) = '{"schema":"qorpera.code-site-finish/v1","state":"ready","pruned":0}'
		and pg_temp.rel_put(v_version, pg_temp.rel_parts(v_texts)) = pg_temp.rel_kept_parts(0)
		and pg_temp.rel_list(v_version, '[]', true) = pg_temp.rel_said_list('listed', 0), 'as it stands');
	perform pg_temp.base_error('select pg_temp.rel_finish(null)', '22023', 'Code site finish invalid');
	-- A later version of the site sends only what changed: the rest is copied, by digest and size, at the last page.
	perform pg_temp.base_assert(pg_temp.rel_land(1662, 'up2', 'up3', pg_temp.rel_made('u2', '{}', pg_temp.rel_up_texts('u2')), 'up')
		= pg_temp.rec_answer('recorded', 3), 'up''s third change');
	v_second := (pg_temp.rel_begin('up', 3, pg_temp.rel_manifest(pg_temp.rel_up_texts('u2'))) ->> 'versionId')::uuid;
	perform pg_temp.base_assert(pg_temp.rel_list(v_second, pg_temp.rel_files(pg_temp.rel_up_texts('u2')), true)
			= pg_temp.rel_said_list('listed', 2)
		and pg_temp.rel_missing(v_second, null, 100) -> 'missing' = jsonb_build_array(jsonb_build_object('path', 'app.js',
			'bytes', octet_length('console.log("u2");')), jsonb_build_object('path', 'index.html', 'bytes', octet_length('<h1>u2</h1>'))),
		'copied by digest');
	-- Lost: a version that is not there, an executor that does not hold the company.
	perform pg_temp.base_assert(pg_temp.rel_list(extensions.gen_random_uuid(), '[]', true) = '{"schema":"qorpera.code-site-list/v1","state":"lost"}'
		and pg_temp.rel_list(v_second, '[]', true, 'exec-other') = '{"schema":"qorpera.code-site-list/v1","state":"lost"}'
		and pg_temp.rel_missing(extensions.gen_random_uuid(), null, 10) = '{"schema":"qorpera.code-site-missing/v1","state":"lost"}'
		and pg_temp.rel_missing(v_second, null, 10, 'exec-other') = '{"schema":"qorpera.code-site-missing/v1","state":"lost"}'
		and pg_temp.rel_put(extensions.gen_random_uuid(), pg_temp.rel_parts(v_texts)) = '{"schema":"qorpera.code-site-put/v1","state":"lost"}'
		and pg_temp.rel_put(v_second, pg_temp.rel_parts(v_texts), 'exec-other') = '{"schema":"qorpera.code-site-put/v1","state":"lost"}'
		and pg_temp.rel_finish(extensions.gen_random_uuid()) = '{"schema":"qorpera.code-site-finish/v1","state":"lost"}'
		and pg_temp.rel_finish(v_second, 'exec-other') = '{"schema":"qorpera.code-site-finish/v1","state":"lost"}'
		and pg_temp.rel_rows(v_second) = '5 files, 3 with bytes, 0 parts', 'lost');
	-- failed: the problem, the failures of that change in a row and the pause after each; another change counts anew.
	v_at := clock_timestamp();
	perform pg_temp.base_assert(pg_temp.rel_failed('up', 3, 'SITE_UPLOAD_FAILED') = '{"schema":"qorpera.code-site-failed/v1","state":"recorded"}'
		and (pg_temp.rec_shop('up')).site_attempts = 1 and (pg_temp.rec_shop('up')).site_change = 3
		and (pg_temp.rec_shop('up')).site_problem = 'SITE_UPLOAD_FAILED'
		and (pg_temp.rec_shop('up')).site_not_before between v_at + interval '2 seconds' and clock_timestamp() + interval '2 seconds'
		and pg_temp.rel_failed('up', 3, 'SITE_UPLOAD_FAILED') ->> 'state' = 'recorded' and (pg_temp.rec_shop('up')).site_attempts = 2
		and (pg_temp.rec_shop('up')).site_not_before between v_at + interval '4 seconds' and clock_timestamp() + interval '4 seconds'
		and pg_temp.rel_failed('up', 2, 'CODE_HOST_SITE_TREE_UNKNOWN') ->> 'state' = 'recorded'
		and (pg_temp.rec_shop('up')).site_attempts = 1 and (pg_temp.rec_shop('up')).site_change = 2
		and (pg_temp.rec_shop('up')).site_problem = 'CODE_HOST_SITE_TREE_UNKNOWN', 'failed: the pause');
	perform pg_temp.base_assert(pg_temp.rel_failed('up', 3, 'SITE_UPLOAD_FAILED', 'exec-other') = '{"schema":"qorpera.code-site-failed/v1","state":"lost"}'
		and pg_temp.rel_failed('nowhere', 3, 'SITE_UPLOAD_FAILED') = '{"schema":"qorpera.code-site-failed/v1","state":"lost"}', 'failed lost');
	perform pg_temp.base_error('select pg_temp.rel_failed(''up'', 3, ''site failed'')', '22023', 'Code site failure invalid');
	perform pg_temp.base_error('select pg_temp.rel_failed(''up'', 0, ''SITE_LIMIT'')', '22023', 'Code site failure invalid');
	update public.qorpera_code_repositories set site_problem = null, site_attempts = 0, site_change = null, site_not_before = null
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'up';
end $$;

-- 7. What's new: the read, put live, Go back ------------------------------------------------------------------------------
do $$
declare v jsonb; p jsonb; v_shown jsonb; v1 uuid; v3 uuid; v4 uuid; r public.qorpera_code_releases%rowtype;
	s public.qorpera_company_sites%rowtype; q public.qorpera_code_repositories%rowtype;
	v_web jsonb := '{"title":"The web shop","name":"webshop"}';
	v_picture jsonb := jsonb_build_object('picture', jsonb_build_object('state', 'ok', 'blob', pg_temp.rec_sha('picture'),
		'bytes', 120, 'type', 'png'));
	v_keys constant text[] := array['bytes', 'createdAt', 'files', 'id', 'kind', 'machine', 'passwordChangedAt', 'port',
		'publishedAt', 'publishedBy', 'schema', 'slug', 'source', 'state', 'title', 'url'];
begin
	-- A change that made a site that is not uploaded yet: the repository is on the page, with nothing to put live.
	perform pg_temp.base_assert(pg_temp.rel_land(1670, 'w0', 'w1', pg_temp.rel_made('w1', v_web), 'a1-web',
		'{"notice":"A new home page"}') = pg_temp.rec_answer('recorded', 1), 'web''s change');
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert(p = '{"owner":"company","name":"a1-web","site":null,"live":null,"back":null,"ready":null,'
		'"waiting":1,"problem":null}', 'not uploaded: ' || coalesce(p::text, 'none'));
	-- Uploaded: the site and its first version are ready. Every member reads it; owners and admins may put it live.
	v1 := pg_temp.rel_upload('a1-web', 1, 'w1');
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert(p - 'ready' = '{"owner":"company","name":"a1-web","site":{"slug":"webshop",'
			'"url":"https://sites.qorpera.com/webshop/","title":"The web shop"},"live":null,"back":null,"waiting":0,"problem":null}'
		and (p -> 'ready') - 'token' = jsonb_build_object('change', 1, 'agent', (pg_temp.rec_row(1, 'a1-web')).staff_agent_id,
			'changes', jsonb_build_array(jsonb_build_object('key', 1, 'notice', 'A new home page', 'picture', null,
				'at', (pg_temp.rec_row(1, 'a1-web')).created_at, 'wasLive', false)), 'quiet', 0)
		and p -> 'ready' ->> 'token' ~ '^[0-9a-f]{64}$', 'the first version: ' || p::text);
	perform pg_temp.base_assert(pg_temp.rel_read() ->> 'schema' = 'qorpera.code-releases/v1'
		and (pg_temp.rel_read() -> 'canRelease') = 'true' and (pg_temp.rel_read(pg_temp.rel_admin()) -> 'canRelease') = 'true'
		and (pg_temp.rel_read(pg_temp.rel_member()) -> 'canRelease') = 'false'
		and (pg_temp.rel_read(pg_temp.rel_viewer()) -> 'canRelease') = 'false'
		and pg_temp.rel_page('a1-web', pg_temp.rel_viewer()) = p, 'every member reads it');
	perform pg_temp.base_error(format('select pg_temp.rel_read(%L)', pg_temp.rel_outsider()), '42501', 'Releases unavailable');
	-- At most ten repositories, by name.
	perform pg_temp.base_assert(jsonb_array_length(pg_temp.rel_read() -> 'sites') = 10
		and pg_temp.rel_read() -> 'sites' -> 0 ->> 'name' = 'a1-web', 'ten: ' || (pg_temp.rel_read() -> 'sites')::text);
	-- Sites does not list it before it is live.
	perform pg_temp.base_assert(not exists (select 1 from jsonb_array_elements(pg_temp.req_as(pg_temp.req_owner(),
		format('public.qorpera_list_company_sites(%L)', pg_temp.rel_company()))) item where item ->> 'slug' = 'webshop'), 'not listed yet');
	-- Who may put it live, and what the call takes.
	v_shown := pg_temp.rel_shown(p);
	perform pg_temp.base_error(format('select pg_temp.rel_live(%L, %L, %L)', 'a1-web', v_shown, pg_temp.rel_member()), '42501',
		'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.rel_live(%L, %L, %L)', 'a1-web', v_shown, pg_temp.rel_viewer()), '42501',
		'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.rel_live(%L, %L, %L)', 'a1-web', v_shown, pg_temp.rel_outsider()), '42501',
		'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.rel_live(%L, %L)', 'nowhere', v_shown), 'P0002', 'No such repository');
	foreach v in array array[v_shown - 'token', v_shown || '{"token":"abc"}', v_shown || '{"change":0}', v_shown || '{"live":"1"}',
		v_shown || '{"live":0}', v_shown || '{"more":1}', '[]'::jsonb] loop
		perform pg_temp.base_error(format('select pg_temp.rel_live(%L, %L)', 'a1-web', v), '22023', 'Release request is invalid');
	end loop;
	-- A page that moved (another live version, another token, a change that is no ready point): nothing is written.
	q := pg_temp.rec_shop('a1-web');
	perform pg_temp.base_assert(pg_temp.rel_live('a1-web', v_shown || '{"live":1}') = pg_temp.rel_moved()
		and pg_temp.rel_live('a1-web', v_shown || jsonb_build_object('token', repeat('0', 64))) = pg_temp.rel_moved()
		and pg_temp.rel_live('a1-web', v_shown || '{"change":2}') = pg_temp.rel_moved()
		and to_jsonb(pg_temp.rec_shop('a1-web')) = to_jsonb(q) and pg_temp.rel_states('a1-web') = '1:ready'
		and pg_temp.rel_release('a1-web', 1) is null, 'a page that moved');
	-- The first release, by an admin.
	perform pg_temp.base_assert(pg_temp.rel_live('a1-web', v_shown, pg_temp.rel_admin()) = pg_temp.rel_answer(1, 'webshop'),
		'the first release');
	r := pg_temp.rel_release('a1-web', 1); s := pg_temp.rel_site_row('a1-web');
	perform pg_temp.base_assert(r.kind = 'release' and r.version = 1 and r.change = 1 and r.main_sha = pg_temp.rec_sha('w1')
		and r.tree = pg_temp.rec_sha('tree:w1') and r.version_id = v1 and r.replaces is null and r.prior is null
		and r.changes = '{1}' and r.shown_sha256 = v_shown ->> 'token' and r.by_user_id = pg_temp.rel_admin()
		and r.profile_id = pg_temp.rel_company(), 'its row: ' || to_jsonb(r)::text);
	perform pg_temp.base_assert(pg_temp.rel_states('a1-web') = '1:live' and (pg_temp.rel_version(v1)).published_at is not null
		and s.current_version_id = v1 and s.title = 'The web shop' and s.published_by_user_id = pg_temp.rel_admin()
		and s.published_by_staff_agent_id is null and s.published_at is not null
		and (pg_temp.rec_shop('a1-web')).last_release = 1 and (pg_temp.rec_shop('a1-web')).live_release = 1
		and (pg_temp.rec_shop('a1-web')).last_version = 1 and (pg_temp.rec_shop('a1-web')).index_version = q.index_version + 1,
		'web live site: ' || to_jsonb(s)::text);
	-- Sites lists it now, in the row every site has.
	v := (select item from jsonb_array_elements(pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_list_company_sites(%L)',
		pg_temp.rel_company()))) item where item ->> 'slug' = 'webshop');
	perform pg_temp.base_assert((select array_agg(key order by key collate "C") from jsonb_object_keys(v) key) = v_keys
		and v ->> 'schema' = 'qorpera.company-site/v1' and v ->> 'state' = 'live' and v ->> 'source' = 'code/company/a1-web'
		and v -> 'publishedBy' = 'null' and v ->> 'kind' = 'files' and v -> 'files' = '3'
		and v ->> 'url' = 'https://sites.qorpera.com/webshop/' and v ->> 'title' = 'The web shop', 'Sites: ' || coalesce(v::text, 'none'));
	-- What is live; the same yes again has moved.
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert((p -> 'live') - 'since' = jsonb_build_object('version', 1, 'kind', 'release',
			'by', pg_temp.rel_admin(), 'from', null)
		and p -> 'live' -> 'since' = to_jsonb(r.created_at) and p -> 'back' = 'null' and p -> 'ready' = 'null'
		and p -> 'waiting' = '0', 'web live: ' || p::text);
	perform pg_temp.base_assert(pg_temp.rel_live('a1-web', v_shown, pg_temp.rel_admin()) = pg_temp.rel_moved(), 'the same yes');
	-- Two more changes, the second behind the scenes, and the newest uploaded: the first is listed with its picture.
	perform pg_temp.base_assert(pg_temp.rel_land(1671, 'w1', 'w2', pg_temp.rel_made('w2', v_web), 'a1-web',
			'{"notice":"Faster checkout","picture":"docs/checkout.png"}', v_picture) = pg_temp.rec_answer('recorded', 2)
		and pg_temp.rel_land(1672, 'w2', 'w3', pg_temp.rel_made('w3', v_web), 'a1-web') = pg_temp.rec_answer('recorded', 3),
		'web''s next changes');
	v3 := pg_temp.rel_upload('a1-web', 3, 'w3');
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert(p -> 'ready' -> 'change' = '3' and p -> 'ready' -> 'quiet' = '1'
		and jsonb_array_length(p -> 'ready' -> 'changes') = 1
		and (p -> 'ready' -> 'changes' -> 0) - 'at' = '{"key":2,"notice":"Faster checkout","picture":"code/company/a1-web/changes/2.png",'
			'"wasLive":false}', 'web ready: ' || p::text);
	-- A newer change ready meanwhile is no reason to refuse: what was shown goes live, and the newer one waits.
	perform pg_temp.base_assert(pg_temp.rel_land(1673, 'w3', 'w4', pg_temp.rel_made('w4', v_web), 'a1-web',
		'{"notice":"A new footer"}') = pg_temp.rec_answer('recorded', 4), 'web''s fourth change');
	v4 := pg_temp.rel_upload('a1-web', 4, 'w4');
	perform pg_temp.base_assert(pg_temp.rel_live('a1-web', pg_temp.rel_shown(p)) = pg_temp.rel_answer(2, 'webshop'), 'version 2');
	r := pg_temp.rel_release('a1-web', 2);
	perform pg_temp.base_assert(r.kind = 'release' and r.version = 2 and r.change = 3 and r.version_id = v3 and r.replaces = 1
		and r.prior = 1 and r.changes = '{3,2}' and r.by_user_id = pg_temp.req_owner()
		and pg_temp.rel_states('a1-web') = '1:kept 3:live 4:ready' and (pg_temp.rel_version(v1)).published_at is not null
		and (pg_temp.rel_site_row('a1-web')).current_version_id = v3
		and (pg_temp.rel_site_row('a1-web')).published_by_user_id = pg_temp.req_owner(), 'version 2: ' || to_jsonb(r)::text);
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert(p -> 'live' -> 'version' = '2' and p -> 'back' = '{"version":1}' and p -> 'ready' -> 'change' = '4'
		and (select jsonb_agg(item - 'at') from jsonb_array_elements(p -> 'ready' -> 'changes') item)
			= '[{"key":4,"notice":"A new footer","picture":null,"wasLive":false}]'
		and p -> 'ready' -> 'quiet' = '0' and p -> 'waiting' = '0', 'after version 2: ' || p::text);
	-- Go back: who may, what the call takes, a page that moved.
	perform pg_temp.base_error(format('select pg_temp.rel_back(%L, %L, %L)', 'a1-web', '{"live":2,"to":1}', pg_temp.rel_member()),
		'42501', 'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.rel_back(%L, %L, %L)', 'a1-web', '{"live":2,"to":1}', pg_temp.rel_viewer()),
		'42501', 'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.rel_back(%L, %L)', 'nowhere', '{"live":2,"to":1}'), 'P0002', 'No such repository');
	foreach v in array array['{"live":2}'::jsonb, '{"live":2,"to":"1"}', '{"live":0,"to":1}', '{"live":2,"to":1,"more":1}',
		'{"live":null,"to":1}'] loop
		perform pg_temp.base_error(format('select pg_temp.rel_back(%L, %L)', 'a1-web', v), '22023', 'Release request is invalid');
	end loop;
	q := pg_temp.rec_shop('a1-web');
	perform pg_temp.base_assert(pg_temp.rel_back('a1-web', '{"live":1,"to":1}') = pg_temp.rel_moved()
		and pg_temp.rel_back('a1-web', '{"live":2,"to":2}') = pg_temp.rel_moved()
		and to_jsonb(pg_temp.rec_shop('a1-web')) = to_jsonb(q) and pg_temp.rel_states('a1-web') = '1:kept 3:live 4:ready', 'back moved');
	-- Back to version 1: a release that shows version 1 again. Version 2's changes are ready again, marked as live before.
	perform pg_temp.base_assert(pg_temp.rel_back('a1-web', '{"live":2,"to":1}') = pg_temp.rel_answer(1, 'webshop'), 'back');
	r := pg_temp.rel_release('a1-web', 3);
	perform pg_temp.base_assert(r.kind = 'back' and r.version = 1 and r.change = 1 and r.main_sha = pg_temp.rec_sha('w1')
		and r.tree = pg_temp.rec_sha('tree:w1') and r.version_id = v1 and r.replaces = 2 and r.prior is null and r.changes = '{}'
		and r.shown_sha256 is null and r.by_user_id = pg_temp.req_owner()
		and pg_temp.rel_states('a1-web') = '1:live 3:kept 4:ready' and (pg_temp.rel_site_row('a1-web')).current_version_id = v1
		and (pg_temp.rec_shop('a1-web')).last_release = 3 and (pg_temp.rec_shop('a1-web')).live_release = 3
		and (pg_temp.rec_shop('a1-web')).last_version = 2 and (pg_temp.rec_shop('a1-web')).index_version = q.index_version + 1,
		'its row: ' || to_jsonb(r)::text);
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert((p -> 'live') - 'since' = jsonb_build_object('version', 1, 'kind', 'back', 'by', pg_temp.req_owner(),
			'from', 2)
		and p -> 'back' = 'null' and p -> 'ready' -> 'change' = '4'
		and (select jsonb_agg(item - 'at' - 'notice' - 'picture') from jsonb_array_elements(p -> 'ready' -> 'changes') item)
			= '[{"key":4,"wasLive":false},{"key":2,"wasLive":true}]' and p -> 'ready' -> 'quiet' = '1', 'gone back: ' || p::text);
	-- Nothing kept before it: moved. Put live again: version 3, and Go back would put version 1 up again.
	perform pg_temp.base_assert(pg_temp.rel_back('a1-web', '{"live":1,"to":1}') = pg_temp.rel_moved()
		and pg_temp.rel_yes('a1-web') = pg_temp.rel_answer(3, 'webshop') and pg_temp.rel_states('a1-web') = '1:kept 3:kept 4:live'
		and pg_temp.rel_page('a1-web') -> 'back' = '{"version":1}' and (pg_temp.rel_release('a1-web', 4)).changes = '{4,3,2}',
		'version 3');
end $$;

-- A change taken out, and a notice changed, after the page was drawn.
do $$
declare p jsonb; q public.qorpera_code_repositories%rowtype; v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.rel_land(1680, 'm0', 'm1', pg_temp.rel_made('m1'), 'a2-moved', '{"notice":"One"}')
			= pg_temp.rec_answer('recorded', 1)
		and pg_temp.rel_land(1681, 'm1', 'm2', pg_temp.rel_made('m2'), 'a2-moved', '{"notice":"Two"}') = pg_temp.rec_answer('recorded', 2),
		'moved''s changes');
	perform pg_temp.rel_upload('a2-moved', 2, 'm2');
	p := pg_temp.rel_page('a2-moved');
	perform pg_temp.base_assert(p -> 'ready' -> 'change' = '2', 'moved ready: ' || p::text);
	perform pg_temp.base_assert(pg_temp.req_undone('rel-undo-m', 1, false, 'm2', 'm3', '{}', 'a2-moved') = pg_temp.req_recorded(3),
		'change 1 taken out');
	q := pg_temp.rec_shop('a2-moved');
	perform pg_temp.base_assert(pg_temp.rel_live('a2-moved', pg_temp.rel_shown(p)) = pg_temp.rel_moved()
		and to_jsonb(pg_temp.rec_shop('a2-moved')) = to_jsonb(q) and pg_temp.rel_states('a2-moved') = '2:ready'
		and pg_temp.rel_page('a2-moved') -> 'ready' = 'null' and pg_temp.rel_page('a2-moved') -> 'waiting' = '2',
		'a change taken out: moved');
	-- A newer change: ready, with the undo and what it took out left out (they cancel).
	perform pg_temp.base_assert(pg_temp.rel_land(1682, 'm3', 'm4', pg_temp.rel_made('m4'), 'a2-moved', '{"notice":"Four"}')
		= pg_temp.rec_answer('recorded', 4), 'moved''s fourth change');
	perform pg_temp.rel_upload('a2-moved', 4, 'm4');
	p := pg_temp.rel_page('a2-moved');
	perform pg_temp.base_assert(p -> 'ready' -> 'change' = '4' and p -> 'ready' -> 'quiet' = '0'
		and (select jsonb_agg(item -> 'key') from jsonb_array_elements(p -> 'ready' -> 'changes') item) = '[4,2]',
		'moved ready again: ' || p::text);
	perform pg_temp.base_claims('service_role');
	v := public.qorpera_folder_describe_code_change(pg_temp.c3_alice(), '{"operationKey":"rel-describe-4","owner":"company",'
		'"name":"a2-moved","change":4,"notice":"Four, and faster"}');
	perform pg_temp.base_assert(v ->> 'state' = 'saved', 'described: ' || v::text);
	perform pg_temp.base_assert(pg_temp.rel_live('a2-moved', pg_temp.rel_shown(p)) = pg_temp.rel_moved()
		and pg_temp.rel_yes('a2-moved') = pg_temp.rel_answer(1, 'a2-moved')
		and (pg_temp.rel_release('a2-moved', 1)).changes = '{4,2}', 'a notice changed: moved, then drawn again');
end $$;

-- The chain of Go backs.
do $$
declare p jsonb;
begin
	for i in 1..3 loop
		perform pg_temp.base_assert(pg_temp.rel_land(1690 + i, 'c' || (i - 1), 'c' || i, pg_temp.rel_made('c' || i), 'a3-chain',
			jsonb_build_object('notice', 'Change ' || i)) = pg_temp.rec_answer('recorded', i), 'chain''s change ' || i);
		perform pg_temp.rel_upload('a3-chain', i, 'c' || i);
		perform pg_temp.base_assert(pg_temp.rel_yes('a3-chain') = pg_temp.rel_answer(i, 'a3-chain'), 'chain''s version ' || i);
	end loop;
	perform pg_temp.base_assert(pg_temp.rel_page('a3-chain') -> 'back' = '{"version":2}'
		and pg_temp.rel_back('a3-chain', '{"live":3,"to":2}') = pg_temp.rel_answer(2, 'a3-chain')
		and pg_temp.rel_page('a3-chain') -> 'back' = '{"version":1}'
		and pg_temp.rel_back('a3-chain', '{"live":2,"to":1}', pg_temp.rel_admin()) = pg_temp.rel_answer(1, 'a3-chain')
		and pg_temp.rel_back('a3-chain', '{"live":1,"to":1}') = pg_temp.rel_moved()
		and pg_temp.rel_states('a3-chain') = '1:live 2:kept 3:kept', 'down the chain');
	p := pg_temp.rel_page('a3-chain');
	perform pg_temp.base_assert((p -> 'live') - 'since' = jsonb_build_object('version', 1, 'kind', 'back', 'by', pg_temp.rel_admin(),
			'from', 2)
		and p -> 'back' = 'null' and p -> 'ready' -> 'change' = '3'
		and (select jsonb_agg(item - 'at' - 'notice' - 'picture') from jsonb_array_elements(p -> 'ready' -> 'changes') item)
			= '[{"key":3,"wasLive":true},{"key":2,"wasLive":true}]'
		and (select string_agg(r.kind || r.version || ':' || coalesce(r.prior::text, '-'), ' ' order by r.n)
			from public.qorpera_code_releases r where r.name = 'a3-chain') = 'release1:- release2:1 release3:2 back2:1 back1:-',
		'the chain: ' || p::text);
end $$;

-- 8. Prune keeps 1 + 5 + 3 -----------------------------------------------------------------------------------------------
do $$
declare p jsonb;
begin
	for i in 1..10 loop
		perform pg_temp.base_assert(pg_temp.rel_land(1700 + i, 'p' || (i - 1), 'p' || i, pg_temp.rel_made('p' || i), 'a4-prune',
			jsonb_build_object('notice', 'Change ' || i)) = pg_temp.rec_answer('recorded', i), 'prune''s change ' || i);
		perform pg_temp.rel_upload('a4-prune', i, 'p' || i);
		perform pg_temp.base_assert(pg_temp.rel_yes('a4-prune') = pg_temp.rel_answer(i, 'a4-prune'), 'prune''s version ' || i);
	end loop;
	-- At each finish: the live version, five before it on the chain, the newest three ready. The tenth's finish was
	-- with version 9 live: 4 to 8 kept for it.
	perform pg_temp.base_assert(pg_temp.rel_states('a4-prune') = '4:kept 5:kept 6:kept 7:kept 8:kept 9:kept 10:live',
		'after ten: ' || pg_temp.rel_states('a4-prune'));
	for i in 11..14 loop
		perform pg_temp.base_assert(pg_temp.rel_land(1700 + i, 'p' || (i - 1), 'p' || i, pg_temp.rel_made('p' || i), 'a4-prune',
			jsonb_build_object('notice', 'Change ' || i)) = pg_temp.rec_answer('recorded', i), 'prune''s change ' || i);
		perform pg_temp.rel_upload('a4-prune', i, 'p' || i);
	end loop;
	perform pg_temp.base_assert(pg_temp.rel_states('a4-prune') = '5:kept 6:kept 7:kept 8:kept 9:kept 10:live 12:ready 13:ready 14:ready'
		and (select count(*) from public.qorpera_code_releases where name = 'a4-prune' and version_id is null) = 4
		and (select count(*) from public.qorpera_company_site_files f join public.qorpera_company_site_versions v on v.id = f.version_id
			where v.site_id = (pg_temp.rel_site_row('a4-prune')).id) = 27, 'after fourteen: ' || pg_temp.rel_states('a4-prune'));
	-- Go back five times; the sixth would need version 4, which is gone.
	for i in reverse 9..5 loop
		perform pg_temp.base_assert(pg_temp.rel_back('a4-prune', jsonb_build_object('live', i + 1, 'to', i))
			= pg_temp.rel_answer(i, 'a4-prune'), 'back to ' || i);
	end loop;
	p := pg_temp.rel_page('a4-prune');
	perform pg_temp.base_assert(p -> 'back' = 'null' and pg_temp.rel_back('a4-prune', '{"live":5,"to":4}') = pg_temp.rel_moved()
		and p -> 'ready' -> 'change' = '14'
		and (select jsonb_agg(item - 'at' - 'notice' - 'picture') from jsonb_array_elements(p -> 'ready' -> 'changes') item)
			= '[{"key":14,"wasLive":false},{"key":13,"wasLive":false},{"key":12,"wasLive":false},{"key":11,"wasLive":false},'
				'{"key":10,"wasLive":true},{"key":9,"wasLive":true},{"key":8,"wasLive":true},{"key":7,"wasLive":true},'
				'{"key":6,"wasLive":true}]', 'the end of the chain: ' || p::text);
end $$;

-- 9. publish_site, the list file, a site taken offline ---------------------------------------------------------------------
do $$
declare v jsonb; p jsonb; v_source text; s public.qorpera_company_sites%rowtype; v_password text; v_index bigint;
	v_new public.qorpera_company_sites%rowtype;
	v_from_code constant text := 'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new';
	v_under_code constant text := 'SITE_FROM_CODE: source must not be under code/: a repository kept in Qorpera goes live only '
		|| 'through What''s new, on a member''s yes';
begin
	-- publish_site never takes a repository's site, never publishes a folder under code/, and never takes one down.
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', pg_temp.c3_alice(), 'webshop'),
		'55000', v_from_code);
	perform pg_temp.base_error(format('select public.qorpera_site_publish_begin(%L, %L, %L, null)', pg_temp.c3_alice(), 'rel-call-1',
		pg_temp.rel_publish('webshop', 'product/web')), '55000', v_from_code);
	foreach v_source in array array['code/company/a1-web/main/dist', 'Code/company/a1-web', '/code/x', 'CODE'] loop
		perform pg_temp.base_error(format('select public.qorpera_site_publish_begin(%L, %L, %L, null)', pg_temp.c3_alice(),
			'rel-call-2', pg_temp.rel_publish('brand-new', v_source)), '22023', v_under_code);
	end loop;
	perform pg_temp.base_error(format('select public.qorpera_site_publish_begin(%L, %L, %L, null)', pg_temp.c3_alice(), 'rel-call-3',
		pg_temp.rel_publish('brand-new', 'codex/site')), '42501');
	perform pg_temp.base_error(format('select public.qorpera_site_unpublish(%L, %L)', pg_temp.c3_alice(), 'webshop'), '55000',
		'SITE_FROM_CODE: this site is made from code kept in Qorpera; only a member takes it offline, in Sites');
	-- A repository's site that is not live yet holds its name: it is never abandoned.
	update public.qorpera_company_sites set updated_at = clock_timestamp() - interval '2 days' where id = (pg_temp.rel_site_row('up')).id;
	perform pg_temp.base_assert(not public.qorpera_site_abandoned(pg_temp.rel_site_row('up'))
		and (pg_temp.rel_site_row('up')).current_version_id is null, 'never abandoned');
	-- The list file: what is live and what is ready, once the repository has a site or made one; neither before.
	v := pg_temp.rec_files(20, 'a1-web') -> 'index';
	perform pg_temp.base_assert((v -> 'live') - 'since' = jsonb_build_object('version', 3, 'kind', 'release', 'change', 4,
			'by', pg_temp.rel_name(pg_temp.req_owner()), 'url', 'https://sites.qorpera.com/webshop/')
		and pg_temp.rel_name(pg_temp.req_owner()) is not null
		and v -> 'live' -> 'since' = to_jsonb((pg_temp.rel_release('a1-web', 4)).created_at) and v -> 'ready' = 'null'
		and jsonb_array_length(v -> 'lines') = 4, 'a1-web''s list: ' || v::text);
	v := pg_temp.rec_files(20, 'a3-chain') -> 'index';
	perform pg_temp.base_assert((v -> 'live') - 'since' = jsonb_build_object('version', 1, 'kind', 'back', 'change', 1,
		'by', pg_temp.rel_name(pg_temp.rel_admin()), 'url', 'https://sites.qorpera.com/a3-chain/')
		and pg_temp.rel_name(pg_temp.rel_admin()) is not null and v -> 'ready' = '{"change":3}', 'a3-chain''s list: ' || v::text);
	v := pg_temp.rec_files(20, 'off') -> 'index';
	perform pg_temp.base_assert(v -> 'live' = 'null' and v -> 'ready' = 'null', 'off''s list: ' || v::text);
	v := pg_temp.rec_files(20, 'shop') -> 'index';
	perform pg_temp.base_assert(v ? 'lines' and not v ? 'live' and not v ? 'ready', 'shop''s list: ' || v::text);
	-- A member takes the repository's site offline in Sites: its versions go, the releases keep their rows, and the next
	-- upload makes it again, with its name and a new password.
	s := pg_temp.rel_site_row('a1-web');
	v_password := (select password from public.qorpera_company_site_secrets where site_id = s.id);
	v_index := (pg_temp.rec_shop('a1-web')).index_version;
	perform pg_temp.base_assert(pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_unpublish_company_site(%L)', s.id))
		->> 'removed' = 'true', 'offline');
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert((pg_temp.rec_shop('a1-web')).site_id is null
		and not exists (select 1 from public.qorpera_company_site_versions where site_id = s.id)
		and (select count(*) = 4 and bool_and(version_id is null) from public.qorpera_code_releases where name = 'a1-web')
		and p = '{"owner":"company","name":"a1-web","site":null,"live":null,"back":null,"ready":null,"waiting":4,"problem":null}'
		and pg_temp.rel_due_of('a1-web') = 4 and (pg_temp.rec_shop('a1-web')).index_version = v_index + 1
		and pg_temp.rec_files(20, 'a1-web') -> 'index' -> 'live' = 'null'
		and pg_temp.rec_files(20, 'a1-web') -> 'index' -> 'ready' = 'null', 'gone: ' || p::text);
	perform pg_temp.rel_upload('a1-web', 4, 'w4');
	v_new := pg_temp.rel_site_row('a1-web');
	p := pg_temp.rel_page('a1-web');
	perform pg_temp.base_assert(v_new.id <> s.id and v_new.slug = 'webshop' and v_new.current_version_id is null
		and (select password from public.qorpera_company_site_secrets where site_id = v_new.id) <> v_password
		and p -> 'live' = 'null' and p -> 'ready' -> 'change' = '4'
		and (select jsonb_agg(item - 'at' - 'notice' - 'picture') from jsonb_array_elements(p -> 'ready' -> 'changes') item)
			= '[{"key":4,"wasLive":true},{"key":2,"wasLive":true},{"key":1,"wasLive":true}]', 'made again: ' || p::text);
	perform pg_temp.base_assert(pg_temp.rel_live('a1-web', pg_temp.rel_shown(p)) = pg_temp.rel_answer(4, 'webshop')
		and (pg_temp.rel_release('a1-web', 5)).replaces is null and (pg_temp.rel_release('a1-web', 5)).prior is null,
		'its first release again');
	-- A member who left: the list file names nobody.
	perform pg_temp.base_claims('authenticated', pg_temp.rel_admin());
	perform public.qorpera_leave_hosted_profile(pg_temp.rel_company());
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.rec_files(20, 'a3-chain') -> 'index' -> 'live' -> 'by' = 'null', 'a member who left');
end $$;

-- 10. What's new lists every repository with a site, whatever the history before it ------------------------------------
-- (The review of #1686, F5.) Thirteen repositories here made a site once and have none now; four are live and two are
-- uploaded, not live yet. The ten: the four live, the two others with a site, then those with none, a problem first,
-- the newest first. By name alone, company/up (a site, not live) fell out behind the history.
do $$
declare v jsonb := pg_temp.rel_read();
begin
	perform pg_temp.base_assert((select jsonb_agg(site -> 'name' order by place) from jsonb_array_elements(v -> 'sites')
			with ordinality listed(site, place))
		= '["a1-web","a2-moved","a3-chain","a4-prune","due","up","given","tenth","full","abandoned"]', 'the ten: '
		|| (select string_agg(site ->> 'name', ', ') from jsonb_array_elements(v -> 'sites') site));
end $$;
