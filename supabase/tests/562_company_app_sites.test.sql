-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- 20260930562000 (private app links), on the folder-v2 runtime base: Alice shares a port of the company's always-on
-- machine as a private app link, https://<slug>-preview.qorpera.com/. A new link, and a live one moved to another
-- machine or port, goes out only on an approved built-in check of her share_app call for that slug, and a move cuts the
-- connected program off; a task machine, a removed or deleted one and another company's never. Each share issues a
-- claim (15 minutes) that the link program trades for its connection key; the claim stays redeemable for 2 minutes
-- after its first use, each redemption's key replacing the last, and a newer share ends it. Visitors unlock with the
-- site's password through the app unlock (the website unlock never opens an app link) and the relay asks for their
-- session; connect and session name the site's id. The site function never serves an app link. Either switch off, the
-- machine removed or being deleted, or the company being deleted, the link answers as locked. Alice's unpublish turns
-- the link off and keeps its name and password for the next share; an admin's unpublish takes it away whole. Members
-- list it with its kind, machine and port. Another company's name, and a website's name, is never Alice's to share,
-- and a website never takes an app link's name. The relay's own role runs only its three calls and reads no table.

select pg_temp.base_claims('service_role');
update public.qorpera_site_settings set enabled = true, apps_enabled = true;
select pg_temp.base_public_send(current_setting('qorpera_test.base_binding')::jsonb, 'progress', 'ca-ack') \g /dev/null

-- The company's machines: two always-on, a task machine and a removed one.
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, desired_state, removed_at)
select machine.id, '92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', machine.name, 'Runs the shop',
	'92400000-0000-4000-8000-000000000030', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000001', 2, 4294967296, 21474836480, 'standard', machine.lifetime,
	machine.state, machine.removed
from (values ('56200000-0000-4000-8000-0000000000a1'::uuid, 'shop-box', 'always-on', 'running', null::timestamptz),
	('56200000-0000-4000-8000-0000000000a2'::uuid, 'spare-box', 'always-on', 'running', null::timestamptz),
	('56200000-0000-4000-8000-0000000000a3'::uuid, 'build-box', 'task', 'running', null::timestamptz),
	('56200000-0000-4000-8000-0000000000a4'::uuid, 'old-box', 'always-on', 'deleted', clock_timestamp()))
	as machine(id, name, lifetime, state, removed);

-- A share request.
create function pg_temp.ca_request(p_slug text, p_machine text default 'shop-box', p_port integer default 3000,
	p_title text default null) returns jsonb language sql immutable as $$
	select jsonb_strip_nulls(jsonb_build_object('slug', p_slug, 'title', p_title, 'machine', p_machine, 'port', p_port))
$$;
-- A recorded review of Alice's share_app call for a slug, as 552's cs_review makes one for publish_site.
create function pg_temp.ca_review(p_slug text, p_decision text, p_built_in text, p_answer text default null,
	p_tool text default 'share_app', p_staff uuid default '92400000-0000-4000-8000-000000000030',
	p_used boolean default true, p_call text default null) returns uuid
language plpgsql as $$
declare v_id uuid := extensions.gen_random_uuid(); v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb;
begin
	insert into public.qorpera_action_reviews (id, profile_id, run_id, call_id, staff_agent_id, tool_name, effect,
		argument_sha256, action, decision, built_in, reason, reviewer_model, approver_scope, answer, answered_at,
		consumed_at, consumed_run_id)
	values (v_id, '92400000-0000-4000-8000-000000000010', (v_binding ->> 'runId')::uuid, coalesce(p_call, 'review-' || v_id),
		p_staff, p_tool, 'external', repeat('c', 64), jsonb_build_object('title', 'Share a private app link',
			'target', null, 'details', '{}'::jsonb, 'arguments', jsonb_build_object('slug', p_slug, 'machine', 'shop-box', 'port', 3000)::text),
		p_decision, p_built_in, 'Reviewed.', 'gpt-6-luna', case when p_decision = 'ask' then 'owners_admins' end, p_answer,
		case when p_answer is not null then clock_timestamp() end,
		case when p_answer in ('allow_once', 'always_allow') and p_used then clock_timestamp() end,
		case when p_answer in ('allow_once', 'always_allow') and p_used then (v_binding ->> 'runId')::uuid end);
	return v_id;
end
$$;
create function pg_temp.ca_share(p_call text, p_request jsonb, p_review uuid default null) returns jsonb language sql as $$
	select public.qorpera_site_share_app(current_setting('qorpera_test.base_binding')::jsonb, p_call, p_request, p_review)
$$;
create function pg_temp.ca_check(p_slug text, p_machine text default 'shop-box', p_port integer default 3000) returns jsonb
language sql as $$
	select public.qorpera_site_share_check(current_setting('qorpera_test.base_binding')::jsonb, p_slug, p_machine, p_port)
$$;
create function pg_temp.ca_as(p_user uuid) returns void language sql as $$
	select pg_temp.base_claims('authenticated', p_user)
$$;
create function pg_temp.ca_sha(p_text text) returns text language sql immutable as $$
	select encode(extensions.digest(convert_to(p_text, 'utf8'), 'sha256'), 'hex')
$$;
create function pg_temp.ca_keys(p_value jsonb) returns text[] language sql immutable as $$
	select array_agg(key order by key collate "C") from jsonb_object_keys(p_value) as key
$$;
-- A site's id as connect and session name it.
create function pg_temp.ca_site(p_slug text) returns text language sql as $$
	select id::text from public.qorpera_company_sites where slug = p_slug
$$;
-- The answer to a key that connects.
create function pg_temp.ca_ok(p_slug text, p_port integer) returns jsonb language sql as $$
	select jsonb_build_object('state', 'ok', 'key', null, 'port', p_port, 'siteId', pg_temp.ca_site(p_slug))
$$;
-- A publish of one index.html for a slug, as the runtime sends it.
create function pg_temp.ca_publish(p_slug text) returns jsonb language sql immutable as $$
	select jsonb_build_object('slug', p_slug, 'source', 'web', 'files', jsonb_build_array(jsonb_build_object('path', 'index.html',
		'bytes', 1, 'sha256', pg_temp.ca_sha('x'))), 'manifestSha256', pg_temp.ca_sha('index.html' || chr(9) || pg_temp.ca_sha('x') || chr(9) || '1'))
$$;

