-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- The platform's numbers of a company, door `site` (company views step 3, slice S1, 20260930768000) on 924's company and
-- its real native run of Alice's. site-serve counts a page view with qorpera_site_count_view; a member asks the site
-- questions with qorpera_member_company_numbers, a run with qorpera_run_company_numbers. Checked here: the grants, the
-- tables (closed, no visitor's data) and the lock timeout; what counts on the old host while hosts are off and on a
-- site's own host while they are on, and what never does (the next host, assets, a missing path, another session's
-- site, an ended or next session, a site not live, taken down, an app link, sites switched off); visits (30 minutes)
-- and the cap of 60 a session an hour; the upkeep (hours into days in the company's zone, once; hour rows after 35
-- days, never one not added; seen rows an hour after the last view) and its schedule; every question's answer, defaults
-- and bounds, and an answer cut at 2000 rows; rights (an outsider, another company's member, a run of another company;
-- another company's sites never show); a site's rows go with it, a session's last view with the session.

create function pg_temp.s_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.s_json(p_got jsonb, p_want jsonb, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
create function pg_temp.s_state(p_sql text) returns text language plpgsql as $$
begin
	execute p_sql;
	return 'ok';
exception when others then
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.s_actor() returns jsonb language sql as $$
	select jsonb_build_object('kind', 'run', 'runId', b ->> 'runId', 'jobId', b ->> 'jobId', 'runnerId', b ->> 'runnerId',
		'assignmentId', b ->> 'assignmentId') from (select current_setting('qorpera_test.base_binding')::jsonb as b) s
$$;
-- A member's ask, as their token makes it; the claims are the service role's again afterwards.
create function pg_temp.s_member(p_user uuid, p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_member_company_numbers(p_environment, p_question, p_params);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
create function pg_temp.s_owner(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.s_member('92400000-0000-4000-8000-000000000001', p_question, p_params)
$$;
create function pg_temp.s_rows(p_question text, p_params jsonb default '{}'::jsonb) returns jsonb language sql as $$
	select pg_temp.s_owner(p_question, p_params) -> 'rows'
$$;
-- The same ask's refusal (or 'ok').
create function pg_temp.s_refused(p_question text, p_params jsonb default '{}'::jsonb,
	p_user uuid default '92400000-0000-4000-8000-000000000001',
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns text language plpgsql as $$
declare v text;
begin
	v := pg_temp.s_state(format('select pg_temp.s_member(%L, %L, %L::jsonb, %L)', p_user, p_question, p_params,
		p_environment));
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- A run's ask as the native host's dispatch makes it (the service role).
create function pg_temp.s_run(p_question text, p_params jsonb default '{}'::jsonb,
	p_environment uuid default '92400000-0000-4000-8000-000000000020') returns jsonb language plpgsql as $$
begin
	perform pg_temp.base_claims('service_role');
	return public.qorpera_run_company_numbers(p_environment, pg_temp.s_actor(), p_question, p_params);
end $$;
-- A session token of 32 characters, and its row.
create function pg_temp.s_token(p_n integer) returns text language sql immutable as $$
	select 'c1266' || lpad(p_n::text, 3, '0') || repeat('a', 24)
$$;
create function pg_temp.s_session(p_n integer, p_site uuid, p_scope text default 'site', p_version uuid default null,
	p_expires interval default interval '7 days') returns void language sql as $$
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope, version_id)
	values (public.qorpera_site_sha256(pg_temp.s_token(p_n)), p_site, 1, clock_timestamp() + p_expires, p_scope, p_version)
$$;
-- site-serve's call now, or the counting at a time of the test's.
create function pg_temp.s_view(p_host text, p_path text, p_n integer, p_at timestamptz default null) returns jsonb
language sql as $$
	select case when p_at is null then public.qorpera_site_count_view(p_host, p_path, pg_temp.s_token(p_n))
		else public.qorpera_site_count_view_at(p_host, p_path, pg_temp.s_token(p_n), p_at) end
$$;
create function pg_temp.s_counted(p_site uuid) returns text language sql as $$
	select coalesce(sum(views), 0) || '/' || coalesce(sum(visits), 0) from public.qorpera_site_counts where site_id = p_site
$$;
create function pg_temp.s_hour() returns timestamptz language sql as $$
	select date_trunc('hour', clock_timestamp(), 'UTC')
$$;
create function pg_temp.s_today() returns date language sql as $$
	select (clock_timestamp() at time zone 'Europe/Copenhagen')::date
$$;
create function pg_temp.s_iso(p_at timestamptz) returns text language sql as $$
	select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;
-- A live files site of p_profile with the files given as (path, content type), version p_version.
create function pg_temp.s_site(p_id uuid, p_profile uuid, p_environment uuid, p_slug text, p_title text,
	p_version uuid, p_files text[]) returns void language plpgsql as $$
declare i integer;
begin
	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (p_id, p_profile, p_environment, p_slug, p_title, 'web', '92400000-0000-4000-8000-000000000030');
	insert into public.qorpera_company_site_secrets(site_id, password) values (p_id, p_slug || '-password');
	if p_version is null then return; end if;
	insert into public.qorpera_company_site_versions(id, site_id, run_id, call_id, staff_agent_id, first_publish, source_path,
		manifest_sha256, file_count, total_bytes, state, published_at)
	values (p_version, p_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, 'count-' || p_slug,
		'92400000-0000-4000-8000-000000000030', true, 'web', repeat('a', 64), cardinality(p_files) / 2, 3, 'live',
		clock_timestamp());
	for i in 1..cardinality(p_files) / 2 loop
		insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content)
		values (p_version, p_files[2 * i - 1], 3, encode(extensions.digest('<p>', 'sha256'), 'hex'), p_files[2 * i],
			convert_to('<p>', 'utf8'));
	end loop;
	update public.qorpera_company_sites set current_version_id = p_version, published_at = clock_timestamp(),
		published_by_staff_agent_id = '92400000-0000-4000-8000-000000000030'
	where id = p_id;
end $$;

-- Another company, with its own member and its own live site, and 924's sites: count-shop (live: two pages, a .htm
-- page, a style sheet, a 404.html), count-blog (live: one page), count-wait (no live version yet) and count-app (an app
-- link). Sites are on; hosts are off.
insert into auth.users(id, email) values
	('12660000-0000-4000-8000-000000000006', 'site-numbers-other@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12660000-0000-4000-8000-000000000010', 'Site numbers other', '12660000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12660000-0000-4000-8000-000000000010', '12660000-0000-4000-8000-000000000006', 'site-numbers-other@example.test',
		'Other owner', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12660000-0000-4000-8000-000000000020', '12660000-0000-4000-8000-000000000010', 'Environment', 1,
	'12660000-0000-4000-8000-000000000006');
select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('12660000-0000-4000-8000-000000000020') \g /dev/null

update public.qorpera_site_settings set enabled = true, hosts_domain = null, hosts_enabled = false;
select pg_temp.s_site('12660000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'count-shop', 'The shop', '12660000-0000-4000-8000-000000000101',
	array['index.html', 'text/html; charset=utf-8', 'about/index.html', 'text/html; charset=utf-8',
		'docs.htm', 'text/html; charset=utf-8', 'style.css', 'text/css; charset=utf-8',
		'404.html', 'text/html; charset=utf-8']);
select pg_temp.s_site('12660000-0000-4000-8000-000000000200', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'count-blog', null, '12660000-0000-4000-8000-000000000201',
	array['index.html', 'text/html; charset=utf-8']);
select pg_temp.s_site('12660000-0000-4000-8000-000000000300', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'count-wait', 'Coming soon', null, '{}');
insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind,
	app_port)
values ('12660000-0000-4000-8000-000000000400', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'count-app', 'app', '92400000-0000-4000-8000-000000000030', 'app', 8080);
insert into public.qorpera_company_site_secrets(site_id, password) values ('12660000-0000-4000-8000-000000000400',
	'count-app-password');
select pg_temp.s_site('12660000-0000-4000-8000-000000000500', '12660000-0000-4000-8000-000000000010',
	'12660000-0000-4000-8000-000000000020', 'other-shop', 'Elsewhere', '12660000-0000-4000-8000-000000000501',
	array['index.html', 'text/html; charset=utf-8']);
-- Sessions: 1 to 3 and 8 and 9 visitors' of count-shop, 4 count-blog's, 5 a member's look first at count-shop, 6
-- count-shop's that ended, 7 other-shop's, 10 count-app's.
select pg_temp.s_session(1, '12660000-0000-4000-8000-000000000100');
select pg_temp.s_session(2, '12660000-0000-4000-8000-000000000100');
select pg_temp.s_session(3, '12660000-0000-4000-8000-000000000100');
select pg_temp.s_session(4, '12660000-0000-4000-8000-000000000200');
select pg_temp.s_session(5, '12660000-0000-4000-8000-000000000100', 'next', '12660000-0000-4000-8000-000000000101',
	interval '12 hours');
select pg_temp.s_session(6, '12660000-0000-4000-8000-000000000100', 'site', null, interval '-1 minute');
select pg_temp.s_session(7, '12660000-0000-4000-8000-000000000500');
select pg_temp.s_session(8, '12660000-0000-4000-8000-000000000100');
select pg_temp.s_session(9, '12660000-0000-4000-8000-000000000100');
select pg_temp.s_session(10, '12660000-0000-4000-8000-000000000400');
-- The upkeep as if it last ran 40 days ago: every hour below is still to be added to its day.
update public.qorpera_site_count_upkeep set rolled_until = pg_temp.s_hour() - interval '40 days';

-- 1. The grants: site-serve's call by the service role only, everything else by no API role; the tables closed, with
--    no column that could hold a visitor's data; the lock timeout; the dispatcher's markers.
do $$
declare v_function text; v_table text; v_role text;
begin
	if has_function_privilege('anon', 'public.qorpera_site_count_view(text,text,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_site_count_view(text,text,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_site_count_view(text,text,text)', 'EXECUTE') then
		raise exception 'qorpera_site_count_view has the wrong grants'; end if;
	foreach v_function in array array['public.qorpera_site_count_view_at(text,text,text,timestamptz)',
		'public.qorpera_site_count_upkeep(timestamptz)', 'public.qorpera_schedule_site_count_upkeep()',
		'public.qorpera_company_numbers_site(uuid,timestamptz,text,jsonb)', 'public.qorpera_company_numbers_zone(uuid)',
		'public.qorpera_company_numbers_hour(jsonb,text,text,boolean)',
		'public.qorpera_site_count_day_rows(uuid[],text,date,date)'] loop
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_function, 'EXECUTE') then
				raise exception '% is open to %', v_function, v_role; end if;
		end loop;
	end loop;
	foreach v_table in array array['public.qorpera_site_counts', 'public.qorpera_site_count_days',
		'public.qorpera_site_session_seen', 'public.qorpera_site_count_upkeep'] loop
		if not (select relrowsecurity from pg_class where oid = v_table::regclass) then
			raise exception '% has no row level security', v_table; end if;
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_table_privilege(v_role, v_table, 'SELECT') or has_table_privilege(v_role, v_table, 'INSERT')
				or has_table_privilege(v_role, v_table, 'UPDATE') or has_table_privilege(v_role, v_table, 'DELETE') then
				raise exception '% is open to %', v_table, v_role; end if;
		end loop;
	end loop;
	-- Every column there is: counts, days, a session's last view. No address, network, agent, referrer, query, country
	-- or header anywhere.
	perform pg_temp.s_same((select string_agg(table_name || '.' || column_name, ',' order by table_name collate "C", ordinal_position)
		from information_schema.columns where table_schema = 'public' and table_name in ('qorpera_site_counts',
			'qorpera_site_count_days', 'qorpera_site_session_seen', 'qorpera_site_count_upkeep')),
		'qorpera_site_count_days.site_id,qorpera_site_count_days.day,qorpera_site_count_days.path,'
		'qorpera_site_count_days.views,qorpera_site_count_days.visits,'
		'qorpera_site_count_upkeep.id,qorpera_site_count_upkeep.rolled_until,qorpera_site_count_upkeep.ran_at,'
		'qorpera_site_count_upkeep.stopped,'
		'qorpera_site_counts.site_id,qorpera_site_counts.hour,qorpera_site_counts.path,qorpera_site_counts.views,'
		'qorpera_site_counts.visits,'
		'qorpera_site_session_seen.token_sha256,qorpera_site_session_seen.site_id,qorpera_site_session_seen.last_view_at,'
		'qorpera_site_session_seen.hour,qorpera_site_session_seen.views_in_hour', 'the tables'' columns');
	-- site-serve hands over the host, the path and the token, nothing else.
	perform pg_temp.s_same((select array_to_string(proargnames, ',') from pg_proc
		where oid = 'public.qorpera_site_count_view(text,text,text)'::regprocedure), 'p_host,p_path,p_token', 'the call''s arguments');
	perform pg_temp.s_same((select array_to_string(proconfig, ',') from pg_proc
		where oid = 'public.qorpera_site_count_view_at(text,text,text,timestamptz)'::regprocedure),
		'search_path="",lock_timeout=100ms', 'the count waits 100 ms for a lock at most');
	perform pg_temp.s_same((select array_to_string(proconfig, ',') from pg_proc
		where oid = 'public.qorpera_site_count_view(text,text,text)'::regprocedure),
		'search_path="",lock_timeout=100ms', 'site-serve''s call too');
	perform pg_temp.s_same((select (strpos(prosrc, '20260930767000') > 0 and strpos(prosrc, '20260930768000') > 0
			and strpos(prosrc, 'not counted yet') = 0)::text
		from pg_proc where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure), 'true',
		'the dispatcher''s markers');
