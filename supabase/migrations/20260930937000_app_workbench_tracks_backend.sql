set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_session_artifacts') is not null then
		raise exception 'App workbench tracks backend (20260930937000) is already applied';
	end if;
	if to_regprocedure('public.qorpera_surface_session_json(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_get_surface_workspace(uuid)') is null
		or to_regprocedure('public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)') is null
		or to_regprocedure('public.qorpera_surface_summary_json(public.qorpera_surfaces)') is null
		or to_regprocedure('public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)') is null
		or to_regprocedure('public.qorpera_discard_surface_session(uuid)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_session_run(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)') is null
		or to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_surface_upsert_preview(public.qorpera_surfaces,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_mint_preview_pass(uuid,uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_surface_preview_slot_host(text,integer)') is null
		or to_regprocedure('public.qorpera_lock_coding_workers(uuid[])') is null
		or to_regprocedure('public.qorpera_terminalize_runner_attempt(uuid,text,text,boolean)') is null
		or to_regprocedure('public.qorpera_surface_needs_standalone_reconciliation(public.qorpera_surfaces,uuid[])') is null
		or to_regprocedure('public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_surface_fail_reconciliation(uuid,text,uuid)') is null
		or to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid,text)') is null
		or to_regprocedure('public.qorpera_publish_surface(uuid)') is null
		or to_regprocedure('public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)') is null then
		raise exception 'App workbench tracks backend (20260930937000) requires prior surface and coding migrations';
	end if;
end $$;

create temporary table awtb_before as
select p.oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc as p
where p.pronamespace = 'public'::regnamespace
	and p.oid in (
		'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
		'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
		'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
		'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
		'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
		'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
		'public.qorpera_surface_fail_reconciliation(uuid,text,uuid)'::regprocedure,
		'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
		'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid,text)'::regprocedure,
		'public.qorpera_discard_surface_session(uuid)'::regprocedure,
		'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
		'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
		'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure
	);

create function pg_temp.awtb_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	if coalesce(cardinality(p_edits), 0) = 0 or cardinality(p_edits) % 2 <> 0 then
		raise exception '20260930937000 invalid edits for %', p_target;
	end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930937000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 120);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

create table public.qorpera_surface_session_artifacts (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	session_id uuid not null references public.qorpera_surface_sessions(id) on delete cascade,
	kind text not null check (kind in ('mockup', 'plan', 'report', 'diff_summary', 'checklist')),
	artifact_key text not null check (artifact_key ~ '^[a-z0-9][a-z0-9._:-]{0,79}$'),
	title text not null check (char_length(title) between 1 and 160),
	summary text check (summary is null or char_length(summary) <= 2000),
	content_format text not null check (content_format in ('markdown', 'html', 'json', 'image_ref')),
	content_text text check (content_text is null or octet_length(content_text) <= 262144),
	image_ref jsonb check (image_ref is null or (jsonb_typeof(image_ref) = 'object' and pg_column_size(image_ref) <= 2048)),
	change_id uuid references public.qorpera_surface_changes(id) on delete set null,
	revision integer not null default 1 check (revision >= 1),
	created_by_kind text not null check (created_by_kind in ('agent', 'member', 'system')),
	created_by_user_id uuid references auth.users(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (session_id, artifact_key)
);

create index qorpera_surface_session_artifacts_session_idx
	on public.qorpera_surface_session_artifacts(session_id, updated_at desc, id asc);
create index qorpera_surface_session_artifacts_surface_idx
	on public.qorpera_surface_session_artifacts(surface_id, updated_at desc);

alter table public.qorpera_surface_session_artifacts enable row level security;
revoke all on public.qorpera_surface_session_artifacts
	from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_surface_sessions
	add column track_branch text check (
		track_branch is null or (
			octet_length(track_branch) between 1 and 200
			and track_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
			and position('..' in track_branch) = 0
		)
	),
	add column checks_summary jsonb check (
		checks_summary is null or (jsonb_typeof(checks_summary) = 'object' and pg_column_size(checks_summary) <= 8192)
	),
	add column progress_steps jsonb not null default '[]'::jsonb check (
		jsonb_typeof(progress_steps) = 'array' and pg_column_size(progress_steps) <= 8192
	),
	add column current_activity text check (current_activity is null or char_length(current_activity) <= 240),
	add column external_pr jsonb check (
		external_pr is null or (jsonb_typeof(external_pr) = 'object' and pg_column_size(external_pr) <= 4096)
	);

alter table public.qorpera_member_surface_state
	add column selected_session_id uuid references public.qorpera_surface_sessions(id) on delete set null,
	add column preview_scope text not null default 'combined' check (preview_scope in ('combined', 'track', 'explicit'));

alter table public.qorpera_surface_reconciliations
	add column auto_publish_after boolean not null default false;

select pg_temp.awtb_patch(
	'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure,
	array[
$old$		'supersedeKey', p_session.supersede_key,$old$,
$new$		'supersedeKey', p_session.supersede_key,
		'trackBranch', p_session.track_branch,
		'checksSummary', p_session.checks_summary,
		'progressSteps', coalesce(p_session.progress_steps, '[]'::jsonb),
		'currentActivity', p_session.current_activity,
		'externalPr', p_session.external_pr,
		'artifacts', coalesce(artifacts_agg.items, '[]'::jsonb),$new$,
$old$		from public.qorpera_surface_session_messages m
		where m.session_id = p_session.id
	) messages_agg on true$old$,
$new$		from public.qorpera_surface_session_messages m
		where m.session_id = p_session.id
	) messages_agg on true
	left join lateral (
		select jsonb_agg(
			jsonb_build_object(
				'id', a.id,
				'sessionId', a.session_id,
				'surfaceId', a.surface_id,
				'kind', a.kind,
				'artifactKey', a.artifact_key,
				'title', a.title,
				'summary', a.summary,
				'contentFormat', a.content_format,
				'contentText', null,
				'imageRef', a.image_ref,
				'changeId', a.change_id,
				'revision', a.revision,
				'createdByKind', a.created_by_kind,
				'createdByUserId', a.created_by_user_id,
				'createdAt', a.created_at,
				'updatedAt', a.updated_at
			)
			order by a.updated_at desc, a.id asc
		) as items
		from public.qorpera_surface_session_artifacts a
		where a.session_id = p_session.id
	) artifacts_agg on true$new$
	]
);

