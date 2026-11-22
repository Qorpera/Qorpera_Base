-- WHY: Route code_repo (live_build) Surface sessions through governed qorpera_coding_sessions so turns run in
-- writable repository VMs on refs/heads/qorpera/coding/<workerId>, keep commits staged for preview/approval
-- without landing main, and sync progress/completion back to qorpera_surface_sessions.

set local lock_timeout = '3s';

create function pg_temp.scrcs_replace(p_function regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_function);
	v_i integer;
	v_old text;
	v_new text;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930855000: invalid replacement pairs for %', p_function;
	end if;
	v_i := 1;
	while v_i <= array_length(p_pairs, 1) loop
		v_old := p_pairs[v_i];
		v_new := p_pairs[v_i + 1];
		v_hits := case when v_old = '' then 0 else (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) end;
		if v_hits <> 1 then
			raise exception '20260930855000: anchor matched % time(s) in %: %', v_hits, p_function, left(v_old, 120);
		end if;
		v_def := replace(v_def, v_old, v_new);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_runtime_workers
	alter column todo_id drop not null,
	alter column steering_run_id drop not null,
	add column surface_backed boolean not null default false,
	add column surface_session_id uuid unique references public.qorpera_surface_sessions(id) on delete set null,
	add constraint qorpera_runtime_workers_surface_origin_check check (
		(not surface_backed and surface_session_id is null and todo_id is not null and steering_run_id is not null)
		or (surface_backed and species = 'coding' and todo_id is null and steering_run_id is null and folder_path is null)
	);

alter table public.qorpera_coding_sessions
	add column surface_session_id uuid unique references public.qorpera_surface_sessions(id) on delete set null;

create index qorpera_coding_sessions_surface_session
	on public.qorpera_coding_sessions (surface_session_id)
	where surface_session_id is not null;

create function public.qorpera_surface_utf8_left(p_text text, p_max_bytes integer)
returns text language plpgsql immutable set search_path = '' as $$
declare
	v_out text := coalesce(p_text, '');
begin
	if p_max_bytes is null or p_max_bytes < 1 then
		return '';
	end if;
	while octet_length(v_out) > p_max_bytes loop
		v_out := left(v_out, greatest(0, length(v_out) - greatest(1, (octet_length(v_out) - p_max_bytes) / 4)));
	end loop;
	return v_out;
end $$;

create function public.qorpera_surface_coding_member_initiated(
	p_session public.qorpera_surface_sessions,
	p_requester_user_id uuid
)
returns boolean language sql immutable set search_path = '' as $$
	select p_session.id is not null
		and p_session.origin_kind in ('member', 'point_to_change', 'cross_surface')
		and p_session.created_by_user_id is not null
		and p_session.created_by_user_id = p_requester_user_id
$$;