end $$;

-- 2. Hosts off: the old host counts a page of a visitor's session, its path after the site's name; nothing else counts.
do $$
declare o constant text := 'sites.qorpera.com';
begin
	perform pg_temp.s_json(pg_temp.s_view(o, 'count-shop/index.html', 1), '{"state":"counted","visit":true}', 'a first view');
	perform pg_temp.s_json(pg_temp.s_view(o, '/count-shop/', 1), '{"state":"counted","visit":false}',
		'the top again, at once: no new visit');
	perform pg_temp.s_json(pg_temp.s_view('SITES.Qorpera.com', 'count-shop/about/', 1), '{"state":"counted","visit":false}',
		'a folder''s page, the host in any case');
	perform pg_temp.s_json(pg_temp.s_view(o, 'count-shop/docs.htm', 1), '{"state":"counted","visit":false}', 'a .htm page');
	perform pg_temp.s_json(pg_temp.s_view(o, 'count-shop', 2), '{"state":"counted","visit":true}', 'another session''s visit');
	perform pg_temp.s_same(pg_temp.s_counted('12660000-0000-4000-8000-000000000100'), '5/2', 'count-shop''s views and visits');
	perform pg_temp.s_same((select string_agg(path || '=' || views || '/' || visits, ',' order by path)
		from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000100'),
		'about/index.html=1/0,docs.htm=1/0,index.html=3/2', 'by path, in this hour');
	perform pg_temp.s_same((select string_agg(hour::text, ',') from (select distinct hour from public.qorpera_site_counts) h),
		pg_temp.s_hour()::text, 'the UTC hour');
	perform pg_temp.s_same((select count(*)::text || ' ' || min(views_in_hour) || ' ' || max(views_in_hour)
		from public.qorpera_site_session_seen), '2 1 4', 'the sessions'' last views');
	-- Never counted: an asset, a path the version lacks, its 404.html is a page (asked for by name), a path that is no
	-- site path, another site's session, a member's look first, an ended session, a token of another shape, no token.
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/style.css', 1) ->> 'state', 'skipped', 'a style sheet');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/gone.html', 1) ->> 'state', 'skipped', 'a missing page');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/../index.html', 1) ->> 'state', 'skipped', 'no site path');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/.git/index.html', 1) ->> 'state', 'skipped', 'a hidden name');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 4) ->> 'state', 'skipped', 'count-blog''s session');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 5) ->> 'state', 'skipped', 'a look first session');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 6) ->> 'state', 'skipped', 'an ended session');
	perform pg_temp.s_same((public.qorpera_site_count_view(o, 'count-shop/index.html', 'short')) ->> 'state', 'skipped',
		'a token of another shape');
	perform pg_temp.s_same((public.qorpera_site_count_view(o, 'count-shop/index.html', null)) ->> 'state', 'skipped',
		'no token');
	perform pg_temp.s_same((public.qorpera_site_count_view(null, 'count-shop/index.html', pg_temp.s_token(1))) ->> 'state',
		'skipped', 'no host');
	-- A site with no live version, an app link, a name that is no site, a reserved name.
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-wait/index.html', 1) ->> 'state', 'skipped', 'not live yet');
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-app/index.html', 10) ->> 'state', 'skipped', 'an app link');
	perform pg_temp.s_same(pg_temp.s_view(o, 'no-shop/index.html', 1) ->> 'state', 'skipped', 'no such site');
	perform pg_temp.s_same(pg_temp.s_view(o, 'api/index.html', 1) ->> 'state', 'skipped', 'a reserved name');
	-- Hosts off: a site's own host and any other host count nothing.
	perform pg_temp.s_same(pg_temp.s_view('count-shop.qorpera.com', 'index.html', 1) ->> 'state', 'skipped',
		'the own host while hosts are off');
	perform pg_temp.s_same(pg_temp.s_view('evil.example', 'count-shop/index.html', 1) ->> 'state', 'skipped', 'another host');
	-- A new password ends the sessions of the old one.
	update public.qorpera_company_sites set password_version = 2 where id = '12660000-0000-4000-8000-000000000100';
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 1) ->> 'state', 'skipped', 'an old password''s session');
	update public.qorpera_company_sites set password_version = 1 where id = '12660000-0000-4000-8000-000000000100';
	-- Sites switched off: nothing counts.
	update public.qorpera_site_settings set enabled = false;
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 1) ->> 'state', 'skipped', 'sites off');
	update public.qorpera_site_settings set enabled = true;
	-- Taken down: nothing counts.
	update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'A test'
	where id = '12660000-0000-4000-8000-000000000100';
	perform pg_temp.s_same(pg_temp.s_view(o, 'count-shop/index.html', 1) ->> 'state', 'skipped', 'taken down');
	update public.qorpera_company_sites set taken_down_at = null, taken_down_reason = null
	where id = '12660000-0000-4000-8000-000000000100';
	-- Nothing of the skipped views was written.
	perform pg_temp.s_same(pg_temp.s_counted('12660000-0000-4000-8000-000000000100'), '5/2', 'nothing more was counted');
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_session_seen), '2', 'no other session was seen');
end $$;

