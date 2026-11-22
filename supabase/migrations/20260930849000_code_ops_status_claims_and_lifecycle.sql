set local lock_timeout = '3s';

do $$ begin
	if exists (
		select 1 from pg_catalog.pg_attribute
		where attrelid = 'public.qorpera_coding_sessions'::regclass
			and attname = 'claimed_paths' and not attisdropped
	) then
		raise exception '20260930849000 is already applied';
	end if;
end $$;

create function pg_temp.code_ops_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930849000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

create function public.qorpera_code_claimed_paths_valid(p_paths text[])
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(
		p_paths is not null
		and cardinality(p_paths) <= 32
		and array_position(p_paths, null) is null
		and not exists (
			select 1 from unnest(p_paths) as item(path)
			where octet_length(item.path) not between 1 and 256
				or item.path ~ '[[:cntrl:]\\]'
				or left(item.path, 1) = '/'
				or right(item.path, 1) = '/'
				or exists (
					select 1 from unnest(string_to_array(item.path, '/')) as seg(part)
					where seg.part in ('', '.', '..')
				)
		)
		and (select count(distinct lower(item.path)) = cardinality(p_paths) from unnest(p_paths) as item(path)),
		false
	)
$$;

create function public.qorpera_code_claimed_paths_json_valid(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
	select case
		when jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) <= 32
			and not exists (select 1 from jsonb_array_elements(p_value) as e where jsonb_typeof(e) <> 'string')
		then public.qorpera_code_claimed_paths_valid(
			coalesce((select array_agg(e #>> '{}') from jsonb_array_elements(p_value) as e), '{}'::text[])
		)
		else false
	end
$$;

create function public.qorpera_code_segment_overlaps(p_a text, p_b text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_a_wild boolean := position('*' in p_a) > 0 or position('?' in p_a) > 0;
	v_b_wild boolean := position('*' in p_b) > 0 or position('?' in p_b) > 0;
	v_regex text;
	v_a_pre text; v_b_pre text; v_a_suf text; v_b_suf text;
begin
	if p_a = p_b or p_a = '*' or p_b = '*' then return true; end if;
	if not v_a_wild and not v_b_wild then return false; end if;
	if v_a_wild and not v_b_wild then
		v_regex := '^' || replace(replace(regexp_replace(p_a, '([.^$+(){}|[\]\\])', '\\\1', 'g'), '*', '.*'), '?', '.') || '$';
		return p_b ~ v_regex;
	end if;
	if v_b_wild and not v_a_wild then
		v_regex := '^' || replace(replace(regexp_replace(p_b, '([.^$+(){}|[\]\\])', '\\\1', 'g'), '*', '.*'), '?', '.') || '$';
		return p_a ~ v_regex;
	end if;
	v_a_pre := split_part(split_part(p_a, '*', 1), '?', 1);
	v_b_pre := split_part(split_part(p_b, '*', 1), '?', 1);
	if v_a_pre <> '' and v_b_pre <> ''
		and left(v_a_pre, least(length(v_a_pre), length(v_b_pre))) <> left(v_b_pre, least(length(v_a_pre), length(v_b_pre))) then
		return false;
	end if;
	v_a_suf := reverse(split_part(split_part(reverse(p_a), '*', 1), '?', 1));
	v_b_suf := reverse(split_part(split_part(reverse(p_b), '*', 1), '?', 1));
	if v_a_suf <> '' and v_b_suf <> ''
		and right(v_a_suf, least(length(v_a_suf), length(v_b_suf))) <> right(v_b_suf, least(length(v_a_suf), length(v_b_suf))) then
		return false;
	end if;
	return true;
end $$;

create function public.qorpera_code_glob_overlaps(p_a text, p_b text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
	v_a text[] := string_to_array(lower(p_a), '/');
	v_b text[] := string_to_array(lower(p_b), '/');
	v_len integer := least(cardinality(v_a), cardinality(v_b));
	v_i integer;
begin
	if p_a is null or p_b is null or p_a = '' or p_b = '' then return false; end if;
	for v_i in 1..v_len loop
		if v_a[v_i] = '**' or v_b[v_i] = '**' then return true; end if;
		if not public.qorpera_code_segment_overlaps(v_a[v_i], v_b[v_i]) then return false; end if;
	end loop;
	return true;
end $$;

create function public.qorpera_code_paths_overlap(p_a text[], p_b text[])
returns text[] language sql immutable set search_path = '' as $$
	select coalesce(
		array_agg(distinct b.path order by b.path),
		'{}'::text[]
	)
	from unnest(coalesce(p_a, '{}'::text[])) as a(path)
	cross join unnest(coalesce(p_b, '{}'::text[])) as b(path)
	where public.qorpera_code_glob_overlaps(a.path, b.path)
$$;

alter table public.qorpera_coding_sessions
	add column claimed_paths text[] not null default '{}'
	check (public.qorpera_code_claimed_paths_valid(claimed_paths));

alter table public.qorpera_code_repositories
	add column archived_at timestamptz,
	add column archived_by_agent_id uuid,
	add column archived_by_user_id uuid;

alter table public.qorpera_code_requests
	drop constraint qorpera_code_requests_kind_check,
	add constraint qorpera_code_requests_kind_check check (kind in ('undo','download','restore','import','query','lifecycle')),
	drop constraint qorpera_code_requests_input_check,
	add constraint qorpera_code_requests_input_check check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 8192),
	drop constraint qorpera_code_requests_outcome_check,
	add constraint qorpera_code_requests_outcome_check check (outcome is null or pg_column_size(outcome) <= 262144);

drop index public.qorpera_code_requests_one_move;
create unique index qorpera_code_requests_one_move on public.qorpera_code_requests(environment_id, owner, name)
	where ((kind = 'undo' and coalesce((input ->> 'dryRun')::boolean, false) = false) or kind = 'restore')
		and state in ('queued','running');

create function public.qorpera_code_archived_guard(p_worker public.qorpera_runtime_workers)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_repo jsonb;
begin
	select session.repository into v_repo from public.qorpera_coding_sessions session where session.worker_id = p_worker.id;
	if v_repo ->> 'host' = 'qorpera' and exists (
		select 1 from public.qorpera_code_repositories repo
		where repo.environment_id = p_worker.environment_id
			and repo.owner = v_repo ->> 'owner'
			and repo.name = v_repo ->> 'name'
			and repo.archived_at is not null
	) then
		raise exception 'This repository is archived; no new coding sessions can run on it' using errcode = '55000';
	end if;
end $$;

create function public.qorpera_surface_prevent_archived_repo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
	v_owner text;
	v_name text;
	v_archived_at timestamptz;
begin
	if new.source_kind = 'code_repo' then
		if new.repository_key is not null and position('/' in new.repository_key) > 0 then
			v_owner := lower(btrim(split_part(new.repository_key, '/', 1)));
			v_name := lower(btrim(split_part(new.repository_key, '/', 2)));
		else
			v_owner := 'surfaces';
			v_name := lower(new.slug);
		end if;
		-- WHY: FOR KEY SHARE serializes with archive's FOR UPDATE so neither order nor concurrent races can attach a surface to an archived repo.
		for v_archived_at in
			select repo.archived_at
			from public.qorpera_code_repositories repo
			where repo.profile_id = new.profile_id
				and repo.owner = v_owner
				and repo.name = v_name
			order by repo.environment_id
			for key share
		loop
			if v_archived_at is not null then
				raise exception 'This repository is archived; unarchive it before attaching a surface' using errcode = '55000';
			end if;
		end loop;
	end if;
	return new;
end $$;

create trigger qorpera_surfaces_prevent_archived_repo
before insert or update of source_kind, repository_key, slug on public.qorpera_surfaces
for each row execute function public.qorpera_surface_prevent_archived_repo();

create function public.qorpera_code_request_wake_topic(p_owner text, p_machine_id_sha256 text)
returns text language sql immutable set search_path = '' as $$
	select 'qorpera-code-requests-wake-' || encode(
		pg_catalog.sha256(convert_to('qorpera.code-requests-wake/v1:' || p_owner || ':' || p_machine_id_sha256, 'UTF8')),
		'hex'
	)
$$;

create function public.qorpera_code_requests_notify_internal(p_environment_id uuid, p_request_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_lock_timeout text := current_setting('lock_timeout'); v_topic text;
begin
	perform pg_catalog.pg_notify(
		'qorpera_code_requests',
		jsonb_build_object('requestId', p_request_id, 'environmentId', p_environment_id, 'kind', p_kind)::text
	);
	begin
		perform set_config('lock_timeout', '50ms', true);
		for v_topic in
			select public.qorpera_code_request_wake_topic(executor.owner, executor.nas_machine_id_sha256)
			from public.qorpera_coding_executors executor
			where executor.environment_id = p_environment_id
				and executor.enabled
				and executor.nas_machine_id_sha256 is not null
		loop
			perform realtime.send(jsonb_build_object('schema', 'qorpera.code-request-wake/v1'), 'wake', v_topic, true);
		end loop;
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception when others then
		null;
	end;
end $$;

create policy qorpera_code_requests_wake_receive
	on realtime.messages
	for select
	to anon
	using (
		realtime.messages.extension = 'broadcast'
		and realtime.messages.topic = (select realtime.topic())
		and realtime.messages.topic ~ '^qorpera-code-requests-wake-[0-9a-f]{64}$'
	);

create function public.qorpera_code_repository_status(p_environment_id uuid, p_owner text, p_name text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_profile_id uuid;
	v_role public.qorpera_profile_role;
	v_repo public.qorpera_code_repositories%rowtype;
	v_registered boolean := false;
	v_sessions jsonb;
	v_sessions_total integer;
	v_changes jsonb;
	v_changes_count integer;
	v_queue jsonb;
	v_site jsonb := '{}'::jsonb;
begin
	if p_environment_id is null
		or coalesce(p_owner, '') !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
		or coalesce(p_name, '') !~ '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$' then
		raise exception 'Code status request is invalid' using errcode = '22023';
	end if;
	if auth.role() = 'authenticated' then
		if auth.uid() is null then
			raise exception 'Code unavailable' using errcode = '42501';
		end if;
		select file.profile_id into v_profile_id
		from public.qorpera_company_files file
		where file.environment_id = p_environment_id and file.core = 'folder-v2'
		limit 1;
		v_role := case when v_profile_id is not null then public.qorpera_member_role(v_profile_id) end;
		if v_role is null then
			raise exception 'Code unavailable' using errcode = '42501';
		end if;
	elsif auth.role() is distinct from 'service_role' then
		raise exception 'Code unavailable' using errcode = '42501';
	end if;

	select * into v_repo
	from public.qorpera_code_repositories repo
	where repo.environment_id = p_environment_id and repo.owner = p_owner and repo.name = p_name;
	v_registered := found;

	if v_registered then
		v_site := public.qorpera_code_release_index(v_repo);
	end if;

	select count(*)::integer into v_sessions_total
	from public.qorpera_coding_sessions session
	where session.environment_id = p_environment_id
		and session.repository ->> 'host' = 'qorpera'
		and session.repository ->> 'owner' = p_owner
		and session.repository ->> 'name' = p_name;

	select coalesce(jsonb_agg(item.row order by item.ord), '[]'::jsonb) into v_sessions
	from (
		select
			row_number() over (
				order by (session.archived_at is null) desc,
					(session.phase in ('publishing','running','preparing','queued','input_ready')) desc,
					session.updated_at desc, session.worker_id
			) as ord,
			jsonb_build_object(
				'workerId', session.worker_id,
				'workerKey', worker.worker_key,
				'agent', coalesce(
					nullif(case when worker.folder_path like 'QorperaOS/%' then split_part(worker.folder_path, '/', 3) else split_part(worker.folder_path, '/', 2) end, ''),
					worker.staff_agent_id::text
				),
				'todoKey', nullif(
					case when worker.folder_path like 'QorperaOS/%' then split_part(worker.folder_path, '/', 5) else split_part(worker.folder_path, '/', 4) end,
					''
				),
				'title', worker.title,
				'state', worker.state,
				'phase', session.phase,
				'harness', session.harness,
				'branch', session.branch,
				'worktree', format('code/%s/%s/worktrees/%s', p_owner, p_name, session.worker_id),
				'baseSha', session.base_sha,
				'claimedPaths', to_jsonb(session.claimed_paths),
				'sequence', worker.sequence,
				'archived', session.archived_at is not null,
				'needs', worker.result ->> 'needs',
				'path', worker.folder_path,
				'createdAt', session.created_at,
				'updatedAt', session.updated_at
			) as row
		from public.qorpera_coding_sessions session
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where session.environment_id = p_environment_id
			and session.repository ->> 'host' = 'qorpera'
			and session.repository ->> 'owner' = p_owner
			and session.repository ->> 'name' = p_name
		order by (session.archived_at is null) desc,
			(session.phase in ('publishing','running','preparing','queued','input_ready')) desc,
			session.updated_at desc, session.worker_id
		limit 50
	) as item;

	select count(*)::integer into v_changes_count
	from public.qorpera_code_changes change
	where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name;

	select coalesce(jsonb_agg(item.row order by item.n desc), '[]'::jsonb) into v_changes
	from (
		select
			change.n,
			jsonb_build_object(
				'n', change.n,
				'kind', change.kind,
				'state', change.state,
				'how', change.how,
				'title', change.title,
				'notice', change.notice,
				'workerId', change.worker_id,
				'checksState', change.checks_state,
				'siteState', change.site_state,
				'filesChanged', change.files_changed,
				'mainBefore', change.main_before,
				'mainAfter', change.main_after,
				'undoes', to_jsonb(change.undoes),
				'revertedBy', change.reverted_by,
				'createdAt', change.created_at
			) as row
		from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner and change.name = p_name
		order by change.n desc
		limit 20
	) as item;

	select jsonb_build_object(
		'landing', (
			select count(*)::integer from public.qorpera_coding_sessions session
			where session.environment_id = p_environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = p_owner
				and session.repository ->> 'name' = p_name and session.phase = 'publishing'
		),
		'running', (
			select count(*)::integer from public.qorpera_coding_sessions session
			where session.environment_id = p_environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = p_owner
				and session.repository ->> 'name' = p_name and session.phase in ('preparing','running')
		),
		'queued', (
			select count(*)::integer from public.qorpera_coding_sessions session
			where session.environment_id = p_environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = p_owner
				and session.repository ->> 'name' = p_name and session.phase in ('queued','input_ready')
		),
		'restoring', exists (
			select 1 from public.qorpera_code_requests req
			where req.environment_id = p_environment_id and req.owner = p_owner and req.name = p_name
				and req.kind = 'restore' and req.state in ('queued','running')
		),
		'openRequests', coalesce((
			select jsonb_agg(jsonb_build_object(
				'requestId', req.id,
				'kind', req.kind,
				'state', req.state,
				'createdAt', req.created_at
			) order by req.created_at, req.id)
			from (
				select request.id, request.kind, request.state, request.created_at
				from public.qorpera_code_requests request
				where request.environment_id = p_environment_id and request.owner = p_owner and request.name = p_name
					and request.state in ('queued','running')
				order by request.created_at, request.id
				limit 20
			) as req
		), '[]'::jsonb)
	) into v_queue;

	return jsonb_build_object(
		'schema', 'qorpera.code-repository-status/v1',
		'registered', v_registered,
		'repository', jsonb_build_object(
			'owner', p_owner,
			'name', p_name,
			'path', format('code/%s/%s', p_owner, p_name),
			'registered', v_registered,
			'archived', coalesce(v_repo.archived_at is not null, false),
			'archivedAt', v_repo.archived_at,
			'mainSha', coalesce(v_repo.last_main, v_repo.main_sha),
			'lastChange', coalesce(v_repo.last_change, 0),
			'checksEnabled', coalesce(v_repo.checks_enabled, true),
			'siteEnabled', coalesce(v_repo.site_enabled, true),
			'restoredAt', v_repo.restored_at,
			'importedAt', v_repo.imported_at
		),
		'sessionsTotal', v_sessions_total,
		'sessions', v_sessions,
		'changesCount', v_changes_count,
		'recentChanges', v_changes,
		'site', v_site,
		'queue', v_queue
	);
end $$;

create function public.qorpera_folder_code_status(p_binding jsonb, p_owner text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	v_run := public.qorpera_code_agent_run(p_binding);
	return public.qorpera_code_repository_status(v_run.environment_id, p_owner, p_name);
end $$;

create function public.qorpera_folder_code_claim_overlaps(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_repo jsonb;
	v_claimed text[];
	v_exclude uuid;
	v_overlaps jsonb;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['repository','claimedPaths']
		or p_request - array['repository','claimedPaths','excludeWorkerId'] <> '{}'::jsonb
		or not public.qorpera_coding_repository_valid(p_request -> 'repository')
		or not public.qorpera_code_claimed_paths_json_valid(p_request -> 'claimedPaths')
		or (p_request ? 'excludeWorkerId' and p_request -> 'excludeWorkerId' <> 'null'::jsonb
			and not public.qorpera_code_json_text(p_request -> 'excludeWorkerId',
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) then
		raise exception 'Code claim overlap request is invalid' using errcode = '22023';
	end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_repo := p_request -> 'repository';
	v_claimed := coalesce((select array_agg(e #>> '{}') from jsonb_array_elements(p_request -> 'claimedPaths') as e), '{}'::text[]);
	v_exclude := case when p_request ->> 'excludeWorkerId' is not null then (p_request ->> 'excludeWorkerId')::uuid end;
	if cardinality(v_claimed) = 0 then
		return jsonb_build_object('schema', 'qorpera.code-claim-overlaps/v1', 'overlaps', '[]'::jsonb);
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'workerId', hit.worker_id,
		'workerKey', hit.worker_key,
		'title', hit.title,
		'phase', hit.phase,
		'branch', hit.branch,
		'claimedPaths', to_jsonb(hit.claimed_paths),
		'matchedPaths', to_jsonb(hit.matched_paths)
	) order by hit.updated_at desc, hit.worker_id), '[]'::jsonb) into v_overlaps
	from (
		select
			session.worker_id,
			worker.worker_key,
			worker.title,
			session.phase,
			session.branch,
			session.claimed_paths,
			session.updated_at,
			public.qorpera_code_paths_overlap(v_claimed, session.claimed_paths) as matched_paths
		from public.qorpera_coding_sessions session
		join public.qorpera_runtime_workers worker on worker.id = session.worker_id
		where session.environment_id = v_run.environment_id
			and session.archived_at is null
			and (worker.state = 'active' or session.phase in ('queued','preparing','running','publishing','input_ready'))
			and (v_exclude is null or session.worker_id <> v_exclude)
			and session.repository ->> 'host' = v_repo ->> 'host'
			and lower(session.repository ->> 'owner') = lower(v_repo ->> 'owner')
			and lower(session.repository ->> 'name') = lower(v_repo ->> 'name')
			and cardinality(session.claimed_paths) > 0
			and cardinality(public.qorpera_code_paths_overlap(v_claimed, session.claimed_paths)) > 0
		order by session.updated_at desc, session.worker_id
		limit 20
	) as hit;
	return jsonb_build_object('schema', 'qorpera.code-claim-overlaps/v1', 'overlaps', v_overlaps);
end $$;

create function public.qorpera_folder_code_history(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_owner text;
	v_name text;
	v_state text;
	v_worker_id uuid;
	v_path text;
	v_cursor integer;
	v_limit integer := 20;
	v_total integer;
	v_rows jsonb;
	v_next integer;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['owner','name']
		or p_request - array['owner','name','state','workerId','path','cursor','limit'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or (p_request ? 'state' and p_request -> 'state' <> 'null'::jsonb
			and not coalesce(p_request ->> 'state' in ('landed','reverted','conflict','refused','lost'), false))
		or (p_request ? 'workerId' and p_request -> 'workerId' <> 'null'::jsonb
			and not public.qorpera_code_json_text(p_request -> 'workerId',
				'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
		or (p_request ? 'path' and p_request -> 'path' <> 'null'::jsonb
			and (jsonb_typeof(p_request -> 'path') <> 'string'
				or octet_length(p_request ->> 'path') not between 1 and 1024
				or (p_request ->> 'path') ~ '[[:cntrl:]\\]'
				or left(p_request ->> 'path', 1) = '/' or right(p_request ->> 'path', 1) = '/'))
		or (p_request ? 'cursor' and p_request -> 'cursor' <> 'null'::jsonb
			and not (public.qorpera_code_json_count(p_request -> 'cursor') and p_request ->> 'cursor' ~ '^[1-9][0-9]{0,8}$'))
		or (p_request ? 'limit' and p_request -> 'limit' <> 'null'::jsonb
			and not (public.qorpera_code_json_count(p_request -> 'limit')
				and (p_request ->> 'limit')::bigint between 1 and 100)) then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_owner := p_request ->> 'owner';
	v_name := p_request ->> 'name';
	v_state := p_request ->> 'state';
	v_worker_id := case when p_request ->> 'workerId' is not null then (p_request ->> 'workerId')::uuid end;
	v_path := p_request ->> 'path';
	v_cursor := case when p_request ->> 'cursor' is not null then (p_request ->> 'cursor')::integer end;
	if p_request ->> 'limit' is not null then v_limit := (p_request ->> 'limit')::integer; end if;

	if not exists (
		select 1 from public.qorpera_code_repositories repo
		where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name
	) then
		raise exception 'No such repository' using errcode = 'P0002';
	end if;

	select count(*)::integer into v_total
	from public.qorpera_code_changes change
	where change.environment_id = v_run.environment_id and change.owner = v_owner and change.name = v_name
		and (v_state is null or change.state = v_state)
		and (v_worker_id is null or change.worker_id = v_worker_id)
		and (v_path is null or exists (
			select 1 from jsonb_array_elements(coalesce(change.paths, '[]'::jsonb)) as p
			where p ->> 'path' = v_path or (p ->> 'path') like v_path || '/%'
		));

	with page as (
		select change.*
		from public.qorpera_code_changes change
		where change.environment_id = v_run.environment_id and change.owner = v_owner and change.name = v_name
			and (v_state is null or change.state = v_state)
			and (v_worker_id is null or change.worker_id = v_worker_id)
			and (v_cursor is null or change.n < v_cursor)
			and (v_path is null or exists (
				select 1 from jsonb_array_elements(coalesce(change.paths, '[]'::jsonb)) as p
				where p ->> 'path' = v_path or (p ->> 'path') like v_path || '/%'
			))
		order by change.n desc
		limit v_limit + 1
	), shown as (
		select * from page order by n desc limit v_limit
	)
	select
		coalesce(jsonb_agg(jsonb_build_object(
			'n', s.n,
			'kind', s.kind,
			'state', s.state,
			'how', s.how,
			'title', s.title,
			'summary', s.summary,
			'notice', s.notice,
			'workerId', s.worker_id,
			'sequence', s.sequence,
			'mainBefore', s.main_before,
			'mainAfter', s.main_after,
			'filesChanged', s.files_changed,
			'paths', coalesce(s.paths, '[]'::jsonb),
			'pathsMore', s.paths_more,
			'checksState', s.checks_state,
			'siteState', s.site_state,
			'undoes', to_jsonb(s.undoes),
			'revertedBy', s.reverted_by,
			'restoredFrom', s.restored_from,
			'refusal', s.refusal,
			'createdAt', s.created_at
		) order by s.n desc), '[]'::jsonb),
		case when (select count(*) from page) > v_limit then (select min(n) from shown) else null end
	into v_rows, v_next
	from shown s;

	return jsonb_build_object(
		'schema', 'qorpera.code-history/v1',
		'owner', v_owner,
		'name', v_name,
		'total', v_total,
		'changes', v_rows,
		'nextCursor', v_next
	);
end $$;

create function public.qorpera_code_resolve_ref_internal(
	p_environment_id uuid, p_owner text, p_name text, p_ref jsonb
)
returns text language plpgsql stable set search_path = '' as $$
declare
	v_text text;
	v_n integer;
	v_sha text;
	v_worker_id uuid;
	v_tail text;
begin
	if p_ref is null or p_ref = 'null'::jsonb then
		return 'refs/heads/main';
	end if;
	if jsonb_typeof(p_ref) = 'number' then
		if not (public.qorpera_code_json_count(p_ref) and p_ref #>> '{}' ~ '^[1-9][0-9]{0,8}$') then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_n := (p_ref #>> '{}')::integer;
		select change.main_after into v_sha from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner
			and change.name = p_name and change.n = v_n;
		if v_sha is null then raise exception 'No such change' using errcode = 'P0002'; end if;
		return v_sha;
	end if;
	if jsonb_typeof(p_ref) <> 'string' then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;
	v_text := p_ref #>> '{}';
	if v_text = 'main' or v_text = 'refs/heads/main' then
		return 'refs/heads/main';
	end if;
	if v_text ~ '^[0-9a-f]{40}$' then
		return v_text;
	end if;
	if v_text ~ '^change:[1-9][0-9]{0,8}$' then
		v_n := substring(v_text from 8)::integer;
		select change.main_after into v_sha from public.qorpera_code_changes change
		where change.environment_id = p_environment_id and change.owner = p_owner
			and change.name = p_name and change.n = v_n;
		if v_sha is null then raise exception 'No such change' using errcode = 'P0002'; end if;
		return v_sha;
	end if;
	if v_text ~ '^worker:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		v_worker_id := substring(v_text from 8)::uuid;
		if not exists (
			select 1 from public.qorpera_coding_sessions session
			where session.worker_id = v_worker_id and session.environment_id = p_environment_id
				and session.repository ->> 'host' = 'qorpera'
				and session.repository ->> 'owner' = p_owner
				and session.repository ->> 'name' = p_name
		) then
			raise exception 'No such worker branch' using errcode = 'P0002';
		end if;
		return 'refs/heads/qorpera/coding/' || v_worker_id::text;
	end if;
	if v_text ~ '^imported:[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' then
		v_tail := substring(v_text from 10);
		if v_tail like '%..%' or v_tail like '%//%' or right(v_tail, 1) in ('/', '.') or right(v_tail, 5) = '.lock' then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		return 'refs/qorpera/imported/heads/' || v_tail;
	end if;
	if v_text ~ '^tag:[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$' then
		v_tail := substring(v_text from 5);
		if v_tail like '%..%' or v_tail like '%//%' or right(v_tail, 1) in ('/', '.') or right(v_tail, 5) = '.lock' then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		return 'refs/tags/' || v_tail;
	end if;
	if v_text ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$'
		and v_text not like '%..%' and v_text not like '%//%'
		and right(v_text, 1) not in ('/', '.') and right(v_text, 5) <> '.lock' then
		return 'refs/tags/' || v_text;
	end if;
	raise exception 'Code request is invalid' using errcode = '22023';
end $$;

create function public.qorpera_code_rel_path_valid(p_path text)
returns boolean language sql immutable set search_path = '' as $$
	select coalesce(
		p_path is not null
		and octet_length(p_path) between 1 and 1024
		and p_path !~ '[[:cntrl:]\\]'
		and left(p_path, 1) <> '/'
		and right(p_path, 1) <> '/'
		and not exists (
			select 1 from unnest(string_to_array(p_path, '/')) as seg(part)
			where seg.part in ('', '.', '..')
		),
		false
	)
$$;

create function public.qorpera_folder_code_query(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_repo public.qorpera_code_repositories%rowtype;
	v_op text;
	v_owner text;
	v_name text;
	v_input jsonb;
	v_id uuid;
	v_ref text;
	v_from text;
	v_to text;
	v_base text;
	v_head text;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['op','owner','name']
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not coalesce(p_request ->> 'op' in ('log','diff','show','branches','merge_preview'), false) then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;
	v_run := public.qorpera_code_agent_run(p_binding);
	v_op := p_request ->> 'op';
	v_owner := p_request ->> 'owner';
	v_name := p_request ->> 'name';

	select * into v_repo from public.qorpera_code_repositories repo
	where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name;
	if not found then
		raise exception 'No such repository' using errcode = 'P0002';
	end if;
	if (select count(*) from public.qorpera_coding_executors executor
		where executor.environment_id = v_run.environment_id and executor.enabled) <> 1 then
		return jsonb_build_object('schema', 'qorpera.code-query/v1', 'state', 'refused', 'reason', 'no_executor');
	end if;

	if v_op = 'log' then
		if p_request - array['op','owner','name','ref','path','limit','since'] <> '{}'::jsonb
			or (p_request ? 'path' and p_request -> 'path' <> 'null'::jsonb
				and not public.qorpera_code_rel_path_valid(p_request ->> 'path'))
			or (p_request ? 'limit' and p_request -> 'limit' <> 'null'::jsonb
				and not (public.qorpera_code_json_count(p_request -> 'limit')
					and (p_request ->> 'limit')::bigint between 1 and 100))
			or (p_request ? 'since' and p_request -> 'since' <> 'null'::jsonb
				and not public.qorpera_code_json_text(p_request -> 'since', '^[0-9A-Za-z:+ ._-]{1,64}$')) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_ref := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'ref');
		v_input := jsonb_build_object(
			'op', 'log',
			'ref', v_ref,
			'limit', coalesce((p_request ->> 'limit')::integer, 20),
			'path', p_request ->> 'path',
			'since', p_request ->> 'since'
		);
	elsif v_op = 'diff' then
		if p_request - array['op','owner','name','from','to','statOnly','paths','maxBytes'] <> '{}'::jsonb
			or not (p_request ? 'from')
			or (p_request ? 'statOnly' and jsonb_typeof(p_request -> 'statOnly') not in ('boolean','null'))
			or (p_request ? 'maxBytes' and p_request -> 'maxBytes' <> 'null'::jsonb
				and not (public.qorpera_code_json_count(p_request -> 'maxBytes')
					and (p_request ->> 'maxBytes')::bigint between 1024 and 65536))
			or (p_request ? 'paths' and p_request -> 'paths' <> 'null'::jsonb and (
				not public.qorpera_code_json_strings(p_request -> 'paths', 32)
				or exists (
					select 1 from jsonb_array_elements_text(p_request -> 'paths') as item(p)
					where not public.qorpera_code_rel_path_valid(item.p)
				)
			)) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_from := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'from');
		v_to := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'to');
		v_input := jsonb_build_object(
			'op', 'diff',
			'from', v_from,
			'to', v_to,
			'statOnly', coalesce((p_request ->> 'statOnly')::boolean, false),
			'paths', coalesce(p_request -> 'paths', '[]'::jsonb),
			'maxBytes', coalesce((p_request ->> 'maxBytes')::integer, 65536)
		);
	elsif v_op = 'show' then
		if p_request - array['op','owner','name','ref','path','maxBytes'] <> '{}'::jsonb
			or not (p_request ? 'path')
			or not public.qorpera_code_rel_path_valid(p_request ->> 'path')
			or (p_request ? 'maxBytes' and p_request -> 'maxBytes' <> 'null'::jsonb
				and not (public.qorpera_code_json_count(p_request -> 'maxBytes')
					and (p_request ->> 'maxBytes')::bigint between 1024 and 131072)) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_ref := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'ref');
		v_input := jsonb_build_object(
			'op', 'show',
			'ref', v_ref,
			'path', p_request ->> 'path',
			'maxBytes', coalesce((p_request ->> 'maxBytes')::integer, 131072)
		);
	elsif v_op = 'branches' then
		if p_request - array['op','owner','name'] <> '{}'::jsonb then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_input := jsonb_build_object('op', 'branches');
	else
		if p_request - array['op','owner','name','base','head'] <> '{}'::jsonb
			or not (p_request ? 'head') then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_base := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'base');
		v_head := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'head');
		v_input := jsonb_build_object('op', 'merge_preview', 'base', v_base, 'head', v_head);
	end if;

	insert into public.qorpera_code_requests(
		environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
	)
	values (
		v_repo.environment_id, v_repo.owner, v_repo.name, v_repo.profile_id, 'query',
		v_input, 'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
	)
	returning id into v_id;
	perform public.qorpera_code_requests_notify_internal(v_repo.environment_id, v_id, 'query');

	return jsonb_build_object('schema', 'qorpera.code-query/v1', 'state', 'queued', 'requestId', v_id);
end $$;

create function public.qorpera_folder_code_lifecycle(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_digest text;
	v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb;
	v_result jsonb;
	v_repo public.qorpera_code_repositories%rowtype;
	v_op text;
	v_owner text;
	v_name text;
	v_mode text;
	v_tag text;
	v_target text;
	v_message text;
	v_id uuid;
	v_now timestamptz := clock_timestamp();
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey','op','owner','name']
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not coalesce(p_request ->> 'op' in ('create','archive','unarchive','tag','prune'), false) then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;
	v_op := p_request ->> 'op';
	v_owner := p_request ->> 'owner';
	v_name := p_request ->> 'name';

	if v_op in ('create','unarchive') then
		if p_request - array['operationKey','op','owner','name'] <> '{}'::jsonb then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
	elsif v_op = 'archive' then
		if p_request - array['operationKey','op','owner','name','reason'] <> '{}'::jsonb
			or (p_request ? 'reason' and p_request -> 'reason' <> 'null'::jsonb
				and (jsonb_typeof(p_request -> 'reason') <> 'string' or octet_length(p_request ->> 'reason') > 500)) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
	elsif v_op = 'tag' then
		if p_request - array['operationKey','op','owner','name','mode','tag','target','message'] <> '{}'::jsonb
			or not coalesce(p_request ->> 'mode' in ('create','list'), false) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_mode := p_request ->> 'mode';
		if v_mode = 'list' and p_request ?| array['tag','target','message'] then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		if v_mode = 'create' then
			v_tag := p_request ->> 'tag';
			if v_tag is null or v_tag !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$'
				or v_tag like '%..%' or v_tag like '%//%' or v_tag like '%/.%'
				or right(v_tag, 1) in ('/', '.') or right(v_tag, 5) = '.lock'
				or (p_request ? 'message' and p_request -> 'message' <> 'null'::jsonb
					and (jsonb_typeof(p_request -> 'message') <> 'string'
						or btrim(p_request ->> 'message') = ''
						or octet_length(p_request ->> 'message') > 1000)) then
				raise exception 'Code request is invalid' using errcode = '22023';
			end if;
			v_message := p_request ->> 'message';
		end if;
	elsif v_op = 'prune' then
		if p_request - array['operationKey','op','owner','name','deleteMergedBranches'] <> '{}'::jsonb
			or (p_request ? 'deleteMergedBranches'
				and jsonb_typeof(p_request -> 'deleteMergedBranches') not in ('boolean','null')) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
	end if;

	v_run := public.qorpera_code_agent_run(p_binding);
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object(
		'schema', 'qorpera.folder-code-lifecycle/v1',
		'runId', v_run.id,
		'request', p_request
	)::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(
		p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'),
		false
	);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000';
	end if;

	if v_op = 'create' then
		perform 1 from public.qorpera_profiles profile where profile.id = v_run.profile_id for key share;
		if exists (select 1 from public.qorpera_company_deletions deletion where deletion.profile_id = v_run.profile_id) then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'deleting');
		elsif exists (
			select 1 from public.qorpera_coding_repository_grants grant_row
			where grant_row.environment_id = v_run.environment_id
				and grant_row.repository ->> 'host' = 'github.com'
				and lower(grant_row.repository ->> 'owner') = v_owner
				and lower(grant_row.repository ->> 'name') = v_name
		) then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'github_conflict');
		elsif exists (
			select 1 from public.qorpera_code_requests imp
			where imp.environment_id = v_run.environment_id and imp.owner = v_owner and imp.name = v_name
				and imp.kind = 'import' and imp.state in ('queued','running')
		) then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'import_in_progress');
		else
			select * into v_repo from public.qorpera_code_repositories repo
			where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
			if found then
				if v_repo.archived_at is not null then
					v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'archived');
				else
					v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'already', 'owner', v_owner, 'name', v_name);
				end if;
			else
				perform public.qorpera_coding_executor_enroll(v_run.environment_id, null);
				if (select count(*) from public.qorpera_coding_executors executor
					where executor.environment_id = v_run.environment_id and executor.enabled) <> 1 then
					v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'no_executor');
				else
					insert into public.qorpera_code_repositories(environment_id, profile_id, owner, name)
					values (v_run.environment_id, v_run.profile_id, v_owner, v_name)
					on conflict (environment_id, owner, name) do nothing;
					insert into public.qorpera_code_requests(
						environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
					)
					values (
						v_run.environment_id, v_owner, v_name, v_run.profile_id, 'lifecycle',
						jsonb_build_object('op', 'create'), 'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
					)
					returning id into v_id;
					perform public.qorpera_code_requests_notify_internal(v_run.environment_id, v_id, 'lifecycle');
					v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'queued', 'requestId', v_id);
				end if;
			end if;
		end if;
	elsif v_op = 'archive' then
		select * into v_repo from public.qorpera_code_repositories repo
		where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
		if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
		if v_repo.archived_at is not null then
			v_result := jsonb_build_object(
				'schema', 'qorpera.code-lifecycle/v1', 'state', 'already',
				'owner', v_owner, 'name', v_name, 'archivedAt', v_repo.archived_at
			);
		elsif v_owner = 'surfaces' or exists (
			select 1 from public.qorpera_surfaces surface
			where surface.profile_id = v_run.profile_id
				and surface.source_kind = 'code_repo'
				and (
					case
						when surface.repository_key is not null and position('/' in surface.repository_key) > 0
							then lower(btrim(split_part(surface.repository_key, '/', 1))) = v_owner
								and lower(btrim(split_part(surface.repository_key, '/', 2))) = v_name
						else v_owner = 'surfaces' and lower(surface.slug) = v_name
					end
				)
		) then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'surface_backed');
		elsif exists (
			select 1 from public.qorpera_coding_sessions session
			join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			where session.environment_id = v_run.environment_id and session.archived_at is null
				and session.repository ->> 'host' = 'qorpera' and session.repository ->> 'owner' = v_owner
				and session.repository ->> 'name' = v_name
				and (worker.state = 'active' or session.phase in ('queued','preparing','running','publishing','input_ready'))
		) then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'sessions_active');
		else
			update public.qorpera_code_repositories
			set archived_at = v_now, archived_by_agent_id = v_run.staff_agent_id, archived_by_user_id = v_run.requested_by_user_id
			where environment_id = v_repo.environment_id and owner = v_repo.owner and name = v_repo.name;
			v_result := jsonb_build_object(
				'schema', 'qorpera.code-lifecycle/v1', 'state', 'done', 'result', 'archived',
				'owner', v_owner, 'name', v_name, 'archivedAt', v_now
			);
		end if;
	elsif v_op = 'unarchive' then
		select * into v_repo from public.qorpera_code_repositories repo
		where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
		if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
		if v_repo.archived_at is null then
			v_result := jsonb_build_object(
				'schema', 'qorpera.code-lifecycle/v1', 'state', 'already',
				'owner', v_owner, 'name', v_name, 'archivedAt', null
			);
		else
			update public.qorpera_code_repositories
			set archived_at = null, archived_by_agent_id = null, archived_by_user_id = null
			where environment_id = v_repo.environment_id and owner = v_repo.owner and name = v_repo.name;
			v_result := jsonb_build_object(
				'schema', 'qorpera.code-lifecycle/v1', 'state', 'done', 'result', 'unarchived',
				'owner', v_owner, 'name', v_name, 'archivedAt', null
			);
		end if;
	elsif v_op = 'tag' then
		select * into v_repo from public.qorpera_code_repositories repo
		where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
		if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
		if v_mode = 'create' and v_repo.archived_at is not null then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'archived');
		elsif (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = v_run.environment_id and executor.enabled) <> 1 then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'no_executor');
		else
			if v_mode = 'create' then
				v_target := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'target');
			end if;
			insert into public.qorpera_code_requests(
				environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
			)
			values (
				v_repo.environment_id, v_repo.owner, v_repo.name, v_repo.profile_id, 'lifecycle',
				case when v_mode = 'list' then jsonb_build_object('op', 'tag', 'mode', 'list')
				else jsonb_build_object('op', 'tag', 'mode', 'create', 'tag', v_tag, 'target', v_target, 'message', v_message) end,
				'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
			)
			returning id into v_id;
			perform public.qorpera_code_requests_notify_internal(v_repo.environment_id, v_id, 'lifecycle');
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'queued', 'requestId', v_id);
		end if;
	else
		select * into v_repo from public.qorpera_code_repositories repo
		where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
		if not found then raise exception 'No such repository' using errcode = 'P0002'; end if;
		if (select count(*) from public.qorpera_coding_executors executor
			where executor.environment_id = v_run.environment_id and executor.enabled) <> 1 then
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'refused', 'reason', 'no_executor');
		else
			insert into public.qorpera_code_requests(
				environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
			)
			values (
				v_repo.environment_id, v_repo.owner, v_repo.name, v_repo.profile_id, 'lifecycle',
				jsonb_build_object(
					'op', 'prune',
					'deleteMergedBranches', coalesce((p_request ->> 'deleteMergedBranches')::boolean, false)
				),
				'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
			)
			returning id into v_id;
			perform public.qorpera_code_requests_notify_internal(v_repo.environment_id, v_id, 'lifecycle');
			v_result := jsonb_build_object('schema', 'qorpera.code-lifecycle/v1', 'state', 'queued', 'requestId', v_id);
		end if;
	end if;

	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

