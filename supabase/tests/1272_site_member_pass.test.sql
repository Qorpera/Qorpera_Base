-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member sees the company's own website inside Qorpera (company views step 4, slice V1, 20260930774000) on 924's
-- company: qorpera_site_member_pass gives a member a one-use pass of 60 seconds for the site's own host, and site-serve
-- redeems it with qorpera_site_member_pass_redeem for a member's session, which is never counted as a view. Checked
-- here: the grants, the table (closed, the pass kept as its SHA-256 only); who gets a pass (every member of the site's
-- company; never an outsider, another company's member, an app link, an anonymous or a service caller) and when (not
-- while hosts are off, not for a site taken down or not live); the answer's shape and its 60 seconds; one use; expiry;
-- the host it is bound to (another site's host, the next host, a host it was not made for, another site's pass);
-- refused once the site is taken down, not live, hosts off, or the member has left; the session it opens (a member's,
-- 12 hours, of the current password, it serves the site) and that it is not counted while a visitor's is; at most 30
-- open passes a member and 50 members' sessions a site; the count's patch keeps its markers and its lock timeout.

create function pg_temp.p_same(p_got text, p_want text, p_what text) returns void language plpgsql as $$
begin
	if p_got is distinct from p_want then raise exception '%: got %, want %', p_what, p_got, p_want; end if;
end $$;
-- A member's ask, as their token makes it; the claims are the service role's again afterwards.
create function pg_temp.p_pass(p_user uuid, p_site uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	v := public.qorpera_site_member_pass(p_site);
	perform pg_temp.base_claims('service_role');
	return v;
end $$;
-- The same ask by p_role's claims: 'ok' or the refusal.
create function pg_temp.p_refused(p_user uuid, p_site uuid, p_role text default 'authenticated') returns text
language plpgsql as $$
begin
	perform pg_temp.base_claims(p_role, p_user);
	perform public.qorpera_site_member_pass(p_site);
	perform pg_temp.base_claims('service_role');
	return 'ok';
exception when others then
	perform pg_temp.base_claims('service_role');
	return sqlstate || ' ' || sqlerrm;
end $$;
create function pg_temp.p_redeem(p_host text, p_pass text) returns jsonb language sql as $$
	select public.qorpera_site_member_pass_redeem(p_host, p_pass)
$$;
create function pg_temp.p_state(p_answer jsonb) returns text language sql immutable as $$
	select p_answer ->> 'state'
$$;
-- A pass of the owner's for p_site, open.
create function pg_temp.p_open(p_site uuid, p_user uuid default '92400000-0000-4000-8000-000000000001') returns text
language plpgsql as $$
declare v jsonb := pg_temp.p_pass(p_user, p_site);
begin
	perform pg_temp.p_same(v ->> 'state', 'open', 'a pass for ' || p_site);
	return v ->> 'pass';
end $$;
-- A live files site of p_profile, version p_version (null: never live), with index.html and about/index.html.
create function pg_temp.p_site(p_id uuid, p_profile uuid, p_environment uuid, p_slug text, p_version uuid)
returns void language plpgsql as $$
begin
	insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id)
	values (p_id, p_profile, p_environment, p_slug, p_slug, 'web', '92400000-0000-4000-8000-000000000030');
	insert into public.qorpera_company_site_secrets(site_id, password) values (p_id, p_slug || '-password');
	if p_version is null then return; end if;
	insert into public.qorpera_company_site_versions(id, site_id, run_id, call_id, staff_agent_id, first_publish, source_path,
		manifest_sha256, file_count, total_bytes, state, published_at)
	values (p_version, p_id, (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, 'pass-' || p_slug,
		'92400000-0000-4000-8000-000000000030', true, 'web', repeat('a', 64), 2, 6, 'live', clock_timestamp());
	insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content)
	select p_version, path, 3, encode(extensions.digest('<p>', 'sha256'), 'hex'), 'text/html; charset=utf-8',
		convert_to('<p>', 'utf8')
	from unnest(array['index.html', 'about/index.html']) as path;
	update public.qorpera_company_sites set current_version_id = p_version, published_at = clock_timestamp(),
		published_by_staff_agent_id = '92400000-0000-4000-8000-000000000030'
	where id = p_id;
