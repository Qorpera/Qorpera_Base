-- WHY: A code interface whose .qorpera/checks.json names a real preview recipe is built by the platform, in a coding
-- VM of a builder coding session per (interface, member); previews and publishes park while the build runs, share one
-- build per (tree, recipe), and fail with a bounded build log the owning session can be handed.

set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)') is null
		or to_regprocedure('public.qorpera_claim_coding_session(text,integer)') is null
		or to_regprocedure('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)') is null
		or to_regprocedure('public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)') is null
		or to_regprocedure('public.qorpera_surface_preview_composition_key(uuid,text,uuid[],uuid)') is null
		or to_regprocedure('public.qorpera_surface_cancel_coding_workers(uuid[],text)') is null then
		raise exception 'Surface preview builds (20260930876000) requires 20260930857000, 20260930860000 and 20260930875000 first';
	end if;
	if to_regclass('public.qorpera_surface_preview_builds') is not null then
		raise exception 'Surface preview builds (20260930876000) is already applied';
	end if;
end $$;

create function pg_temp.spb_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930876000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930876000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

create table public.qorpera_surface_preview_builders (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	member_user_id uuid references auth.users(id) on delete set null,
	worker_id uuid unique references public.qorpera_runtime_workers(id) on delete set null,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	unique (surface_id, member_user_id)
);
alter table public.qorpera_surface_preview_builders enable row level security;
revoke all on public.qorpera_surface_preview_builders from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_surface_preview_builds (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	surface_id uuid not null references public.qorpera_surfaces(id) on delete cascade,
	builder_id uuid not null references public.qorpera_surface_preview_builders(id) on delete cascade,
	repository_key text not null check (char_length(repository_key) between 1 and 200),
	commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
	tree_sha text not null check (tree_sha ~ '^[0-9a-f]{40}$'),
	recipe jsonb not null check (jsonb_typeof(recipe) = 'object'),
	recipe_sha256 text not null check (recipe_sha256 ~ '^[0-9a-f]{64}$'),
	state text not null default 'queued' check (state in ('queued', 'running', 'built', 'failed', 'dropped')),
	built_tree_sha text check (built_tree_sha is null or built_tree_sha ~ '^[0-9a-f]{40}$'),
	error_detail text check (error_detail is null or char_length(error_detail) <= 1000),
	worker_id uuid,
	worker_sequence integer,
	attempts integer not null default 0 check (attempts >= 0),
	queued_at timestamptz not null default clock_timestamp(),
	started_at timestamptz,
	finished_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check ((state = 'built') = (built_tree_sha is not null)),
	check ((state = 'running') = (worker_id is not null and started_at is not null)),
	unique (surface_id, tree_sha, recipe_sha256)
);
create index qorpera_surface_preview_builds_builder on public.qorpera_surface_preview_builds(builder_id, state, queued_at)
	where state in ('queued', 'running');
create index qorpera_surface_preview_builds_running on public.qorpera_surface_preview_builds(profile_id)
	where state = 'running';
alter table public.qorpera_surface_preview_builds enable row level security;
revoke all on public.qorpera_surface_preview_builds from public, anon, authenticated, service_role, qorpera_secret_broker;

alter table public.qorpera_surface_previews
	add column build_id uuid references public.qorpera_surface_preview_builds(id) on delete set null,
	add column requested_by_user_id uuid references auth.users(id) on delete set null;
create index qorpera_surface_previews_build on public.qorpera_surface_previews(build_id) where build_id is not null;

alter table public.qorpera_surface_jobs
	add column build_id uuid references public.qorpera_surface_preview_builds(id) on delete set null;
create index qorpera_surface_jobs_build on public.qorpera_surface_jobs(build_id) where build_id is not null;

create function public.qorpera_surface_preview_requester()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'authenticated' or auth.uid() is null then
		return new;
	end if;
	if tg_op = 'INSERT' then
		new.requested_by_user_id := auth.uid();
	elsif new.expires_at > old.expires_at then
		new.requested_by_user_id := auth.uid();
	end if;
	return new;
end $$;

create trigger qorpera_surface_previews_requester before insert or update on public.qorpera_surface_previews
	for each row execute function public.qorpera_surface_preview_requester();

create function public.qorpera_surface_preview_path_valid(p_path text)
returns boolean language sql immutable set search_path = '' as $$
	select p_path = '.' or (
		octet_length(p_path) between 1 and 300
		and p_path !~ '[[:cntrl:]\\]'
		and ('/' || p_path || '/') !~ '/\.{0,2}/'
	)
$$;