-- 3. Hosts on: a site's own host counts, at the top; the old host (its links move) and the next host never.
update public.qorpera_site_settings set hosts_domain = 'qorpera.com';
update public.qorpera_site_settings set hosts_enabled = true;
do $$
begin
	perform pg_temp.s_json(pg_temp.s_view('count-shop.qorpera.com', 'about/', 3), '{"state":"counted","visit":true}',
		'the own host');
	perform pg_temp.s_json(pg_temp.s_view('Count-Shop.Qorpera.COM', '/', 3), '{"state":"counted","visit":false}',
		'the own host in any case, its top');
	perform pg_temp.s_json(pg_temp.s_view('count-blog.qorpera.com', '', 4), '{"state":"counted","visit":true}',
		'count-blog''s session on its own host');
	perform pg_temp.s_json(pg_temp.s_view('other-shop.qorpera.com', 'index.html', 7), '{"state":"counted","visit":true}',
		'another company''s site counts for that company');
	perform pg_temp.s_same(pg_temp.s_view('count-shop--next.qorpera.com', 'index.html', 5) ->> 'state', 'skipped',
		'the next host, a member''s session');
	perform pg_temp.s_same(pg_temp.s_view('count-shop--next.qorpera.com', 'index.html', 3) ->> 'state', 'skipped',
		'the next host, a visitor''s session');
	perform pg_temp.s_same(pg_temp.s_view('sites.qorpera.com', 'count-shop/index.html', 3) ->> 'state', 'skipped',
		'the old host while hosts are on');
	perform pg_temp.s_same(pg_temp.s_view('count-blog.qorpera.com', 'index.html', 3) ->> 'state', 'skipped',
		'count-shop''s session on count-blog''s host');
	perform pg_temp.s_same(pg_temp.s_view('count-shop.qorpera.com.evil.example', 'index.html', 3) ->> 'state', 'skipped',
		'a look-alike host');
	perform pg_temp.s_same(pg_temp.s_view('count-shop.qorpera.com', 'style.css', 3) ->> 'state', 'skipped', 'an asset');
	perform pg_temp.s_same(pg_temp.s_counted('12660000-0000-4000-8000-000000000100'), '7/3', 'count-shop now');
	perform pg_temp.s_same(pg_temp.s_counted('12660000-0000-4000-8000-000000000500'), '1/1', 'other-shop now');
end $$;

-- 4. Visits and the cap, at the test's times. Session 8 views at an hour's 1st minute (a visit), its 29th (none), its
--    58th (none: 29 minutes after the one before), then 31 minutes later (a visit). Session 9 has 60 counted views in
--    one hour, then its 61st is capped and counts nothing but its time, so its next view, in the next hour and 25
--    minutes later, counts and is no new visit.
do $$
declare v_at timestamptz := pg_temp.s_hour() - interval '6 hours' + interval '1 minute'; i integer; v jsonb;
	h constant text := 'count-shop.qorpera.com';