end $$;
create function pg_temp.p_counted(p_site uuid) returns text language sql as $$
	select coalesce(sum(views), 0)::text from public.qorpera_site_counts where site_id = p_site
$$;

-- Another company with its owner, a viewer and its own live site, and 924's sites: pass-shop and pass-blog (live), pass-wait (not
-- live yet) and pass-app (an app link). Sites and hosts are on.
insert into auth.users(id, email) values
	('12720000-0000-4000-8000-000000000006', 'site-pass-other@example.test'),
	('12720000-0000-4000-8000-000000000007', 'site-pass-other-viewer@example.test');
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('12720000-0000-4000-8000-000000000010', 'Site pass other', '12720000-0000-4000-8000-000000000006');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
	('12720000-0000-4000-8000-000000000010', '12720000-0000-4000-8000-000000000006', 'site-pass-other@example.test',
		'Other owner', 'owner'),
	('12720000-0000-4000-8000-000000000010', '12720000-0000-4000-8000-000000000007', 'site-pass-other-viewer@example.test',
		'Other viewer', 'viewer');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('12720000-0000-4000-8000-000000000020', '12720000-0000-4000-8000-000000000010', 'Environment', 1,
	'12720000-0000-4000-8000-000000000006');
select pg_temp.base_claims('service_role');
select public.qorpera_folder_enable('12720000-0000-4000-8000-000000000020') \g /dev/null

