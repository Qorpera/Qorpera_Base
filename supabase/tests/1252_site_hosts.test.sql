-- @fixture 1216_code_releases.test.sql until "-- 1. Rights, the columns, the marker"
-- Every company website gets an address of its own (migration 20260930756000): https://<slug>.qorpera.com/, Look first on
-- https://<slug>--next.qorpera.com/, an operator's takedown and drill. 1216's fixture (1211's and 1210's helpers before
-- it): company/<name> repositories, session copies that hand commits in, the executor's site upload, the member's read and
-- yes. This file's repositories are company/h-look (site look-shop: version 1 live, 2 ready with a 404.html, 3 landed),
-- company/h-wait (site wait-shop: version 1 ready, never live) and company/h-drill; its session copies are numbered from
-- 2520.
--   1. Rights, the columns and their rules, the markers.
--   2. The name rule: the reserved text, each refusal, the derived names, and the migration's guard on stored names.
--   3. A site host: the parse and the one regex, each shape (the next host, 48 characters, two hyphens, -next).
--   4. Hosts off (with no domain, and with the domain set): every existing call answers as before.
--   5. Hosts on: links, the list file's preparing, What's new's preview, the switch's rootLinks.
--   6. The old host: moved for every valid name, legacy for the rest.
--   7. The own host: none, locked, the password, files, a folder, missing, a company being deleted.
--   8. Look first: who may open it, moved, the ticket, enter (shape, host, use, expiry, member, version), the next host's
--      files and 404.html, the caps of 20, a version gone, a new password.
--   9. The old serve and unlock: a visitor's session only, and the cap of 2000 counts visitors' only.
--  10. Takedown: refusals, gone on every host, nothing goes live, the members' read, an app link, restore.
--  11. The drill: refusals, taken once, only while its switch is on, cleared.
--  12. Hosts off again: the way back.

select pg_temp.base_claims('service_role') \g /dev/null

-- site-serve's calls, as the function makes them: the service role.
create function pg_temp.sh_serve(p_host text, p_path text default '', p_token text default null, p_etag text default null,
	p_offset integer default 0, p_length integer default 10485760) returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_site_serve_host(%L, %L, %L, %L, %s, %s)', p_host, p_path, p_token, p_etag,
		p_offset, p_length))
$$;
create function pg_temp.sh_unlock(p_host text, p_password text, p_client text default '192.0.2.40') returns jsonb
language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_site_unlock_host(%L, %L, %L)', p_host, p_password, p_client))
$$;
create function pg_temp.sh_enter(p_host text, p_ticket text) returns jsonb language sql as $$
	select pg_temp.rel_exec(format('public.qorpera_site_enter(%L, %L)', p_host, p_ticket))
$$;
-- The members' calls, as the web makes them.
create function pg_temp.sh_open(p_name text, p_change integer, p_user uuid default pg_temp.req_owner()) returns jsonb
language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_open_site_preview(%L, %L, %L, %s)', pg_temp.rel_company(), 'company',
		p_name, p_change))
$$;
create function pg_temp.sh_access(p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_company_site_access(%L)', pg_temp.rel_company()))
$$;
create function pg_temp.sh_sites(p_user uuid default pg_temp.req_owner()) returns jsonb language sql as $$
	select pg_temp.req_as(p_user, format('public.qorpera_list_company_sites(%L)', pg_temp.rel_company()))
$$;
-- The operator's switch.
create function pg_temp.sh_hosts(p_domain text, p_on boolean) returns void language sql as $$
	update public.qorpera_site_settings set hosts_domain = p_domain, hosts_enabled = p_on
$$;
-- The switch, under session copy p_worker's lease.
create function pg_temp.sh_switch(p_worker uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	perform pg_temp.base_claims('service_role');
	set local role service_role;
	v := public.qorpera_code_checks_switch(p_worker, pg_temp.rec_token());
	reset role;
	return v;
end $$;
-- A ticket from an open answer's link; a file answer's text; a site's password; a token's digest.
create function pg_temp.sh_ticket(p_answer jsonb) returns text language sql immutable as $$
	select substring(p_answer ->> 'url' from '[?]t=([A-Za-z0-9_-]{43})$')
$$;
create function pg_temp.sh_text(p_answer jsonb) returns text language sql immutable as $$
	select convert_from(decode(p_answer ->> 'content', 'base64'), 'utf8')
$$;
create function pg_temp.sh_password(p_slug text) returns text language sql as $$
	select secret.password from public.qorpera_company_site_secrets secret
	join public.qorpera_company_sites site on site.id = secret.site_id where site.slug = p_slug
$$;
create function pg_temp.sh_sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
-- The sessions of site p_slug in scope p_scope.
create function pg_temp.sh_sessions(p_slug text, p_scope text) returns integer language sql as $$
	select count(*)::integer from public.qorpera_company_site_sessions session
	join public.qorpera_company_sites site on site.id = session.site_id where site.slug = p_slug and session.scope = p_scope
$$;
create function pg_temp.sh_site(p_slug text) returns public.qorpera_company_sites language sql as $$
	select * from public.qorpera_company_sites where slug = p_slug
$$;
-- company/h-look's files: version 1 with a folder of its own, version 2 with a 404.html.
create function pg_temp.sh_texts(p_n integer) returns jsonb language sql immutable as $$
	select pg_temp.rel_texts('h' || p_n) || case p_n when 1 then '{"docs/index.html":"<p>Docs</p>"}'::jsonb
		when 2 then '{"404.html":"<p>Not here</p>"}'::jsonb else '{}'::jsonb end
$$;
-- The reserved text, as the migration and the coding executor's RESERVED hold it.
create function pg_temp.sh_reserved() returns text language sql immutable as $$
	select 'api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta'::text
$$;

select pg_temp.rel_repository(name) from unnest(array['h-look', 'h-wait', 'h-drill']) name \g /dev/null

-- 1. Rights, the columns and their rules, the markers -----------------------------------------------------------------
do $$
declare v_role text; v_function text;
begin
	foreach v_role in array array['public', 'anon', 'authenticated', 'service_role', 'qorpera_secret_broker', 'qorpera_site_relay'] loop
		foreach v_function in array array['public.qorpera_site_serve_host(text,text,text,text,integer,integer)',
			'public.qorpera_site_unlock_host(text,text,text)', 'public.qorpera_site_enter(text,text)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'service_role'),
				v_function || ' is site-serve''s only: ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_open_site_preview(uuid,text,text,integer)',
			'public.qorpera_company_site_access(uuid)'] loop
			perform pg_temp.base_assert(has_function_privilege(v_role, v_function, 'EXECUTE') = (v_role = 'authenticated'),
				v_function || ' is the members'' only: ' || v_role);
		end loop;
		foreach v_function in array array['public.qorpera_site_take_down(text,text)', 'public.qorpera_site_restore(text)',
			'public.qorpera_code_set_drill(uuid,text,text,text)', 'public.qorpera_site_reserved_names()',
			'public.qorpera_site_hosts_on()', 'public.qorpera_site_host_pattern(text)', 'public.qorpera_site_host(text)'] loop
			perform pg_temp.base_assert(not has_function_privilege(v_role, v_function, 'EXECUTE'), v_function || ' is closed to ' || v_role);
		end loop;
		perform pg_temp.base_assert(not has_table_privilege(v_role, 'public.qorpera_company_site_tickets', 'SELECT,INSERT,UPDATE,DELETE'),
			'the tickets are closed to ' || v_role);
	end loop;
	perform pg_temp.base_assert((select relrowsecurity from pg_class where oid = 'public.qorpera_company_site_tickets'::regclass),
		'the tickets have row level security');
	perform pg_temp.base_assert((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc where oid in (
		'public.qorpera_site_serve_host(text,text,text,text,integer,integer)'::regprocedure,
		'public.qorpera_site_unlock_host(text,text,text)'::regprocedure, 'public.qorpera_site_enter(text,text)'::regprocedure,
		'public.qorpera_open_site_preview(uuid,text,text,integer)'::regprocedure, 'public.qorpera_company_site_access(uuid)'::regprocedure,
		'public.qorpera_site_take_down(text,text)'::regprocedure, 'public.qorpera_site_restore(text)'::regprocedure,
		'public.qorpera_code_set_drill(uuid,text,text,text)'::regprocedure)), 'definers with an empty search path');
	perform pg_temp.base_assert((select proconfig @> array['lock_timeout=3s'] from pg_proc
		where oid = 'public.qorpera_open_site_preview(uuid,text,text,integer)'::regprocedure), 'Look first waits 3 s at most');
	perform pg_temp.base_assert((select provolatile = 's' from pg_proc
		where oid = 'public.qorpera_site_serve_host(text,text,text,text,integer,integer)'::regprocedure), 'serving reads only');
	-- Everything starts off and up: no domain, hosts off, no site taken down, no drill.
	perform pg_temp.base_assert((select hosts_domain is null and not hosts_enabled from public.qorpera_site_settings)
		and not exists (select 1 from public.qorpera_company_sites where taken_down_at is not null or taken_down_reason is not null)
		and not exists (select 1 from public.qorpera_code_repositories where drill is not null or drill_set_at is not null
			or drill_taken_at is not null)
		and not exists (select 1 from public.qorpera_company_site_sessions where scope <> 'site' or version_id is not null),
		'all off');
	-- Hosts need a domain of one or more labels, lower case, no dot at either end.
	perform pg_temp.base_error('update public.qorpera_site_settings set hosts_enabled = true', '23514');
	foreach v_function in array array['Qorpera.com', 'qorpera', '.qorpera.com', 'qorpera.com.', 'qorpera..com', '-a.com',
		'a_b.com', 'https://qorpera.com', repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.com'] loop
		perform pg_temp.base_error(format('update public.qorpera_site_settings set hosts_domain = %L', v_function), '23514');
	end loop;
	-- A session's scope and version go together; a drill is check or site; a ticket is a digest that ends after it began
	-- (the checks come before the keys: no site is needed; a takedown's own rule is checked in 10).
	foreach v_function in array array[
		$q$insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope)
			values (repeat('1', 64), extensions.gen_random_uuid(), 1, clock_timestamp() + interval '1 hour', 'next')$q$,
		$q$insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope, version_id)
			values (repeat('1', 64), extensions.gen_random_uuid(), 1, clock_timestamp() + interval '1 hour', 'site',
				extensions.gen_random_uuid())$q$,
		$q$insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, expires_at, scope)
			values (repeat('1', 64), extensions.gen_random_uuid(), 1, clock_timestamp() + interval '1 hour', 'other')$q$,
		$q$update public.qorpera_code_repositories set drill = 'checks'$q$,
		$q$insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, expires_at)
			values ('abc', extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.req_owner(),
				clock_timestamp() + interval '2 minutes')$q$,
		$q$insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, created_at, expires_at)
			values (repeat('2', 64), extensions.gen_random_uuid(), extensions.gen_random_uuid(), pg_temp.req_owner(),
				clock_timestamp(), clock_timestamp() - interval '1 second')$q$] loop
		perform pg_temp.base_error(v_function, '23514');
	end loop;
	-- Each changed body carries this migration's marker and keeps the ones it had.
	foreach v_function in array array['public.qorpera_site_slug_valid(text)|20260930550000',
		'public.qorpera_site_url(text)|20260930562000', 'public.qorpera_site_serve(text,text,text,text,integer,integer)|20260930562000',
		'public.qorpera_site_unlock(text,text,text)|20260930550000',
		'public.qorpera_site_app_live(public.qorpera_company_sites)|20260930562000',
		'public.qorpera_code_site_slugs(text,text)|', 'public.qorpera_code_checks_switch(uuid,uuid)|20260930729000',
		'public.qorpera_code_release_index(public.qorpera_code_repositories)|', 'public.qorpera_list_code_releases(uuid)|',
		'public.qorpera_put_code_release_live(uuid,text,text,jsonb)|', 'public.qorpera_code_release_back(uuid,text,text,jsonb)|'] loop
		perform pg_temp.base_assert(strpos(pg_get_functiondef(split_part(v_function, '|', 1)::regprocedure), '20260930756000') > 0
			and strpos(pg_get_functiondef(split_part(v_function, '|', 1)::regprocedure), split_part(v_function, '|', 2)) > 0,
			'the markers are in ' || v_function);
	end loop;
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_site_url(text)'::regprocedure), '20260930550000') > 0
		and strpos(pg_get_functiondef('public.qorpera_site_serve(text,text,text,text,integer,integer)'::regprocedure),
			'20260930550000') > 0, 'the first markers stay');
