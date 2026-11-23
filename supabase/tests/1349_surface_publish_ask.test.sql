-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.spa_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_publish_ask: %', p_message;
	end if;
end $$;

create function pg_temp.spa_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.spa_call(p_user_id uuid, p_sql text)
returns jsonb language plpgsql as $$
declare
	v_result jsonb;
begin
	perform pg_temp.spa_as(p_user_id);
	set local role authenticated;
	execute p_sql into v_result;
	reset role;
	return v_result;
end $$;

create function pg_temp.spa_refused(p_user_id uuid, p_sql text)
returns text language plpgsql as $$
begin
	perform pg_temp.spa_as(p_user_id);
	set local role authenticated;
	execute p_sql;
	reset role;
	return 'ok';
exception when others then
	reset role;
	return sqlstate;
end $$;

create function pg_temp.spa_pending(p_surface uuid)
returns void language sql as $$
	update public.qorpera_surfaces
	set unpublished_change_count = 1, live_head_sha = 'b2', published_head_sha = 'a1', publish_status = 'idle', auto_publish = false
	where id = p_surface
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_dee constant uuid := '13490000-0000-4000-8000-000000000004';
	v_eve constant uuid := '13490000-0000-4000-8000-000000000005';
	v_stranger constant uuid := '13490000-0000-4000-8000-000000000006';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_sql_ask_dee text;
	v_result jsonb;
	v_ask public.qorpera_surface_publish_asks%rowtype;
