-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Each member's own arrangement of the apps drawer (20260930728000): read and written whole by the member, shape and
-- size checked, a write over a newer one refused; Reset sidebar takes it away with the rest and Undo puts it back.
select pg_temp.base_claims('service_role');

create function pg_temp.al_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute 'select (' || p_sql || ')::jsonb' into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.al_refused(p_user uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.al_call(p_user, p_sql);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_sql, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_sql;
end $$;
create function pg_temp.al_set(p_layout jsonb, p_expected timestamptz) returns text language sql as $$
	select format('public.qorpera_set_member_app_layout(%L, %L::jsonb, %L::timestamptz)',
		'92400000-0000-4000-8000-000000000010', p_layout, p_expected)
$$;

do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_read text := $q$public.qorpera_member_app_layout('92400000-0000-4000-8000-000000000010')$q$;
	v_layout jsonb := '{"schema":"qorpera.member-app-layout/v1",
		"places":{"app:trip-planner":{"group":"m-1a2b","after":null,"first":true,"at":2},"group:m-1a2b":{"group":null,"after":"page:bank","at":1}},
		"groups":{"m-1a2b":{"mine":{"name":"Daily"}},"market":{"name":"Sales"},"trips":{"removed":true}}}';
	v_state jsonb; v_at timestamptz; v_sidebar jsonb;
begin
	-- An empty layout to start with, for any member.
	v_state := pg_temp.al_call(v_viewer, v_read);
	perform pg_temp.base_assert(v_state #> '{layout,places}' = '{}' and v_state -> 'updatedAt' = 'null'::jsonb,
		'A member starts with no apps layout: ' || v_state::text);

	-- A viewer writes theirs; it is theirs alone.
	v_state := pg_temp.al_call(v_viewer, pg_temp.al_set(v_layout, null));
	perform pg_temp.base_assert(v_state -> 'layout' = v_layout and v_state ->> 'updatedAt' is not null, 'Written: ' || v_state::text);
	v_at := (v_state ->> 'updatedAt')::timestamptz;
	perform pg_temp.base_assert(pg_temp.al_call(v_owner, v_read) #> '{layout,places}' = '{}', 'The owner''s is untouched');
	-- A write from a tab that read before is refused; one that read the newest goes through.
	perform pg_temp.al_refused(v_viewer, pg_temp.al_set(v_layout, null), 'QAL01');
	perform pg_temp.al_refused(v_viewer, pg_temp.al_set(v_layout, v_at - interval '1 second'), 'QAL01');

	-- The sidebar counts it among the member's changes: two places and three groups.
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	v_sidebar := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_sidebar #>> '{own,apps}' = '5' and v_sidebar #>> '{own,changes}' = '5',
		'Reset counts the apps layout: ' || (v_sidebar -> 'own')::text);

	-- Reset takes it away; Undo puts it back as it was.
	perform pg_temp.al_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"reset"}')$q$);
	perform pg_temp.base_assert(pg_temp.al_call(v_viewer, v_read) #> '{layout,places}' = '{}', 'Reset takes the layout away');
	perform pg_temp.al_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"undo_reset"}')$q$);
	v_state := pg_temp.al_call(v_viewer, v_read);
	perform pg_temp.base_assert(v_state -> 'layout' = v_layout and (v_state ->> 'updatedAt')::timestamptz = v_at,
		'Undo puts the layout back: ' || v_state::text);

	-- Writing an empty layout leaves nothing of the member's own.
	v_state := pg_temp.al_call(v_viewer, pg_temp.al_set('{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{}}', v_at));
	perform pg_temp.base_assert(v_state -> 'updatedAt' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_member_app_layouts where user_id = v_viewer), 'An empty layout is no row');
end $$;

-- Shapes the web never writes are refused, and so is a stranger.
do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_bad jsonb;
begin
	foreach v_bad in array array[
		-- Missing fields are refused, never taken as an empty layout (review F3 on #1678).
		'{}', '{"places":{},"groups":{}}', '{"schema":"qorpera.member-app-layout/v1","places":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{"mine":{}}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{"mine":"x"}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":"x"},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":{"at":"1"}},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":{"at":-1}},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":{"at":1.5}},"groups":{}}',
		'[]', '{"schema":"other","places":{},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{},"extra":1}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"agent:x":{}},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":{"group":"Bad Id"}},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{"app:a":{"first":"yes"}},"groups":{}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{"name":""}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{"removed":false}}}',
		'{"schema":"qorpera.member-app-layout/v1","places":{},"groups":{"g":{"mine":{"name":"x","colour":"red"}}}}'
	]::jsonb[] loop
		perform pg_temp.al_refused(v_viewer, pg_temp.al_set(v_bad, null), '22023');
	end loop;
	perform pg_temp.al_refused(v_viewer, pg_temp.al_set(jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', '{}'::jsonb, 'groups', (select jsonb_object_agg('g' || n, jsonb_build_object('name', repeat('x', 40)))
			from generate_series(1, 1500) n)), null), '22023');
	perform pg_temp.al_refused('92400000-0000-4000-8000-0000000000ff',
		$q$public.qorpera_member_app_layout('92400000-0000-4000-8000-000000000010')$q$, '42501');
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	begin
		perform 1 from public.qorpera_member_app_layouts;
		raise exception 'layouts were readable directly';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

-- An app's name may be 64 characters, and a group id is read as the agents' tool reads it (review F1/F2 on #1678, round 8).
do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_state jsonb;
	v_long text := 'app:' || repeat('a', 64);
begin
	v_state := pg_temp.al_call(v_viewer, pg_temp.al_set(jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', jsonb_build_object(v_long, jsonb_build_object('group', '-ops', 'after', null, 'first', true, 'at', 1)),
		'groups', jsonb_build_object('-ops', jsonb_build_object('mine', jsonb_build_object('name', 'Ops')))), null));
	perform pg_temp.base_assert(v_state #> '{layout,places}' ? v_long, 'A 64-character app name is taken: ' || v_state::text);
	perform pg_temp.al_refused(v_viewer, pg_temp.al_set(jsonb_build_object('schema', 'qorpera.member-app-layout/v1',
		'places', jsonb_build_object(v_long || 'a', '{}'::jsonb), 'groups', '{}'::jsonb),
		(v_state ->> 'updatedAt')::timestamptz), '22023');
end $$;
