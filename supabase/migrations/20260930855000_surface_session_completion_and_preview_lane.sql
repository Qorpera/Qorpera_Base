-- WHY: Preserve surface-session wake authority through runner job completion, keep surface-session runs
-- out of Co-Founder chat activity, and restrict composite preview builds to code_repo surfaces.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)') is null
		or to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)') is null
		or to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)') is null
		or to_regprocedure('public.qorpera_get_surface_workspace(uuid)') is null
		or to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null then
		raise exception '20260930855000 requires 20260930844000 and 20260930751000';
	end if;
	if position('20260930855000' in pg_get_functiondef(
		'public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)'::regprocedure)) > 0 then
		raise exception '20260930855000 is already applied';
	end if;
end $$;

create temporary table scpl_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields, md5(p.prosrc) as source
from pg_proc as p where p.pronamespace = 'public'::regnamespace;

create function pg_temp.scpl_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
	v_matches integer;
begin
	for v_index in 1 .. coalesce(array_length(p_pairs, 1), 0) by 2 loop
		if p_pairs[v_index] = '' then
			raise exception '20260930855000 empty anchor for %', p_target;
		end if;
		v_matches := (length(v_definition) - length(replace(v_definition, p_pairs[v_index], ''))) / length(p_pairs[v_index]);
		if v_matches <> 1 then
			raise exception '20260930855000 anchor found % time(s) in %, expected 1: %',
				v_matches, p_target, left(p_pairs[v_index], 120);
		end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

select pg_temp.scpl_patch(
	'public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
	array[
$old$	v_result := public.qorpera_surface_complete_session_turn(
		p_session_id, p_state, p_reply_text, p_question, p_note_paths, p_branch_head_sha, p_lease_token
	);
	update public.qorpera_surface_sessions
	set wake_id = null
	where id = p_session_id;
	return v_result;$old$,
$new$	v_result := public.qorpera_surface_complete_session_turn(
		p_session_id, p_state, p_reply_text, p_question, p_note_paths, p_branch_head_sha, p_lease_token
	);
	-- WHY: 20260930855000 keeps wake_id intact so qorpera_complete_runner_job_v6 still resolves wake authority.
	return v_result;$new$
	]
);

select pg_temp.scpl_patch(
	'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure,
	array[
$old$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session
	);
	if coalesce(p_finish_session, false) then
		update public.qorpera_surface_sessions
		set wake_id = null
		where id = p_session_id;
	end if;
	return v_result;$old$,
$new$	v_result := public.qorpera_record_surface_change(
		p_session_id, p_title, p_summary, p_kind, v_parent_sha, v_head_sha,
		p_depends_on_change_ids, p_affected_paths, p_diff_stats, p_patch_manifest, p_finish_session
	);
	-- WHY: 20260930855000 keeps wake_id intact when finishing inside a run so runner job completion stays authorized.
	return v_result;$new$
	]
);