create function public.qorpera_surface_resolve_coding_sponsor(
	p_profile_id uuid,
	p_environment_id uuid,
	p_owner_user_id uuid,
	p_member_initiated boolean,
	p_preferred_harness text default null,
	p_require_preferred boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_enabled_harnesses text[];
	v_candidates text[] := '{}'::text[];
	v_harness text;
	v_provider text;
	v_native text;
	v_conn_id uuid;
	v_conn_ver bigint;
	v_allow_auto boolean;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_client_hex text;
	v_client uuid;
	v_sponsor_kind text;
	v_seed text;
begin
	if not exists (
		select 1 from public.qorpera_profile_members
		where profile_id = p_profile_id and user_id = p_owner_user_id
	) then
		return jsonb_build_object('status', 'no_member');
	end if;

	if exists (select 1 from public.qorpera_coding_executors where environment_id = p_environment_id) then
		select coalesce(array_agg(distinct h order by h), '{}'::text[])
		into v_enabled_harnesses
		from public.qorpera_coding_executors e, unnest(e.harnesses) as h
		where e.environment_id = p_environment_id and e.enabled;
	else
		select coalesce(array_agg(distinct h order by h), '{}'::text[])
		into v_enabled_harnesses
		from public.qorpera_coding_executors e, unnest(e.harnesses) as h
		where e.enabled;
	end if;

	if coalesce(cardinality(v_enabled_harnesses), 0) = 0 then
		return jsonb_build_object('status', 'no_coding_executor');
	end if;

	if p_require_preferred then
		if p_preferred_harness is null or not (p_preferred_harness = any(v_enabled_harnesses)) then
			return jsonb_build_object('status', 'no_coding_executor');
		end if;
		v_candidates := array[p_preferred_harness];
	else
		if p_preferred_harness is not null and p_preferred_harness = any(v_enabled_harnesses) then
			v_candidates := array_append(v_candidates, p_preferred_harness);
		end if;
		foreach v_harness in array array['codex', 'claude-code'] loop
			if v_harness = any(v_enabled_harnesses) and not (v_harness = any(v_candidates)) then
				v_candidates := array_append(v_candidates, v_harness);
			end if;
		end loop;
	end if;

	foreach v_harness in array v_candidates loop
		v_provider := case v_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
		v_native := case v_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end;
		v_conn_id := null;
		v_conn_ver := null;
		v_allow_auto := false;

		select login.connection_id, login.connection_version, coalesce(login.allow_autonomous, false)
		into v_conn_id, v_conn_ver, v_allow_auto
		from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, v_harness) as login;

		if v_conn_id is null then
			continue;
		end if;
		if not p_member_initiated and not v_allow_auto then
			continue;
		end if;

		select * into v_version
		from public.qorpera_provider_connection_versions v
		where v.connection_id = v_conn_id and v.version = v_conn_ver and v.authorization_state = 'active';
		if v_version.connection_id is null
			or not public.qorpera_provider_execution_enabled(v_provider, v_version.authentication_mode, v_version.native_harness)
			or (v_version.authentication_mode = 'native_subscription' and not exists (
				select 1 from public.qorpera_native_credential_capsules c
				where c.id = v_version.credential_capsule_id and c.status = 'active'
			)) then
			continue;
		end if;

		v_sponsor := null;
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions sponsor
		join public.qorpera_execution_sponsor_bindings b on b.id = sponsor.binding_id
		where b.profile_id = p_profile_id and b.status = 'active'
			and sponsor.sponsor_kind = 'member_connection'
			and sponsor.provider_connection_id = v_conn_id
			and sponsor.provider_connection_version = v_conn_ver
			and sponsor.created_by_user_id = p_owner_user_id
			and (sponsor.allow_autonomous or p_member_initiated)
			and sponsor.version = (
				select max(later.version) from public.qorpera_execution_sponsor_versions later
				where later.binding_id = b.id
			)
		order by sponsor.allow_autonomous desc, sponsor.created_at desc
		limit 1;

		if v_sponsor.binding_id is null then
			v_seed := case when v_allow_auto then 'qorpera-coding-owner:' else 'qorpera-surface-coding-owner:' end
				|| v_conn_id::text || ':' || v_conn_ver::text;
			v_client_hex := encode(extensions.digest(convert_to(v_seed, 'utf8'), 'sha256'), 'hex');
			v_client := (left(v_client_hex, 8) || '-' || substr(v_client_hex, 9, 4) || '-4' || substr(v_client_hex, 14, 3)
				|| '-8' || substr(v_client_hex, 18, 3) || '-' || substr(v_client_hex, 21, 12))::uuid;
			select * into v_binding
			from public.qorpera_execution_sponsor_bindings
			where profile_id = p_profile_id and client_binding_id = v_client
			for update;
			if v_binding.id is null then
				insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
				values (p_profile_id, v_client, p_owner_user_id)
				returning * into v_binding;
			elsif v_binding.created_by_user_id <> p_owner_user_id or v_binding.status <> 'active' then
				continue;
			end if;
			select sponsor.* into v_sponsor
			from public.qorpera_execution_sponsor_versions sponsor
			where sponsor.binding_id = v_binding.id
			order by sponsor.version desc
			limit 1;
			if v_sponsor.binding_id is null
				or v_sponsor.provider_connection_version <> v_conn_ver
				or (v_allow_auto and not v_sponsor.allow_autonomous) then
				insert into public.qorpera_execution_sponsor_versions (
					binding_id, version, sponsor_kind, provider_connection_id,
					provider_connection_version, allow_autonomous, created_by_user_id
				)
				values (
					v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'member_connection', v_conn_id,
					v_conn_ver, v_allow_auto, p_owner_user_id
				)
				returning * into v_sponsor;
			end if;
		end if;

		return jsonb_build_object(
			'status', 'ok',
			'harness', v_harness,
			'bindingId', v_sponsor.binding_id,
			'version', v_sponsor.version
		);
	end loop;

	foreach v_harness in array v_candidates loop
		v_provider := case v_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
		v_native := case v_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end;
		v_conn_id := null;
		v_conn_ver := null;
		v_allow_auto := false;

		select c.id, v.version, coalesce(v.allow_autonomous, false)
		into v_conn_id, v_conn_ver, v_allow_auto
		from public.qorpera_provider_connections c
		cross join lateral (
			select pv.version, pv.allow_autonomous, pv.authentication_mode, pv.native_harness, pv.credential_capsule_id
			from public.qorpera_provider_connection_versions pv
			where pv.connection_id = c.id and pv.authorization_state = 'active' and pv.native_harness = v_native
			order by pv.version desc limit 1
		) v
		where c.profile_id = p_profile_id and c.owner_user_id is null
			and c.provider = v_provider and c.status = 'active'
			and (v.allow_autonomous or p_member_initiated)
			and public.qorpera_provider_execution_enabled(v_provider, v.authentication_mode, v.native_harness)
			and (v.authentication_mode <> 'native_subscription' or exists (
				select 1 from public.qorpera_native_credential_capsules cap
				where cap.id = v.credential_capsule_id and cap.status = 'active'
			))
		order by not coalesce(v.allow_autonomous, false), c.created_at desc, c.id
		limit 1;

		if v_conn_id is null then
			continue;
		end if;

		v_sponsor := null;
		v_sponsor_kind := 'company_connection';
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions sponsor
		join public.qorpera_execution_sponsor_bindings b on b.id = sponsor.binding_id
		where b.profile_id = p_profile_id and b.status = 'active'
			and sponsor.sponsor_kind = v_sponsor_kind
			and sponsor.provider_connection_id = v_conn_id
			and sponsor.provider_connection_version = v_conn_ver
			and (sponsor.allow_autonomous or p_member_initiated)
			and sponsor.version = (
				select max(later.version) from public.qorpera_execution_sponsor_versions later
				where later.binding_id = b.id
			)
		order by sponsor.allow_autonomous desc, sponsor.created_at desc
		limit 1;

		if v_sponsor.binding_id is null then
			v_seed := 'qorpera-surface-coding-company:' || v_conn_id::text || ':' || v_conn_ver::text;
			v_client_hex := encode(extensions.digest(convert_to(v_seed, 'utf8'), 'sha256'), 'hex');
			v_client := (left(v_client_hex, 8) || '-' || substr(v_client_hex, 9, 4) || '-4' || substr(v_client_hex, 14, 3)
				|| '-8' || substr(v_client_hex, 18, 3) || '-' || substr(v_client_hex, 21, 12))::uuid;
			select * into v_binding
			from public.qorpera_execution_sponsor_bindings
			where profile_id = p_profile_id and client_binding_id = v_client
			for update;
			if v_binding.id is null then
				insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
				values (p_profile_id, v_client, p_owner_user_id)
				returning * into v_binding;
			elsif v_binding.status <> 'active' then
				continue;
			end if;
			select sponsor.* into v_sponsor
			from public.qorpera_execution_sponsor_versions sponsor
			where sponsor.binding_id = v_binding.id
			order by sponsor.version desc
			limit 1;
			if v_sponsor.binding_id is null
				or v_sponsor.provider_connection_version <> v_conn_ver
				or (v_allow_auto and not v_sponsor.allow_autonomous) then
				insert into public.qorpera_execution_sponsor_versions (
					binding_id, version, sponsor_kind, provider_connection_id,
					provider_connection_version, allow_autonomous, created_by_user_id
				)
				values (
					v_binding.id, coalesce(v_sponsor.version, 0) + 1, v_sponsor_kind, v_conn_id,
					v_conn_ver, v_allow_auto, p_owner_user_id
				)
				returning * into v_sponsor;
			end if;
		end if;

		return jsonb_build_object(
			'status', 'ok',
			'harness', v_harness,
			'bindingId', v_sponsor.binding_id,
			'version', v_sponsor.version
		);
	end loop;

	return jsonb_build_object('status', 'no_sponsor');
end $$;

create function public.qorpera_surface_sync_coding_completion(
	p_session public.qorpera_coding_sessions,
	p_worker public.qorpera_runtime_workers,
	p_outcome text,
	p_summary text,
	p_needs text default null,
	p_options jsonb default null,
	p_artifacts jsonb default null
)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
	v_surf_session public.qorpera_surface_sessions%rowtype;
	v_head_sha text;
	v_base_sha text;
	v_prev_sha text;
	v_question jsonb;
	v_title text;
