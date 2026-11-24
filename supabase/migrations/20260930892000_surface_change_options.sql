set local lock_timeout = '3s';

do $$
declare
	v_session_json text;
begin
	if to_regprocedure('public.qorpera_surface_session_json(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_approve_surface_change(uuid,boolean)') is null
		or to_regprocedure('public.qorpera_approve_session_all(uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_change(uuid)') is null
		or to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean)') is null
		or to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null then
		raise exception 'Surface change options (20260930892000) requires prior surface migrations first';
	end if;
	v_session_json := pg_get_functiondef('public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure);
	if position('''optionGroupKey''' in v_session_json) > 0 then
		raise exception 'Surface change options (20260930892000) is already applied';
	end if;
end $$;

alter table public.qorpera_surface_changes
	add column if not exists option_group_key text,
	add column if not exists option_group_title text;

alter table public.qorpera_surface_changes
	drop constraint if exists qorpera_surface_changes_option_group_check,
	add constraint qorpera_surface_changes_option_group_check check (
		(option_group_key is null and option_group_title is null)
		or (
			option_group_key is not null
			and char_length(option_group_key) between 1 and 80
			and option_group_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
			and (option_group_title is null or char_length(btrim(option_group_title)) between 1 and 160)
		)
	);

create index if not exists qorpera_surface_changes_option_group_idx
	on public.qorpera_surface_changes(session_id, option_group_key)
	where option_group_key is not null;

create function pg_temp.sco_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930892000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930892000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.sco_patch('public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure, array[
$old$'kind', ch.kind,
					'status', ch.status,$old$,
$new$'kind', ch.kind,
					'status', ch.status,
					'optionGroupKey', ch.option_group_key,
					'optionGroupTitle', ch.option_group_title,$new$
]);

select pg_temp.sco_patch('public.qorpera_approve_surface_change(uuid,boolean)'::regprocedure, array[
$old$	if v_change.status not in ('staged', 'conflicted') then
		raise exception 'Change is not open for approval' using errcode = '22023';
	end if;$old$,
$new$	if v_change.status not in ('staged', 'conflicted') then
		raise exception 'Change is not open for approval' using errcode = '22023';
	end if;
	if v_change.option_group_key is not null and exists (
		select 1 from public.qorpera_surface_changes sib
		where sib.session_id = v_change.session_id
			and sib.option_group_key = v_change.option_group_key
			and sib.id <> v_change.id
			and sib.status in ('staged', 'conflicted')
	) then
		raise exception 'Choose one option before approving' using errcode = '22023';
	end if;$new$
]);

select pg_temp.sco_patch('public.qorpera_approve_session_all(uuid)'::regprocedure, array[
$old$	perform 1 from public.qorpera_surface_changes where session_id = p_session_id order by seq asc, id asc for update;$old$,
$new$	perform 1 from public.qorpera_surface_changes where session_id = p_session_id order by seq asc, id asc for update;
	if exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.session_id = p_session_id
			and ch.status in ('staged', 'conflicted')
			and ch.option_group_key is not null
		group by ch.option_group_key
		having count(*) > 1
	) then
		raise exception 'Choose an option before approving all changes' using errcode = '22023';
	end if;$new$
]);

select pg_temp.sco_patch('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure, array[
$old$				'sessionWorkerId', sess.worker_id,$old$,
$new$				'sessionWorkerId', sess.worker_id,
				'sessionBranchHeadSha', sess.branch_head_sha,$new$,
$old$				'siblingRemainingChanges', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'changeId', ch.id,
								'parentSha', ch.parent_sha,
								'headSha', ch.head_sha,
								'title', ch.title
							)
							order by ch.seq asc
						)$old$,
