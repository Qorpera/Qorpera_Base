-- WHY: Persist change discard/restore events in session threads, expose resolvedChanges to turn reads, and stop coding turns from resurrecting or basing on discarded commits.
set local lock_timeout = '3s';

do $$
declare
	v_read_turn text;
begin
	if to_regprocedure('public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_change(uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_option_group(uuid,text)') is null
		or to_regprocedure('public.qorpera_undo_surface_change(uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)') is null then
		raise exception '20260930902000 requires prior surface migrations through 20260930900000';
	end if;
	v_read_turn := pg_get_functiondef('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure);
	if position('''resolvedChanges''' in v_read_turn) > 0 then
		raise exception '20260930902000 is already applied';
	end if;
end $$;

create temporary table sdaa_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.sdaa_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930902000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930902000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.sdaa_patch(
	'public.qorpera_discard_surface_change(uuid)'::regprocedure,
	array[
$old$	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
begin$old$,
$new$	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
	v_user_id uuid;
begin$new$,
$old$	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);$old$,
$new$	v_user_id := public.qorpera_assert_surface_member(v_lookup.profile_id, true);$new$,
$old$	if v_discarded_count > 0 then
		perform public.qorpera_surface_enqueue_standalone_dependents(v_change.surface_id, array[p_change_id]);
	end if;$old$,
$new$	if v_discarded_count > 0 then
		perform public.qorpera_surface_enqueue_standalone_dependents(v_change.surface_id, array[p_change_id]);

		insert into public.qorpera_surface_session_messages(
			profile_id, session_id, author_kind, author_user_id, body, change_id
		)
		values (
			v_change.profile_id,
			v_change.session_id,
			'system',
			v_user_id,
			case when v_change.option_group_key is not null then 'Discarded option: ' else 'Discarded change: ' end || v_change.title,
			v_change.id
		);

		update public.qorpera_surface_sessions
		set updated_at = clock_timestamp()
		where id = v_change.session_id;
	end if;$new$
	]
);

select pg_temp.sdaa_patch(
	'public.qorpera_discard_surface_option_group(uuid,text)'::regprocedure,
	array[
$old$	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
begin$old$,
$new$	v_locked_worker_ids uuid[] := '{}'::uuid[];
	v_was_discarded boolean := false;
	v_user_id uuid;
	v_discarded_titles text;
begin$new$,
$old$	perform public.qorpera_assert_surface_member(v_profile_id, true);$old$,
$new$	v_user_id := public.qorpera_assert_surface_member(v_profile_id, true);$new$,
$old$		returning ch.id
	)
	select coalesce(array_agg(id), '{}'::uuid[]) into v_discarded_ids from dropped;$old$,
$new$		returning ch.id, ch.seq, ch.title
	)
	select
		coalesce(array_agg(id order by seq asc, id asc), '{}'::uuid[]),
		string_agg(title, ', ' order by seq asc, id asc)
	into v_discarded_ids, v_discarded_titles
	from dropped;$new$,
$old$		perform public.qorpera_surface_enqueue_standalone_dependents(v_session.surface_id, v_discarded_ids);
	end if;$old$,
$new$		perform public.qorpera_surface_enqueue_standalone_dependents(v_session.surface_id, v_discarded_ids);

		insert into public.qorpera_surface_session_messages(
			profile_id, session_id, author_kind, author_user_id, body, change_id
		)
		values (
			v_session.profile_id,
			v_session.id,
			'system',
			v_user_id,
			case
				when cardinality(v_discarded_ids) = 1
					then 'Discarded option: ' || left(coalesce(v_discarded_titles, v_key), 400)
				else 'Discarded options: ' || left(coalesce(v_discarded_titles, v_key), 400)
			end,
			case when cardinality(v_discarded_ids) = 1 then v_discarded_ids[1] else null end
		);

		update public.qorpera_surface_sessions
		set updated_at = clock_timestamp()
		where id = p_session_id;
	end if;$new$
	]
);

