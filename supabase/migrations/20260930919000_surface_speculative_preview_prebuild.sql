set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_preview_build_settle(uuid)') is null
		or to_regprocedure('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)') is null
		or to_regprocedure('public.qorpera_company_coding_at_zero(uuid,timestamptz)') is null
		or to_regprocedure('public.qorpera_company_deleting(uuid)') is null then
		raise exception '20260930919000 requires 20260930901000 and 20260930916000 first';
	end if;
	if to_regprocedure('public.qorpera_surface_enqueue_speculative_preview(uuid,uuid,uuid)') is not null then
		raise exception '20260930919000 is already applied';
	end if;
end $$;

create temporary table sspp_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.sspp_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930919000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		if p_pairs[v_i] = '' then
			raise exception '20260930919000: empty anchor for %', p_target;
		end if;
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930919000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 140);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create function public.qorpera_surface_enqueue_speculative_preview(
	p_surface_id uuid,
	p_session_id uuid,
	p_change_id uuid
)
returns void
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_change public.qorpera_surface_changes%rowtype;
	v_default_ids uuid[];
	v_preview public.qorpera_surface_previews%rowtype;
	v_requester uuid;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null
		or v_surface.source_kind <> 'code_repo'
		or v_surface.status <> 'active'
		or v_surface.site_id is null
		or nullif(btrim(coalesce(v_surface.live_head_sha, '')), '') is null
		or public.qorpera_company_deleting(v_surface.profile_id)
		or public.qorpera_company_coding_at_zero(v_surface.profile_id, v_now) then
		return;
	end if;

	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id and surface_id = p_surface_id;
	if v_session.id is null or coalesce(v_session.is_internal, false) then
		return;
	end if;

	select * into v_change
	from public.qorpera_surface_changes
	where id = p_change_id and surface_id = p_surface_id and session_id = p_session_id;
	if v_change.id is null or v_change.kind <> 'git_range' or v_change.status <> 'staged' then
		return;
	end if;

	with open_non_exp as (
		select
			ch.id,
			ch.session_id,
			ch.option_group_key,
			ch.created_at,
			ch.seq,
			row_number() over (
				partition by ch.session_id, ch.option_group_key
				order by ch.seq asc, ch.id asc
			) as group_rank
		from public.qorpera_surface_changes ch
		join public.qorpera_surface_sessions s on s.id = ch.session_id
		where ch.surface_id = p_surface_id
			and ch.profile_id = v_surface.profile_id
			and ch.kind = 'git_range'
			and ch.status in ('staged', 'conflicted')
			and s.exploration_id is null
			and s.state <> 'discarded'
			and not coalesce(s.is_internal, false)
	)
	select coalesce(array_agg(id order by created_at asc, seq asc, id asc), '{}'::uuid[])
	into v_default_ids
	from open_non_exp
	where option_group_key is null or group_rank = 1;

	if v_session.exploration_id is not null then
		v_preview := public.qorpera_surface_upsert_preview(
			v_surface,
			v_surface.live_head_sha,
			coalesce(v_default_ids, '{}'::uuid[]),
			v_session.id
		);
	else
		if v_change.option_group_key is not null and not (v_change.id = any(coalesce(v_default_ids, '{}'::uuid[]))) then
			return;
		end if;
		if coalesce(cardinality(v_default_ids), 0) = 0 then
			return;
		end if;
		v_preview := public.qorpera_surface_upsert_preview(
			v_surface,
			v_surface.live_head_sha,
			v_default_ids,
			null
		);
	end if;

	v_requester := coalesce(v_session.created_by_user_id, v_surface.created_by_user_id);
	if v_preview.id is not null and v_preview.requested_by_user_id is null and v_requester is not null then
		update public.qorpera_surface_previews
		set requested_by_user_id = v_requester
		where id = v_preview.id and requested_by_user_id is null;
	end if;
end $$;