begin
	if p_session.surface_session_id is null then
		return;
	end if;

	select * into v_surf_session
	from public.qorpera_surface_sessions
	where id = p_session.surface_session_id
	for update;

	if v_surf_session.id is null or v_surf_session.state not in ('running', 'reconciling_running') then
		return;
	end if;

	if p_session.base_sha is not null and v_surf_session.base_sha is null then
		update public.qorpera_surface_sessions
		set base_sha = p_session.base_sha, updated_at = clock_timestamp()
		where id = v_surf_session.id
		returning * into v_surf_session;
	end if;

	if p_outcome = 'succeeded' then
		if p_artifacts is not null and jsonb_typeof(p_artifacts) = 'array' and jsonb_array_length(p_artifacts) >= 1 then
			v_head_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'headSha', '')), '');
			v_base_sha := nullif(btrim(coalesce(p_artifacts -> 0 ->> 'baseSha', '')), '');
		end if;
		v_base_sha := coalesce(v_base_sha, p_session.base_sha, v_surf_session.base_sha);

		if v_head_sha ~ '^[0-9a-f]{40}$' and v_base_sha ~ '^[0-9a-f]{40}$' then
			select nullif(btrim(c.head_sha), '') into v_prev_sha
			from public.qorpera_surface_changes c
			where c.session_id = v_surf_session.id and c.head_sha is not null
			order by c.seq desc
			limit 1;
			v_prev_sha := coalesce(v_prev_sha, v_base_sha);
			if v_head_sha <> v_prev_sha then
				v_title := left(coalesce(nullif(btrim(v_surf_session.title), ''), 'Staged update'), 160);
				perform public.qorpera_record_surface_change(
					v_surf_session.id,
					v_title,
					left(btrim(coalesce(p_summary, '')), 400),
					'git_range',
					v_prev_sha,
					v_head_sha,
					'{}'::uuid[],
					'{}'::text[],
					null,
					null,
					false
				);
			end if;
		end if;

		perform public.qorpera_surface_complete_session_turn(
			v_surf_session.id,
			'ready',
			p_summary,
			null,
			null,
			case when v_head_sha ~ '^[0-9a-f]{40}$' then v_head_sha else null end,
			v_surf_session.lease_token
		);
	elsif p_outcome = 'blocked' then
		v_question := jsonb_build_object(
			'text', coalesce(nullif(btrim(coalesce(p_needs, '')), ''), 'Input needed to continue.'),
			'options', coalesce(case when jsonb_typeof(p_options) = 'array' then p_options end, '[]'::jsonb)
		);
		perform public.qorpera_surface_complete_session_turn(
			v_surf_session.id,
			'needs_input',
			p_summary,
			v_question,
			null,
			null,
			v_surf_session.lease_token
		);
	else
		perform public.qorpera_surface_complete_session_turn(
			v_surf_session.id,
			'failed',
			p_summary,
			null,
			null,
			null,
			v_surf_session.lease_token
		);
	end if;

	update public.qorpera_surface_sessions
	set wake_id = null
	where id = v_surf_session.id;
end $$;

create or replace function public.qorpera_coding_worker_targets(p_worker public.qorpera_runtime_workers)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_array(
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff', 'key', p_worker.profile_id::text || ':' || p_worker.staff_agent_id::text,
			'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', p_worker.profile_id::text || ':' || p_worker.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', p_worker.id::text, 'mode', 'nokeyupdate',
			'required', true))
	|| case when p_worker.todo_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('rank', 5,
		'tbl', 'qorpera_runtime_agent_todos', 'key', p_worker.todo_id::text, 'mode', 'nokeyupdate', 'required', false)) end
	|| case when p_worker.owner_user_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('rank', 1,
		'tbl', 'qorpera_profile_members', 'key', p_worker.profile_id::text || ':' || p_worker.owner_user_id::text, 'mode', 'keyshare',
		'required', false)) end
$$;

create or replace function public.qorpera_coding_session_claim_json(
	p_session public.qorpera_coding_sessions,
	p_worker public.qorpera_runtime_workers
)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-session-claim/v1','workerId',p_worker.id,'sequence',p_worker.sequence,
		'leaseToken',p_session.lease_token,'leaseUntil',p_session.lease_until,'profileId',p_worker.profile_id,'environmentId',p_worker.environment_id,
		'agentId',p_worker.staff_agent_id,'ownerUserId',p_worker.owner_user_id,
		'sponsor',jsonb_build_object('bindingId',p_worker.owner_sponsor_binding_id,'version',p_worker.owner_sponsor_version),
		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,
		'harnessSessionRef',p_session.harness_session_ref,'pullRequest',p_session.pull_request,'title',p_worker.title,
		'dispatch',p_worker.dispatch,'followUp',p_worker.dispatch ->> 'followUp','todoId',p_worker.todo_id)
		|| case when p_session.surface_session_id is null then '{}'::jsonb else coalesce((
			select jsonb_build_object('surfaceSession', jsonb_build_object(
				'sessionId', ss.id,
				'surfaceId', surf.id,
				'slug', surf.slug,
				'title', surf.title
			))
			from public.qorpera_surface_sessions ss
			join public.qorpera_surfaces surf on surf.id = ss.surface_id
			where ss.id = p_session.surface_session_id
		), '{}'::jsonb) end
$$;

select pg_temp.scrcs_replace('public.qorpera_folder_worker_dispatch_payload(public.qorpera_runtime_workers,public.qorpera_runtime_agent_todos)'::regprocedure, array[
	$old$		|| case when p_worker.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude', jsonb_build_object('model', p_worker.claude_model, 'effort', p_worker.claude_effort)) end$old$,
	$new$		|| case when p_worker.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude', jsonb_build_object('model', p_worker.claude_model, 'effort', p_worker.claude_effort)) end
		|| case when p_worker.surface_session_id is null then '{}'::jsonb else coalesce((
			select jsonb_build_object('surfaceSession', jsonb_build_object(
				'sessionId', ss.id,
				'surfaceId', surf.id,
				'surfaceSlug', surf.slug,
				'leaseToken', ss.lease_token
			))
			from public.qorpera_surface_sessions ss
			join public.qorpera_surfaces surf on surf.id = ss.surface_id
			where ss.id = p_worker.surface_session_id
		), '{}'::jsonb) end$new$
]);

select pg_temp.scrcs_replace('public.qorpera_worker_wake_ancestry(public.qorpera_wake_occurrences)'::regprocedure, array[
	$old$	select * into v_worker from public.qorpera_runtime_workers where id = p_wake.source_id;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;$old$,
	$new$	select * into v_worker from public.qorpera_runtime_workers where id = p_wake.source_id;
	-- 20260930855000: a surface-backed coding worker starts its own causal root with no parent run.
	if p_wake.source_kind = 'worker-dispatch' and p_wake.parent_run_id is null
		and v_worker.id is not null and v_worker.species = 'coding' and v_worker.surface_session_id is not null then
		if p_wake.wake_kind <> 'agent'
			or p_wake.trigger_id is distinct from 'worker-dispatch'
			or v_worker.profile_id is distinct from p_wake.profile_id
			or v_worker.environment_id is distinct from p_wake.environment_id
			or v_worker.staff_agent_id is distinct from p_wake.staff_agent_id
			or v_worker.owner_user_id is distinct from p_wake.requested_by_user_id
			or p_wake.file_event_id is not null
			or p_wake.session_id is not null then
			return null;
		end if;
		return public.qorpera_wake_ancestry(null, null, p_wake.staff_agent_id, p_wake.id);
	end if;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;$new$
]);

