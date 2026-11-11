-- @fixture 1216_code_releases.test.sql until "-- 1. Rights, the columns, the marker"
-- A repository's site and its releases at the bounds the limits allow (migration 20260930729000): members and the
-- executor's control call under an 8 s statement limit, and the control gives a call 30 s. Each case builds the worst
-- case and holds the call to a generous bound, measured with clock_timestamp(); bnd_ms keeps what each took.
--   1. One file of 10 MiB put in parts of 88 KiB: the call that completes it (join, size and SHA-256, write).
--   2. A whole site at the caps (500 files, 25 MiB, 100 folders) beside nine kept versions of 25 MiB: begin, the
--      listing in pages of 150, missing in pages of 100, the puts, and the finish whose prune deletes one version.
--   3. The 200-row window of the ready point, and a release whose changes are cut at the newest 500 while its token
--      covers every row.
--   4. The member's read with 10 code sites, each 200 landed rows after the live one, 20 with a notice and picture.
--   5. Put live and Go back on such a site.
-- 1216's fixture part (1211's before it) gives the rel_ helpers. This file's repositories are company/zz-* and
-- company/aa-r0 to aa-r9; each case takes its sites offline before the next, so the company stays within its ten.

create temp table bnd_ms (name text primary key, ms numeric not null, bound numeric not null);
-- Times the call p_sql (a select of one jsonb) under the name, and answers what it answered.
create function pg_temp.bnd_time(p_name text, p_sql text, p_bound numeric) returns jsonb language plpgsql as $$
declare v_at timestamptz; v jsonb; v_ms numeric;
begin
	v_at := clock_timestamp();
	execute 'select ' || p_sql into v;
	v_ms := round(extract(epoch from clock_timestamp() - v_at) * 1000, 1);
	insert into bnd_ms values (p_name, v_ms, p_bound)
	on conflict (name) do update set ms = greatest(bnd_ms.ms, excluded.ms);
	return v;
end $$;
-- p_bytes random bytes (nothing a compressor shortens).
create function pg_temp.bnd_random(p_bytes integer) returns bytea language sql volatile as $$
	select coalesce(string_agg(extensions.gen_random_bytes(least(1024, p_bytes - (g - 1) * 1024)), ''::bytea order by g), ''::bytea)
	from generate_series(1, ceil(p_bytes / 1024.0)::integer) g
