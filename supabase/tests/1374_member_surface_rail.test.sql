-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
select pg_temp.base_claims('service_role');

create function pg_temp.sr_call(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
	execute 'select (' || p_sql || ')::jsonb' into v_result;
	reset role;
	perform pg_temp.base_claims('service_role');
	return v_result;
end $$;
create function pg_temp.sr_refused(p_user uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
	begin
		perform pg_temp.sr_call(p_user, p_sql);
	exception when others then
		reset role;
		perform pg_temp.base_claims('service_role');
		if sqlstate <> p_code then raise exception 'expected % for %, got % (%)', p_code, p_sql, sqlstate, sqlerrm; end if;
		return;
	end;
	raise exception 'expected % for %', p_code, p_sql;
end $$;
create function pg_temp.sr_set(p_layout jsonb, p_expected timestamptz) returns text language sql as $$
	select format('public.qorpera_set_member_surface_rail(%L, %L::jsonb, %L::timestamptz)',
		'92400000-0000-4000-8000-000000000010', p_layout, p_expected)
$$;

do $$
declare v_owner uuid := '92400000-0000-4000-8000-000000000001'; v_viewer uuid := '92400000-0000-4000-8000-000000000003';
	v_read text := $q$public.qorpera_member_surface_rail('92400000-0000-4000-8000-000000000010')$q$;
	v_layout jsonb := '{"schema":"qorpera.member-surface-rail/v1",
		"order":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],
		"sections":[{"id":"s-1a2b","name":"Products","surfaces":["33333333-3333-4333-8333-333333333333"]},
			{"id":"s-3c4d","name":"Later","surfaces":[]}]}';
	v_state jsonb; v_at timestamptz; v_sidebar jsonb;
begin
	v_state := pg_temp.sr_call(v_viewer, v_read);
	perform pg_temp.base_assert(v_state #> '{layout,order}' = '[]' and v_state #> '{layout,sections}' = '[]'
		and v_state -> 'updatedAt' = 'null'::jsonb, 'A member starts with no interfaces layout: ' || v_state::text);

	v_state := pg_temp.sr_call(v_viewer, pg_temp.sr_set(v_layout, null));
	perform pg_temp.base_assert(v_state -> 'layout' = v_layout and v_state ->> 'updatedAt' is not null,
		'Written: ' || v_state::text);
	v_at := (v_state ->> 'updatedAt')::timestamptz;
	perform pg_temp.base_assert(pg_temp.sr_call(v_owner, v_read) #> '{layout,order}' = '[]', 'The owner''s is untouched');
	perform pg_temp.sr_refused(v_viewer, pg_temp.sr_set(v_layout, null), 'QSR01');
	perform pg_temp.sr_refused(v_viewer, pg_temp.sr_set(v_layout, v_at - interval '1 second'), 'QSR01');

	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	v_sidebar := public.qorpera_read_company_sidebar('92400000-0000-4000-8000-000000000010');
	reset role;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_sidebar #>> '{own,surfaces}' = '3' and v_sidebar #>> '{own,changes}' = '3',
		'Reset counts the interfaces layout: ' || (v_sidebar -> 'own')::text);

	perform pg_temp.sr_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"reset"}')$q$);
	perform pg_temp.base_assert(pg_temp.sr_call(v_viewer, v_read) #> '{layout,order}' = '[]', 'Reset takes the layout away');
	perform pg_temp.sr_call(v_viewer, $q$public.qorpera_manage_company_sidebar('92400000-0000-4000-8000-000000000010', '{"action":"undo_reset"}')$q$);
	v_state := pg_temp.sr_call(v_viewer, v_read);
	perform pg_temp.base_assert(v_state -> 'layout' = v_layout and (v_state ->> 'updatedAt')::timestamptz = v_at,
		'Undo puts the layout back: ' || v_state::text);

	v_state := pg_temp.sr_call(v_viewer,
		pg_temp.sr_set('{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[]}', v_at));
	perform pg_temp.base_assert(v_state -> 'updatedAt' = 'null'::jsonb
		and not exists (select 1 from public.qorpera_member_surface_rails where user_id = v_viewer), 'An empty layout is no row');
end $$;

do $$
declare v_viewer uuid := '92400000-0000-4000-8000-000000000003'; v_bad jsonb;
begin
	foreach v_bad in array array[
		'{}', '[]', '{"order":[],"sections":[]}', '{"schema":"qorpera.member-surface-rail/v1","order":[]}',
		'{"schema":"other","order":[],"sections":[]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[],"extra":1}',
		'{"schema":"qorpera.member-surface-rail/v1","order":{},"sections":[]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":["inbox"],"sections":[]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[1],"sections":[]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":["11111111-1111-4111-8111-111111111111","11111111-1111-4111-8111-111111111111"],"sections":[]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":["11111111-1111-4111-8111-111111111111"],"sections":[{"id":"a","name":"A","surfaces":["11111111-1111-4111-8111-111111111111"]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":"A","surfaces":[]},{"id":"a","name":"B","surfaces":[]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"Bad Id","name":"A","surfaces":[]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":"","surfaces":[]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":" A","surfaces":[]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":"A\nB","surfaces":[]}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":"A"}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":[{"id":"a","name":"A","surfaces":[],"open":true}]}',
		'{"schema":"qorpera.member-surface-rail/v1","order":[],"sections":["a"]}'
	]::jsonb[] loop
		perform pg_temp.sr_refused(v_viewer, pg_temp.sr_set(v_bad, null), '22023');
	end loop;
	perform pg_temp.sr_refused(v_viewer, pg_temp.sr_set(jsonb_build_object('schema', 'qorpera.member-surface-rail/v1',
		'order', '[]'::jsonb, 'sections', (select jsonb_agg(jsonb_build_object('id', 's' || n, 'name', 'x', 'surfaces', '[]'::jsonb))
			from generate_series(1, 51) n)), null), '22023');
	perform pg_temp.sr_refused('92400000-0000-4000-8000-0000000000ff',
		$q$public.qorpera_member_surface_rail('92400000-0000-4000-8000-000000000010')$q$, '42501');
	perform pg_temp.base_claims('authenticated', v_viewer);
	set local role authenticated;
	begin
		perform 1 from public.qorpera_member_surface_rails;
		raise exception 'interfaces layouts were readable directly';
	exception when insufficient_privilege then null;
	end;
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;