select pg_temp.scrcs_replace('public.qorpera_pin_wake_occurrence()'::regprocedure, array[
	$old$	v_surf_member_initiated boolean;$old$,
	$new$	v_surf_member_initiated boolean;
	v_surf_worker public.qorpera_runtime_workers%rowtype;$new$,
	$old$	elsif new.wake_kind = 'agent' then$old$,
	$new$	elsif new.wake_kind = 'agent' and new.source_kind = 'worker-dispatch' and new.parent_run_id is null then
		-- 20260930855000: surface-backed coding worker dispatch has no parent run; pin from the coding worker and active surface session.
		select * into v_surf_worker from public.qorpera_runtime_workers w
		where w.id = new.source_id and w.profile_id = new.profile_id and w.environment_id = new.environment_id
			and w.staff_agent_id = new.staff_agent_id and w.species = 'coding' and w.surface_session_id is not null;
		select * into v_surf_session from public.qorpera_surface_sessions s
		where s.id = v_surf_worker.surface_session_id and s.profile_id = new.profile_id
			and s.state in ('running', 'reconciling_running') and s.lease_token is not null;
		if not public.qorpera_company_is_folder_v2(new.profile_id)
			or v_surf_worker.id is null or v_surf_session.id is null
			or new.file_event_id is not null or new.run_id is not null then
			raise exception 'Wake surface coding worker is unavailable' using errcode = '42501'; end if;
		new.requested_by_user_id := v_surf_worker.owner_user_id;
		new.sponsor_binding_id := v_surf_worker.owner_sponsor_binding_id;
		new.sponsor_version := public.qorpera_live_sponsor_version(v_surf_worker.owner_sponsor_binding_id, v_surf_worker.owner_sponsor_version);
		if new.sponsor_binding_id is null or new.sponsor_version is null then
			raise exception 'No model account can pay for this work' using errcode = '42501'; end if;
		new.logical_computer_id := null;
		new.session_id := null;
		v_actor := null;
	elsif new.wake_kind = 'agent' then$new$
]);

select pg_temp.scrcs_replace('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	$old$		if not exists (select 1 from public.qorpera_execution_runs where id = p_wake.parent_run_id and profile_id = p_wake.profile_id
			and environment_id = p_wake.environment_id) then return false; end if;$old$,
	$new$		-- 20260930855000: surface-backed coding worker-dispatch has no parent run; its owner sponsor was verified above.
		if p_wake.source_kind = 'worker-dispatch' and p_wake.parent_run_id is null
			and exists (
				select 1 from public.qorpera_runtime_workers w
				join public.qorpera_surface_sessions s on s.id = w.surface_session_id and s.profile_id = w.profile_id
				where w.id = p_wake.source_id and w.species = 'coding'
					and w.profile_id = p_wake.profile_id and w.environment_id = p_wake.environment_id
					and (p_wake.run_id is not null or s.state in ('running', 'reconciling_running'))
			) then
			v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);
			return coalesce(v_ancestry ->> 'rootId' = p_wake.causal_root_id::text
				and v_ancestry -> 'agentIds' = to_jsonb(p_wake.causal_agent_ids), false);
		end if;
		if not exists (select 1 from public.qorpera_execution_runs where id = p_wake.parent_run_id and profile_id = p_wake.profile_id
			and environment_id = p_wake.environment_id) then return false; end if;$new$
]);

select pg_temp.scrcs_replace('public.qorpera_folder_materialize_company(uuid, integer)'::regprocedure, array[
	$old$			elsif v_wake.source_kind in ('office-activation', 'worker-dispatch', 'worker-completion', 'machine-event', 'machine-checkin') then -- 20260930098000$old$,
	$new$			elsif v_wake.source_kind in ('office-activation', 'worker-dispatch', 'worker-completion', 'machine-event', 'machine-checkin')
				and v_wake.parent_run_id is not null then -- 20260930098000 / 20260930855000$new$,
	$old$						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($old$,
	$new$						or (v_wake.source_kind = 'worker-dispatch' and v_wake.parent_run_id is null
							and exists (
								select 1 from public.qorpera_runtime_workers w
								join public.qorpera_surface_sessions s on s.id = w.surface_session_id and s.profile_id = w.profile_id
								where w.id = v_wake.source_id and w.species = 'coding' and w.profile_id = v_wake.profile_id
									and public.qorpera_surface_coding_member_initiated(s, v_wake.requested_by_user_id)
							))
						or (sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority($new$
]);

select pg_temp.scrcs_replace('public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure, array[
	$old$	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_surface_sessions s on s.id = w.source_id and s.profile_id = w.profile_id$old$,
	$new$	-- 20260930855000: member-initiated surface-backed coding turns bypass unattended autonomy requirements for their requester.
	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_runtime_workers rw on rw.id = w.source_id and rw.profile_id = w.profile_id
		join public.qorpera_surface_sessions s on s.id = rw.surface_session_id and s.profile_id = w.profile_id
		where w.id = p_run.source_id and (w.run_id is null or w.run_id = p_run.id) and w.wake_kind = 'agent'
			and w.source_kind = 'worker-dispatch' and w.parent_run_id is null and w.profile_id = p_run.profile_id
			and rw.species = 'coding'
			and public.qorpera_surface_coding_member_initiated(s, p_run.requested_by_user_id)
	) then return true; end if;
	if p_run.source_kind = 'wake' and exists (
		select 1 from public.qorpera_wake_occurrences w
		join public.qorpera_surface_sessions s on s.id = w.source_id and s.profile_id = w.profile_id$new$
]);

select pg_temp.scrcs_replace('public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)'::regprocedure, array[
	$old$		when not sponsor.allow_autonomous or not version.allow_autonomous
			or exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = version.connection_id and newer.version > version.version and not newer.allow_autonomous)
			then 'not_allowed_away'$old$,
	$new$		when (not sponsor.allow_autonomous or not version.allow_autonomous
			or exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = version.connection_id and newer.version > version.version and not newer.allow_autonomous))
			and not (p_worker.surface_session_id is not null and exists (
				select 1 from public.qorpera_surface_sessions s
				where s.id = p_worker.surface_session_id
					and public.qorpera_surface_coding_member_initiated(s, p_worker.owner_user_id)
			))
			then 'not_allowed_away'$new$
]);

