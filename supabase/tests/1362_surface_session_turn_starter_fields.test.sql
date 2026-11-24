-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sstsf_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_session_turn_starter_fields: %', p_message;
	end if;
end $$;

create function pg_temp.sstsf_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sstsf_turn(p_profile_id uuid, p_session_id uuid, p_lease uuid)
returns jsonb language plpgsql as $$
declare v_turn jsonb;
begin
	update public.qorpera_surface_sessions set state = 'running', lease_token = p_lease where id = p_session_id;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_turn := public.qorpera_native_surface_read_session_turn(p_profile_id, p_session_id, p_lease);
	reset role;
	return v_turn;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_owner constant uuid := '85600000-0000-4000-8000-000000000001';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_identity uuid;
	v_product uuid;
	v_custom uuid;
	v_session_identity uuid;
	v_session_product uuid;
	v_session_custom uuid;
	v_turn jsonb;
	v_errcode text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, null);
	reset role;
	select id into v_identity from public.qorpera_surfaces where profile_id = v_company and slug = 'identity';
	perform pg_temp.sstsf_assert(v_identity is not null, 'the company has its Identity interface');

	perform pg_temp.sstsf_as(v_owner);
	set local role authenticated;
	v_product := (public.qorpera_create_surface(v_company, 'Travel Kit', 'travel-kit', 'studio', 'custom', 'box', null,
		'surfaces/travel-kit', null, false) ->> 'id')::uuid;
	v_custom := (public.qorpera_create_surface(v_company, 'Field Notes', 'field-notes', 'studio', 'custom', 'star', null,
		'surfaces/field-notes', null, false) ->> 'id')::uuid;
	v_session_identity := (public.qorpera_start_surface_session(v_identity, 'Tighten the palette', 'Palette') ->> 'id')::uuid;
	v_session_product := (public.qorpera_start_surface_session(v_product, 'Add the four figures', 'Figures') ->> 'id')::uuid;
	v_session_custom := (public.qorpera_start_surface_session(v_custom, 'Lay out the notes', 'Notes') ->> 'id')::uuid;

	v_errcode := null;
	begin
		perform public.qorpera_native_surface_read_session_turn(v_company, v_session_custom, gen_random_uuid());
	exception when others then
		v_errcode := sqlstate;
	end;
	perform pg_temp.sstsf_assert(v_errcode = '42501', 'authenticated still cannot read a session turn, got ' || coalesce(v_errcode, 'none'));
	reset role;

	v_turn := pg_temp.sstsf_turn(v_company, v_session_product, '13620000-0000-4000-8000-000000000101');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceKind' = 'custom', 'the product-by-icon interface keeps its stored kind');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceIcon' = 'box', 'the product-by-icon interface hands over its icon');
	perform pg_temp.sstsf_assert(v_turn -> 'surfaceIsGlobal' = 'false'::jsonb, 'the product-by-icon interface is not global');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceArchetype' = 'studio', 'the product-by-icon interface is a studio');
	perform pg_temp.sstsf_assert(v_turn ->> 'prompt' = 'Add the four figures', 'the prompt is unchanged');

	v_turn := pg_temp.sstsf_turn(v_company, v_session_identity, '13620000-0000-4000-8000-000000000102');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceKind' = 'identity', 'Identity keeps its kind');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceIcon' = 'spark', 'Identity hands over its icon, got ' || coalesce(v_turn ->> 'surfaceIcon', 'null'));
	perform pg_temp.sstsf_assert(v_turn -> 'surfaceIsGlobal' = 'true'::jsonb, 'Identity is global');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceArchetype' = 'studio', 'Identity is a studio');
	perform pg_temp.sstsf_assert(v_turn ->> 'folderRoot' = 'identity', 'Identity keeps its folder root');

	v_turn := pg_temp.sstsf_turn(v_company, v_session_product, '13620000-0000-4000-8000-000000000104');
	perform pg_temp.sstsf_assert(v_turn -> 'openLayoutOps' = '[]'::jsonb, 'a session with no waiting change has no layout ops');

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, patch_manifest, status)
	values
		(v_company, v_custom, v_session_custom, 1, 'Page', 'folder_patch',
			'[{"op":"write_text","path":"layout.json","content":"{}"},{"op":"write_text","path":"notes.md","content":"x"}]'::jsonb,
			'staged'),
		(v_company, v_custom, v_session_custom, 2, 'Dropped', 'folder_patch',
			'[{"op":"delete","path":"layout.json"}]'::jsonb, 'discarded'),
		(v_company, v_custom, v_session_custom, 3, 'Rename', 'folder_patch',
			'[{"op":"merge_json","path":"surfaces/field-notes/layout.json","patch":{"tabs":[]}}]'::jsonb, 'staged');
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, patch_manifest, status)
	values (v_company, v_product, v_session_product, 1, 'Other session', 'folder_patch',
		'[{"op":"delete","path":"layout.json"}]'::jsonb, 'staged');

	v_turn := pg_temp.sstsf_turn(v_company, v_session_custom, '13620000-0000-4000-8000-000000000103');
	perform pg_temp.sstsf_assert(
		v_turn -> 'openLayoutOps' = '[{"op":"write_text","path":"layout.json","content":"{}"},{"op":"merge_json","path":"surfaces/field-notes/layout.json","patch":{"tabs":[]}}]'::jsonb,
		'the session''s own waiting layout ops come in order, got ' || coalesce(v_turn ->> 'openLayoutOps', 'null')
	);
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceIcon' = 'star', 'the custom interface hands over its icon');
	perform pg_temp.sstsf_assert(v_turn -> 'surfaceIsGlobal' = 'false'::jsonb, 'the custom interface is not global');
	perform pg_temp.sstsf_assert(v_turn ->> 'surfaceArchetype' = 'studio', 'the custom interface is a studio');
	perform pg_temp.sstsf_assert(v_turn ->> 'folderRoot' = 'surfaces/field-notes', 'the custom interface keeps its folder root');

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, patch_manifest, status)
	values
		(v_company, v_custom, v_session_custom, 4, 'Module', 'folder_patch',
			'[{"op":"write_text","path":"modules/price/layout.json","content":"{}"},{"op":"delete","path":"mylayout.json"},{"op":"delete","path":"surfaces/field-notes/modules/price/layout.json"},{"op":"delete","path":"surfaces/other/layout.json"}]'::jsonb,
			'staged'),
		(v_company, v_custom, v_session_custom, 5, 'Again', 'folder_patch',
			'[{"op":"merge_json","path":"layout.json","patch":{"a":1}},{"op":"delete","path":"surfaces/field-notes/layout.json"},{"op":"merge_json","path":"layout.json","patch":{"b":2}}]'::jsonb,
			'conflicted');
	v_turn := pg_temp.sstsf_turn(v_company, v_session_custom, '13620000-0000-4000-8000-000000000105');
	perform pg_temp.sstsf_assert(
		v_turn -> 'openLayoutOps' = '[{"op":"delete","path":"surfaces/field-notes/layout.json"},{"op":"merge_json","path":"layout.json","patch":{"b":2}}]'::jsonb,
		'only the exact layout path, from the last whole write or delete onward, got ' || coalesce(v_turn ->> 'openLayoutOps', 'null')
	);

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, kind, patch_manifest, status)
	values (v_company, v_product, v_session_product, 2, 'Big page', 'folder_patch',
		jsonb_build_array(jsonb_build_object('op', 'write_text', 'path', 'surfaces/travel-kit/layout.json', 'content', repeat('x', 100000))),
		'staged');
	v_turn := pg_temp.sstsf_turn(v_company, v_session_product, '13620000-0000-4000-8000-000000000106');
	perform pg_temp.sstsf_assert(
		v_turn ? 'openLayoutOps' and jsonb_typeof(v_turn -> 'openLayoutOps') = 'null',
		'waiting layout ops over the cap are null, got ' || coalesce(left(v_turn ->> 'openLayoutOps', 80), 'null')
	);
	perform pg_temp.sstsf_assert(octet_length(v_turn::text) < 65536, 'the turn stays small when the layout ops are over the cap');
end $$;
