-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's own icons in the apps drawer (20260930732000): `emblems` beside `places`, `groups` and `colours`, each key
-- an app's (no group's) and each value a built-in emblem's name or custom:<id>; a document with icons alone is kept;
-- Reset counts them and takes them away, Undo puts them back; anything else is refused.
select pg_temp.base_claims('service_role');

create function pg_temp.ae_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute 'select (' || p_sql || ')::jsonb' into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.ae_refused(p_user uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.ae_call(p_user, p_sql);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_sql, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_sql;
end $$;
create function pg_temp.ae_set(p_layout jsonb, p_expected timestamptz) returns text language sql as $$
	select format('public.qorpera_set_member_app_layout(%L, %L::jsonb, %L::timestamptz)',
		'92400000-0000-4000-8000-000000000010', p_layout, p_expected)
$$;

do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_read text := $q$public.qorpera_member_app_layout('92400000-0000-4000-8000-000000000010')$q$;
	v_emblems jsonb := '{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},
		"emblems":{"app:trip-planner":"custom:compass","app:company-finances":"coin","page:mailbox":"chat","whats-new":"star","sites":"map"}}';
	v_all jsonb := '{"schema":"qorpera.member-app-layout/v1",
		"places":{"app:trip-planner":{"group":null,"after":"page:bank","at":1}},"groups":{},
		"colours":{"group:trips":"teal"},"emblems":{"app:trip-planner":"custom:trail-sign"}}';
	v_state jsonb; v_at timestamptz; v_sidebar jsonb;
begin
	-- Icons alone are the member's own: written and read back whole, a row of theirs.
	v_state := pg_temp.ae_call(v_viewer, pg_temp.ae_set(v_emblems, null));
	perform pg_temp.base_assert(v_state -> 'layout' = v_emblems, 'Icons alone are kept: ' || v_state::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_member_app_layouts where user_id = v_viewer),
		'Icons alone are a row');
	v_at := (v_state ->> 'updatedAt')::timestamptz;

	-- Beside places and colours, and Reset counts each icon as a change: one place, one colour, one icon.
	v_state := pg_temp.ae_call(v_viewer, pg_temp.ae_set(v_all, v_at));
	perform pg_temp.base_assert(v_state -> 'layout' = v_all, 'Icons beside the rest: ' || v_state::text);
	v_at := (v_state ->> 'updatedAt')::timestamptz;
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	v_sidebar := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_sidebar #>> '{own,apps}' = '3' and v_sidebar #>> '{own,changes}' = '3',
		'Reset counts the icons: ' || (v_sidebar -> 'own')::text);

	-- Reset takes them away with the rest; Undo puts them back.
	perform pg_temp.ae_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"reset"}')$q$);
	perform pg_temp.base_assert(pg_temp.ae_call(v_viewer, v_read) -> 'layout' -> 'emblems' is null, 'Reset takes the icons');
	perform pg_temp.ae_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"undo_reset"}')$q$);
	perform pg_temp.base_assert(pg_temp.ae_call(v_viewer, v_read) -> 'layout' = v_all, 'Undo puts the icons back');

	-- With nothing left, empty icons included, no row stays.
	v_state := pg_temp.ae_call(v_viewer, pg_temp.ae_set(
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{},"emblems":{}}', v_at));
	perform pg_temp.base_assert(v_state -> 'updatedAt' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_member_app_layouts where user_id = v_viewer), 'Nothing left is no row');
end $$;

-- Icons the web never writes are refused.
do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_bad jsonb;
begin
	foreach v_bad in array array[
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":[]}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":null}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"group:trips":"map"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:Bad":"map"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":"Map"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":"custom:"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":"custom:-x"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":"custom:../x"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":"https://x"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":1}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"emblems":{"app:a":{"id":"map"}}}'
	]::jsonb[] loop
		perform pg_temp.ae_refused(v_viewer, pg_temp.ae_set(v_bad, null), '22023');
	end loop;
	perform pg_temp.ae_refused(v_viewer, pg_temp.ae_set(jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', '{}'::jsonb, 'groups', '{}'::jsonb,
		'emblems', (select jsonb_object_agg('app:a' || n, 'map') from generate_series(1, 301) n)), null), '22023');
end $$;