$new$				'siblingRemainingChanges', coalesce(
					(
						select jsonb_agg(
							jsonb_build_object(
								'changeId', ch.id,
								'parentSha', ch.parent_sha,
								'headSha', ch.head_sha,
								'title', ch.title,
								'optionGroupKey', ch.option_group_key
							)
							order by ch.seq asc
						)$new$,
$old$							jsonb_build_object(
								'sessionId', peer.id,
								'workerId', peer.worker_id,
								'remainingChanges', coalesce(peer_changes.items, '[]'::jsonb)
							)$old$,
$new$							jsonb_build_object(
								'sessionId', peer.id,
								'workerId', peer.worker_id,
								'branchHeadSha', peer.branch_head_sha,
								'remainingChanges', coalesce(peer_changes.items, '[]'::jsonb)
							)$new$,
$old$								jsonb_build_object(
									'changeId', pch.id,
									'parentSha', pch.parent_sha,
									'headSha', pch.head_sha,
									'title', pch.title
								)$old$,
$new$								jsonb_build_object(
									'changeId', pch.id,
									'parentSha', pch.parent_sha,
									'headSha', pch.head_sha,
									'title', pch.title,
									'optionGroupKey', pch.option_group_key
								)$new$
]);

select pg_temp.sco_patch('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure, array[
$old$				where c.session_id = v_session.id
					and c.kind = 'folder_patch'
					and c.status in ('staged', 'merging', 'conflicted')
					and o.op ->> 'path' in ($old$,
$new$				where c.session_id = v_session.id
					and c.kind = 'folder_patch'
					and c.status in ('staged', 'merging', 'conflicted')
					and c.option_group_key is null
					and o.op ->> 'path' in ($new$,
$old$				where c.session_id = v_session.id
					and c.kind = 'folder_patch'
					and c.status in ('staged', 'conflicted')
					and x.op_obj ->> 'op' in ('write_text', 'delete')$old$,
$new$				where c.session_id = v_session.id
					and c.kind = 'folder_patch'
					and c.status in ('staged', 'conflicted')
					and c.option_group_key is null
					and x.op_obj ->> 'op' in ('write_text', 'delete')$new$,
$old$		'branchHeadSha', v_session.branch_head_sha,$old$,
$new$		'branchHeadSha', v_session.branch_head_sha,
		'openChanges', coalesce(
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
					order by c.seq asc
					limit 32
				) oc
			),
			'[]'::jsonb
		),$new$
]);

select pg_temp.sco_patch('public.qorpera_undo_surface_change(uuid)'::regprocedure, array[
$old$	if v_change.published_at is not null then
		raise exception 'Published change cannot be rolled back before release; start a new change instead' using errcode = '22023';
	end if;$old$,
$new$	if v_change.published_at is not null then
		raise exception 'Published change cannot be rolled back before release; start a new change instead' using errcode = '22023';
	end if;
	if v_change.status = 'discarded' and v_change.option_group_key is not null and v_change.discarded_by_exploration then
		raise exception 'Another option was chosen; this one cannot be restored' using errcode = '22023';
	end if;$new$
]);

drop function pg_temp.sco_patch(regprocedure, text[]);