select pg_temp.p_site('12720000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'pass-shop', '12720000-0000-4000-8000-000000000101');
select pg_temp.p_site('12720000-0000-4000-8000-000000000200', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'pass-blog', '12720000-0000-4000-8000-000000000201');
select pg_temp.p_site('12720000-0000-4000-8000-000000000300', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'pass-wait', null);
insert into public.qorpera_company_sites(id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind,
	app_port)
values ('12720000-0000-4000-8000-000000000400', '92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020', 'pass-app', 'app', '92400000-0000-4000-8000-000000000030', 'app', 8080);
select pg_temp.p_site('12720000-0000-4000-8000-000000000500', '12720000-0000-4000-8000-000000000010',
	'12720000-0000-4000-8000-000000000020', 'pass-other', '12720000-0000-4000-8000-000000000501');
update public.qorpera_site_settings set enabled = true, hosts_domain = 'qorpera.com';
update public.qorpera_site_settings set hosts_enabled = true;

-- 1. The grants: the pass for members only (authenticated), the redeem for site-serve only (the service role), the
--    table closed with RLS on; the session's new column; the count's patch keeps its markers and its lock timeout.
do $$
declare v_role text;
begin
	if has_function_privilege('anon', 'public.qorpera_site_member_pass(uuid)', 'EXECUTE')
		or not has_function_privilege('authenticated', 'public.qorpera_site_member_pass(uuid)', 'EXECUTE')
		or has_function_privilege('service_role', 'public.qorpera_site_member_pass(uuid)', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_site_member_pass(uuid)', 'EXECUTE') then
		raise exception 'qorpera_site_member_pass has the wrong grants'; end if;
	if has_function_privilege('anon', 'public.qorpera_site_member_pass_redeem(text,text)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_site_member_pass_redeem(text,text)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_site_member_pass_redeem(text,text)', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_site_member_pass_redeem(text,text)', 'EXECUTE') then
		raise exception 'qorpera_site_member_pass_redeem has the wrong grants'; end if;
	if not (select relrowsecurity from pg_class where oid = 'public.qorpera_company_site_member_passes'::regclass) then
		raise exception 'the passes have no row level security'; end if;
	foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
		if has_table_privilege(v_role, 'public.qorpera_company_site_member_passes', 'SELECT')
			or has_table_privilege(v_role, 'public.qorpera_company_site_member_passes', 'INSERT')
			or has_table_privilege(v_role, 'public.qorpera_company_site_member_passes', 'UPDATE')
			or has_table_privilege(v_role, 'public.qorpera_company_site_member_passes', 'DELETE') then
			raise exception 'the passes are open to %', v_role; end if;
	end loop;
	perform pg_temp.p_same((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
		where table_schema = 'public' and table_name = 'qorpera_company_site_member_passes'),
		'pass_sha256,site_id,user_id,host,created_at,expires_at', 'the passes'' columns: never the pass itself');
	perform pg_temp.p_same((select string_agg(p.proname || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ','), ' '
			order by p.proname) from pg_proc as p where p.oid in ('public.qorpera_site_member_pass(uuid)'::regprocedure,
			'public.qorpera_site_member_pass_redeem(text,text)'::regprocedure)),
		'qorpera_site_member_pass:true:search_path="",lock_timeout=3s '
		'qorpera_site_member_pass_redeem:true:search_path=""', 'security definer, empty search path');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', null), '22023 A site is needed',
		'no site named');
end $$;

-- 2. Who gets a pass: every member of the site's company, viewers too; the answer's shape; only the SHA-256 is kept.
do $$
declare v jsonb; v_user uuid; v_at timestamptz;
begin
	foreach v_user in array array['92400000-0000-4000-8000-000000000001', '92400000-0000-4000-8000-000000000002',
		'92400000-0000-4000-8000-000000000003', '92400000-0000-4000-8000-000000000004']::uuid[] loop
		v_at := clock_timestamp();
		v := pg_temp.p_pass(v_user, '12720000-0000-4000-8000-000000000100');
		perform pg_temp.p_same((select string_agg(key, ',' order by key) from jsonb_object_keys(v) as key),
			'action,expiresAt,host,pass,schema,state', 'the answer''s keys');
		perform pg_temp.p_same(v ->> 'schema' || ' ' || (v ->> 'state') || ' ' || (v ->> 'host') || ' ' || (v ->> 'action'),
			'qorpera.site-member-pass/v1 open pass-shop.qorpera.com https://pass-shop.qorpera.com/__qorpera/member',
			'a pass for ' || v_user);
		perform pg_temp.p_same(((v ->> 'pass') ~ '^[A-Za-z0-9_-]{43}$')::text, 'true', 'the pass is 32 bytes of base64url');
		perform pg_temp.p_same(((v ->> 'expiresAt')::timestamptz between v_at + interval '59 seconds'
			and clock_timestamp() + interval '60 seconds')::text, 'true', 'good for 60 seconds');
		perform pg_temp.p_same((select pass.user_id || ' ' || pass.site_id || ' ' || pass.host || ' '
				|| (pass.expires_at - pass.created_at) || ' ' || (pass.expires_at = (v ->> 'expiresAt')::timestamptz)
			from public.qorpera_company_site_member_passes as pass
			where pass.pass_sha256 = public.qorpera_site_sha256(v ->> 'pass')),
			v_user || ' 12720000-0000-4000-8000-000000000100 pass-shop.qorpera.com 00:01:00 true', 'kept by its SHA-256');
	end loop;
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes as pass
		where pass.pass_sha256 !~ '^[0-9a-f]{64}$' or pass.host <> 'pass-shop.qorpera.com'), '0', 'no pass kept in plain');
	-- The other company's owner on its own site.
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('12720000-0000-4000-8000-000000000006',
		'12720000-0000-4000-8000-000000000500')), 'open', 'another company''s member on its own site');
end $$;

-- 3. Who never gets one: an outsider, another company's member, a member on another company's site, a site that is not
--    there or an app link (the same words); an anonymous or a service caller. Nothing is written for them.
do $$
declare v_count bigint := (select count(*) from public.qorpera_company_site_member_passes);
	c_refused constant text := '42501 Only the company''s members open its site here';
