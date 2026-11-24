create function public.qorpera_discard_surface_session(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_now timestamptz := clock_timestamp();
	v_change_ids uuid[];
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);
	if v_session.state in ('completed', 'discarded') then
		return public.qorpera_surface_session_json(v_session);
	end if;
	if exists (
		select 1 from public.qorpera_surface_explorations e
		where e.id = v_session.exploration_id and e.status = 'open'
	) then
		raise exception 'This session is one of several options; dismiss the options together' using errcode = '55000';
	end if;

	perform public.qorpera_surface_cancel_coding_workers(array[p_session_id], 'surface_discarded');

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.state in ('completed', 'discarded') then
		return public.qorpera_surface_session_json(v_session);
	end if;
	if exists (
		select 1 from public.qorpera_surface_changes ch
		where ch.session_id = p_session_id and ch.status = 'merging'
	) or exists (
		select 1 from public.qorpera_surface_jobs j
		where j.session_id = p_session_id and j.status in ('queued', 'running')
	) then
		raise exception 'A change from this session is being approved' using errcode = '55000';
	end if;

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = v_now
	where session_id = p_session_id and status in ('staged', 'conflicted');

	select coalesce(array_agg(ch.id), '{}'::uuid[]) into v_change_ids
	from public.qorpera_surface_changes ch
	where ch.session_id = p_session_id;

	update public.qorpera_member_surface_state
	set
		toggled_change_ids = coalesce(
			(select array_agg(t.id order by t.ord) from unnest(toggled_change_ids) with ordinality t(id, ord)
			 where t.id <> all(v_change_ids)),
			'{}'::uuid[]
		),
		active_exploration_session_id = nullif(active_exploration_session_id, p_session_id),
		compare_session_ids = array_remove(compare_session_ids, p_session_id)
	where surface_id = v_session.surface_id;

	-- WHY: no wake_id and no lease is what ends a studio run (qorpera_folder_wake_authorized, qorpera_surface_renew_lease).
	update public.qorpera_surface_sessions
	set
		state = case
			when exists (
				select 1 from public.qorpera_surface_changes ch
				where ch.session_id = p_session_id and ch.status = 'merged'
			) then 'completed'
			else 'discarded'
		end,
		has_active_chat = false,
		question = null,
		lease_token = null,
		lease_expires_at = null,
		wake_id = null,
		closed_at = v_now,
		updated_at = v_now
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_discard_surface_session(uuid) from public, anon;
grant execute on function public.qorpera_discard_surface_session(uuid) to authenticated;