drop function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean);
create function public.qorpera_record_surface_change(
	p_session_id uuid,
	p_title text,
	p_summary text,
	p_kind text default 'git_range',
	p_parent_sha text default null,
	p_head_sha text default null,
	p_depends_on_change_ids uuid[] default '{}'::uuid[],
	p_affected_paths text[] default '{}'::text[],
	p_diff_stats jsonb default null,
	p_patch_manifest jsonb default null,
	p_finish_session boolean default false,
	p_option_group_key text default null,
	p_option_group_title text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_next_seq smallint;
	v_change public.qorpera_surface_changes%rowtype;
	v_superseded_ids uuid[];
	v_affected_session_ids uuid[];
	v_affected_sid uuid;
	v_group_key text := nullif(lower(btrim(coalesce(p_option_group_key, ''))), '');
	v_group_title text := nullif(btrim(coalesce(p_option_group_title, '')), '');
	v_existing_group_parent text;
	v_existing_group_title text;
begin
	if v_group_key is null and v_group_title is not null then
		raise exception 'optionGroupTitle requires optionGroup' using errcode = '22023';
	end if;
	if v_group_key is not null then
		if char_length(v_group_key) > 80 or v_group_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
			raise exception 'optionGroup must be 1..80 lower-case letters, digits, and single hyphens' using errcode = '22023';
		end if;
		if v_group_title is not null and char_length(v_group_title) > 160 then
			raise exception 'optionGroupTitle must be at most 160 characters' using errcode = '22023';
		end if;
	end if;

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;

	if v_group_key is not null then
		select
			nullif(btrim(c.parent_sha), ''),
			nullif(btrim(c.option_group_title), '')
		into v_existing_group_parent, v_existing_group_title
		from public.qorpera_surface_changes c
		where c.session_id = p_session_id
			and c.option_group_key = v_group_key
			and c.status in ('staged', 'conflicted')
		order by c.seq asc
		limit 1;

		if v_group_title is null and v_existing_group_title is not null then
			v_group_title := v_existing_group_title;
		end if;
		if coalesce(p_kind, 'git_range') = 'git_range'
			and v_existing_group_parent is not null
			and p_parent_sha is distinct from v_existing_group_parent then
			raise exception 'All git options in the same optionGroup must share the same parentSha' using errcode = '22023';
		end if;
	end if;

	select coalesce(max(seq), 0)::smallint + 1 into v_next_seq
	from public.qorpera_surface_changes
	where session_id = p_session_id;

	insert into public.qorpera_surface_changes(
		profile_id, surface_id, session_id, seq, title, summary, kind,
		parent_sha, head_sha, depends_on_change_ids, affected_paths, diff_stats, patch_manifest, status,
		option_group_key, option_group_title
	)
	values (
		v_session.profile_id, v_session.surface_id, p_session_id, v_next_seq,
		btrim(p_title), coalesce(p_summary, ''), coalesce(p_kind, 'git_range'),
		p_parent_sha, p_head_sha, coalesce(p_depends_on_change_ids, '{}'::uuid[]),
		coalesce(p_affected_paths, '{}'::text[]), p_diff_stats, p_patch_manifest, 'staged',
		v_group_key, v_group_title
	)
	returning * into v_change;

	insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body, change_id)
	values (
		v_session.profile_id, p_session_id, 'system',
		case when v_group_key is not null then 'Staged option: ' else 'Staged change: ' end
			|| v_change.title
			|| case when char_length(v_change.summary) > 0 then ' — ' || v_change.summary else '' end,
		v_change.id
	);

	-- WHY: 20260930860000 discards superseded conflicted changes once a reconciliation session records a resolved change.
	if (
		v_session.state in ('reconciling', 'reconciling_running')
		or v_session.origin_label = 'Conflict reconciliation'
	) and jsonb_typeof(v_session.origin_ref -> 'changeIds') = 'array' then
		-- WHY: Lock superseded sessions in canonical id order before updating their changes so approve/undo cannot deadlock (40P01).
		perform 1
		from public.qorpera_surface_sessions s
		where s.surface_id = v_session.surface_id
			and s.profile_id = v_session.profile_id
			and s.id <> p_session_id
			and s.id in (
				select ch.session_id
				from public.qorpera_surface_changes ch
				where ch.surface_id = v_session.surface_id
					and ch.profile_id = v_session.profile_id
					and ch.id <> v_change.id
					and ch.id in (
						select x::uuid
						from jsonb_array_elements_text(v_session.origin_ref -> 'changeIds') as x
					)
			)
		order by s.id asc
		for update;

		with resolved as (
			update public.qorpera_surface_changes ch
			set
				status = 'discarded',
				conflict_paths = null,
				resolved_at = clock_timestamp()
			where ch.surface_id = v_session.surface_id
				and ch.profile_id = v_session.profile_id
				and ch.id <> v_change.id
				and ch.status = 'conflicted'
				and ch.id in (
					select x::uuid
					from jsonb_array_elements_text(v_session.origin_ref -> 'changeIds') as x
				)
			returning ch.id, ch.session_id
		)
		select
			coalesce(array_agg(distinct id), '{}'::uuid[]),
			coalesce(array_agg(distinct session_id order by session_id), '{}'::uuid[])
		into v_superseded_ids, v_affected_session_ids
		from resolved;

		if cardinality(v_superseded_ids) > 0 then
			update public.qorpera_member_surface_state
			set toggled_change_ids = array(
				select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_superseded_ids))
			)
			where surface_id = v_session.surface_id;

			foreach v_affected_sid in array v_affected_session_ids loop
				if v_affected_sid <> p_session_id then
					perform public.qorpera_evaluate_surface_session_lifecycle(v_affected_sid);
				end if;
			end loop;
		end if;
	end if;

	update public.qorpera_surface_sessions
	set
		branch_head_sha = coalesce(p_head_sha, branch_head_sha),
		state = case when p_finish_session then 'ready' else state end,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	return jsonb_build_object(
		'changeId', v_change.id,
		'seq', v_change.seq,
		'session', public.qorpera_surface_session_json(v_session)
	);