select pg_temp.sdaa_patch(
	'public.qorpera_undo_surface_change(uuid)'::regprocedure,
	array[
$old$	update public.qorpera_surface_changes
	set status = 'staged', resolved_at = null, approved_by_user_id = null, discarded_by_exploration = false
	where id = any(v_undo_change_ids);$old$,
$new$	update public.qorpera_surface_changes
	set status = 'staged', resolved_at = null, approved_by_user_id = null, discarded_by_exploration = false
	where id = any(v_undo_change_ids);

	if v_change.status = 'discarded' then
		insert into public.qorpera_surface_session_messages(
			profile_id, session_id, author_kind, author_user_id, body, change_id
		)
		values (
			v_change.profile_id,
			v_change.session_id,
			'system',
			v_user_id,
			'Restored change: ' || v_change.title,
			v_change.id
		);
	end if;$new$
	]
);

select pg_temp.sdaa_patch(
	'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
	array[
$old$			where m.session_id = v_session.id
				and m.author_kind in ('member', 'session')
				and nullif(btrim(m.body), '') is not null$old$,
$new$			where m.session_id = v_session.id
				and (
					m.author_kind in ('member', 'session')
					or (
						m.author_kind = 'system'
						and (
							btrim(m.body) like 'Discarded %'
							or btrim(m.body) like 'Selected option: %'
							or btrim(m.body) like 'Restored change: %'
						)
					)
				)
				and nullif(btrim(m.body), '') is not null$new$,
$old$				case when s.author_kind = 'session' then 'You'
					else coalesce(nullif(left(regexp_replace(btrim(coalesce(pm.display_name, '')), '\s+', ' ', 'g'), 80), ''),
						'A teammate') end$old$,
$new$				case
					when s.author_kind = 'session' then 'You'
					when s.author_kind = 'system' then 'System'
					else coalesce(nullif(left(regexp_replace(btrim(coalesce(pm.display_name, '')), '\s+', ' ', 'g'), 80), ''),
						'A teammate')
				end$new$,
$old$		'openChanges', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', oc.id,
						'title', oc.title,
						'parentSha', oc.parent_sha,
						'headSha', oc.head_sha,
						'optionGroupKey', oc.option_group_key,
						'optionGroupTitle', oc.option_group_title
					)
					order by oc.seq asc
				)
				from (
					select c.id, c.seq, c.title, c.parent_sha, c.head_sha, c.option_group_key, c.option_group_title
					from public.qorpera_surface_changes c
					where c.session_id = v_session.id
						and c.status in ('staged', 'conflicted')
					order by c.seq desc
					limit 32
				) oc
			),
			'[]'::jsonb
		),$old$,
$new$		'openChanges', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', oc.id,
						'seq', oc.seq,
						'title', oc.title,
						'summary', left(coalesce(oc.summary, ''), 240),
						'status', oc.status,
						'parentSha', oc.parent_sha,
						'headSha', oc.head_sha,
						'affectedPaths', to_jsonb(coalesce(oc.affected_paths[1:12], '{}'::text[])),
						'optionGroupKey', oc.option_group_key,
						'optionGroupTitle', oc.option_group_title
					)
					order by oc.seq asc
				)
				from (
					select
						c.id, c.seq, c.title, c.summary, c.status,
						c.parent_sha, c.head_sha, c.affected_paths,
						c.option_group_key, c.option_group_title
					from public.qorpera_surface_changes c
					where c.session_id = v_session.id
						and c.status in ('staged', 'conflicted')
					order by c.seq desc
					limit 32
				) oc
			),
			'[]'::jsonb
		),
		'resolvedChanges', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', rc.id,
						'seq', rc.seq,
						'title', rc.title,
						'summary', left(coalesce(rc.summary, ''), 200),
						'status', rc.status,
						'parentSha', rc.parent_sha,
						'headSha', rc.head_sha,
						'affectedPaths', to_jsonb(coalesce(rc.affected_paths[1:12], '{}'::text[])),
						'optionGroupKey', rc.option_group_key,
						'optionGroupTitle', rc.option_group_title,
						'discardedByExploration', rc.discarded_by_exploration,
						'resolvedAt', rc.resolved_at
					)
					order by rc.seq asc
				)
				from (
					select
						c.id, c.seq, c.title, c.summary, c.status,
						c.parent_sha, c.head_sha, c.affected_paths,
						c.option_group_key, c.option_group_title,
						c.discarded_by_exploration, c.resolved_at
					from public.qorpera_surface_changes c
					where c.session_id = v_session.id
						and c.status in ('discarded', 'merged', 'reverted')
					order by coalesce(c.resolved_at, c.created_at) desc, c.seq desc
					limit 24
				) rc
			),
			'[]'::jsonb
		),$new$
	]
);