-- 1. Who may call what ----------------------------------------------------------------------------------------------------
do $$
declare v_name text; v_signature text; v_bad text;
begin
	foreach v_name in array array['qorpera_site_share_check', 'qorpera_site_share_app'] loop
		perform pg_temp.base_assert((select scope = 'binding' and budget = 'standard' from public.qorpera_native_host_calls
			where name = v_name), v_name || ' is the native host''s, with the run''s binding');
	end loop;
	foreach v_signature in array array['public.qorpera_site_share_check(jsonb,text,text,integer)',
		'public.qorpera_site_share_app(jsonb,text,jsonb,uuid)', 'public.qorpera_site_app_connect(text,text)',
		'public.qorpera_site_app_session(text,text)', 'public.qorpera_site_app_unlock(text,text,text)',
		'public.qorpera_site_publish_check(jsonb,text)', 'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)',
		'public.qorpera_site_unpublish(jsonb,text)', 'public.qorpera_site_serve(text,text,text,text,integer,integer)',
		'public.qorpera_site_unlock(text,text,text)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_signature, 'execute')
			and not has_function_privilege('authenticated', v_signature, 'execute')
			and has_function_privilege('service_role', v_signature, 'execute'), 'Only the platform calls ' || v_signature);
	end loop;
	perform pg_temp.base_assert(not has_function_privilege('anon', 'public.qorpera_list_company_sites(uuid)', 'execute')
		and has_function_privilege('authenticated', 'public.qorpera_list_company_sites(uuid)', 'execute')
		and not has_function_privilege('service_role', 'public.qorpera_list_company_sites(uuid)', 'execute'), 'Members list sites');
	foreach v_signature in array array['public.qorpera_site_app_live(public.qorpera_company_sites)',
		'public.qorpera_site_new_secret()', 'public.qorpera_site_url(text)',
		'public.qorpera_site_abandoned(public.qorpera_company_sites)'] loop
		perform pg_temp.base_assert(not has_function_privilege('anon', v_signature, 'execute')
			and not has_function_privilege('authenticated', v_signature, 'execute')
			and not has_function_privilege('service_role', v_signature, 'execute'), 'No API role calls ' || v_signature);
	end loop;
	perform pg_temp.base_assert(not has_table_privilege('anon', 'public.qorpera_company_site_app_claims', 'select')
		and not has_table_privilege('authenticated', 'public.qorpera_company_site_app_claims', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_site_app_claims', 'select')
		and not has_table_privilege('service_role', 'public.qorpera_company_site_app_claims', 'insert'),
		'No API role reads the claims');
	-- The relay's role: no login, the relay's three calls and nothing else of the sites, and no table.
	perform pg_temp.base_assert((select not rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls and not rolcreaterole
		from pg_roles where rolname = 'qorpera_site_relay') and has_schema_privilege('qorpera_site_relay', 'public', 'usage'),
		'The relay has a role of its own');
	select string_agg(p.oid::regprocedure::text, ', ') into v_bad from pg_proc as p
	where p.pronamespace = 'public'::regnamespace
		and (p.proname like 'qorpera\_site\_%' or p.proname in ('qorpera_list_company_sites', 'qorpera_company_site_password',
			'qorpera_set_company_site_password', 'qorpera_unpublish_company_site', 'qorpera_company_site_for_admin'))
		and has_function_privilege('qorpera_site_relay', p.oid, 'execute')
			<> (p.proname in ('qorpera_site_app_connect', 'qorpera_site_app_session', 'qorpera_site_app_unlock'));
	perform pg_temp.base_assert(v_bad is null, 'The relay runs its three calls only: ' || coalesce(v_bad, ''));
	select string_agg(c.oid::regclass::text, ', ') into v_bad from pg_class as c
	where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p', 'f')
		and has_table_privilege('qorpera_site_relay', c.oid, 'select');
	perform pg_temp.base_assert(v_bad is null, 'The relay reads no table: ' || coalesce(v_bad, ''));
	-- Every replaced body names this migration; the website unlock is 20260930550000's; observations name share_app.
	foreach v_signature in array array['public.qorpera_site_url(text)', 'public.qorpera_site_abandoned(public.qorpera_company_sites)',
		'public.qorpera_site_publish_check(jsonb,text)', 'public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)',
		'public.qorpera_site_unpublish(jsonb,text)', 'public.qorpera_list_company_sites(uuid)',
		'public.qorpera_site_serve(text,text,text,text,integer,integer)', 'public.qorpera_site_share_app(jsonb,text,jsonb,uuid)'] loop
		perform pg_temp.base_assert(strpos(pg_get_functiondef(v_signature::regprocedure), '20260930562000') > 0,
			v_signature || ' names 20260930562000');
	end loop;
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_site_unlock(text,text,text)'::regprocedure), '20260930562000') = 0,
		'The website unlock is as 20260930550000 wrote it');
	perform pg_temp.base_assert(strpos(pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
		'''publish_site'',''unpublish_site'',/* 20260930562000 */''share_app''') > 0, 'Observations name share_app');
	perform pg_temp.base_assert((select apps_enabled = true and app_host_suffix = '-preview.qorpera.com'
		from public.qorpera_site_settings), 'The suffix is the previews''');
end
$$;