select pg_temp.scrcs_replace('public.qorpera_authorize_coding_turn(jsonb)'::regprocedure, array[
	$old$		'pullRequest', v_session.pull_request, 'submission', (select turn.submission from public.qorpera_coding_session_turns turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence)));$old$,
	$new$		'pullRequest', v_session.pull_request,
		'surfaceSessionId', v_session.surface_session_id,
		'submission', (select turn.submission from public.qorpera_coding_session_turns turn
			where turn.worker_id = v_worker.id and turn.sequence = v_worker.sequence)));$new$
]);

create or replace function public.qorpera_begin_native_coding_execution(
	p_binding jsonb,
	p_binary_sha256 text,
	p_runtime_bundle_sha256 text,
	p_reasoning_policy_sha256 text,
	p_tool_catalog_text text,
	p_context_sha256 text,
	p_context_bytes integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_authority jsonb;
	v_catalog jsonb;
	v_is_surface boolean;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_is_surface := nullif(coalesce(v_authority #>> '{coding,surfaceSessionId}', ''), '') is not null;
	v_catalog := p_tool_catalog_text::jsonb;
	if jsonb_typeof(v_catalog -> 'tools') is distinct from 'array' then
		raise exception 'Coding catalog invalid' using errcode = '22023';
	end if;
	if jsonb_array_length(v_catalog -> 'tools') not between 4 and (case when v_is_surface then 6 else 5 end)
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool) <> jsonb_array_length(v_catalog -> 'tools')
		or exists (
			select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask')
				and not (v_is_surface and tool ->> 'name' = 'coding_record_change')
		) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501';
	end if;
	return public.qorpera_begin_native_company_execution_v2(
		p_binding, p_binary_sha256, p_runtime_bundle_sha256,
		p_reasoning_policy_sha256, p_tool_catalog_text, p_context_sha256, p_context_bytes
	);
end $$;

select pg_temp.scrcs_replace('public.qorpera_heartbeat_coding_session(uuid,uuid,integer)'::regprocedure, array[
	$old$	where worker_id = v_session.worker_id returning lease_until into v_until;
	return v_until;$old$,
	$new$	where worker_id = v_session.worker_id returning lease_until into v_until;
	-- 20260930855000: keep linked surface session lease alive while coding executor holds the turn.
	if v_session.surface_session_id is not null then
		update public.qorpera_surface_sessions
		set lease_expires_at = greatest(coalesce(lease_expires_at, clock_timestamp()), v_until + interval '5 minutes'),
			updated_at = clock_timestamp()
		where id = v_session.surface_session_id and state in ('running', 'reconciling_running');
	end if;
	return v_until;$new$
]);

select pg_temp.scrcs_replace('public.qorpera_record_coding_progress(uuid,uuid,text,text,integer,jsonb,text,text,uuid,uuid,text)'::regprocedure, array[
	$old$	if p_phase is not null then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase', p_phase)); end if;
	return public.qorpera_coding_session_view(v_session, v_worker);$old$,
	$new$	if p_phase is not null then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase', p_phase)); end if;
	-- 20260930855000: propagate initialized starter repo base_sha to the surface session and surface baseline.
	if v_session.surface_session_id is not null and v_session.base_sha is not null then
		update public.qorpera_surface_sessions
		set base_sha = coalesce(base_sha, v_session.base_sha),
			lease_expires_at = greatest(coalesce(lease_expires_at, clock_timestamp()), clock_timestamp() + interval '10 minutes'),
			updated_at = clock_timestamp()
		where id = v_session.surface_session_id and state in ('running', 'reconciling_running');
		update public.qorpera_surfaces surf
		set live_head_sha = coalesce(surf.live_head_sha, v_session.base_sha),
			updated_at = clock_timestamp()
		from public.qorpera_surface_sessions ss
		where ss.id = v_session.surface_session_id and surf.id = ss.surface_id and surf.live_head_sha is null;
	end if;
	return public.qorpera_coding_session_view(v_session, v_worker);$new$
]);

select pg_temp.scrcs_replace('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure, array[
	$old$	update public.qorpera_coding_session_turns set occurrence_id = v_occurrence,
		narrow = narrow or public.qorpera_coding_view_narrow(v_worker.id)
	where worker_id = v_worker.id and sequence = v_worker.sequence;$old$,
	$new$	update public.qorpera_coding_session_turns set occurrence_id = v_occurrence,
		narrow = narrow or public.qorpera_coding_view_narrow(v_worker.id)
	where worker_id = v_worker.id and sequence = v_worker.sequence;
	-- 20260930855000: track active coding turn wake on the linked surface session.
	if v_session.surface_session_id is not null then
		update public.qorpera_surface_sessions
		set wake_id = v_occurrence,
			lease_expires_at = greatest(coalesce(lease_expires_at, clock_timestamp()), clock_timestamp() + interval '15 minutes'),
			updated_at = clock_timestamp()
		where id = v_session.surface_session_id and state in ('running', 'reconciling_running');
	end if;$new$
]);

select pg_temp.scrcs_replace('public.qorpera_claim_coding_session(text,integer)'::regprocedure, array[
	$old$				update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(), completion_state = 'waiting', updated_at = clock_timestamp(),$old$,
	$new$				update public.qorpera_runtime_workers set state = 'failed', reported_at = clock_timestamp(),
					completion_state = case when surface_session_id is not null then 'suppressed' else 'waiting' end,
					updated_at = clock_timestamp(),$new$,
	$old$				perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				-- C1c-3i (20260930026000): the failure holds this company's rows; the next claim takes the next candidate.
				return null;$old$,
	$new$				if v_worker.todo_id is not null then
					perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
				end if;
				-- 20260930855000: surface-backed coding sessions sync executor lease expiry back to qorpera_surface_sessions.
				if v_session.surface_session_id is not null then
					select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
					perform public.qorpera_surface_sync_coding_completion(
						v_session, v_worker, 'failed',
						coalesce(v_worker.result ->> 'summary', 'The coding executor stopped responding; the workspace is kept.'),
						null, null, null
					);
				end if;
				-- C1c-3i (20260930026000): the failure holds this company's rows; the next claim takes the next candidate.
				return null;$new$,
	$old$			return public.qorpera_coding_session_claim_json(v_session, v_worker);$old$,
	$new$			if v_session.surface_session_id is not null then
				update public.qorpera_surface_sessions
				set lease_expires_at = greatest(coalesce(lease_expires_at, clock_timestamp()), v_session.lease_until + interval '5 minutes'),
					updated_at = clock_timestamp()
				where id = v_session.surface_session_id and state in ('running', 'reconciling_running');
			end if;
			return public.qorpera_coding_session_claim_json(v_session, v_worker);$new$
]);

select pg_temp.scrcs_replace('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure, array[
	$old$		or (p_artifacts is not null and (v_session.repository ->> 'host' <> 'qorpera' or p_outcome <> 'succeeded'
			or jsonb_array_length(p_artifacts) <> 1 or jsonb_typeof(p_artifacts -> 0) <> 'object'
			or (p_artifacts -> 0) - array['kind','state','branch','headSha','mainSha'] <> '{}'::jsonb
			or p_artifacts -> 0 ->> 'kind' is distinct from 'landed'
			or coalesce(p_artifacts -> 0 ->> 'state', '') not in ('fast-forward','merged','unchanged')
			or p_artifacts -> 0 ->> 'branch' is distinct from v_session.repository ->> 'baseBranch'
			or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'
			or coalesce(p_artifacts -> 0 ->> 'mainSha', '') !~ '^[0-9a-f]{40}$'))$old$,
	$new$		-- 20260930855000: surface-backed coding sessions report a 'staged' artifact on the session branch instead of landing main.
		or (p_artifacts is not null and (v_session.repository ->> 'host' <> 'qorpera' or p_outcome <> 'succeeded'
			or jsonb_array_length(p_artifacts) <> 1 or jsonb_typeof(p_artifacts -> 0) <> 'object'
			or case when v_session.surface_session_id is not null then
				(p_artifacts -> 0) - array['kind','branch','baseSha','headSha'] <> '{}'::jsonb
				or p_artifacts -> 0 ->> 'kind' is distinct from 'staged'
				or p_artifacts -> 0 ->> 'branch' is distinct from v_session.branch
				or coalesce(p_artifacts -> 0 ->> 'baseSha', '') !~ '^[0-9a-f]{40}$'
				or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'
			else
				(p_artifacts -> 0) - array['kind','state','branch','headSha','mainSha'] <> '{}'::jsonb
				or p_artifacts -> 0 ->> 'kind' is distinct from 'landed'
				or coalesce(p_artifacts -> 0 ->> 'state', '') not in ('fast-forward','merged','unchanged')
				or p_artifacts -> 0 ->> 'branch' is distinct from v_session.repository ->> 'baseBranch'
				or coalesce(p_artifacts -> 0 ->> 'headSha', '') !~ '^[0-9a-f]{40}$'
				or coalesce(p_artifacts -> 0 ->> 'mainSha', '') !~ '^[0-9a-f]{40}$'
			end))$new$,
	$old$	-- 20260930670000: the platform's own line on where the commit landed, after the session's summary (cut to fit).
	if p_artifacts is not null then$old$,
	$new$	-- 20260930670000: the platform's own line on where the commit landed, after the session's summary (cut to fit).
	-- 20260930855000: surface-backed sessions stay staged on the session branch and do not append a landing line.
	if p_artifacts is not null and p_artifacts -> 0 ->> 'kind' = 'landed' then$new$,
	$old$		-- 20260930670000: where a repository kept in Qorpera got the commit.
		|| case when p_artifacts is not null then jsonb_build_object('landed', p_artifacts -> 0) else '{}'::jsonb end$old$,
	$new$		-- 20260930670000 / 20260930855000: where a repository kept in Qorpera landed or staged the commit.
		|| case
			when p_artifacts is not null and p_artifacts -> 0 ->> 'kind' = 'staged' then jsonb_build_object('staged', p_artifacts -> 0)
			when p_artifacts is not null then jsonb_build_object('landed', p_artifacts -> 0)
			else '{}'::jsonb end$new$,
	$old$	update public.qorpera_runtime_workers set state = p_outcome, result = v_report, reported_at = clock_timestamp(),
		completion_state = 'waiting', updated_at = clock_timestamp() where id = v_worker.id returning * into v_worker;$old$,
	$new$	update public.qorpera_runtime_workers set state = p_outcome, result = v_report, reported_at = clock_timestamp(),
		completion_state = case when surface_session_id is not null then 'suppressed' else 'waiting' end,
		updated_at = clock_timestamp() where id = v_worker.id returning * into v_worker;$new$,
	$old$	perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
	return public.qorpera_coding_session_view(v_session, v_worker);$old$,
	$new$	if v_worker.todo_id is not null then
		perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
	end if;
	if v_session.surface_session_id is not null then
		perform public.qorpera_surface_sync_coding_completion(v_session, v_worker, p_outcome, v_summary, v_needs, p_options, p_artifacts);
	end if;
	return public.qorpera_coding_session_view(v_session, v_worker);$new$
]);

