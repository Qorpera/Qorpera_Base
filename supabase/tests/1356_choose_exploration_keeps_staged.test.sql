-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.ceks_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'choose_exploration_keeps_staged: %', p_message;
	end if;
end $$;

create function pg_temp.ceks_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.ceks_choose_refused(p_user_id uuid, p_exploration_id uuid, p_session_id uuid)
returns text language plpgsql as $$
declare v_errcode text;
begin
	perform pg_temp.ceks_as(p_user_id);
	set local role authenticated;
	begin
		perform public.qorpera_choose_exploration(p_exploration_id, p_session_id);
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	return v_errcode;
end $$;

create function pg_temp.ceks_errcode(p_user_id uuid, p_sql text)
returns text language plpgsql as $$
declare v_errcode text;
begin
	perform pg_temp.ceks_as(p_user_id);
	set local role authenticated;
	begin
		execute p_sql;
	exception when others then
		v_errcode := sqlstate;
	end;
	reset role;
	return v_errcode;
end $$;

create function pg_temp.ceks_snapshot(p_surface_id uuid)
returns text language sql as $$
	select coalesce((select string_agg(concat_ws('/', c.id, c.status, c.discarded_by_exploration, c.resolved_at, c.approved_by_user_id), ',' order by c.id)
			from public.qorpera_surface_changes c where c.surface_id = p_surface_id), '')
		|| '|' || coalesce((select string_agg(concat_ws('/', s.id, s.state, s.closed_at, s.updated_at, s.has_active_chat), ',' order by s.id)
			from public.qorpera_surface_sessions s where s.surface_id = p_surface_id), '')
		|| '|' || coalesce((select string_agg(concat_ws('/', e.id, e.status, e.chosen_session_id, e.resolved_at), ',' order by e.id)
			from public.qorpera_surface_explorations e where e.surface_id = p_surface_id), '')
		|| '|' || (select count(*) from public.qorpera_surface_jobs j where j.surface_id = p_surface_id)
