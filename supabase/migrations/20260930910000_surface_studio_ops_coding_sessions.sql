set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_studio_ops_coding_ready()') is not null then
		raise exception '20260930910000 is already applied';
	end if;
	if to_regprocedure('public.qorpera_coding_claude_driver_ready()') is null
		or to_regprocedure('public.qorpera_reply_surface_session(uuid,text,boolean,uuid)') is null
		or to_regprocedure('public.qorpera_surface_enqueue_session_run(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text,text)') is null
		or to_regprocedure('public.qorpera_machine_data_pass(uuid,jsonb,text)') is null
		or to_regprocedure('public.qorpera_data_pass_redeem(text)') is null then
		raise exception '20260930910000 requires Claude coding defaults, surface reply in-place, coding machine planning, and coding data passes';
	end if;
end $$;

create function pg_temp.ssoc_apply(p_def text, p_label text, p_pairs text[])
returns text language plpgsql as $$
declare
	v_def text := p_def;
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930910000: invalid replacement pairs for %', p_label;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930910000: anchor matched % time(s) in %: %', v_hits, p_label, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	return v_def;
end $$;

create function pg_temp.ssoc_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
begin
	execute pg_temp.ssoc_apply(pg_get_functiondef(p_target), p_target::text, p_pairs);
end $$;

alter table public.qorpera_coding_sessions
	add column workspace_kind text not null default 'git_repo'
		check (workspace_kind in ('git_repo', 'surface_folder', 'surface_ops')),
	alter column repository drop not null;

do $$
declare
	v_con name;
begin
	for v_con in
		select c.conname
		from pg_constraint c
		where c.conrelid = 'public.qorpera_coding_sessions'::regclass
			and c.contype = 'c'
			and pg_get_constraintdef(c.oid) like '%qorpera_coding_repository_valid%'
	loop
		execute format('alter table public.qorpera_coding_sessions drop constraint %I', v_con);
	end loop;
end $$;

alter table public.qorpera_coding_sessions
	add constraint qorpera_coding_sessions_workspace_repository_check check (
		(workspace_kind = 'git_repo' and repository is not null and public.qorpera_coding_repository_valid(repository))
		or (workspace_kind in ('surface_folder', 'surface_ops') and repository is null and surface_session_id is not null)
	);

create function public.qorpera_surface_studio_ops_coding_ready()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton
			and bundle.manifest -> 'implementation' ? 'packages/runtime/src/cloud-surface-coding-tools.ts'
	)
$$;

create function public.qorpera_coding_session_machine_repository(p_session public.qorpera_coding_sessions)
returns text language sql immutable set search_path = '' as $$
	select case
		when coalesce(p_session.workspace_kind, 'git_repo') <> 'git_repo' then 'qorpera/surface-workspace'
		else lower((p_session.repository ->> 'owner') || '/' || (p_session.repository ->> 'name'))
	end
$$;