select pg_temp.scpl_patch(
	'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
	array[
$old$	if v_lane in ('all', 'code_repo') then
		with expired_previews as (
			select p.id
			from public.qorpera_surface_previews p
			where p.status = 'building'
				and p.lease_expires_at is not null
				and p.lease_expires_at <= v_now
				and p.expires_at > v_now
			order by p.lease_expires_at asc
			limit v_cap
			for update skip locked
		)$old$,
$new$	if v_lane in ('all', 'code_repo') then
		with expired_previews as (
			select p.id
			from public.qorpera_surface_previews p
			join public.qorpera_surfaces surf on surf.id = p.surface_id
			where p.status = 'building'
				and surf.source_kind = 'code_repo'
				and p.lease_expires_at is not null
				and p.lease_expires_at <= v_now
				and p.expires_at > v_now
			order by p.lease_expires_at asc
			limit v_cap
			for update of p skip locked
		)$new$,
$old$		with picked as (
			select s.id
			from public.qorpera_surface_sessions s
			where s.state in ('queued', 'reconciling')
				and (s.lease_expires_at is null or s.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(s.profile_id)
			order by s.created_at asc
			limit v_cap
			for update skip locked
		),$old$,
$new$		with picked as (
			select s.id
			from public.qorpera_surface_sessions s
			where s.state in ('queued', 'reconciling')
				and (s.lease_expires_at is null or s.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(s.profile_id)
				and (s.wake_id is null or not exists (
					select 1 from public.qorpera_wake_occurrences wk
					where wk.id = s.wake_id
						and (wk.status = 'materialized'
							or (wk.status = 'queued' and wk.created_at > v_now - interval '30 minutes'))
				))
			order by s.created_at asc
			limit v_cap
			for update skip locked
		),$new$,
$old$	if v_lane in ('all', 'code_repo') then
		with picked as (
			select p.id
			from public.qorpera_surface_previews p
			where p.status = 'composing'
				and p.expires_at > v_now
				and (p.lease_expires_at is null or p.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(p.profile_id)
			order by p.created_at asc
			limit v_cap
			for update skip locked
		),$old$,
$new$	if v_lane in ('all', 'code_repo') then
		-- WHY: 20260930855000 restricts code_repo preview claiming to code_repo surfaces so folder overlays are never built on code-host.
		with picked as (
			select p.id
			from public.qorpera_surface_previews p
			join public.qorpera_surfaces surf on surf.id = p.surface_id
			where p.status = 'composing'
				and surf.source_kind = 'code_repo'
				and p.expires_at > v_now
				and (p.lease_expires_at is null or p.lease_expires_at <= v_now)
				and not public.qorpera_surface_company_paused(p.profile_id)
			order by p.created_at asc
			limit v_cap
			for update of p skip locked
		),$new$
	]
);

select pg_temp.scpl_patch(
	'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
	array[
$old$	if cardinality(v_toggled) > 0 or p_exploration_session_id is not null then
		v_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, p_exploration_session_id);
		if v_site.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host);
		end if;
	end if;$old$,
$new$	-- WHY: 20260930855000 only creates server composite previews for code_repo surfaces; folder overlays render client-side.
	if v_surface.source_kind = 'code_repo' and (cardinality(v_toggled) > 0 or p_exploration_session_id is not null) then
		v_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, p_exploration_session_id);
		if v_site.id is not null and v_preview.status = 'ready' then
			v_primary_host := v_site.slug || '--p' || v_preview.short_host_id || '.qorpera.com';
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host);
		end if;
	end if;$new$,
$old$			v_cmp_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, v_cmp_session.id);
			v_cmp_host := null;
			v_cmp_pass := null;
			if v_site.id is not null and v_cmp_preview.status = 'ready' then
				v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';
				v_cmp_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_cmp_host);
			end if;
			v_compare_frames := v_compare_frames || jsonb_build_array(
				jsonb_build_object(
					'sessionId', v_cmp_session.id,
					'label', v_cmp_session.label,
					'frame', jsonb_build_object(
						'previewId', v_cmp_preview.id,
						'status', v_cmp_preview.status,$old$,
$new$			v_cmp_preview := null;
			v_cmp_host := null;
			v_cmp_pass := null;
			if v_surface.source_kind = 'code_repo' then
				v_cmp_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, v_cmp_session.id);
				if v_site.id is not null and v_cmp_preview.status = 'ready' then
					v_cmp_host := v_site.slug || '--p' || v_cmp_preview.short_host_id || '.qorpera.com';
					v_cmp_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_cmp_host);
				end if;
			end if;
			v_compare_frames := v_compare_frames || jsonb_build_array(
				jsonb_build_object(
					'sessionId', v_cmp_session.id,
					'label', v_cmp_session.label,
					'frame', jsonb_build_object(
						'previewId', v_cmp_preview.id,
						'status', coalesce(v_cmp_preview.status, 'live_baseline'),$new$
	]
);

select pg_temp.scpl_patch(
	'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
	array[
$old$	if cardinality(v_toggled) > 0 or v_member_state.active_exploration_session_id is not null then
		select p.* into v_preview$old$,
$new$	-- WHY: 20260930855000 only reads composite preview rows for code_repo surfaces.
	if v_surface.source_kind = 'code_repo' and (cardinality(v_toggled) > 0 or v_member_state.active_exploration_session_id is not null) then
		select p.* into v_preview$new$
	]
);

select pg_temp.scpl_patch(
	'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	array[
$old$					where newer.profile_id = run.profile_id and newer.environment_id = run.environment_id
						and newer.staff_agent_id = run.staff_agent_id and newer.id <> run.id
						and newer.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
				) as superseded$old$,
$new$					where newer.profile_id = run.profile_id and newer.environment_id = run.environment_id
						and newer.staff_agent_id = run.staff_agent_id and newer.id <> run.id
						and newer.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
						and not (newer.source_kind = 'wake' and exists (
							select 1 from public.qorpera_wake_occurrences as newer_occ
							where newer_occ.id = newer.source_id and newer_occ.source_kind = 'surface-session'
						))
				) as superseded$new$,
$old$			where run.environment_id = p_environment_id and (
				job.status in ('queued', 'leased')$old$,
$new$			where run.environment_id = p_environment_id and (
				-- WHY: 20260930855000 keeps surface-session runs on their surface card rather than Co-Founder chat activity.
				(job.status in ('queued', 'leased') and not (run.source_kind = 'wake' and exists (
					select 1 from public.qorpera_wake_occurrences as occurrence
					where occurrence.id = run.source_id and occurrence.source_kind = 'surface-session'
				)))$new$,
$old$							and not (exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)$old$,
$new$							and not ((exists (select 1 from public.qorpera_coding_session_turns as coding
									where coding.occurrence_id = occurrence.id)
								or occurrence.source_kind = 'surface-session')$new$
	]
);

delete from public.qorpera_surface_previews p
using public.qorpera_surfaces s
where s.id = p.surface_id and s.source_kind <> 'code_repo';

do $guard$
declare
	v_complete text := pg_get_functiondef('public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)'::regprocedure);
	v_record text := pg_get_functiondef('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure);
	v_claim text := pg_get_functiondef('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure);
	v_select text := pg_get_functiondef('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure);
	v_ws text := pg_get_functiondef('public.qorpera_get_surface_workspace(uuid)'::regprocedure);
	v_activity text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
begin
	if strpos(v_complete, '20260930855000') = 0 or strpos(v_complete, 'set wake_id = null') > 0 then
		raise exception '20260930855000 guard failed for qorpera_native_surface_complete_turn';
	end if;
	if strpos(v_record, '20260930855000') = 0 or strpos(v_record, 'set wake_id = null') > 0 then
		raise exception '20260930855000 guard failed for qorpera_native_surface_record_change';
	end if;
	if strpos(v_claim, '20260930855000') = 0 or strpos(v_claim, 'wk.status = ''materialized''') = 0 then
		raise exception '20260930855000 guard failed for qorpera_surface_claim_pending_jobs_for_lane';
	end if;
	if strpos(v_select, '20260930855000') = 0 then
		raise exception '20260930855000 guard failed for qorpera_set_preview_selection';
	end if;
	if strpos(v_ws, '20260930855000') = 0 then
		raise exception '20260930855000 guard failed for qorpera_get_surface_workspace';
	end if;
	if strpos(v_activity, '20260930855000') = 0
		or strpos(v_activity, '20260930751000') = 0
		or strpos(v_activity, '20260930542000') = 0
		or strpos(v_activity, 'when job.cancelled_by_user_id is not null then 0') = 0 then
		raise exception '20260930855000 guard failed for qorpera_list_staff_execution_activity';
	end if;
end $guard$;

do $$
declare
	v_expected constant regprocedure[] := array[
		'public.qorpera_native_surface_complete_turn(uuid,uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
		'public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid)'::regprocedure,
		'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
		'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
		'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure
	];
begin
	if (select count(*) from pg_temp.scpl_before as prior join pg_proc as patched on patched.oid = prior.oid
			where md5(patched.prosrc) is distinct from prior.source) <> cardinality(v_expected)
		or exists (select 1 from pg_temp.scpl_before as prior left join pg_proc as patched on patched.oid = prior.oid
			where patched.oid is null or to_jsonb(patched) - 'prosrc' is distinct from prior.fields
				or (md5(patched.prosrc) is distinct from prior.source and not (prior.oid = any(v_expected))))
		or exists (select 1 from pg_proc as p where p.pronamespace = 'public'::regnamespace
			and p.oid not in (select prior.oid from pg_temp.scpl_before as prior)) then
		raise exception '20260930855000: catalog changed unexpectedly';
	end if;
end $$;

drop function pg_temp.scpl_patch(regprocedure, text[]);
drop table pg_temp.scpl_before;
