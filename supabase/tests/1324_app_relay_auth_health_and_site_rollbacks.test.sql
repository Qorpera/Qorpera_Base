-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.r839_as(p_user uuid) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
end $$;

create function pg_temp.r839_publish(p_slug text, p_call text, p_html text, p_review uuid default null) returns jsonb
language plpgsql as $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_sha text := encode(extensions.digest(convert_to(p_html, 'utf8'), 'sha256'), 'hex');
	v_bytes integer := octet_length(convert_to(p_html, 'utf8'));
	v_manifest text := encode(
		extensions.digest(convert_to('index.html' || chr(9) || v_sha || chr(9) || v_bytes::text, 'utf8'), 'sha256'),
		'hex'
	);
	v_begin jsonb;
	v_version uuid;
begin
	v_begin := public.qorpera_site_publish_begin(
		v_binding,
		p_call,
		jsonb_build_object(
			'slug', p_slug,
			'source', 'web',
			'title', 'Site ' || p_call,
			'manifestSha256', v_manifest,
			'files', jsonb_build_array(jsonb_build_object('path', 'index.html', 'bytes', v_bytes, 'sha256', v_sha))
		),
		p_review
	);
	v_version := (v_begin ->> 'versionId')::uuid;
	if v_begin ->> 'state' = 'uploading' then
		perform public.qorpera_site_publish_put(
			v_binding,
			v_version,
			jsonb_build_array(jsonb_build_object('path', 'index.html', 'content', encode(convert_to(p_html, 'utf8'), 'base64')))
		);
		return public.qorpera_site_publish_finish(v_binding, v_version);
	end if;
	return v_begin;
end $$;

select pg_temp.base_claims('service_role');
update public.qorpera_site_settings
set enabled = true, apps_enabled = true, hosts_enabled = true, hosts_domain = 'qorpera.com';
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'r839-ack') \g /dev/null

do $$
declare
	v_sig text;
	v_receipts jsonb;