create function public.qorpera_surface_preview_recipe_valid(p_recipe jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
	if jsonb_typeof(p_recipe) is distinct from 'object'
		or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_recipe) k)
			is distinct from array['cwd', 'folder', 'run', 'timeoutSeconds']
		or jsonb_typeof(p_recipe -> 'run') <> 'string'
		or jsonb_typeof(p_recipe -> 'cwd') <> 'string'
		or jsonb_typeof(p_recipe -> 'folder') <> 'string'
		or jsonb_typeof(p_recipe -> 'timeoutSeconds') <> 'number' then
		return false;
	end if;
	if btrim(p_recipe ->> 'run') = '' or octet_length(p_recipe ->> 'run') > 4096
		or not public.qorpera_surface_preview_path_valid(p_recipe ->> 'cwd')
		or not public.qorpera_surface_preview_path_valid(p_recipe ->> 'folder')
		or (p_recipe ->> 'timeoutSeconds') !~ '^[0-9]{2,3}$' then
		return false;
	end if;
	return (p_recipe ->> 'timeoutSeconds')::integer between 10 and 600;
end $$;

create function public.qorpera_surface_preview_build_detail(p_code text, p_text text)
returns text language sql immutable set search_path = '' as $$
	select left(p_code || E'\n' || coalesce(p_text, ''), 1000)
$$;

create function public.qorpera_surface_is_preview_builder(p_worker_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_surface_preview_builders b where b.worker_id = p_worker_id)
$$;

create function public.qorpera_surface_preview_selected(p_preview_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_surface_previews p
		join public.qorpera_surfaces surf on surf.id = p.surface_id
		join public.qorpera_member_surface_state ms on ms.surface_id = p.surface_id
		where p.id = p_preview_id
			and (
				(
					(cardinality(coalesce(ms.toggled_change_ids, '{}'::uuid[])) > 0 or ms.active_exploration_session_id is not null)
					and p.composition_key = public.qorpera_surface_preview_composition_key(
						surf.id, surf.live_head_sha, coalesce(ms.toggled_change_ids, '{}'::uuid[]), ms.active_exploration_session_id
					)
				)
				or exists (
					select 1
					from unnest(coalesce(ms.compare_session_ids, '{}'::uuid[])) as csid
					where cardinality(coalesce(ms.compare_session_ids, '{}'::uuid[])) >= 2
						and p.composition_key = public.qorpera_surface_preview_composition_key(
							surf.id, surf.live_head_sha, coalesce(ms.toggled_change_ids, '{}'::uuid[]), csid
						)
				)
			)
	)
$$;

