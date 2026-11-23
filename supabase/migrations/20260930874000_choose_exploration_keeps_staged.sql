set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_choose_exploration(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_cancel_coding_workers(uuid[],text)') is null then
		raise exception 'Choosing keeps staged (20260930874000) requires 20260930843000 and 20260930857000 first';
	end if;
end $$;

create or replace function public.qorpera_choose_exploration(p_exploration_id uuid, p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_exploration public.qorpera_surface_explorations%rowtype;
	v_winner jsonb;
begin
	select * into v_exploration from public.qorpera_surface_explorations where id = p_exploration_id for update;
	if v_exploration.id is null then raise exception 'Exploration not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_exploration.profile_id, true);

	if not exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = p_session_id
			and s.exploration_id = p_exploration_id
			and s.surface_id = v_exploration.surface_id
			and s.profile_id = v_exploration.profile_id
	) then
		raise exception 'Session does not belong to exploration' using errcode = '42501';
	end if;

	perform public.qorpera_surface_cancel_coding_workers(
		(select coalesce(array_agg(s.id), '{}'::uuid[])
		 from public.qorpera_surface_sessions s
		 where s.exploration_id = p_exploration_id and s.id <> p_session_id),
		'surface_discarded'
	);

	update public.qorpera_surface_changes
	set status = 'discarded', discarded_by_exploration = true, resolved_at = clock_timestamp()
	where session_id in (
		select id from public.qorpera_surface_sessions where exploration_id = p_exploration_id and id <> p_session_id
	) and status in ('staged', 'conflicted');

	update public.qorpera_surface_sessions
	set state = 'discarded', has_active_chat = false, lease_token = null, lease_expires_at = null, wake_id = null,
		closed_at = clock_timestamp(), updated_at = clock_timestamp()
	where exploration_id = p_exploration_id and id <> p_session_id;

	update public.qorpera_surface_explorations
	set status = 'chosen', chosen_session_id = p_session_id, resolved_at = clock_timestamp()
	where id = p_exploration_id;

	update public.qorpera_member_surface_state
	set active_exploration_session_id = null, compare_session_ids = '{}'::uuid[]
	where surface_id = v_exploration.surface_id;

	select public.qorpera_surface_session_json(s) into v_winner
	from public.qorpera_surface_sessions s
	where s.id = p_session_id;
	return v_winner;
end $$;

revoke all on function public.qorpera_choose_exploration(uuid, uuid) from public, anon;
grant execute on function public.qorpera_choose_exploration(uuid, uuid) to authenticated;
