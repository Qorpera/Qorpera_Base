-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A member's own colours in the apps drawer (20260930731000): `colours` beside `places` and `groups`, each key an app's
-- or a group's and each value a palette colour; a document with colours alone is kept; Reset counts them and takes them
-- away, Undo puts them back; anything else is refused.
select pg_temp.base_claims('service_role');

create function pg_temp.ac_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute 'select (' || p_sql || ')::jsonb' into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.ac_refused(p_user uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.ac_call(p_user, p_sql);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_sql, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_sql;
end $$;
create function pg_temp.ac_set(p_layout jsonb, p_expected timestamptz) returns text language sql as $$
	select format('public.qorpera_set_member_app_layout(%L, %L::jsonb, %L::timestamptz)',
		'92400000-0000-4000-8000-000000000010', p_layout, p_expected)
$$;

do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_read text := $q$public.qorpera_member_app_layout('92400000-0000-4000-8000-000000000010')$q$;
	v_colours jsonb := '{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},
		"colours":{"group:trips":"teal","app:company-finances":"gold","page:mailbox":"pink","whats-new":"charcoal","sites":"gray"}}';
	v_both jsonb := '{"schema":"qorpera.member-app-layout/v1",
		"places":{"app:trip-planner":{"group":null,"after":"page:bank","at":1}},"groups":{"market":{"name":"Sales"}},
		"colours":{"group:market":"coral"}}';
	v_state jsonb; v_at timestamptz; v_sidebar jsonb;
begin
	-- Colours alone are the member's own: written and read back whole, a row of theirs.
	v_state := pg_temp.ac_call(v_viewer, pg_temp.ac_set(v_colours, null));
	perform pg_temp.base_assert(v_state -> 'layout' = v_colours and v_state ->> 'updatedAt' is not null,
		'Colours alone are kept: ' || v_state::text);
	perform pg_temp.base_assert(exists (select 1 from public.qorpera_member_app_layouts where user_id = v_viewer),
		'Colours alone are a row');
	v_at := (v_state ->> 'updatedAt')::timestamptz;

	-- Beside places and groups too, and Reset counts each colour as a change: one place, one group, one colour.
	v_state := pg_temp.ac_call(v_viewer, pg_temp.ac_set(v_both, v_at));
	perform pg_temp.base_assert(v_state -> 'layout' = v_both, 'Colours beside places and groups: ' || v_state::text);
	v_at := (v_state ->> 'updatedAt')::timestamptz;
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	v_sidebar := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_sidebar #>> '{own,apps}' = '3' and v_sidebar #>> '{own,changes}' = '3',
		'Reset counts the colours: ' || (v_sidebar -> 'own')::text);

	-- Reset takes them away with the rest; Undo puts them back.
	perform pg_temp.ac_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"reset"}')$q$);
	perform pg_temp.base_assert(pg_temp.ac_call(v_viewer, v_read) -> 'layout' -> 'colours' is null, 'Reset takes the colours');
	perform pg_temp.ac_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"undo_reset"}')$q$);
	v_state := pg_temp.ac_call(v_viewer, v_read);
	perform pg_temp.base_assert(v_state -> 'layout' = v_both, 'Undo puts the colours back: ' || v_state::text);

	-- With nothing left, empty colours included, no row stays.
	v_state := pg_temp.ac_call(v_viewer, pg_temp.ac_set(
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{}}', v_at));
	perform pg_temp.base_assert(v_state -> 'updatedAt' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_member_app_layouts where user_id = v_viewer), 'Nothing left is no row');
end $$;

-- Colours the web never writes are refused.
do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_bad jsonb;
begin
	foreach v_bad in array array[
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":[]}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":null}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":"teal"}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":"red"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":"#ff0000"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":"Teal"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":1}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":null}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:a":{"colour":"teal"}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"app:Bad":"teal"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"agent:x":"teal"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"group:Bad Id":"teal"}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"colours":{"page:whats-new":"teal"}}'
	]::jsonb[] loop
		perform pg_temp.ac_refused(v_viewer, pg_temp.ac_set(v_bad, null), '22023');
	end loop;
	-- At most 300 colours.
	perform pg_temp.ac_refused(v_viewer, pg_temp.ac_set(jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', '{}'::jsonb, 'groups', '{}'::jsonb,
		'colours', (select jsonb_object_agg('app:a' || n, 'teal') from generate_series(1, 301) n)), null), '22023');
	perform pg_temp.base_assert(pg_temp.ac_call(v_viewer, pg_temp.ac_set(jsonb_build_object(
		'schema', 'qorpera.member-app-layout/v1', 'places', '{}'::jsonb, 'groups', '{}'::jsonb,
		'colours', (select jsonb_object_agg('app:a' || n, 'teal') from generate_series(1, 300) n)), null))
		#>> '{layout,colours,app:a300}' = 'teal', '300 colours are taken');
end $$;
