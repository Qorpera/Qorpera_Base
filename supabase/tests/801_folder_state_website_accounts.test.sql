-- @fixture 704_folder_state_connections.test.sql until "-- 1. The company, and the platform writing its first connection file"
-- Company state files, A1-7b (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §2 "connections/<name>.md", §8 "Plan
-- (A1-7)"): a website account's connection file. Its parse carries site, twoStep and openedFor and may be pending or
-- need a person; any other connection keeps its exact shape, so a member's edit of an old file's text still passes.

-- Two website accounts in the vault, as A1's broker opens them (connector website, active while it is open).
insert into public.qorpera_cloud_secrets(id,profile_id,environment_id,broker_authority_id,owner_kind,connector_id,secret_name,purpose,
	status,current_version,created_by_user_id,account_label,available_to_all_agents) values
	('80100000-0000-4000-8000-0000000000f1','70400000-0000-4000-8000-000000000010','70400000-0000-4000-8000-000000000020','70400000-0000-4000-8000-0000000000d1','company','website','portal','Supplier portal','active',1,'70400000-0000-4000-8000-000000000001','ops@nordlys.test',true);

-- A website account's file, as A1's vault writer writes it.
create function pg_temp.site_parse(p_set jsonb default '{}') returns jsonb language sql as $$
	select jsonb_build_object('kind','connection','id','80100000-0000-4000-8000-0000000000f1','service','website','account','ops@nordlys.test',
		'status','pending','actions','[]'::jsonb,'connectedBy','70400000-0000-4000-8000-0000000000c0','connectedAt','2026-10-02T08:00:00Z',
		'site','portal.example.com','twoStep','authenticator','openedFor','80100000-0000-4000-8000-0000000000d1','purpose','') || p_set
$$;
create function pg_temp.site_text(p_parse jsonb) returns text language sql as $$
	select format(E'---\nid: %s\nservice: website\naccount: %s\nstatus: %s\nactions: []\nconnected_by: %s\nconnected_at: %s\nsite: %s\ntwo_step: %s\n%s---\n%s',
		p_parse ->> 'id', p_parse ->> 'account', p_parse ->> 'status', p_parse ->> 'connectedBy', p_parse ->> 'connectedAt',
		p_parse ->> 'site', p_parse ->> 'twoStep',
		case when p_parse ->> 'openedFor' is null then '' else format(E'opened_for: %s\n', p_parse ->> 'openedFor') end,
		p_parse ->> 'purpose')
$$;
create function pg_temp.site_write(p_parse jsonb) returns jsonb language sql as $$
	select pg_temp.write('connections/portal.md', 'connection', pg_temp.site_text(p_parse), p_parse, pg_temp.version('connections/portal.md'))
$$;
create function pg_temp.problems(p_parse jsonb) returns integer language sql as $$
	select jsonb_array_length(public.qorpera_company_state_parse_problems('connection', p_parse))
$$;

-- 1. The platform writes a website account's file through its states; a member writes its text only -------------------

do $$
declare r jsonb; i integer; s text;
begin
	r := pg_temp.commit(pg_temp.platform(), 'site-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','vision'), pg_temp.vision('Nordlys Connections'),
		jsonb_build_object('op','mkdir','path','agents'),
		pg_temp.write('agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70400000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder'),
		jsonb_build_object('op','mkdir','path','connections'),
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test')));
	for i in 1..7 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	-- Opened, waiting for a person, connected, broken: each a platform save of the same file.
	foreach s in array array['pending','needs_person','connected','broken'] loop
		perform pg_temp.expect(pg_temp.commit(pg_temp.platform(), 'site-state-' || s, jsonb_build_array(
			pg_temp.site_write(pg_temp.site_parse(jsonb_build_object('status', s))))), 1, 'saved');
	end loop;
	if (pg_temp.idx('80100000-0000-4000-8000-0000000000f1')).folder_path is distinct from 'connections/portal.md' then
		raise exception 'A website account''s file is indexed like any connection: %', to_jsonb(pg_temp.idx('80100000-0000-4000-8000-0000000000f1')); end if;
	-- A member writes the text below the settings, on a website file and on a file whose shape did not change.
	r := pg_temp.commit(pg_temp.member(), 'site-0002', jsonb_build_array(
		pg_temp.site_write(pg_temp.site_parse('{"status":"broken","purpose":"The supplier portal."}')),
		pg_temp.conn('hello', '70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test', 'The shared inbox.')));
	perform pg_temp.expect(r, 1, 'saved'); perform pg_temp.expect(r, 2, 'saved');
	-- But never the settings: not the state, not the site.
	r := pg_temp.commit(pg_temp.member(), 'site-0003', jsonb_build_array(
		pg_temp.site_write(pg_temp.site_parse('{"status":"connected","purpose":"The supplier portal."}')),
		pg_temp.site_write(pg_temp.site_parse('{"status":"broken","site":"evil.example.com","purpose":"The supplier portal."}'))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_rule'); perform pg_temp.expect(r, 2, 'refused', 'structured_rule');
	-- A website account's own states belong to website files: a gmail file stays connected or broken.
	r := pg_temp.commit(pg_temp.platform(), 'site-0004', jsonb_build_array(
		pg_temp.write('connections/hello.md', 'connection', 'x', pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e1', 'gmail',
			'hello@nordlys.test', 'The shared inbox.') || '{"status":"pending"}', pg_temp.version('connections/hello.md'))));
	perform pg_temp.expect(r, 1, 'refused', 'structured_invalid');
	if coalesce(r -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '') not like '%read this file differently%(status)%' then
		raise exception 'The refusal names the status: %', r; end if;
end $$;

-- 2. The shapes: a website file's three keys and states, and every other file's unchanged shape -----------------------

do $$
declare t record; gmail constant jsonb := pg_temp.conn_parse('70400000-0000-4000-8000-0000000000e1', 'gmail', 'hello@nordlys.test');
begin
	for t in select * from (values
		(pg_temp.site_parse(), 0), (pg_temp.site_parse('{"openedFor":null}'), 0), (pg_temp.site_parse('{"status":"needs_person"}'), 0),
		(pg_temp.site_parse('{"twoStep":"none"}'), 0), (pg_temp.site_parse('{"twoStep":"email"}'), 0), (pg_temp.site_parse('{"twoStep":"sms"}'), 0),
		(pg_temp.site_parse(jsonb_build_object('site', repeat('a', 64) || '.com')), 0),
		(pg_temp.site_parse(jsonb_build_object('site', repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 61))), 0),
		(gmail, 0), (gmail || '{"status":"broken"}', 0),
		-- The keys: all three on a website file, none on any other.
		(pg_temp.site_parse() - 'site', 1), (pg_temp.site_parse() - 'twoStep', 1), (pg_temp.site_parse() - 'openedFor', 1),
		(pg_temp.site_parse('{"note":"x"}'), 1), (gmail || '{"site":"example.com"}', 1), (gmail || '{"twoStep":"none"}', 1),
		(gmail || '{"openedFor":null}', 1),
		(pg_temp.site_parse('{"service":"gmail"}'), 1),
		-- The site, by the vault's host rule.
		(pg_temp.site_parse('{"site":"Portal.example.com"}'), 1), (pg_temp.site_parse('{"site":"example"}'), 1),
		(pg_temp.site_parse('{"site":"-a.example.com"}'), 1), (pg_temp.site_parse('{"site":"a-.example.com"}'), 1),
		(pg_temp.site_parse('{"site":"a..example.com"}'), 1), (pg_temp.site_parse('{"site":"a.example.com."}'), 1),
		(pg_temp.site_parse('{"site":"a_b.example.com"}'), 1), (pg_temp.site_parse('{"site":"https://example.com"}'), 1),
		(pg_temp.site_parse('{"site":"example.com:443"}'), 1), (pg_temp.site_parse('{"site":null}'), 1), (pg_temp.site_parse('{"site":7}'), 1),
		(pg_temp.site_parse(jsonb_build_object('site', repeat('a', 65) || '.com')), 1),
		(pg_temp.site_parse(jsonb_build_object('site', repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 62))), 1),
		-- The two-step method, the todo, the states.
		(pg_temp.site_parse('{"twoStep":"phone"}'), 1), (pg_temp.site_parse('{"twoStep":null}'), 1),
		(pg_temp.site_parse('{"openedFor":"todo-1"}'), 1), (pg_temp.site_parse('{"openedFor":7}'), 1),
		(pg_temp.site_parse('{"status":"closed"}'), 1), (pg_temp.site_parse('{"status":null}'), 1),
		(gmail || '{"status":"pending"}', 1), (gmail || '{"status":"needs_person"}', 1)) v(parse, problems)
	loop
		if pg_temp.problems(t.parse) is distinct from t.problems then
			raise exception 'Parse % expected % problems, got %', t.parse, t.problems,
				public.qorpera_company_state_parse_problems('connection', t.parse); end if;
	end loop;
end $$;

rollback;