end $$;
revoke all on function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_record_surface_change(uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, text, text) to service_role;

drop function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid);
create function public.qorpera_native_surface_record_change(
	p_profile_id uuid,
	p_session_id uuid,
	p_title text,
	p_summary text,
	p_kind text default 'git_range',
	p_parent_sha text default null,
	p_head_sha text default null,
	p_depends_on_change_ids uuid[] default '{}'::uuid[],
	p_affected_paths text[] default '{}'::text[],
	p_diff_stats jsonb default null,
	p_patch_manifest jsonb default null,
	p_finish_session boolean default false,
	p_lease_token uuid default null,
	p_option_group_key text default null,
	p_option_group_title text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_parent_sha text := nullif(btrim(coalesce(p_parent_sha, '')), '');
	v_head_sha text := nullif(btrim(coalesce(p_head_sha, '')), '');
	v_group_key text := nullif(lower(btrim(coalesce(p_option_group_key, ''))), '');
	v_result jsonb;
begin
	if p_lease_token is null then
		raise exception 'Surface change recording requires lease token' using errcode = '42501';
	end if;
	select * into v_session
	from public.qorpera_surface_sessions s
	where s.id = p_session_id and s.profile_id = p_profile_id
	for update;
	if v_session.id is null then
		raise exception 'Surface session does not belong to profile' using errcode = '42501';
	end if;
	if v_session.state not in ('running', 'reconciling_running') or v_session.lease_token is distinct from p_lease_token then
		raise exception 'Surface session lease is not active' using errcode = '42501';
	end if;
	if coalesce(p_kind, 'git_range') = 'git_range' then
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
	end if;
	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session,
		p_option_group_key, p_option_group_title
	);
	-- WHY: 20260930855000 keeps wake_id intact when finishing inside a run so runner job completion stays authorized.
	return v_result;
end $$;
revoke all on function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function public.qorpera_native_surface_record_change(uuid, uuid, text, text, text, text, text, uuid[], text[], jsonb, jsonb, boolean, uuid, text, text) to service_role;

create or replace function public.qorpera_discard_surface_change(p_change_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_lookup record;
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_survivor_ids uuid[];
begin
	select session_id, surface_id, profile_id into v_lookup
	from public.qorpera_surface_changes
	where id = p_change_id;
	if v_lookup.session_id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);

	select * into v_session from public.qorpera_surface_sessions where id = v_lookup.session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform 1 from public.qorpera_surfaces where id = v_session.surface_id for update;
	perform 1 from public.qorpera_surface_changes where session_id = v_session.id order by seq asc, id asc for update;

	select * into v_change from public.qorpera_surface_changes where id = p_change_id;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;

	update public.qorpera_surface_changes
	set status = 'discarded', resolved_at = clock_timestamp()
	where id = p_change_id and status in ('staged', 'conflicted');

	if v_change.option_group_key is not null then
		select coalesce(array_agg(ch.id), '{}'::uuid[])
		into v_survivor_ids
		from public.qorpera_surface_changes ch
		where ch.session_id = v_change.session_id
			and ch.option_group_key = v_change.option_group_key
			and ch.status in ('staged', 'conflicted');

		if cardinality(v_survivor_ids) = 1 then
			update public.qorpera_surface_changes
			set option_group_key = null, option_group_title = null
			where id = v_survivor_ids[1];
		end if;
	end if;

	update public.qorpera_member_surface_state
	set toggled_change_ids = array_remove(toggled_change_ids, p_change_id)
	where surface_id = v_change.surface_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_discard_surface_change(uuid) from public, anon;