create or replace function public.qorpera_surface_enqueue_session_run(
	p_session_id uuid,
	p_lease_token uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_peek public.qorpera_surface_sessions%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_existing_wake public.qorpera_wake_occurrences%rowtype;
	v_cofounder public.qorpera_company_cofounders%rowtype;
	v_requester uuid;
	v_sponsor jsonb;
	v_coding_sponsor jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_member_initiated boolean;
	v_reason text;
	v_now timestamptz := clock_timestamp();
	v_targets jsonb;
	v_repo_owner text;
	v_repo_name text;
	v_repo jsonb;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_coding_session public.qorpera_coding_sessions%rowtype;
	v_harness text;
	v_title text;
	v_goal text;
	v_dispatch jsonb;
	v_followup text;
	v_conflict_paths text[];
begin
	if not public.qorpera_surfaces_enabled() then
		return jsonb_build_object('status', 'unavailable', 'reason', 'surfaces_disabled');
	end if;
	if p_session_id is null or p_lease_token is null then
		raise exception 'Session ID and lease token are required' using errcode = '22023';
	end if;

	select * into v_peek
	from public.qorpera_surface_sessions
	where id = p_session_id;
	if v_peek.id is null or v_peek.state not in ('running', 'reconciling_running')
		or v_peek.lease_token is distinct from p_lease_token then
		return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
	end if;

	select * into v_cofounder
	from public.qorpera_company_cofounders
	where profile_id = v_peek.profile_id
	limit 1;
	if v_cofounder.profile_id is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_cofounder');
	end if;

	if not public.qorpera_company_is_folder_v2(v_peek.profile_id) then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_substrate');
	end if;

	v_member_initiated := v_peek.origin_kind in ('member', 'point_to_change', 'cross_surface')
		and v_peek.created_by_user_id is not null;
	if v_member_initiated then
		select m.user_id into v_requester
		from public.qorpera_profile_members m
		where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id;
	else
		v_requester := coalesce(
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = v_peek.created_by_user_id),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id and m.user_id = v_cofounder.created_by_user_id),
			(select m.user_id from public.qorpera_profile_members m
				where m.profile_id = v_peek.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1)
		);
	end if;
	if v_requester is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_member');
	end if;

	v_targets := jsonb_build_array(
		jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_peek.profile_id::text || ':' || v_requester::text, 'mode', 'keyshare', 'required', true),
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', v_peek.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_peek.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false)
	) || case when v_peek.worker_id is null then '[]'::jsonb else jsonb_build_array(
		jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers',
			'key', v_peek.worker_id::text, 'mode', 'nokeyupdate', 'required', false)
	) end;

	begin
		perform public.qorpera_folder_company_enter(v_cofounder.environment_id, v_peek.profile_id, v_targets, true);
	exception when sqlstate '55000' then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = p_session_id
			and state in ('running', 'reconciling_running')
			and lease_token = p_lease_token;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end;

	-- WHY: Lock coding session before surface session when reusing an existing worker to match qorpera_complete_coding_turn's order.
	if v_peek.worker_id is not null then
		select * into v_coding_session
		from public.qorpera_coding_sessions
		where worker_id = v_peek.worker_id
		for update;
		select * into v_worker
		from public.qorpera_runtime_workers
		where id = v_peek.worker_id;
	end if;

	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id
	for update;
	if v_session.id is null or v_session.state not in ('running', 'reconciling_running')
		or v_session.lease_token is distinct from p_lease_token then
		return jsonb_build_object('status', 'unavailable', 'reason', 'lease_lost');
	end if;

	if public.qorpera_surface_company_paused(v_session.profile_id) then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = v_session.id;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end if;

	select * into v_surface from public.qorpera_surfaces where id = v_session.surface_id;
	if v_surface.id is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'surface_missing');
	end if;

	if v_surface.source_kind = 'code_repo' then
		if v_worker.id is not null and v_coding_session.worker_id is not null
			and v_coding_session.phase in ('queued', 'input_ready', 'preparing', 'running', 'publishing')
			and v_worker.state = 'active' then
			return jsonb_build_object(
				'status', 'enqueued',
				'wakeId', v_session.wake_id,
				'runId', null,
				'workerId', v_worker.id
			);
		end if;

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

		v_coding_sponsor := public.qorpera_surface_resolve_coding_sponsor(
			v_session.profile_id,
			v_cofounder.environment_id,
			coalesce(v_worker.owner_user_id, v_requester),
			v_member_initiated,
			v_coding_session.harness,
			v_worker.id is not null
		);
		if coalesce(v_coding_sponsor ->> 'status', '') <> 'ok' then
			return jsonb_build_object(
				'status', 'unavailable',
				'reason', coalesce(nullif(v_coding_sponsor ->> 'status', ''), 'no_sponsor')
			);
		end if;
		v_harness := v_coding_sponsor ->> 'harness';

		perform public.qorpera_coding_executor_enroll(v_cofounder.environment_id, v_harness);
		if not exists (
			select 1 from public.qorpera_coding_executors e
			where e.environment_id = v_cofounder.environment_id and e.enabled and v_harness = any(e.harnesses)
		) then
			return jsonb_build_object('status', 'unavailable', 'reason', 'no_coding_executor');
		end if;

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

		v_title := public.qorpera_surface_utf8_left(
			coalesce(nullif(btrim(regexp_replace(v_session.title, E'[\r\n]+', ' ', 'g')), ''), 'Surface session'),
			180
		);
		v_goal := public.qorpera_surface_utf8_left(
			coalesce(nullif(btrim(v_session.prompt), ''), v_title),
			2000
		);

		if v_worker.id is null then
			v_dispatch := jsonb_build_object(
				'goal', v_goal,
				'definitionOfDone', 'Commit clean, verified changes on the session branch, call coding_record_change for each deliverable, and finish with coding_finish.',
				'context', public.qorpera_surface_utf8_left(coalesce(v_surface.brief_summary, ''), 500),
				'sources', '[]'::jsonb,
				'followUp', null,
				'authority', 'Work only inside this Surface repository worktree on the session branch.',
				'output', 'Stage changes on the session branch via coding_record_change and finish with coding_finish.',
				'cancellation', 'Stop if the Surface session is cancelled or superseded.',
				'completion', 'Sync staged commits and summary back to the Surface session.'
			);

			insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			)
			values (
				v_session.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
				'surface-' || replace(v_session.id::text, '-', ''), 'coding', v_title,
				'read', 'each', v_dispatch, 'active', 1, v_requester, null,
				v_requester, (v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint,
				true, v_session.id
			)
			returning * into v_worker;

			insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
			values (v_worker.id, 1, 'dispatched', null, jsonb_build_object('surfaceSessionId', v_session.id));

			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness, v_repo,
				'qorpera/coding/' || v_worker.id::text, v_session.base_sha,
				'queued', v_session.id
			)
			returning * into v_coding_session;

			perform public.qorpera_coding_session_queue(v_worker, 'dispatch', null, null);
		else
			if v_worker.sequence >= 64 then
				return jsonb_build_object('status', 'unavailable', 'reason', 'session_turn_limit');
			end if;
			if v_worker.state = 'active' then
				perform public.qorpera_cancel_worker(v_worker, null, 'surface_superseded');
				select * into v_worker from public.qorpera_runtime_workers where id = v_worker.id;
			end if;

			if v_session.state = 'reconciling_running' then
				select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_conflict_paths
				from public.qorpera_surface_changes c, unnest(coalesce(c.conflict_paths, '{}'::text[])) as p
				where c.session_id = v_session.id and c.status = 'conflicted';
				v_followup := 'Reconcile overlapping changes on the session branch'
					|| case when coalesce(cardinality(v_conflict_paths), 0) > 0
						then ' across: ' || array_to_string(v_conflict_paths, ', ')
						else '' end
					|| '. Commit the clean resolution, record the updated change, and call coding_finish.';
			else
				select btrim(m.body) into v_followup
				from public.qorpera_surface_session_messages m
				where m.session_id = v_session.id and m.author_kind = 'member'
				order by m.created_at desc, m.id desc
				limit 1;
				if nullif(v_followup, '') is null then
					v_followup := 'Continue and complete the requested surface changes.';
				end if;
			end if;
			v_followup := public.qorpera_surface_utf8_left(v_followup, 2000);

			update public.qorpera_runtime_workers
			set
				state = 'active',
				sequence = sequence + 1,
				occurrence_id = null,
				result = null,
				reported_at = null,
				completion_state = 'none',
				completion_occurrence_id = null,
				owner_sponsor_binding_id = (v_coding_sponsor ->> 'bindingId')::uuid,
				owner_sponsor_version = (v_coding_sponsor ->> 'version')::bigint,
				dispatch = jsonb_set(dispatch, '{followUp}', to_jsonb(v_followup)),
				updated_at = v_now
			where id = v_worker.id
			returning * into v_worker;

			insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
			values (
				v_worker.id, v_worker.sequence, 'followup', null,
				jsonb_build_object('text', v_followup, 'surfaceSessionId', v_session.id)
					|| case when v_member_initiated then jsonb_build_object('byUserId', v_requester) else '{}'::jsonb end
			);

			update public.qorpera_coding_sessions
			set
				phase = 'input_ready',
				finished_at = null,
				lease_owner = null,
				lease_token = null,
				lease_until = null,
				claim_after = null,
				updated_at = v_now
			where worker_id = v_worker.id
			returning * into v_coding_session;

			perform public.qorpera_coding_event(
				v_worker.id, v_worker.sequence, 'input',
				case when v_member_initiated then 'member' else 'agent' end,
				jsonb_build_object('text', v_followup)
			);
			perform public.qorpera_open_coding_turn(
				v_worker,
				case when v_member_initiated then 'member' else 'agent' end,
				v_followup,
				case when v_member_initiated then v_requester end,
				null
			);
		end if;

		update public.qorpera_surface_sessions
		set
			worker_id = v_worker.id,
			wake_id = null,
			lease_expires_at = greatest(coalesce(lease_expires_at, v_now), v_now + interval '10 minutes'),
			updated_at = v_now
		where id = v_session.id;

		return jsonb_build_object(
			'status', 'enqueued',
			'wakeId', null,
			'runId', null,
			'workerId', v_worker.id
		);
	end if;

	if v_session.wake_id is not null then
		select * into v_existing_wake from public.qorpera_wake_occurrences where id = v_session.wake_id;
		if v_existing_wake.id is not null and v_existing_wake.status in ('queued', 'materialized') then
			return jsonb_build_object(
				'status', 'enqueued',
				'wakeId', v_existing_wake.id,
				'runId', v_existing_wake.run_id
			);
		end if;
	end if;

	v_sponsor := public.qorpera_surface_resolve_sponsor(v_session.profile_id, v_requester);
	if v_sponsor is null
		or nullif(v_sponsor ->> 'sponsorBindingId', '') is null
		or nullif(v_sponsor ->> 'sponsorVersion', '') is null then
		return jsonb_build_object('status', 'unavailable', 'reason', 'no_sponsor');
	end if;

	begin
		perform public.qorpera_folder_admit_wakes(v_session.profile_id);
		insert into public.qorpera_wake_occurrences(
			id, profile_id, environment_id, wake_kind, source_kind, source_id,
			trigger_id, occurrence_key, scheduled_for, not_before
		)
		values (
			extensions.gen_random_uuid(),
			v_session.profile_id,
			v_cofounder.environment_id,
			'agent',
			'surface-session',
			v_session.id,
			'surface-session',
			'surface-session:' || v_session.id::text || ':' || p_lease_token::text,
			v_now,
			v_now
		)
		returning * into v_wake;
	exception when insufficient_privilege then
		v_reason := case
			when sqlerrm = 'No model account can pay for this work' then 'no_sponsor'
			when sqlerrm = 'Wake surface session requester is unavailable' then 'no_member'
			when sqlerrm = 'Wake surface session is unavailable' then 'session_unavailable'
			else 'unavailable'
		end;
		return jsonb_build_object('status', 'unavailable', 'reason', v_reason);
	end;

	if v_wake.status <> 'queued' then
		update public.qorpera_surface_sessions
		set
			state = case when state = 'reconciling_running' then 'reconciling' else 'queued' end,
			lease_token = null,
			wake_id = null,
			lease_expires_at = v_now + interval '15 seconds',
			updated_at = v_now
		where id = v_session.id;
		return jsonb_build_object('status', 'deferred', 'reason', 'paused', 'retryAfterSeconds', 15);
	end if;

	update public.qorpera_surface_sessions
	set
		wake_id = v_wake.id,
		lease_expires_at = greatest(coalesce(lease_expires_at, v_now), v_now + interval '10 minutes'),
		updated_at = v_now
	where id = v_session.id;

	return jsonb_build_object(
		'status', 'enqueued',
		'wakeId', v_wake.id,
		'runId', v_wake.run_id
	);