end $$;

-- 2. The name rule ------------------------------------------------------------------------------------------------------
do $$
declare v_slug text;
begin
	-- One text: 118 names, each once, split by one space; the executor's RESERVED holds it byte for byte.
	perform pg_temp.base_assert(public.qorpera_site_reserved_names() = pg_temp.sh_reserved()
		and pg_temp.sh_sha(public.qorpera_site_reserved_names()) = 'e3f73121ff872bb8b690df2a702addf2b39285e2ef4543c8fc198fd1ffbc6745'
		and cardinality(string_to_array(pg_temp.sh_reserved(), ' ')) = 118
		and (select count(distinct name) from unnest(string_to_array(pg_temp.sh_reserved(), ' ')) name) = 118
		and pg_temp.sh_reserved() !~ '(^ | $|  )', 'the reserved text');
	perform pg_temp.base_assert((select bool_and(not public.qorpera_site_slug_valid(name))
		from unnest(string_to_array(pg_temp.sh_reserved(), ' ')) name), 'every reserved name is refused');
	-- Refused: two hyphens anywhere, a name ending -preview, qorpera anywhere, and the old rules.
	foreach v_slug in array array['shop--app', 'a--b', 'abc--next', 'xn--shop', 'shop-preview', 'a-b-preview', 'my-qorpera',
		'qorperashop', 'shop-qorpera-x', 'ab', '-ab', 'ab-', 'Shop', 'shop.v2', 'shop_v2', repeat('a', 49), '', 'screens', 'edge',
		'demo', 'shop', 'inbox', 'objects', 'send', 'next', 'preview'] loop
		perform pg_temp.base_assert(not public.qorpera_site_slug_valid(v_slug), v_slug || ' is refused');
	end loop;
	perform pg_temp.base_assert(public.qorpera_site_slug_valid(null) is false, 'no name is refused');
	-- Valid: production's one name, a name ending -next (a plain own host), -preview inside a name, and the bounds.
	foreach v_slug in array array['saml-gift-message', 'shop-next', 'preview-shop', 'a-preview-b', 'shopqorp', 'webshop', 'abc',
		repeat('a', 48), 'a1-b2-c3', 'next-door', 'shops'] loop
		perform pg_temp.base_assert(public.qorpera_site_slug_valid(v_slug), v_slug || ' is a name');
	end loop;
	-- A repository's site's names: qorpera out, a run of hyphens one, project when nothing is left; the name the checks
	-- file asks for is tried as it is, and only when it passes.
	perform pg_temp.base_assert(public.qorpera_code_site_slugs('my__app', null) = array['my-app'] || array(select 'my-app-' || n
			from generate_series(2, 9) n)
		and public.qorpera_code_site_slugs('qorpera-shop', null) = array(select 'shop-' || n from generate_series(2, 9) n)
		and public.qorpera_code_site_slugs('my-qorpera-site', 'my--site') = array['my-site'] || array(select 'my-site-' || n
			from generate_series(2, 9) n)
		and public.qorpera_code_site_slugs('qorpera', null) = array['project'] || array(select 'project-' || n from generate_series(2, 9) n)
		and public.qorpera_code_site_slugs('Qorpera_Tools', 'tools-now') = array['tools-now', 'tools'] || array(select 'tools-' || n
			from generate_series(2, 9) n)
		and (public.qorpera_code_site_slugs('qorqorperapera', null))[1] = 'qor-pera'
		and (public.qorpera_code_site_slugs('a._b', null))[1] = 'a-b'
		and (public.qorpera_code_site_slugs('x--y', 'shop-preview'))[1] = 'x-y'
		and (public.qorpera_code_site_slugs('gift_message.app', null))[1] = 'gift-message-app'
		and (public.qorpera_code_site_slugs(repeat('a', 30) || '--' || repeat('b', 30), null))[1] = repeat('a', 30) || '-' || repeat('b', 17),
		'derived names: ' || array_to_string(public.qorpera_code_site_slugs('qorpera-shop', null), ','));
	-- The migration's guard on stored names (as written there: a migration's own blocks cannot be called) refuses a name
	-- that breaks the rule, naming it.
	begin
		insert into public.qorpera_company_sites(profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
		values (pg_temp.rel_company(), pg_temp.rec_here(), 'bad--name', 'web', '92400000-0000-4000-8000-000000000030'),
			(pg_temp.rel_company(), pg_temp.rec_here(), 'old-preview', 'web', '92400000-0000-4000-8000-000000000030');
		declare v_broken text[];
		begin
			select array_agg(site.slug order by site.slug collate "C") into v_broken from public.qorpera_company_sites as site
			where not public.qorpera_site_slug_valid(site.slug);
			if v_broken is not null then
				raise exception '20260930756000: these sites'' names break the name rule (qorpera_site_slug_valid): %',
					array_to_string(v_broken, ', '); end if;
		end;
		raise exception 'the guard let a broken name through' using errcode = 'QSH00';
	exception when sqlstate 'P0001' then
		perform pg_temp.base_assert(sqlerrm = '20260930756000: these sites'' names break the name rule (qorpera_site_slug_valid): '
			|| 'bad--name, old-preview', 'the guard names them: ' || sqlerrm);
	end;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites where not public.qorpera_site_slug_valid(slug)),
		'every stored name passes');