-- WHY: Every preview row and publish job parked on a build follows its outcome: built wakes them for the lane, failed
-- fails them with the build's detail, dropped expires the previews no one selects any more.
create function public.qorpera_surface_preview_build_settle(p_build_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_job public.qorpera_surface_jobs%rowtype;
begin
	select * into v_build from public.qorpera_surface_preview_builds where id = p_build_id;
	if v_build.id is null or v_build.state in ('queued', 'running') then
		return;
	end if;

	if v_build.state = 'failed' then
		update public.qorpera_surface_previews
		set status = 'failed', error_detail = v_build.error_detail, lease_expires_at = null, lease_token = null, updated_at = v_now
		where build_id = v_build.id and status = 'building' and lease_token is null;
	else
		update public.qorpera_surface_previews p
		set
			status = 'composing',
			attempts = 0,
			lease_expires_at = null,
			lease_token = null,
			expires_at = case when public.qorpera_surface_preview_selected(p.id) then p.expires_at else least(p.expires_at, v_now) end,
			updated_at = v_now
		where p.build_id = v_build.id and p.status = 'building' and p.lease_token is null;
	end if;

	for v_job in
		select * from public.qorpera_surface_jobs
		where build_id = v_build.id and kind = 'publish_surface' and status = 'running' and lease_token is null
		for update
	loop
		if v_build.state = 'built' then
			update public.qorpera_surface_jobs
			set status = 'queued', attempts = 0, lease_expires_at = null, updated_at = v_now
			where id = v_job.id;
		else
			update public.qorpera_surfaces
			set
				publish_status = 'failed',
				last_publish_error = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				updated_at = v_now
			where id = v_job.surface_id;
			update public.qorpera_surface_jobs
			set
				status = 'failed',
				error_detail = coalesce(v_build.error_detail,
					public.qorpera_surface_preview_build_detail('PREVIEW_BUILD_FAILED', 'The build was dropped.')),
				lease_expires_at = null,
				completed_at = v_now,
				updated_at = v_now
			where id = v_job.id;
		end if;
	end loop;
end $$;

create function public.qorpera_surface_preview_build_fail(p_build_id uuid, p_detail text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	update public.qorpera_surface_preview_builds
	set state = 'failed', error_detail = left(p_detail, 1000), built_tree_sha = null, worker_id = null, worker_sequence = null,
		started_at = null, finished_at = clock_timestamp(), updated_at = clock_timestamp()
	where id = p_build_id and state in ('queued', 'running');
	if found then
		perform public.qorpera_surface_preview_build_settle(p_build_id);
	end if;
end $$;

-- WHY: The builder's coding worker (no model ever runs on it) is made on first use, then woken for a new turn each time
-- a build waits and it stands idle; an active worker picks the next queued build at its next turn.
create function public.qorpera_surface_preview_builder_kick(p_builder_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_cofounder public.qorpera_company_cofounders%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_sponsor jsonb;
	v_harness text;
	v_repo jsonb;
	v_repo_owner text;
	v_repo_name text;
	v_targets jsonb;
	v_now timestamptz := clock_timestamp();
	v_text constant text := 'Build the interface preview.';
begin
	select * into v_builder from public.qorpera_surface_preview_builders where id = p_builder_id for update;
	if v_builder.id is null then
		return 'no_builder';
	end if;
	if v_builder.worker_id is not null then
		select * into v_worker from public.qorpera_runtime_workers where id = v_builder.worker_id;
		if v_worker.state = 'active' then
			return 'ok';
		end if;
	end if;
	select * into v_surface from public.qorpera_surfaces where id = v_builder.surface_id;
	if v_surface.id is null or v_surface.status = 'archived' then
		return 'surface_missing';
	end if;
	select * into v_cofounder from public.qorpera_company_cofounders where profile_id = v_builder.profile_id limit 1;
	if v_cofounder.profile_id is null then
		return 'no_cofounder';
	end if;
	if not public.qorpera_company_is_folder_v2(v_builder.profile_id) then
		return 'no_substrate';
	end if;
	if not exists (
		select 1 from public.qorpera_profile_members m
		where m.profile_id = v_builder.profile_id and m.user_id = v_builder.member_user_id
	) then
		return 'no_member';
	end if;

	v_targets := jsonb_build_array(
		jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_builder.profile_id::text || ':' || v_builder.member_user_id::text, 'mode', 'keyshare', 'required', true),
		jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
			'key', v_builder.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false),
		jsonb_build_object('rank', 3, 'tbl', 'qorpera_staff_execution_authorities',
			'key', v_builder.profile_id::text || ':' || v_cofounder.staff_agent_id::text, 'mode', 'keyshare', 'required', false)
	) || case when v_worker.id is null then '[]'::jsonb else jsonb_build_array(
		jsonb_build_object('rank', 5, 'tbl', 'qorpera_runtime_workers', 'key', v_worker.id::text, 'mode', 'nokeyupdate', 'required', false)
	) end;
	begin
		perform public.qorpera_folder_company_enter(v_cofounder.environment_id, v_builder.profile_id, v_targets, true);
	exception when sqlstate '55000' then
		return 'paused';
	end;

	if v_surface.repository_key is not null and position('/' in v_surface.repository_key) > 0 then
		v_repo_owner := lower(btrim(split_part(v_surface.repository_key, '/', 1)));
		v_repo_name := lower(btrim(split_part(v_surface.repository_key, '/', 2)));
	else
		v_repo_owner := 'surfaces';
		v_repo_name := lower(v_surface.slug);
	end if;
	v_repo := jsonb_build_object('host', 'qorpera', 'owner', v_repo_owner, 'name', v_repo_name, 'baseBranch', 'main');
	if not public.qorpera_coding_repository_valid(v_repo) then
		return 'invalid_repository';
	end if;

	v_sponsor := public.qorpera_surface_resolve_coding_sponsor(
		v_builder.profile_id, v_cofounder.environment_id, v_builder.member_user_id, true,
		(select cs.harness from public.qorpera_coding_sessions cs where cs.worker_id = v_worker.id),
		v_worker.id is not null
	);
	if coalesce(v_sponsor ->> 'status', '') <> 'ok' then
		return coalesce(nullif(v_sponsor ->> 'status', ''), 'no_sponsor');
	end if;
	v_harness := v_sponsor ->> 'harness';
	perform public.qorpera_coding_executor_enroll(v_cofounder.environment_id, v_harness);
	if not exists (
		select 1 from public.qorpera_coding_executors e
		where e.environment_id = v_cofounder.environment_id and e.enabled and v_harness = any(e.harnesses)
	) then
		return 'no_coding_executor';
	end if;
	insert into public.qorpera_coding_repository_grants(environment_id, staff_agent_id, repository, enabled)
	values (v_cofounder.environment_id, v_cofounder.staff_agent_id, v_repo, true)
	on conflict (environment_id, staff_agent_id, repository) do nothing;
	if exists (
		select 1 from public.qorpera_coding_repository_grants g
		where g.environment_id = v_cofounder.environment_id and g.staff_agent_id = v_cofounder.staff_agent_id
			and g.repository = v_repo and not g.enabled
	) then
		return 'repository_disabled';
	end if;

	if v_worker.id is null then
		insert into public.qorpera_runtime_workers(
			profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
			access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
			owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
			surface_backed, surface_session_id
		)
		values (
			v_builder.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
			'surface-build-' || replace(v_builder.id::text, '-', ''), 'coding', 'Interface preview builds',
			'read', 'each',
			jsonb_build_object(
				'kind', 'surface-preview-build',
				'surfaceId', v_surface.id,
				'goal', 'Build previews of this interface from its preview recipe.',
				'definitionOfDone', 'The platform runs the build; no model works in this session.',
				'context', '',
				'sources', '[]'::jsonb,
				'followUp', null
			),
			'active', 1, v_builder.member_user_id, null,
			v_builder.member_user_id, (v_sponsor ->> 'bindingId')::uuid, (v_sponsor ->> 'version')::bigint,
			true, null
		)
		returning * into v_worker;
		insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
		values (v_worker.id, 1, 'dispatched', null, jsonb_build_object('surfaceId', v_surface.id, 'previewBuilder', true));
		insert into public.qorpera_coding_sessions(
			worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha, phase, surface_session_id
		)
		values (
			v_worker.id, v_builder.profile_id, v_cofounder.environment_id, null, v_harness, v_repo,
			'qorpera/coding/' || v_worker.id::text, null, 'queued', null
		);
		perform public.qorpera_coding_session_queue(v_worker, 'dispatch', null, null);
		update public.qorpera_surface_preview_builders set worker_id = v_worker.id, updated_at = v_now where id = v_builder.id;
		return 'ok';
	end if;

	update public.qorpera_runtime_workers
	set
		state = 'active',
		sequence = sequence + 1,
		occurrence_id = null,
		result = null,
		reported_at = null,
		completion_state = 'none',
		completion_occurrence_id = null,
		owner_sponsor_binding_id = (v_sponsor ->> 'bindingId')::uuid,
		owner_sponsor_version = (v_sponsor ->> 'version')::bigint,
		updated_at = v_now
	where id = v_worker.id
	returning * into v_worker;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'followup', null, jsonb_build_object('text', v_text, 'previewBuilder', true));
	update public.qorpera_coding_sessions
	set phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null,
		claim_after = null, updated_at = v_now
	where worker_id = v_worker.id;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'input', 'agent', jsonb_build_object('text', v_text));
	perform public.qorpera_open_coding_turn(v_worker, 'agent', v_text, null, null);
	update public.qorpera_surface_preview_builders set updated_at = v_now where id = v_builder.id;
	return 'ok';