-- 2. The switches and the check ------------------------------------------------------------------------------------------
do $$
declare v_slug text;
begin
	update public.qorpera_site_settings set apps_enabled = false;
	perform pg_temp.base_error(format('select pg_temp.ca_check(%L)', 'shop-preview'), '0A000', 'Sharing app links is not switched on yet');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-0', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once')), '0A000', 'Sharing app links is not switched on yet');
	update public.qorpera_site_settings set apps_enabled = true, enabled = false;
	perform pg_temp.base_error(format('select pg_temp.ca_check(%L)', 'shop-preview'), '0A000', 'Publishing websites is not switched on yet');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-0', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once')), '0A000', 'Publishing websites is not switched on yet');
	update public.qorpera_site_settings set enabled = true;
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites), 'No switched-off share made a link');

	foreach v_slug in array array['ab', 'Shop', 'shop.v2', '-shop', 'shop-', 'api', 'well-known', repeat('a', 49)] loop
		perform pg_temp.base_error(format('select pg_temp.ca_check(%L)', v_slug), '22023');
	end loop;
	perform pg_temp.base_error('select pg_temp.ca_check(''shop-preview'', ''shop-box'', 0)', '22023', 'Site share request is invalid');
	perform pg_temp.base_error('select pg_temp.ca_check(''shop-preview'', ''shop-box'', 65536)', '22023', 'Site share request is invalid');
	perform pg_temp.base_error('select pg_temp.ca_check(''shop-preview'', ''shop-box'', null)', '22023', 'Site share request is invalid');
	perform pg_temp.base_assert(pg_temp.ca_check('shop-preview')
		= '{"state":"new","needsReview":true,"url":"https://shop-preview-preview.qorpera.com/"}'::jsonb,
		'A free slug is a new link: ' || pg_temp.ca_check('shop-preview')::text);
	-- A machine share_app would refuse is refused before any card: none of that name, a removed one, a task machine.
	perform pg_temp.base_assert(pg_temp.ca_check('shop-preview', 'no-box')
			= '{"state":"refused","reason":"APP_MACHINE_NOT_FOUND","needsReview":false}'::jsonb
		and pg_temp.ca_check('shop-preview', 'old-box') = '{"state":"refused","reason":"APP_MACHINE_NOT_FOUND","needsReview":false}'::jsonb
		and pg_temp.ca_check('shop-preview', null) = '{"state":"refused","reason":"APP_MACHINE_NOT_FOUND","needsReview":false}'::jsonb
		and pg_temp.ca_check('shop-preview', 'build-box')
			= '{"state":"refused","reason":"APP_MACHINE_NOT_ALWAYS_ON","needsReview":false}'::jsonb,
		'Machines share_app refuses are refused by the check');
end
$$;

-- 3. The request, the machine and a new link's approval ----------------------------------------------------------------
do $$
declare v_request jsonb; v_name text; v_share jsonb; v_again jsonb; v_password text;
begin
	-- The request's own checks.
	foreach v_request in array array[pg_temp.ca_request('shop-preview') || '{"extra":true}', pg_temp.ca_request('shop-preview') - 'machine',
		pg_temp.ca_request('shop-preview') - 'port', pg_temp.ca_request('shop-preview', p_port => 0),
		pg_temp.ca_request('shop-preview', p_port => 65536), jsonb_set(pg_temp.ca_request('shop-preview'), '{port}', '"3000"'),
		jsonb_set(pg_temp.ca_request('shop-preview'), '{port}', '3000.5'), jsonb_set(pg_temp.ca_request('shop-preview'), '{machine}', '7'),
		pg_temp.ca_request('shop-preview', p_title => repeat('t', 121)), '[]'::jsonb] loop
		perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'bad', v_request), '22023', 'Site share request is invalid');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'bad', pg_temp.ca_request('api')), '22023');
	-- The machine: the company's own, not removed, and always-on.
	foreach v_name in array array['no-box', 'old-box'] loop
		perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-m', pg_temp.ca_request('shop-preview', v_name),
			pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once')), '22023',
			'APP_MACHINE_NOT_FOUND: the company has no machine of that name; start an always-on one with machine_start');
	end loop;
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-m', pg_temp.ca_request('shop-preview', 'build-box'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once')), '55000',
		'APP_MACHINE_NOT_ALWAYS_ON: a task machine sleeps when its task is done, so its link would stop; share from an always-on machine');

	-- No review, a review still waiting, a denied one, one of another slug, tool or agent, or one with no built-in check:
	-- no link.
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'share-1', pg_temp.ca_request('shop-preview')), '42501',
		'SITE_APPROVAL_REQUIRED: a new app link, or an app link from another machine or port, goes out only after an owner or admin approves it on a card');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change')), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'deny')), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('other-preview', 'ask', 'access_change', 'allow_once')), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once', 'publish_site')), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once', 'share_app',
			'92400000-0000-4000-8000-000000000031')), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'allow', 'none')), '42501');
	-- An approval never carries over: an answer this run did not use, and a reviewer's allow of another call.
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once', p_used => false)), '42501');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-1', pg_temp.ca_request('shop-preview'),
		pg_temp.ca_review('shop-preview', 'allow', 'access_change', p_call => 'another-call')), '42501');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites)
		and not exists (select 1 from public.qorpera_company_site_app_claims), 'No refused share made a link');
	-- A reviewer's allow of this very call under a company Allow rule opens a link.
	perform pg_temp.base_assert((pg_temp.ca_share('rule-call', pg_temp.ca_request('rule-preview'),
		pg_temp.ca_review('rule-preview', 'allow', 'access_change', p_call => 'rule-call')) ->> 'firstShare')::boolean,
		'An allow of this call under a company rule opens a link');
	delete from public.qorpera_company_sites where slug = 'rule-preview';

	-- Approved on its card: the link, its password and a claim.
	v_share := pg_temp.ca_share('share-1', pg_temp.ca_request('shop-preview', p_title => 'Shop preview'),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(pg_temp.ca_keys(v_share) = array['claim', 'claimExpiresAt', 'clientUrl', 'connectUrl', 'firstShare',
			'machine', 'newPassword', 'port', 'slug', 'url']
		and v_share ->> 'slug' = 'shop-preview' and v_share ->> 'url' = 'https://shop-preview-preview.qorpera.com/'
		and v_share ->> 'machine' = 'shop-box' and v_share -> 'port' = '3000'::jsonb and v_share -> 'firstShare' = 'true'::jsonb
		and v_share -> 'newPassword' = 'true'::jsonb and v_share ->> 'claim' ~ '^[A-Za-z0-9_-]{43}$'
		and (v_share ->> 'claimExpiresAt')::timestamptz between clock_timestamp() + interval '14 minutes' and clock_timestamp() + interval '15 minutes'
		and v_share ->> 'clientUrl' = 'https://shop-preview-preview.qorpera.com/.qorpera/client.mjs'
		and v_share ->> 'connectUrl' = 'wss://shop-preview-preview.qorpera.com/.qorpera/connect', 'The link is shared: ' || v_share::text);
	perform pg_temp.base_assert((select kind = 'app' and machine_id = '56200000-0000-4000-8000-0000000000a1' and app_port = 3000
		and title = 'Shop preview' and source_path = 'shop-box' and published_at is not null
		and published_by_staff_agent_id = '92400000-0000-4000-8000-000000000030' and app_key_sha256 is null
		and current_version_id is null from public.qorpera_company_sites where slug = 'shop-preview'), 'The site is an app link');
	select secret.password into v_password from public.qorpera_company_site_secrets as secret
	join public.qorpera_company_sites as site on site.id = secret.site_id where site.slug = 'shop-preview';
	perform pg_temp.base_assert(v_password ~ '^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$'
		and strpos(v_share::text, v_password) = 0, 'The link has a new password the agent never sees: ' || v_password);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_company_site_app_claims
			where claim_sha256 = pg_temp.ca_sha(v_share ->> 'claim') and used_at is null and first_share and new_password
				and call_id = 'share-1')
		and not exists (select 1 from public.qorpera_company_site_app_claims where claim_sha256 = v_share ->> 'claim'),
		'Only the claim''s digest is kept');
	-- The same call again: the same link, as that call answered (a new password included), with a fresh claim.
	v_again := pg_temp.ca_share('share-1', pg_temp.ca_request('shop-preview', p_title => 'Shop preview'));
	perform pg_temp.base_assert(v_again - 'claim' - 'claimExpiresAt' = v_share - 'claim' - 'claimExpiresAt'
		and v_again ->> 'claim' <> v_share ->> 'claim' and (select count(*) from public.qorpera_company_sites) = 1,
		'The same call answers the same link with a fresh claim: ' || v_again::text);
	perform set_config('qorpera_test.ca_claim_1', v_share ->> 'claim', true);
	perform set_config('qorpera_test.ca_claim_2', v_again ->> 'claim', true);
	perform set_config('qorpera_test.ca_password', v_password, true);