$$;
-- A repository's rows p_from to p_to, landed, their checks passed; each makes a site of a tree of its own when p_made
-- (3 files, 100 bytes: never uploaded), and every p_notice_every-th has a notice and a picture of its commit.
create function pg_temp.bnd_rows(p_name text, p_from integer, p_to integer, p_made boolean, p_notice_every integer default 0)
returns void language sql as $$
	insert into public.qorpera_code_changes (environment_id, owner, name, n, profile_id, kind, state, how, main_before,
		main_after, head_sha, worker_id, sequence, title, notice, picture, checks_state, checks, site_state, site)
	select pg_temp.rec_here(), 'company', p_name, g, pg_temp.rel_company(), 'landing', 'landed', 'fast-forward',
		pg_temp.rec_sha(p_name || ':' || (g - 1)), pg_temp.rec_sha(p_name || ':' || g), pg_temp.rec_sha(p_name || ':' || g),
		extensions.gen_random_uuid(), 1, 'Change ' || g,
		case when p_notice_every > 0 and g % p_notice_every = 0 then 'What a customer notices of change ' || g end,
		case when p_notice_every > 0 and g % p_notice_every = 0 then jsonb_build_object('source', 'commit',
			'path', 'docs/' || g || '.png', 'blob', pg_temp.rec_sha('picture' || g), 'bytes', 100, 'type', 'png',
			'at', format('code/company/%s/changes/%s.png', p_name, g)) end,
		'passed', '{"schema":"qorpera.code-checks/v1"}'::jsonb, case when p_made then 'made' end,
		case when p_made then jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', pg_temp.rec_sha(p_name || ':tree:' || g),
			'files', 3, 'bytes', 100, 'folder', 'dist', 'name', null, 'title', null) end
	from generate_series(p_from, p_to) g;
	update public.qorpera_code_repositories set last_change = p_to, last_main = pg_temp.rec_sha(p_name || ':' || p_to),
		index_version = index_version + 1
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = p_name;
$$;
-- Row p_n of company/p_name makes the site p_site (to upload it).
create function pg_temp.bnd_site(p_name text, p_n integer, p_site jsonb) returns void language sql as $$
	update public.qorpera_code_changes set site_state = 'made', site = p_site
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = p_name and n = p_n
$$;
-- A temp table of files (path, content, sha256, bytes) as the pass names them: its manifest, and its page p_page of
-- p_size in C order.
create function pg_temp.bnd_manifest(p_table text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	execute format('select jsonb_build_object(''manifestSha256'', encode(extensions.digest(convert_to(string_agg(path '
		'|| chr(9) || sha256 || chr(9) || bytes::text, chr(10) order by path collate "C"), ''utf8''), ''sha256''), ''hex''), '
		'''files'', count(*), ''bytes'', sum(bytes)) from %I', p_table) into v;
	return v;
end $$;
create function pg_temp.bnd_page(p_table text, p_page integer, p_size integer) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	execute format('select coalesce(jsonb_agg(jsonb_build_object(''path'', path, ''bytes'', bytes, ''sha256'', sha256) '
		'order by path collate "C"), ''[]'') from (select * from %I order by path collate "C" offset %s limit %s) page',
		p_table, (p_page - 1) * p_size, p_size) into v;
	return v;
end $$;
-- A code site taken offline, as a member does in Sites.
create function pg_temp.bnd_offline(p_name text) returns void language sql as $$
	delete from public.qorpera_company_sites where environment_id = pg_temp.rec_here() and code_owner = 'company'
		and code_name = p_name
$$;

select pg_temp.rel_repository(name) from unnest(array['zz-big', 'zz-site', 'zz-window', 'zz-cap', 'aa-r0', 'aa-r1', 'aa-r2',
	'aa-r3', 'aa-r4', 'aa-r5', 'aa-r6', 'aa-r7', 'aa-r8', 'aa-r9']) name \g /dev/null

-- 1. One file of 10 MiB, in parts of 88 KiB ----------------------------------------------------------------------------
create temp table bnd_big as
select 'index.html'::text as path, content, encode(extensions.digest(content, 'sha256'), 'hex') as sha256,
	octet_length(content) as bytes
from (select pg_temp.bnd_random(10485760) as content) big;
do $$
declare v jsonb; v_version uuid; v_parts integer := ceil(10485760 / 90112.0)::integer; v_content bytea;
	v_site jsonb := jsonb_build_object('schema', 'qorpera.code-site/v1', 'tree', pg_temp.rec_sha('zz-big:tree'), 'files', 1,
		'bytes', 10485760, 'folder', 'dist', 'name', null, 'title', null);
begin
	perform pg_temp.bnd_rows('zz-big', 1, 1, false);
	perform pg_temp.bnd_site('zz-big', 1, v_site);
	v_version := (pg_temp.rel_begin('zz-big', 1, pg_temp.bnd_manifest('bnd_big')) ->> 'versionId')::uuid;
	perform pg_temp.base_assert(pg_temp.rel_list(v_version, pg_temp.bnd_page('bnd_big', 1, 150), true)
		= pg_temp.rel_said_list('listed', 1) and v_parts = 117, 'the big file is listed');
	select content into v_content from bnd_big;
	for i in 0 .. v_parts - 1 loop
		v := pg_temp.bnd_time(case when i = v_parts - 1 then 'big: the call that completes 10 MiB' else 'big: a part of 88 KiB' end,
			format('pg_temp.rel_put(%L, %L)', v_version, jsonb_build_array(jsonb_build_object('path', 'index.html', 'part', i,
				'of', v_parts, 'contentBase64', encode(substring(v_content from i * 90112 + 1 for 90112), 'base64')))),
			case when i = v_parts - 1 then 3000 else 1000 end);
		perform pg_temp.base_assert(v = pg_temp.rel_kept_parts(case when i = v_parts - 1 then 1 else 0 end), 'part ' || i || ': ' || v::text);
	end loop;
	perform pg_temp.base_assert(pg_temp.rel_content(v_version, 'index.html') = v_content
		and pg_temp.rel_rows(v_version) = '1 files, 1 with bytes, 0 parts'
		and pg_temp.rel_finish(v_version) ->> 'state' = 'ready', 'the 10 MiB file is whole');
	perform pg_temp.bnd_offline('zz-big');
end $$;

-- 2. A whole site at the caps, beside nine kept versions of 25 MiB ---------------------------------------------------------
-- 500 files in 100 folders, 25 MiB in all: set a (the history's, all alike) and set b (the measured upload's).
create temp table bnd_a as
select path, content, encode(extensions.digest(content, 'sha256'), 'hex') as sha256, octet_length(content) as bytes
from (select case when i = 0 then 'index.html' else format('d%s/f%s.js', lpad((i % 100)::text, 2, '0'), i) end as path,
	pg_temp.bnd_random(case when i = 0 then 52828 else 52428 end) as content from generate_series(0, 499) i) files;
create temp table bnd_b as
select path, content, encode(extensions.digest(content, 'sha256'), 'hex') as sha256, octet_length(content) as bytes
from (select path, pg_temp.bnd_random(bytes) as content from bnd_a) files;
do $$
declare v jsonb; v_version uuid; v_manifest jsonb := pg_temp.bnd_manifest('bnd_a');
	v_site jsonb := jsonb_build_object('schema', 'qorpera.code-site/v1', 'files', 500, 'bytes', 26214400, 'folder', 'dist',
		'name', 'zz-site', 'title', null);
begin
	perform pg_temp.base_assert(v_manifest -> 'files' = '500' and v_manifest -> 'bytes' = '26214400'
		and (select count(distinct split_part(path, '/', 1)) from bnd_a where path like '%/%') = 100, 'the caps: ' || v_manifest::text);
	-- Nine versions of set a: the first's bytes put in place, every later one's copied at its last page (25 MiB each).
	-- Versions 1 to 6 go live in turn; 7 to 9 stay ready. The finishes delete nothing: live, five on the chain, three ready.
	for g in 1 .. 9 loop
		perform pg_temp.bnd_rows('zz-site', g, g, false);
		perform pg_temp.bnd_site('zz-site', g, v_site || jsonb_build_object('tree', pg_temp.rec_sha('zz-site:tree:' || g)));
		v_version := (pg_temp.rel_begin('zz-site', g, v_manifest) ->> 'versionId')::uuid;
		for p in 1 .. 4 loop
			v := pg_temp.bnd_time(case when p = 4 and g > 1 then 'site: the last page, copying 25 MiB' else 'site: a page of 150' end,
				format('pg_temp.rel_list(%L, %L, %L)', v_version, pg_temp.bnd_page('bnd_a', p, 150), p = 4), 3000);
		end loop;
		perform pg_temp.base_assert(v = pg_temp.rel_said_list('listed', case when g = 1 then 500 else 0 end), 'version ' || g || ': ' || v::text);
		if g = 1 then
			update public.qorpera_company_site_files file set content = a.content from bnd_a a
			where file.version_id = v_version and file.path = a.path;
		end if;
		perform pg_temp.base_assert(pg_temp.rel_finish(v_version) = '{"schema":"qorpera.code-site-finish/v1","state":"ready","pruned":0}',
			'version ' || g || ' ready');
		if g <= 6 then
			perform pg_temp.base_assert(pg_temp.rel_yes('zz-site') = pg_temp.rel_answer(g, 'zz-site'), 'version ' || g || ' live');
		end if;
	end loop;
	perform pg_temp.base_assert(pg_temp.rel_states('zz-site') = '1:kept 2:kept 3:kept 4:kept 5:kept 6:live 7:ready 8:ready 9:ready'
		and (select count(*) from public.qorpera_company_site_files f join public.qorpera_company_site_versions v on v.id = f.version_id
			where v.site_id = (pg_temp.rel_site_row('zz-site')).id and f.content is not null) = 4500, 'nine of 25 MiB');
	-- The tenth, of set b: every call timed.
	perform pg_temp.bnd_rows('zz-site', 10, 10, false);
	perform pg_temp.bnd_site('zz-site', 10, v_site || jsonb_build_object('tree', pg_temp.rec_sha('zz-site:tree:10')));
	v := pg_temp.bnd_time('site: begin', format('pg_temp.rel_begin(%L, 10, %L)', 'zz-site', pg_temp.bnd_manifest('bnd_b')), 3000);
	v_version := (v ->> 'versionId')::uuid;
	for p in 1 .. 4 loop
		v := pg_temp.bnd_time(case when p = 4 then 'site: the last page, nothing to copy' else 'site: a page of 150' end,
			format('pg_temp.rel_list(%L, %L, %L)', v_version, pg_temp.bnd_page('bnd_b', p, 150), p = 4), 3000);
	end loop;
	perform pg_temp.base_assert(v = pg_temp.rel_said_list('listed', 500), 'the tenth listed: ' || v::text);
	for p in 1 .. 6 loop
		v := pg_temp.bnd_time('site: missing, a page of 100', format('pg_temp.rel_missing(%L, %L, 100)', v_version,
			case when p > 1 then (select path from bnd_b order by path collate "C" offset (p - 1) * 100 - 1 limit 1) end), 3000);
		perform pg_temp.base_assert(jsonb_array_length(v -> 'missing') = case when p <= 5 then 100 else 0 end
			and v -> 'more' = to_jsonb(p < 5), 'missing page ' || p || ': ' || left(v::text, 200));
	end loop;
	for v in select jsonb_build_array(jsonb_build_object('path', path, 'part', 0, 'of', 1, 'contentBase64', encode(content, 'base64')))
		from bnd_b order by path collate "C" loop
		perform pg_temp.base_assert(pg_temp.bnd_time('site: a put of one file (52 KiB)', format('pg_temp.rel_put(%L, %L)', v_version, v), 3000)
			= pg_temp.rel_kept_parts(1), 'a put');
	end loop;
	v := pg_temp.bnd_time('site: finish, pruning one version of 25 MiB', format('pg_temp.rel_finish(%L)', v_version), 3000);
	perform pg_temp.base_assert(v = '{"schema":"qorpera.code-site-finish/v1","state":"ready","pruned":1}'
		and pg_temp.rel_states('zz-site') = '1:kept 2:kept 3:kept 4:kept 5:kept 6:live 8:ready 9:ready 10:ready', 'pruned one: ' || v::text);
	perform pg_temp.bnd_offline('zz-site');
end $$;

-- 3. The window of 200 rows, and a release cut at 500 -------------------------------------------------------------------
do $$
declare p jsonb; v jsonb; r public.qorpera_code_releases%rowtype;
begin
	-- company/zz-window: change 1 is a ready point; then 199 changes that are not. 200 rows after nothing live: offered.
	perform pg_temp.bnd_rows('zz-window', 1, 1, false);
	perform pg_temp.bnd_site('zz-window', 1, pg_temp.rel_site('zz-window:1'));
	perform pg_temp.rel_upload('zz-window', 1, 'zz-window:1');
	perform pg_temp.bnd_rows('zz-window', 2, 200, false);
	perform pg_temp.base_assert(pg_temp.rel_page('zz-window') -> 'ready' -> 'change' = '1', 'within the newest 200');
	-- Landings refused or in conflict move no main and take no place in the window (the review of #1686).
	insert into public.qorpera_code_changes (environment_id, owner, name, n, profile_id, kind, state, head_sha, worker_id,
		sequence, title, refusal)
	select pg_temp.rec_here(), 'company', 'zz-window', g, pg_temp.rel_company(), 'landing', 'refused', pg_temp.rec_sha('h' || g),
		extensions.gen_random_uuid(), 1, 'Refused ' || g, '{"code":"CODE_HOST_LAND_CONFLICT","paths":[]}'::jsonb
	from generate_series(201, 203) g;
	perform pg_temp.base_assert(pg_temp.rel_page('zz-window') -> 'ready' -> 'change' = '1', 'refusals take no place in the window');
	-- One change more: change 1 is no longer among the newest 200, and is not offered.
	perform pg_temp.bnd_rows('zz-window', 204, 204, false);
	p := pg_temp.rel_page('zz-window');
	perform pg_temp.base_assert(p -> 'ready' = 'null' and p -> 'waiting' = '201'
		and public.qorpera_code_release_point(pg_temp.rec_shop('zz-window')) is null, 'beyond the newest 200: ' || p::text);
	perform pg_temp.bnd_offline('zz-window');

	-- company/zz-cap: 600 changes, then change 601 with a site, uploaded. A page drawn, then the oldest change's notice
	-- changed (it is not among the newest 500): the token moved.
	perform pg_temp.bnd_rows('zz-cap', 1, 601, false);
	perform pg_temp.bnd_site('zz-cap', 601, pg_temp.rel_site('zz-cap:601'));
	perform pg_temp.rel_upload('zz-cap', 601, 'zz-cap:601');
	p := pg_temp.rel_page('zz-cap');
	perform pg_temp.base_assert(p -> 'ready' -> 'change' = '601' and p -> 'ready' -> 'quiet' = '601', 'the cap''s page');
	update public.qorpera_code_changes set notice = 'The first change, described later'
	where environment_id = pg_temp.rec_here() and owner = 'company' and name = 'zz-cap' and n = 1;
	perform pg_temp.base_assert(pg_temp.rel_live('zz-cap', pg_temp.rel_shown(p)) = pg_temp.rel_moved(), 'the token covers change 1');
	p := pg_temp.rel_page('zz-cap');
	v := pg_temp.bnd_time('put live: 601 changes, cut at 500', format('pg_temp.rel_live(%L, %L)', 'zz-cap', pg_temp.rel_shown(p)), 1000);
	r := pg_temp.rel_release('zz-cap', 1);
	perform pg_temp.base_assert(v = pg_temp.rel_answer(1, 'zz-cap') and cardinality(r.changes) = 500 and r.changes[1] = 601
		and r.changes[500] = 102 and r.shown_sha256 = p -> 'ready' ->> 'token', 'the newest 500: ' || v::text);
	perform pg_temp.bnd_offline('zz-cap');
end $$;

-- 4. The member's read: ten sites, each 200 changes after the live one ------------------------------------------------
do $$
declare v_name text; v jsonb;
begin
	for i in 0 .. 9 loop
		v_name := 'aa-r' || i;
		perform pg_temp.bnd_rows(v_name, 1, 1, false);
		perform pg_temp.bnd_site(v_name, 1, pg_temp.rel_site(v_name || ':1'));
		perform pg_temp.rel_upload(v_name, 1, v_name || ':1');
		perform pg_temp.base_assert(pg_temp.rel_yes(v_name) = pg_temp.rel_answer(1, v_name), v_name || ' live');
		perform pg_temp.bnd_rows(v_name, 2, 201, true, 10);
		perform pg_temp.bnd_site(v_name, 201, pg_temp.rel_site(v_name || ':201'));
		perform pg_temp.rel_upload(v_name, 201, v_name || ':201');
	end loop;
	v := pg_temp.bnd_time('read: 10 sites, 200 changes each', format('pg_temp.rel_read(%L)', pg_temp.req_owner()), 2000);
	perform pg_temp.base_assert(jsonb_array_length(v -> 'sites') = 10 and not exists (select 1 from jsonb_array_elements(v -> 'sites') site
		where site -> 'ready' -> 'change' is distinct from '201' or jsonb_array_length(site -> 'ready' -> 'changes') is distinct from 20
			or site -> 'ready' -> 'quiet' is distinct from '180' or site -> 'live' -> 'version' is distinct from '1'
			or site -> 'ready' -> 'changes' -> 0 ->> 'picture' is distinct from format('code/company/%s/changes/200.png', site ->> 'name')),
		'the read: ' || left(v::text, 600));

-- 5. Put live and Go back on such a site --------------------------------------------------------------------------------
	v := pg_temp.bnd_time('put live: 200 changes', format('pg_temp.rel_live(%L, %L)', 'aa-r0',
		pg_temp.rel_shown(pg_temp.rel_page('aa-r0'))), 1000);
	perform pg_temp.base_assert(v = pg_temp.rel_answer(2, 'aa-r0') and cardinality((pg_temp.rel_release('aa-r0', 2)).changes) = 200,
		'put live: ' || v::text);
	v := pg_temp.bnd_time('go back', format('pg_temp.rel_back(%L, %L)', 'aa-r0', '{"live":2,"to":1}'), 1000);
	perform pg_temp.base_assert(v = pg_temp.rel_answer(1, 'aa-r0'), 'go back: ' || v::text);
end $$;

-- Every bound held.
do $$
begin
	perform pg_temp.base_assert(not exists (select 1 from bnd_ms where ms >= bound) and (select count(*) from bnd_ms) = 13,
		'bounds: ' || (select string_agg(name || ' ' || ms || ' ms (bound ' || bound || ')', '; ' order by name) from bnd_ms));
end $$;
