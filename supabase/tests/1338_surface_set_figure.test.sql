-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

create function pg_temp.fig_assert(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
	if p_ok is not true then
		raise exception 'surface_set_figure: %', p_what;
	end if;
end $$;

create function pg_temp.fig_as(p_user uuid) returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user)::text, true)::text::void
$$;

create function pg_temp.fig_refusal(p_user uuid, p_surface uuid, p_figure text) returns text language plpgsql as $$
declare
	v_code text;
begin
	perform pg_temp.fig_as(p_user);
	set local role authenticated;
	begin
		perform public.qorpera_set_surface_figure(p_surface, p_figure);
	exception when others then
		v_code := sqlstate;
	end;
	reset role;
	return v_code;
end $$;

do $$
declare
	v_owner constant uuid := '92400000-0000-4000-8000-000000000001';
	v_member constant uuid := '92400000-0000-4000-8000-000000000002';
	v_viewer constant uuid := '92400000-0000-4000-8000-000000000003';
	v_outsider constant uuid := '92400000-0000-4000-8000-000000000005';
	v_profile constant uuid := '92400000-0000-4000-8000-000000000010';
	v_created jsonb;
	v_surface_id uuid;
	v_summary jsonb;
begin
	update public.qorpera_surface_settings set enabled = true where singleton = true;

	perform pg_temp.fig_as(v_owner);
	set local role authenticated;
	v_created := public.qorpera_create_surface(v_profile, 'Money', 'money', 'live_build');
	v_surface_id := (v_created ->> 'id')::uuid;
	v_summary := public.qorpera_set_surface_figure(v_surface_id, 'piggy');
	reset role;
	perform pg_temp.fig_assert(v_summary ->> 'icon' = 'figure:piggy', 'the owner sets a figure and gets the surface back');
	perform pg_temp.fig_assert(
		(select icon from public.qorpera_surfaces where id = v_surface_id) = 'figure:piggy',
		'the figure is stored in the icon'
	);

	perform pg_temp.fig_as(v_member);
	set local role authenticated;
	v_summary := public.qorpera_set_surface_figure(v_surface_id, ' jar ');
	reset role;
	perform pg_temp.fig_assert(v_summary ->> 'icon' = 'figure:jar', 'a contributor changes it too, trimmed');

	perform pg_temp.fig_assert(pg_temp.fig_refusal(v_viewer, v_surface_id, 'shop') = '42501', 'a viewer is refused');
	perform pg_temp.fig_assert(pg_temp.fig_refusal(v_outsider, v_surface_id, 'shop') = '42501', 'an outsider is refused');
	perform pg_temp.fig_assert(pg_temp.fig_refusal(v_owner, v_surface_id, 'Piggy!') = '22023', 'a name with other characters is refused');
	perform pg_temp.fig_assert(pg_temp.fig_refusal(v_owner, v_surface_id, null) = '22023', 'no name is refused');
	perform pg_temp.fig_assert(
		pg_temp.fig_refusal(v_owner, v_surface_id, repeat('a', 25)) = '22023',
		'a name longer than 24 letters is refused'
	);
	perform pg_temp.fig_assert(
		pg_temp.fig_refusal(v_owner, '92400000-0000-4000-8000-0000000009ff', 'shop') = 'P0002',
		'an unknown surface is not found'
	);
	perform pg_temp.fig_assert(
		(select icon from public.qorpera_surfaces where id = v_surface_id) = 'figure:jar',
		'refused calls leave the figure as it was'
	);

	update public.qorpera_surface_settings set enabled = false where singleton = true;
	perform pg_temp.fig_assert(
		pg_temp.fig_refusal(v_owner, v_surface_id, 'shop') = '0A000',
		'no change while surfaces are switched off'
	);
end $$;

rollback;