end
$$;

-- 4. The link program's connection ---------------------------------------------------------------------------------------
do $$
declare v_claim text := current_setting('qorpera_test.ca_claim_2'); v_answer jsonb; v_key text; v_again text; v_key2 text;
	v_share jsonb; v_site text := pg_temp.ca_site('shop-preview');
begin
	-- An ended claim, an unknown slug, a wrong or malformed secret: all refused alike.
	foreach v_answer in array array[public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_claim_1')),
		public.qorpera_site_app_connect('no-such-app', v_claim), public.qorpera_site_app_connect('shop-preview', repeat('A', 43)),
		public.qorpera_site_app_connect('shop-preview', 'short'), public.qorpera_site_app_connect('shop-preview', null),
		public.qorpera_site_app_connect('Shop-preview', v_claim), public.qorpera_site_app_connect('shop-preview', v_claim || '=')] loop
		perform pg_temp.base_assert(v_answer = '{"state":"refused"}'::jsonb, 'Refused: ' || v_answer::text);
	end loop;
	-- The claim: a new key, of which only the digest is kept, and the site's id.
	v_answer := public.qorpera_site_app_connect('shop-preview', v_claim);
	v_key := v_answer ->> 'key';
	perform pg_temp.base_assert(pg_temp.ca_keys(v_answer) = array['key', 'port', 'siteId', 'state'] and v_answer ->> 'state' = 'ok'
		and v_key ~ '^[A-Za-z0-9_-]{43}$' and v_key <> v_claim and v_answer -> 'port' = '3000'::jsonb and v_answer ->> 'siteId' = v_site,
		'The claim is traded for a key: ' || v_answer::text);
	perform pg_temp.base_assert((select app_key_sha256 = pg_temp.ca_sha(v_key) from public.qorpera_company_sites where slug = 'shop-preview')
		and (select used_at is not null and expires_at between clock_timestamp() + interval '1 minute' and clock_timestamp() + interval '2 minutes'
			from public.qorpera_company_site_app_claims where claim_sha256 = pg_temp.ca_sha(v_claim)),
		'The key''s digest is kept and the claim has 2 minutes more');
	-- For those 2 minutes the claim connects again (an answer lost on the way), each time with a new key in place of the
	-- last: only the newest program connects.
	v_again := public.qorpera_site_app_connect('shop-preview', v_claim) ->> 'key';
	perform pg_temp.base_assert(v_again ~ '^[A-Za-z0-9_-]{43}$' and v_again <> v_key
		and public.qorpera_site_app_connect('shop-preview', v_key) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', v_again) = pg_temp.ca_ok('shop-preview', 3000),
		'The claim again: a new key in place of the last');
	update public.qorpera_company_site_app_claims set expires_at = clock_timestamp() - interval '1 second'
	where claim_sha256 = pg_temp.ca_sha(v_claim);
	perform pg_temp.base_assert(public.qorpera_site_app_connect('shop-preview', v_claim) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', v_again) = pg_temp.ca_ok('shop-preview', 3000),
		'After its 2 minutes the claim is refused; the key reconnects');
	v_key := v_again;
	-- An expired claim is refused, and the key still works: sharing the same machine and port again needs no approval
	-- and keeps the connected program.
	v_share := pg_temp.ca_share('share-2', pg_temp.ca_request('shop-preview'));
	perform pg_temp.base_assert(v_share -> 'firstShare' = 'false'::jsonb and v_share -> 'newPassword' = 'false'::jsonb
		and v_share ->> 'machine' = 'shop-box', 'Sharing the live link again needs no approval: ' || v_share::text);
	update public.qorpera_company_site_app_claims set created_at = created_at - interval '20 minutes',
		expires_at = clock_timestamp() - interval '1 second' where claim_sha256 = pg_temp.ca_sha(v_share ->> 'claim');
	perform pg_temp.base_assert(public.qorpera_site_app_connect('shop-preview', v_share ->> 'claim') = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', v_key) = pg_temp.ca_ok('shop-preview', 3000), 'An expired claim is refused');
	-- Another port is another service: only on an approval, and the connected program is cut off at once.
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'share-3', pg_temp.ca_request('shop-preview', p_port => 8080)),
		'42501', 'SITE_APPROVAL_REQUIRED: a new app link, or an app link from another machine or port, goes out only after an owner or admin approves it on a card');
	v_share := pg_temp.ca_share('share-3', pg_temp.ca_request('shop-preview', p_port => 8080),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(v_share -> 'port' = '8080'::jsonb and v_share -> 'firstShare' = 'false'::jsonb
		and public.qorpera_site_app_connect('shop-preview', v_key) = '{"state":"refused"}'::jsonb
		and (select app_key_sha256 is null from public.qorpera_company_sites where slug = 'shop-preview'),
		'A new port cuts the old program off');
	v_key2 := public.qorpera_site_app_connect('shop-preview', v_share ->> 'claim') ->> 'key';
	perform pg_temp.base_assert(v_key2 ~ '^[A-Za-z0-9_-]{43}$'
		and public.qorpera_site_app_connect('shop-preview', v_key2) = pg_temp.ca_ok('shop-preview', 8080),
		'The new program connects to the new port');
	perform set_config('qorpera_test.ca_key', v_key2, true);
end
$$;

-- 5. An update from another machine, and the names a link cannot take -------------------------------------------------------
insert into public.qorpera_company_sites (profile_id, environment_id, slug, source_path, created_by_staff_agent_id)
values ('92400000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000020', 'files-site', 'web',
	'92400000-0000-4000-8000-000000000030');
insert into public.qorpera_company_site_secrets (site_id, password)
select id, 'files-site-password' from public.qorpera_company_sites where slug = 'files-site';

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_share jsonb; v_check jsonb; v_key text;
begin
	v_check := pg_temp.ca_check('shop-preview', 'shop-box', 8080);
	perform pg_temp.base_assert(v_check = '{"state":"update","needsReview":false,"machine":"shop-box","port":8080,
		"url":"https://shop-preview-preview.qorpera.com/"}'::jsonb, 'The live link is an update, with its machine and port: ' || v_check::text);
	v_check := pg_temp.ca_check('shop-preview', 'spare-box', 8080);
	perform pg_temp.base_assert(v_check - 'url' = '{"state":"update","needsReview":true,"machine":"shop-box","port":8080}'::jsonb
		and (pg_temp.ca_check('shop-preview', 'shop-box', 3000) ->> 'needsReview')::boolean,
		'From another machine or port, the update needs approval: ' || v_check::text);
	-- From another machine, only on an approval; the connected program is cut off at once.
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'share-4', pg_temp.ca_request('shop-preview', 'spare-box', 8080)),
		'42501', 'SITE_APPROVAL_REQUIRED: a new app link, or an app link from another machine or port, goes out only after an owner or admin approves it on a card');
	v_share := pg_temp.ca_share('share-4', pg_temp.ca_request('shop-preview', 'spare-box', 8080),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(v_share ->> 'machine' = 'spare-box' and v_share -> 'firstShare' = 'false'::jsonb
		and v_share -> 'newPassword' = 'false'::jsonb
		and pg_temp.ca_check('shop-preview', 'spare-box', 8080) - 'url' = '{"state":"update","needsReview":false,"machine":"spare-box","port":8080}'::jsonb
		and (pg_temp.ca_check('shop-preview', 'shop-box', 8080) ->> 'needsReview')::boolean
		and (select title = 'Shop preview' and source_path = 'spare-box' and app_key_sha256 is null
			from public.qorpera_company_sites where slug = 'shop-preview')
		and public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb,
		'The link moved to another machine, and the old program is cut off: ' || v_share::text);
	v_key := public.qorpera_site_app_connect('shop-preview', v_share ->> 'claim') ->> 'key';
	perform pg_temp.base_assert(v_key is not null, 'The program on the other machine connects');
	perform set_config('qorpera_test.ca_key', v_key, true);

	-- A website of the company is never shared as an app link, and a website never takes an app link's name.
	perform pg_temp.base_assert(pg_temp.ca_check('files-site') - 'url' = '{"state":"taken","needsReview":false}'::jsonb, 'A website''s name is taken');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'share-f', pg_temp.ca_request('files-site'),
		pg_temp.ca_review('files-site', 'ask', 'access_change', 'allow_once')), '55000',
		'SITE_NAME_TAKEN: a website of the company has this name; choose another name for the app link');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', v_binding, 'shop-preview'), '55000',
		'SITE_NAME_TAKEN: an app link of the company has this name; choose another');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_begin(%L, %L, %L, %L)', v_binding, 'pub-1',
		pg_temp.ca_publish('shop-preview'), pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once', 'publish_site')),
		'55000', 'SITE_NAME_TAKEN: an app link of the company has this name; choose another');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_site_versions), 'No files version on an app link');
	perform pg_temp.base_assert((select kind = 'files' and machine_id is null from public.qorpera_company_sites where slug = 'files-site'),
		'The website is as it was');
	-- A website has no machine, port or key; an app link has a port, never a files version, and no key while it is off.
	perform pg_temp.base_error('update public.qorpera_company_sites set app_port = 80 where slug = ''files-site''', '23514');
	perform pg_temp.base_error('update public.qorpera_company_sites set kind = ''app'' where slug = ''files-site''', '23514');
	perform pg_temp.base_error('update public.qorpera_company_sites set published_at = null, published_by_staff_agent_id = null
		where slug = ''shop-preview''', '23514');
end
$$;

-- 6. Visitors --------------------------------------------------------------------------------------------------------------
do $$
declare v_password text := current_setting('qorpera_test.ca_password'); v_open jsonb; v_token text;
	v_site uuid := (select id from public.qorpera_company_sites where slug = 'shop-preview'); v_opened jsonb;
begin
	v_opened := jsonb_build_object('state', 'open', 'siteId', v_site::text);
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', null) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_session('shop-preview', repeat('A', 32)) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_session('no-such-app', repeat('A', 32)) = '{"state":"locked"}'::jsonb,
		'No session, no app; an unknown slug looks the same');
	perform pg_temp.base_assert(public.qorpera_site_app_unlock('shop-preview', 'wrong-password', '192.0.2.1') = '{"state":"wrong"}'::jsonb
		and public.qorpera_site_app_unlock('no-such-app', 'wrong-password', '192.0.2.1') = '{"state":"wrong"}'::jsonb,
		'A wrong password and an unknown slug answer the same');
	-- The website unlock never opens an app link, nor the app unlock a website.
	perform pg_temp.base_assert(public.qorpera_site_unlock('shop-preview', v_password, '192.0.2.6') = '{"state":"wrong"}'::jsonb
		and public.qorpera_site_app_unlock('files-site', 'files-site-password', '192.0.2.6') = '{"state":"wrong"}'::jsonb,
		'Each unlock is its kind''s');
	v_open := public.qorpera_site_app_unlock('shop-preview', v_password, '192.0.2.1');
	v_token := v_open ->> 'token';
	perform pg_temp.base_assert(v_open ->> 'state' = 'open' and v_token ~ '^[A-Za-z0-9_-]{32}$' and (v_open ->> 'maxAge')::int = 604800
		and exists (select 1 from public.qorpera_company_site_sessions where site_id = v_site and token_sha256 = pg_temp.ca_sha(v_token)),
		'The password opens a session of the app link: ' || v_open::text);
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = v_opened, 'The session is open, with the site''s id');
	-- The site function never serves an app link, and the session opens no other site.
	perform pg_temp.base_assert(public.qorpera_site_serve('shop-preview', '', v_token, null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_serve('shop-preview', 'index.html', v_token, null, 0, 10485760) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_session('files-site', v_token) = '{"state":"locked"}'::jsonb, 'An app link is the relay''s alone');
	-- The app unlock has the website unlock's limits, on the same rows.
	perform public.qorpera_site_app_unlock('shop-preview', 'guess-' || i, '198.51.100.7') from generate_series(1, 10) as i;
	perform pg_temp.base_assert(public.qorpera_site_app_unlock('shop-preview', v_password, '198.51.100.7') ->> 'state' = 'limited'
		and public.qorpera_site_app_unlock('shop-preview', v_password, '198.51.100.8') ->> 'state' = 'open'
		and (select count(*) from public.qorpera_site_unlock_failures where slug = 'shop-preview') >= 10, 'The limits hold');
	delete from public.qorpera_site_unlock_failures;

	-- App links switched off: locked, refused, and the password opens nothing; on again, the session is open again.
	update public.qorpera_site_settings set apps_enabled = false;
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_unlock('shop-preview', v_password, '192.0.2.2') = '{"state":"wrong"}'::jsonb, 'App links off');
	update public.qorpera_site_settings set apps_enabled = true, enabled = false;
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_unlock('shop-preview', v_password, '192.0.2.3') = '{"state":"wrong"}'::jsonb, 'Sites off');
	update public.qorpera_site_settings set enabled = true;
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = v_opened
		and public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = pg_temp.ca_ok('shop-preview', 8080),
		'Both on again: open');

	-- Its machine being deleted (not yet removed): the link does not answer, as share_app no longer takes the machine.
	update public.qorpera_company_machines set desired_state = 'deleted' where id = '56200000-0000-4000-8000-0000000000a2';
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_unlock('shop-preview', v_password, '192.0.2.4') = '{"state":"wrong"}'::jsonb
		and pg_temp.ca_check('shop-preview') - 'url' = '{"state":"new","needsReview":true}'::jsonb
		and pg_temp.ca_check('shop-preview', 'spare-box', 8080)
			= '{"state":"refused","reason":"APP_MACHINE_NOT_FOUND","needsReview":false}'::jsonb,
		'A machine being deleted takes its link down');
	update public.qorpera_company_machines set desired_state = 'running' where id = '56200000-0000-4000-8000-0000000000a2';
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = v_opened, 'Back');

	-- A new password ends every session.
	perform pg_temp.ca_as('92400000-0000-4000-8000-000000000001');
	perform public.qorpera_set_company_site_password(v_site, 'friends of the shop');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_unlock('shop-preview', v_password, '192.0.2.5') = '{"state":"wrong"}'::jsonb,
		'A new password ends the session');
	v_token := public.qorpera_site_app_unlock('shop-preview', 'friends of the shop', '192.0.2.5') ->> 'token';
	perform pg_temp.base_assert(public.qorpera_site_app_session('shop-preview', v_token) = v_opened, 'The new password opens it');
	perform set_config('qorpera_test.ca_password', 'friends of the shop', true);
	perform set_config('qorpera_test.ca_token', v_token, true);
end
$$;

-- 7. Members -------------------------------------------------------------------------------------------------------------
do $$
declare v_list jsonb; v_app jsonb; v_files jsonb; v_site uuid := (select id from public.qorpera_company_sites where slug = 'shop-preview');
begin
	perform pg_temp.ca_as('92400000-0000-4000-8000-000000000003');
	v_list := public.qorpera_list_company_sites('92400000-0000-4000-8000-000000000010');
	select item.value into v_app from jsonb_array_elements(v_list) as item(value) where item.value ->> 'slug' = 'shop-preview';
	select item.value into v_files from jsonb_array_elements(v_list) as item(value) where item.value ->> 'slug' = 'files-site';
	perform pg_temp.base_assert(jsonb_array_length(v_list) = 2 and pg_temp.ca_keys(v_app) = array['bytes', 'createdAt', 'files', 'id',
			'kind', 'machine', 'passwordChangedAt', 'port', 'publishedAt', 'publishedBy', 'schema', 'slug', 'source', 'state', 'title', 'url']
		and v_app ->> 'kind' = 'app' and v_app ->> 'machine' = 'spare-box' and v_app -> 'port' = '8080'::jsonb
		and v_app ->> 'url' = 'https://shop-preview-preview.qorpera.com/' and v_app ->> 'state' = 'live' and v_app ->> 'title' = 'Shop preview'
		and v_app ->> 'source' = 'spare-box' and v_app -> 'files' = '0'::jsonb and v_app -> 'bytes' = '0'::jsonb
		and v_app #>> '{publishedBy,name}' = 'Alice' and v_app ->> 'schema' = 'qorpera.company-site/v1'
		and strpos(v_list::text, current_setting('qorpera_test.ca_password')) = 0,
		'A viewer lists the app link, never its password: ' || v_list::text);
	perform pg_temp.base_assert(pg_temp.ca_keys(v_files) = pg_temp.ca_keys(v_app) and v_files ->> 'kind' = 'files'
		and v_files -> 'machine' = 'null'::jsonb and v_files -> 'port' = 'null'::jsonb
		and v_files ->> 'url' = 'https://sites.qorpera.com/files-site/' and v_files ->> 'state' = 'publishing',
		'A website lists as before: ' || v_files::text);
	-- Its machine gone, or being deleted, the row says so.
	update public.qorpera_company_machines set desired_state = 'deleted' where id = '56200000-0000-4000-8000-0000000000a2';
	select item.value into v_app from jsonb_array_elements(public.qorpera_list_company_sites('92400000-0000-4000-8000-000000000010'))
		as item(value) where item.value ->> 'slug' = 'shop-preview';
	perform pg_temp.base_assert(v_app ->> 'state' = 'off' and v_app -> 'machine' = 'null'::jsonb and v_app ->> 'source' = 'spare-box',
		'A link whose machine is being deleted is off: ' || v_app::text);
	update public.qorpera_company_machines set removed_at = clock_timestamp() where id = '56200000-0000-4000-8000-0000000000a2';
	select item.value into v_app from jsonb_array_elements(public.qorpera_list_company_sites('92400000-0000-4000-8000-000000000010'))
		as item(value) where item.value ->> 'slug' = 'shop-preview';
	perform pg_temp.base_assert(v_app ->> 'state' = 'off' and v_app -> 'machine' = 'null'::jsonb, 'A link whose machine is gone is off');
	update public.qorpera_company_machines set desired_state = 'running', removed_at = null where id = '56200000-0000-4000-8000-0000000000a2';
	-- Owners and admins read the link's password, as a website's.
	perform pg_temp.base_error(format('select public.qorpera_company_site_password(%L)', v_site), '42501');
	perform pg_temp.ca_as('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(public.qorpera_company_site_password(v_site) ->> 'password' = current_setting('qorpera_test.ca_password'),
		'An admin reads the password');
	perform pg_temp.base_claims('service_role');
end
$$;

-- 8. Another company ---------------------------------------------------------------------------------------------------
insert into public.qorpera_profiles(id, name, created_by_user_id)
values ('56200000-0000-4000-8000-000000000010', 'Other company', '92400000-0000-4000-8000-000000000005');
insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
values ('56200000-0000-4000-8000-000000000010', '92400000-0000-4000-8000-000000000005', 'base-outsider@example.test', 'Outsider', 'owner');
insert into public.qorpera_company_environments(id, profile_id, name, contract_version, created_by_user_id)
values ('56200000-0000-4000-8000-000000000020', '56200000-0000-4000-8000-000000000010', 'Environment', 1,
	'92400000-0000-4000-8000-000000000005');
insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
	started_by_receipt_id, requested_by_user_id, cpus, memory_bytes, disk_bytes, image, lifetime)
values ('56200000-0000-4000-8000-0000000000b1', '56200000-0000-4000-8000-000000000010', '56200000-0000-4000-8000-000000000020',
	'their-box', 'Their app', '56200000-0000-4000-8000-000000000040', (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid,
	extensions.gen_random_uuid(), '92400000-0000-4000-8000-000000000005', 1, 1073741824, 10737418240, 'standard', 'always-on');
insert into public.qorpera_company_sites (id, profile_id, environment_id, slug, source_path, created_by_staff_agent_id, kind, machine_id,
	app_port, published_at, published_by_staff_agent_id)
values ('56200000-0000-4000-8000-000000000030', '56200000-0000-4000-8000-000000000010', '56200000-0000-4000-8000-000000000020',
		'their-app', 'their-box', '56200000-0000-4000-8000-000000000040', 'app', '56200000-0000-4000-8000-0000000000b1', 3000,
		clock_timestamp(), '56200000-0000-4000-8000-000000000040'),
	('56200000-0000-4000-8000-000000000031', '56200000-0000-4000-8000-000000000010', '56200000-0000-4000-8000-000000000020',
		'their-other', 'their-box', '56200000-0000-4000-8000-000000000040', 'app', '56200000-0000-4000-8000-0000000000b1', 4000,
		clock_timestamp(), '56200000-0000-4000-8000-000000000040');
insert into public.qorpera_company_site_secrets (site_id, password) values
	('56200000-0000-4000-8000-000000000030', 'other-company-pw'), ('56200000-0000-4000-8000-000000000031', 'other-company-pw');
insert into public.qorpera_company_site_app_claims (claim_sha256, site_id, run_id, call_id, first_share, new_password, expires_at)
values (encode(extensions.digest(repeat('t', 43), 'sha256'), 'hex'), '56200000-0000-4000-8000-000000000031', extensions.gen_random_uuid(),
	'c', true, true, clock_timestamp() + interval '15 minutes');

do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_token text; v_share jsonb; v_answer jsonb;
begin
	-- Alice can neither take its name, nor share its machine, nor take its link offline.
	perform pg_temp.base_assert(pg_temp.ca_check('their-app') - 'url' = '{"state":"taken","needsReview":false}'::jsonb, 'Their name is taken');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'take', pg_temp.ca_request('their-app'),
		pg_temp.ca_review('their-app', 'ask', 'access_change', 'allow_once')), '55000',
		'SITE_NAME_TAKEN: another site already has this name; choose another');
	perform pg_temp.base_error(format('select public.qorpera_site_publish_check(%L, %L)', v_binding, 'their-app'), '55000',
		'SITE_NAME_TAKEN: another site already has this name; choose another');
	perform pg_temp.base_assert(pg_temp.ca_check('on-their-box', 'their-box')
		= '{"state":"refused","reason":"APP_MACHINE_NOT_FOUND","needsReview":false}'::jsonb, 'Their machine is not Alice''s');
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L, %L)', 'theirs', pg_temp.ca_request('on-their-box', 'their-box'),
		pg_temp.ca_review('on-their-box', 'ask', 'access_change', 'allow_once')), '22023',
		'APP_MACHINE_NOT_FOUND: the company has no machine of that name; start an always-on one with machine_start');
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'their-app') ->> 'removed' = 'false'
		and (select published_at is not null from public.qorpera_company_sites where slug = 'their-app'), 'Their link stays');
	perform pg_temp.base_assert(public.qorpera_site_app_connect('their-app', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb,
		'Alice''s key is her link''s only');
	-- A visitor's session is its link's only, and names its site.
	v_token := public.qorpera_site_app_unlock('their-app', 'other-company-pw', '192.0.2.9') ->> 'token';
	perform pg_temp.base_assert(public.qorpera_site_app_session('their-app', v_token)
			= '{"state":"open","siteId":"56200000-0000-4000-8000-000000000030"}'::jsonb
		and public.qorpera_site_app_session('shop-preview', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_session('their-app', current_setting('qorpera_test.ca_token')) = '{"state":"locked"}'::jsonb,
		'A session is its link''s only');
	-- A shared link holds its name however old its last change.
	update public.qorpera_company_sites set updated_at = clock_timestamp() - interval '2 days' where slug = 'their-app';
	perform pg_temp.base_assert(pg_temp.ca_check('their-app') ->> 'state' = 'taken', 'A shared link is never abandoned');

	-- While the company is being deleted its links are locked.
	insert into public.qorpera_company_deletions (profile_id) values ('56200000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(public.qorpera_site_app_session('their-app', v_token) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_unlock('their-app', 'other-company-pw', '192.0.2.10') = '{"state":"wrong"}'::jsonb
		and public.qorpera_site_app_connect('their-other', repeat('t', 43)) = '{"state":"refused"}'::jsonb,
		'A company being deleted shares nothing');
	delete from public.qorpera_company_deletions where profile_id = '56200000-0000-4000-8000-000000000010';
	v_answer := public.qorpera_site_app_connect('their-other', repeat('t', 43));
	perform pg_temp.base_assert(v_answer ->> 'key' is not null and v_answer ->> 'siteId' = '56200000-0000-4000-8000-000000000031',
		'Its claim was refused for the deletion only');

	-- Off for two days: another company may take its name.
	update public.qorpera_company_sites set published_at = null, published_by_staff_agent_id = null,
		updated_at = clock_timestamp() - interval '2 days' where slug = 'their-app';
	perform pg_temp.base_assert(pg_temp.ca_check('their-app') - 'url' = '{"state":"new","needsReview":true}'::jsonb
		and public.qorpera_site_publish_check(v_binding, 'their-app') ->> 'mode' = 'new', 'An abandoned link''s name is free');
	v_share := pg_temp.ca_share('take-2', pg_temp.ca_request('their-app'), pg_temp.ca_review('their-app', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(v_share -> 'firstShare' = 'true'::jsonb and v_share -> 'newPassword' = 'true'::jsonb
		and (select profile_id = '92400000-0000-4000-8000-000000000010' and machine_id = '56200000-0000-4000-8000-0000000000a1'
				and id <> '56200000-0000-4000-8000-000000000030'
			from public.qorpera_company_sites where slug = 'their-app')
		and not exists (select 1 from public.qorpera_company_site_secrets where site_id = '56200000-0000-4000-8000-000000000030'),
		'Alice took the free name, as a new site: ' || v_share::text);

	-- The company's purge takes its links, their claims and its machine; Alice's stay.
	insert into public.qorpera_company_deletions (profile_id) values ('56200000-0000-4000-8000-000000000010');
	perform public.qorpera_purge_company('56200000-0000-4000-8000-000000000010');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites where profile_id = '56200000-0000-4000-8000-000000000010')
		and not exists (select 1 from public.qorpera_company_site_app_claims where site_id = '56200000-0000-4000-8000-000000000031')
		and not exists (select 1 from public.qorpera_company_machines where id = '56200000-0000-4000-8000-0000000000b1')
		and (select count(*) from public.qorpera_company_sites where profile_id = '92400000-0000-4000-8000-000000000010') = 3,
		'The purge took its links, and only its');
	delete from public.qorpera_company_sites where slug = 'their-app';
end
$$;

-- 9. Unpublishing ------------------------------------------------------------------------------------------------------
do $$
declare v_binding jsonb := current_setting('qorpera_test.base_binding')::jsonb; v_share jsonb;
	v_site uuid := (select id from public.qorpera_company_sites where slug = 'shop-preview');
begin
	-- Alice turns the link off: its key, claims and sessions go; the site, its name and its password stay.
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'shop-preview') = jsonb_build_object('schema',
		'qorpera.site-unpublish/v1', 'slug', 'shop-preview', 'removed', true), 'Alice turns her link off');
	perform pg_temp.base_assert((select published_at is null and published_by_staff_agent_id is null and app_key_sha256 is null
			and machine_id = '56200000-0000-4000-8000-0000000000a2' from public.qorpera_company_sites where id = v_site)
		and not exists (select 1 from public.qorpera_company_site_app_claims where site_id = v_site)
		and not exists (select 1 from public.qorpera_company_site_sessions where site_id = v_site)
		and (select password from public.qorpera_company_site_secrets where site_id = v_site) = current_setting('qorpera_test.ca_password'),
		'Off: no key, claims or sessions; the password stays');
	perform pg_temp.base_assert(public.qorpera_site_app_connect('shop-preview', current_setting('qorpera_test.ca_key')) = '{"state":"refused"}'::jsonb
		and public.qorpera_site_app_session('shop-preview', current_setting('qorpera_test.ca_token')) = '{"state":"locked"}'::jsonb
		and public.qorpera_site_app_unlock('shop-preview', current_setting('qorpera_test.ca_password'), '192.0.2.20') = '{"state":"wrong"}'::jsonb,
		'An off link answers nothing');
	perform pg_temp.ca_as('92400000-0000-4000-8000-000000000003');
	select item.value into v_share from jsonb_array_elements(public.qorpera_list_company_sites('92400000-0000-4000-8000-000000000010'))
		as item(value) where item.value ->> 'slug' = 'shop-preview';
	perform pg_temp.base_assert(v_share ->> 'state' = 'off' and v_share -> 'publishedAt' = 'null'::jsonb, 'Members see it off: ' || v_share::text);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.ca_check('shop-preview', 'spare-box', 8080) - 'url' = '{"state":"new","needsReview":true}'::jsonb
		and public.qorpera_site_unpublish(v_binding, 'shop-preview') ->> 'removed' = 'false', 'Off again: nothing to turn off');
	-- Sharing it again is a new link: only on an approval, with the same password (not a new one).
	perform pg_temp.base_error(format('select pg_temp.ca_share(%L, %L)', 'share-5', pg_temp.ca_request('shop-preview', 'spare-box', 8080)),
		'42501');
	v_share := pg_temp.ca_share('share-5', pg_temp.ca_request('shop-preview', 'spare-box', 8080),
		pg_temp.ca_review('shop-preview', 'ask', 'access_change', 'allow_once'));
	perform pg_temp.base_assert(v_share -> 'firstShare' = 'true'::jsonb and v_share -> 'newPassword' = 'false'::jsonb
		and (select id from public.qorpera_company_sites where slug = 'shop-preview') = v_site
		and (select password from public.qorpera_company_site_secrets where site_id = v_site) = current_setting('qorpera_test.ca_password'),
		'Shared again, with its password: ' || v_share::text);
	-- Turning a link off works with the switches off.
	update public.qorpera_site_settings set enabled = false, apps_enabled = false;
	perform pg_temp.base_assert(public.qorpera_site_unpublish(v_binding, 'shop-preview') ->> 'removed' = 'true', 'Off with the switches off');
	update public.qorpera_site_settings set enabled = true, apps_enabled = true;
	-- An admin's unpublish takes the link away whole.
	perform pg_temp.ca_as('92400000-0000-4000-8000-000000000004');
	perform pg_temp.base_assert(public.qorpera_unpublish_company_site(v_site) ->> 'removed' = 'true', 'An admin takes it away');
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(not exists (select 1 from public.qorpera_company_sites where id = v_site)
		and not exists (select 1 from public.qorpera_company_site_secrets where site_id = v_site)
		and not exists (select 1 from public.qorpera_company_site_app_claims where site_id = v_site)
		and pg_temp.ca_check('shop-preview') - 'url' = '{"state":"new","needsReview":true}'::jsonb, 'Gone, with its password and claims');
end
$$;

rollback;
