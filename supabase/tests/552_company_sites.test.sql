-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930550000 (company sites), on the folder-v2 runtime base: Alice publishes a static website to a private,
-- password-protected link. A new site goes out only on an approved built-in check of her call for that slug; an update
-- of a live site needs none. Files land checked against the size and digest the begin named, and the switch replaces
-- the old version at once. Visitors unlock with the password (wrong ones limited per address and per slug) and read
-- files only through a session of that site; an unknown slug answers as a locked one. Members list the company's sites;
-- owners and admins read and change the password (which ends every session) and unpublish. Another company's site is
-- never Alice's to see, take or remove, and the company's deletion takes its sites with it. No API role reads the
-- tables, and only the platform calls the agent's and the edge function's functions.

select pg_temp.base_claims('service_role');
update public.qorpera_site_settings set enabled = true;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'cs-ack') \g /dev/null

-- A file of a request: its path, size and digest for a text.
create function pg_temp.cs_file(p_path text, p_text text) returns jsonb language sql immutable as $$
	select jsonb_build_object('path', p_path, 'bytes', octet_length(convert_to(p_text, 'utf8')),
		'sha256', encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex'))
$$;
-- A publish request for files given as {path: text}, with its manifest as the runtime takes it.
create function pg_temp.cs_request(p_slug text, p_files jsonb, p_title text default null,
	p_source text default 'product/webshop') returns jsonb language sql immutable as $$
	select jsonb_strip_nulls(jsonb_build_object('slug', p_slug, 'title', p_title, 'source', p_source,
		'files', (select jsonb_agg(pg_temp.cs_file(f.key, f.value) order by f.key) from jsonb_each_text(p_files) as f),
		'manifestSha256', (select encode(extensions.digest(convert_to(string_agg(f.key || chr(9)
			|| (pg_temp.cs_file(f.key, f.value) ->> 'sha256') || chr(9) || octet_length(convert_to(f.value, 'utf8'))::text,
			chr(10) order by f.key collate "C"), 'utf8'), 'sha256'), 'hex') from jsonb_each_text(p_files) as f)))
$$;
-- An upload batch for files given as {path: text}.
create function pg_temp.cs_put_files(p_files jsonb) returns jsonb language sql immutable as $$
	select jsonb_agg(jsonb_build_object('path', f.key, 'content', encode(convert_to(f.value, 'utf8'), 'base64')))
	from jsonb_each_text(p_files) as f
$$;
-- A recorded review of Alice's publish_site call for a slug, as the kernel keeps it (20260926130000's columns). An
-- answered card is used by Alice's run (consumed_run_id), unless p_used is false; a reviewer's allow is of call p_call.
create function pg_temp.cs_review(p_slug text, p_decision text, p_built_in text, p_answer text default null,
	p_tool text default 'publish_site', p_staff uuid default '92400000-0000-4000-8000-000000000030',
	p_used boolean default true, p_call text default null) returns uuid
language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	insert into public.qorpera_action_reviews (id, profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, answer, answered_at,
		consumed_at, consumed_run_id)
	values (v_id, '92400000-0000-4000-8000-000000000010', (v_binding ->> 'runId')::uuid, coalesce(p_call, 'review-' || v_id),
		p_staff, p_tool, 'external', repeat('c', 64), jsonb_build_object('title', 'Publish a new password-protected website',
			'target', null, 'details', '{}'::jsonb, 'arguments', jsonb_build_object('slug', p_slug, 'source', 'product/webshop')::text),
		p_decision, p_built_in, 'Reviewed.', 'gpt-6-luna', case when p_decision = 'ask' then 'owners_admins' end, p_answer,
		case when p_answer is not null then clock_timestamp() end,
		case when p_answer in ('allow_once', 'always_allow') and p_used then clock_timestamp() end,
		case when p_answer in ('allow_once', 'always_allow') and p_used then (v_binding ->> 'runId')::uuid end);
	return v_id;
end
$$;
create function pg_temp.cs_begin(p_call text, p_request jsonb, p_review uuid default null) returns jsonb language sql as $$
	select public.qorpera_site_publish_begin(current_setting('qorpera_test.base_binding')::jsonb, p_call, p_request, p_review)
$$;
create function pg_temp.cs_as(p_user uuid) returns void language sql as $$
	select pg_temp.base_claims('authenticated', p_user)