-- WHY: Reserve qorpera/surface-workspace for non-git Studio/Ops coding machines so no real git repo can collide on machine identity.
select pg_temp.ssoc_patch(
	'public.qorpera_coding_repository_valid(jsonb)'::regprocedure,
	array[
$old$		and not exists (select 1 from unnest(string_to_array(p_repository ->> 'baseBranch','/')) part
			where part = '' or left(part,1) = '.' or right(part,1) = '.' or right(part,5) = '.lock'), false)$old$,
$new$		and not (lower(p_repository ->> 'owner') = 'qorpera' and lower(p_repository ->> 'name') = 'surface-workspace')
		and not exists (select 1 from unnest(string_to_array(p_repository ->> 'baseBranch','/')) part
			where part = '' or left(part,1) = '.' or right(part,1) = '.' or right(part,5) = '.lock'), false)$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure,
	array[
$old$	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));$old$,
$new$	v_repository := public.qorpera_coding_session_machine_repository(v_session);$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure,
	array[
$old$		or v_machine.repository is distinct from lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name')) then$old$,
$new$		or v_machine.repository is distinct from public.qorpera_coding_session_machine_repository(v_session) then$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_coding_attachment_refusal(public.qorpera_coding_sessions,public.qorpera_runtime_workers,public.qorpera_coding_machines)'::regprocedure,
	array[
$old$		when not exists (select 1 from public.qorpera_coding_repository_grants grant_row where grant_row.environment_id = p_session.environment_id
			and grant_row.staff_agent_id = p_worker.staff_agent_id and grant_row.repository = p_session.repository and grant_row.enabled) then 'REPOSITORY_WITHDRAWN'$old$,
$new$		when coalesce(p_session.workspace_kind, 'git_repo') = 'git_repo' and not exists (select 1 from public.qorpera_coding_repository_grants grant_row where grant_row.environment_id = p_session.environment_id
			and grant_row.staff_agent_id = p_worker.staff_agent_id and grant_row.repository = p_session.repository and grant_row.enabled) then 'REPOSITORY_WITHDRAWN'
		when coalesce(p_session.workspace_kind, 'git_repo') <> 'git_repo' and not exists (select 1 from public.qorpera_surface_sessions ss join public.qorpera_surfaces surf on surf.id = ss.surface_id
			where ss.id = p_session.surface_session_id and surf.status = 'active') then 'REPOSITORY_WITHDRAWN'$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	array[
$old$	) or not exists (
		select 1 from public.qorpera_coding_repository_grants as repository_grant
		where repository_grant.environment_id = v_session.environment_id
			and repository_grant.staff_agent_id = v_worker.staff_agent_id
			and repository_grant.repository = v_session.repository and repository_grant.enabled
	) then$old$,
$new$	) or (v_session.workspace_kind = 'git_repo' and not exists (
		select 1 from public.qorpera_coding_repository_grants as repository_grant
		where repository_grant.environment_id = v_session.environment_id
			and repository_grant.staff_agent_id = v_worker.staff_agent_id
			and repository_grant.repository = v_session.repository and repository_grant.enabled
	)) then$new$,
$old$	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));$old$,
$new$	v_repository := case when v_session.workspace_kind = 'git_repo'
		then lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'))
		else null end;$new$
	]
);

-- WHY: Prevent Studio and Ops coding VMs from mutating live published Company Files directly via /company; changes must be staged via stage_surface_patch or stage_surface_ops_action (notes write via the run actor).
select pg_temp.ssoc_patch(
	'public.qorpera_folder_commit(uuid,jsonb,text,jsonb,uuid,uuid)'::regprocedure,
	array[
$old$		if v_ok and v_actor_kind in ('member','run','view') and not (v_actor_kind = 'run'
			and public.qorpera_memory_run_log_admits(p_environment_id, p_operation_key, v_auth_actor, v_op, v_path, v_unit)) then$old$,
$new$		if v_ok and v_actor_kind = 'view' and v_view.kind = 'coding_session' and exists (
			select 1 from public.qorpera_coding_sessions cs
			where cs.worker_id = v_view.worker_id and cs.workspace_kind <> 'git_repo'
		) then
			v_ok := false; v_reason := 'denied';
		end if;
		if v_ok and v_actor_kind in ('member','run','view') and not (v_actor_kind = 'run'
			and public.qorpera_memory_run_log_admits(p_environment_id, p_operation_key, v_auth_actor, v_op, v_path, v_unit)) then$new$
	]
);