begin
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000005', '12720000-0000-4000-8000-000000000100'),
		c_refused, 'an outsider');
	perform pg_temp.p_same(pg_temp.p_refused('12720000-0000-4000-8000-000000000006', '12720000-0000-4000-8000-000000000100'),
		c_refused, 'another company''s member');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000500'),
		c_refused, 'a member on another company''s site');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000999'),
		c_refused, 'no such site');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000400'),
		c_refused, 'an app link');
	perform pg_temp.p_same(pg_temp.p_refused(null, '12720000-0000-4000-8000-000000000100', 'anon'), c_refused, 'anonymous');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000100',
		'service_role'), c_refused, 'the service role');
	perform pg_temp.p_same(pg_temp.p_refused(null, '12720000-0000-4000-8000-000000000100'), c_refused, 'a token with no user');
	perform pg_temp.p_same((select count(*) from public.qorpera_company_site_member_passes)::text, v_count::text,
		'nothing written');
end $$;

-- 4. When none is given: hosts off (sites off, or hosts_enabled off), a site taken down, a site not live yet, a company
--    being deleted. Nothing is written.
savepoint p_when;
do $$
declare v_count bigint := (select count(*) from public.qorpera_company_site_member_passes);
begin
	update public.qorpera_site_settings set hosts_enabled = false;
	perform pg_temp.p_same(pg_temp.p_pass('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000100')::text,
		'{"state": "off", "schema": "qorpera.site-member-pass/v1"}', 'hosts off');
	update public.qorpera_site_settings set hosts_enabled = true, enabled = false;
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000001',
		'12720000-0000-4000-8000-000000000100')), 'off', 'sites off');
	update public.qorpera_site_settings set enabled = true;
	update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'A test'
	where id = '12720000-0000-4000-8000-000000000100';
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000003',
		'12720000-0000-4000-8000-000000000100')), 'gone', 'taken down');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000001',
		'12720000-0000-4000-8000-000000000300')), 'none', 'not live yet');
	perform pg_temp.p_same((select count(*) from public.qorpera_company_site_member_passes)::text, v_count::text,
		'nothing written');
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.p_same(pg_temp.p_refused('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000200'),
		'42501 Only the company''s members open its site here', 'a company being deleted');
end $$;
rollback to savepoint p_when;

-- 5. Redeemed: a member's session of 12 hours, of the current password, that serves the site; one use.
do $$
declare v_pass text := pg_temp.p_open('12720000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000003');
	v jsonb; v_session public.qorpera_company_site_sessions%rowtype;
begin
	v := pg_temp.p_redeem('pass-shop.qorpera.com', v_pass);
	perform pg_temp.p_same((select string_agg(key, ',' order by key) from jsonb_object_keys(v) as key) || ' '
		|| (v ->> 'state') || ' ' || (v ->> 'maxAge') || ' ' || ((v ->> 'token') ~ '^[A-Za-z0-9_-]{32}$'),
		'maxAge,state,token open 43200 true', 'a session');
	select session.* into v_session from public.qorpera_company_site_sessions as session
	where session.token_sha256 = public.qorpera_site_sha256(v ->> 'token');
	perform pg_temp.p_same(v_session.scope || ' ' || v_session.member_user_id || ' ' || v_session.password_version || ' '
		|| (v_session.version_id is null) || ' '
		|| (v_session.expires_at between clock_timestamp() + interval '11 hours 59 minutes' and clock_timestamp() + interval '12 hours'),
		'site 92400000-0000-4000-8000-000000000003 1 true true', 'a member''s session, 12 hours, the current password''s');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes
		where pass_sha256 = public.qorpera_site_sha256(v_pass)), '0', 'the pass is gone');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused', 'one use');
	-- The session opens the site on its own host.
	perform pg_temp.p_same(public.qorpera_site_serve_host('pass-shop.qorpera.com', '/', v ->> 'token', null, 0, 0) ->> 'state',
		'file', 'the member''s session serves the site');
	perform pg_temp.p_same(public.qorpera_site_serve_host('pass-blog.qorpera.com', '/', v ->> 'token', null, 0, 0) ->> 'state',
		'locked', 'and no other site');
	-- In any case, as the front may send it.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('Pass-Shop.Qorpera.COM', v_pass)), 'open', 'the host in any case');