$$;

-- 1. Who may call what ----------------------------------------------------------------------------------------------------
do $$
declare v_name text; v_signature text;
begin
	foreach v_name in array array['qorpera_site_publish_check', 'qorpera_site_publish_begin', 'qorpera_site_publish_put',
		'qorpera_site_publish_finish', 'qorpera_site_unpublish'] loop
		perform pg_temp.base_assert((select scope = 'binding' and budget = 'standard' from public.qorpera_native_host_calls
			where name = v_name), v_name || ' is the native host''s, with the run''s binding');
	end loop;
	foreach v_signature in array array['public.qorpera_site_publish_check(jsonb,text)',
		'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)', 'public.qorpera_site_publish_put(jsonb,uuid,jsonb)',
		'public.qorpera_site_publish_finish(jsonb,uuid)', 'public.qorpera_site_unpublish(jsonb,text)',
		'public.qorpera_site_serve(text,text,text,text,integer,integer)', 'public.qorpera_site_unlock(text,text,text)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_signature, 'execute')
			and not has_function_privilege('authenticated', v_signature, 'execute')
			and has_function_privilege('service_role', v_signature, 'execute'), 'Only the platform calls ' || v_signature);
	end loop;
	foreach v_signature in array array['public.qorpera_list_company_sites(uuid)', 'public.qorpera_company_site_password(uuid)',
		'public.qorpera_set_company_site_password(uuid,text)', 'public.qorpera_unpublish_company_site(uuid)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_signature, 'execute')
			and has_function_privilege('authenticated', v_signature, 'execute')
			and not has_function_privilege('service_role', v_signature, 'execute'), 'Members call ' || v_signature);
	end loop;
	foreach v_signature in array array['public.qorpera_site_new_password()', 'public.qorpera_site_url(text)',
		'public.qorpera_site_agent_run(jsonb,boolean)', 'public.qorpera_company_site_for_admin(uuid)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_signature, 'execute')
			and not has_function_privilege('authenticated', v_signature, 'execute')
			and not has_function_privilege('service_role', v_signature, 'execute'), 'No API role calls ' || v_signature);
	end loop;
	foreach v_name in array array['qorpera_site_settings', 'qorpera_company_sites', 'qorpera_company_site_secrets',
		'qorpera_company_site_versions', 'qorpera_company_site_files', 'qorpera_company_site_sessions',
		'qorpera_site_unlock_failures'] loop
		perform pg_temp.base_assert(not has_table_privilege('anon', 'public.' || v_name, 'select')
			and not has_table_privilege('authenticated', 'public.' || v_name, 'select')
			and not has_table_privilege('service_role', 'public.' || v_name, 'select')
			and not has_table_privilege('service_role', 'public.' || v_name, 'insert'), 'No API role reads ' || v_name);
	end loop;
	-- Observations name both tools, as the runtime's vocabulary does.
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''publish_site'',''unpublish_site''') > 0, 'Observations name the site tools');
end
$$;

-- 2. The switch, the check and a new site's approval ---------------------------------------------------------------------
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_check jsonb; v_begin jsonb;
	v_files jsonb := '{"index.html":"<h1>Wristbands</h1>","about.html":"<p>About</p>","img/logo.svg":"<svg/>"}';
	v_password text;
begin
	update public.qorpera_site_settings set enabled = false;
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', v_binding, 'wristband-shop'),
		'0A000', 'Publishing websites is not switched on yet');
	-- Taking a site offline is allowed with publishing switched off.
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'wristband-shop') ->> 'removed' = 'false',
		'Unpublishing nothing works while publishing is off');
	update public.qorpera_site_settings set enabled = true;

	foreach v_password in array array['ab', 'Wristband', 'shop.v2', '-shop', 'shop-', 'api', 'well-known', repeat('a', 49)] loop
		perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', v_binding, v_password), '22023');
	end loop;
	v_check := public.qorpera_site_publish_check(v_binding, 'wristband-shop');
	perform pg_temp.base_assert(v_check = jsonb_build_object('schema', 'qorpera.site-publish-check/v1', 'slug', 'wristband-shop',
		'url', 'https://sites.qorpera.com/wristband-shop/', 'mode', 'new', 'siteId', null, 'liveSource', null),
		'A free slug is a new site: ' || v_check::text);

	-- No review, a review still waiting, a denied one, one of another slug, tool or agent, or one with no built-in check:
	-- no site.
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files)),
		'42501', 'SITE_APPROVAL_REQUIRED: a new website, or a website from another folder, goes out only after an owner or admin approves it on a card');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change')), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'deny')), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('other-shop', 'ask', 'access_change', 'allow_once')), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once', 'send_mail')), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once', 'publish_site',
			'92400000-0000-4000-8000-000000000031')), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'allow', 'none')), '42501');
	-- An approval never carries over: an answer this run did not use, and a reviewer's allow of another call.
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once', p_used => false)), '42501');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'site-1', pg_temp.cs_request('wristband-shop', v_files),
		pg_temp.cs_review('wristband-shop', 'allow', 'access_change', p_call => 'another-call')), '42501');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites), 'No refused begin made a site');
	-- A reviewer's allow of this very call under a company Allow rule opens a site.
	perform pg_temp.base_assert(pg_temp.cs_begin('rule-call', pg_temp.cs_request('rule-shop', '{"index.html":"x"}'),
		pg_temp.cs_review('rule-shop', 'allow', 'access_change', p_call => 'rule-call')) ->> 'mode' = 'new',
		'An allow of this call under a company rule opens a site');
	delete from public.qorpera_company_sites where slug = 'rule-shop';

	-- The request's own checks.
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'bad', jsonb_set(pg_temp.cs_request('wristband-shop', v_files),
		'{manifestSha256}', to_jsonb(repeat('0', 64))), pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')),
		'22023', 'Site publish request is invalid');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'bad', pg_temp.cs_request('wristband-shop',
		'{"home.html":"x"}'), pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')),
		'22023', 'SITE_NO_INDEX: a site needs an index.html at its top');
	foreach v_password in array array['../index.html', '.env.html', 'a//b.html', 'a/./b.html', 'run.php', 'a b.html', '-x.html',
		'a\b.html', '/index.html', 'index.html/'] loop
		perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'bad', pg_temp.cs_request('wristband-shop',
			jsonb_build_object('index.html', 'x', v_password, 'y')), pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')),
			'22023');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'bad', jsonb_set(pg_temp.cs_request('wristband-shop',
		'{"index.html":"x"}'), '{files,0,bytes}', '10485761'), pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')),
		'22023');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'bad', jsonb_set(pg_temp.cs_request('wristband-shop',
		'{"index.html":"x"}'), '{extra}', 'true'), pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')),
		'22023', 'Site publish request is invalid');

	-- Approved on its card: the site, its password, and an upload of three files.
	v_begin := pg_temp.cs_begin('site-1', pg_temp.cs_request('wristband-shop', v_files, 'Wristbands'),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(v_begin ->> 'mode' = 'new' and v_begin ->> 'state' = 'uploading'
		and v_begin -> 'missing' = '["about.html", "img/logo.svg", "index.html"]'::jsonb
		and v_begin ->> 'url' = 'https://sites.qorpera.com/wristband-shop/' and not v_begin ? 'password',
		'The begin opens an upload: ' || v_begin::text);
	select password into v_password from public.qorpera_company_site_secrets;
	perform pg_temp.base_assert(v_password ~ '^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$',
		'The site has a new password: ' || v_password);
	perform pg_temp.base_assert(strpos(v_begin::text, v_password) = 0, 'The agent never sees the password');
	-- The same call again is the same version; a company Allow rule's allow also opens a site.
	perform pg_temp.base_assert(pg_temp.cs_begin('site-1', pg_temp.cs_request('wristband-shop', v_files, 'Wristbands')) ->> 'versionId'
		= v_begin ->> 'versionId', 'The same call answers its own version');
	perform set_config('qorpera_test.cs_version', v_begin ->> 'versionId', true);
	perform set_config('qorpera_test.cs_password', v_password, true);
end
$$;

-- 3. The bytes and the switch ------------------------------------------------------------------------------------------
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_version uuid := current_setting('qorpera_test.cs_version')::uuid; v_put jsonb; v_finish jsonb;
begin
	perform pg_temp.base_error(format('select public.qorpera_site_publish_finish(%L, %L)', v_binding, v_version),
		'55000', 'SITE_UPLOAD_INCOMPLETE: some files have no bytes yet');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_put(%L, %L, %L)', v_binding, v_version,
		pg_temp.cs_put_files('{"index.html":"<h1>Other</h1>"}')), '22023',
		'SITE_FILE_CHANGED: a file''s bytes are not the ones named when the publish began; publish again');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_put(%L, %L, %L)', v_binding, v_version,
		'[{"path":"index.html","content":"not base64!"}]'), '22023', 'Site upload is invalid');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_put(%L, %L, %L)', v_binding, v_version,
		pg_temp.cs_put_files('{"secret.html":"x"}')), '22023', 'Site upload is invalid');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_put(%L, %L, %L)', v_binding,
		extensions.gen_random_uuid(), pg_temp.cs_put_files('{"index.html":"<h1>Wristbands</h1>"}')), '55000');
	v_put := public.qorpera_site_publish_put(v_binding, v_version, pg_temp.cs_put_files('{"index.html":"<h1>Wristbands</h1>"}'));
	perform pg_temp.base_assert(v_put -> 'missing' = '["about.html", "img/logo.svg"]'::jsonb, 'One file landed: ' || v_put::text);
	v_put := public.qorpera_site_publish_put(v_binding, v_version, pg_temp.cs_put_files('{"about.html":"<p>About</p>","img/logo.svg":"<svg/>"}'));
	perform pg_temp.base_assert(v_put -> 'missing' = '[]'::jsonb, 'Every file landed');
	v_finish := public.qorpera_site_publish_finish(v_binding, v_version);
	perform pg_temp.base_assert(v_finish ->> 'state' = 'live' and v_finish ->> 'mode' = 'new' and (v_finish ->> 'files')::int = 3,
		'The site is live: ' || v_finish::text);
	perform pg_temp.base_assert(public.qorpera_site_publish_finish(v_binding, v_version) = v_finish, 'The finish again answers the same');
	perform pg_temp.base_assert((select current_version_id = v_version and published_by_staff_agent_id = '92400000-0000-4000-8000-000000000030'
		and title = 'Wristbands' from public.qorpera_company_sites where slug = 'wristband-shop'), 'The site names its live version');
	perform pg_temp.base_assert((select content_type from public.qorpera_company_site_files where version_id = v_version
		and path = 'img/logo.svg') = 'image/svg+xml', 'Each file has its type');
end
$$;

-- 4. Visitors ------------------------------------------------------------------------------------------------------------
do $$
declare v_open jsonb; v_token text; v_file jsonb; v_answer jsonb; i integer;
begin
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', '', null, null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_serve('wristband-shop', '', repeat('A', 32), null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_serve('no-such-site', '', repeat('A', 32), null, 0, 10485760) = '{"state":"locked"}'::jsonb,
		'No session, no file; an unknown slug looks the same');
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', 'wrong-password', '192.0.2.1') = '{"state":"wrong"}'::jsonb
		and public.qorpera_site_unlock('no-such-site', 'wrong-password', '192.0.2.1') = '{"state":"wrong"}'::jsonb,
		'A wrong password and an unknown slug answer the same');
	v_open := public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'), '192.0.2.1');
	v_token := v_open ->> 'token';
	perform pg_temp.base_assert(v_open ->> 'state' = 'open' and v_token ~ '^[A-Za-z0-9_-]{32}$' and (v_open ->> 'maxAge')::int = 604800
		and (select expires_at between clock_timestamp() + interval '6 days 23 hours' and clock_timestamp() + interval '7 days'
			from public.qorpera_company_site_sessions where token_sha256 = encode(extensions.digest(v_token, 'sha256'), 'hex')),
		'The password opens a session: ' || v_open::text);
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_sessions where token_sha256 = v_token)
		and not exists (select 1 from public.qorpera_site_unlock_failures where client_sha256 like '%192.0.2.1%'),
		'Only digests are kept');
	v_file := public.qorpera_site_serve('wristband-shop', '', v_token, null, 0, 10485760);
	perform pg_temp.base_assert(v_file ->> 'state' = 'file' and v_file ->> 'path' = 'index.html'
		and v_file ->> 'contentType' = 'text/html; charset=utf-8'
		and convert_from(decode(v_file ->> 'content', 'base64'), 'utf8') = '<h1>Wristbands</h1>', 'The home page: ' || v_file::text);
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', 'index.html', v_token, v_file ->> 'sha256', 0, 10485760) -> 'content'
		= 'null'::jsonb, 'A matching ETag carries no content');
	-- A byte range carries just its bytes; none asked for (a HEAD, a check) carries none; past the end, none.
	v_answer := public.qorpera_site_serve('wristband-shop', '', v_token, null, 4, 5);
	perform pg_temp.base_assert(v_answer ->> 'offset' = '4' and convert_from(decode(v_answer ->> 'content', 'base64'), 'utf8') = 'Wrist'
		and (v_answer ->> 'bytes')::int = 19, 'A range: ' || v_answer::text);
	v_answer := public.qorpera_site_serve('wristband-shop', '', v_token, null, 0, 0);
	perform pg_temp.base_assert(v_answer -> 'content' = 'null'::jsonb and v_answer ->> 'sha256' = v_file ->> 'sha256', 'No bytes');
	v_answer := public.qorpera_site_serve('wristband-shop', '', v_token, null, 50, 10);
	perform pg_temp.base_assert(v_answer -> 'content' = 'null'::jsonb and v_answer ->> 'offset' = '19', 'Past the end: ' || v_answer::text);
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', 'img', v_token, null, 0, 10485760)
		= '{"state":"missing"}'::jsonb, 'A folder without an index is missing');
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', 'img/logo.svg', v_token, null, 0, 10485760) ->> 'contentType'
		= 'image/svg+xml', 'A file in a folder');
	foreach v_answer in array array[public.qorpera_site_serve('wristband-shop', '../secret', v_token, null, 0, 10485760),
		public.qorpera_site_serve('wristband-shop', 'nothing.html', v_token, null, 0, 10485760)] loop
		perform pg_temp.base_assert(v_answer = '{"state":"missing"}'::jsonb, 'A path that is not the site''s: ' || v_answer::text);
	end loop;
	perform set_config('qorpera_test.cs_token', v_token, true);

	-- Ten wrong passwords from one address: that address waits, another does not.
	for i in 1..10 loop perform public.qorpera_site_unlock('wristband-shop', 'guess-' || i, '198.51.100.7'); end loop;
	v_answer := public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'), '198.51.100.7');
	perform pg_temp.base_assert(v_answer ->> 'state' = 'limited' and (v_answer ->> 'retryAfter')::int between 1 and 900,
		'The address is limited, even with the right password: ' || v_answer::text);
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'),
		'198.51.100.8') ->> 'state' = 'open', 'Another address is not');
	-- 300 wrong ones for the slug in an hour: everyone waits, and open sessions still read.
	insert into public.qorpera_site_unlock_failures (slug, client_sha256)
	select 'wristband-shop', encode(extensions.digest(n::text, 'sha256'), 'hex') from generate_series(1, 290) as n;
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'),
		'203.0.113.9') ->> 'state' = 'limited', 'The slug is limited');
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', '', v_token, null, 0, 10485760) ->> 'state' = 'file',
		'An open session still reads');
	delete from public.qorpera_site_unlock_failures;
	-- 30 wrong ones from one network across slugs: that network waits on every slug; an IPv6 /64 is one network.
	for i in 1..32 loop
		perform public.qorpera_site_unlock('guess-' || (i % 4), 'guess', '2001:db8:aa:bb::' || to_hex(i));
	end loop;
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'),
		'2001:db8:aa:bb::99') ->> 'state' = 'limited', 'The /64 is limited on every slug');
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'),
		'2001:db8:aa:cc::1') ->> 'state' = 'open', 'Another /64 is not');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_site_unlock_failures where client_sha256
		= encode(extensions.digest('2001:db8:aa:bb::', 'sha256'), 'hex')), 'A network is kept only as its HMAC');
	delete from public.qorpera_site_unlock_failures;
end
$$;

-- 5. An update ---------------------------------------------------------------------------------------------------------
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_begin jsonb; v_finish jsonb; v_draft jsonb;
	v_files jsonb := '{"index.html":"<h1>Wristbands 2</h1>","about.html":"<p>About</p>","img/logo.svg":"<svg/>"}';
begin
	perform pg_temp.base_assert(public.qorpera_site_publish_check(v_binding, 'wristband-shop') ->> 'mode' = 'update',
		'The live site is an update');
	-- The same files, and no title (an update keeps the site's): nothing to publish.
	v_begin := pg_temp.cs_begin('site-same', pg_temp.cs_request('wristband-shop',
		'{"index.html":"<h1>Wristbands</h1>","about.html":"<p>About</p>","img/logo.svg":"<svg/>"}'));
	perform pg_temp.base_assert(v_begin ->> 'state' = 'live' and (v_begin ->> 'unchanged')::boolean and v_begin ->> 'mode' = 'update',
		'Unchanged: ' || v_begin::text);
	-- One open upload a site: a newer publish replaces an unfinished one.
	v_draft := pg_temp.cs_begin('site-2a', pg_temp.cs_request('wristband-shop', '{"index.html":"<h1>Draft</h1>"}', 'Wristbands'));
	-- No approval needed; the files the live version has are copied, only the changed one is missing.
	v_begin := pg_temp.cs_begin('site-2', pg_temp.cs_request('wristband-shop', v_files, 'Wristbands'));
	perform pg_temp.base_assert(v_begin ->> 'mode' = 'update' and v_begin -> 'missing' = '["index.html"]'::jsonb,
		'An update uploads only what changed: ' || v_begin::text);
	perform pg_temp.base_error(format('select public.qorpera_site_publish_put(%L, %L, %L)', v_binding, v_draft ->> 'versionId',
		pg_temp.cs_put_files('{"index.html":"<h1>Draft</h1>"}')), '55000', 'SITE_UPLOAD_GONE: this upload is no longer open; publish again');
	-- The same call with other files is refused.
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L)', 'site-2', pg_temp.cs_request('wristband-shop',
		'{"index.html":"<h1>Else</h1>"}', 'Wristbands')), '22023',
		'SITE_SOURCE_CHANGED: the files changed since this call began; call publish_site again');
	-- Until the switch, visitors see the old version.
	perform pg_temp.base_assert(convert_from(decode(public.qorpera_site_serve('wristband-shop', '',
		current_setting('qorpera_test.cs_token'), null, 0, 10485760) ->> 'content', 'base64'), 'utf8') = '<h1>Wristbands</h1>', 'The old version');
	perform public.qorpera_site_publish_put(v_binding, (v_begin ->> 'versionId')::uuid,
		pg_temp.cs_put_files('{"index.html":"<h1>Wristbands 2</h1>"}'));
	v_finish := public.qorpera_site_publish_finish(v_binding, (v_begin ->> 'versionId')::uuid);
	perform pg_temp.base_assert(v_finish ->> 'mode' = 'update' and v_finish ->> 'state' = 'live', 'Updated: ' || v_finish::text);
	perform pg_temp.base_assert(convert_from(decode(public.qorpera_site_serve('wristband-shop', '',
		current_setting('qorpera_test.cs_token'), null, 0, 10485760) ->> 'content', 'base64'), 'utf8') = '<h1>Wristbands 2</h1>'
		and (select count(*) from public.qorpera_company_site_versions) = 1
		and (select count(*) from public.qorpera_company_site_files) = 3
		and (select title from public.qorpera_company_sites where slug = 'wristband-shop') = 'Wristbands',
		'The new version replaced the old one whole');
	-- From another folder, the live site is published only on an approval.
	perform pg_temp.base_assert(public.qorpera_site_publish_check(v_binding, 'wristband-shop') ->> 'liveSource' = 'product/webshop',
		'The check names the live source');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L)', 'site-3', pg_temp.cs_request('wristband-shop', v_files,
		null, 'product/other')), '42501');
	perform pg_temp.base_assert(pg_temp.cs_begin('site-3', pg_temp.cs_request('wristband-shop', v_files, null, 'product/other'),
		pg_temp.cs_review('wristband-shop', 'ask', 'access_change', 'allow_once')) ->> 'mode' = 'update',
		'With its approval, from another folder');
end
$$;

-- 6. Members -----------------------------------------------------------------------------------------------------------
do $$
declare v_site uuid := (select id from public.qorpera_company_sites where slug = 'wristband-shop'); v_list jsonb; v_password jsonb;
begin
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000003');
	v_list := public.qorpera_list_company_sites('92400000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(jsonb_array_length(v_list) = 1 and v_list -> 0 ->> 'url' = 'https://sites.qorpera.com/wristband-shop/'
		and v_list -> 0 ->> 'state' = 'live' and (v_list -> 0 ->> 'files')::int = 3 and v_list #>> '{0,publishedBy,name}' = 'Alice'
		and v_list -> 0 ->> 'schema' = 'qorpera.company-site/v1' and strpos(v_list::text, current_setting('qorpera_test.cs_password')) = 0
		and (select array_agg(key order by key collate "C") from jsonb_object_keys(v_list -> 0) as key) = array['bytes', 'createdAt', 'files', 'id',
			'passwordChangedAt', 'publishedAt', 'publishedBy', 'schema', 'slug', 'source', 'state', 'title', 'url'],
		'A viewer lists the site, never its password: ' || v_list::text);
	perform pg_temp.base_error(format('select public.qorpera_company_site_password(%L)', v_site), '42501');
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000002');
	perform pg_temp.base_error(format('select public.qorpera_company_site_password(%L)', v_site), '42501');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_password(%L, null)', v_site), '42501');
	perform pg_temp.base_error(format('select public.qorpera_unpublish_company_site(%L)', v_site), '42501');
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error(format('select public.qorpera_list_company_sites(%L)', '92400000-0000-4000-8000-000000000010'), '42501');
	perform pg_temp.base_error(format('select public.qorpera_company_site_password(%L)', v_site), '42501');

	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000004');
	v_password := public.qorpera_company_site_password(v_site);
	perform pg_temp.base_assert(v_password ->> 'password' = current_setting('qorpera_test.cs_password')
		and v_password ->> 'siteId' = v_site::text, 'An admin reads the password');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_password(%L, %L)', v_site, 'short'), '22023',
		'A site password is 10 to 128 characters');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_password(%L, %L)', v_site, '          '), '22023');
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000001');
	v_password := public.qorpera_set_company_site_password(v_site, 'friends of the wristband');
	perform pg_temp.base_assert(v_password ->> 'password' = 'friends of the wristband', 'The owner sets a password');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', '', current_setting('qorpera_test.cs_token'), null, 0, 10485760)
		= '{"state":"locked"}'::jsonb and not exists (select 1 from public.qorpera_company_site_sessions),
		'A new password ends every session');
	perform pg_temp.base_assert(public.qorpera_site_unlock('wristband-shop', current_setting('qorpera_test.cs_password'), '192.0.2.5')
		->> 'state' = 'wrong' and public.qorpera_site_unlock('wristband-shop', 'friends of the wristband', '192.0.2.5') ->> 'state'
		= 'open', 'Only the new password opens it');
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_assert(public.qorpera_set_company_site_password(v_site, null) ->> 'password'
		~ '^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$', 'Or makes a new one');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 7. Another company ---------------------------------------------------------------------------------------------------
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('55200000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('55200000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000005', 'base-outsider@example.test', 'Outsider', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('55200000-0000-4000-8000-000000000020', '55200000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
values ('55200000-0000-4000-8000-000000000030', '55200000-0000-4000-8000-000000000010', '55200000-0000-4000-8000-000000000020',
	'other-shop', 'web', '55200000-0000-4000-8000-000000000040');
insert into public.qorpera_company_site_secrets (site_id, password) values ('55200000-0000-4000-8000-000000000030', 'other-company-pw');
insert into public.qorpera_company_site_versions (id, site_id, state, run_id, call_id, staff_agent_id, first_publish, source_path,
	manifest_sha256, file_count, total_bytes, published_at)
values ('55200000-0000-4000-8000-000000000050', '55200000-0000-4000-8000-000000000030', 'live', extensions.gen_random_uuid(), 'c',
	'55200000-0000-4000-8000-000000000040', true, 'web', repeat('d', 64), 1, 5, clock_timestamp());
insert into public.qorpera_company_site_files (version_id, path, bytes, sha256, content_type, content)
values ('55200000-0000-4000-8000-000000000050', 'index.html', 5, encode(extensions.digest('other', 'sha256'), 'hex'),
	'text/html; charset=utf-8', convert_to('other', 'utf8'));
update public.qorpera_company_sites set current_version_id = '55200000-0000-4000-8000-000000000050', published_at = clock_timestamp(),
	published_by_staff_agent_id = '55200000-0000-4000-8000-000000000040' where id = '55200000-0000-4000-8000-000000000030';

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_token text; v_list jsonb;
begin
	-- Alice can neither take its name, nor overwrite it, nor take it offline.
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', v_binding, 'other-shop'), '55000',
		'SITE_NAME_TAKEN: another site already has this name; choose another');
	perform pg_temp.base_error(format('select pg_temp.cs_begin(%L, %L, %L)', 'take', pg_temp.cs_request('other-shop', '{"index.html":"x"}'),
		pg_temp.cs_review('other-shop', 'ask', 'access_change', 'allow_once')), '55000');
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'other-shop') ->> 'removed' = 'false'
		and exists (select 1 from public.qorpera_company_sites where slug = 'other-shop'), 'Another company''s site stays');
	-- Its session never reads Alice's site, and Alice's never reads it.
	v_token := public.qorpera_site_unlock('other-shop', 'other-company-pw', '192.0.2.9') ->> 'token';
	perform pg_temp.base_assert(public.qorpera_site_serve('wristband-shop', '', v_token, null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_serve('other-shop', '', v_token, null, 0, 10485760) ->> 'state' = 'file', 'A session is its site''s only');
	-- Each company's members see their own sites only, and never another's password.
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000005');
	v_list := public.qorpera_list_company_sites('55200000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(jsonb_array_length(v_list) = 1 and v_list -> 0 ->> 'slug' = 'other-shop' and v_list #> '{0,publishedBy}'
		= 'null'::jsonb, 'The other company lists its own site: ' || v_list::text);
	perform pg_temp.base_error(format('select public.qorpera_unpublish_company_site(%L)',
		(select id from public.qorpera_company_sites where slug = 'wristband-shop')), '42501');
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_company_site_password(%L)', '55200000-0000-4000-8000-000000000030'), '42501');
	perform pg_temp.base_claims('service_role');

	-- A site whose first upload never finished frees its name a day after its last change.
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id, updated_at)
	values ('55200000-0000-4000-8000-000000000010', '55200000-0000-4000-8000-000000000020', 'old-draft', 'web',
		'55200000-0000-4000-8000-000000000040', clock_timestamp() - interval '2 days');
	perform pg_temp.base_assert(public.qorpera_site_publish_check(v_binding, 'old-draft') ->> 'mode' = 'new', 'An abandoned name is free');

	-- While the company is being deleted its sites are locked, and its members see none.
	insert into public.qorpera_company_deletions (profile_id) values ('55200000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(public.qorpera_site_serve('other-shop', '', v_token, null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_unlock('other-shop', 'other-company-pw', '192.0.2.10') ->> 'state' = 'wrong',
		'A company being deleted serves nothing');
	-- Its purge takes the sites, their files, password and sessions.
	perform public.qorpera_purge_company('55200000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites where profile_id = '55200000-0000-4000-8000-000000000010')
		and not exists (select 1 from public.qorpera_company_site_versions where id = '55200000-0000-4000-8000-000000000050')
		and not exists (select 1 from public.qorpera_company_site_files where version_id = '55200000-0000-4000-8000-000000000050')
		and not exists (select 1 from public.qorpera_company_site_secrets where site_id = '55200000-0000-4000-8000-000000000030')
		and not exists (select 1 from public.qorpera_company_site_sessions where site_id = '55200000-0000-4000-8000-000000000030')
		and exists (select 1 from public.qorpera_company_sites where slug = 'wristband-shop'), 'The purge took its sites, and only its');
end
$$;

-- 8. Unpublishing ------------------------------------------------------------------------------------------------------
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_site uuid; v_token text;
begin
	select id into v_site from public.qorpera_company_sites where slug = 'wristband-shop';
	perform pg_temp.cs_as('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(public.qorpera_unpublish_company_site(v_site) ->> 'removed' = 'true', 'An admin takes it offline');
	perform pg_temp.base_assert(public.qorpera_unpublish_company_site(v_site) ->> 'removed' = 'false', 'Again: already gone');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_versions)
		and not exists (select 1 from public.qorpera_company_site_files) and not exists (select 1 from public.qorpera_company_site_secrets),
		'Its files and password went with it');
	-- The agent's unpublish: Alice's own site, by its slug.
	insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'second-site', 'web',
		'92400000-0000-4000-8000-000000000030');
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'second-site') = jsonb_build_object('schema',
		'qorpera.site-unpublish/v1', 'slug', 'second-site', 'removed', true), 'Alice takes her company''s site offline');
	perform pg_temp.base_error(format('select public.qorpera_site_unpublish(%L, %L)', v_binding, '../x'), '22023');
end
$$;

rollback;