begin
	perform pg_temp.spa_assert(
		not has_table_privilege('authenticated', 'public.qorpera_surface_publish_asks', 'SELECT')
		and not has_table_privilege('service_role', 'public.qorpera_surface_publish_asks', 'SELECT')
		and not has_table_privilege('anon', 'public.qorpera_surface_publish_asks', 'SELECT'),
		'asks are never readable directly'
	);
	perform pg_temp.spa_assert(
		not has_function_privilege('authenticated', 'public.qorpera_surface_member_may_publish(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('service_role', 'public.qorpera_surface_member_may_publish(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_surface_member_may_publish(uuid,uuid)', 'EXECUTE'),
		'the publish check is internal'
	);
	perform pg_temp.spa_assert(
		has_function_privilege('authenticated', 'public.qorpera_ask_surface_publish(uuid,uuid)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_decline_surface_publish_ask(uuid)', 'EXECUTE')
		and has_function_privilege('authenticated', 'public.qorpera_withdraw_surface_publish_ask(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_ask_surface_publish(uuid,uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_decline_surface_publish_ask(uuid)', 'EXECUTE')
		and not has_function_privilege('anon', 'public.qorpera_withdraw_surface_publish_ask(uuid)', 'EXECUTE'),
		'members call the three ask functions; anon none'
	);

	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into auth.users(id, email) values
		(v_dee, 'dee-1349@example.test'), (v_eve, 'eve-1349@example.test'), (v_stranger, 'stranger-1349@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(v_company, v_dee, 'dee-1349@example.test', 'Dee', 'contributor'),
		(v_company, v_eve, 'eve-1349@example.test', 'Eve', 'viewer');

	v_surface := (pg_temp.spa_call(v_anna, format(
		$q$select public.qorpera_create_surface(%L, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true)$q$,
		v_company)) ->> 'id')::uuid;
	v_sql_ask_dee := format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_dee);

	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, v_sql_ask_dee) = '55000',
		'nothing to publish: no ask'
	);

	perform pg_temp.spa_pending(v_surface);
	perform pg_temp.spa_assert(
		pg_temp.spa_call(v_anna, format('select public.qorpera_get_surface_workspace(%L)', v_surface)) -> 'surface' -> 'publishAsk'
			= 'null'::jsonb,
		'a surface with no ask says publishAsk null'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_anna)) = '22023'
		and pg_temp.spa_refused(v_anna, format('select public.qorpera_ask_surface_publish(%L, null)', v_surface)) = '22023',
		'nobody asks themselves or no one'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_eve)) = '42501'
		and pg_temp.spa_refused(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_stranger)) = '42501',
		'only a member who may publish can be asked: not a viewer, not an outsider'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_eve, v_sql_ask_dee) = '42501' and pg_temp.spa_refused(v_stranger, v_sql_ask_dee) = '42501',
		'a viewer or an outsider cannot ask'
	);

	v_result := pg_temp.spa_call(v_anna, v_sql_ask_dee);
	perform pg_temp.spa_assert(
		v_result -> 'publishAsk' ->> 'askedByUserId' = v_anna::text
		and v_result -> 'publishAsk' ->> 'askedUserId' = v_dee::text
		and v_result -> 'publishAsk' ->> 'status' = 'open'
		and (v_result -> 'publishAsk' ->> 'changeCount')::integer = 1
		and v_result -> 'publishAsk' -> 'answeredAt' = 'null'::jsonb
		and v_result -> 'publishAsk' ->> 'askedAt' is not null,
		'the ask is on the surface: who asked, who is asked, when, what was pending'
	);
	select * into strict v_ask from public.qorpera_surface_publish_asks where surface_id = v_surface;
	perform pg_temp.spa_assert(v_ask.head_sha = 'b2' and v_ask.profile_id = v_company, 'the ask keeps the head it was about');

	perform pg_temp.spa_call(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_bo));
	perform pg_temp.spa_assert(
		(select count(*) from public.qorpera_surface_publish_asks where surface_id = v_surface) = 1
		and (select asked_user_id from public.qorpera_surface_publish_asks where surface_id = v_surface) = v_bo,
		'a new ask replaces the old one: one open ask per surface'
	);

	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_dee, format('select public.qorpera_decline_surface_publish_ask(%L)', v_surface)) = 'P0002',
		'only the asked member answers'
	);
	v_result := pg_temp.spa_call(v_bo, format('select public.qorpera_decline_surface_publish_ask(%L)', v_surface));
	perform pg_temp.spa_assert(
		v_result -> 'publishAsk' ->> 'status' = 'declined' and v_result -> 'publishAsk' ->> 'answeredAt' is not null
		and v_result -> 'publishAsk' ->> 'askedByUserId' = v_anna::text,
		'No closes the ask and the asker can read that she said no'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_bo, format('select public.qorpera_decline_surface_publish_ask(%L)', v_surface)) = 'P0002',
		'a closed ask is not answered twice'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_bo, format('select public.qorpera_withdraw_surface_publish_ask(%L)', v_surface)) = 'P0002',
		'only the asker takes an ask back'
	);
	v_result := pg_temp.spa_call(v_anna, format('select public.qorpera_withdraw_surface_publish_ask(%L)', v_surface));
	perform pg_temp.spa_assert(
		v_result -> 'publishAsk' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'the asker clears the answered ask'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, format('select public.qorpera_withdraw_surface_publish_ask(%L)', v_surface)) = 'P0002',
		'nothing left to take back'
	);

	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	v_result := pg_temp.spa_call(v_anna, format('select public.qorpera_withdraw_surface_publish_ask(%L)', v_surface));
	perform pg_temp.spa_assert(v_result -> 'publishAsk' = 'null'::jsonb, 'the asker takes an open ask back');

	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	v_result := pg_temp.spa_call(v_dee, format('select public.qorpera_publish_surface(%L)', v_surface));
	perform pg_temp.spa_assert(
		v_result -> 'publishAsk' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface)
		and (select unpublished_change_count from public.qorpera_surfaces where id = v_surface) = 0,
		'Yes is the asked member''s own publish, and it closes the ask'
	);

	perform pg_temp.spa_pending(v_surface);
	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	perform pg_temp.spa_call(v_bo, format('select public.qorpera_publish_surface(%L)', v_surface));
	perform pg_temp.spa_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'anyone''s publish closes the ask'
	);

	perform pg_temp.spa_pending(v_surface);
	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	update public.qorpera_surfaces set publish_status = 'publishing' where id = v_surface;
	perform pg_temp.spa_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'a publish that runs as a job closes the ask when it starts'
	);
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, v_sql_ask_dee) = '55000',
		'no ask while a publish runs'
	);

	perform pg_temp.spa_pending(v_surface);
	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	perform pg_temp.spa_call(v_dee, format('select public.qorpera_decline_surface_publish_ask(%L)', v_surface));
	v_result := pg_temp.spa_call(v_anna, v_sql_ask_dee);
	perform pg_temp.spa_assert(
		v_result -> 'publishAsk' ->> 'status' = 'open' and v_result -> 'publishAsk' -> 'answeredAt' = 'null'::jsonb,
		'asking again after a no opens a fresh ask'
	);
	update public.qorpera_surfaces set unpublished_change_count = 0, published_head_sha = live_head_sha where id = v_surface;
	perform pg_temp.spa_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'the ask closes when nothing is left to publish'
	);

	perform pg_temp.spa_pending(v_surface);
	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	update public.qorpera_surfaces set unpublished_change_count = 2 where id = v_surface;
	perform pg_temp.spa_assert(
		exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface and status = 'open'),
		'more to publish keeps the ask open'
	);

	update public.qorpera_profile_members set role = 'viewer' where profile_id = v_company and user_id = v_dee;
	perform pg_temp.spa_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'an ask closes when the asked member may no longer publish'
	);
	update public.qorpera_profile_members set role = 'contributor' where profile_id = v_company and user_id = v_dee;
	perform pg_temp.spa_call(v_anna, v_sql_ask_dee);
	delete from public.qorpera_profile_members where profile_id = v_company and user_id = v_dee;
	perform pg_temp.spa_assert(
		not exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface),
		'an ask closes when the asked member leaves the company'
	);
	perform pg_temp.spa_call(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_bo));
	update public.qorpera_profile_members set role = 'contributor' where profile_id = v_company and user_id = v_eve;
	perform pg_temp.spa_assert(
		exists (select 1 from public.qorpera_surface_publish_asks where surface_id = v_surface and asked_user_id = v_bo),
		'another member''s role change leaves the ask'
	);

	update public.qorpera_surfaces set auto_publish = true where id = v_surface;
	perform pg_temp.spa_assert(
		pg_temp.spa_refused(v_anna, format('select public.qorpera_ask_surface_publish(%L, %L)', v_surface, v_bo)) = '55000',
		'with Auto-publish on there is nothing to ask'
	);
end $$;