create function public.qorpera_folder_request_code_undo_v2(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_digest text;
	v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb;
	v_result jsonb;
	v_repository public.qorpera_code_repositories%rowtype;
	v_change public.qorpera_code_changes%rowtype;
	v_row public.qorpera_code_changes%rowtype;
	v_open public.qorpera_code_requests%rowtype;
	v_n integer;
	v_to integer;
	v_later boolean;
	v_dry_run boolean;
	v_run_checks boolean;
	v_force boolean;
	v_targets integer[];
	v_reason text;
	v_id uuid;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey','owner','name','reason']
		or p_request - array['operationKey','owner','name','change','toChange','changes','andLater','reason','notice','dryRun','runChecks','force'] <> '{}'::jsonb
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or jsonb_typeof(p_request -> 'reason') is distinct from 'string' or btrim(p_request ->> 'reason') = ''
		or octet_length(p_request ->> 'reason') > 500
		or (p_request ? 'notice' and jsonb_typeof(p_request -> 'notice') not in ('string','null'))
		or (p_request ->> 'notice' is not null and not public.qorpera_code_notice_valid(p_request ->> 'notice'))
		or (p_request ? 'andLater' and jsonb_typeof(p_request -> 'andLater') not in ('boolean','null'))
		or (p_request ? 'dryRun' and jsonb_typeof(p_request -> 'dryRun') not in ('boolean','null'))
		or (p_request ? 'runChecks' and jsonb_typeof(p_request -> 'runChecks') not in ('boolean','null'))
		or (p_request ? 'force' and jsonb_typeof(p_request -> 'force') not in ('boolean','null')) then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;

	v_later := coalesce((p_request ->> 'andLater')::boolean, false);
	v_dry_run := coalesce((p_request ->> 'dryRun')::boolean, false);
	v_force := coalesce((p_request ->> 'force')::boolean, false);
	v_run_checks := coalesce((p_request ->> 'runChecks')::boolean, not v_force);

	if p_request ? 'changes' and p_request -> 'changes' <> 'null'::jsonb then
		if (p_request ? 'change' and p_request -> 'change' <> 'null'::jsonb)
			or (p_request ? 'toChange' and p_request -> 'toChange' <> 'null'::jsonb)
			or v_later
			or jsonb_typeof(p_request -> 'changes') <> 'array'
			or jsonb_array_length(p_request -> 'changes') not between 1 and 50
			or exists (
				select 1 from jsonb_array_elements(p_request -> 'changes') as c
				where not (public.qorpera_code_json_count(c) and c #>> '{}' ~ '^[1-9][0-9]{0,8}$')
			) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		select array_agg(distinct (c #>> '{}')::integer order by (c #>> '{}')::integer desc) into v_targets
		from jsonb_array_elements(p_request -> 'changes') as c;
		v_n := v_targets[cardinality(v_targets)];
	else
		if not (p_request ? 'change' and public.qorpera_code_json_count(p_request -> 'change')
			and p_request ->> 'change' ~ '^[1-9][0-9]{0,8}$') then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_n := (p_request ->> 'change')::integer;
		if p_request ? 'toChange' and p_request -> 'toChange' <> 'null'::jsonb then
			if v_later or not (public.qorpera_code_json_count(p_request -> 'toChange')
				and p_request ->> 'toChange' ~ '^[1-9][0-9]{0,8}$') then
				raise exception 'Code request is invalid' using errcode = '22023';
			end if;
			v_to := (p_request ->> 'toChange')::integer;
			if v_to < v_n or (v_to - v_n) >= 50 then
				raise exception 'Code request is invalid' using errcode = '22023';
			end if;
		end if;
	end if;

	v_run := public.qorpera_code_agent_run(p_binding);
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object(
		'schema', 'qorpera.folder-code-undo/v2',
		'runId', v_run.id,
		'request', p_request || jsonb_build_object('notice', p_request -> 'notice')
	)::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(
		p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'),
		false
	);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000';
	end if;

	select * into v_repository from public.qorpera_code_repositories
	where environment_id = v_run.environment_id and owner = p_request ->> 'owner' and name = p_request ->> 'name' for update;
	if not found then raise exception 'No such change' using errcode = 'P0002'; end if;

	if v_to is not null then
		select array_agg(c.n order by c.n desc) into v_targets
		from public.qorpera_code_changes c
		where c.environment_id = v_repository.environment_id and c.owner = v_repository.owner
			and c.name = v_repository.name and c.n between v_n and v_to and c.state = 'landed';
		if v_targets is null or cardinality(v_targets) = 0 then
			raise exception 'No such change' using errcode = 'P0002';
		end if;
		v_n := v_targets[cardinality(v_targets)];
	end if;

	select * into v_change from public.qorpera_code_changes change
	where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
		and change.name = v_repository.name and change.n = v_n;
	if v_change.n is null then raise exception 'No such change' using errcode = 'P0002'; end if;

	if v_targets is not null then
		for v_row in
			select c.* from unnest(v_targets) as t(num)
			left join public.qorpera_code_changes c
				on c.environment_id = v_repository.environment_id and c.owner = v_repository.owner
					and c.name = v_repository.name and c.n = t.num
		loop
			if v_row.n is null then raise exception 'No such change' using errcode = 'P0002'; end if;
			if v_row.state in ('conflict','refused') then v_reason := 'never_landed'; exit;
			elsif v_row.state = 'lost' then v_reason := 'lost'; exit;
			elsif v_row.state = 'reverted' then v_reason := 'already_reverted'; exit;
			elsif v_row.kind = 'restore' then v_reason := 'restore'; exit;
			elsif v_row.main_before is null or (v_row.own_after is not null and v_row.own_before is null) then
				v_reason := 'wall'; exit;
			end if;
		end loop;
	else
		if v_change.state = 'reverted' then
			v_result := jsonb_build_object(
				'schema', 'qorpera.code-request/v1', 'state', 'already',
				'change', v_n, 'undoneBy', v_change.reverted_by
			);
			perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
			return v_result;
		end if;
		v_reason := case
			when v_change.state in ('conflict','refused') then 'never_landed'
			when v_change.state = 'lost' then 'lost'
			when v_change.kind = 'restore' then 'restore'
			when v_change.main_before is null
				or (v_later and exists (
					select 1 from public.qorpera_code_changes change
					where change.environment_id = v_repository.environment_id and change.owner = v_repository.owner
						and change.name = v_repository.name and change.n > v_n and change.kind = 'restore'
				))
				or (not v_later and v_change.own_after is not null and v_change.own_before is null) then 'wall'
		end;
	end if;

	if v_reason is null and not v_dry_run then
		if v_repository.archived_at is not null then
			v_reason := 'archived';
		else
			select * into v_open from public.qorpera_code_requests request
			where request.environment_id = v_repository.environment_id and request.owner = v_repository.owner
				and request.name = v_repository.name
				and ((request.kind = 'undo' and coalesce((request.input ->> 'dryRun')::boolean, false) = false)
					or request.kind = 'restore')
				and request.state in ('queued','running');
			if v_open.id is not null and (
				v_open.kind <> 'undo'
				or v_open.input -> 'change' <> to_jsonb(v_n)
				or coalesce((v_open.input ->> 'andLater')::boolean, false) <> v_later
				or coalesce(v_open.input -> 'targets', 'null'::jsonb) is distinct from coalesce(to_jsonb(v_targets), 'null'::jsonb)
			) then
				v_reason := 'busy';
			end if;
		end if;
	end if;

	if v_reason is null and v_open.id is null and (
		select count(*) from public.qorpera_coding_executors executor
		where executor.environment_id = v_repository.environment_id and executor.enabled
	) <> 1 then
		v_reason := 'no_executor';
	end if;

	if v_reason is not null then
		v_result := jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'refused', 'reason', v_reason);
	else
		v_id := v_open.id;
		if v_id is null then
			insert into public.qorpera_code_requests(
				environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
			)
			values (
				v_repository.environment_id, v_repository.owner, v_repository.name, v_repository.profile_id, 'undo',
				jsonb_build_object(
					'v2', true,
					'change', v_n,
					'andLater', v_later,
					'dryRun', v_dry_run,
					'runChecks', v_run_checks,
					'force', v_force,
					'reason', p_request ->> 'reason',
					'notice', p_request ->> 'notice'
				) || case when v_targets is not null then jsonb_build_object('targets', to_jsonb(v_targets)) else '{}'::jsonb end,
				'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
			)
			returning id into v_id;
			perform public.qorpera_code_requests_notify_internal(v_repository.environment_id, v_id, 'undo');
		end if;
		v_result := jsonb_build_object('schema', 'qorpera.code-request/v1', 'state', 'queued', 'requestId', v_id);
	end if;

	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

create function public.qorpera_folder_code_request_v2(p_binding jsonb, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_request public.qorpera_code_requests%rowtype;
begin
	v_run := public.qorpera_code_agent_run(p_binding);
	select * into v_request from public.qorpera_code_requests request
	where request.id = p_request_id and request.environment_id = v_run.environment_id
		and request.kind <> 'import';
	if not found then raise exception 'No such code request' using errcode = 'P0002'; end if;
	return jsonb_build_object(
		'schema', 'qorpera.code-request/v2',
		'requestId', v_request.id,
		'kind', v_request.kind,
		'state', case when v_request.state = 'expired' then 'done' else v_request.state end,
		'result', v_request.outcome -> 'result',
		'change', v_request.outcome -> 'change',
		'code', v_request.outcome -> 'code',
		'paths', case when v_request.state = 'refused' then v_request.outcome -> 'paths' end,
		'messages', case when v_request.state = 'refused' then v_request.outcome -> 'messages' end,
		'data', case when v_request.state = 'done' then
			case when v_request.kind = 'query' and v_request.outcome ? 'data' then v_request.outcome -> 'data'
			else v_request.outcome - array['schema','state','result','change','code'] end
		end
	);
end $$;

select pg_temp.code_ops_patch(
	'public.qorpera_folder_worker_commit(uuid,jsonb,text,jsonb,jsonb,uuid,uuid)'::regprocedure, array[
	$old$where (v_action <> 'dispatch' or k not in ('harness','owner','repository','species'))$old$,
	$new$where (v_action <> 'dispatch' or k not in ('claimedPaths','harness','owner','repository','species'))$new$,
	$old$or jsonb_typeof(coalesce(p_request -> 'owner', '""')) <> 'string'))$old$,
	$new$or jsonb_typeof(coalesce(p_request -> 'owner', '""')) <> 'string'
			or jsonb_typeof(coalesce(p_request -> 'claimedPaths', '[]')) <> 'array'))$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure, array[
	$old$or (v_species = 'in-house' and (v_request ?| array['repository','owner']$old$,
	$new$or (v_species = 'in-house' and (v_request ?| array['claimedPaths','repository','owner']$new$,
	$old$v_problem := public.qorpera_code_import_problem(p_environment_id, v_request -> 'repository');$old$,
	$new$v_problem := public.qorpera_code_import_problem(p_environment_id, v_request -> 'repository');
			elsif v_species = 'coding' and v_request ? 'claimedPaths'
				and not public.qorpera_code_claimed_paths_json_valid(v_request -> 'claimedPaths') then
				v_problem := 'claimedPaths must be at most 32 valid relative file paths or globs';
			elsif v_species = 'coding' and v_request -> 'repository' ->> 'host' = 'qorpera'
				and exists (select 1 from public.qorpera_code_repositories archived
					where archived.environment_id = p_environment_id
						and archived.owner = v_request -> 'repository' ->> 'owner'
						and archived.name = v_request -> 'repository' ->> 'name'
						and archived.archived_at is not null) then
				v_problem := 'This repository is archived; no new coding sessions can run on it';$new$,
	$old$v_problem := public.qorpera_code_import_problem(p_environment_id,
					(select session.repository from public.qorpera_coding_sessions session where session.worker_id = v_worker.id));$old$,
	$new$v_problem := public.qorpera_code_import_problem(p_environment_id,
					(select session.repository from public.qorpera_coding_sessions session where session.worker_id = v_worker.id));
			elsif v_worker.species = 'coding' and exists (
				select 1 from public.qorpera_coding_sessions session
				join public.qorpera_code_repositories archived
					on archived.environment_id = p_environment_id
						and archived.owner = session.repository ->> 'owner'
						and archived.name = session.repository ->> 'name'
				where session.worker_id = v_worker.id
					and session.repository ->> 'host' = 'qorpera'
					and archived.archived_at is not null
			) then
				v_problem := 'This repository is archived; no new coding sessions can run on it';$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure, array[
	$old$insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, repository, branch)
			values (v_worker.id, p_profile_id, p_environment_id,
				(select run.session_id from public.qorpera_execution_runs run where run.id = v_commit.run_id),
				p_parse ->> 'harness', p_parse -> 'repository', 'qorpera/coding/' || v_worker.id::text);$old$,
	$new$insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, repository, branch, claimed_paths)
			values (v_worker.id, p_profile_id, p_environment_id,
				(select run.session_id from public.qorpera_execution_runs run where run.id = v_commit.run_id),
				p_parse ->> 'harness', p_parse -> 'repository', 'qorpera/coding/' || v_worker.id::text,
				coalesce((select array_agg(e #>> '{}') from jsonb_array_elements(coalesce(v_request -> 'claimedPaths', '[]'::jsonb)) as e), '{}'::text[]));$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)'::regprocedure, array[
	$old$perform public.qorpera_code_import_guard(p_worker);$old$,
	$new$perform public.qorpera_code_import_guard(p_worker);
	perform public.qorpera_code_archived_guard(p_worker);$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_code_request_lease(text)'::regprocedure, array[
	$old$when 'import' then interval '15 minutes'$old$,
	$new$when 'import' then interval '15 minutes'
		when 'query' then interval '2 minutes'
		when 'lifecycle' then interval '5 minutes'$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_code_request_outcome_valid(text,jsonb)'::regprocedure, array[
	$old$select coalesce(jsonb_typeof(p_outcome) = 'object' and pg_column_size(p_outcome) <= 65536$old$,
	$new$select coalesce(jsonb_typeof(p_outcome) = 'object' and pg_column_size(p_outcome) <= 262144$new$,
	$old$			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'undo' then
				p_outcome ?& array['paths'] and p_outcome - array['schema','state','code','paths'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and public.qorpera_code_json_strings(p_outcome -> 'paths', 100)$old$,
	$new$			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'undo' then
				p_outcome ?& array['paths'] and p_outcome - array['schema','state','code','paths','messages'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and public.qorpera_code_json_strings(p_outcome -> 'paths', 100)
				and (not (p_outcome ? 'messages') or public.qorpera_code_json_strings(p_outcome -> 'messages', 30))
			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind in ('query','lifecycle') then
				p_outcome - array['schema','state','code','paths','messages'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and (not (p_outcome ? 'paths') or public.qorpera_code_json_strings(p_outcome -> 'paths', 100))
				and (not (p_outcome ? 'messages') or public.qorpera_code_json_strings(p_outcome -> 'messages', 30))$new$,
	$old$				when 'undo:undone' then
					p_outcome ?& array['filesChanged','paths','pathsMore']
					and p_outcome - array['schema','state','result','mainBefore','mainAfter','filesChanged','paths',
						'pathsMore'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainBefore', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainAfter', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_count(p_outcome -> 'filesChanged') and p_outcome ->> 'filesChanged' ~ '^[0-9]{1,9}$'
					and jsonb_typeof(p_outcome -> 'paths') = 'array' and public.qorpera_code_change_paths_valid(p_outcome -> 'paths')
					and public.qorpera_code_json_count(p_outcome -> 'pathsMore') and p_outcome ->> 'pathsMore' ~ '^[0-9]{1,9}$'$old$,
	$new$				when 'undo:undone' then
					p_outcome ?& array['filesChanged','paths','pathsMore']
					and p_outcome - array['schema','state','result','mainBefore','mainAfter','filesChanged','paths',
						'pathsMore','matchesBeforeTree','checksVerified','siteReused','siteNeedsRebuild'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainBefore', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainAfter', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_count(p_outcome -> 'filesChanged') and p_outcome ->> 'filesChanged' ~ '^[0-9]{1,9}$'
					and jsonb_typeof(p_outcome -> 'paths') = 'array' and public.qorpera_code_change_paths_valid(p_outcome -> 'paths')
					and public.qorpera_code_json_count(p_outcome -> 'pathsMore') and p_outcome ->> 'pathsMore' ~ '^[0-9]{1,9}$'
					and (not (p_outcome ? 'matchesBeforeTree') or jsonb_typeof(p_outcome -> 'matchesBeforeTree') = 'boolean')
					and (not (p_outcome ? 'checksVerified') or coalesce(p_outcome ->> 'checksVerified' in ('passed','inherited','none','off','not_run'), false))
					and (not (p_outcome ? 'siteReused') or jsonb_typeof(p_outcome -> 'siteReused') = 'boolean')
					and (not (p_outcome ? 'siteNeedsRebuild') or jsonb_typeof(p_outcome -> 'siteNeedsRebuild') = 'boolean')
				when 'undo:dry_run' then
					p_outcome ?& array['clean','mainBefore']
					and p_outcome - array['schema','state','result','clean','mainBefore','filesChanged','paths','pathsMore',
						'wouldRevert','matchesBeforeTree','checksFilePresent','conflictedPaths','conflictMessages'] = '{}'::jsonb
					and jsonb_typeof(p_outcome -> 'clean') = 'boolean'
					and public.qorpera_code_json_text(p_outcome -> 'mainBefore', '^[0-9a-f]{40}$')$new$,
	$old$				when 'import:looked' then p_outcome - array['schema','state','result'] = '{}'::jsonb$old$,
	$new$				when 'import:looked' then p_outcome - array['schema','state','result'] = '{}'::jsonb
				when 'query:ok' then
					p_outcome ?& array['data'] and p_outcome - array['schema','state','result','data'] = '{}'::jsonb
					and jsonb_typeof(p_outcome -> 'data') = 'object'
				when 'lifecycle:created' then
					p_outcome - array['schema','state','result','mainSha','created'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
					and (not (p_outcome ? 'created') or jsonb_typeof(p_outcome -> 'created') = 'boolean')
				when 'lifecycle:tagged' then
					p_outcome - array['schema','state','result','tag','kind','sha','targetSha'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'sha', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'targetSha', '^[0-9a-f]{40}$')
				when 'lifecycle:tags' then
					p_outcome ?& array['tags'] and p_outcome - array['schema','state','result','tags'] = '{}'::jsonb
					and jsonb_typeof(p_outcome -> 'tags') = 'array'
				when 'lifecycle:pruned' then
					p_outcome - array['schema','state','result','retiredWorktrees','deletedBranches','skippedWorktrees'] = '{}'::jsonb$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_code_requests_claim(text,text,integer,text[])'::regprocedure, array[
	$old$v_import boolean := false; -- 20260930736000$old$,
	$new$v_import boolean := false; v_targets_meta jsonb; v_repo_row public.qorpera_code_repositories%rowtype; v_prior_site jsonb; v_prior_verified integer;$new$,
	$old$or not p_kinds <@ array['undo','download','restore','import'] then$old$,
	$new$or not p_kinds <@ array['undo','download','restore','import','query','lifecycle'] then$new$,
	$old$		if v_request.kind = 'undo' then
			v_item := v_item || jsonb_build_object('change', jsonb_build_object('n', v_change.n,
					'mainBefore', v_begun -> 'mainBefore', 'mainAfter', v_begun -> 'mainAfter'),
				'andLater', (v_request.input ->> 'andLater')::boolean, 'message', v_begun -> 'message');$old$,
	$new$		if v_request.kind = 'undo' then
			v_item := v_item || jsonb_build_object('change', jsonb_build_object('n', v_change.n,
					'mainBefore', v_begun -> 'mainBefore', 'mainAfter', v_begun -> 'mainAfter'),
				'andLater', coalesce((v_request.input ->> 'andLater')::boolean, false), 'message', v_begun -> 'message');
			if coalesce((v_request.input ->> 'v2')::boolean, false) then
				select * into v_repo_row from public.qorpera_code_repositories repo
				where repo.environment_id = v_request.environment_id and repo.owner = v_request.owner
					and repo.name = v_request.name;
				select max(back.n) into v_prior_verified
				from public.qorpera_code_changes back
				where back.environment_id = v_request.environment_id and back.owner = v_request.owner
					and back.name = v_request.name and back.checks_state in ('passed','inherited')
					and back.main_after = v_begun ->> 'mainBefore';
				select jsonb_build_object('change', back.n, 'tree', back.site ->> 'tree') into v_prior_site
				from public.qorpera_code_changes back
				where back.environment_id = v_request.environment_id and back.owner = v_request.owner
					and back.name = v_request.name and back.checks_state in ('passed','inherited')
					and back.site_state = 'made'
					and back.main_after = v_begun ->> 'mainBefore'
				order by back.n desc limit 1;
				v_targets_meta := null;
				if v_request.input ? 'targets' and jsonb_typeof(v_request.input -> 'targets') = 'array' then
					select coalesce(jsonb_agg(jsonb_build_object(
						'n', c.n,
						'mainBefore', coalesce(c.own_before, c.main_before),
						'mainAfter', case when c.own_before is not null then c.own_after else c.main_after end
					) order by c.n desc), '[]'::jsonb) into v_targets_meta
					from jsonb_array_elements_text(v_request.input -> 'targets') as t(num)
					join public.qorpera_code_changes c
						on c.environment_id = v_request.environment_id and c.owner = v_request.owner
							and c.name = v_request.name and c.n = t.num::integer;
				end if;
				v_item := v_item || jsonb_build_object(
					'dryRun', coalesce((v_request.input ->> 'dryRun')::boolean, false),
					'runChecks', coalesce((v_request.input ->> 'runChecks')::boolean, false),
					'force', coalesce((v_request.input ->> 'force')::boolean, false),
					'checksEnabled', coalesce(v_repo_row.checks_enabled, true),
					'priorVerifiedChange', v_prior_verified,
					'siteConfigured', (v_repo_row.site_id is not null or v_prior_site is not null),
					'priorSite', v_prior_site
				) || case when v_targets_meta is not null then jsonb_build_object('targets', v_targets_meta) else '{}'::jsonb end;
			end if;
		elsif v_request.kind = 'query' then
			v_item := v_item || jsonb_build_object('op', v_request.input ->> 'op', 'query', v_request.input);
		elsif v_request.kind = 'lifecycle' then
			v_item := v_item || jsonb_build_object('op', v_request.input ->> 'op', 'lifecycle', v_request.input);$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_code_request_step(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$	v_generation bigint; v_progress jsonb; v_place boolean; v_step text; v_waiting text; -- 20260930736000$old$,
	$new$	v_generation bigint; v_progress jsonb; v_place boolean; v_step text; v_waiting text; v_candidates jsonb;$new$,
	$old$	return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'go', 'leaseUntil', v_request.lease_until);$old$,
	$new$	if v_request.kind = 'lifecycle' and v_request.input ->> 'op' = 'prune' then
		select coalesce(jsonb_agg(candidate.worker_id order by candidate.worker_id), '[]'::jsonb) into v_candidates
		from (
			select session.worker_id
			from public.qorpera_coding_sessions session
			join public.qorpera_runtime_workers worker on worker.id = session.worker_id
			where session.environment_id = v_request.environment_id
				and session.repository ->> 'host' = 'qorpera'
				and session.repository ->> 'owner' = v_request.owner
				and session.repository ->> 'name' = v_request.name
				and session.archived_at is not null
				and session.attached_machine_id is null
				and session.vm_allocation_id is null
				and worker.state <> 'active'
				and not exists (
					select 1 from public.qorpera_coding_session_turns turn
					where turn.worker_id = session.worker_id and turn.outcome is null
				)
			order by session.archived_at, session.worker_id
			limit 200
		) as candidate;
	end if;
	return jsonb_build_object('schema', 'qorpera.code-request-step/v1', 'state', 'go', 'leaseUntil', v_request.lease_until)
		|| case when v_candidates is not null then jsonb_build_object('candidates', v_candidates) else '{}'::jsonb end;$new$
]);

select pg_temp.code_ops_patch(
	'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure, array[
	$old$			or public.qorpera_code_request_outcome_valid('import', p_outcome))) then$old$,
	$new$			or public.qorpera_code_request_outcome_valid('import', p_outcome)
			or public.qorpera_code_request_outcome_valid('query', p_outcome)
			or public.qorpera_code_request_outcome_valid('lifecycle', p_outcome))) then$new$,
	$old$		elsif v_later then
			v_undoes := public.qorpera_code_changes_take_out(v_repository.environment_id, v_repository.owner,
				v_repository.name, array[v_n], v_target, true);
		else
			perform public.qorpera_code_changes_take_out(v_repository.environment_id, v_repository.owner,
				v_repository.name, array[v_n], v_target, false);
			v_undoes := array[v_target];
		end if;$old$,
	$new$		elsif v_later then
			v_undoes := public.qorpera_code_changes_take_out(v_repository.environment_id, v_repository.owner,
				v_repository.name, array[v_n], v_target, true);
		elsif v_request.input ? 'targets' and jsonb_typeof(v_request.input -> 'targets') = 'array' then
			select coalesce(array_agg((t #>> '{}')::integer order by (t #>> '{}')::integer), '{}'::integer[]) into v_undoes
			from jsonb_array_elements(v_request.input -> 'targets') as t;
			for v_target in select unnest(v_undoes) order by 1 desc loop
				perform public.qorpera_code_changes_take_out(v_repository.environment_id, v_repository.owner,
					v_repository.name, array[v_n], v_target, false);
			end loop;
		else
			perform public.qorpera_code_changes_take_out(v_repository.environment_id, v_repository.owner,
				v_repository.name, array[v_n], v_target, false);
			v_undoes := array[v_target];
		end if;$new$,
	$old$						where v_later and change.main_after = p_outcome ->> 'mainAfter'$old$,
	$new$						where (v_later or coalesce((p_outcome -> 'matchesBeforeTree')::boolean, false))
							and change.main_after = p_outcome ->> 'mainAfter'$new$,
	$old$		v_stored := p_outcome - 'paths' || case when v_unrecorded then '{"unrecorded":true}'::jsonb else '{}'::jsonb end;$old$,
	$new$		v_stored := p_outcome - 'paths' || case when v_unrecorded then '{"unrecorded":true}'::jsonb else '{}'::jsonb end;
	elsif v_request.kind = 'undo' and v_result = 'dry_run' then
		v_stored := p_outcome;
	elsif v_request.kind = 'lifecycle' and v_result = 'created' then
		update public.qorpera_code_repositories
		set last_main = coalesce(last_main, p_outcome ->> 'mainSha')
		where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		v_stored := p_outcome;$new$,
	$old$	if v_state = 'refused' and p_outcome ? 'paths' then
		v_stored := p_outcome || jsonb_build_object('paths', public.qorpera_code_change_fit(p_outcome -> 'paths', 100, 12288));
	end if;$old$,
	$new$	if v_state = 'refused' then
		if p_outcome ? 'paths' then
			v_stored := v_stored || jsonb_build_object('paths', public.qorpera_code_change_fit(p_outcome -> 'paths', 100, 12288));
		end if;
		if p_outcome ? 'messages' then
			v_stored := v_stored || jsonb_build_object('messages', public.qorpera_code_change_fit(p_outcome -> 'messages', 30, 4096));
		end if;
	end if;$new$
]);

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_code_claim_overlaps', 'binding'),
	('qorpera_folder_code_history', 'binding'),
	('qorpera_folder_code_lifecycle', 'binding'),
	('qorpera_folder_code_query', 'binding'),
	('qorpera_folder_code_request_v2', 'binding'),
	('qorpera_folder_code_status', 'binding'),
	('qorpera_folder_request_code_undo_v2', 'binding');

revoke all on function
	public.qorpera_code_claimed_paths_valid(text[]),
	public.qorpera_code_claimed_paths_json_valid(jsonb),
	public.qorpera_code_segment_overlaps(text, text),
	public.qorpera_code_glob_overlaps(text, text),
	public.qorpera_code_paths_overlap(text[], text[]),
	public.qorpera_code_archived_guard(public.qorpera_runtime_workers),
	public.qorpera_surface_prevent_archived_repo(),
	public.qorpera_code_request_wake_topic(text, text),
	public.qorpera_code_requests_notify_internal(uuid, uuid, text),
	public.qorpera_code_resolve_ref_internal(uuid, text, text, jsonb),
	public.qorpera_code_rel_path_valid(text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

revoke all on function
	public.qorpera_code_repository_status(uuid, text, text),
	public.qorpera_folder_code_status(jsonb, text, text),
	public.qorpera_folder_code_claim_overlaps(jsonb, jsonb),
	public.qorpera_folder_code_history(jsonb, jsonb),
	public.qorpera_folder_code_query(jsonb, jsonb),
	public.qorpera_folder_code_lifecycle(jsonb, jsonb),
	public.qorpera_folder_request_code_undo_v2(jsonb, jsonb),
	public.qorpera_folder_code_request_v2(jsonb, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_code_repository_status(uuid, text, text) to authenticated, service_role;

grant execute on function
	public.qorpera_folder_code_status(jsonb, text, text),
	public.qorpera_folder_code_claim_overlaps(jsonb, jsonb),
	public.qorpera_folder_code_history(jsonb, jsonb),
	public.qorpera_folder_code_query(jsonb, jsonb),
	public.qorpera_folder_code_lifecycle(jsonb, jsonb),
	public.qorpera_folder_request_code_undo_v2(jsonb, jsonb),
	public.qorpera_folder_code_request_v2(jsonb, uuid)
	to service_role;

do $$ declare v_owner name; begin
	foreach v_owner in array array(
		select distinct pg_get_userbyid(proowner) from pg_proc where oid in (
			'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
			'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
			'public.qorpera_open_coding_turn(public.qorpera_runtime_workers,text,text,uuid,uuid)'::regprocedure
		)
	) loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception 'A code ops function has an API owner';
		end if;
		if v_owner is distinct from current_user then
			execute format(
				'grant execute on function public.qorpera_code_claimed_paths_valid(text[]), '
				'public.qorpera_code_claimed_paths_json_valid(jsonb), '
				'public.qorpera_code_archived_guard(public.qorpera_runtime_workers) to %I',
				v_owner
			);
		end if;
	end loop;
end $$;