begin
	perform pg_temp.s_json(pg_temp.s_view(h, 'docs.htm', 8, v_at), '{"state":"counted","visit":true}', 'minute 1');
	perform pg_temp.s_json(pg_temp.s_view(h, 'docs.htm', 8, v_at + interval '28 minutes'),
		'{"state":"counted","visit":false}', 'minute 29');
	perform pg_temp.s_json(pg_temp.s_view(h, 'docs.htm', 8, v_at + interval '57 minutes'),
		'{"state":"counted","visit":false}', 'minute 58');
	perform pg_temp.s_json(pg_temp.s_view(h, 'docs.htm', 8, v_at + interval '88 minutes'),
		'{"state":"counted","visit":true}', '31 minutes later');
	perform pg_temp.s_json(pg_temp.s_view(h, 'docs.htm', 8, v_at + interval '118 minutes'),
		'{"state":"counted","visit":true}', 'exactly 30 minutes later: a new visit');
	perform pg_temp.s_same((select string_agg(to_char(hour at time zone 'UTC', 'HH24') || '=' || views || '/' || visits, ','
			order by hour)
		from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000100' and path = 'docs.htm'
			and hour < pg_temp.s_hour()),
		to_char((v_at) at time zone 'UTC', 'HH24') || '=3/1,' || to_char((v_at + interval '1 hour') at time zone 'UTC', 'HH24')
			|| '=2/2', 'session 8''s two hours');
	v_at := pg_temp.s_hour() - interval '4 hours' + interval '1 minute';
	for i in 0..59 loop
		v := pg_temp.s_view(h, 'index.html', 9, v_at + i * interval '20 seconds');
		perform pg_temp.s_same(v ->> 'state', 'counted', 'view ' || i);
	end loop;
	perform pg_temp.s_same((select views_in_hour::text from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(9))), '60', 'sixty this hour');
	perform pg_temp.s_json(pg_temp.s_view(h, 'index.html', 9, v_at + interval '40 minutes'), '{"state":"capped"}',
		'the 61st');
	perform pg_temp.s_json(pg_temp.s_view(h, 'about/index.html', 9, v_at + interval '41 minutes'), '{"state":"capped"}',
		'the 62nd, another page');
	perform pg_temp.s_same((select views || '/' || visits from public.qorpera_site_counts
		where site_id = '12660000-0000-4000-8000-000000000100' and hour = pg_temp.s_hour() - interval '4 hours'
			and path = 'index.html'), '60/1', 'sixty views, one visit');
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_counts
		where site_id = '12660000-0000-4000-8000-000000000100' and hour = pg_temp.s_hour() - interval '4 hours'
			and path = 'about/index.html'), '0', 'the capped page has no row');
	perform pg_temp.s_same((select (last_view_at = v_at + interval '41 minutes')::text from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(9))), 'true', 'a capped view keeps its time');
	perform pg_temp.s_json(pg_temp.s_view(h, 'index.html', 9, v_at + interval '66 minutes'),
		'{"state":"counted","visit":false}', 'the next hour, 25 minutes after the capped view');
	perform pg_temp.s_same((select hour || ' ' || views_in_hour from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(9))),
		(pg_temp.s_hour() - interval '3 hours') || ' 1', 'a new hour, a new cap');
end $$;

-- 5. The questions. count-blog gets hours of its own: this one (3 views, 2 visits, besides session 4's), the one before
--    (index 4/1, about 2/1), 47 and 48 hours ago, 10, 34 and 36 days ago.
insert into public.qorpera_site_counts(site_id, hour, path, views, visits) values
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '1 hour', 'index.html', 4, 1),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '1 hour', 'about.html', 2, 1),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '47 hours', 'index.html', 1, 1),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '48 hours', 'index.html', 9, 9),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '10 days', 'index.html', 5, 5),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '34 days', 'old.html', 7, 7),
	('12660000-0000-4000-8000-000000000200', pg_temp.s_hour() - interval '36 days', 'oldest.html', 11, 11);
update public.qorpera_site_counts set views = views + 3, visits = visits + 2
where site_id = '12660000-0000-4000-8000-000000000200' and hour = pg_temp.s_hour() and path = 'index.html';