begin
	foreach v_sig in array array[
		'public.qorpera_set_company_site_app_auth_mode(uuid,text)',
		'public.qorpera_site_list_versions(uuid)',
		'public.qorpera_site_activate_version(uuid,uuid)'
	] loop
		perform pg_temp.base_assert(
			not has_function_privilege('anon', v_sig, 'execute')
			and has_function_privilege('authenticated', v_sig, 'execute')
			and not has_function_privilege('service_role', v_sig, 'execute')
			and not has_function_privilege('qorpera_site_relay', v_sig, 'execute'),
			'Authenticated-only grant on ' || v_sig
		);
	end loop;
	foreach v_sig in array array[
		'public.qorpera_site_agent_list_versions(jsonb,text)',
		'public.qorpera_site_agent_activate_version(jsonb,text,uuid)',
		'public.qorpera_authorize_machine_app_op(jsonb,jsonb,text,text,uuid,text)'
	] loop
		perform pg_temp.base_assert(
			not has_function_privilege('anon', v_sig, 'execute')
			and not has_function_privilege('authenticated', v_sig, 'execute')
			and has_function_privilege('service_role', v_sig, 'execute')
			and not has_function_privilege('qorpera_site_relay', v_sig, 'execute'),
			'Service-role-only grant on ' || v_sig
		);
	end loop;
	perform pg_temp.base_assert(
		not has_function_privilege('anon', 'public.qorpera_site_app_resolve(text)', 'execute')
		and not has_function_privilege('authenticated', 'public.qorpera_site_app_resolve(text)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_site_app_resolve(text)', 'execute')
		and not has_function_privilege('qorpera_site_relay', 'public.qorpera_site_app_resolve(text)', 'execute'),
		'Helper qorpera_site_app_resolve is revoked from all roles'
	);
	perform pg_temp.base_assert(
		public.qorpera_site_content_type('engine.wasm') = 'application/wasm'
		and public.qorpera_site_content_type('models/hero.glb') = 'model/gltf-binary'
		and public.qorpera_site_content_type('models/hero.gltf') = 'model/gltf+json'
		and public.qorpera_site_content_type('captions/en.vtt') = 'text/vtt; charset=utf-8'
		and public.qorpera_site_content_type('docs/guide.md') = 'text/markdown; charset=utf-8'
		and public.qorpera_site_content_type('feed.rss') = 'application/rss+xml; charset=utf-8'
		and public.qorpera_site_content_type('feed.atom') = 'application/atom+xml; charset=utf-8'
		and public.qorpera_site_content_type('bad.php') is null
		and public.qorpera_site_content_type('bad.exe') is null,
		'Expanded static site MIME allowlist works'
	);
	set local role service_role;
	v_receipts := public.qorpera_record_runtime_observation_batch(
		(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
		jsonb_build_array(jsonb_build_object(
			'schema', 'qorpera.runtime-observation/v1',
			'attemptId', extensions.gen_random_uuid(),
			'parentAttemptId', null,
			'assignmentId', current_setting('qorpera_test.base_binding')::jsonb -> 'assignmentId',
			'phase', 'start',
			'operation', 'manage_site',
			'logicalOperationSha256', repeat('8', 64),
			'observedAt', '2026-11-22T06:00:00.000Z',
			'durationMs', null,
			'status', 'started',
			'errorCategory', null,
			'receiptId', null,
			'readId', null,
			'inputBytes', null,
			'outputBytes', null,
			'inputTokens', null,
			'outputTokens', null,
			'cachedInputTokens', null,
			'cacheWriteInputTokens', null,
			'reasoningOutputTokens', null,
			'totalTokens', null
		))
	);
	reset role;
	perform pg_temp.base_assert(
		v_receipts #>> '{receipts,0,schema}' = 'qorpera.runtime-observation-receipt/v1',
		'Runtime observations accept manage_site'
	);
end $$;

insert into public.qorpera_company_machines(
	id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime
) values (
	'13240000-0000-4000-8000-0000000000a1',
	'92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020',
	'relay-box',
	'Runs hosted app',
	'92400000-0000-4000-8000-000000000030',
	(current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	extensions.gen_random_uuid(),
	'92400000-0000-4000-8000-000000000001',
	2, 4294967296, 21474836480, 'standard', 'always-on'
);

insert into public.qorpera_company_sites(
	id, profile_id, environment_id, slug, title, source_path, created_by_staff_agent_id,
	kind, machine_id, app_port, published_at, published_by_staff_agent_id
) values (
	'13240000-0000-4000-8000-0000000000b1',
	'92400000-0000-4000-8000-000000000010',
	'92400000-0000-4000-8000-000000000020',
	'live-dash',
	'Live Dashboard',
	'relay-box',
	'92400000-0000-4000-8000-000000000030',
	'app',
	'13240000-0000-4000-8000-0000000000a1',
	4000,
	clock_timestamp(),
	'92400000-0000-4000-8000-000000000030'
);

insert into public.qorpera_company_site_secrets(site_id, password)
values ('13240000-0000-4000-8000-0000000000b1', 'dash-secret-password');

do $$
declare
	v_app_id uuid := '13240000-0000-4000-8000-0000000000b1';
	v_pwd_token text;
	v_pass_json jsonb;
	v_pass text;
	v_redeem jsonb;
	v_member_token text;
	v_session jsonb;
	v_key text := repeat('K', 43);
	v_prog text := repeat('P', 43);
begin
	v_pwd_token := public.qorpera_site_app_unlock('live-dash', 'dash-secret-password', '192.0.2.10') ->> 'token';
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('live-dash', v_pwd_token) = jsonb_build_object('state', 'open', 'siteId', v_app_id::text),
		'Default password mode opens with password session'
	);

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000003');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_app_auth_mode(%L, %L)', v_app_id, 'company_member'), '42501');
	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_app_auth_mode(%L, %L)', v_app_id, 'company_member'), '42501');

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_set_company_site_app_auth_mode(%L, %L)', v_app_id, 'public'), '42501', 'PUBLIC_SITES_DISABLED');
	perform pg_temp.base_assert(
		public.qorpera_set_company_site_app_auth_mode(v_app_id, 'company_member') ->> 'authMode' = 'company_member',
		'Owner switches app to company_member mode'
	);

	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('live-dash', v_pwd_token) = '{"state":"locked","authMode":"company_member"}'::jsonb,
		'Password session is invalidated in company_member mode'
	);
	perform pg_temp.base_assert(
		public.qorpera_site_app_unlock('live-dash', 'dash-secret-password', '192.0.2.10') = '{"state":"wrong"}'::jsonb,
		'Password unlock is rejected in company_member mode'
	);

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000003');
	v_pass_json := public.qorpera_site_member_pass(v_app_id);
	v_pass := v_pass_json ->> 'pass';
	perform pg_temp.base_assert(
		v_pass_json ->> 'state' = 'open'
		and v_pass_json ->> 'host' = 'live-dash-preview.qorpera.com'
		and v_pass_json ->> 'action' = 'https://live-dash-preview.qorpera.com/.qorpera/member',
		'Company member obtains pass for company_member app: ' || v_pass_json::text
	);

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error(format('select public.qorpera_site_member_pass(%L)', v_app_id), '42501');

	perform pg_temp.base_claims('service_role');
	v_session := public.qorpera_site_app_session('live-dash', v_pass);
	perform pg_temp.base_assert(
		v_session = '{"state":"locked","authMode":"company_member"}'::jsonb,
		'Unredeemed member pass is rejected by qorpera_site_app_session: ' || v_session::text
	);
	v_redeem := public.qorpera_site_app_unlock('live-dash', v_pass, '192.0.2.11');
	v_member_token := v_redeem ->> 'token';
	perform pg_temp.base_assert(
		v_redeem ->> 'state' = 'open'
		and (v_redeem ->> 'maxAge')::int = 43200
		and v_redeem ->> 'memberId' = '92400000-0000-4000-8000-000000000003',
		'Member pass redeems into 12h session: ' || v_redeem::text
	);
	perform pg_temp.base_assert(
		public.qorpera_site_app_unlock('live-dash', v_pass, '192.0.2.11') = '{"state":"wrong"}'::jsonb,
		'Member pass is one-use'
	);
	v_session := public.qorpera_site_app_session('live-dash', v_member_token);
	perform pg_temp.base_assert(
		v_session ->> 'state' = 'open'
		and v_session ->> 'authMode' = 'company_member'
		and v_session ->> 'memberId' = '92400000-0000-4000-8000-000000000003',
		'Redeemed member session opens company_member app'
	);

	update public.qorpera_site_settings set public_enabled = true, domains_enabled = true;
	insert into public.qorpera_company_site_domains(
		site_id, profile_id, hostname, is_apex, is_primary, status, verification_token
	) values
		(v_app_id, '92400000-0000-4000-8000-000000000010', 'dash.acme-test.example', false, true, 'tls_active', repeat('a', 32)),
		(v_app_id, '92400000-0000-4000-8000-000000000010', 'pending.acme-test.example', false, false, 'pending_dns', repeat('b', 32));

	update public.qorpera_company_sites set app_key_sha256 = public.qorpera_site_sha256(v_key) where id = v_app_id;
	perform pg_temp.base_assert(
		public.qorpera_site_app_connect('live-dash', v_key, v_prog) -> 'domains' = '["dash.acme-test.example"]'::jsonb
		and public.qorpera_site_app_connect('live-dash', v_key, v_prog) ->> 'authMode' = 'company_member',
		'qorpera_site_app_connect returns authMode and verified custom domains'
	);
	v_session := public.qorpera_site_app_session('dash.acme-test.example', v_member_token);
	perform pg_temp.base_assert(
		v_session ->> 'state' = 'open'
		and v_session ->> 'slug' = 'live-dash'
		and v_session ->> 'memberId' = '92400000-0000-4000-8000-000000000003',
		'Verified custom domain resolves company_member app: ' || v_session::text
	);
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('pending.acme-test.example', v_member_token) = '{"state":"locked"}'::jsonb,
		'Unverified custom domain stays locked'
	);

	delete from public.qorpera_profile_members
	where profile_id = '92400000-0000-4000-8000-000000000010'
		and user_id = '92400000-0000-4000-8000-000000000003';
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('live-dash', v_member_token) = '{"state":"locked","authMode":"company_member"}'::jsonb,
		'Removed member loses access immediately'
	);
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000003', 'viewer@example.test', 'Viewer', 'viewer');

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(
		public.qorpera_set_company_site_app_auth_mode(v_app_id, 'public') ->> 'authMode' = 'public',
		'Admin switches app to public mode'
	);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('live-dash', null) = jsonb_build_object('state', 'open', 'siteId', v_app_id::text, 'authMode', 'public')
		and public.qorpera_site_app_session('dash.acme-test.example', null) = jsonb_build_object(
			'state', 'open', 'siteId', v_app_id::text, 'authMode', 'public', 'slug', 'live-dash'
		),
		'Public mode opens without cookie on preview and custom domains'
	);
	update public.qorpera_site_settings set public_enabled = false;
	perform pg_temp.base_assert(
		public.qorpera_site_app_session('live-dash', null) = '{"state":"locked"}'::jsonb,
		'Disabling public_enabled locks public apps immediately'
	);
	update public.qorpera_site_settings set public_enabled = true;