end $$;

-- 3. A site host --------------------------------------------------------------------------------------------------------
do $$
declare v_host text; v_pattern text := public.qorpera_site_host_pattern('qorpera.com'); v jsonb;
begin
	perform pg_temp.base_assert(v_pattern = '^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$', 'the one regex: ' || v_pattern);
	-- The first draft's regex took --next into the slug (greedy): why the parse is by label.
	perform pg_temp.base_assert(substring('shop--next.qorpera.com' from '^([a-z0-9][a-z0-9-]{1,46}[a-z0-9])(--next)?\.qorpera\.com$')
		= 'shop--next', 'the greedy regex');
	-- No domain: no site host.
	perform pg_temp.base_assert(public.qorpera_site_host('look-shop.qorpera.com') is null, 'no domain, no host');
	perform pg_temp.sh_hosts('qorpera.com', false);
	-- Each host, and what it is.
	for v_host, v in select pair.host, pair.parsed::jsonb from (values
		('look-shop.qorpera.com', '{"slug":"look-shop","scope":"site"}'),
		('webshop--next.qorpera.com', '{"slug":"webshop","scope":"next"}'),
		-- (shop is a reserved name, so shop--next is no site's next host.)
		('shop--next.qorpera.com', null),
		(repeat('a', 48) || '.qorpera.com', jsonb_build_object('slug', repeat('a', 48), 'scope', 'site')::text),
		(repeat('a', 48) || '--next.qorpera.com', jsonb_build_object('slug', repeat('a', 48), 'scope', 'next')::text),
		('shop-next.qorpera.com', '{"slug":"shop-next","scope":"site"}'),
		('shop-next--next.qorpera.com', '{"slug":"shop-next","scope":"next"}'),
		('a1-b2.qorpera.com', '{"slug":"a1-b2","scope":"site"}'),
		-- Not a site host: too long or short, two hyphens, --next alone or twice, another level or domain, a platform
		-- name, an app link's host, qorpera in it, an IDN, upper case (callers lower-case first).
		(repeat('a', 49) || '.qorpera.com', null), (repeat('a', 49) || '--next.qorpera.com', null),
		('ab.qorpera.com', null), ('ab--next.qorpera.com', null), ('a--b.qorpera.com', null), ('--next.qorpera.com', null),
		('-next.qorpera.com', null), ('shop---next.qorpera.com', null), ('shop--next--next.qorpera.com', null),
		('a.look-shop.qorpera.com', null), ('qorpera.com', null), ('.qorpera.com', null), ('look-shop.qorpera.com.evil.test', null),
		('look-shop.evil.test', null), ('lookqorpera.com', null), ('look-shop.qorpera.co', null), ('look-shop.qorpera.com.', null),
		('api.qorpera.com', null), ('sites.qorpera.com', null), ('next.qorpera.com', null), ('app-preview.qorpera.com', null),
		('my-qorpera.qorpera.com', null), ('xn--80ak6aa92e.qorpera.com', null), ('Look-shop.qorpera.com', null),
		('look-shop.qorpera.com:443', null), ('', null)) pair(host, parsed) loop
		perform pg_temp.base_assert(public.qorpera_site_host(v_host) is not distinct from v, 'the host ' || v_host || ': '
			|| coalesce(public.qorpera_site_host(v_host)::text, 'none'));
		-- The one regex agrees: it matches with the slug in group 1 (the length checked apart), and the rule holds.
		perform pg_temp.base_assert((v_host ~ v_pattern and char_length(substring(v_host from v_pattern)) between 3 and 48
				and public.qorpera_site_slug_valid(substring(v_host from v_pattern))) = (v is not null)
			and (v is null or substring(v_host from v_pattern) = v ->> 'slug'), 'the regex on ' || v_host);
	end loop;
	perform pg_temp.sh_hosts(null, false);
end $$;

-- 4. Hosts off: every existing call answers as before ---------------------------------------------------------------------
-- company/h-look: change 1 made version 1 (live), change 2 version 2 (ready, with a 404.html); company/h-wait: version 1
-- ready, never live.
do $$
begin
	perform pg_temp.base_assert(pg_temp.rel_land(2520, 'h0', 'h1', pg_temp.rel_made('h1', '{"name":"look-shop","title":"Look shop"}',
			pg_temp.sh_texts(1)), 'h-look') = pg_temp.rec_answer('recorded', 1), 'h-look 1');
	perform set_config('qorpera_test.sh_v1', pg_temp.rel_upload('h-look', 1, 'h1', pg_temp.sh_texts(1))::text, true);
	perform pg_temp.base_assert(pg_temp.rel_yes('h-look') = pg_temp.rel_answer(1, 'look-shop'), 'version 1 live, by its path');
	perform pg_temp.base_assert(pg_temp.rel_land(2521, 'h1', 'h2', pg_temp.rel_made('h2', '{"name":"look-shop"}', pg_temp.sh_texts(2)),
		'h-look') = pg_temp.rec_answer('recorded', 2), 'h-look 2');
	perform set_config('qorpera_test.sh_v2', pg_temp.rel_upload('h-look', 2, 'h2', pg_temp.sh_texts(2))::text, true);
	perform pg_temp.base_assert(pg_temp.rel_land(2522, 'w0', 'w1', pg_temp.rel_made('w1', '{"name":"wait-shop"}'), 'h-wait')
		= pg_temp.rec_answer('recorded', 1), 'h-wait 1');
	perform set_config('qorpera_test.sh_w1', pg_temp.rel_upload('h-wait', 1, 'w1')::text, true);
	perform pg_temp.base_assert(pg_temp.rel_states('h-look') = '1:live 2:ready' and pg_temp.rel_states('h-wait') = '1:ready',
		'h-look: ' || pg_temp.rel_states('h-look'));
end $$;

do $$
declare v_case text; v jsonb; v_failures bigint; v_w uuid := pg_temp.rec_turn(2523, 1, pg_temp.rec_sha('x1'), '{}',
	pg_temp.own_repo('company', 'h-look'));
begin
	foreach v_case in array array['no domain', 'domain set', 'sites off'] loop
		if v_case = 'domain set' then perform pg_temp.sh_hosts('qorpera.com', false); end if;
		if v_case = 'sites off' then
			-- (Hosts on while sites are off is still off: links never name a host nothing serves.)
			perform pg_temp.sh_hosts('qorpera.com', true);
			update public.qorpera_site_settings set enabled = false;
		end if;
		perform pg_temp.base_assert(not public.qorpera_site_hosts_on(), v_case || ': hosts are off');
		perform pg_temp.base_assert(public.qorpera_site_url('look-shop') = 'https://sites.qorpera.com/look-shop/'
			and public.qorpera_site_url('brand-new') = 'https://sites.qorpera.com/brand-new/', v_case || ': links by path');
		-- The list file: exactly live and ready, as before.
		v := public.qorpera_code_release_index(pg_temp.rec_shop('h-look'));
		perform pg_temp.base_assert((select array_agg(key order by key) from jsonb_object_keys(v) key) = array['live', 'ready']
			and v -> 'live' ->> 'url' = 'https://sites.qorpera.com/look-shop/'
			and (select array_agg(key order by key) from jsonb_object_keys(v -> 'live') key)
				= array['by', 'change', 'kind', 'since', 'url', 'version'] and v -> 'ready' = '{"change":2}',
			v_case || ': the list file: ' || v::text);
		perform pg_temp.base_assert(not (pg_temp.rec_files(20, 'h-look') -> 'index') ? 'preparing', v_case || ': no preparing');
		-- What's new: no preview.
		perform pg_temp.base_assert(pg_temp.rel_read() - 'sites' = '{"schema":"qorpera.code-releases/v1","canRelease":true}',
			v_case || ': What''s new: ' || (pg_temp.rel_read() - 'sites')::text);
		-- The switch: exactly as before.
		perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":true}',
			v_case || ': the switch: ' || pg_temp.sh_switch(v_w)::text);
		-- Serving: the old host is the old handler's; no other host is a site's.
		perform pg_temp.base_assert(pg_temp.sh_serve('sites.qorpera.com', 'look-shop/') = '{"state":"legacy"}'
			and pg_temp.sh_serve('sites.qorpera.com', 'look-shop/~' || repeat('A', 32) || '/index.html') = '{"state":"legacy"}'
			and pg_temp.sh_serve('sites.qorpera.com', '') = '{"state":"legacy"}'
			and pg_temp.sh_serve('look-shop.qorpera.com') = '{"state":"none"}'
			and pg_temp.sh_serve('look-shop--next.qorpera.com') = '{"state":"none"}', v_case || ': serving');
		-- (A check reads the tables in a statement of its own, after the calls that write.)
		v_failures := (select count(*) from public.qorpera_site_unlock_failures);
		perform pg_temp.base_assert(pg_temp.sh_unlock('look-shop.qorpera.com', pg_temp.sh_password('look-shop')) = '{"state":"wrong"}'
			and pg_temp.sh_enter('look-shop--next.qorpera.com', repeat('T', 43)) = '{"state":"refused"}', v_case || ': no password, no ticket');
		perform pg_temp.base_assert((select count(*) from public.qorpera_site_unlock_failures) = v_failures, v_case || ': nothing counted');
		perform pg_temp.base_assert(pg_temp.sh_open('h-look', 2) = '{"schema":"qorpera.site-preview/v1","state":"off"}',
			v_case || ': Look first is off');
		perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_tickets), v_case || ': no ticket');
		perform pg_temp.base_assert(pg_temp.sh_access() = jsonb_build_object('schema', 'qorpera.company-site-access/v1', 'hosts', false,
			'sites', jsonb_build_array(jsonb_build_object('siteId', (pg_temp.sh_site('look-shop')).id, 'takenDown', null),
				jsonb_build_object('siteId', (pg_temp.sh_site('wait-shop')).id, 'takenDown', null))), v_case || ': the access read');
	end loop;
	update public.qorpera_site_settings set enabled = true, hosts_domain = null, hosts_enabled = false;
	-- The members' list says the path, in the row it always had.
	v := (select item from jsonb_array_elements(pg_temp.sh_sites()) item where item ->> 'slug' = 'look-shop');
	perform pg_temp.base_assert(v ->> 'url' = 'https://sites.qorpera.com/look-shop/', 'Sites: ' || v::text);