-- WHY: Prevent Studio and Ops coding VMs from bypassing staging/approval via the company-data machine pass (data change/apply).
select pg_temp.ssoc_patch(
	'public.qorpera_machine_data_pass(uuid,jsonb,text)'::regprocedure,
	array[
$old$			where cs.worker_id = v_view.worker_id and cs.attachment_token = v_view.attachment_token
				and cs.archived_at is null and m.id = v_view.machine_id$old$,
$new$			where cs.worker_id = v_view.worker_id and cs.attachment_token = v_view.attachment_token
				and cs.workspace_kind = 'git_repo'
				and cs.archived_at is null and m.id = v_view.machine_id$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_data_pass_redeem(text)'::regprocedure,
	array[
$old$					where cs.worker_id = view.worker_id and cs.attachment_token = view.attachment_token
						and cs.archived_at is null and m.id = view.machine_id$old$,
$new$					where cs.worker_id = view.worker_id and cs.attachment_token = view.attachment_token
						and cs.workspace_kind = 'git_repo'
						and cs.archived_at is null and m.id = view.machine_id$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions,public.qorpera_runtime_workers)'::regprocedure,
	array[
$old$		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,$old$,
$new$		'harness',p_session.harness,'model',p_session.model,'workspaceKind',coalesce(p_session.workspace_kind, 'git_repo'),'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_authorize_coding_turn(jsonb)'::regprocedure,
	array[
$old$		'surfaceSessionId', v_session.surface_session_id,$old$,
$new$		'surfaceSessionId', v_session.surface_session_id,
		'workspaceKind', v_session.workspace_kind,$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
	array[
$old$			'harness', v_session.harness, 'repository', v_session.repository,$old$,
$new$			'harness', v_session.harness, 'workspaceKind', v_session.workspace_kind, 'repository', v_session.repository,$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	array[
$old$	v_is_surface boolean;
	v_is_claude boolean;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_is_surface := nullif(coalesce(v_authority #>> '{coding,surfaceSessionId}', ''), '') is not null;
	v_is_claude := v_authority #>> '{coding,harness}' = 'claude-code';$old$,
$new$	v_is_surface boolean;
	v_is_claude boolean;
	v_workspace_kind text;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_is_surface := nullif(coalesce(v_authority #>> '{coding,surfaceSessionId}', ''), '') is not null;
	v_is_claude := v_authority #>> '{coding,harness}' = 'claude-code';
	v_workspace_kind := coalesce(v_authority #>> '{coding,workspaceKind}', 'git_repo');$new$,
$old$	if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 8 else 6 end)
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool) <> jsonb_array_length(v_catalog -> 'tools')
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))
		) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;$old$,
$new$	if (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool) <> jsonb_array_length(v_catalog -> 'tools') then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;
	if v_workspace_kind = 'surface_folder' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 16
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_patch','narrate_explainer','make_picture','coding_view_attachment',
					'company_read','company_list','company_write','company_edit','company_mkdir',
					'read_skill','search_skills','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;
	elsif v_workspace_kind = 'surface_ops' then
		if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 2 else 5 end) and 10
			or exists (
				select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
				where tool ->> 'name' not in (
					'stage_surface_ops_action','coding_view_attachment',
					'company_read','company_list','coding_finish','coding_ask'
				)
					and not (not v_is_claude and tool ->> 'name' in ('coding_run_command','coding_read_command','coding_cancel_command'))
			) then
			raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
		end if;
	elsif jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 8 else 6 end)
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask','make_picture')
				and not (v_is_surface and tool ->> 'name' in ('coding_record_change', 'coding_view_attachment'))
		) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_record_coding_context_view(jsonb,jsonb)'::regprocedure,
	array[
$old$	if exists (select 1 from jsonb_array_elements(p_view -> 'outputs') output where output -> 'readId' is distinct from 'null'::jsonb or output ? 'capture') then
		raise exception 'Coding context cannot introduce Company File reads' using errcode = '42501'; end if;$old$,
$new$	if exists (
		select 1 from jsonb_array_elements(p_view -> 'outputs') output
		where output ? 'capture'
			or (coalesce(v_authority #>> '{coding,workspaceKind}', 'git_repo') = 'git_repo'
				and output -> 'readId' is distinct from 'null'::jsonb)
	) then
		raise exception 'Coding context cannot introduce Company File reads' using errcode = '42501'; end if;$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_submit_coding_turn(jsonb,jsonb)'::regprocedure,
	array[
$old$declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_session public.qorpera_coding_sessions%rowtype;$old$,
$new$declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_workspace_kind text; v_session public.qorpera_coding_sessions%rowtype;$new$,
$old$	v_worker_id := (v_authority #>> '{coding,workerId}')::uuid;
	v_sequence := (v_authority #>> '{coding,sequence}')::integer;$old$,
$new$	v_worker_id := (v_authority #>> '{coding,workerId}')::uuid;
	v_sequence := (v_authority #>> '{coding,sequence}')::integer;
	v_workspace_kind := coalesce(v_authority #>> '{coding,workspaceKind}', 'git_repo');$new$,
$old$		or (v_kind = 'finish' and (p_submission - array['kind','operationKey','summary','headSha','notice','picture'] <> '{}'::jsonb
			or coalesce(p_submission ->> 'headSha','') !~ '^[0-9a-f]{40}$'
			or (p_submission ? 'notice' and (jsonb_typeof(p_submission -> 'notice') <> 'string'
				or char_length(p_submission ->> 'notice') not between 1 and 200 or p_submission ->> 'notice' ~ '[\n\r\t]'))
			or (p_submission ? 'picture' and (jsonb_typeof(p_submission -> 'picture') <> 'string'
				or octet_length(p_submission ->> 'picture') > 300
				or p_submission ->> 'picture' !~ '^[A-Za-z0-9._-][A-Za-z0-9._ -]*(/[A-Za-z0-9._-][A-Za-z0-9._ -]*)*\.(png|jpg|jpeg|webp|PNG|JPG|JPEG|WEBP)$'
				or exists (select 1 from unnest(string_to_array(p_submission ->> 'picture', '/')) part where part in ('.','..'))))))$old$,
$new$		or (v_kind = 'finish' and v_workspace_kind = 'git_repo' and (p_submission - array['kind','operationKey','summary','headSha','notice','picture'] <> '{}'::jsonb
			or coalesce(p_submission ->> 'headSha','') !~ '^[0-9a-f]{40}$'
			or (p_submission ? 'notice' and (jsonb_typeof(p_submission -> 'notice') <> 'string'
				or char_length(p_submission ->> 'notice') not between 1 and 200 or p_submission ->> 'notice' ~ '[\n\r\t]'))
			or (p_submission ? 'picture' and (jsonb_typeof(p_submission -> 'picture') <> 'string'
				or octet_length(p_submission ->> 'picture') > 300
				or p_submission ->> 'picture' !~ '^[A-Za-z0-9._-][A-Za-z0-9._ -]*(/[A-Za-z0-9._-][A-Za-z0-9._ -]*)*\.(png|jpg|jpeg|webp|PNG|JPG|JPEG|WEBP)$'
				or exists (select 1 from unnest(string_to_array(p_submission ->> 'picture', '/')) part where part in ('.','..'))))))
		or (v_kind = 'finish' and v_workspace_kind <> 'git_repo' and (p_submission - array['kind','operationKey','summary','headSha','notePaths'] <> '{}'::jsonb
			or (p_submission ? 'headSha' and p_submission -> 'headSha' <> 'null'::jsonb)
			or (p_submission ? 'notePaths' and (jsonb_typeof(p_submission -> 'notePaths') <> 'array' or jsonb_array_length(p_submission -> 'notePaths') > 64
				or exists (
					select 1 from jsonb_array_elements(p_submission -> 'notePaths') np
					where jsonb_typeof(np) <> 'string'
						or btrim(np #>> '{}') = ''
						or octet_length(np #>> '{}') > 512
						or left(btrim(np #>> '{}'), 1) = '/'
						or right(btrim(np #>> '{}'), 1) = '/'
						or (np #>> '{}') like '%\%'
						or (np #>> '{}') like '%:%'
						or exists (select 1 from unnest(string_to_array(btrim(np #>> '{}'), '/')) part where part in ('', '.', '..'))
				)))))$new$,
$old$		|| jsonb_strip_nulls(jsonb_build_object('notice', p_submission ->> 'notice', 'picture', p_submission ->> 'picture'));$old$,
$new$		|| jsonb_strip_nulls(jsonb_build_object(
			'notice', p_submission ->> 'notice',
			'picture', p_submission ->> 'picture',
			'notePaths', case when v_workspace_kind <> 'git_repo' and p_submission ? 'notePaths' then p_submission -> 'notePaths' end
		));$new$
	]
);

do $$
declare
	v_def text;
begin
	v_def := pg_get_functiondef(
		'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions,public.qorpera_runtime_workers,text,text,text,jsonb,jsonb)'::regprocedure
	);
	v_def := pg_temp.ssoc_apply(v_def, 'qorpera_surface_sync_coding_completion', array[
		'p_artifacts jsonb DEFAULT NULL::jsonb)',
		'p_artifacts jsonb DEFAULT NULL::jsonb, p_note_paths text[] DEFAULT NULL::text[])',
$old$		v_sync_head_sha := case when v_head_sha ~ '^[0-9a-f]{40}$' then v_head_sha else null end;

		if v_head_sha ~ '^[0-9a-f]{40}$' and v_base_sha ~ '^[0-9a-f]{40}$' then$old$,
$new$		v_sync_head_sha := case when coalesce(p_session.workspace_kind, 'git_repo') = 'git_repo' and v_head_sha ~ '^[0-9a-f]{40}$' then v_head_sha else null end;

		if coalesce(p_session.workspace_kind, 'git_repo') = 'git_repo' and v_head_sha ~ '^[0-9a-f]{40}$' and v_base_sha ~ '^[0-9a-f]{40}$' then$new$,
$old$		perform public.qorpera_surface_complete_session_turn(
			v_surf_session.id,
			'ready',
			p_summary,
			null,
			null,
			v_sync_head_sha,
			v_surf_session.lease_token
		);$old$,
$new$		perform public.qorpera_surface_complete_session_turn(
			v_surf_session.id,
			'ready',
			p_summary,
			null,
			case when p_note_paths is not null and cardinality(p_note_paths) > 0 then p_note_paths else null end,
			v_sync_head_sha,
			v_surf_session.lease_token
		);$new$
	]);
	drop function public.qorpera_surface_sync_coding_completion(
		public.qorpera_coding_sessions, public.qorpera_runtime_workers, text, text, text, jsonb, jsonb
	);
	execute v_def;
end $$;

select pg_temp.ssoc_patch(
	'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
	array[
$old$	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb;$old$,
$new$	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb; v_note_paths text[];$new$,
$old$		or (p_pull_request is not null and v_session.repository ->> 'host' <> 'github.com')$old$,
$new$		or (p_pull_request is not null and (v_session.workspace_kind <> 'git_repo' or v_session.repository ->> 'host' is distinct from 'github.com'))$new$,
$old$		or (p_artifacts is not null and (v_session.repository ->> 'host' <> 'qorpera' or p_outcome <> 'succeeded'$old$,
$new$		or (p_artifacts is not null and (v_session.workspace_kind <> 'git_repo' or v_session.repository ->> 'host' is distinct from 'qorpera' or p_outcome <> 'succeeded'$new$,
$old$	update public.qorpera_coding_sessions set$old$,
$new$	if v_session.workspace_kind <> 'git_repo' then
		select array_agg(np) into v_note_paths
		from public.qorpera_coding_session_turns t
		cross join lateral jsonb_array_elements_text(
			case when jsonb_typeof(t.submission -> 'notePaths') = 'array' then t.submission -> 'notePaths' else '[]'::jsonb end
		) as np
		where t.worker_id = v_worker.id and t.sequence = v_worker.sequence
			and nullif(btrim(np), '') is not null;
	end if;
	update public.qorpera_coding_sessions set$new$,
$old$		perform public.qorpera_surface_sync_coding_completion(v_session, v_worker, p_outcome, v_summary, v_needs, p_options, p_artifacts);$old$,
$new$		perform public.qorpera_surface_sync_coding_completion(v_session, v_worker, p_outcome, v_summary, v_needs, p_options, p_artifacts, v_note_paths);$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$	v_harness text;
	v_title text;$old$,
$new$	v_harness text;
	v_workspace_kind text;
	v_title text;$new$,
$old$	if v_surface.source_kind = 'code_repo' then$old$,
$new$	if v_surface.source_kind = 'code_repo'
		or (v_surface.source_kind in ('folder', 'native_ops') and public.qorpera_surface_studio_ops_coding_ready()) then
		v_workspace_kind := case v_surface.source_kind
			when 'code_repo' then 'git_repo'
			when 'folder' then 'surface_folder'
			else 'surface_ops'
		end;$new$,
$old$		if v_surface.repository_key is not null and position('/' in v_surface.repository_key) > 0 then
			v_repo_owner := lower(btrim(split_part(v_surface.repository_key, '/', 1)));
			v_repo_name := lower(btrim(split_part(v_surface.repository_key, '/', 2)));
		else
			v_repo_owner := 'surfaces';
			v_repo_name := lower(v_surface.slug);
		end if;
		v_repo := jsonb_build_object(
			'host', 'qorpera',
			'owner', v_repo_owner,
			'name', v_repo_name,
			'baseBranch', 'main'
		);
		if not public.qorpera_coding_repository_valid(v_repo) then
			return jsonb_build_object('status', 'unavailable', 'reason', 'invalid_repository');
		end if;

		if exists (
			select 1 from public.qorpera_coding_repository_grants g
			where g.environment_id = v_cofounder.environment_id
				and g.repository ->> 'host' = 'github.com'
				and lower(g.repository ->> 'owner') = v_repo_owner
				and lower(g.repository ->> 'name') = v_repo_name
		) then
			return jsonb_build_object('status', 'unavailable', 'reason', 'repository_conflict');
		end if;$old$,
$new$		if v_workspace_kind = 'git_repo' then
			if v_surface.repository_key is not null and position('/' in v_surface.repository_key) > 0 then
				v_repo_owner := lower(btrim(split_part(v_surface.repository_key, '/', 1)));
				v_repo_name := lower(btrim(split_part(v_surface.repository_key, '/', 2)));
			else
				v_repo_owner := 'surfaces';
				v_repo_name := lower(v_surface.slug);
			end if;
			v_repo := jsonb_build_object(
				'host', 'qorpera',
				'owner', v_repo_owner,
				'name', v_repo_name,
				'baseBranch', 'main'
			);
			if not public.qorpera_coding_repository_valid(v_repo) then
				return jsonb_build_object('status', 'unavailable', 'reason', 'invalid_repository');
			end if;

			if exists (
				select 1 from public.qorpera_coding_repository_grants g
				where g.environment_id = v_cofounder.environment_id
					and g.repository ->> 'host' = 'github.com'
					and lower(g.repository ->> 'owner') = v_repo_owner
					and lower(g.repository ->> 'name') = v_repo_name
			) then
				return jsonb_build_object('status', 'unavailable', 'reason', 'repository_conflict');
			end if;
		else
			v_repo := null;
		end if;$new$,
$old$		insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
		values (v_cofounder.environment_id, v_cofounder.staff_agent_id, v_repo, true)
		on conflict (environment_id, staff_agent_id, repository) do nothing;
		if exists (
			select 1 from public.qorpera_coding_repository_grants g
			where g.environment_id = v_cofounder.environment_id
				and g.staff_agent_id = v_cofounder.staff_agent_id
				and g.repository = v_repo
				and not g.enabled
		) then
			return jsonb_build_object('status', 'unavailable', 'reason', 'repository_disabled');
		end if;$old$,
$new$		if v_workspace_kind = 'git_repo' then
			insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
			values (v_cofounder.environment_id, v_cofounder.staff_agent_id, v_repo, true)
			on conflict (environment_id, staff_agent_id, repository) do nothing;
			if exists (
				select 1 from public.qorpera_coding_repository_grants g
				where g.environment_id = v_cofounder.environment_id
					and g.staff_agent_id = v_cofounder.staff_agent_id
					and g.repository = v_repo
					and not g.enabled
			) then
				return jsonb_build_object('status', 'unavailable', 'reason', 'repository_disabled');
			end if;
		end if;$new$,
$old$				if nullif(v_preview_base_summary, '') is not null then
					v_goal := public.qorpera_surface_utf8_left(
						v_goal || E'\nActive preview changes visible when requested (inspect via git show): ' || v_preview_base_summary,
						2000
					);
				end if;$old$,
$new$				if nullif(v_preview_base_summary, '') is not null then
					v_goal := public.qorpera_surface_utf8_left(
						v_goal || case when v_workspace_kind = 'git_repo'
							then E'\nActive preview changes visible when requested (inspect via git show): '
							else E'\nActive preview changes visible when requested: ' end || v_preview_base_summary,
						2000
					);
				end if;$new$,
$old$			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', case
					when v_session.is_internal and v_session.origin_ref ? 'reconciliationId'
					then 'Integrate all listed staged changes onto main cleanly (newer intent wins on direct contradictions), verify builds/checks, commit once, call coding_record_change, and finish with coding_finish. Never call coding_ask.'
					else 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.'
				end,
				'context', v_context,
				'sources', '[]'::jsonb,
				'followUp', v_followup,
				'authority', 'Work only inside this Surface repository worktree on the session branch.',
				'output', 'Stage changes on the session branch via coding_record_change and finish with coding_finish.',
				'cancellation', 'Stop if the Surface session is cancelled or superseded.',
				'completion', 'Sync staged commits and summary back to the Surface session.'
			);$old$,
$new$			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', case
					when v_workspace_kind = 'surface_folder' and v_session.is_internal and v_session.origin_ref ? 'reconciliationId'
						then 'Combine all listed overlapping folder patches cleanly via stage_surface_patch (newer intent wins on direct contradictions) and finish with coding_finish. Never call coding_ask.'
					when v_workspace_kind = 'surface_folder'
						then 'Stage clean, verified Studio changes via stage_surface_patch (one call per deliverable) and finish with coding_finish.'
					when v_workspace_kind = 'surface_ops'
						then 'Stage clear, structured operational action(s) via stage_surface_ops_action and finish with coding_finish.'
					when v_session.is_internal and v_session.origin_ref ? 'reconciliationId'
						then 'Integrate all listed staged changes onto main cleanly (newer intent wins on direct contradictions), verify builds/checks, commit once, call coding_record_change, and finish with coding_finish. Never call coding_ask.'
					else 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.'
				end,
				'context', v_context,
				'sources', '[]'::jsonb,
				'followUp', v_followup,
				'authority', case
					when v_workspace_kind = 'surface_folder'
						then 'Inspect Company Files and stage Studio folder patches via stage_surface_patch without mutating published files directly.'
					when v_workspace_kind = 'surface_ops'
						then 'Inspect Company Files read-only and stage operational actions via stage_surface_ops_action for founder approval.'
					else 'Work only inside this Surface repository worktree on the session branch.'
				end,
				'output', case
					when v_workspace_kind = 'surface_folder'
						then 'Stage folder patches via stage_surface_patch and finish with coding_finish.'
					when v_workspace_kind = 'surface_ops'
						then 'Stage actions via stage_surface_ops_action and finish with coding_finish.'
					else 'Stage changes on the session branch via coding_record_change and finish with coding_finish.'
				end,
				'cancellation', 'Stop if the Surface session is cancelled or superseded.',
				'completion', case
					when v_workspace_kind = 'git_repo' then 'Sync staged commits and summary back to the Surface session.'
					else 'Sync staged changes and summary back to the Surface session.'
				end
			);$new$,
$old$			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, model, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness,
				nullif(v_coding_sponsor ->> 'model', ''), v_repo,
				'qorpera/coding/' || v_worker.id::text, null,
				'queued', v_session.id
			)
			returning * into v_coding_session;$old$,
$new$			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, model, workspace_kind, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness,
				nullif(v_coding_sponsor ->> 'model', ''), v_workspace_kind, v_repo,
				'qorpera/coding/' || v_worker.id::text, null,
				'queued', v_session.id
			)
			returning * into v_coding_session;$new$,
$old$				v_followup := 'Reconcile overlapping changes on the session branch'
					|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
						then ' across: ' || array_to_string(v_conflict_paths, ', ')
						else '' end
					|| '. Commit the clean resolution, record the updated change, and call coding_finish.';$old$,
$new$				v_followup := case when v_workspace_kind = 'surface_folder' then
					'Reconcile overlapping staged folder patches'
						|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
							then ' across: ' || array_to_string(v_conflict_paths, ', ')
							else '' end
						|| '. Stage the clean combined resolution via stage_surface_patch and call coding_finish.'
				else
					'Reconcile overlapping changes on the session branch'
						|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
							then ' across: ' || array_to_string(v_conflict_paths, ', ')
							else '' end
						|| '. Commit the clean resolution, record the updated change, and call coding_finish.'
				end;$new$,
$old$			v_build_fix := public.qorpera_surface_build_fix_take(v_session, v_worker.id, v_worker.sequence + 1);
			if v_build_fix ? 'dropped' then
				-- WHY: The session was queued for a fix that went stale; it opens no turn, goes back to the state the fix
				-- found it in, and lease_lost ends the job quietly.
				update public.qorpera_surface_sessions
				set
					state = v_build_fix ->> 'priorState',
					closed_at = (v_build_fix ->> 'priorClosedAt')::timestamptz,
					lease_token = null,
					lease_expires_at = null,
					wake_id = null,
					updated_at = v_now
				where id = v_session.id;
				return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
			end if;
			if v_build_fix ? 'followup' then
				v_followup := v_build_fix ->> 'followup';
				v_member_initiated := false;
			end if;$old$,
$new$			if v_workspace_kind = 'git_repo' then
				v_build_fix := public.qorpera_surface_build_fix_take(v_session, v_worker.id, v_worker.sequence + 1);
				if v_build_fix ? 'dropped' then
					-- WHY: The session was queued for a fix that went stale; it opens no turn, goes back to the state the fix
					-- found it in, and lease_lost ends the job quietly.
					update public.qorpera_surface_sessions
					set
						state = v_build_fix ->> 'priorState',
						closed_at = (v_build_fix ->> 'priorClosedAt')::timestamptz,
						lease_token = null,
						lease_expires_at = null,
						wake_id = null,
						updated_at = v_now
					where id = v_session.id;
					return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
				end if;
				if v_build_fix ? 'followup' then
					v_followup := v_build_fix ->> 'followup';
					v_member_initiated := false;
				end if;
			end if;$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_reply_surface_session(uuid,text,boolean,uuid)'::regprocedure,
	array[
$old$	if exists (
		select 1 from public.qorpera_surfaces surf
		where surf.id = v_session.surface_id and surf.source_kind = 'code_repo'
	) then$old$,
$new$	if exists (
		select 1 from public.qorpera_surfaces surf
		where surf.id = v_session.surface_id
			and (surf.source_kind = 'code_repo'
				or (surf.source_kind in ('folder', 'native_ops') and public.qorpera_surface_studio_ops_coding_ready()))
	) then$new$
	]
);

select pg_temp.ssoc_patch(
	'public.qorpera_surface_automation_payer_problem(uuid,uuid,text)'::regprocedure,
	array[
$old$	if exists (
		select 1 from public.qorpera_surfaces s
		where s.profile_id = p_profile_id and s.slug = p_target_surface_slug and s.status = 'active'
			and s.source_kind = 'code_repo'
	) then$old$,
$new$	if exists (
		select 1 from public.qorpera_surfaces s
		where s.profile_id = p_profile_id and s.slug = p_target_surface_slug and s.status = 'active'
			and (s.source_kind = 'code_repo'
				or (s.source_kind in ('folder', 'native_ops') and public.qorpera_surface_studio_ops_coding_ready()))
	) then$new$
	]
);

drop function pg_temp.ssoc_patch(regprocedure, text[]);
drop function pg_temp.ssoc_apply(text, text, text[]);

revoke all on function
	public.qorpera_surface_studio_ops_coding_ready(),
	public.qorpera_coding_session_machine_repository(public.qorpera_coding_sessions),
	public.qorpera_coding_attachment_refusal(public.qorpera_coding_sessions, public.qorpera_runtime_workers, public.qorpera_coding_machines),
	public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions, public.qorpera_runtime_workers),
	public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions, public.qorpera_runtime_workers, text, text, text, jsonb, jsonb, text[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure,
			'public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_reply_surface_session(uuid,text,boolean,uuid)'::regprocedure,
			'public.qorpera_surface_automation_payer_problem(uuid,uuid,text)'::regprocedure,
			'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure,
			'public.qorpera_claim_coding_session(text,integer)'::regprocedure,
			'public.qorpera_folder_view_open(uuid,jsonb,text,jsonb)'::regprocedure,
			'public.qorpera_folder_view_valid(public.qorpera_folder_views)'::regprocedure,
			'public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930910000: patched function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_surface_studio_ops_coding_ready(), '
			|| 'public.qorpera_coding_session_machine_repository(public.qorpera_coding_sessions), '
			|| 'public.qorpera_coding_attachment_refusal(public.qorpera_coding_sessions, public.qorpera_runtime_workers, public.qorpera_coding_machines), '
			|| 'public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions, public.qorpera_runtime_workers), '
			|| 'public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions, public.qorpera_runtime_workers, text, text, text, jsonb, jsonb, text[]) to %I',
			v_owner
		);
	end loop;
end $$;