grant execute on function public.qorpera_discard_surface_change(uuid) to authenticated;

create function public.qorpera_choose_surface_change_option(p_change_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_lookup record;
	v_change public.qorpera_surface_changes%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_discarded_ids uuid[];
begin
	select session_id, surface_id, profile_id into v_lookup
	from public.qorpera_surface_changes
	where id = p_change_id;
	if v_lookup.session_id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_lookup.profile_id, true);

	select * into v_session from public.qorpera_surface_sessions where id = v_lookup.session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform 1 from public.qorpera_surfaces where id = v_session.surface_id for update;
	perform 1 from public.qorpera_surface_changes where session_id = v_session.id order by seq asc, id asc for update;

	select * into v_change from public.qorpera_surface_changes where id = p_change_id;
	if v_change.id is null then raise exception 'Change not found' using errcode = 'P0002'; end if;

	if v_change.status not in ('staged', 'conflicted') then
		raise exception 'Option is no longer open' using errcode = '55000';
	end if;

	if v_change.option_group_key is not null then
		with dropped as (
			update public.qorpera_surface_changes ch
			set status = 'discarded', discarded_by_exploration = true, resolved_at = clock_timestamp()
			where ch.session_id = v_change.session_id
				and ch.option_group_key = v_change.option_group_key
				and ch.id <> v_change.id
				and ch.status in ('staged', 'conflicted')
			returning ch.id
		)
		select coalesce(array_agg(id), '{}'::uuid[]) into v_discarded_ids from dropped;

		update public.qorpera_surface_changes
		set option_group_key = null, option_group_title = null
		where id = v_change.id;

		if cardinality(v_discarded_ids) > 0 then
			update public.qorpera_member_surface_state
			set toggled_change_ids = array(
				select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_discarded_ids))
			)
			where surface_id = v_change.surface_id;
		end if;

		insert into public.qorpera_surface_session_messages(profile_id, session_id, author_kind, body, change_id)
		values (
			v_change.profile_id, v_change.session_id, 'system',
			'Selected option: ' || v_change.title,
			v_change.id
		);

		update public.qorpera_surface_sessions
		set updated_at = clock_timestamp()
		where id = v_change.session_id;
	end if;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(v_change.session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_choose_surface_change_option(uuid) from public, anon;
grant execute on function public.qorpera_choose_surface_change_option(uuid) to authenticated;

create function public.qorpera_discard_surface_option_group(p_session_id uuid, p_option_group_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_session public.qorpera_surface_sessions%rowtype;
	v_key text := nullif(lower(btrim(coalesce(p_option_group_key, ''))), '');
	v_discarded_ids uuid[];
begin
	if v_key is null or char_length(v_key) > 80 or v_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
		raise exception 'Invalid option group key' using errcode = '22023';
	end if;

	select profile_id into v_profile_id from public.qorpera_surface_sessions where id = p_session_id;
	if v_profile_id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform public.qorpera_assert_surface_member(v_profile_id, true);

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then raise exception 'Surface session not found' using errcode = 'P0002'; end if;
	perform 1 from public.qorpera_surfaces where id = v_session.surface_id for update;
	perform 1 from public.qorpera_surface_changes where session_id = v_session.id order by seq asc, id asc for update;

	with dropped as (
		update public.qorpera_surface_changes ch
		set status = 'discarded', resolved_at = clock_timestamp()
		where ch.session_id = p_session_id
			and ch.option_group_key = v_key
			and ch.status in ('staged', 'conflicted')
		returning ch.id
	)
	select coalesce(array_agg(id), '{}'::uuid[]) into v_discarded_ids from dropped;

	if cardinality(v_discarded_ids) > 0 then
		update public.qorpera_member_surface_state
		set toggled_change_ids = array(
			select cid from unnest(toggled_change_ids) as cid where not (cid = any(v_discarded_ids))
		)
		where surface_id = v_session.surface_id;
	end if;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_discard_surface_option_group(uuid, text) from public, anon;
grant execute on function public.qorpera_discard_surface_option_group(uuid, text) to authenticated;