end $$;

create function public.qorpera_surface_preview_kick_failed(p_builder_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_build_id uuid;
begin
	if p_reason in ('ok', 'paused') then
		return;
	end if;
	for v_build_id in
		select b.id from public.qorpera_surface_preview_builds b
		where b.builder_id = p_builder_id and b.state = 'queued'
		order by b.queued_at, b.id
		for update
	loop
		perform public.qorpera_surface_preview_build_fail(v_build_id, public.qorpera_surface_preview_build_detail(
			'PREVIEW_BUILD_FAILED',
			case p_reason
				when 'no_sponsor' then 'No AI model account of the member who asked can run coding sessions, so no machine could be opened for the build.'
				when 'no_coding_executor' then 'No coding service runs for this company, so no machine could be opened for the build.'
				when 'surface_missing' then 'The interface was deleted.'
				else 'No machine could be opened for the build (' || p_reason || ').'
			end
		));
	end loop;
end $$;

-- WHY: One build per (interface, tree, recipe): the first ask queues it on the asker's builder, later asks share it, a
-- failed or dropped build is queued again, and the asker's other queued builds that only unselected previews wait on are
-- dropped so toggling never stacks builds.
create function public.qorpera_surface_request_build(
	p_kind text,
	p_id uuid,
	p_lease_token uuid,
	p_commit_sha text,
	p_tree_sha text,
	p_recipe jsonb,
	p_stale_built_tree text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_preview public.qorpera_surface_previews%rowtype;
	v_job public.qorpera_surface_jobs%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_member uuid;
	v_recipe_sha text;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_old public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_kick text;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Surface code host authority required' using errcode = '42501';
	end if;
	if p_kind not in ('preview', 'publish') or p_id is null or p_lease_token is null
		or coalesce(p_commit_sha, '') !~ '^[0-9a-f]{40}$' or coalesce(p_tree_sha, '') !~ '^[0-9a-f]{40}$'
		or not public.qorpera_surface_preview_recipe_valid(p_recipe)
		or (p_stale_built_tree is not null and p_stale_built_tree !~ '^[0-9a-f]{40}$') then
		raise exception 'Surface build request is invalid' using errcode = '22023';
	end if;

	if p_kind = 'preview' then
		select * into v_preview from public.qorpera_surface_previews where id = p_id for update;
		if v_preview.id is null or v_preview.status <> 'building' or v_preview.lease_token is distinct from p_lease_token then
			raise exception 'Preview lease mismatch' using errcode = '55000';
		end if;
		select * into v_surface from public.qorpera_surfaces where id = v_preview.surface_id;
		v_member := v_preview.requested_by_user_id;
	else
		select * into v_job from public.qorpera_surface_jobs where id = p_id for update;
		if v_job.id is null or v_job.kind <> 'publish_surface' or v_job.status <> 'running'
			or v_job.lease_token is distinct from p_lease_token then
			raise exception 'Surface job lease mismatch' using errcode = '55000';
		end if;
		select * into v_surface from public.qorpera_surfaces where id = v_job.surface_id;
		v_member := v_job.requested_by_user_id;
	end if;
	if v_surface.id is null or v_surface.source_kind <> 'code_repo' then
		raise exception 'Surface is not a code interface' using errcode = '22023';
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m where m.profile_id = v_surface.profile_id and m.user_id = v_member
	) then
		v_member := v_surface.created_by_user_id;
	end if;
	if v_member is null or not exists (
		select 1 from public.qorpera_profile_members m where m.profile_id = v_surface.profile_id and m.user_id = v_member
	) then
		select m.user_id into v_member from public.qorpera_profile_members m
		where m.profile_id = v_surface.profile_id order by (m.role = 'owner') desc, m.joined_at asc limit 1;
	end if;
	if v_member is null then
		raise exception 'No member can build this interface' using errcode = '42501';
	end if;

	v_recipe_sha := encode(extensions.digest(convert_to(p_recipe::text, 'utf8'), 'sha256'), 'hex');
	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.surface-build:' || v_surface.id::text, 0));

	select * into v_build from public.qorpera_surface_preview_builds
	where surface_id = v_surface.id and tree_sha = p_tree_sha and recipe_sha256 = v_recipe_sha
	for update;

	if v_build.id is not null and v_build.state = 'built'
		and (p_stale_built_tree is null or v_build.built_tree_sha is distinct from p_stale_built_tree) then
		if p_kind = 'preview' then
			update public.qorpera_surface_previews set build_id = v_build.id where id = v_preview.id;
		else
			update public.qorpera_surface_jobs set build_id = v_build.id where id = v_job.id;
		end if;
		return jsonb_build_object('state', 'built', 'buildId', v_build.id, 'builtTreeSha', v_build.built_tree_sha);
	end if;

	insert into public.qorpera_surface_preview_builders(profile_id, surface_id, member_user_id)
	values (v_surface.profile_id, v_surface.id, v_member)
	on conflict (surface_id, member_user_id) do nothing;
	select * into v_builder from public.qorpera_surface_preview_builders
	where surface_id = v_surface.id and member_user_id = v_member;

	if v_build.id is null then
		insert into public.qorpera_surface_preview_builds(
			profile_id, surface_id, builder_id, repository_key, commit_sha, tree_sha, recipe, recipe_sha256
		)
		values (
			v_surface.profile_id, v_surface.id, v_builder.id, coalesce(v_surface.repository_key, 'surfaces/' || lower(v_surface.slug)),
			p_commit_sha, p_tree_sha, p_recipe, v_recipe_sha
		)
		returning * into v_build;
	elsif v_build.state in ('built', 'failed', 'dropped') then
		update public.qorpera_surface_preview_builds
		set state = 'queued', builder_id = v_builder.id, commit_sha = p_commit_sha, built_tree_sha = null, error_detail = null,
			worker_id = null, worker_sequence = null, attempts = 0, queued_at = v_now, started_at = null, finished_at = null,
			updated_at = v_now
		where id = v_build.id
		returning * into v_build;
	end if;

	if p_kind = 'preview' then
		update public.qorpera_surface_previews
		set build_id = v_build.id, lease_token = null, lease_expires_at = null, error_detail = null, updated_at = v_now
		where id = v_preview.id;
	else
		update public.qorpera_surface_jobs
		set build_id = v_build.id, lease_token = null, lease_expires_at = null, updated_at = v_now
		where id = v_job.id;
	end if;

	for v_old in
		select * from public.qorpera_surface_preview_builds b
		where b.builder_id = v_build.builder_id and b.state = 'queued' and b.id <> v_build.id
		order by b.queued_at, b.id
		for update skip locked
	loop
		if not exists (
			select 1 from public.qorpera_surface_jobs j
			where j.build_id = v_old.id and j.kind = 'publish_surface' and j.status = 'running' and j.lease_token is null
		) and not exists (
			select 1 from public.qorpera_surface_previews p
			where p.build_id = v_old.id and p.status = 'building' and p.lease_token is null
				and public.qorpera_surface_preview_selected(p.id)
		) then
			update public.qorpera_surface_preview_builds
			set state = 'dropped', finished_at = v_now, updated_at = v_now
			where id = v_old.id;
			perform public.qorpera_surface_preview_build_settle(v_old.id);
		end if;
	end loop;

	if v_build.state = 'queued' then
		select * into v_builder from public.qorpera_surface_preview_builders where id = v_build.builder_id;
		v_kick := public.qorpera_surface_preview_builder_kick(v_builder.id);
		perform public.qorpera_surface_preview_kick_failed(v_builder.id, v_kick);
		select * into v_build from public.qorpera_surface_preview_builds where id = v_build.id;
		if v_build.state = 'failed' then
			return jsonb_build_object('state', 'failed', 'buildId', v_build.id, 'errorDetail', v_build.error_detail);
		end if;
	end if;
	return jsonb_build_object('state', 'waiting', 'buildId', v_build.id);
end $$;

-- WHY: A builder turn takes its build only once its machine is ready, at most two builds run per company, and a company
-- out of computer hours fails its waiting builds instead of holding them.
create function public.qorpera_begin_surface_preview_build(p_worker_id uuid, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_surface public.qorpera_surfaces%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_id uuid;
begin
	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into v_builder from public.qorpera_surface_preview_builders where worker_id = p_worker_id for update;
	if v_builder.id is null then
		raise exception 'Coding session is not a preview builder' using errcode = '42501';
	end if;
	if v_session.phase <> 'preparing' or v_worker.state <> 'active' then
		raise exception 'Preview build turn is not preparing' using errcode = '55000';
	end if;

	update public.qorpera_surface_preview_builds
	set state = 'queued', worker_id = null, worker_sequence = null, started_at = null, queued_at = v_now, updated_at = v_now
	where builder_id = v_builder.id and state = 'running';

	select * into v_surface from public.qorpera_surfaces where id = v_builder.surface_id;
	if v_surface.id is null or v_surface.status = 'archived' then
		for v_id in select id from public.qorpera_surface_preview_builds
			where builder_id = v_builder.id and state = 'queued' for update loop
			update public.qorpera_surface_preview_builds set state = 'dropped', finished_at = v_now, updated_at = v_now where id = v_id;
			perform public.qorpera_surface_preview_build_settle(v_id);
		end loop;
		return jsonb_build_object('state', 'none');
	end if;

	if public.qorpera_company_coding_at_zero(v_builder.profile_id, v_now) then
		for v_id in select id from public.qorpera_surface_preview_builds
			where builder_id = v_builder.id and state = 'queued' order by queued_at, id for update loop
			perform public.qorpera_surface_preview_build_fail(v_id, public.qorpera_surface_preview_build_detail(
				'PREVIEW_BUILD_NO_HOURS', 'The company has no computer hours left, so the build did not run.'));
		end loop;
		return jsonb_build_object('state', 'none');
	end if;

	select * into v_build from public.qorpera_surface_preview_builds
	where builder_id = v_builder.id and state = 'queued'
	order by queued_at, id
	limit 1
	for update skip locked;
	if v_build.id is null then
		return jsonb_build_object('state', 'none');
	end if;

	perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('qorpera.surface-builds-running:' || v_builder.profile_id::text, 0));
	if (select count(*) from public.qorpera_surface_preview_builds b
		where b.profile_id = v_builder.profile_id and b.state = 'running') >= 2 then
		return jsonb_build_object('state', 'wait');
	end if;

	update public.qorpera_surface_preview_builds
	set state = 'running', worker_id = v_worker.id, worker_sequence = v_worker.sequence, started_at = v_now,
		attempts = attempts + 1, updated_at = v_now
	where id = v_build.id
	returning * into v_build;

	return jsonb_build_object(
		'state', 'build',
		'build', jsonb_build_object(
			'buildId', v_build.id,
			'surfaceId', v_build.surface_id,
			'repositoryKey', v_build.repository_key,
			'commitSha', v_build.commit_sha,
			'treeSha', v_build.tree_sha,
			'recipe', v_build.recipe,
			'attempt', v_build.attempts
		)
	);
end $$;

create function public.qorpera_complete_surface_preview_build(
	p_worker_id uuid,
	p_lease_token uuid,
	p_build_id uuid,
	p_outcome text,
	p_built_tree_sha text default null,
	p_error_detail text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_worker public.qorpera_runtime_workers%rowtype;
	v_session public.qorpera_coding_sessions%rowtype;
	v_builder public.qorpera_surface_preview_builders%rowtype;
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_now timestamptz := clock_timestamp();
	v_kick text;
begin
	if p_outcome not in ('built', 'failed', 'none')
		or (p_outcome = 'none') <> (p_build_id is null)
		or (p_outcome = 'built') <> (p_built_tree_sha is not null)
		or (p_built_tree_sha is not null and p_built_tree_sha !~ '^[0-9a-f]{40}$')
		or (p_outcome = 'failed') <> (p_error_detail is not null)
		or (p_error_detail is not null and (char_length(p_error_detail) > 1000 or p_error_detail !~ '^PREVIEW_BUILD_[A-Z_]{1,40}\n')) then
		raise exception 'Preview build result is invalid' using errcode = '22023';
	end if;
	v_worker := public.qorpera_lock_coding_worker(p_worker_id);
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into v_builder from public.qorpera_surface_preview_builders where worker_id = p_worker_id for update;
	if v_builder.id is null then
		raise exception 'Coding session is not a preview builder' using errcode = '42501';
	end if;

	if p_build_id is not null then
		select * into v_build from public.qorpera_surface_preview_builds where id = p_build_id for update;
		if v_build.id is null or v_build.builder_id <> v_builder.id or v_build.state <> 'running'
			or v_build.worker_id is distinct from p_worker_id or v_build.worker_sequence is distinct from v_worker.sequence then
			raise exception 'Preview build is not running in this turn' using errcode = '55000';
		end if;
		if p_outcome = 'built' then
			update public.qorpera_surface_preview_builds
			set state = 'built', built_tree_sha = p_built_tree_sha, error_detail = null, worker_id = null, worker_sequence = null,
				started_at = null, finished_at = v_now, updated_at = v_now
			where id = v_build.id;
			perform public.qorpera_surface_preview_build_settle(v_build.id);
		else
			perform public.qorpera_surface_preview_build_fail(v_build.id, p_error_detail);
		end if;
	end if;

	perform public.qorpera_complete_coding_turn(
		p_worker_id, p_lease_token,
		case when p_outcome = 'failed' then 'failed' else 'succeeded' end,
		case p_outcome when 'built' then 'Built the interface preview.' when 'failed' then 'The interface preview build failed.'
			else 'No interface preview was waiting to be built.' end
	);

	if exists (select 1 from public.qorpera_surface_preview_builds b where b.builder_id = v_builder.id and b.state = 'queued') then
		v_kick := public.qorpera_surface_preview_builder_kick(v_builder.id);
		perform public.qorpera_surface_preview_kick_failed(v_builder.id, v_kick);
	end if;
	return jsonb_build_object('workerId', p_worker_id, 'outcome', p_outcome);
end $$;

-- WHY: Bounds what waits on a build: ten minutes queued without a machine, a running build whose turn lost its lease
-- (queued again once, then failed), thirty minutes running at most; and wakes one idle builder whose builds still wait.
create function public.qorpera_surface_preview_builds_sweep(p_now timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
	v_build public.qorpera_surface_preview_builds%rowtype;
	v_builder_id uuid;
	v_kick text;
begin
	for v_build in
		select * from public.qorpera_surface_preview_builds b
		where b.state = 'queued' and b.queued_at <= p_now - interval '10 minutes'
		order by b.queued_at, b.id
		limit 8
		for update skip locked
	loop
		perform public.qorpera_surface_preview_build_fail(v_build.id, public.qorpera_surface_preview_build_detail(
			'PREVIEW_BUILD_NO_MACHINE', 'No coding machine could be had for the build within ten minutes.'));
	end loop;

	for v_build in
		select * from public.qorpera_surface_preview_builds b
		where b.state = 'running'
			and (
				b.started_at <= p_now - interval '30 minutes'
				or not exists (
					select 1
					from public.qorpera_coding_sessions cs
					join public.qorpera_runtime_workers w on w.id = cs.worker_id
					where cs.worker_id = b.worker_id
						and w.state = 'active'
						and w.sequence = b.worker_sequence
						and cs.phase in ('preparing', 'running', 'publishing')
						and cs.lease_until > p_now
				)
			)
		order by b.started_at, b.id
		limit 8
		for update skip locked
	loop
		if v_build.attempts < 2 and v_build.started_at > p_now - interval '30 minutes' then
			update public.qorpera_surface_preview_builds
			set state = 'queued', worker_id = null, worker_sequence = null, started_at = null, queued_at = p_now, updated_at = p_now
			where id = v_build.id;
		else
			perform public.qorpera_surface_preview_build_fail(v_build.id, public.qorpera_surface_preview_build_detail(
				'PREVIEW_BUILD_NO_MACHINE', 'The coding machine running the build stopped answering.'));
		end if;
	end loop;

	select br.id into v_builder_id
	from public.qorpera_surface_preview_builders br
	where exists (select 1 from public.qorpera_surface_preview_builds b where b.builder_id = br.id and b.state = 'queued')
		and not exists (select 1 from public.qorpera_runtime_workers w where w.id = br.worker_id and w.state = 'active')
	order by br.updated_at, br.id
	limit 1
	for update skip locked;
	if v_builder_id is not null then
		begin
			v_kick := public.qorpera_surface_preview_builder_kick(v_builder_id);
			perform public.qorpera_surface_preview_kick_failed(v_builder_id, v_kick);
		exception when others then
			null;
		end;
	end if;
end $$;

select pg_temp.spb_patch('public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure, array[
$old$	if v_lane in ('all', 'code_repo') then
		with expired_previews as ($old$,
$new$	if v_lane in ('all', 'code_repo') then
		perform public.qorpera_surface_preview_builds_sweep(v_now);
		with expired_previews as ($new$
]);

select pg_temp.spb_patch('public.qorpera_claim_coding_session(text,integer)'::regprocedure, array[
$old$				and not public.qorpera_coding_session_waits_for_usage_limit(session.worker_id)$old$,
$new$				and (not public.qorpera_coding_session_waits_for_usage_limit(session.worker_id)
					or public.qorpera_surface_is_preview_builder(session.worker_id))$new$,
$old$					completion_state = case when surface_session_id is not null then 'suppressed' else 'waiting' end,$old$,
$new$					completion_state = case when surface_backed then 'suppressed' else 'waiting' end,$new$
]);

select pg_temp.spb_patch('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure, array[
$old$		completion_state = case when surface_session_id is not null then 'suppressed' else 'waiting' end,$old$,
$new$		completion_state = case when surface_backed then 'suppressed' else 'waiting' end,$new$
]);

drop function pg_temp.spb_patch(regprocedure, text[]);

revoke all on function
	public.qorpera_surface_preview_requester(),
	public.qorpera_surface_preview_path_valid(text),
	public.qorpera_surface_preview_recipe_valid(jsonb),
	public.qorpera_surface_preview_build_detail(text, text),
	public.qorpera_surface_is_preview_builder(uuid),
	public.qorpera_surface_preview_selected(uuid),
	public.qorpera_surface_preview_build_settle(uuid),
	public.qorpera_surface_preview_build_fail(uuid, text),
	public.qorpera_surface_preview_builder_kick(uuid),
	public.qorpera_surface_preview_kick_failed(uuid, text),
	public.qorpera_surface_preview_builds_sweep(timestamptz),
	public.qorpera_surface_request_build(text, uuid, uuid, text, text, jsonb, text),
	public.qorpera_begin_surface_preview_build(uuid, uuid),
	public.qorpera_complete_surface_preview_build(uuid, uuid, uuid, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function
	public.qorpera_surface_request_build(text, uuid, uuid, text, text, jsonb, text),
	public.qorpera_begin_surface_preview_build(uuid, uuid),
	public.qorpera_complete_surface_preview_build(uuid, uuid, uuid, text, text, text)
	to service_role;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_claim_pending_jobs_for_lane(integer,text)'::regprocedure,
			'public.qorpera_claim_coding_session(text,integer)'::regprocedure,
			'public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'Patched surface build function has an API owner: %', v_owner;
		end if;
		execute format('grant execute on function public.qorpera_surface_preview_builds_sweep(timestamptz), public.qorpera_surface_is_preview_builder(uuid) to %I', v_owner);
	end loop;
end $$;