select pg_temp.sdaa_patch(
	'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text)'::regprocedure,
	array[
$old$	v_group_key text := nullif(lower(btrim(coalesce(p_option_group_key, ''))), '');
	v_result jsonb;
begin$old$,
$new$	v_group_key text := nullif(lower(btrim(coalesce(p_option_group_key, ''))), '');
	v_discarded_parent_title text;
	v_active_target_sha text;
	v_result jsonb;
begin$new$,
$old$	if coalesce(p_kind, 'git_range') = 'git_range' then
		if v_parent_sha is null then
			select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
			if v_group_key is not null then
				select nullif(btrim(c.parent_sha), '')
				into v_parent_sha
				from public.qorpera_surface_changes c
				where c.session_id = p_session_id
					and c.option_group_key = v_group_key
					and c.parent_sha is not null
					and c.status in ('staged', 'conflicted')
				order by c.seq asc
				limit 1;
			end if;
			if v_parent_sha is null then
				v_parent_sha := coalesce(
					(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
						where c.session_id = p_session_id and c.head_sha is not null
							and c.status in ('staged', 'conflicted')
						order by c.seq desc limit 1),
					nullif(btrim(coalesce(v_session.branch_head_sha, '')), ''),
					nullif(btrim(coalesce(v_session.base_sha, '')), ''),
					nullif(btrim(coalesce(v_surface.live_head_sha, '')), '')
				);
			end if;
		end if;
		if v_parent_sha is null or v_parent_sha !~ '^[0-9a-f]{40}$'
			or v_head_sha is null or v_head_sha !~ '^[0-9a-f]{40}$' then
			raise exception 'Git range change requires valid 40-hex parent and head commit SHAs' using errcode = '22023';
		end if;
	end if;$old$,
$new$	if coalesce(p_kind, 'git_range') = 'git_range' then
		select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
		if v_parent_sha is null then
			if v_group_key is not null then
				select nullif(btrim(c.parent_sha), '')
				into v_parent_sha
				from public.qorpera_surface_changes c
				where c.session_id = p_session_id
					and c.option_group_key = v_group_key
					and c.parent_sha is not null
					and c.status in ('staged', 'conflicted')
				order by c.seq asc
				limit 1;
			end if;
			if v_parent_sha is null then
				v_parent_sha := coalesce(
					(select nullif(btrim(c.head_sha), '') from public.qorpera_surface_changes c
						where c.session_id = p_session_id and c.head_sha is not null
							and c.status in ('staged', 'conflicted')
						order by c.seq desc limit 1),
					case
						when nullif(btrim(coalesce(v_session.branch_head_sha, '')), '') is not null
							and not exists (
								select 1 from public.qorpera_surface_changes dc
								where dc.session_id = p_session_id
									and dc.status = 'discarded'
									and dc.head_sha = btrim(v_session.branch_head_sha)
							)
						then nullif(btrim(coalesce(v_session.branch_head_sha, '')), '')
						when exists (
							select 1 from public.qorpera_surface_changes dc
							where dc.session_id = p_session_id
								and dc.status = 'discarded'
								and dc.head_sha = btrim(coalesce(v_session.branch_head_sha, ''))
						)
						then coalesce(
							nullif(btrim(coalesce(v_surface.live_head_sha, '')), ''),
							nullif(btrim(coalesce(v_session.base_sha, '')), '')
						)
						else null
					end,
					nullif(btrim(coalesce(v_session.base_sha, '')), ''),
					nullif(btrim(coalesce(v_surface.live_head_sha, '')), '')
				);
			end if;
		end if;
		if v_parent_sha is null or v_parent_sha !~ '^[0-9a-f]{40}$'
			or v_head_sha is null or v_head_sha !~ '^[0-9a-f]{40}$' then
			raise exception 'Git range change requires valid 40-hex parent and head commit SHAs' using errcode = '22023';
		end if;
		if v_parent_sha is distinct from nullif(btrim(coalesce(v_session.base_sha, '')), '')
			and v_parent_sha is distinct from nullif(btrim(coalesce(v_surface.live_head_sha, '')), '')
			and not exists (
				select 1 from public.qorpera_surface_changes ac
				where ac.session_id = p_session_id
					and ac.head_sha = v_parent_sha
					and ac.status in ('staged', 'conflicted', 'merging', 'merged')
			) then
			select dc.title into v_discarded_parent_title
			from public.qorpera_surface_changes dc
			where dc.session_id = p_session_id
				and dc.head_sha = v_parent_sha
				and dc.status = 'discarded'
			order by dc.seq desc
			limit 1;
			if v_discarded_parent_title is not null then
				select nullif(btrim(oc.head_sha), '') into v_active_target_sha
				from public.qorpera_surface_changes oc
				where oc.session_id = p_session_id
					and oc.head_sha is not null
					and oc.status in ('staged', 'conflicted')
				order by oc.seq desc
				limit 1;
				if v_active_target_sha is not null then
					raise exception 'parentSha % belongs to discarded change "%". Reset your working tree with `git read-tree --reset -u %` (keeping HEAD on the branch tip), commit on top of the active staged state, and pass parentSha "%".',
						v_parent_sha, v_discarded_parent_title, v_active_target_sha, v_active_target_sha
						using errcode = '22023';
				else
					v_active_target_sha := coalesce(
						nullif(btrim(coalesce(v_surface.live_head_sha, '')), ''),
						nullif(btrim(coalesce(v_session.base_sha, '')), ''),
						'main'
					);
					raise exception 'parentSha % belongs to discarded change "%". No staged changes remain open on this session; run `git reset --hard %` (after checking `git log %..HEAD` for unrecorded work), commit from main, and pass parentSha "%".',
						v_parent_sha, v_discarded_parent_title, v_active_target_sha, v_active_target_sha, v_active_target_sha
						using errcode = '22023';
				end if;
			end if;
		end if;
	end if;$new$
	]
);