end $$;

-- 6. Refused: a pass of the wrong shape, expired, at another site's host, at the next host, at a host it was not made
--    for, another site's pass, after a takedown, once not live, hosts off, a member who left, a company being deleted.
--    A refusal at the wrong place never spends the pass.
savepoint p_refused;
do $$
declare v_pass text; v_other text;
begin
	foreach v_pass in array array[null, '', 'short', repeat('a', 42), repeat('a', 44), repeat('a', 42) || '.',
		repeat('a', 42) || '='] loop
		perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused',
			'the shape ' || coalesce(v_pass, 'null'));
	end loop;
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem(null, pg_temp.p_open('12720000-0000-4000-8000-000000000100'))),
		'refused', 'no host');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', repeat('a', 43))), 'refused',
		'a pass never made');
	-- Expired: 60 seconds after it was made.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	update public.qorpera_company_site_member_passes set created_at = clock_timestamp() - interval '61 seconds',
		expires_at = clock_timestamp() - interval '1 second'
	where pass_sha256 = public.qorpera_site_sha256(v_pass);
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused', 'expired');
	-- The wrong hosts: another site's, the next host, a port, a dot, another domain. The pass still opens its own after.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	foreach v_other in array array['pass-blog.qorpera.com', 'pass-shop--next.qorpera.com', 'pass-shop.qorpera.com:443',
		'pass-shop.qorpera.com.', 'pass-shop.example.com', 'pass-other.qorpera.com', 'sites.qorpera.com'] loop
		perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem(v_other, v_pass)), 'refused', 'at ' || v_other);
	end loop;
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'open',
		'a refusal elsewhere did not spend it');
	-- Bound to its host: a pass made for another host (as if the site's name had changed) is refused at this one.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	update public.qorpera_company_site_member_passes set host = 'pass-old.qorpera.com'
	where pass_sha256 = public.qorpera_site_sha256(v_pass);
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused',
		'a pass made for another host');
	-- Bound to its site: pass-blog's pass is refused at pass-shop's host, even made for that host.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000200');
	update public.qorpera_company_site_member_passes set host = 'pass-shop.qorpera.com'
	where pass_sha256 = public.qorpera_site_sha256(v_pass);
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused',
		'another site''s pass');
	-- Own hosts only: a pass made for the next host is refused there.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	update public.qorpera_company_site_member_passes set host = 'pass-shop--next.qorpera.com'
	where pass_sha256 = public.qorpera_site_sha256(v_pass);
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop--next.qorpera.com', v_pass)), 'refused',
		'never on a next host');
end $$;
rollback to savepoint p_refused;

savepoint p_after;
do $$
declare v_pass text;
begin
	-- Taken down after the pass was made.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'A test'
	where id = '12720000-0000-4000-8000-000000000100';
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused', 'taken down');
	update public.qorpera_company_sites set taken_down_at = null, taken_down_reason = null
	where id = '12720000-0000-4000-8000-000000000100';
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'open',
		'restored, the pass was not spent');
	-- Hosts off after the pass was made.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	update public.qorpera_site_settings set hosts_enabled = false;
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused', 'hosts off');
	update public.qorpera_site_settings set hosts_enabled = true;
	-- Not live any more.
	update public.qorpera_company_sites set current_version_id = null where id = '12720000-0000-4000-8000-000000000100';
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused', 'not live');
	update public.qorpera_company_sites set current_version_id = '12720000-0000-4000-8000-000000000101'
	where id = '12720000-0000-4000-8000-000000000100';
	-- The member left the company (the other company's viewer, whom nothing else refers to).
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000500', '12720000-0000-4000-8000-000000000007');
	delete from public.qorpera_profile_members where profile_id = '12720000-0000-4000-8000-000000000010'
		and user_id = '12720000-0000-4000-8000-000000000007';
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-other.qorpera.com', v_pass)), 'refused',
		'a member who left');
	-- The company is being deleted.
	v_pass := pg_temp.p_open('12720000-0000-4000-8000-000000000100');
	insert into public.qorpera_company_deletions(profile_id, requested_by_user_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000001');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_redeem('pass-shop.qorpera.com', v_pass)), 'refused',
		'a company being deleted');