end $$;

do $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_review_id uuid := extensions.gen_random_uuid();
	v_versions uuid[] := array[]::uuid[];
	v_res jsonb;
	v_site_id uuid;
	v_list jsonb;
	v_act jsonb;
	v_token text;
	v_i integer;
begin
	insert into public.qorpera_action_reviews(
		id, profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model,
		approver_scope, answer, answered_at, consumed_at, consumed_run_id
	) values (
		v_review_id,
		'92400000-0000-4000-8000-000000000010',
		(v_binding ->> 'runId')::uuid,
		'pub-v1',
		'92400000-0000-4000-8000-000000000030',
		'publish_site',
		'external',
		repeat('c', 64),
		jsonb_build_object(
			'title', 'Publish a new password-protected website',
			'target', null,
			'details', '{}'::jsonb,
			'arguments', jsonb_build_object('slug', 'rollback-shop', 'source', 'web')::text
		),
		'ask',
		'access_change',
		'Reviewed.',
		'gpt-6-luna',
		'owners_admins',
		'allow_once',
		clock_timestamp(),
		clock_timestamp(),
		(v_binding ->> 'runId')::uuid
	);

	for v_i in 1..12 loop
		v_res := pg_temp.r839_publish(
			'rollback-shop',
			'pub-v' || v_i,
			'<h1>Release ' || v_i || '</h1>',
			case when v_i = 1 then v_review_id else null end
		);
		v_versions := array_append(v_versions, (v_res ->> 'versionId')::uuid);
	end loop;

	select id into v_site_id from public.qorpera_company_sites where slug = 'rollback-shop';
	perform pg_temp.base_assert(
		(select count(*) from public.qorpera_company_site_versions where site_id = v_site_id) = 10
		and (select count(*) from public.qorpera_company_site_versions where site_id = v_site_id and state = 'live') = 1
		and (select count(*) from public.qorpera_company_site_versions where site_id = v_site_id and state = 'kept') = 9
		and not exists (select 1 from public.qorpera_company_site_versions where id in (v_versions[1], v_versions[2]))
		and exists (select 1 from public.qorpera_company_site_versions where id = v_versions[3]),
		'publish_site retains last 10 versions and prunes older ones'
	);

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000003');
	v_list := public.qorpera_site_list_versions(v_site_id);
	perform pg_temp.base_assert(
		v_list ->> 'schema' = 'qorpera.site-versions/v1'
		and jsonb_array_length(v_list -> 'versions') = 10
		and v_list #>> '{versions,0,id}' = v_versions[12]::text
		and (v_list #>> '{versions,0,isCurrent}')::boolean,
		'Viewer lists retained versions with current first'
	);
	perform pg_temp.base_error(format('select public.qorpera_site_activate_version(%L, %L)', v_site_id, v_versions[5]), '42501');

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000005');
	perform pg_temp.base_error(format('select public.qorpera_site_list_versions(%L)', v_site_id), '42501');
	perform pg_temp.base_error(format('select public.qorpera_site_activate_version(%L, %L)', v_site_id, v_versions[5]), '42501');

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000001');
	v_act := public.qorpera_site_activate_version(v_site_id, v_versions[5]);
	perform pg_temp.base_assert(
		v_act ->> 'schema' = 'qorpera.site-version-activate/v1'
		and v_act ->> 'versionId' = v_versions[5]::text
		and v_act ->> 'previousVersionId' = v_versions[12]::text,
		'Owner rolls back to version 5 atomically'
	);

	perform pg_temp.base_claims('service_role');
	v_token := public.qorpera_site_unlock(
		'rollback-shop',
		(select password from public.qorpera_company_site_secrets where site_id = v_site_id),
		'192.0.2.12'
	) ->> 'token';
	perform pg_temp.base_assert(
		convert_from(decode(public.qorpera_site_serve('rollback-shop', '', v_token, null, 0, 10485760) ->> 'content', 'base64'), 'utf8')
			= '<h1>Release 5</h1>'
		and (select state from public.qorpera_company_site_versions where id = v_versions[12]) = 'kept',
		'Serving rollback-shop immediately returns version 5 and keeps version 12'
	);

	v_res := pg_temp.r839_publish('rollback-shop', 'pub-v13', '<h1>Release 13</h1>');
	perform pg_temp.base_assert(
		v_res ->> 'state' = 'live'
		and (select published_by_user_id is null and published_by_staff_agent_id is not null
			from public.qorpera_company_sites where id = v_site_id),
		'Agent publish after member rollback preserves published_by constraint'
	);

	v_list := public.qorpera_site_agent_list_versions(v_binding, 'rollback-shop');
	perform pg_temp.base_assert(
		jsonb_array_length(v_list -> 'versions') = 10,
		'Agent lists retained versions'
	);
	v_act := public.qorpera_site_agent_activate_version(v_binding, 'rollback-shop', v_versions[5]);
	perform pg_temp.base_assert(
		v_act ->> 'versionId' = v_versions[5]::text,
		'Agent rolls back publish_site to kept version'
	);

	perform public.qorpera_site_take_down('rollback-shop', 'Abuse test');
	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000001');
	perform pg_temp.base_error(format('select public.qorpera_site_activate_version(%L, %L)', v_site_id, v_versions[12]), '42501', 'SITE_TAKEN_DOWN');
	perform pg_temp.base_claims('service_role');
	perform public.qorpera_site_restore('rollback-shop');
end $$;

do $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_code_site uuid := '13240000-0000-4000-8000-0000000000c1';
	v_v_kept uuid := '13240000-0000-4000-8000-0000000000c2';
	v_v_live uuid := '13240000-0000-4000-8000-0000000000c3';
	v_v_ready uuid := '13240000-0000-4000-8000-0000000000c4';
	v_list jsonb;
begin
	insert into public.qorpera_code_repositories(
		environment_id, profile_id, owner, name
	) values (
		'92400000-0000-4000-8000-000000000020',
		'92400000-0000-4000-8000-000000000010',
		'acme',
		'site-repo'
	);
	insert into public.qorpera_company_sites(
		id, profile_id, environment_id, slug, title, source_path, kind, code_owner, code_name
	) values (
		v_code_site,
		'92400000-0000-4000-8000-000000000010',
		'92400000-0000-4000-8000-000000000020',
		'code-shop',
		'Code Shop',
		'dist',
		'files',
		'acme',
		'site-repo'
	);
	insert into public.qorpera_company_site_secrets(site_id, password) values (v_code_site, 'code-shop-password');
	insert into public.qorpera_company_site_versions(
		id, site_id, first_publish, title, source_path, manifest_sha256, file_count, total_bytes,
		state, published_at, tree, change, main_sha
	) values
		(v_v_kept, v_code_site, true, 'Code v1', 'dist', repeat('1', 64), 1, 11, 'kept', clock_timestamp() - interval '2 minutes', repeat('a', 40), 1, repeat('b', 40)),
		(v_v_live, v_code_site, false, 'Code v2', 'dist', repeat('2', 64), 1, 11, 'live', clock_timestamp() - interval '1 minute', repeat('c', 40), 2, repeat('d', 40)),
		(v_v_ready, v_code_site, false, 'Code v3', 'dist', repeat('3', 64), 1, 11, 'ready', null, repeat('e', 40), 3, repeat('f', 40));
	insert into public.qorpera_company_site_files(version_id, path, bytes, sha256, content_type, content) values
		(v_v_kept, 'index.html', 11, encode(extensions.digest('<h1>c1</h1>', 'sha256'), 'hex'), 'text/html; charset=utf-8', convert_to('<h1>c1</h1>', 'utf8')),
		(v_v_live, 'index.html', 11, encode(extensions.digest('<h1>c2</h1>', 'sha256'), 'hex'), 'text/html; charset=utf-8', convert_to('<h1>c2</h1>', 'utf8')),
		(v_v_ready, 'index.html', 11, encode(extensions.digest('<h1>c3</h1>', 'sha256'), 'hex'), 'text/html; charset=utf-8', convert_to('<h1>c3</h1>', 'utf8'));
	update public.qorpera_company_sites
	set current_version_id = v_v_live, published_at = clock_timestamp(), published_by_user_id = '92400000-0000-4000-8000-000000000001'
	where id = v_code_site;

	perform pg_temp.r839_as('92400000-0000-4000-8000-000000000001');
	v_list := public.qorpera_site_list_versions(v_code_site);
	perform pg_temp.base_assert(
		jsonb_array_length(v_list -> 'versions') = 3
		and v_list #>> '{versions,0,origin}' = 'code',
		'qorpera_site_list_versions lists code site versions read-only'
	);
	perform pg_temp.base_error(
		format('select public.qorpera_site_activate_version(%L, %L)', v_code_site, v_v_kept),
		'55000',
		'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new'
	);
	perform pg_temp.base_error(
		format('select public.qorpera_site_activate_version(%L, %L)', v_code_site, v_v_ready),
		'55000',
		'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new'
	);

	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_error(
		format('select public.qorpera_site_agent_activate_version(%L, %L, %L)', v_binding, 'code-shop', v_v_kept),
		'55000',
		'SITE_FROM_CODE: this site is made from code kept in Qorpera; a member puts it live in What''s new'
	);
	perform pg_temp.base_assert(
		(select current_version_id from public.qorpera_company_sites where id = v_code_site) = v_v_live,
		'Code site current_version_id remains unchanged after refused direct activation'
	);
end $$;

do $$
declare
	v_site_id uuid;
begin
	perform pg_temp.base_claims('service_role');
	select id into v_site_id from public.qorpera_company_sites where slug = 'rollback-shop';
	update public.qorpera_company_site_versions
	set total_bytes = 26214400
	where site_id = v_site_id and state = 'kept';
	perform pg_temp.r839_publish('rollback-shop', 'pub-v14', '<h1>Release 14</h1>');
	perform pg_temp.base_assert(
		coalesce((
			select sum(v.total_bytes)
			from public.qorpera_company_site_versions as v
			join public.qorpera_company_sites as s on s.id = v.site_id
			where s.profile_id = '92400000-0000-4000-8000-000000000010' and v.tree is null and v.state = 'kept'
		), 0) <= 131072000
		and (select count(*) from public.qorpera_company_site_versions where site_id = v_site_id and state = 'kept') < 9,
		'publish_site prunes kept versions to stay within the 125 MiB per-company byte budget'
	);
end $$;

do $$
declare
	v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
	v_run_id uuid := (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
	v_machine uuid := '13240000-0000-4000-8000-0000000000a1';
	v_scope jsonb := jsonb_build_object('machineId', '13240000-0000-4000-8000-0000000000a1');
	v_auth jsonb;
	v_receipt_start uuid := '13240000-0000-4000-8000-000000000801';
	v_receipt_reload uuid := '13240000-0000-4000-8000-000000000802';
	v_receipt_stop uuid := '13240000-0000-4000-8000-000000000803';
	v_env_start text;
	v_env_reload text;
	v_env_stop text;
begin
	perform pg_temp.base_claims('service_role');
	v_auth := public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'logs');
	perform pg_temp.base_assert(
		v_auth ->> 'state' = 'refused' and v_auth ->> 'reason' = 'MACHINE_NOT_RUNNING',
		'Unplaced app machine is refused with MACHINE_NOT_RUNNING: ' || v_auth::text
	);

	perform set_config('session_replication_role', 'replica', true);
	update public.qorpera_company_machines
	set desired_state = 'running', last_used_at = clock_timestamp() - interval '1 hour'
	where id = v_machine;
	insert into public.qorpera_company_machine_placements(
		id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256, running_at, boot_id
	) values (
		'13240000-0000-4000-8000-0000000007b1',
		v_machine,
		'92400000-0000-4000-8000-000000000010',
		'mx-1324',
		repeat('8', 64),
		'{"providerId":"machine-1324"}',
		repeat('7', 64),
		clock_timestamp(),
		'13240000-0000-4000-8000-0000000007c1'
	);
	insert into public.qorpera_runtime_machine_allocations(
		id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256, reserved_at
	) values (
		'13240000-0000-4000-8000-0000000007b1',
		'92400000-0000-4000-8000-000000000010',
		'13240000-0000-4000-8000-0000000007b1',
		'lxd',
		repeat('7', 64),
		clock_timestamp()
	);
	insert into public.qorpera_runtime_node_demands(
		allocation_id, node_id, provider_kind, provider_id, policy_sha256, cpu_millis, memory_bytes, reserved_at
	) values (
		'13240000-0000-4000-8000-0000000007b1',
		'13240000-0000-4000-8000-0000000007d1',
		'machine',
		'machine-1324',
		repeat('4', 64),
		2000,
		4294967296,
		clock_timestamp()
	);
	perform set_config('session_replication_role', 'origin', true);

	v_auth := public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'logs');
	perform pg_temp.base_assert(
		v_auth ->> 'state' = 'authorized'
		and v_auth ->> 'executorOwner' = 'mx-1324'
		and v_auth ->> 'slug' = 'live-dash'
		and (v_auth ->> 'appPort')::int = 4000,
		'Running app machine authorizes logs op: ' || v_auth::text
	);
	perform pg_temp.base_assert(
		public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'health') ->> 'state' = 'authorized',
		'Read-only health op authorizes without receipt'
	);

	v_env_start := jsonb_build_object(
		'schema', 'qorpera.cloud-tool-operation/v2',
		'operation', jsonb_build_object(
			'tool', 'manage_site',
			'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', 'manage-site.start1',
			'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('action', 'app_start', 'slug', 'live-dash', 'command', 'node app.js', 'port', 4000),
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', v_machine::text)
		)
	)::text;
	v_env_reload := jsonb_build_object(
		'schema', 'qorpera.cloud-tool-operation/v2',
		'operation', jsonb_build_object(
			'tool', 'manage_site',
			'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', 'manage-site.reload1',
			'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('action', 'app_reload', 'slug', 'live-dash', 'port', 4001),
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', v_machine::text)
		)
	)::text;
	v_env_stop := jsonb_build_object(
		'schema', 'qorpera.cloud-tool-operation/v2',
		'operation', jsonb_build_object(
			'tool', 'manage_site',
			'toolVersion', 'qorpera.machine-tools/v1',
			'logicalOperationKey', 'manage-site.stop1',
			'requiresCompanyRevision', false,
			'arguments', jsonb_build_object('action', 'app_stop', 'slug', 'live-dash'),
			'target', jsonb_build_object('realm', 'company_machine', 'machineId', v_machine::text)
		)
	)::text;

	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'start'),
		'22023'
	);
	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'start', v_receipt_start, v_env_start),
		'42501',
		'Machine app receipt is unavailable'
	);

	perform public.qorpera_begin_native_tool_operation(
		v_binding,
		v_receipt_start,
		'manage_site:manage-site.start1',
		encode(extensions.digest(convert_to(v_env_start, 'UTF8'), 'sha256'), 'hex'),
		repeat('1', 64),
		false
	);
	v_auth := public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'start', v_receipt_start, v_env_start);
	perform pg_temp.base_assert(
		v_auth ->> 'state' = 'authorized'
		and v_auth ->> 'receiptId' = v_receipt_start::text
		and v_auth #>> '{arguments,command}' = 'node app.js',
		'Mutating start op authorizes with matching executing receipt: ' || v_auth::text
	);
	perform public.qorpera_site_take_down('live-dash', 'Abuse test');
	perform pg_temp.base_assert(
		public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'logs') ->> 'state' = 'authorized'
		and public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'health') ->> 'state' = 'authorized',
		'Taken-down app site still allows logs and health inspection'
	);
	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'start', v_receipt_start, v_env_start),
		'42501',
		'SITE_TAKEN_DOWN'
	);
	perform public.qorpera_complete_native_tool_operation(
		v_binding,
		v_receipt_start,
		encode(extensions.digest(convert_to(v_env_start, 'UTF8'), 'sha256'), 'hex'),
		'{}'::jsonb
	);

	perform public.qorpera_begin_native_tool_operation(
		v_binding,
		v_receipt_reload,
		'manage_site:manage-site.reload1',
		encode(extensions.digest(convert_to(v_env_reload, 'UTF8'), 'sha256'), 'hex'),
		repeat('2', 64),
		false
	);
	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'reload', v_receipt_reload, v_env_reload),
		'42501',
		'SITE_TAKEN_DOWN'
	);
	perform public.qorpera_site_restore('live-dash');
	perform pg_temp.base_assert(
		public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'reload', v_receipt_reload, v_env_reload) ->> 'state' = 'authorized',
		'Reload op authorizes with matching executing receipt once restored'
	);
	perform public.qorpera_complete_native_tool_operation(
		v_binding,
		v_receipt_reload,
		encode(extensions.digest(convert_to(v_env_reload, 'UTF8'), 'sha256'), 'hex'),
		'{}'::jsonb
	);

	perform public.qorpera_site_take_down('live-dash', 'Abuse test');
	perform public.qorpera_begin_native_tool_operation(
		v_binding,
		v_receipt_stop,
		'manage_site:manage-site.stop1',
		encode(extensions.digest(convert_to(v_env_stop, 'UTF8'), 'sha256'), 'hex'),
		repeat('3', 64),
		false
	);
	perform pg_temp.base_assert(
		public.qorpera_authorize_machine_app_op(v_binding, v_scope, 'live-dash', 'stop', v_receipt_stop, v_env_stop) ->> 'state' = 'authorized',
		'Stop op still authorizes while site is taken down'
	);
	perform public.qorpera_site_restore('live-dash');
	perform public.qorpera_complete_native_tool_operation(
		v_binding,
		v_receipt_stop,
		encode(extensions.digest(convert_to(v_env_stop, 'UTF8'), 'sha256'), 'hex'),
		'{}'::jsonb
	);
	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'stop', v_receipt_stop, v_env_stop),
		'42501',
		'Machine app receipt is unavailable'
	);

	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L)', v_binding, v_scope, 'rollback-shop', 'logs'),
		'42501'
	);
	perform pg_temp.base_error(
		format('select public.qorpera_authorize_machine_app_op(%L, %L, %L, %L)', v_binding, v_scope, 'live-dash', 'exec'),
		'22023'
	);
end $$;