select pg_temp.sdaa_patch(
	'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure,
	array[
$old$			v_prev_sha := coalesce(v_prev_sha, v_base_sha);
			if v_head_sha <> v_prev_sha then$old$,
$new$			v_prev_sha := coalesce(v_prev_sha, v_base_sha);
			if v_head_sha <> v_prev_sha
				and v_head_sha is distinct from nullif(btrim(coalesce(v_surf_session.branch_head_sha, '')), '')
				and not exists (
					select 1 from public.qorpera_surface_changes c
					where c.session_id = v_surf_session.id
						and c.head_sha = v_head_sha
				) then$new$
	]
);

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_discard_surface_change(uuid)'::regprocedure,
			'public.qorpera_discard_surface_option_group(uuid,text)'::regprocedure,
			'public.qorpera_undo_surface_change(uuid)'::regprocedure,
			'public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure,
			'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text)'::regprocedure,
			'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Discard agent awareness function has an API owner: %', v_owner;
		end if;
		execute format('grant select, insert on public.qorpera_surface_session_messages to %I', v_owner);
		execute format('grant select, update on public.qorpera_surface_sessions to %I', v_owner);
		execute format('grant select on public.qorpera_surface_changes, public.qorpera_surfaces to %I', v_owner);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join sdaa_before as b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930902000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.sdaa_patch(regprocedure, text[]);
drop table sdaa_before;