end $$;
rollback to savepoint p_after;

-- 7. Not counted: a member's session never counts a view, a visitor's of the same site does.
savepoint p_count;
do $$
declare v_member text; v_visitor text;
begin
	v_member := pg_temp.p_redeem('pass-shop.qorpera.com', pg_temp.p_open('12720000-0000-4000-8000-000000000100')) ->> 'token';
	perform pg_temp.p_same(public.qorpera_site_count_view('pass-shop.qorpera.com', '/', v_member) ->> 'state', 'skipped',
		'a member''s view');
	perform pg_temp.p_same(public.qorpera_site_count_view('pass-shop.qorpera.com', 'about/', v_member) ->> 'state', 'skipped',
		'a member''s second view');
	perform pg_temp.p_same(pg_temp.p_counted('12720000-0000-4000-8000-000000000100'), '0', 'nothing counted');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_site_session_seen
		where token_sha256 = public.qorpera_site_sha256(v_member)), '0', 'the member''s session is not seen');
	v_visitor := public.qorpera_site_unlock_host('pass-shop.qorpera.com', 'pass-shop-password', '192.0.2.1') ->> 'token';
	perform pg_temp.p_same(public.qorpera_site_count_view('pass-shop.qorpera.com', '/', v_visitor) ->> 'state', 'counted',
		'a visitor''s view');
	perform pg_temp.p_same(pg_temp.p_counted('12720000-0000-4000-8000-000000000100'), '1', 'the visitor''s view counted');
	perform pg_temp.p_same((select (member_user_id is null)::text from public.qorpera_company_site_sessions
		where token_sha256 = public.qorpera_site_sha256(v_visitor)), 'true', 'a visitor''s session is no member''s');
end $$;
rollback to savepoint p_count;