end $$;

select pg_temp.scrcs_replace('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure, array[
	$old$			where s.state in ('running', 'reconciling_running')
				and ($old$,
	$new$			where s.state in ('running', 'reconciling_running')
				and not exists (
					select 1 from public.qorpera_coding_sessions cs
					where cs.worker_id = s.worker_id
						and cs.phase in ('queued', 'input_ready', 'preparing', 'running', 'publishing')
				)
				and ($new$
]);

select pg_temp.scrcs_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure, array[
	$old$/* 20260930817000 */'narrate_app',$old$,
	$new$/* 20260930817000 */'narrate_app',/* 20260930855000 */'coding_record_change','propose_surface','start_surface_session','stage_surface_patch','stage_surface_ops_action','manage_surface_automation','surface_reply','surface_ask',$new$
]);

revoke all on function
	public.qorpera_surface_utf8_left(text, integer),
	public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions, uuid),
	public.qorpera_surface_resolve_coding_sponsor(uuid, uuid, uuid, boolean, text, boolean),
	public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions, public.qorpera_runtime_workers, text, text, text, jsonb, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_pin_wake_occurrence()'::regprocedure,
			'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
			'public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
			'public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)'::regprocedure,
			'public.qorpera_worker_wake_ancestry(public.qorpera_wake_occurrences)'::regprocedure,
			'public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions,public.qorpera_runtime_workers)'::regprocedure,
			'public.qorpera_folder_worker_dispatch_payload(public.qorpera_runtime_workers,public.qorpera_runtime_agent_todos)'::regprocedure,
			'public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)'::regprocedure,
			'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
			'public.qorpera_heartbeat_coding_session(uuid,uuid,integer)'::regprocedure,
			'public.qorpera_record_coding_progress(uuid,uuid,text,text,integer,jsonb,text,text,uuid,uuid,text)'::regprocedure,
			'public.qorpera_claim_coding_session(text,integer)'::regprocedure,
			'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Surface coding integration function has an API owner: %', v_owner;
		end if;
		execute format('grant select, insert, update on public.qorpera_surface_sessions, public.qorpera_surfaces, public.qorpera_surface_changes, public.qorpera_surface_session_messages to %I', v_owner);
		execute format('grant execute on function public.qorpera_surface_coding_member_initiated(public.qorpera_surface_sessions, uuid), public.qorpera_surface_sync_coding_completion(public.qorpera_coding_sessions, public.qorpera_runtime_workers, text, text, text, jsonb, jsonb) to %I', v_owner);
	end loop;
end $$;

drop function pg_temp.scrcs_replace(regprocedure, text[]);