create function public.qorpera_get_surface_session_artifact(p_artifact_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_artifact public.qorpera_surface_session_artifacts%rowtype;
begin
	select * into v_artifact from public.qorpera_surface_session_artifacts where id = p_artifact_id;
	if v_artifact.id is null then
		raise exception 'Surface session artifact not found' using errcode = 'P0002';
	end if;
	perform public.qorpera_assert_surface_member(v_artifact.profile_id, false);
	perform public.qorpera_assert_surfaces_enabled();

	return jsonb_build_object(
		'id', v_artifact.id,
		'sessionId', v_artifact.session_id,
		'surfaceId', v_artifact.surface_id,
		'kind', v_artifact.kind,
		'artifactKey', v_artifact.artifact_key,
		'title', v_artifact.title,
		'summary', v_artifact.summary,
		'contentFormat', v_artifact.content_format,
		'contentText', v_artifact.content_text,
		'imageRef', v_artifact.image_ref,
		'changeId', v_artifact.change_id,
		'revision', v_artifact.revision,
		'createdByKind', v_artifact.created_by_kind,
		'createdByUserId', v_artifact.created_by_user_id,
		'createdAt', v_artifact.created_at,
		'updatedAt', v_artifact.updated_at
	);
end $$;
revoke all on function public.qorpera_get_surface_session_artifact(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_get_surface_session_artifact(uuid)
	to authenticated;

select pg_temp.awtb_patch(
	'public.qorpera_get_surface_workspace(uuid)'::regprocedure,
	array[
$old$		'previewState', jsonb_build_object(
			'surfaceId', p_surface_id,
			'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,$old$,
$new$		'previewState', jsonb_build_object(
			'surfaceId', p_surface_id,
			'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
			'selectedSessionId', v_member_state.selected_session_id,
			'previewScope', coalesce(v_member_state.preview_scope, 'combined'),$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_set_preview_selection(uuid,uuid[],uuid,uuid[],text)'::regprocedure,
	array[
$old$	insert into public.qorpera_member_surface_state(
		user_id, surface_id, active_exploration_session_id, toggled_change_ids, compare_session_ids, active_route, updated_at
	)
	values (v_user_id, p_surface_id, p_exploration_session_id, v_toggled, v_compare, v_route, clock_timestamp())
	on conflict (user_id, surface_id) do update set
		active_exploration_session_id = excluded.active_exploration_session_id,
		toggled_change_ids = excluded.toggled_change_ids,
		compare_session_ids = excluded.compare_session_ids,
		active_route = excluded.active_route,
		updated_at = clock_timestamp();$old$,
$new$	insert into public.qorpera_member_surface_state(
		user_id, surface_id, active_exploration_session_id, toggled_change_ids, compare_session_ids, active_route,
		selected_session_id, preview_scope, updated_at
	)
	values (v_user_id, p_surface_id, p_exploration_session_id, v_toggled, v_compare, v_route, null, 'combined', clock_timestamp())
	on conflict (user_id, surface_id) do update set
		active_exploration_session_id = excluded.active_exploration_session_id,
		toggled_change_ids = excluded.toggled_change_ids,
		compare_session_ids = excluded.compare_session_ids,
		active_route = excluded.active_route,
		selected_session_id = null,
		preview_scope = 'combined',
		updated_at = clock_timestamp();$new$,
$old$	return jsonb_build_object(
		'surfaceId', p_surface_id,
		'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,$old$,
$new$	return jsonb_build_object(
		'surfaceId', p_surface_id,
		'mode', case when cardinality(v_compare) >= 2 then 'compare' else 'single' end,
		'selectedSessionId', null,
		'previewScope', 'combined',$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_summary_json(public.qorpera_surfaces)'::regprocedure,
	array[
$old$		'needsAttentionCount', 0 /* WHY: 20260930922000 keeps agent blockers off the rail; teammate publish asks are layered by the client */,$old$,
$new$		'needsAttentionCount', case when p_surface.surface_kind in ('web_app', 'mobile_app', 'desktop_app') then coalesce(stats.attention_sessions, 0) else 0 end /* WHY: 20260930937000 restores real attention counts for app workbench surfaces while keeping other surfaces pull-only */,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_complete_merge(uuid,text,text,text,uuid,text[],text,jsonb,uuid)'::regprocedure,
	array[
$old$	v_repo public.qorpera_code_repositories%rowtype;
	v_queued_publish_id uuid;
begin$old$,
$new$	v_repo public.qorpera_code_repositories%rowtype;
	v_queued_publish_id uuid;
	v_eval_sid uuid;
begin$new$,
$old$	if v_job.session_id is not null then
		perform 1 from public.qorpera_surface_sessions where id = v_job.session_id for update;
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_job.surface_id for update;$old$,
$new$	perform 1
	from public.qorpera_surface_sessions s
	where s.id in (
		select v_job.session_id where v_job.session_id is not null
		union
		select x::uuid
		from jsonb_array_elements_text(
			case when jsonb_typeof(v_job.payload -> 'combinedSessionIds') = 'array' then v_job.payload -> 'combinedSessionIds' else '[]'::jsonb end
		) as x
		union
		select ch.session_id
		from public.qorpera_surface_changes ch
		where ch.id in (
			select y::uuid
			from jsonb_array_elements_text(
				case when jsonb_typeof(v_job.payload -> 'changeIds') = 'array' then v_job.payload -> 'changeIds' else '[]'::jsonb end
			) as y
		)
	)
	order by s.id asc
	for update;
	select * into v_surface from public.qorpera_surfaces where id = v_job.surface_id for update;$new$,
$old$		end if;

		if v_job.session_id is not null then
			perform public.qorpera_evaluate_surface_session_lifecycle(v_job.session_id);
		end if;
	elsif v_job.kind = 'undo_change' then$old$,
$new$		end if;

		for v_eval_sid in
			select distinct affected.sid
			from (
				select v_job.session_id as sid where v_job.session_id is not null
				union
				select x::uuid as sid
				from jsonb_array_elements_text(
					case when jsonb_typeof(v_job.payload -> 'combinedSessionIds') = 'array' then v_job.payload -> 'combinedSessionIds' else '[]'::jsonb end
				) as x
				union
				select ch.session_id as sid
				from public.qorpera_surface_changes ch
				where ch.id = any(v_change_ids)
			) affected
			order by affected.sid asc
		loop
			perform public.qorpera_evaluate_surface_session_lifecycle(v_eval_sid);
		end loop;
	elsif v_job.kind = 'undo_change' then$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_fail_reconciliation(uuid,text,uuid)'::regprocedure,
	array[
$old$		auto_approve_after = false,
		updated_at = v_now$old$,
$new$		auto_approve_after = false,
		auto_publish_after = false,
		updated_at = v_now$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_enqueue_silent_reconciliation(uuid,uuid[],text[],uuid,boolean,boolean)'::regprocedure,
	array[
$old$	v_auto_approve boolean := coalesce(p_auto_approve_after, false);
	v_now timestamptz := clock_timestamp();$old$,
$new$	v_auto_approve boolean := coalesce(p_auto_approve_after, false);
	v_auto_publish boolean := false;
	v_now timestamptz := clock_timestamp();$new$,
$old$		select r.id as rec_id, r.session_id, r.status as rec_status, r.auto_approve_after as rec_auto_approve
		from public.qorpera_surface_reconciliations r$old$,
$new$		select r.id as rec_id, r.session_id, r.status as rec_status, r.auto_approve_after as rec_auto_approve,
			r.auto_publish_after as rec_auto_publish
		from public.qorpera_surface_reconciliations r$new$,
$old$		v_auto_approve := v_auto_approve or coalesce(v_sup.rec_auto_approve, false);$old$,
$new$		v_auto_approve := v_auto_approve or coalesce(v_sup.rec_auto_approve, false);
		v_auto_publish := v_auto_publish or coalesce(v_sup.rec_auto_publish, false);$new$,
$old$				error_detail = 'Superseded by updated change revision',
				auto_approve_after = false,$old$,
$new$				error_detail = 'Superseded by updated change revision',
				auto_approve_after = false,
				auto_publish_after = false,$new$,
$old$			auto_approve_after = v_auto_approve,$old$,
$new$			auto_approve_after = v_auto_approve,
			auto_publish_after = v_auto_publish,$new$,
$old$			selected_change_ids, status, conflict_paths, auto_approve_after,
			created_by_user_id, updated_at, expires_at
		)
		values (
			v_surface.profile_id, p_surface_id, v_comp_key, v_base_fp,
			v_ordered_ids, 'queued', v_paths, v_auto_approve,$old$,
$new$			selected_change_ids, status, conflict_paths, auto_approve_after, auto_publish_after,
			created_by_user_id, updated_at, expires_at
		)
		values (
			v_surface.profile_id, p_surface_id, v_comp_key, v_base_fp,
			v_ordered_ids, 'queued', v_paths, v_auto_approve, v_auto_publish,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid,text)'::regprocedure,
	array[
$old$				update public.qorpera_surface_reconciliations
				set auto_approve_after = false, updated_at = v_now
				where id = v_rec.id;$old$,
$new$				update public.qorpera_surface_reconciliations
				set auto_approve_after = false, auto_publish_after = false, updated_at = v_now
				where id = v_rec.id;$new$,
$old$							'reconciliationId', v_rec.id,
							'autoPublish', v_surface.auto_publish$old$,
$new$							'reconciliationId', v_rec.id,
							'autoPublish', (v_surface.auto_publish or coalesce(v_rec.auto_publish_after, false))$new$,
$old$							'changeIds', to_jsonb(v_rec.selected_change_ids),
							'autoPublish', v_surface.auto_publish$old$,
$new$							'changeIds', to_jsonb(v_rec.selected_change_ids),
							'autoPublish', (v_surface.auto_publish or coalesce(v_rec.auto_publish_after, false))$new$,
$old$							if v_retry_rec.id is not null and v_retry_rec.status in ('queued', 'running') then
								v_retry_enqueued := true;$old$,
$new$							if v_retry_rec.id is not null and v_retry_rec.status in ('queued', 'running') then
								if coalesce(v_rec.auto_publish_after, false) then
									update public.qorpera_surface_reconciliations
									set auto_publish_after = true, updated_at = v_now
									where id = v_retry_rec.id;
								end if;
								v_retry_enqueued := true;$new$,
$old$										'reconciliationId', v_retry_rec.id,
										'autoPublish', v_surface.auto_publish$old$,
$new$										'reconciliationId', v_retry_rec.id,
										'autoPublish', (v_surface.auto_publish or coalesce(v_rec.auto_publish_after, false))$new$,
$old$				error_detail = case when status in ('queued', 'running') then 'Change updated' else error_detail end,
				auto_approve_after = false,$old$,
$new$				error_detail = case when status in ('queued', 'running') then 'Change updated' else error_detail end,
				auto_approve_after = false,
				auto_publish_after = false,$new$,
$old$					error_detail = case when status in ('queued', 'running') then 'Change superseded' else error_detail end,
					auto_approve_after = false,$old$,
$new$					error_detail = case when status in ('queued', 'running') then 'Change superseded' else error_detail end,
					auto_approve_after = false,
					auto_publish_after = false,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_complete_session_turn(uuid,text,text,jsonb,text[],text,uuid)'::regprocedure,
	array[
$old$		lease_expires_at = null,
		lease_token = null,$old$,
$new$		lease_expires_at = null,
		lease_token = null,
		current_activity = null,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_discard_surface_session(uuid)'::regprocedure,
	array[
$old$		active_exploration_session_id = nullif(active_exploration_session_id, p_session_id),
		compare_session_ids = array_remove(compare_session_ids, p_session_id)$old$,
$new$		active_exploration_session_id = nullif(active_exploration_session_id, p_session_id),
		selected_session_id = nullif(selected_session_id, p_session_id),
		compare_session_ids = array_remove(compare_session_ids, p_session_id)$new$,
$old$		lease_token = null,
		lease_expires_at = null,
		wake_id = null,$old$,
$new$		lease_token = null,
		lease_expires_at = null,
		wake_id = null,
		current_activity = null,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$		update public.qorpera_surface_sessions
		set
			worker_id = v_worker.id,
			wake_id = null,$old$,
$new$		update public.qorpera_surface_sessions
		set
			worker_id = v_worker.id,
			track_branch = coalesce(track_branch, v_coding_session.branch),
			wake_id = null,$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	array[
$old$	elsif jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 9 else 7 end)
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture','company_search')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))
		) then$old$,
$new$	elsif jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 11 else 7 end)
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture','company_search')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment', 'coding_publish_artifact', 'coding_report_progress'))
		) then$new$
	]
);

select pg_temp.awtb_patch(
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	array[
$old$'steer_surface_session',$old$,
$new$'steer_surface_session','coding_publish_artifact','coding_report_progress',$new$
	]
);

create function public.qorpera_select_surface_track_preview(
	p_surface_id uuid,
	p_session_id uuid default null,
	p_combine_session_ids uuid[] default null,
	p_active_route text default '/'
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_site public.qorpera_company_sites%rowtype;
	v_user_id uuid;
	v_combine_ids uuid[] := '{}'::uuid[];
	v_selected_session_id uuid := null;
	v_preview_scope text := 'track';
	v_toggled uuid[] := '{}'::uuid[];
	v_route text := coalesce(nullif(btrim(coalesce(p_active_route, '')), ''), '/');
	v_preview public.qorpera_surface_previews%rowtype;
	v_primary_host text;
	v_primary_pass text;
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, false);
	perform public.qorpera_assert_surfaces_enabled();

	if coalesce(cardinality(p_combine_session_ids), 0) > 0 then
		if p_session_id is not null then
			raise exception 'Pass either sessionId or combineSessionIds, not both' using errcode = '22023';
		end if;
		select coalesce(array_agg(dedup.sid order by dedup.first_ord), '{}'::uuid[])
		into v_combine_ids
		from (
			select u.sid, min(u.ord) as first_ord
			from unnest(p_combine_session_ids) with ordinality as u(sid, ord)
			where u.sid is not null
			group by u.sid
		) dedup;
		if cardinality(v_combine_ids) not between 2 and 8 then
			raise exception 'Combine track preview requires between 2 and 8 distinct tracks' using errcode = '22023';
		end if;
		if exists (
			select 1 from unnest(v_combine_ids) as sid
			where not exists (
				select 1 from public.qorpera_surface_sessions s
				where s.id = sid
					and s.surface_id = p_surface_id
					and s.profile_id = v_surface.profile_id
					and s.state <> 'discarded'
			)
		) then
			raise exception 'Track session does not belong to surface' using errcode = '42501';
		end if;
		v_preview_scope := 'explicit';
		v_selected_session_id := null;
		select coalesce(array_agg(picked.id order by picked.created_at asc, picked.seq asc, picked.id asc), '{}'::uuid[])
		into v_toggled
		from (
			select ch.id, ch.created_at, ch.seq,
				row_number() over (
					partition by ch.session_id, coalesce(ch.option_group_key, ch.id::text)
					order by ch.seq asc, ch.id asc
				) as option_rank
			from public.qorpera_surface_changes ch
			where ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.session_id = any(v_combine_ids)
				and ch.status in ('staged', 'conflicted')
		) picked
		where picked.option_rank = 1;
	elsif p_session_id is not null then
		if not exists (
			select 1 from public.qorpera_surface_sessions s
			where s.id = p_session_id
				and s.surface_id = p_surface_id
				and s.profile_id = v_surface.profile_id
		) then
			raise exception 'Track session does not belong to surface' using errcode = '42501';
		end if;
		v_preview_scope := 'track';
		v_selected_session_id := p_session_id;
		select coalesce(array_agg(picked.id order by picked.created_at asc, picked.seq asc, picked.id asc), '{}'::uuid[])
		into v_toggled
		from (
			select ch.id, ch.created_at, ch.seq,
				row_number() over (
					partition by coalesce(ch.option_group_key, ch.id::text)
					order by ch.seq asc, ch.id asc
				) as option_rank
			from public.qorpera_surface_changes ch
			where ch.surface_id = p_surface_id
				and ch.profile_id = v_surface.profile_id
				and ch.session_id = p_session_id
				and ch.status in ('staged', 'conflicted')
		) picked
		where picked.option_rank = 1;
	else
		v_preview_scope := 'track';
		v_selected_session_id := null;
		v_toggled := '{}'::uuid[];
	end if;

	insert into public.qorpera_member_surface_state(
		user_id, surface_id, active_exploration_session_id, toggled_change_ids, compare_session_ids, active_route,
		selected_session_id, preview_scope, updated_at
	)
	values (
		v_user_id, p_surface_id, null, v_toggled, '{}'::uuid[], v_route,
		v_selected_session_id, v_preview_scope, clock_timestamp()
	)
	on conflict (user_id, surface_id) do update set
		active_exploration_session_id = null,
		toggled_change_ids = excluded.toggled_change_ids,
		compare_session_ids = '{}'::uuid[],
		active_route = excluded.active_route,
		selected_session_id = excluded.selected_session_id,
		preview_scope = excluded.preview_scope,
		updated_at = clock_timestamp();

	if v_surface.site_id is not null then
		select * into v_site from public.qorpera_company_sites where id = v_surface.site_id;
	end if;

	if v_surface.source_kind = 'code_repo' and cardinality(v_toggled) > 0 then
		v_preview := public.qorpera_surface_upsert_preview(v_surface, v_surface.live_head_sha, v_toggled, null);
		if v_site.id is not null and v_preview.status = 'ready' then
			v_primary_host := public.qorpera_surface_preview_slot_host(v_site.slug, 0);
			v_primary_pass := public.qorpera_surface_mint_preview_pass(v_site.id, v_user_id, v_primary_host, v_preview.site_version_id);
		end if;
	end if;

	return jsonb_build_object(
		'surfaceId', p_surface_id,
		'mode', 'single',
		'selectedSessionId', v_selected_session_id,
		'previewScope', v_preview_scope,
		'primary', jsonb_build_object(
			'previewId', v_preview.id,
			'status', case when v_preview.id is not null then v_preview.status else 'live_baseline' end,
			'doorActionUrl', case when v_primary_host is not null then 'https://' || v_primary_host || '/__qorpera/member' else null end,
			'memberPass', v_primary_pass,
			'activeRoute', v_route,
			'toggledChangeIds', to_jsonb(v_toggled),
			'conflictReport', v_preview.conflict_report,
			'errorDetail', v_preview.error_detail
		),
		'compareFrames', '[]'::jsonb
	);
end $$;
revoke all on function public.qorpera_select_surface_track_preview(uuid, uuid, uuid[], text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_select_surface_track_preview(uuid, uuid, uuid[], text)
	to authenticated;

create function public.qorpera_ship_surface_track(
	p_session_id uuid,
	p_publish boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_change_ids uuid[];
	v_needs_worker boolean := false;
	v_auto_publish boolean := false;
	v_merged_count integer;
	v_last_sha text;
	v_deferred_for_reconcile boolean := false;
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_session.profile_id, true);

	if v_session.state in ('queued', 'running', 'reconciling', 'reconciling_running') then
		raise exception 'Stop or wait for the current turn before shipping this track' using errcode = '55000';
	end if;
	if v_session.state = 'discarded' then
		raise exception 'Cannot ship a discarded track' using errcode = '55000';
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id for update;
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;
	perform 1 from public.qorpera_surface_changes where session_id = p_session_id order by seq asc, id asc for update;

	if exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.session_id = p_session_id
			and ch.status in ('staged', 'conflicted')
			and ch.option_group_key is not null
		group by ch.option_group_key
		having count(*) > 1
	) then
		raise exception 'Choose one option in each option group before shipping this track' using errcode = '55000';
	end if;

	select
		coalesce(array_agg(ch.id order by ch.seq asc, ch.id asc), '{}'::uuid[]),
		bool_or(
			(ch.kind = 'git_range' and v_surface.repository_key is not null and ch.head_sha is not null)
			or (ch.kind in ('folder_patch', 'ops_action') and ch.patch_manifest is not null)
		)
	into v_change_ids, v_needs_worker
	from public.qorpera_surface_changes ch
	where ch.session_id = p_session_id and ch.status in ('staged', 'conflicted');

	v_auto_publish := coalesce(p_publish, false) or v_surface.auto_publish;

	if cardinality(v_change_ids) = 0 and not coalesce(p_publish, false) then
		raise exception 'Track has no open changes to ship' using errcode = '55000';
	end if;

	if cardinality(v_change_ids) > 0 and exists (
		select 1 from public.qorpera_surface_jobs j
		where j.surface_id = v_session.surface_id
			and j.kind in ('land_change', 'undo_change')
			and j.status in ('queued', 'running')
			and (
				(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_change_ids))
				or exists (
					select 1
					from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
					where x::uuid = any(v_change_ids)
				)
			)
	) then
		raise exception 'A merge or rollback job is already active for this track' using errcode = '55000';
	end if;

	if cardinality(v_change_ids) > 0 and coalesce(v_needs_worker, false) then
		if public.qorpera_surface_needs_standalone_reconciliation(v_surface, v_change_ids) then
			v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
				v_session.surface_id, v_change_ids, '{}'::text[], v_user_id, true, false
			);
			if v_rec.id is not null and v_rec.status = 'failed' then
				v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
					v_session.surface_id, v_change_ids, '{}'::text[], v_user_id, true, true
				);
			end if;
			if v_rec.id is not null and v_rec.status in ('queued', 'running') then
				v_deferred_for_reconcile := true;
				if v_auto_publish then
					update public.qorpera_surface_reconciliations
					set auto_publish_after = true, updated_at = v_now
					where id = v_rec.id;
				end if;
			end if;
		end if;
		if not v_deferred_for_reconcile then
			update public.qorpera_surface_changes
			set status = 'merging', conflict_paths = null, approved_by_user_id = v_user_id
			where id = any(v_change_ids);

			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, session_id, kind, payload, requested_by_user_id
			)
			values (
				v_session.profile_id, v_session.surface_id, p_session_id, 'land_change',
				jsonb_build_object(
					'changeIds', to_jsonb(v_change_ids),
					'autoPublish', v_auto_publish,
					'trackSessionId', p_session_id
				),
				v_user_id
			);
		end if;
	elsif cardinality(v_change_ids) > 0 then
		select head_sha into v_last_sha
		from public.qorpera_surface_changes
		where id = any(v_change_ids)
		order by seq desc, id desc
		limit 1;

		update public.qorpera_surface_changes
		set
			status = 'merged',
			conflict_paths = null,
			approved_by_user_id = v_user_id,
			published_at = case when v_auto_publish then v_now else null end,
			published_by_user_id = case when v_auto_publish then v_user_id else null end,
			resolved_at = v_now
		where id = any(v_change_ids);
		get diagnostics v_merged_count = row_count;

		update public.qorpera_surfaces
		set
			live_head_sha = coalesce(v_last_sha, live_head_sha),
			published_head_sha = case when v_auto_publish then coalesce(v_last_sha, published_head_sha) else published_head_sha end,
			unpublished_change_count = case when v_auto_publish then 0 else unpublished_change_count + v_merged_count end,
			updated_at = v_now
		where id = v_session.surface_id;
	elsif coalesce(p_publish, false) then
		perform public.qorpera_publish_surface(v_surface.id);
	end if;

	if cardinality(v_change_ids) > 0 and not v_deferred_for_reconcile then
		update public.qorpera_member_surface_state
		set
			toggled_change_ids = coalesce(
				(select array_agg(t.id order by t.ord)
				 from unnest(toggled_change_ids) with ordinality as t(id, ord)
				 where t.id <> all(v_change_ids)),
				'{}'::uuid[]
			),
			selected_session_id = nullif(selected_session_id, p_session_id),
			preview_scope = case when selected_session_id = p_session_id then 'combined' else preview_scope end
		where surface_id = v_session.surface_id;
	elsif v_deferred_for_reconcile then
		update public.qorpera_member_surface_state
		set
			selected_session_id = null,
			preview_scope = 'combined'
		where surface_id = v_session.surface_id
			and selected_session_id = p_session_id;
	end if;

	update public.qorpera_surface_sessions
	set has_active_chat = false, updated_at = v_now
	where id = p_session_id;

	v_session := public.qorpera_evaluate_surface_session_lifecycle(p_session_id);
	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_ship_surface_track(uuid, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_ship_surface_track(uuid, boolean)
	to authenticated;

create function public.qorpera_combine_surface_tracks(
	p_surface_id uuid,
	p_session_ids uuid[],
	p_land boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_surface public.qorpera_surfaces%rowtype;
	v_user_id uuid;
	v_session_ids uuid[] := '{}'::uuid[];
	v_change_ids uuid[] := '{}'::uuid[];
	v_needs_worker boolean := false;
	v_preview_state jsonb;
	v_job_id uuid := null;
	v_merged_count integer := 0;
	v_last_sha text;
	v_sid uuid;
	v_deferred_for_reconcile boolean := false;
	v_rec public.qorpera_surface_reconciliations%rowtype;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id;
	if v_surface.id is null then
		raise exception 'Surface not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_surface.profile_id, coalesce(p_land, false));

	select coalesce(array_agg(dedup.sid order by dedup.first_ord), '{}'::uuid[])
	into v_session_ids
	from (
		select u.sid, min(u.ord) as first_ord
		from unnest(coalesce(p_session_ids, '{}'::uuid[])) with ordinality as u(sid, ord)
		where u.sid is not null
		group by u.sid
	) dedup;

	if cardinality(v_session_ids) not between 2 and 8 then
		raise exception 'Combining tracks requires between 2 and 8 distinct tracks' using errcode = '22023';
	end if;

	if not coalesce(p_land, false) then
		v_preview_state := public.qorpera_select_surface_track_preview(p_surface_id, null, v_session_ids, '/');
		return jsonb_build_object(
			'mode', 'preview',
			'sessionIds', to_jsonb(v_session_ids),
			'previewState', v_preview_state
		);
	end if;

	perform 1
	from public.qorpera_surface_sessions s
	where s.id = any(v_session_ids) and s.surface_id = p_surface_id and s.profile_id = v_surface.profile_id
	order by s.id asc
	for update;
	select * into v_surface from public.qorpera_surfaces where id = p_surface_id for update;
	if v_surface.status = 'archived' then
		raise exception 'This interface was deleted' using errcode = '55000';
	end if;

	if (
		select count(*)
		from public.qorpera_surface_sessions s
		where s.id = any(v_session_ids) and s.surface_id = p_surface_id and s.profile_id = v_surface.profile_id
	) <> cardinality(v_session_ids) then
		raise exception 'Track session does not belong to surface' using errcode = '42501';
	end if;

	if exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = any(v_session_ids)
			and s.state in ('queued', 'running', 'reconciling', 'reconciling_running', 'discarded')
	) then
		raise exception 'Every selected track must be idle and active before combining and shipping' using errcode = '55000';
	end if;

	perform 1
	from public.qorpera_surface_changes ch
	where ch.surface_id = p_surface_id and ch.session_id = any(v_session_ids)
	order by ch.created_at asc, ch.seq asc, ch.id asc
	for update;

	if exists (
		select 1
		from public.qorpera_surface_changes ch
		where ch.surface_id = p_surface_id
			and ch.session_id = any(v_session_ids)
			and ch.status in ('staged', 'conflicted')
			and ch.option_group_key is not null
		group by ch.session_id, ch.option_group_key
		having count(*) > 1
	) then
		raise exception 'Choose one option in each option group before combining tracks' using errcode = '55000';
	end if;

	select
		coalesce(array_agg(ch.id order by ch.created_at asc, ch.seq asc, ch.id asc), '{}'::uuid[]),
		bool_or(
			(ch.kind = 'git_range' and v_surface.repository_key is not null and ch.head_sha is not null)
			or (ch.kind in ('folder_patch', 'ops_action') and ch.patch_manifest is not null)
		)
	into v_change_ids, v_needs_worker
	from public.qorpera_surface_changes ch
	where ch.surface_id = p_surface_id
		and ch.session_id = any(v_session_ids)
		and ch.status in ('staged', 'conflicted');

	if cardinality(v_change_ids) = 0 then
		raise exception 'Selected tracks have no open changes to combine' using errcode = '55000';
	end if;

	if exists (
		select 1 from public.qorpera_surface_jobs j
		where j.surface_id = p_surface_id
			and j.kind in ('land_change', 'undo_change')
			and j.status in ('queued', 'running')
			and (
				(j.payload ? 'changeId' and (j.payload ->> 'changeId')::uuid = any(v_change_ids))
				or exists (
					select 1
					from jsonb_array_elements_text(coalesce(j.payload -> 'changeIds', '[]'::jsonb)) as x
					where x::uuid = any(v_change_ids)
				)
			)
	) then
		raise exception 'A merge or rollback job is already active for one of the selected tracks' using errcode = '55000';
	end if;

	if coalesce(v_needs_worker, false) then
		if public.qorpera_surface_needs_standalone_reconciliation(v_surface, v_change_ids) then
			v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
				p_surface_id, v_change_ids, '{}'::text[], v_user_id, true, false
			);
			if v_rec.id is not null and v_rec.status = 'failed' then
				v_rec := public.qorpera_surface_enqueue_silent_reconciliation(
					p_surface_id, v_change_ids, '{}'::text[], v_user_id, true, true
				);
			end if;
			if v_rec.id is not null and v_rec.status in ('queued', 'running') then
				v_deferred_for_reconcile := true;
			end if;
		end if;
		if not v_deferred_for_reconcile then
			update public.qorpera_surface_changes
			set status = 'merging', conflict_paths = null, approved_by_user_id = v_user_id
			where id = any(v_change_ids);

			insert into public.qorpera_surface_jobs(
				profile_id, surface_id, session_id, kind, payload, requested_by_user_id
			)
			values (
				v_surface.profile_id, p_surface_id, v_session_ids[1], 'land_change',
				jsonb_build_object(
					'changeIds', to_jsonb(v_change_ids),
					'autoPublish', v_surface.auto_publish,
					'combinedSessionIds', to_jsonb(v_session_ids)
				),
				v_user_id
			)
			returning id into v_job_id;
		end if;
	else
		select head_sha into v_last_sha
		from public.qorpera_surface_changes
		where id = any(v_change_ids)
		order by created_at desc, seq desc, id desc
		limit 1;

		update public.qorpera_surface_changes
		set
			status = 'merged',
			conflict_paths = null,
			approved_by_user_id = v_user_id,
			published_at = case when v_surface.auto_publish then v_now else null end,
			published_by_user_id = case when v_surface.auto_publish then v_user_id else null end,
			resolved_at = v_now
		where id = any(v_change_ids);
		get diagnostics v_merged_count = row_count;

		update public.qorpera_surfaces
		set
			live_head_sha = coalesce(v_last_sha, live_head_sha),
			published_head_sha = case when v_surface.auto_publish then coalesce(v_last_sha, published_head_sha) else published_head_sha end,
			unpublished_change_count = case when v_surface.auto_publish then 0 else unpublished_change_count + v_merged_count end,
			updated_at = v_now
		where id = p_surface_id;
	end if;

	if not v_deferred_for_reconcile then
		update public.qorpera_member_surface_state
		set
			toggled_change_ids = coalesce(
				(select array_agg(t.id order by t.ord)
				 from unnest(toggled_change_ids) with ordinality as t(id, ord)
				 where t.id <> all(v_change_ids)),
				'{}'::uuid[]
			),
			selected_session_id = case when selected_session_id = any(v_session_ids) then null else selected_session_id end,
			preview_scope = case when selected_session_id = any(v_session_ids) then 'combined' else preview_scope end
		where surface_id = p_surface_id;
	else
		update public.qorpera_member_surface_state
		set
			selected_session_id = null,
			preview_scope = 'combined'
		where surface_id = p_surface_id
			and selected_session_id = any(v_session_ids);
	end if;

	update public.qorpera_surface_sessions
	set has_active_chat = false, updated_at = v_now
	where id = any(v_session_ids);

	foreach v_sid in array v_session_ids loop
		perform public.qorpera_evaluate_surface_session_lifecycle(v_sid);
	end loop;

	return jsonb_build_object(
		'mode', 'land',
		'sessionIds', to_jsonb(v_session_ids),
		'changeIds', to_jsonb(v_change_ids),
		'jobId', v_job_id
	);
end $$;
revoke all on function public.qorpera_combine_surface_tracks(uuid, uuid[], boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_combine_surface_tracks(uuid, uuid[], boolean)
	to authenticated;

create function public.qorpera_cancel_surface_session_turn(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding public.qorpera_coding_sessions%rowtype;
	v_user_id uuid;
	v_wake_ids uuid[] := '{}'::uuid[];
	v_job_id uuid;
	v_now timestamptz := clock_timestamp();
begin
	select * into v_peek from public.qorpera_surface_sessions where id = p_session_id;
	if v_peek.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	v_user_id := public.qorpera_assert_surface_member(v_peek.profile_id, true);

	-- WHY: Lock coding worker and coding session before surface session to match qorpera_surface_enqueue_session_run's lock order.
	if v_peek.worker_id is not null then
		perform public.qorpera_lock_coding_workers(array[v_peek.worker_id]);
		select * into v_coding
		from public.qorpera_coding_sessions
		where worker_id = v_peek.worker_id
		for update;
		select * into v_worker
		from public.qorpera_runtime_workers
		where id = v_peek.worker_id;
	end if;

	select * into v_session from public.qorpera_surface_sessions where id = p_session_id for update;
	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	if v_session.worker_id is distinct from v_peek.worker_id then
		raise exception 'Track worker changed concurrently; retry stopping the turn' using errcode = '55000';
	end if;
	if v_session.is_internal then
		raise exception 'Cannot cancel an internal reconciliation session' using errcode = '55000';
	end if;
	if v_session.state not in ('queued', 'running', 'reconciling', 'reconciling_running') then
		return public.qorpera_surface_session_json(v_session);
	end if;

	if v_worker.id is not null and v_worker.occurrence_id is not null then
		v_wake_ids := array_append(v_wake_ids, v_worker.occurrence_id);
	end if;
	if v_session.wake_id is not null and not (v_session.wake_id = any(v_wake_ids)) then
		v_wake_ids := array_append(v_wake_ids, v_session.wake_id);
	end if;

	if cardinality(v_wake_ids) > 0 then
		update public.qorpera_wake_occurrences
		set
			status = 'cancelled',
			finished_at = v_now,
			blocked_reason = 'Stopped by member'
		where id = any(v_wake_ids)
			and status = 'queued';

		for v_job_id in
			select s.id
			from (
				select distinct job.id
				from public.qorpera_wake_occurrences wk
				join public.qorpera_execution_runs run on run.id = wk.run_id
				join public.qorpera_runner_jobs job on job.id = run.job_id and job.run_id = run.id
				where wk.id = any(v_wake_ids)
					and job.profile_id = v_session.profile_id
					and job.status in ('queued', 'leased')
				order by job.id asc
			) s
		loop
			perform public.qorpera_terminalize_runner_attempt(v_job_id, 'cancelled', 'Stopped by member', false);
			perform public.qorpera_append_runner_audit(
				v_session.profile_id, null, v_job_id, 'job_cancelled',
				jsonb_build_object('reason', 'surface_turn_stopped', 'sessionId', p_session_id),
				v_user_id
			);
		end loop;
	end if;

	if v_worker.id is not null and v_worker.state = 'active' then
		update public.qorpera_runtime_workers
		set
			epoch = epoch + 1,
			occurrence_id = null,
			updated_at = v_now
		where id = v_worker.id;

		if v_coding.worker_id is not null then
			update public.qorpera_coding_sessions
			set
				phase = 'awaiting_input',
				lease_owner = null,
				lease_token = null,
				lease_until = null,
				last_step = 'Stopped by member',
				updated_at = v_now
			where worker_id = v_coding.worker_id
				and phase in ('queued', 'input_ready', 'preparing', 'running', 'publishing');
			if found then
				perform public.qorpera_coding_event(
					v_coding.worker_id, v_worker.sequence, 'phase', 'member',
					jsonb_build_object('phase', 'awaiting_input', 'reason', 'member_stopped')
				);
			end if;
		end if;
	end if;

	insert into public.qorpera_surface_session_messages(
		profile_id, session_id, author_kind, author_user_id, body
	)
	values (v_session.profile_id, p_session_id, 'system', v_user_id, 'Stopped by member.');

	update public.qorpera_surface_sessions
	set
		state = 'ready',
		has_active_chat = true,
		question = null,
		lease_token = null,
		lease_expires_at = null,
		wake_id = null,
		current_activity = null,
		updated_at = v_now
	where id = p_session_id
	returning * into v_session;

	return public.qorpera_surface_session_json(v_session);
end $$;
revoke all on function public.qorpera_cancel_surface_session_turn(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_cancel_surface_session_turn(uuid)
	to authenticated;

create function public.qorpera_native_surface_upsert_artifact(
	p_profile_id uuid,
	p_session_id uuid,
	p_lease_token uuid,
	p_kind text,
	p_artifact_key text,
	p_title text,
	p_summary text default null,
	p_content_format text default 'markdown',
	p_content_text text default null,
	p_image_ref jsonb default null,
	p_change_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_artifact public.qorpera_surface_session_artifacts%rowtype;
	v_key text := lower(btrim(coalesce(p_artifact_key, '')));
	v_title text := btrim(coalesce(p_title, ''));
	v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
	v_format text := lower(btrim(coalesce(p_content_format, 'markdown')));
	v_kind text := lower(btrim(coalesce(p_kind, '')));
	v_existing_count integer := 0;
	v_exists boolean := false;
	v_now timestamptz := clock_timestamp();
begin
	if p_profile_id is null or p_session_id is null or p_lease_token is null then
		raise exception 'Surface artifact update requires profile, session, and lease token' using errcode = '42501';
	end if;
	if v_kind not in ('mockup', 'plan', 'report', 'diff_summary', 'checklist') then
		raise exception 'Artifact kind is invalid' using errcode = '22023';
	end if;
	if v_key !~ '^[a-z0-9][a-z0-9._:-]{0,79}$' then
		raise exception 'Artifact key is invalid' using errcode = '22023';
	end if;
	if char_length(v_title) not between 1 and 160 then
		raise exception 'Artifact title must be 1..160 characters' using errcode = '22023';
	end if;
	if v_summary is not null and char_length(v_summary) > 2000 then
		raise exception 'Artifact summary exceeds 2000 characters' using errcode = '22023';
	end if;
	if v_format not in ('markdown', 'html', 'json', 'image_ref') then
		raise exception 'Artifact content format is invalid' using errcode = '22023';
	end if;
	if v_format = 'image_ref' then
		if p_image_ref is null
			or jsonb_typeof(p_image_ref) <> 'object'
			or pg_column_size(p_image_ref) > 2048
			or (p_image_ref - array['sha256', 'bytes', 'mediaType']) <> '{}'::jsonb
			or coalesce(p_image_ref ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
			or jsonb_typeof(p_image_ref -> 'bytes') <> 'number'
			or coalesce(p_image_ref ->> 'bytes', '') !~ '^[1-9][0-9]{0,7}$'
			or (p_image_ref ->> 'bytes')::integer > 8388608
			or coalesce(p_image_ref ->> 'mediaType', '') not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') then
			raise exception 'Artifact imageRef is invalid' using errcode = '22023';
		end if;
	else
		if p_content_text is null or char_length(btrim(p_content_text)) = 0 or octet_length(p_content_text) > 262144 then
			raise exception 'Artifact contentText must be 1..262144 bytes' using errcode = '22023';
		end if;
		if p_image_ref is not null then
			raise exception 'imageRef is only valid when contentFormat is image_ref' using errcode = '22023';
		end if;
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

	if p_change_id is not null and not exists (
		select 1 from public.qorpera_surface_changes ch
		where ch.id = p_change_id and ch.session_id = p_session_id and ch.profile_id = p_profile_id
	) then
		raise exception 'Change does not belong to surface session' using errcode = '22023';
	end if;

	select exists (
		select 1 from public.qorpera_surface_session_artifacts a
		where a.session_id = p_session_id and a.artifact_key = v_key
	) into v_exists;
	if not v_exists then
		select count(*)::integer into v_existing_count
		from public.qorpera_surface_session_artifacts a
		where a.session_id = p_session_id;
		if v_existing_count >= 32 then
			raise exception 'Session artifact limit (32) reached' using errcode = '55000';
		end if;
	end if;

	insert into public.qorpera_surface_session_artifacts(
		profile_id, surface_id, session_id, kind, artifact_key, title, summary,
		content_format, content_text, image_ref, change_id, revision, created_by_kind, created_by_user_id,
		created_at, updated_at
	)
	values (
		p_profile_id, v_session.surface_id, p_session_id, v_kind, v_key, v_title, v_summary,
		v_format, case when v_format = 'image_ref' then null else p_content_text end,
		case when v_format = 'image_ref' then p_image_ref else null end,
		p_change_id, 1, 'agent', null, v_now, v_now
	)
	on conflict (session_id, artifact_key) do update set
		kind = excluded.kind,
		title = excluded.title,
		summary = excluded.summary,
		content_format = excluded.content_format,
		content_text = excluded.content_text,
		image_ref = excluded.image_ref,
		change_id = excluded.change_id,
		revision = public.qorpera_surface_session_artifacts.revision + 1,
		updated_at = v_now
	returning * into v_artifact;

	update public.qorpera_surface_sessions
	set updated_at = v_now
	where id = p_session_id;

	return jsonb_build_object(
		'id', v_artifact.id,
		'sessionId', v_artifact.session_id,
		'surfaceId', v_artifact.surface_id,
		'kind', v_artifact.kind,
		'artifactKey', v_artifact.artifact_key,
		'title', v_artifact.title,
		'summary', v_artifact.summary,
		'contentFormat', v_artifact.content_format,
		'contentText', v_artifact.content_text,
		'imageRef', v_artifact.image_ref,
		'changeId', v_artifact.change_id,
		'revision', v_artifact.revision,
		'createdByKind', v_artifact.created_by_kind,
		'createdByUserId', v_artifact.created_by_user_id,
		'createdAt', v_artifact.created_at,
		'updatedAt', v_artifact.updated_at
	);
end $$;
revoke all on function public.qorpera_native_surface_upsert_artifact(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, uuid)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_native_surface_upsert_artifact(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, uuid)
	to service_role;

create function public.qorpera_native_surface_report_progress(
	p_profile_id uuid,
	p_session_id uuid,
	p_lease_token uuid,
	p_current_activity text default null,
	p_progress_steps jsonb default null,
	p_checks_summary jsonb default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_activity text;
	v_step jsonb;
	v_cmd jsonb;
	v_now timestamptz := clock_timestamp();
begin
	if p_profile_id is null or p_session_id is null or p_lease_token is null then
		raise exception 'Surface progress update requires profile, session, and lease token' using errcode = '42501';
	end if;

	if p_current_activity is not null then
		v_activity := nullif(btrim(p_current_activity), '');
		if v_activity is not null and char_length(v_activity) > 240 then
			raise exception 'currentActivity exceeds 240 characters' using errcode = '22023';
		end if;
	end if;

	if p_progress_steps is not null then
		if jsonb_typeof(p_progress_steps) <> 'array'
			or jsonb_array_length(p_progress_steps) > 16
			or pg_column_size(p_progress_steps) > 8192 then
			raise exception 'progressSteps must be an array of at most 16 steps within 8192 bytes' using errcode = '22023';
		end if;
		for v_step in select value from jsonb_array_elements(p_progress_steps) loop
			if jsonb_typeof(v_step) <> 'object'
				or (v_step - array['id', 'label', 'status', 'detail']) <> '{}'::jsonb
				or jsonb_typeof(v_step -> 'id') <> 'string'
				or char_length(btrim(v_step ->> 'id')) not between 1 and 48
				or jsonb_typeof(v_step -> 'label') <> 'string'
				or char_length(btrim(v_step ->> 'label')) not between 1 and 160
				or coalesce(v_step ->> 'status', '') not in ('pending', 'in_progress', 'done', 'failed', 'skipped')
				or (v_step ? 'detail' and v_step -> 'detail' <> 'null'::jsonb and (
					jsonb_typeof(v_step -> 'detail') <> 'string'
					or char_length(v_step ->> 'detail') > 300
				)) then
				raise exception 'progressSteps entry is invalid' using errcode = '22023';
			end if;
		end loop;
	end if;

	if p_checks_summary is not null then
		if jsonb_typeof(p_checks_summary) <> 'object'
			or pg_column_size(p_checks_summary) > 8192
			or (p_checks_summary - array['status', 'summary', 'commands', 'updatedAt']) <> '{}'::jsonb
			or coalesce(p_checks_summary ->> 'status', '') not in ('pending', 'running', 'passed', 'failed', 'skipped')
			or (p_checks_summary ? 'summary' and p_checks_summary -> 'summary' <> 'null'::jsonb and (
				jsonb_typeof(p_checks_summary -> 'summary') <> 'string'
				or char_length(p_checks_summary ->> 'summary') > 500
			))
			or (p_checks_summary ? 'updatedAt' and p_checks_summary -> 'updatedAt' <> 'null'::jsonb and (
				jsonb_typeof(p_checks_summary -> 'updatedAt') <> 'string'
				or char_length(p_checks_summary ->> 'updatedAt') > 64
			)) then
			raise exception 'checksSummary is invalid' using errcode = '22023';
		end if;
		if p_checks_summary ? 'commands' and p_checks_summary -> 'commands' <> 'null'::jsonb then
			if jsonb_typeof(p_checks_summary -> 'commands') <> 'array'
				or jsonb_array_length(p_checks_summary -> 'commands') > 16 then
				raise exception 'checksSummary.commands must be an array of at most 16 items' using errcode = '22023';
			end if;
			for v_cmd in select value from jsonb_array_elements(p_checks_summary -> 'commands') loop
				if jsonb_typeof(v_cmd) <> 'object'
					or (v_cmd - array['name', 'status', 'durationMs']) <> '{}'::jsonb
					or jsonb_typeof(v_cmd -> 'name') <> 'string'
					or char_length(btrim(v_cmd ->> 'name')) not between 1 and 120
					or coalesce(v_cmd ->> 'status', '') not in ('pending', 'running', 'passed', 'failed', 'skipped')
					or (v_cmd ? 'durationMs' and v_cmd -> 'durationMs' <> 'null'::jsonb and (
						jsonb_typeof(v_cmd -> 'durationMs') <> 'number'
						or coalesce((v_cmd ->> 'durationMs') !~ '^[0-9]{1,9}$', true)
					)) then
					raise exception 'checksSummary.commands entry is invalid' using errcode = '22023';
				end if;
			end loop;
		end if;
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

	update public.qorpera_surface_sessions
	set
		current_activity = case when p_current_activity is not null then v_activity else current_activity end,
		progress_steps = coalesce(p_progress_steps, progress_steps),
		checks_summary = coalesce(p_checks_summary, checks_summary),
		updated_at = v_now
	where id = p_session_id
	returning * into v_session;

	return jsonb_build_object(
		'sessionId', v_session.id,
		'currentActivity', v_session.current_activity,
		'progressSteps', coalesce(v_session.progress_steps, '[]'::jsonb),
		'checksSummary', v_session.checks_summary,
		'updatedAt', v_session.updated_at
	);
end $$;
revoke all on function public.qorpera_native_surface_report_progress(uuid, uuid, uuid, text, jsonb, jsonb)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_native_surface_report_progress(uuid, uuid, uuid, text, jsonb, jsonb)
	to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_native_surface_upsert_artifact', 'profile'),
	('qorpera_native_surface_report_progress', 'profile')
on conflict (name) do nothing;

do $$
declare
	v_owner name;
	v_bad text;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_session_json(public.qorpera_surface_sessions)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930937000: patched function has an API owner: %', v_owner;
		end if;
		execute format('grant select on public.qorpera_surface_session_artifacts to %I', v_owner);
	end loop;

	select string_agg(p.oid::regprocedure::text, ', ')
	into v_bad
	from pg_proc p
	join awtb_before b on b.oid = p.oid
	where p.pronamespace = 'public'::regnamespace
		and b.fields is distinct from (to_jsonb(p) - 'prosrc');
	if v_bad is not null then
		raise exception '20260930937000 changed function metadata on: %', v_bad;
	end if;
end $$;

drop function pg_temp.awtb_patch(regprocedure, text[]);
drop table awtb_before;