revoke all on function public.qorpera_surface_enqueue_speculative_preview(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.sspp_patch(
	'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)'::regprocedure,
	array[
$old$		perform public.qorpera_surface_enqueue_chain_reconciliation(v_session.surface_id, v_change.id);

		update public.qorpera_surface_sessions
		set
			branch_head_sha = coalesce(v_eff_head_sha, branch_head_sha),
			state = case when p_finish_session then 'ready' else state end,
			updated_at = v_now
		where id = p_session_id
		returning * into v_session;$old$,
$new$		perform public.qorpera_surface_enqueue_chain_reconciliation(v_session.surface_id, v_change.id);

		update public.qorpera_surface_sessions
		set
			branch_head_sha = coalesce(v_eff_head_sha, branch_head_sha),
			state = case when p_finish_session then 'ready' else state end,
			updated_at = v_now
		where id = p_session_id
		returning * into v_session;

		perform public.qorpera_surface_enqueue_speculative_preview(v_session.surface_id, p_session_id, v_change.id);$new$,
$old$	update public.qorpera_surface_sessions
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
	);$old$,
$new$	update public.qorpera_surface_sessions
	set
		branch_head_sha = coalesce(p_head_sha, branch_head_sha),
		state = case when p_finish_session then 'ready' else state end,
		updated_at = clock_timestamp()
	where id = p_session_id
	returning * into v_session;

	perform public.qorpera_surface_enqueue_speculative_preview(v_session.surface_id, p_session_id, v_change.id);

	return jsonb_build_object(
		'changeId', v_change.id,
		'seq', v_change.seq,
		'session', public.qorpera_surface_session_json(v_session)
	);$new$
	]
);

select pg_temp.sspp_patch(
	'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
	array[
$old$	-- WHY: 20260930860000 filters and deduplicates toggled changes to open staged/conflicted rows in input order.
	if cardinality(v_toggled) > 0 then
		select coalesce(array_agg(dedup.cid order by dedup.first_ord), '{}'::uuid[])
		into v_toggled
		from (
			select u.cid, min(u.ord) as first_ord
			from unnest(v_toggled) with ordinality as u(cid, ord)
			join public.qorpera_surface_changes ch
				on ch.id = u.cid
				and ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.status in ('staged', 'conflicted')
			group by u.cid
		) dedup;
	end if;$old$,
$new$	-- WHY: Canonical (created_at, seq, id) order matches speculative pre-build composition keys across sessions.
	if cardinality(v_toggled) > 0 then
		select coalesce(array_agg(dedup.cid order by dedup.created_at asc, dedup.seq asc, dedup.cid asc), '{}'::uuid[])
		into v_toggled
		from (
			select distinct ch.id as cid, ch.created_at, ch.seq
			from unnest(v_toggled) as u(cid)
			join public.qorpera_surface_changes ch
				on ch.id = u.cid
				and ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.status in ('staged', 'conflicted')
		) dedup;
	end if;$new$
	]
);

select pg_temp.sspp_patch(
	'public.qorpera_surface_preview_build_settle(uuid)'::regprocedure,
	array[
$old$				update public.qorpera_surface_previews p
				set
					status = 'ready',
					composite_tree_sha = v_build.tree_sha,
					site_version_id = v_version_id,
					conflict_report = null,
					error_detail = null,
					attempts = 0,
					lease_expires_at = null,
					lease_token = null,
					expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else least(p.expires_at, v_now) end,
					updated_at = v_now
				where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;$old$,
$new$				update public.qorpera_surface_previews p
				set
					status = 'ready',
					composite_tree_sha = v_build.tree_sha,
					site_version_id = v_version_id,
					conflict_report = null,
					error_detail = null,
					attempts = 0,
					lease_expires_at = null,
					lease_token = null,
					expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else greatest(least(p.expires_at, v_now + interval '1 hour'), v_now) end,
					updated_at = v_now
				where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;$new$
	]
);

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct r.rolname
		from pg_proc as p
		join pg_roles as r on r.oid = p.proowner
		where p.oid = any(array[
			'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Speculative preview function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_enqueue_speculative_preview(uuid, uuid, uuid) to %I',
			v_owner
		);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc as p
	join sspp_before as b on b.oid = p.oid
	where (to_jsonb(p) - 'prosrc') is distinct from b.fields;
	if v_bad is not null then
		raise exception '20260930919000 changed function attributes for: %', v_bad;
	end if;
end $$;
