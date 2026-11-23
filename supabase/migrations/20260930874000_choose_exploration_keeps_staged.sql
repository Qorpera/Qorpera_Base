set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_choose_exploration(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_surface_cancel_coding_workers(uuid[],text)') is null then
		raise exception 'Choosing keeps staged (20260930874000) requires 20260930843000 and 20260930857000 first';
	end if;
	if position('Exploration is no longer open' in pg_get_functiondef(
		'public.qorpera_discard_exploration(uuid)'::regprocedure)) > 0 then
		raise exception 'Choosing keeps staged (20260930874000) is already applied';
	end if;
end $$;

create function pg_temp.ceks_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930874000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930874000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.ceks_patch('public.qorpera_discard_exploration(uuid)'::regprocedure, array[
$old$	perform public.qorpera_assert_surface_member(v_exploration.profile_id, true);
$old$,
$new$	perform public.qorpera_assert_surface_member(v_exploration.profile_id, true);
	if v_exploration.status <> 'open' then
		raise exception 'Exploration is no longer open' using errcode = '55000';
	end if;
$new$
]);

select pg_temp.ceks_patch('public.qorpera_undo_surface_change(uuid)'::regprocedure, array[
$old$	v_chosen_has_landed boolean := false;
$old$,
'',
$old$	if v_exploration.id is not null
		and v_exploration.status = 'chosen'
		and v_exploration.chosen_session_id is not null
		and v_exploration.chosen_session_id <> v_change.session_id then
		select exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.session_id = v_exploration.chosen_session_id
				and ch.status in ('merged', 'merging')
		) into v_chosen_has_landed;
		if v_chosen_has_landed then
			raise exception 'Undo the chosen exploration variant before restoring a discarded alternative' using errcode = '22023';
		end if;
	end if;
$old$,
$new$	if v_exploration.id is not null
		and v_exploration.status = 'chosen'
		and v_exploration.chosen_session_id is distinct from v_change.session_id then
		raise exception 'Another option was chosen; this one cannot be restored' using errcode = '22023';
	end if;
$new$,
$old$	-- WHY: Keep a chosen exploration closed while its winning session still has merged or merging changes on main.
	if v_exploration.id is not null
		and v_exploration.status = 'chosen'
		and v_exploration.chosen_session_id is not null then
		select exists (
			select 1 from public.qorpera_surface_changes ch
			where ch.session_id = v_exploration.chosen_session_id
				and ch.status in ('merged', 'merging')
		) into v_chosen_has_landed;

		if not v_chosen_has_landed then
			update public.qorpera_surface_explorations
			set status = 'open', chosen_session_id = null, resolved_at = null
			where id = v_exploration.id;

			update public.qorpera_surface_changes
			set status = 'staged', resolved_at = null, approved_by_user_id = null, discarded_by_exploration = false
			where session_id in (
				select id from public.qorpera_surface_sessions
				where exploration_id = v_exploration.id and id <> v_exploration.chosen_session_id
			) and status = 'discarded' and discarded_by_exploration = true and published_at is null;

			update public.qorpera_surface_sessions
			set state = 'ready', closed_at = null, updated_at = clock_timestamp()
			where exploration_id = v_exploration.id and id <> v_exploration.chosen_session_id and state = 'discarded';
		end if;
	end if;

$old$,
''
]);

drop function pg_temp.ceks_patch(regprocedure, text[]);

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

	if v_exploration.status <> 'open'
		and not (v_exploration.status = 'chosen' and v_exploration.chosen_session_id = p_session_id) then
		raise exception 'Exploration is no longer open' using errcode = '55000';
	end if;

	if v_exploration.status = 'open' then
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
	end if;

	select public.qorpera_surface_session_json(s) into v_winner
	from public.qorpera_surface_sessions s
	where s.id = p_session_id;
	return v_winner;
end $$;

revoke all on function public.qorpera_choose_exploration(uuid, uuid) from public, anon;
grant execute on function public.qorpera_choose_exploration(uuid, uuid) to authenticated;