do $$
declare v jsonb; v_rows jsonb; v_today date := pg_temp.s_today(); v_want text;
begin
	-- sites: the company's files sites by name, with their own host's address; never an app link or another company's.
	v := pg_temp.s_owner('sites');
	perform pg_temp.s_same((select string_agg(k, ',' order by k) from jsonb_object_keys(v) k), 'asOf,columns,etag,more,rows',
		'the answer''s keys');
	perform pg_temp.s_json(v -> 'columns', '["site","title","url","live"]', 'sites'' columns');
	perform pg_temp.s_json(v -> 'rows', '[["count-blog",null,"https://count-blog.qorpera.com/",true],'
		'["count-shop","The shop","https://count-shop.qorpera.com/",true],'
		'["count-wait","Coming soon","https://count-wait.qorpera.com/",false]]', 'the sites');
	perform pg_temp.s_same(((v ->> 'etag') ~ '^[0-9a-f]{32}$')::text, 'true', 'the etag');
	perform pg_temp.s_same(v ->> 'more', 'false', 'more');
	perform pg_temp.s_same(pg_temp.s_refused('sites', '{"site":"count-shop"}'), '22023 The question takes no :site',
		'sites takes no :site');
	-- Taken down, or sites switched off: not live. Hosts off: the old host's address.
	update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'A test'
	where id = '12660000-0000-4000-8000-000000000200';
	perform pg_temp.s_same(pg_temp.s_rows('sites') #>> '{0,3}', 'false', 'taken down');
	update public.qorpera_company_sites set taken_down_at = null, taken_down_reason = null
	where id = '12660000-0000-4000-8000-000000000200';
	update public.qorpera_site_settings set hosts_enabled = false;
	perform pg_temp.s_same(pg_temp.s_rows('sites') #>> '{1,2}', 'https://sites.qorpera.com/count-shop/', 'hosts off');
	update public.qorpera_site_settings set enabled = false;
	perform pg_temp.s_same(pg_temp.s_rows('sites') #>> '{1,3}', 'false', 'sites off');
	update public.qorpera_site_settings set enabled = true, hosts_enabled = true;

	-- site-now: one row a site; here now is the sessions with a view in the last 5 minutes (1 and 2 on count-shop's old
	-- host, 3 on its own; 4 on count-blog's); today's views and visits are the company's day's.
	v := pg_temp.s_owner('site-now');
	perform pg_temp.s_json(v -> 'columns', '["site","here_now","views_today","visits_today"]', 'site-now''s columns');
	perform pg_temp.s_same(jsonb_array_length(v -> 'rows')::text, '3', 'a row a site');
	perform pg_temp.s_json(v -> 'rows' -> 2, '["count-wait",0,0,0]', 'a site not live yet');
	perform pg_temp.s_same((v -> 'rows' -> 1 ->> 0) || ' ' || (v -> 'rows' -> 1 ->> 1), 'count-shop 3', 'count-shop here now');
	perform pg_temp.s_same((v -> 'rows' -> 1 ->> 2) || '/' || (v -> 'rows' -> 1 ->> 3),
		(select sum(views) || '/' || sum(visits) from public.qorpera_site_counts
			where site_id = '12660000-0000-4000-8000-000000000100'
				and (hour at time zone 'Europe/Copenhagen')::date = v_today), 'count-shop today');
	perform pg_temp.s_json(pg_temp.s_rows('site-now', '{"site":"count-blog"}'),
		(select jsonb_build_array(jsonb_build_array('count-blog', 1, sum(views), sum(visits)))
			from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000200'
				and (hour at time zone 'Europe/Copenhagen')::date = v_today), 'count-blog alone');
	-- A view more than 5 minutes ago is not here now.
	update public.qorpera_site_session_seen set last_view_at = clock_timestamp() - interval '301 seconds'
	where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(4));
	perform pg_temp.s_same(pg_temp.s_rows('site-now', '{"site":"count-blog"}') #>> '{0,1}', '0', 'not here now');
	update public.qorpera_site_session_seen set last_view_at = clock_timestamp() - interval '299 seconds'
	where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(4));
	perform pg_temp.s_same(pg_temp.s_rows('site-now', '{"site":"count-blog"}') #>> '{0,1}', '1', 'still here now');
	-- :site names one of the company's files sites.
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"site":"other-shop"}'),
		'22023 :site is not one of the company''s sites', 'another company''s site');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"site":"count-app"}'),
		'22023 :site is not one of the company''s sites', 'an app link');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"site":7}'), '22023 :site is a site''s name', 'a number');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"site":null}'), 'ok', 'null is no :site');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"from":"2026-01-01"}'), '22023 The question takes no :from',
		'site-now takes no :from');

	-- site-hours: by default the 48 hours to this one, zeros included; hour in UTC, hour_local the company's.
	v := pg_temp.s_owner('site-hours', '{"site":"count-blog"}');
	perform pg_temp.s_json(v -> 'columns', '["site","hour","hour_local","views","visits"]', 'site-hours'' columns');
	v_rows := v -> 'rows';
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text, '48', '48 hours');
	perform pg_temp.s_json(v_rows -> 0, jsonb_build_array('count-blog', pg_temp.s_iso(pg_temp.s_hour() - interval '47 hours'),
		to_char((pg_temp.s_hour() - interval '47 hours') at time zone 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI'), 1, 1),
		'the first hour');
	perform pg_temp.s_json(v_rows -> 46, jsonb_build_array('count-blog', pg_temp.s_iso(pg_temp.s_hour() - interval '1 hour'),
		to_char((pg_temp.s_hour() - interval '1 hour') at time zone 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI'), 6, 2),
		'the hour before, both pages');
	perform pg_temp.s_json(v_rows -> 47 -> 1, to_jsonb(pg_temp.s_iso(pg_temp.s_hour())), 'this hour last');
	perform pg_temp.s_json(v_rows -> 47 -> 3, '4', 'this hour''s views');
	perform pg_temp.s_json(v_rows -> 20, jsonb_build_array('count-blog', pg_temp.s_iso(pg_temp.s_hour() - interval '27 hours'),
		to_char((pg_temp.s_hour() - interval '27 hours') at time zone 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI'), 0, 0),
		'an hour with no views');
	perform pg_temp.s_same(pg_temp.s_rows('site-hours') -> 0 ->> 0 || ' ' || jsonb_array_length(pg_temp.s_rows('site-hours')),
		'count-blog 144', 'every site''s hours, by name');
	-- From and to: a time with its zone, in its hour; a day, the company's first or last hour; from alone, at most 7
	-- days and never past this hour.
	v_rows := pg_temp.s_rows('site-hours', jsonb_build_object('site', 'count-blog',
		'from', to_char((pg_temp.s_hour() - interval '48 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:"25:07.5Z"'),
		'to', to_char((pg_temp.s_hour() - interval '47 hours') at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI"+05:30"')));
	perform pg_temp.s_same(v_rows::text, jsonb_build_array(
		jsonb_build_array('count-blog', pg_temp.s_iso(pg_temp.s_hour() - interval '48 hours'),
			to_char((pg_temp.s_hour() - interval '48 hours') at time zone 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI'), 9, 9),
		jsonb_build_array('count-blog', pg_temp.s_iso(pg_temp.s_hour() - interval '47 hours'),
			to_char((pg_temp.s_hour() - interval '47 hours') at time zone 'Europe/Copenhagen', 'YYYY-MM-DD"T"HH24:MI'), 1, 1))::text,
		'two hours named by times');
	v_rows := pg_temp.s_rows('site-hours', jsonb_build_object('site', 'count-blog', 'from', to_char(v_today - 1, 'YYYY-MM-DD'),
		'to', to_char(v_today - 1, 'YYYY-MM-DD')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text || ' ' || (v_rows -> 0 ->> 2) || ' ' || (v_rows -> -1 ->> 2),
		(extract(epoch from (v_today::timestamp at time zone 'Europe/Copenhagen')
			- ((v_today - 1)::timestamp at time zone 'Europe/Copenhagen')) / 3600)::integer || ' ' || to_char(v_today - 1, 'YYYY-MM-DD') || 'T00:00 '
			|| to_char(v_today - 1, 'YYYY-MM-DD') || 'T23:00', 'yesterday, the company''s day');
	v_rows := pg_temp.s_rows('site-hours', jsonb_build_object('site', 'count-blog', 'from', pg_temp.s_iso(pg_temp.s_hour()
		- interval '3 hours')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text || ' ' || (v_rows -> -1 ->> 1), '4 ' || pg_temp.s_iso(pg_temp.s_hour()),
		'from alone ends at this hour');
	v_rows := pg_temp.s_rows('site-hours', jsonb_build_object('site', 'count-blog', 'from', pg_temp.s_iso(pg_temp.s_hour()
		- interval '30 days')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text, '168', 'from alone: at most 7 days');
	v_rows := pg_temp.s_rows('site-hours', jsonb_build_object('site', 'count-blog', 'to', pg_temp.s_iso(pg_temp.s_hour()
		+ interval '5 hours')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text || ' ' || (v_rows -> -1 ->> 3), '48 0', 'to alone, ahead: 48 hours');
	perform pg_temp.s_same(pg_temp.s_refused('site-hours', jsonb_build_object('from', pg_temp.s_iso(pg_temp.s_hour()),
		'to', pg_temp.s_iso(pg_temp.s_hour() - interval '1 hour'))), '22023 :from is after :to', 'from after to');
	perform pg_temp.s_same(pg_temp.s_refused('site-hours', jsonb_build_object('from', pg_temp.s_iso(pg_temp.s_hour()
		- interval '168 hours'), 'to', pg_temp.s_iso(pg_temp.s_hour()))), '22023 From :from to :to is at most 7 days',
		'169 hours');
	perform pg_temp.s_same(pg_temp.s_refused('site-hours', jsonb_build_object('from', pg_temp.s_iso(pg_temp.s_hour()
		- interval '167 hours'), 'to', pg_temp.s_iso(pg_temp.s_hour()))), 'ok', '168 hours');
	foreach v_want in array array['2026-11-14T08:00', '2026-11-14 08:00Z', '2026-11-14T8:00Z', '2026-13-14T08:00Z',
		'2026-11-31', 'yesterday', '2026-11-14T08Z', '2026-11-14T25:00Z'] loop
		perform pg_temp.s_same(pg_temp.s_refused('site-hours', jsonb_build_object('from', v_want)),
			'22023 :from is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', 'the time ' || v_want);
	end loop;
	perform pg_temp.s_same(pg_temp.s_refused('site-hours', '{"to":1700000000}'),
		'22023 :to is a day as YYYY-MM-DD or a time as YYYY-MM-DDTHH:MMZ', 'a number');
	perform pg_temp.s_same(pg_temp.s_refused('site-hours', '{"limit":5}'), '22023 The question takes no :limit',
		'site-hours takes no :limit');

	-- site-days: by default the 30 days to today, zeros included.
	v := pg_temp.s_owner('site-days', '{"site":"count-blog"}');
	perform pg_temp.s_json(v -> 'columns', '["site","day","views","visits"]', 'site-days'' columns');
	v_rows := v -> 'rows';
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text || ' ' || (v_rows -> 0 ->> 1) || ' ' || (v_rows -> 29 ->> 1),
		'30 ' || to_char(v_today - 29, 'YYYY-MM-DD') || ' ' || to_char(v_today, 'YYYY-MM-DD'), 'the 30 days to today');
	perform pg_temp.s_same((select sum((row ->> 2)::integer) || '/' || sum((row ->> 3)::integer)
		from jsonb_array_elements(v_rows) row), (select sum(views) || '/' || sum(visits) from public.qorpera_site_counts
			where site_id = '12660000-0000-4000-8000-000000000200'
				and (hour at time zone 'Europe/Copenhagen')::date between v_today - 29 and v_today), 'the 30 days'' sums');
	perform pg_temp.s_json((select jsonb_agg(row ->> 2 order by row ->> 1) from jsonb_array_elements(v_rows) row
		where row ->> 1 = to_char(((pg_temp.s_hour() - interval '10 days') at time zone 'Europe/Copenhagen')::date,
			'YYYY-MM-DD')), '["5"]', 'ten days ago');
	perform pg_temp.s_same(jsonb_array_length(pg_temp.s_rows('site-days'))::text, '90', 'every site''s 30 days');
	v_rows := pg_temp.s_rows('site-days', jsonb_build_object('site', 'count-blog', 'from', to_char(v_today - 40, 'YYYY-MM-DD')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text || ' ' || (v_rows -> -1 ->> 1),
		'41 ' || to_char(v_today, 'YYYY-MM-DD'), 'from alone ends today');
	perform pg_temp.s_same((select sum((row ->> 2)::integer)::text from jsonb_array_elements(v_rows) row),
		(select sum(views)::text from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000200'),
		'every hour of count-blog, the 36 days old one too');
	v_rows := pg_temp.s_rows('site-days', jsonb_build_object('site', 'count-blog', 'from', to_char(v_today - 1000, 'YYYY-MM-DD')));
	perform pg_temp.s_same(jsonb_array_length(v_rows)::text, '400', 'from alone: at most 400 days');
	perform pg_temp.s_same(pg_temp.s_refused('site-days', jsonb_build_object('from', to_char(v_today - 400, 'YYYY-MM-DD'),
		'to', to_char(v_today, 'YYYY-MM-DD'))), '22023 From :from to :to is at most 400 days', '401 days');
	perform pg_temp.s_same(pg_temp.s_refused('site-days', jsonb_build_object('from', to_char(v_today - 399, 'YYYY-MM-DD'),
		'to', to_char(v_today, 'YYYY-MM-DD'))), 'ok', '400 days');
	perform pg_temp.s_same(pg_temp.s_refused('site-days', jsonb_build_object('from', to_char(v_today, 'YYYY-MM-DD'),
		'to', to_char(v_today - 1, 'YYYY-MM-DD'))), '22023 :from is after :to', 'from after to');
	perform pg_temp.s_same(pg_temp.s_refused('site-days', '{"from":"2026-02-30"}'), '22023 :from is a day as YYYY-MM-DD',
		'no such day');
	perform pg_temp.s_same(pg_temp.s_refused('site-days', '{"to":"2026-11-14T08:00Z"}'), '22023 :to is a day as YYYY-MM-DD',
		'a time is no day');

	-- site-pages: the most viewed paths a site, visits that began there; limit 10 by default, 1 to 50.
	v := pg_temp.s_owner('site-pages', jsonb_build_object('site', 'count-shop'));
	perform pg_temp.s_json(v -> 'columns', '["site","path","views","visits"]', 'site-pages'' columns');
	perform pg_temp.s_json(v -> 'rows', (select jsonb_agg(jsonb_build_array('count-shop', path, views, visits)
			order by views desc, visits desc, path collate "C")
		from (select path, sum(views) as views, sum(visits) as visits from public.qorpera_site_counts
			where site_id = '12660000-0000-4000-8000-000000000100'
				and (hour at time zone 'Europe/Copenhagen')::date between v_today - 29 and v_today group by path) p),
		'count-shop''s pages');
	perform pg_temp.s_same(v #>> '{rows,0,1}', 'index.html', 'the most viewed first');
	perform pg_temp.s_json(pg_temp.s_rows('site-pages', jsonb_build_object('site', 'count-blog', 'limit', 1,
		'from', to_char(v_today - 40, 'YYYY-MM-DD'))), '[["count-blog","index.html",23,19]]', 'limit 1, 41 days');
	perform pg_temp.s_json(pg_temp.s_rows('site-pages', jsonb_build_object('site', 'count-blog', 'limit', '2',
		'from', to_char(v_today - 40, 'YYYY-MM-DD'))), '[["count-blog","index.html",23,19],["count-blog","oldest.html",11,11]]',
		'limit as text');
	perform pg_temp.s_same((select string_agg(row ->> 0, ',') from jsonb_array_elements(pg_temp.s_rows('site-pages',
		'{"limit":1}')) row), 'count-blog,count-shop', 'every site''s top page, a site with no views has none');
	perform pg_temp.s_same(jsonb_array_length(pg_temp.s_rows('site-pages', jsonb_build_object('site', 'count-shop')))::text,
		'3', 'every page of count-shop, ten at most');
	foreach v_want in array array['0', '51', '1.5', '-1', '"x"', 'true', '"07a"'] loop
		perform pg_temp.s_same(pg_temp.s_refused('site-pages', ('{"limit":' || v_want || '}')::jsonb),
			'22023 :limit is a whole number from 1 to 50', 'the limit ' || v_want);
	end loop;
	perform pg_temp.s_same(pg_temp.s_refused('site-pages', '{"limit":50}'), 'ok', 'limit 50');
	perform pg_temp.s_same(pg_temp.s_refused('site-pages', '{"page":"index.html"}'), '22023 The question takes no :page',
		'site-pages takes no :page');
end $$;

-- 6. The upkeep: hours into days, once; hour rows older than 35 days go (after they are added), seen rows an hour after
--    the last view. The day questions answer the same before and after.
do $$
declare v_today date := pg_temp.s_today(); v_days_before jsonb; v_pages_before jsonb; v jsonb; v_until timestamptz;
	v_range jsonb := jsonb_build_object('from', to_char(pg_temp.s_today() - 45, 'YYYY-MM-DD')); v_want text;
begin
	v_days_before := pg_temp.s_rows('site-days', v_range);
	v_pages_before := pg_temp.s_rows('site-pages', v_range || '{"limit":50}');
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_count_days), '0', 'no days yet');
	v_until := date_trunc('hour', clock_timestamp() - interval '5 minutes', 'UTC');
	-- Every hour to be added, by its day in Copenhagen's zone (the company has none).
	select string_agg(day || ' ' || path || ' ' || views || '/' || visits, ',' order by day, path collate "C") into v_want
	from (select (hour at time zone 'Europe/Copenhagen')::date as day, path, sum(views) as views, sum(visits) as visits
		from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000200' and hour < v_until
		group by 1, 2) h;
	-- Session 1's last view more than an hour ago, session 2's just less.
	update public.qorpera_site_session_seen set last_view_at = clock_timestamp() - interval '61 minutes'
	where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(1));
	update public.qorpera_site_session_seen set last_view_at = clock_timestamp() - interval '59 minutes'
	where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(2));
	v := public.qorpera_site_count_upkeep();
	perform pg_temp.s_same(v ->> 'stopped', 'done', 'the upkeep ran');
	perform pg_temp.s_same((select (rolled_until = v_until and stopped = 'done' and ran_at is not null)::text
		from public.qorpera_site_count_upkeep), 'true', 'every hour that ended 5 minutes ago is added');
	perform pg_temp.s_same((select string_agg(day || ' ' || path || ' ' || views || '/' || visits, ','
			order by day, path collate "C")
		from public.qorpera_site_count_days where site_id = '12660000-0000-4000-8000-000000000200'), v_want,
		'count-blog''s days');
	-- Hours older than 35 days went; the rest stay for 35 days.
	perform pg_temp.s_same((select string_agg(path, ',' order by path) from public.qorpera_site_counts
		where site_id = '12660000-0000-4000-8000-000000000200' and hour < clock_timestamp() - interval '30 days'), 'old.html',
		'the 36 days old hour went, the 34 days old one stays');
	perform pg_temp.s_same((v ->> 'hoursDeleted') || ' ' || (v ->> 'seenDeleted'), '1 3',
		'one hour row, and the seen rows of sessions 1, 8 and 9');
	perform pg_temp.s_same((select string_agg(right(token_sha256, 4), ',' order by token_sha256)
		from public.qorpera_site_session_seen where token_sha256 in (public.qorpera_site_sha256(pg_temp.s_token(1)),
			public.qorpera_site_sha256(pg_temp.s_token(2)))), right(public.qorpera_site_sha256(pg_temp.s_token(2)), 4),
		'session 2 is still seen, session 1 is not');
	-- The day questions answer as before.
	perform pg_temp.s_json(pg_temp.s_rows('site-days', v_range), v_days_before, 'site-days after the upkeep');
	perform pg_temp.s_json(pg_temp.s_rows('site-pages', v_range || '{"limit":50}'), v_pages_before,
		'site-pages after the upkeep');
	-- Again: nothing is added twice.
	perform pg_temp.s_same((public.qorpera_site_count_upkeep() ->> 'days'), '0', 'a second run adds nothing');
	perform pg_temp.s_json(pg_temp.s_rows('site-days', v_range), v_days_before, 'site-days after a second run');
end $$;

-- An hour later the next hour is added, and still answered once.
savepoint s_later;
do $$
declare v_range jsonb := jsonb_build_object('from', to_char(pg_temp.s_today() - 45, 'YYYY-MM-DD')); v_before jsonb;
	v_from timestamptz := (select rolled_until from public.qorpera_site_count_upkeep);
begin
	v_before := pg_temp.s_rows('site-days', v_range);
	perform public.qorpera_site_count_upkeep(clock_timestamp() + interval '1 hour');
	perform pg_temp.s_same((select (rolled_until = v_from + interval '1 hour')::text from public.qorpera_site_count_upkeep),
		'true', 'the next hour added');
	perform pg_temp.s_json(pg_temp.s_rows('site-days', v_range), v_before, 'site-days an hour later');
end $$;
rollback to savepoint s_later;

-- 40 days on, every hour row is gone, each added to its day first, and every seen row; the days stay.
savepoint s_ahead;
do $$
declare v_total text := (select sum(views)::text from (select views from public.qorpera_site_counts
		where hour >= (select rolled_until from public.qorpera_site_count_upkeep)
		union all select views from public.qorpera_site_count_days) c);
begin
	perform pg_temp.s_same((public.qorpera_site_count_upkeep(clock_timestamp() + interval '40 days') ->> 'stopped'), 'done',
		'a run 40 days on');
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_counts), '0', 'every hour went, once added');
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_session_seen), '0', 'every seen row went');
	perform pg_temp.s_same((select sum(views)::text from public.qorpera_site_count_days), v_total, 'every view is in a day');
end $$;
rollback to savepoint s_ahead;

-- The company's own zone: Kiritimati (UTC+14) puts an hour at 12:00 UTC on the next day; the hours are added in it.
savepoint s_zone;
do $$
declare v_at timestamptz := date_trunc('day', clock_timestamp() - interval '3 days', 'UTC') + interval '12 hours';
begin
	update public.qorpera_profiles set time_zone = 'Pacific/Kiritimati' where id = '92400000-0000-4000-8000-000000000010';
	update public.qorpera_site_count_upkeep set rolled_until = v_at;
	insert into public.qorpera_site_counts(site_id, hour, path, views, visits)
	values ('12660000-0000-4000-8000-000000000300', v_at, 'zone.html', 2, 1);
	-- Before the upkeep, from the hours, on the zone's day.
	perform pg_temp.s_same((select string_agg(row ->> 1 || '=' || (row ->> 2), ',') from jsonb_array_elements(pg_temp.s_rows(
		'site-days', '{"site":"count-wait"}')) row where (row ->> 2)::integer > 0),
		to_char((v_at at time zone 'UTC')::date + 1, 'YYYY-MM-DD') || '=2', 'the zone''s day, from the hours');
	perform public.qorpera_site_count_upkeep();
	perform pg_temp.s_same((select day::text || ' ' || views from public.qorpera_site_count_days
		where site_id = '12660000-0000-4000-8000-000000000300'),
		((v_at at time zone 'UTC')::date + 1)::text || ' 2', 'added on the zone''s day');
	perform pg_temp.s_same((select string_agg(row ->> 1 || '=' || (row ->> 2), ',') from jsonb_array_elements(pg_temp.s_rows(
		'site-days', '{"site":"count-wait"}')) row where (row ->> 2)::integer > 0),
		to_char((v_at at time zone 'UTC')::date + 1, 'YYYY-MM-DD') || '=2', 'the zone''s day, from the days');
	-- Hours are told in the zone; today is the zone's.
	perform pg_temp.s_same(pg_temp.s_rows('site-hours', '{"site":"count-wait"}') #>> '{47,2}',
		to_char(pg_temp.s_hour() at time zone 'Pacific/Kiritimati', 'YYYY-MM-DD"T"HH24:MI'), 'this hour in the zone');
	perform pg_temp.s_same(pg_temp.s_rows('site-days', '{"site":"count-wait"}') #>> '{29,1}',
		to_char((clock_timestamp() at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM-DD'), 'the zone''s today');
	-- A zone the database does not know: Copenhagen's.
	update public.qorpera_profiles set time_zone = 'Mars/Olympus_Mons' where id = '92400000-0000-4000-8000-000000000010';
	perform pg_temp.s_same(public.qorpera_company_numbers_zone('92400000-0000-4000-8000-000000000010'), 'Europe/Copenhagen',
		'an unknown zone');
end $$;
rollback to savepoint s_zone;

-- 7. The schedule. pg_cron is not part of the test database: a stand-in with its schedule-by-name contract shows one job,
--    hourly at minute 9, whose command runs the upkeep.
savepoint s_cron;
do $$
declare v_first jsonb; v_second jsonb; v_command text;
begin
	if to_regnamespace('cron') is null then
		perform pg_temp.s_json(public.qorpera_schedule_site_count_upkeep(),
			'{"schema":"qorpera.site-count-upkeep-schedule/v1","scheduled":false}', 'a schedule without pg_cron');
		create schema cron;
		create table cron.job(jobid bigint generated always as identity primary key, schedule text not null,
			command text not null, jobname text not null, username text not null default current_user,
			unique (jobname, username));
		create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
			insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command)
			on conflict (jobname, username) do update set schedule = excluded.schedule, command = excluded.command
			returning jobid
		$f$;
	end if;
	v_first := public.qorpera_schedule_site_count_upkeep();
	v_second := public.qorpera_schedule_site_count_upkeep();
	perform pg_temp.s_same((v_first ->> 'scheduled') || ' ' || (v_second -> 'job' = v_first -> 'job')::text, 'true true',
		'scheduled, once');
	perform pg_temp.s_same((select count(*) || ' ' || min(schedule) || ' ' || min(command) from cron.job
		where jobname = 'qorpera-site-counts'), '1 9 * * * * select public.qorpera_site_count_upkeep()', 'the job');
	select command into v_command from cron.job where jobname = 'qorpera-site-counts';
	execute v_command;
end $$;
rollback to savepoint s_cron;

-- 8. Rights: any member (a viewer too) and a run of the company; never an outsider or another company's member; a run
--    asks its own company only. Another company's member sees its own sites only.
do $$
declare v_member jsonb; v_run jsonb;
begin
	v_member := pg_temp.s_owner('site-days', '{"site":"count-shop"}');
	v_run := pg_temp.s_run('site-days', '{"site":"count-shop"}');
	perform pg_temp.s_json(v_run - 'asOf', v_member - 'asOf', 'a run''s answer is a member''s, its etag too');
	perform pg_temp.s_json(pg_temp.s_member('92400000-0000-4000-8000-000000000003', 'sites') -> 'rows',
		pg_temp.s_rows('sites'), 'a viewer');
	perform pg_temp.s_json(pg_temp.s_member('92400000-0000-4000-8000-000000000002', 'site-now') -> 'rows',
		pg_temp.s_rows('site-now'), 'a contributor');
	perform pg_temp.s_same(pg_temp.s_refused('sites', '{}', '92400000-0000-4000-8000-000000000005'),
		'42501 Company numbers are unavailable', 'an outsider');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{}', '12660000-0000-4000-8000-000000000006'),
		'42501 Company numbers are unavailable', 'another company''s member');
	perform pg_temp.s_json(pg_temp.s_member('12660000-0000-4000-8000-000000000006', 'site-now', '{}',
		'12660000-0000-4000-8000-000000000020') -> 'rows', '[["other-shop",1,1,1]]', 'the other company sees its own');
	perform pg_temp.s_same(pg_temp.s_refused('site-now', '{"site":"count-shop"}', '12660000-0000-4000-8000-000000000006',
		'12660000-0000-4000-8000-000000000020'), '22023 :site is not one of the company''s sites', 'nor names ours');
	perform pg_temp.s_same(left(pg_temp.s_state($s$select pg_temp.s_run('sites', '{}',
		'12660000-0000-4000-8000-000000000020')$s$), 5), '42501', 'a run asking another company''s sites');
	perform pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.s_same(pg_temp.s_state(format('select public.qorpera_run_company_numbers(%L, %L::jsonb, %L)',
		'92400000-0000-4000-8000-000000000020', pg_temp.s_actor(), 'sites')), '42501 Folder core authority is required',
		'a member''s token on the run''s door');
	perform pg_temp.base_claims('service_role');
end $$;

-- 9. An answer is at most 2000 rows: seven sites' 400 days are cut, with more.
savepoint s_more;
do $$
declare i integer; v jsonb;
begin
	for i in 1..4 loop
		perform pg_temp.s_site(('12660000-0000-4000-8000-00000000060' || i)::uuid, '92400000-0000-4000-8000-000000000010',
			'92400000-0000-4000-8000-000000000020', 'count-more-' || i, null, null, '{}');
	end loop;
	v := pg_temp.s_owner('site-days', jsonb_build_object('from', to_char(pg_temp.s_today() - 399, 'YYYY-MM-DD')));
	perform pg_temp.s_same(jsonb_array_length(v -> 'rows') || ' ' || (v ->> 'more') || ' ' || (v #>> '{rows,1999,0}'),
		'2000 true count-more-4', 'cut at 2000');
	v := pg_temp.s_owner('site-days', jsonb_build_object('from', to_char(pg_temp.s_today() - 199, 'YYYY-MM-DD')));
	perform pg_temp.s_same(jsonb_array_length(v -> 'rows') || ' ' || (v ->> 'more'), '1400 false', 'seven sites'' 200 days');
end $$;
rollback to savepoint s_more;

-- 10. A site's rows go with it; a session's last view with the session.
savepoint s_gone;
do $$
begin
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(3))), '1', 'session 3 is seen');
	delete from public.qorpera_company_site_sessions where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(3));
	perform pg_temp.s_same((select count(*)::text from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(pg_temp.s_token(3))), '0', 'gone with the session');
	insert into public.qorpera_site_count_days(site_id, day, path, views, visits)
	values ('12660000-0000-4000-8000-000000000100', pg_temp.s_today() - 100, 'index.html', 1, 1);
	delete from public.qorpera_company_sites where id = '12660000-0000-4000-8000-000000000100';
	perform pg_temp.s_same((select count(*) from public.qorpera_site_counts where site_id = '12660000-0000-4000-8000-000000000100')
		|| ' ' || (select count(*) from public.qorpera_site_count_days where site_id = '12660000-0000-4000-8000-000000000100')
		|| ' ' || (select count(*) from public.qorpera_site_session_seen where site_id = '12660000-0000-4000-8000-000000000100'),
		'0 0 0', 'gone with the site');
	perform pg_temp.s_same((select string_agg(row ->> 0, ',') from jsonb_array_elements(pg_temp.s_rows('sites')) row),
		'count-blog,count-wait', 'and from the questions');
end $$;
rollback to savepoint s_gone;

rollback;
