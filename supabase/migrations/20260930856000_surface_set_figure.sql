-- WHY: The figure lives in the icon as "figure:<name>" and the web owns the list of names (an unknown one draws as
-- its kind's figure), so a new figure needs no migration. Colours are never chosen (Jonas, 22 Nov 2026).

create function public.qorpera_set_surface_figure(p_surface_id uuid, p_figure text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_figure text := btrim(coalesce(p_figure, ''));
begin
	if v_figure !~ '^[a-z]{2,24}$' then
		raise exception 'A figure is a short lowercase name' using errcode = '22023';
	end if;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.id is null then raise exception 'Surface not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_surface.profile_id, true);

	update public.qorpera_surfaces
	set icon = 'figure:' || v_figure, updated_at = clock_timestamp()
	where id = p_surface_id
	returning * into v_surface;

	return public.qorpera_surface_summary_json(v_surface);
end $$;
revoke all on function public.qorpera_set_surface_figure(uuid, text) from public, anon;
grant execute on function public.qorpera_set_surface_figure(uuid, text) to authenticated;