end $$;

-- 5. Hosts on: links, preparing, preview, rootLinks ------------------------------------------------------------------------
do $$
declare v jsonb; v_w uuid := pg_temp.rec_turn(2524, 1, pg_temp.rec_sha('x2'), '{}', pg_temp.own_repo('company', 'h-look'));
	q public.qorpera_code_repositories%rowtype;
begin
	perform pg_temp.sh_hosts('qorpera.com', true);
	perform pg_temp.base_assert(public.qorpera_site_hosts_on(), 'hosts are on');
	perform pg_temp.base_assert(public.qorpera_site_url('look-shop') = 'https://look-shop.qorpera.com/'
		and public.qorpera_site_url('brand-new') = 'https://brand-new.qorpera.com/', 'a website''s own host');
	v := (select item from jsonb_array_elements(pg_temp.sh_sites()) item where item ->> 'slug' = 'look-shop');
	perform pg_temp.base_assert(v ->> 'url' = 'https://look-shop.qorpera.com/'
		and (select count(*) from jsonb_object_keys(v)) = 16, 'Sites: the same row, the host''s link: ' || v::text);
	-- The list file: the live link, and preparing (null: nothing is due).
	v := public.qorpera_code_release_index(pg_temp.rec_shop('h-look'));
	perform pg_temp.base_assert(v -> 'live' ->> 'url' = 'https://look-shop.qorpera.com/' and v -> 'ready' = '{"change":2}'
		and v ? 'preparing' and v -> 'preparing' = 'null', 'the list file: ' || v::text);
	-- Change 3 landed and its site is not uploaded yet: being prepared, in the list file too.
	perform pg_temp.base_assert(pg_temp.rel_land(2525, 'h2', 'h3', pg_temp.rel_made('h3', '{"name":"look-shop"}'), 'h-look')
		= pg_temp.rec_answer('recorded', 3), 'h-look 3');
	perform pg_temp.base_assert(public.qorpera_code_release_index(pg_temp.rec_shop('h-look')) -> 'preparing' = '{"change":3}'
		and pg_temp.rec_files(20, 'h-look') -> 'index' -> 'preparing' = '{"change":3}'
		and pg_temp.rec_files(20, 'h-look') -> 'index' -> 'ready' = '{"change":2}', 'being prepared');
	-- Not while the repository's sites are off, nor once the pass gave the change up.
	q := pg_temp.rec_shop('h-look');
	update public.qorpera_code_repositories set site_enabled = false where environment_id = q.environment_id and name = 'h-look';
	perform pg_temp.base_assert(public.qorpera_code_release_index(pg_temp.rec_shop('h-look')) -> 'preparing' = 'null', 'sites off');
	update public.qorpera_code_repositories set site_enabled = true, site_problem = 'SITE_UPLOAD_FAILED', site_change = 3,
		site_attempts = 5, site_given_up = 3 where environment_id = q.environment_id and name = 'h-look';
	perform pg_temp.base_assert(public.qorpera_code_release_index(pg_temp.rec_shop('h-look')) -> 'preparing' = 'null', 'given up');
	update public.qorpera_code_repositories set site_problem = null, site_change = null, site_attempts = 0, site_given_up = null
	where environment_id = q.environment_id and name = 'h-look';
	-- A repository with no site and none made: still nothing.
	perform pg_temp.base_assert(public.qorpera_code_release_index(pg_temp.rec_shop('h-drill')) = '{}', 'no site');
	-- What's new: owners and admins may look first.
	perform pg_temp.base_assert(pg_temp.rel_read() - 'sites' = '{"schema":"qorpera.code-releases/v1","canRelease":true,"preview":true}'
		and pg_temp.rel_read(pg_temp.rel_admin()) -> 'preview' = 'true' and pg_temp.rel_read(pg_temp.rel_member()) -> 'preview' = 'false'
		and pg_temp.rel_read(pg_temp.rel_viewer()) -> 'preview' = 'false', 'preview');
	perform pg_temp.base_assert((pg_temp.rel_page('h-look') -> 'site' ->> 'url') = 'https://look-shop.qorpera.com/', 'the page''s link');
	-- The switch: links from / are a site's own.
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w)
		= '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":true,"rootLinks":true}', 'rootLinks');
	perform pg_temp.base_assert(pg_temp.sh_access() ->> 'hosts' = 'true', 'the access read says so');
end $$;

-- 6. The old host --------------------------------------------------------------------------------------------------------
do $$
begin
	perform pg_temp.base_assert(pg_temp.sh_serve('sites.qorpera.com', 'look-shop/~' || repeat('A', 32) || '/index.html')
			= '{"state":"moved","url":"https://look-shop.qorpera.com/"}'
		and pg_temp.sh_serve('sites.qorpera.com', '/look-shop/app.js') = '{"state":"moved","url":"https://look-shop.qorpera.com/"}'
		and pg_temp.sh_serve('SITES.qorpera.com', 'look-shop') = '{"state":"moved","url":"https://look-shop.qorpera.com/"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'look-shop/.qorpera/unlock') = '{"state":"moved","url":"https://look-shop.qorpera.com/"}',
		'a site moves to its own host');
	-- Every valid name moves, so the old host shows nothing of which sites exist; anything else is the old handler's.
	perform pg_temp.base_assert(pg_temp.sh_serve('sites.qorpera.com', 'no-such-site/') = '{"state":"moved","url":"https://no-such-site.qorpera.com/"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'robots.txt') = '{"state":"legacy"}'
		and pg_temp.sh_serve('sites.qorpera.com', '') = '{"state":"legacy"}'
		and pg_temp.sh_serve('sites.qorpera.com', null) = '{"state":"legacy"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'api/') = '{"state":"legacy"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'shop--app/') = '{"state":"legacy"}', 'names that move, and the rest');
end $$;