-- 8. At most 30 open passes a member (expired ones do not count, and another member's are their own); at most 50
--    members' sessions a site, the newest, and members' sessions that ended go; visitors' sessions are not touched.
savepoint p_bounds;
do $$
declare v jsonb; i integer;
begin
	-- No open pass from the sections before.
	delete from public.qorpera_company_site_member_passes;
	for i in 1..30 loop perform pg_temp.p_open('12720000-0000-4000-8000-000000000100'); end loop;
	v := pg_temp.p_pass('92400000-0000-4000-8000-000000000001', '12720000-0000-4000-8000-000000000200');
	perform pg_temp.p_same(v ->> 'schema' || ' ' || (v ->> 'state') || ' ' || ((v ->> 'retryAfter')::integer between 1 and 60)
		|| ' ' || (select string_agg(key, ',' order by key) from jsonb_object_keys(v) as key),
		'qorpera.site-member-pass/v1 limited true retryAfter,schema,state', 'the 31st open pass');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes
		where user_id = '92400000-0000-4000-8000-000000000001'), '30', 'no 31st written');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000004',
		'12720000-0000-4000-8000-000000000100')), 'open', 'another member''s own 30');
	-- One expires: room for one more, and the expired one goes.
	update public.qorpera_company_site_member_passes set created_at = clock_timestamp() - interval '2 minutes',
		expires_at = clock_timestamp() - interval '1 minute'
	where pass_sha256 = (select pass_sha256 from public.qorpera_company_site_member_passes
		where user_id = '92400000-0000-4000-8000-000000000001' limit 1);
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000001',
		'12720000-0000-4000-8000-000000000100')), 'open', 'an expired pass makes room');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes
		where user_id = '92400000-0000-4000-8000-000000000001'), '30', 'the expired pass went');
	perform pg_temp.p_same(pg_temp.p_state(pg_temp.p_pass('92400000-0000-4000-8000-000000000001',
		'12720000-0000-4000-8000-000000000100')), 'limited', 'and 30 again');
	delete from public.qorpera_company_site_member_passes;
	delete from public.qorpera_company_site_sessions where member_user_id is not null;
	-- 50 members' sessions a site: an ended one goes, the oldest past 50 go, visitors' stay.
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope, member_user_id,
		created_at)
	select public.qorpera_site_sha256('member-' || n), '12720000-0000-4000-8000-000000000100', 1,
		clock_timestamp() + case when n = 52 then interval '-1 minute' else interval '1 hour' end, 'site',
		'92400000-0000-4000-8000-000000000001', clock_timestamp() - interval '1 hour' + n * interval '1 second'
	from generate_series(1, 52) as n;
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope, created_at)
	select public.qorpera_site_sha256('visitor-' || n), '12720000-0000-4000-8000-000000000100', 1,
		clock_timestamp() + interval '1 hour', 'site', clock_timestamp() - interval '2 hours'
	from generate_series(1, 3) as n;
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope, member_user_id)
	values (public.qorpera_site_sha256('member-blog'), '12720000-0000-4000-8000-000000000200', 1,
		clock_timestamp() + interval '1 hour', 'site', '92400000-0000-4000-8000-000000000001');
	v := pg_temp.p_redeem('pass-shop.qorpera.com', pg_temp.p_open('12720000-0000-4000-8000-000000000100'));
	perform pg_temp.p_same(v ->> 'state', 'open', 'a 53rd member''s session');
	-- The newest one ended and goes; of the 51 left the newest 49 stay with the new one, the two oldest go.
	perform pg_temp.p_same((select count(*) || ' ' || bool_and(token_sha256 <> public.qorpera_site_sha256('member-52'))
			|| ' ' || bool_and(token_sha256 <> public.qorpera_site_sha256('member-1'))
			|| ' ' || bool_and(token_sha256 <> public.qorpera_site_sha256('member-2'))
			|| ' ' || bool_or(token_sha256 = public.qorpera_site_sha256('member-3'))
			|| ' ' || bool_or(token_sha256 = public.qorpera_site_sha256(v ->> 'token'))
		from public.qorpera_company_site_sessions
		where site_id = '12720000-0000-4000-8000-000000000100' and member_user_id is not null),
		'50 true true true true true', 'the newest 50 members'' sessions: the ended one and the oldest went');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_sessions
		where site_id = '12720000-0000-4000-8000-000000000100' and member_user_id is null), '3', 'visitors'' sessions stay');
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_sessions
		where token_sha256 = public.qorpera_site_sha256('member-blog')), '1', 'another site''s stay');
	-- A member's session is a site session only.
	begin
		insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope,
			version_id, member_user_id)
		values (public.qorpera_site_sha256('member-next'), '12720000-0000-4000-8000-000000000100', 1,
			clock_timestamp() + interval '1 hour', 'next', '12720000-0000-4000-8000-000000000101',
			'92400000-0000-4000-8000-000000000001');
		raise exception 'a member''s next session was stored';
	exception when check_violation then null;
	end;
	-- The site's expired passes go at a redeem.
	insert into public.qorpera_company_site_member_passes(pass_sha256, site_id, user_id, host, created_at, expires_at)
	values (repeat('b', 64), '12720000-0000-4000-8000-000000000100', '92400000-0000-4000-8000-000000000004',
		'pass-shop.qorpera.com', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute');
	perform pg_temp.p_redeem('pass-shop.qorpera.com', pg_temp.p_open('12720000-0000-4000-8000-000000000100'));
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes
		where pass_sha256 = repeat('b', 64)), '0', 'the site''s expired passes go');
end $$;
rollback to savepoint p_bounds;

-- 9. A pass goes with its site.
savepoint p_gone;
do $$
begin
	perform pg_temp.p_open('12720000-0000-4000-8000-000000000200');
	delete from public.qorpera_company_sites where id = '12720000-0000-4000-8000-000000000200';
	perform pg_temp.p_same((select count(*)::text from public.qorpera_company_site_member_passes
		where site_id = '12720000-0000-4000-8000-000000000200'), '0', 'gone with the site');
end $$;
rollback to savepoint p_gone;

rollback;