$$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_outsider constant uuid := '13560000-0000-4000-8000-000000000099';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_surface uuid;
	v_plain uuid;
	v_exploration uuid;
	v_other_exploration uuid;
	v_other_variant uuid;
	v_winner uuid;
	v_loser_a uuid;
	v_loser_b uuid;
	v_w1 uuid;
	v_w2 uuid;
	v_a1 uuid;
	v_a2 uuid;
	v_b1 uuid;
	v_b_manual uuid;
	v_head_before text;
	v_unpublished_before integer;
	v_jobs_before integer;
	v_result jsonb;
	v_again jsonb;
	v_snapshot text;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role)
	select v_company, v_bo, 'bo@example.test', 'Bo', 'contributor'
	where not exists (select 1 from public.qorpera_profile_members where profile_id = v_company and user_id = v_bo);
	insert into auth.users(id, email) values (v_outsider, 'ceks-outsider@example.test');

	perform pg_temp.ceks_as(v_anna);
	set local role authenticated;
	v_surface := (public.qorpera_create_surface(v_company, 'Cafe Site', 'cafe-site', 'studio', 'report', 'figure:book', null,
		'surfaces/cafe-site', null, false) ->> 'id')::uuid;
	v_exploration := (public.qorpera_start_surface_session(v_surface, 'Explore three hero directions', null, 'member', null, null,
		3, 'Hero directions', array['Warm', 'Minimal', 'Bold']) ->> 'explorationId')::uuid;
	v_other_exploration := (public.qorpera_start_surface_session(v_surface, 'Explore two footers', null, 'member', null, null,
		2, 'Footers', array['Short', 'Long']) ->> 'explorationId')::uuid;
	v_plain := (public.qorpera_start_surface_session(v_surface, 'Fix the menu prices', 'Prices') ->> 'id')::uuid;
	reset role;

	select id into v_winner from public.qorpera_surface_sessions
	where exploration_id = v_exploration order by created_at, id limit 1;
	select id into v_loser_a from public.qorpera_surface_sessions
	where exploration_id = v_exploration and id <> v_winner order by created_at, id limit 1;
	select id into v_loser_b from public.qorpera_surface_sessions
	where exploration_id = v_exploration and id not in (v_winner, v_loser_a);
	select id into v_other_variant from public.qorpera_surface_sessions
	where exploration_id = v_other_exploration order by created_at, id limit 1;
	perform pg_temp.ceks_assert(v_loser_b is not null and v_other_variant is not null, 'both explorations spawned their variants');

	update public.qorpera_surface_sessions set state = 'ready', lease_token = null, lease_expires_at = null
	where exploration_id in (v_exploration, v_other_exploration);

	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_winner, 1, 'Warm hero', 'Warm photo', 'folder_patch', 'staged')
	returning id into v_w1;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_winner, 2, 'Warm headline', 'Warm words', 'folder_patch', 'staged')
	returning id into v_w2;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_loser_a, 1, 'Minimal hero', 'White space', 'folder_patch', 'staged')
	returning id into v_a1;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_loser_a, 2, 'Minimal type', 'Thin type', 'folder_patch', 'conflicted')
	returning id into v_a2;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_loser_b, 1, 'Bold hero', 'Big colour', 'folder_patch', 'staged')
	returning id into v_b1;
	insert into public.qorpera_surface_changes(profile_id, surface_id, session_id, seq, title, summary, kind, status)
	values (v_company, v_surface, v_loser_b, 2, 'Bold footer', 'Dropped by hand', 'folder_patch', 'discarded')
	returning id into v_b_manual;

	insert into public.qorpera_member_surface_state(user_id, surface_id, active_exploration_session_id, toggled_change_ids, compare_session_ids)
	values (v_anna, v_surface, v_loser_a, array[v_w1], array[v_winner, v_loser_a, v_loser_b]),
		(v_bo, v_surface, v_winner, '{}'::uuid[], array[v_winner, v_loser_b]);

	select live_head_sha, unpublished_change_count into v_head_before, v_unpublished_before
	from public.qorpera_surfaces where id = v_surface;
	select count(*) into v_jobs_before from public.qorpera_surface_jobs where surface_id = v_surface;

	perform pg_temp.ceks_assert(pg_temp.ceks_choose_refused(v_anna, v_exploration, v_other_variant) = '42501',
		'a variant of another exploration is refused');
	perform pg_temp.ceks_assert(pg_temp.ceks_choose_refused(v_anna, v_exploration, v_plain) = '42501',
		'a session outside any exploration is refused');
	perform pg_temp.ceks_assert(pg_temp.ceks_choose_refused(v_outsider, v_exploration, v_winner) = '42501',
		'a non-member is refused');
	perform pg_temp.ceks_assert(
		(select status = 'open' and chosen_session_id is null from public.qorpera_surface_explorations where id = v_exploration)
		and (select count(*) from public.qorpera_surface_changes
			where session_id in (v_winner, v_loser_a, v_loser_b) and status in ('staged', 'conflicted')) = 5,
		'a refused choice changes nothing');

	perform pg_temp.ceks_as(v_anna);
	set local role authenticated;
	v_result := public.qorpera_choose_exploration(v_exploration, v_winner);
	reset role;

	perform pg_temp.ceks_assert(
		(select bool_and(status = 'staged' and approved_by_user_id is null and resolved_at is null and published_at is null)
			from public.qorpera_surface_changes where id in (v_w1, v_w2)),
		'the chosen variant''s changes stay staged, none approved');
	perform pg_temp.ceks_assert(
		(select live_head_sha is not distinct from v_head_before and unpublished_change_count = v_unpublished_before
			from public.qorpera_surfaces where id = v_surface)
		and (select count(*) from public.qorpera_surface_jobs where surface_id = v_surface) = v_jobs_before,
		'Base is untouched: no new head, no unpublished count, no merge job');
	perform pg_temp.ceks_assert(
		(select state = 'ready' and closed_at is null and exploration_id = v_exploration
			from public.qorpera_surface_sessions where id = v_winner),
		'the chosen variant goes on as an open session and keeps its exploration');
	perform pg_temp.ceks_assert(
		(select bool_and(status = 'discarded' and discarded_by_exploration and resolved_at is not null)
			from public.qorpera_surface_changes where id in (v_a1, v_a2, v_b1))
		and (select status = 'discarded' and not discarded_by_exploration
			from public.qorpera_surface_changes where id = v_b_manual),
		'the other variants'' open changes are discarded by the exploration; a change dropped by hand keeps its tag');
	perform pg_temp.ceks_assert(
		(select bool_and(state = 'discarded' and closed_at is not null and not has_active_chat and lease_token is null)
			from public.qorpera_surface_sessions where id in (v_loser_a, v_loser_b)),
		'the other variants'' sessions are closed');
	perform pg_temp.ceks_assert(
		(select status = 'chosen' and chosen_session_id = v_winner and resolved_at is not null
			from public.qorpera_surface_explorations where id = v_exploration)
		and (select status = 'open' from public.qorpera_surface_explorations where id = v_other_exploration)
		and (select state = 'ready' from public.qorpera_surface_sessions where id = v_other_variant),
		'the exploration is chosen with its winner; another exploration is left alone');
	perform pg_temp.ceks_assert(
		(select bool_and(active_exploration_session_id is null and compare_session_ids = '{}'::uuid[])
			from public.qorpera_member_surface_state where surface_id = v_surface)
		and (select toggled_change_ids = array[v_w1] from public.qorpera_member_surface_state
			where user_id = v_anna and surface_id = v_surface),
		'every member''s exploration view is cleared; a toggled winner change stays toggled');
	perform pg_temp.ceks_assert(
		v_result ->> 'id' = v_winner::text
		and v_result ->> 'explorationId' = v_exploration::text
		and v_result ->> 'state' = 'ready'
		and (v_result ->> 'openChangeCount')::integer = 2
		and (select bool_and(c ->> 'status' = 'staged') from jsonb_array_elements(v_result -> 'changes') c),
		'the answer is the chosen session with its staged changes, got ' || v_result::text);

	v_snapshot := pg_temp.ceks_snapshot(v_surface);
	perform pg_temp.ceks_as(v_bo);
	set local role authenticated;
	v_again := public.qorpera_choose_exploration(v_exploration, v_winner);
	reset role;
	perform pg_temp.ceks_assert(v_again = v_result and pg_temp.ceks_snapshot(v_surface) = v_snapshot,
		'choosing the chosen option again answers the same and changes nothing');

	perform pg_temp.ceks_assert(pg_temp.ceks_choose_refused(v_bo, v_exploration, v_loser_a) = '55000',
		'choosing another option after the choice is refused');
	perform pg_temp.ceks_assert(
		pg_temp.ceks_errcode(v_anna, format('select public.qorpera_discard_exploration(%L::uuid)', v_exploration)) = '55000',
		'discarding a chosen exploration is refused');
	perform pg_temp.ceks_assert(
		pg_temp.ceks_errcode(v_anna, format('select public.qorpera_undo_surface_change(%L::uuid)', v_a1)) = '22023',
		'restoring an option that was not chosen is refused');
	perform pg_temp.ceks_assert(pg_temp.ceks_snapshot(v_surface) = v_snapshot,
		'the refused choice, discard and restore change nothing: the winner''s work stays staged');

	perform pg_temp.ceks_as(v_anna);
	set local role authenticated;
	perform public.qorpera_discard_surface_change(v_w2);
	reset role;
	perform pg_temp.ceks_assert((select status from public.qorpera_surface_changes where id = v_w2) = 'discarded',
		'a chosen option''s change can be discarded by hand');
	perform pg_temp.ceks_as(v_anna);
	set local role authenticated;
	perform public.qorpera_undo_surface_change(v_w2);
	reset role;
	perform pg_temp.ceks_assert(
		(select status = 'staged' and not discarded_by_exploration from public.qorpera_surface_changes where id = v_w2)
		and (select status = 'chosen' and chosen_session_id = v_winner from public.qorpera_surface_explorations where id = v_exploration)
		and (select bool_and(status = 'discarded' and discarded_by_exploration)
			from public.qorpera_surface_changes where id in (v_a1, v_a2, v_b1))
		and (select bool_and(state = 'discarded' and closed_at is not null)
			from public.qorpera_surface_sessions where id in (v_loser_a, v_loser_b))
		and (select state = 'ready' and closed_at is null from public.qorpera_surface_sessions where id = v_winner),
		'undoing a hand discard of the chosen option''s change restores only that change; the exploration stays chosen');

	perform pg_temp.ceks_as(v_anna);
	set local role authenticated;
	perform public.qorpera_approve_surface_change(v_w1);
	reset role;
	perform pg_temp.ceks_assert(
		(select status from public.qorpera_surface_changes where id = v_w1) = 'merged'
		and (select status from public.qorpera_surface_changes where id = v_w2) = 'staged',
		'the chosen variant''s changes can then be approved one by one');
end $$;