-- 7. The own host --------------------------------------------------------------------------------------------------------
do $$
declare v_open jsonb; v_token text; v jsonb; v_failures bigint;
begin
	-- No site here: an unknown name, an app link's or a platform's name, another level, a site not live yet.
	perform pg_temp.base_assert(pg_temp.sh_serve('no-such-site.qorpera.com') = '{"state":"none"}'
		and pg_temp.sh_serve('api.qorpera.com', 'rest/v1/') = '{"state":"none"}'
		and pg_temp.sh_serve('a.look-shop.qorpera.com') = '{"state":"none"}'
		and pg_temp.sh_serve('look-shop.qorpera.com.evil.test') = '{"state":"none"}'
		and pg_temp.sh_serve('wait-shop.qorpera.com') = '{"state":"none"}'
		and pg_temp.sh_serve(null) = '{"state":"none"}', 'none');
	-- Locked without a visitor's session of the current password.
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com') = '{"state":"locked","scope":"site","public":false}'
		and pg_temp.sh_serve('look-shop.qorpera.com', '', 'short') = '{"state":"locked","scope":"site","public":false}'
		and pg_temp.sh_serve('look-shop.qorpera.com', 'index.html', repeat('A', 32)) = '{"state":"locked","scope":"site","public":false}',
		'locked');
	-- The password: a wrong one counts against the name, the right one opens a visitor's session for 7 days.
	v_failures := (select count(*) from public.qorpera_site_unlock_failures where slug = 'look-shop');
	perform pg_temp.base_assert(pg_temp.sh_unlock('look-shop.qorpera.com', 'not the password', '192.0.2.41') = '{"state":"wrong"}',
		'a wrong one');
	perform pg_temp.base_assert((select count(*) from public.qorpera_site_unlock_failures where slug = 'look-shop') = v_failures + 1,
		'a wrong one counts');
	v_open := pg_temp.sh_unlock('LOOK-SHOP.qorpera.com', pg_temp.sh_password('look-shop'), '192.0.2.42');
	v_token := v_open ->> 'token';
	perform pg_temp.base_assert(v_open ->> 'state' = 'open' and v_token ~ '^[A-Za-z0-9_-]{32}$' and v_open -> 'maxAge' = '604800'
		and (select scope = 'site' and version_id is null and expires_at > clock_timestamp() + interval '6 days 23 hours'
			from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha(v_token)), 'the password opens it: ' || v_open::text);
	-- The next host, the old host and a host that is no site's never take a password, and count nothing.
	v_failures := (select count(*) from public.qorpera_site_unlock_failures);
	perform pg_temp.base_assert(pg_temp.sh_unlock('look-shop--next.qorpera.com', pg_temp.sh_password('look-shop')) = '{"state":"wrong"}'
		and pg_temp.sh_unlock('sites.qorpera.com', pg_temp.sh_password('look-shop')) = '{"state":"wrong"}'
		and pg_temp.sh_unlock('a.look-shop.qorpera.com', pg_temp.sh_password('look-shop')) = '{"state":"wrong"}'
		and pg_temp.sh_unlock('no-such-site--next.qorpera.com', 'a guess') = '{"state":"wrong"}', 'no other host takes the password');
	perform pg_temp.base_assert((select count(*) from public.qorpera_site_unlock_failures) = v_failures, 'and counts nothing');
	-- The live version's files, at the top of the host.
	v := pg_temp.sh_serve('look-shop.qorpera.com', '', v_token);
	perform pg_temp.base_assert(v - 'content' - 'sha256' - 'bytes' = '{"state":"file","status":200,"path":"index.html",'
			'"contentType":"text/html; charset=utf-8","offset":0,"scope":"site","public":false}'
		and pg_temp.sh_text(v) = '<h1>h1</h1>', 'the home page: ' || v::text);
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com', '/index.html', v_token, v ->> 'sha256') -> 'content' = 'null'
		and pg_temp.sh_text(pg_temp.sh_serve('look-shop.qorpera.com', 'app.js', v_token, null, 0, 7)) = 'console'
		and pg_temp.sh_serve('look-shop.qorpera.com', 'app.js', v_token, null, 0, 0) -> 'content' = 'null'
		and pg_temp.sh_text(pg_temp.sh_serve('look-shop.qorpera.com', 'docs/', v_token)) = '<p>Docs</p>', 'files');
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com', 'docs', v_token)
			= '{"state":"directory","path":"docs/","scope":"site","public":false}'
		and pg_temp.sh_serve('look-shop.qorpera.com', 'nothing.html', v_token) = '{"state":"missing","scope":"site","public":false}'
		and pg_temp.sh_serve('look-shop.qorpera.com', '../secret', v_token) = '{"state":"missing","scope":"site","public":false}',
		'a folder, and a path version 1 does not have (it has no 404.html)');
	-- The visitor's session never opens the next host.
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_token) = '{"state":"locked","scope":"next","public":false}',
		'a visitor never sees the next version');
	-- A company being deleted serves nothing.
	begin
		insert into public.qorpera_company_deletions (profile_id) values (pg_temp.rel_company());
		perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com', '', v_token) = '{"state":"none"}', 'being deleted');
		raise exception 'undo' using errcode = 'QSH01';
	exception when sqlstate 'QSH01' then null;
	end;
	perform set_config('qorpera_test.sh_visitor', v_token, true);
end $$;

-- 8. Look first ------------------------------------------------------------------------------------------------------------
do $$
declare v_open jsonb; v_ticket text; v jsonb; v_token text; v_v2 uuid := current_setting('qorpera_test.sh_v2')::uuid;
	v_site uuid := (pg_temp.sh_site('look-shop')).id; i integer;
begin
	-- Owners and admins only; a request that is not one; a repository the company does not keep.
	perform pg_temp.base_error(format('select pg_temp.sh_open(%L, 2, %L)', 'h-look', pg_temp.rel_member()), '42501', 'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.sh_open(%L, 2, %L)', 'h-look', pg_temp.rel_viewer()), '42501', 'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.sh_open(%L, 2, %L)', 'h-look', pg_temp.rel_outsider()), '42501', 'Releases unavailable');
	perform pg_temp.base_error(format('select pg_temp.sh_open(%L, 0)', 'h-look'), '22023', 'Look first request is invalid');
	perform pg_temp.base_error(format('select pg_temp.sh_open(%L, 2)', 'nowhere'), 'P0002', 'No such repository');
	-- A change that is no ready point with a version (3 is not uploaded; 9 does not exist; 1 is live, below the point).
	perform pg_temp.base_assert(pg_temp.sh_open('h-look', 3) = '{"schema":"qorpera.site-preview/v1","state":"moved"}'
		and pg_temp.sh_open('h-look', 9) = '{"schema":"qorpera.site-preview/v1","state":"moved"}'
		and pg_temp.sh_open('h-look', 1) = '{"schema":"qorpera.site-preview/v1","state":"moved"}'
		and pg_temp.sh_open('h-drill', 1) = '{"schema":"qorpera.site-preview/v1","state":"moved"}', 'moved');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_tickets), 'moved makes no ticket');
	-- Open: a one-time ticket for version 2, kept as its digest, for 2 minutes.
	v_open := pg_temp.sh_open('h-look', 2, pg_temp.rel_admin());
	v_ticket := pg_temp.sh_ticket(v_open);
	perform pg_temp.base_assert(v_open - 'url' = '{"schema":"qorpera.site-preview/v1","state":"open"}'
		and v_open ->> 'url' = 'https://look-shop--next.qorpera.com/.qorpera/enter?t=' || v_ticket and v_ticket is not null
		and (select site_id = v_site and version_id = v_v2 and user_id = pg_temp.rel_admin()
				and expires_at between clock_timestamp() + interval '119 seconds' and clock_timestamp() + interval '120 seconds'
			from public.qorpera_company_site_tickets where ticket_sha256 = pg_temp.sh_sha(v_ticket))
		and not exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 = v_ticket), 'open: ' || v_open::text);
	-- enter: a ticket of that shape only; on its site's next host only (it stays for the right one); once.
	perform pg_temp.base_assert(pg_temp.sh_enter('look-shop--next.qorpera.com', 'short') = '{"state":"refused"}'
		and pg_temp.sh_enter('look-shop--next.qorpera.com', v_ticket || '=') = '{"state":"refused"}'
		and pg_temp.sh_enter('look-shop.qorpera.com', v_ticket) = '{"state":"refused"}'
		and pg_temp.sh_enter('wait-shop--next.qorpera.com', v_ticket) = '{"state":"refused"}'
		and pg_temp.sh_enter('sites.qorpera.com', v_ticket) = '{"state":"refused"}'
		and pg_temp.sh_enter('look-shop--next.qorpera.com', null) = '{"state":"refused"}', 'refused');
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 = pg_temp.sh_sha(v_ticket)),
		'refused, the ticket stays for its host');
	v := pg_temp.sh_enter('Look-Shop--Next.qorpera.com', v_ticket);
	v_token := v ->> 'token';
	perform pg_temp.base_assert(v ->> 'state' = 'open' and v_token ~ '^[A-Za-z0-9_-]{32}$' and v -> 'maxAge' = '43200'
		and (select scope = 'next' and version_id = v_v2 and site_id = v_site
				and expires_at between clock_timestamp() + interval '11 hours 59 minutes' and clock_timestamp() + interval '12 hours'
			from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha(v_token))
		and not exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 = pg_temp.sh_sha(v_ticket)),
		'enter: ' || v::text);
	perform pg_temp.base_assert(pg_temp.sh_enter('look-shop--next.qorpera.com', v_ticket) = '{"state":"refused"}', 'used once');
	-- The next host serves version 2 (ready), whatever is live; a path it does not have gets its 404.html, status 404,
	-- whole whatever the visitor holds.
	v := pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_token);
	perform pg_temp.base_assert(v ->> 'state' = 'file' and v -> 'status' = '200' and v ->> 'scope' = 'next'
		and pg_temp.sh_text(v) = '<h1>h2</h1>' and v -> 'public' = 'false', 'the next version: ' || v::text);
	v := pg_temp.sh_serve('look-shop--next.qorpera.com', 'nothing.html', v_token, pg_temp.sh_sha('<p>Not here</p>'));
	perform pg_temp.base_assert(v - 'content' = jsonb_build_object('state', 'file', 'status', 404, 'path', '404.html',
			'contentType', 'text/html; charset=utf-8', 'bytes', 15, 'sha256', pg_temp.sh_sha('<p>Not here</p>'), 'offset', 0,
			'scope', 'next', 'public', false)
		and pg_temp.sh_text(v) = '<p>Not here</p>', 'its 404.html: ' || v::text);
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '404.html', v_token) -> 'status' = '200'
		and pg_temp.sh_serve('look-shop--next.qorpera.com', 'docs/', v_token) -> 'status' = '404', '404.html itself, and a folder version 2 lacks');
	-- The member's session opens the next host only; the next host opens to nothing else.
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com', '', v_token) = '{"state":"locked","scope":"site","public":false}'
		and pg_temp.sh_serve('look-shop--next.qorpera.com') = '{"state":"locked","scope":"next","public":false}'
		and pg_temp.sh_serve('wait-shop--next.qorpera.com', '', v_token) = '{"state":"locked","scope":"next","public":false}'
		and pg_temp.sh_serve('wait-shop--next.qorpera.com') = '{"state":"locked","scope":"next","public":false}',
		'one session, one host');
	-- A ticket that ended, or whose member is no longer an owner or admin, opens nothing (and is spent).
	insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, created_at, expires_at)
	values (pg_temp.sh_sha(repeat('E', 43)), v_site, v_v2, pg_temp.rel_admin(), clock_timestamp() - interval '3 minutes',
			clock_timestamp() - interval '1 minute'),
		(pg_temp.sh_sha(repeat('M', 43)), v_site, v_v2, pg_temp.rel_member(), clock_timestamp(), clock_timestamp() + interval '2 minutes');
	perform pg_temp.base_assert(pg_temp.sh_enter('look-shop--next.qorpera.com', repeat('E', 43)) = '{"state":"refused"}'
		and pg_temp.sh_enter('look-shop--next.qorpera.com', repeat('M', 43)) = '{"state":"refused"}', 'ended, or not an owner''s');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_tickets
		where ticket_sha256 = pg_temp.sh_sha(repeat('M', 43))), 'a ticket taken is spent');
	-- A version that is no longer the site's ready, live or kept one: locked; pruned, its sessions and tickets go with it.
	begin
		update public.qorpera_company_site_versions set state = 'uploading' where id = v_v2;
		perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_token)
			= '{"state":"locked","scope":"next","public":false}', 'not ready');
		raise exception 'undo' using errcode = 'QSH01';
	exception when sqlstate 'QSH01' then null;
	end;
	begin
		perform pg_temp.sh_open('h-look', 2);
		delete from public.qorpera_company_site_versions where id = v_v2;
		perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_token)
				= '{"state":"locked","scope":"next","public":false}'
			and not exists (select 1 from public.qorpera_company_site_sessions where version_id = v_v2)
			and not exists (select 1 from public.qorpera_company_site_tickets where version_id = v_v2), 'pruned');
		raise exception 'undo' using errcode = 'QSH01';
	exception when sqlstate 'QSH01' then null;
	end;
	-- At most 20 tickets a site, the newest, and expired ones go.
	insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, created_at, expires_at)
	select pg_temp.sh_sha('t' || n), v_site, v_v2, pg_temp.req_owner(), clock_timestamp() - make_interval(secs => 60 - n),
		clock_timestamp() + interval '1 minute' from generate_series(1, 25) n;
	insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, created_at, expires_at)
	values (pg_temp.sh_sha('old'), v_site, v_v2, pg_temp.req_owner(), clock_timestamp() - interval '1 hour',
		clock_timestamp() - interval '58 minutes');
	v_open := pg_temp.sh_open('h-look', 2);
	perform pg_temp.base_assert((select count(*) from public.qorpera_company_site_tickets where site_id = v_site) = 20
		and exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 = pg_temp.sh_sha(pg_temp.sh_ticket(v_open)))
		and exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 = pg_temp.sh_sha('t25'))
		and not exists (select 1 from public.qorpera_company_site_tickets where ticket_sha256 in (pg_temp.sh_sha('t6'), pg_temp.sh_sha('old'))),
		'twenty tickets');
	-- At most 20 next sessions a site, the newest; visitors' sessions are never touched.
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, created_at, expires_at, scope, version_id)
	select pg_temp.sh_sha('n' || n), v_site, (pg_temp.sh_site('look-shop')).password_version,
		clock_timestamp() - make_interval(secs => 100 - n), clock_timestamp() + interval '1 hour', 'next', v_v2
	from generate_series(1, 25) n;
	i := pg_temp.sh_sessions('look-shop', 'site');
	v := pg_temp.sh_enter('look-shop--next.qorpera.com', pg_temp.sh_ticket(v_open));
	perform pg_temp.base_assert(v ->> 'state' = 'open' and pg_temp.sh_sessions('look-shop', 'next') = 20
		and pg_temp.sh_sessions('look-shop', 'site') = i
		and exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha(v ->> 'token'))
		and exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha(v_token))
		and exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha('n8'))
		and not exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha('n7')),
		'twenty next sessions, the newest: ' || pg_temp.sh_sessions('look-shop', 'next'));
	perform set_config('qorpera_test.sh_next', v ->> 'token', true);
end $$;

-- 9. The old serve and unlock --------------------------------------------------------------------------------------------
do $$
declare v_next text := current_setting('qorpera_test.sh_next'); v_visitor text := current_setting('qorpera_test.sh_visitor');
	v_site uuid := (pg_temp.sh_site('look-shop')).id; v_version integer := (pg_temp.sh_site('look-shop')).password_version; v jsonb;
begin
	perform pg_temp.base_assert(pg_temp.rel_exec(format('public.qorpera_site_serve(%L, %L, %L, null, 0, 10485760)', 'look-shop', '',
			v_next)) = '{"state":"locked"}'
		and pg_temp.rel_exec(format('public.qorpera_site_serve(%L, %L, %L, null, 0, 10485760)', 'look-shop', '', v_visitor)) ->> 'state'
			= 'file', 'the old serve reads a visitor''s session only');
	-- The cap of 2000 counts visitors' sessions: 1999 visitors' and the 20 next ones (the oldest), then two passwords.
	delete from public.qorpera_company_site_sessions where site_id = v_site and scope = 'site';
	update public.qorpera_company_site_sessions set created_at = clock_timestamp() - interval '1 day' where site_id = v_site;
	insert into public.qorpera_company_site_sessions(token_sha256, site_id, password_version, created_at, expires_at)
	select pg_temp.sh_sha('v' || n), v_site, v_version, clock_timestamp() - make_interval(secs => 5000 - n),
		clock_timestamp() + interval '1 day' from generate_series(1, 1999) n;
	v := pg_temp.rel_exec(format('public.qorpera_site_unlock(%L, %L, %L)', 'look-shop', pg_temp.sh_password('look-shop'), '192.0.2.43'));
	perform pg_temp.base_assert(v ->> 'state' = 'open' and pg_temp.sh_sessions('look-shop', 'site') = 2000
		and pg_temp.sh_sessions('look-shop', 'next') = 20, 'two thousand: ' || pg_temp.sh_sessions('look-shop', 'site'));
	v := pg_temp.sh_unlock('look-shop.qorpera.com', pg_temp.sh_password('look-shop'), '192.0.2.44');
	perform pg_temp.base_assert(v ->> 'state' = 'open' and pg_temp.sh_sessions('look-shop', 'site') = 2000
		and pg_temp.sh_sessions('look-shop', 'next') = 20
		and not exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = pg_temp.sh_sha('v1')),
		'the oldest visitor''s went, no member''s: ' || pg_temp.sh_sessions('look-shop', 'next'));
	perform set_config('qorpera_test.sh_visitor', v ->> 'token', true);
	-- A new password ends the members' looks too: they open Look first again.
	perform pg_temp.req_as(pg_temp.req_owner(), format('public.qorpera_set_company_site_password(%L, null)', v_site));
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_next) = '{"state":"locked","scope":"next","public":false}'
		and pg_temp.sh_sessions('look-shop', 'next') = 0, 'a new password');
	v := pg_temp.sh_unlock('look-shop.qorpera.com', pg_temp.sh_password('look-shop'), '192.0.2.45');
	perform set_config('qorpera_test.sh_visitor', v ->> 'token', true);
	v := pg_temp.sh_enter('look-shop--next.qorpera.com', pg_temp.sh_ticket(pg_temp.sh_open('h-look', 2)));
	perform set_config('qorpera_test.sh_next', v ->> 'token', true);
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v ->> 'token') ->> 'state' = 'file', 'open again');
end $$;

-- 10. Takedown -----------------------------------------------------------------------------------------------------------
-- Version 2 goes live (release 2, Go back to 1), change 3's version is ready.
do $$
begin
	perform pg_temp.base_assert(pg_temp.rel_yes('h-look') = jsonb_build_object('schema', 'qorpera.code-release/v1', 'state', 'live',
		'version', 2, 'url', 'https://look-shop.qorpera.com/'), 'version 2 live, by its own host');
	perform pg_temp.rel_upload('h-look', 3, 'h3');
	perform pg_temp.base_assert(pg_temp.rel_states('h-look') = '1:kept 2:live 3:ready'
		and public.qorpera_code_release_index(pg_temp.rec_shop('h-look')) -> 'preparing' = 'null', 'h-look: ' || pg_temp.rel_states('h-look'));
end $$;

do $$
declare v jsonb; v_visitor text := current_setting('qorpera_test.sh_visitor'); v_next text := current_setting('qorpera_test.sh_next');
	v_site uuid := (pg_temp.sh_site('look-shop')).id; q public.qorpera_code_repositories%rowtype; v_at timestamptz; v_reason text;
begin
	-- A takedown has both its time and its reason, one line of 1 to 300 characters.
	foreach v_reason in array array[
		$q$update public.qorpera_company_sites set taken_down_at = clock_timestamp() where slug = 'look-shop'$q$,
		$q$update public.qorpera_company_sites set taken_down_reason = 'Reported' where slug = 'look-shop'$q$,
		$q$update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = '' where slug = 'look-shop'$q$,
		$q$update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = 'two' || chr(10) || 'lines'
			where slug = 'look-shop'$q$,
		$q$update public.qorpera_company_sites set taken_down_at = clock_timestamp(), taken_down_reason = repeat('r', 301)
			where slug = 'look-shop'$q$] loop
		perform pg_temp.base_error(v_reason, '23514');
	end loop;
	foreach v_reason in array array['', '   ', 'two' || chr(10) || 'lines', repeat('r', 301), null] loop
		perform pg_temp.base_error(format('select public.qorpera_site_take_down(%L, %L)', 'look-shop', v_reason), '22023',
			'A takedown''s reason is one line of 1 to 300 characters');
	end loop;
	perform pg_temp.base_error(format('select public.qorpera_site_take_down(%L, %L)', 'no-such-site', 'Reported'), 'P0002',
		'No site has this name');
	perform pg_temp.base_error(format('select public.qorpera_site_restore(%L)', 'no-such-site'), 'P0002', 'No site has this name');
	perform pg_temp.sh_open('h-look', 3);
	-- Down: the reason kept trimmed, the site's tickets gone, nothing else deleted.
	v := public.qorpera_site_take_down('look-shop', '  Reported as phishing. ');
	perform pg_temp.base_assert(v = '{"schema":"qorpera.site-take-down/v1","slug":"look-shop","state":"down"}'
		and (pg_temp.sh_site('look-shop')).taken_down_reason = 'Reported as phishing.' and (pg_temp.sh_site('look-shop')).taken_down_at
			is not null
		and not exists (select 1 from public.qorpera_company_site_tickets where site_id = v_site)
		and pg_temp.sh_sessions('look-shop', 'site') > 0 and pg_temp.sh_sessions('look-shop', 'next') = 1
		and pg_temp.rel_states('h-look') = '1:kept 2:live 3:ready', 'down');
	v_at := (pg_temp.sh_site('look-shop')).taken_down_at;
	-- Gone on every host of the site, with a session or without; the old host too, with hosts on or off.
	perform pg_temp.base_assert(pg_temp.sh_serve('look-shop.qorpera.com', '', v_visitor) = '{"state":"gone"}'
		and pg_temp.sh_serve('look-shop.qorpera.com') = '{"state":"gone"}'
		and pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_next) = '{"state":"gone"}'
		and pg_temp.sh_serve('look-shop--next.qorpera.com') = '{"state":"gone"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'look-shop/~' || repeat('A', 32) || '/') = '{"state":"gone"}', 'gone');
	update public.qorpera_site_settings set hosts_enabled = false;
	perform pg_temp.base_assert(pg_temp.sh_serve('sites.qorpera.com', 'look-shop/') = '{"state":"gone"}'
		and pg_temp.sh_serve('sites.qorpera.com', 'wait-shop/') = '{"state":"legacy"}', 'gone with hosts off');
	update public.qorpera_site_settings set hosts_enabled = true;
	-- The old calls: locked, wrong; the new: wrong, refused.
	perform pg_temp.base_assert(pg_temp.rel_exec(format('public.qorpera_site_serve(%L, %L, %L, null, 0, 10485760)', 'look-shop', '',
			v_visitor)) = '{"state":"locked"}'
		and pg_temp.rel_exec(format('public.qorpera_site_unlock(%L, %L, %L)', 'look-shop', pg_temp.sh_password('look-shop'),
			'192.0.2.46')) = '{"state":"wrong"}'
		and pg_temp.sh_unlock('look-shop.qorpera.com', pg_temp.sh_password('look-shop'), '192.0.2.47') = '{"state":"wrong"}', 'the passwords');
	insert into public.qorpera_company_site_tickets(ticket_sha256, site_id, version_id, user_id, expires_at)
	values (pg_temp.sh_sha(repeat('D', 43)), v_site, (select current_version_id from public.qorpera_company_sites where id = v_site),
		pg_temp.req_owner(), clock_timestamp() + interval '2 minutes');
	perform pg_temp.base_assert(pg_temp.sh_enter('look-shop--next.qorpera.com', repeat('D', 43)) = '{"state":"refused"}'
		and pg_temp.sh_open('h-look', 3) = '{"schema":"qorpera.site-preview/v1","state":"gone"}', 'no look first');
	-- Nothing goes live, nor back, and nothing is written.
	q := pg_temp.rec_shop('h-look');
	perform pg_temp.base_assert(pg_temp.rel_yes('h-look') = '{"schema":"qorpera.code-release/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'
		and pg_temp.rel_back('h-look', '{"live":2,"to":1}') = '{"schema":"qorpera.code-release/v1","state":"refused","code":"SITE_TAKEN_DOWN"}'
		and to_jsonb(pg_temp.rec_shop('h-look')) = to_jsonb(q) and pg_temp.rel_states('h-look') = '1:kept 2:live 3:ready'
		and pg_temp.rel_release('h-look', 3) is null, 'refused');
	-- Members read why, viewers too; the list file and Sites are as they were.
	v := pg_temp.sh_access(pg_temp.rel_viewer());
	perform pg_temp.base_assert(v -> 'sites' = jsonb_build_array(jsonb_build_object('siteId', v_site, 'takenDown',
			jsonb_build_object('at', v_at, 'reason', 'Reported as phishing.')),
			jsonb_build_object('siteId', (pg_temp.sh_site('wait-shop')).id, 'takenDown', null)), 'why: ' || v::text);
	perform pg_temp.base_error(format('select pg_temp.sh_access(%L)', pg_temp.rel_outsider()), '42501',
		'Only the company''s members see its sites');
	-- Taken down again: its time stays, the new reason is kept.
	perform public.qorpera_site_take_down('look-shop', 'Phishing, confirmed.');
	perform pg_temp.base_assert((pg_temp.sh_site('look-shop')).taken_down_at = v_at
		and (pg_temp.sh_site('look-shop')).taken_down_reason = 'Phishing, confirmed.', 'again');
	-- Restored: as before, sessions and all.
	perform pg_temp.base_assert(public.qorpera_site_restore('look-shop') = '{"schema":"qorpera.site-take-down/v1","slug":"look-shop","state":"up"}'
		and (pg_temp.sh_site('look-shop')).taken_down_at is null and (pg_temp.sh_site('look-shop')).taken_down_reason is null
		and pg_temp.sh_text(pg_temp.sh_serve('look-shop.qorpera.com', '', v_visitor)) = '<h1>h2</h1>'
		and pg_temp.sh_text(pg_temp.sh_serve('look-shop--next.qorpera.com', '', v_next)) = '<h1>h2</h1>'
		and pg_temp.sh_access() -> 'sites' -> 0 -> 'takenDown' = 'null', 'restored');
	perform pg_temp.base_assert(pg_temp.rel_back('h-look', '{"live":2,"to":1}') = pg_temp.rel_answer(1, 'look-shop')
			|| '{"url":"https://look-shop.qorpera.com/"}', 'back goes again');
end $$;

-- An app link taken down answers as off; restored, it answers again. Its link keeps its own host.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
values ('12520000-0000-4000-8000-0000000000a1', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'link-box', 'Runs the app', '92400000-0000-4000-8000-000000000030',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid, extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001', 2, 4294967296, 21474836480, 'standard', 'always-on');
insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind, machine_id,
	app_port, published_at, published_by_staff_agent_id)
values ('12520000-0000-4000-8000-000000000030', '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020',
	'link-app', 'link-box', '92400000-0000-4000-8000-000000000030', 'app', '12520000-0000-4000-8000-0000000000a1', 3000,
	clock_timestamp(), '92400000-0000-4000-8000-000000000030');
insert into public.qorpera_company_site_secrets (site_id, password) values ('12520000-0000-4000-8000-000000000030', 'link-app-password');
insert into public.qorpera_company_site_sessions (token_sha256, site_id, password_version, expires_at)
values (encode(extensions.digest(repeat('L', 32), 'sha256'), 'hex'), '12520000-0000-4000-8000-000000000030', 1,
	clock_timestamp() + interval '1 day');

do $$
declare v_open constant jsonb := '{"state":"open","siteId":"12520000-0000-4000-8000-000000000030"}';
begin
	update public.qorpera_site_settings set apps_enabled = true;
	perform pg_temp.base_assert(public.qorpera_site_url('link-app') = 'https://link-app-preview.qorpera.com/',
		'an app link keeps its host: ' || public.qorpera_site_url('link-app'));
	perform pg_temp.base_assert(pg_temp.sh_serve('link-app.qorpera.com', '', repeat('L', 32)) = '{"state":"none"}',
		'its name is no site host');
	perform pg_temp.base_assert(pg_temp.rel_exec(format('public.qorpera_site_app_session(%L, %L)', 'link-app', repeat('L', 32)))
		= v_open, 'its visitor''s session opens it: '
		|| pg_temp.rel_exec(format('public.qorpera_site_app_session(%L, %L)', 'link-app', repeat('L', 32)))::text);
	perform public.qorpera_site_take_down('link-app', 'Reported.');
	perform pg_temp.base_assert(pg_temp.rel_exec(format('public.qorpera_site_app_session(%L, %L)', 'link-app', repeat('L', 32)))
			= '{"state":"locked"}'
		and pg_temp.rel_exec(format('public.qorpera_site_app_unlock(%L, %L, %L)', 'link-app', 'link-app-password', '192.0.2.48'))
			= '{"state":"wrong"}'
		and (select item ->> 'state' from jsonb_array_elements(pg_temp.sh_sites()) item where item ->> 'slug' = 'link-app') = 'off',
		'an app link taken down is off');
	perform public.qorpera_site_restore('link-app');
	perform pg_temp.base_assert(pg_temp.rel_exec(format('public.qorpera_site_app_session(%L, %L)', 'link-app', repeat('L', 32))) = v_open
		and (select item ->> 'state' from jsonb_array_elements(pg_temp.sh_sites()) item where item ->> 'slug' = 'link-app') = 'live',
		'restored');
end $$;

-- 11. The drill ----------------------------------------------------------------------------------------------------------
do $$
declare v jsonb; v_w uuid := pg_temp.rec_turn(2530, 1, pg_temp.rec_sha('d1'), '{}', pg_temp.own_repo('company', 'h-drill'));
	v_base constant jsonb := '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":true,"rootLinks":true}';
	q public.qorpera_code_repositories%rowtype;
begin
	perform pg_temp.base_error(format('select public.qorpera_code_set_drill(%L, %L, %L, %L)', pg_temp.rec_here(), 'company', 'h-drill',
		'checks'), '22023', 'A drill is check, site or null');
	perform pg_temp.base_error(format('select public.qorpera_code_set_drill(%L, %L, %L, %L)', pg_temp.rec_here(), 'company', 'nowhere',
		'check'), 'P0002', 'No such repository');
	v := public.qorpera_code_set_drill(pg_temp.rec_here(), 'company', 'h-drill', 'check');
	q := pg_temp.rec_shop('h-drill');
	perform pg_temp.base_assert(v = jsonb_build_object('schema', 'qorpera.code-drill/v1', 'owner', 'company', 'name', 'h-drill',
		'drill', 'check', 'setAt', q.drill_set_at, 'takenAt', null) and q.drill = 'check', 'set: ' || v::text);
	-- Taken once, by the switch of a turn on that repository; not by another repository's.
	perform pg_temp.base_assert(pg_temp.sh_switch(pg_temp.rec_turn(2531, 1, pg_temp.rec_sha('d2'), '{}',
		pg_temp.own_repo('company', 'h-look'))) = v_base, 'another repository''s turn');
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = v_base || '{"drill":"check"}'
		and (pg_temp.rec_shop('h-drill')).drill is null and (pg_temp.rec_shop('h-drill')).drill_taken_at is not null, 'taken');
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = v_base, 'once');
	-- A check drill waits while the checks are off, a site drill while sites are off; switched on, each is taken.
	update public.qorpera_code_repositories set checks_enabled = false where environment_id = pg_temp.rec_here() and name = 'h-drill';
	perform public.qorpera_code_set_drill(pg_temp.rec_here(), 'company', 'h-drill', 'check');
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = v_base || '{"enabled":false}' and (pg_temp.rec_shop('h-drill')).drill = 'check',
		'a check drill waits for the checks');
	update public.qorpera_code_repositories set checks_enabled = true where environment_id = pg_temp.rec_here() and name = 'h-drill';
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = v_base || '{"drill":"check"}', 'then it is taken');
	update public.qorpera_code_repositories set site_enabled = false where environment_id = pg_temp.rec_here() and name = 'h-drill';
	perform public.qorpera_code_set_drill(pg_temp.rec_here(), 'company', 'h-drill', 'site');
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = v_base || '{"site":false}' and (pg_temp.rec_shop('h-drill')).drill = 'site',
		'a site drill waits for the site');
	update public.qorpera_code_repositories set site_enabled = true where environment_id = pg_temp.rec_here() and name = 'h-drill';
	-- With hosts off it rides the answer as it was.
	update public.qorpera_site_settings set hosts_enabled = false;
	perform pg_temp.base_assert(pg_temp.sh_switch(v_w) = '{"schema":"qorpera.code-checks-switch/v1","enabled":true,"site":true,"drill":"site"}',
		'a site drill, hosts off');
	update public.qorpera_site_settings set hosts_enabled = true;
	-- null clears one that waits.
	perform public.qorpera_code_set_drill(pg_temp.rec_here(), 'company', 'h-drill', 'check');
	perform pg_temp.base_assert(public.qorpera_code_set_drill(pg_temp.rec_here(), 'company', 'h-drill', null) ->> 'drill' is null
		and pg_temp.sh_switch(v_w) = v_base, 'cleared');
end $$;

-- 12. Hosts off again: the way back --------------------------------------------------------------------------------------
do $$
declare v jsonb;
begin
	update public.qorpera_site_settings set hosts_enabled = false;
	v := public.qorpera_code_release_index(pg_temp.rec_shop('h-look'));
	perform pg_temp.base_assert(public.qorpera_site_url('look-shop') = 'https://sites.qorpera.com/look-shop/'
		and (select array_agg(key order by key) from jsonb_object_keys(v) key) = array['live', 'ready']
		and v -> 'live' ->> 'url' = 'https://sites.qorpera.com/look-shop/'
		and not pg_temp.rel_read() ? 'preview'
		and pg_temp.sh_serve('sites.qorpera.com', 'look-shop/') = '{"state":"legacy"}'
		and pg_temp.sh_serve('look-shop.qorpera.com', '', current_setting('qorpera_test.sh_visitor')) = '{"state":"none"}'
		and pg_temp.sh_open('h-look', 3) = '{"schema":"qorpera.site-preview/v1","state":"off"}', 'back to the path');
end $$;

rollback;
