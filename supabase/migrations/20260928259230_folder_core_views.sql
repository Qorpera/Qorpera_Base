-- Company folder core, C1b-3a: views (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1B.md, section "C1b-3: views").
--
-- Inert for today's companies: everything here runs only for folder-v2 companies, except two small patches that
-- change nothing for them (the commit's rank-0 target, which only F2's hook asks for, and screen_in_use, which
-- reads a table that stays empty until a folder-v2 view opens).
--
-- This slice:
-- * one row per mount (qorpera_folder_views) for run boxes, computer desktops and coding sessions, with a pass, a
--   lease, the view's agent and member, and a kind-specific anchor (§1, §3);
-- * the view actor {kind:'view', viewId, pass} in read, list, the feed, releases and the commit (§2);
-- * open, renew and close (§5); a view's own read set, and inheritance into a run (§6);
-- * the commit's anchor step, taken last and checked under its lock (§3, §4), and the company row at rank 0 (§4).

-- 1. Tables --------------------------------------------------------------------------------------------------------

-- This alters the folder commits table: never queue live readers behind the change (as #502 did for C1b-2 and F2).
set local lock_timeout = '3s';

create table public.qorpera_folder_views (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	-- No foreign key to qorpera_profiles: inserting a view never locks the company row (§4).
	profile_id uuid not null,
	kind text not null check (kind in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine')),
	staff_agent_id uuid not null,
	member_user_id uuid not null,
	worker_access text check (worker_access in ('read','write')),
	run_id uuid,
	job_id uuid,
	runner_id uuid,
	client_lease_id uuid,
	screen_id uuid,
	screen_generation bigint,
	activation_id uuid,
	holder_run_id uuid,
	holder_user_id uuid,
	worker_id uuid,
	attachment_token uuid,
	node_id text,
	machine_id uuid,
	pass_sha256 bytea not null check (octet_length(pass_sha256) = 32),
	state text not null default 'open' check (state in ('open','closed')),
	lease_until timestamptz not null,
	renewed_at timestamptz not null default clock_timestamp(),
	unsaved_since timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	closed_at timestamptz,
	close_reason text check (close_reason in ('closed','superseded','ended','expired')),
	check ((state = 'closed') = (closed_at is not null) and (state = 'closed') = (close_reason is not null)),
	check (kind <> 'run_box' or (run_id is not null and job_id is not null and runner_id is not null and client_lease_id is not null)),
	check (kind <> 'computer_desktop' or (screen_id is not null and screen_generation is not null and activation_id is not null
		and (holder_run_id is null) <> (holder_user_id is null))),
	check (kind <> 'coding_session' or (worker_id is not null and attachment_token is not null)),
	-- Shell commands and test machines arrive with C1b-3b.
	check (kind in ('run_box','computer_desktop','coding_session'))
);
create unique index qorpera_folder_views_open_screen on public.qorpera_folder_views(screen_id) where state = 'open';
create unique index qorpera_folder_views_open_coding on public.qorpera_folder_views(worker_id) where state = 'open';
create unique index qorpera_folder_views_open_run_box on public.qorpera_folder_views(job_id, runner_id, client_lease_id)
	where state = 'open' and kind = 'run_box';
create index qorpera_folder_views_node on public.qorpera_folder_views(node_id) where state = 'open';
-- A machine's views, newest first: open carries the previous one's read set.
create index qorpera_folder_views_screen_history on public.qorpera_folder_views(screen_id, created_at desc) where screen_id is not null;
create index qorpera_folder_views_worker_history on public.qorpera_folder_views(worker_id, created_at desc) where worker_id is not null;

-- A view's own read set, read records and release ids: the run's tables (C1b-2 §3), keyed by view.
create table public.qorpera_folder_view_reads (
	view_id uuid not null references public.qorpera_folder_views(id) on delete cascade,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	grant_id uuid,
	resource_revision bigint not null,
	grant_revision bigint,
	updated_at timestamptz not null default clock_timestamp(),
	check ((grant_id is null) = (grant_revision is null))
);
create unique index qorpera_folder_view_reads_key on public.qorpera_folder_view_reads(view_id, resource_id, grant_id) nulls not distinct;
create table public.qorpera_folder_view_read_records (
	view_id uuid not null references public.qorpera_folder_views(id) on delete cascade,
	release_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	resource_id uuid not null,
	reads jsonb not null check (jsonb_typeof(reads) = 'array'),
	output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (view_id, release_id, resource_id)
);
create table public.qorpera_folder_view_releases (
	view_id uuid not null references public.qorpera_folder_views(id) on delete cascade,
	release_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
	result jsonb not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (view_id, release_id)
);
-- Inheritance ids: a run takes in a view's reads once per id.
create table public.qorpera_folder_run_inheritances (
	run_id uuid not null,
	inherit_id uuid not null,
	environment_id uuid not null references public.qorpera_folder_clocks(environment_id) on delete cascade,
	view_id uuid not null,
	result jsonb not null,
	created_at timestamptz not null default clock_timestamp(),
	primary key (run_id, inherit_id)
);
alter table public.qorpera_folder_views enable row level security;
alter table public.qorpera_folder_view_reads enable row level security;
alter table public.qorpera_folder_view_read_records enable row level security;
alter table public.qorpera_folder_view_releases enable row level security;
alter table public.qorpera_folder_run_inheritances enable row level security;
revoke all on public.qorpera_folder_views, public.qorpera_folder_view_reads, public.qorpera_folder_view_read_records,
	public.qorpera_folder_view_releases, public.qorpera_folder_run_inheritances from public, anon, authenticated, service_role;

-- Commits by views: the view, and a staff actor without a run when the view is detached (§7).
alter table public.qorpera_folder_commits add column view_id uuid, add column view_kind text
	check (view_kind in ('run_box','computer_desktop','computer_shell_command','coding_session','test_machine'));
-- A coding view's save during a leased turn records that turn, for attribution only; the save acts detached (§6).
alter table public.qorpera_folder_commits add column turn_run_id uuid;
alter table public.qorpera_folder_commits add constraint qorpera_folder_commits_turn_run check (
	turn_run_id is null or (view_kind = 'coding_session' and run_id is null));
alter table public.qorpera_folder_commits drop constraint qorpera_folder_commits_run_attribution;
alter table public.qorpera_folder_commits add constraint qorpera_folder_commits_run_attribution check (
	((actor_kind = 'staff_agent') = (run_id is not null) or (actor_kind = 'staff_agent' and run_id is null and view_id is not null))
	and (actor_kind = 'staff_agent') = (session_kind is not null)
	and (routine_id is null) = (routine_version is null)
	and (view_id is null) = (view_kind is null));

-- 2. Validity and the view actor (§2, §3) ----------------------------------------------------------------------------

-- Whether a view still names the same owner period of its anchor (§3). Plain reads: the early check in resolve and
-- renew, and the re-check after the commit's anchor lock, in a new statement.
create function public.qorpera_folder_view_valid(p_view public.qorpera_folder_views)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_view.state = 'open' and p_view.lease_until > clock_timestamp() and case p_view.kind
		when 'run_box' then exists (select 1 from public.qorpera_runner_jobs j
			where j.id = p_view.job_id and j.run_id = p_view.run_id and j.status = 'leased' and j.runner_id = p_view.runner_id
				and j.client_lease_id = p_view.client_lease_id and j.lease_expires_at > clock_timestamp())
		when 'computer_desktop' then exists (select 1 from public.qorpera_runtime_office_screens s
			join public.qorpera_runtime_offices o on o.id = s.office_id
			where s.id = p_view.screen_id and s.generation = p_view.screen_generation
				-- Held by the view's holder or by nobody, with privacy that admits it; or a drain still pending, which
				-- is the old holder's final publish (§3, the end boundary).
				and (s.drain_pending or (
					((s.run_id is null and s.takeover_user_id is null)
						or (p_view.holder_run_id is not null and s.run_id = p_view.holder_run_id)
						or (p_view.holder_user_id is not null and s.takeover_user_id = p_view.holder_user_id))
					and (o.privacy_state = 'shared' or (p_view.holder_user_id is not null
						and o.privacy_challenge ->> 'memberId' = p_view.holder_user_id::text
						and o.privacy_challenge ->> 'screenId' = p_view.screen_id::text))))
				and exists (select 1 from public.qorpera_runtime_office_activations a
					where a.activation_id = p_view.activation_id and a.office_id = o.id and a.superseded_at is null)
				and exists (select 1 from public.qorpera_runtime_office_access x
					where x.office_id = o.id and x.staff_agent_id = p_view.staff_agent_id and x.state = 'active'))
		when 'coding_session' then exists (select 1 from public.qorpera_coding_sessions cs
			join public.qorpera_runtime_workers w on w.id = cs.worker_id
			join public.qorpera_coding_machines m on m.id = cs.attached_machine_id
			where cs.worker_id = p_view.worker_id and cs.attachment_token = p_view.attachment_token
				and public.qorpera_coding_attachment_refusal(cs, w, m) is null)
		else false end
$$;

-- The run a view acts through, if one is live: a run box's run; a desktop's holder run while it still holds the
-- screen; for a coding session, its worker's leased turn (for read sets and attribution only, §6).
create function public.qorpera_folder_view_live_run(p_view public.qorpera_folder_views)
returns jsonb language sql stable security definer set search_path = '' as $$
	select case p_view.kind
		when 'run_box' then jsonb_build_object('kind','run','runId',p_view.run_id,'jobId',p_view.job_id,
			'runnerId',p_view.runner_id,'assignmentId',p_view.client_lease_id)
		when 'computer_desktop' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,
				'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
			from public.qorpera_runtime_office_screens s
			join public.qorpera_execution_runs r on r.id = s.run_id
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where s.id = p_view.screen_id and p_view.holder_run_id is not null and s.run_id = p_view.holder_run_id
				and s.lease_expires_at > clock_timestamp() and j.status = 'leased' and j.lease_expires_at > clock_timestamp())
		when 'coding_session' then (select jsonb_build_object('kind','run','runId',r.id,'jobId',j.id,
				'runnerId',j.runner_id,'assignmentId',j.client_lease_id)
			from public.qorpera_wake_occurrences o
			join public.qorpera_execution_runs r on r.id = o.run_id
			join public.qorpera_runner_jobs j on j.id = r.job_id
			where o.wake_kind = 'agent' and o.source_kind = 'worker-dispatch' and o.source_id = p_view.worker_id
				and j.status = 'leased' and j.lease_expires_at > clock_timestamp()
			order by j.lease_expires_at desc limit 1)
	end
$$;

-- Resolves {kind:'view', viewId, pass} (§2). The early check refuses quickly; the commit's anchor step is the
-- guarantee. Returns a resolved actor like a run's, with view: {id, kind, companyWide} and, when a run is live and
-- the view acts through it, the run's lockTargets and attribution.
create function public.qorpera_folder_view_resolve(p_environment_id uuid, p_profile_id uuid, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_view public.qorpera_folder_views%rowtype; v_run jsonb; v_resolved jsonb; v_view_json jsonb;
begin
	if p_actor - array['kind','viewId','pass'] <> '{}'::jsonb
		or coalesce(p_actor ->> 'viewId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		or coalesce(p_actor ->> 'pass', '') !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	select * into v_view from public.qorpera_folder_views where id = (p_actor ->> 'viewId')::uuid;
	if not found or v_view.environment_id <> p_environment_id or v_view.profile_id <> p_profile_id
		or v_view.pass_sha256 <> extensions.digest(p_actor ->> 'pass', 'sha256') then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	if not public.qorpera_folder_view_valid(v_view) then
		raise exception 'Folder view has ended' using errcode = '42501'; end if;
	v_view_json := jsonb_build_object('id', v_view.id, 'kind', v_view.kind, 'companyWide', v_view.kind = 'computer_desktop');
	-- A member-held desktop acts as the member, within the company-wide view; members are not stopped by the pause.
	if v_view.holder_user_id is not null then
		if not exists (select 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_view.holder_user_id) then
			raise exception 'Folder view member is unavailable' using errcode = '42501'; end if;
		return jsonb_build_object('kind','member','userId',v_view.holder_user_id,'view',v_view_json);
	end if;
	-- Every other view acts as an agent, which the pause stops.
	if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = p_profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	v_run := public.qorpera_folder_view_live_run(v_view);
	if v_view.kind = 'run_box' or (v_view.kind = 'computer_desktop' and v_run is not null) then
		v_resolved := public.qorpera_folder_run_resolve(p_environment_id, p_profile_id, v_run);
		return v_resolved || jsonb_build_object('view', v_view_json || jsonb_build_object('runActor', v_run));
	end if;
	-- Detached: a desktop whose run has ended, or a coding session. The agent and member must still stand.
	if not exists (select 1 from public.qorpera_profile_staff where profile_id = p_profile_id
			and staff_agent_id = v_view.staff_agent_id and employment_status = 'active')
		or not exists (select 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_view.member_user_id) then
		raise exception 'Folder view agent is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('kind','staff_agent','staffAgentId',v_view.staff_agent_id,'requesterUserId',v_view.member_user_id,
		'audience',jsonb_build_object('kind','company'),
		'sessionKind',case when v_view.kind = 'coding_session' then 'coding' else 'in_house' end,
		'workerAccess',v_view.worker_access,'runId',null,
		'view',v_view_json || jsonb_build_object('turnRunActor', case when v_view.kind = 'coding_session' then v_run end));
end $$;

-- Reads, listings and the feed take view actors too.
create or replace function public.qorpera_folder_read_actor(p_environment_id uuid, p_actor jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile uuid;
begin
	if p_actor ->> 'kind' = 'platform' and p_actor - array['kind'] = '{}'::jsonb then return null; end if;
	if p_actor ->> 'kind' = 'member' and p_actor - array['kind','userId'] = '{}'::jsonb
		and coalesce(p_actor ->> 'userId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return p_actor; end if;
	select profile_id into v_profile from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2';
	if p_actor ->> 'kind' = 'view' then
		if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
		return public.qorpera_folder_view_resolve(p_environment_id, v_profile, p_actor) - 'lockTargets' - 'attribution';
	end if;
	if p_actor ->> 'kind' is distinct from 'run' or p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
		or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
			where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if v_profile is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_profile) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	return public.qorpera_folder_run_resolve(p_environment_id, v_profile, p_actor) - 'lockTargets' - 'attribution';
end $$;

-- The company-wide view (§2): a desktop view may use only paths whose covering resource is the root, or rules/ for
-- reads. Checked before the early returns for member and platform actors, on top of the actor's own authority.
create or replace function public.qorpera_folder_actor_resource_allowed(p_profile_id uuid, p_actor jsonb,
	p_resource public.qorpera_company_path_resources, p_permission text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_requester uuid; v_staff uuid;
begin
	if p_resource.id is null then return false; end if;
	if (p_actor -> 'view' ->> 'companyWide')::boolean
		and not ((p_resource.path = '' and p_resource.scope = 'company_shared')
			or (p_resource.scope = 'company_rules' and p_permission = 'read')) then return false; end if;
	if p_actor ->> 'kind' = 'platform' then return true; end if;
	if p_actor ->> 'kind' = 'member' then
		return public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'member', (p_actor ->> 'userId')::uuid, p_permission);
	end if;
	if p_actor ->> 'kind' is distinct from 'staff_agent' then return false; end if;
	-- An in-house worker with read access writes nothing. A coding worker's access is always 'read' (dispatch forces
	-- it, 20260922230000:376-378); there it names the dispatch's sources, not folder writes.
	if p_permission = 'write' and p_actor ->> 'sessionKind' = 'in_house' and p_actor ->> 'workerAccess' = 'read' then
		return false; end if;
	v_requester := (p_actor ->> 'requesterUserId')::uuid; v_staff := (p_actor ->> 'staffAgentId')::uuid;
	if not public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'member', v_requester, p_permission) then
		return false; end if;
	if p_actor -> 'audience' ->> 'kind' = 'company' then
		return p_resource.scope <> 'member_private'
			and public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'staff_agent', v_staff, p_permission);
	elsif p_actor -> 'audience' ->> 'kind' = 'member_private' then
		return (p_actor -> 'audience' ->> 'userId')::uuid is not distinct from v_requester
			and (p_resource.scope <> 'member_private' or p_resource.owner_user_id = v_requester)
			and public.qorpera_folder_principal_allowed(p_profile_id, p_resource, 'staff_agent', v_staff, p_permission);
	end if;
	return false;
end $$;

-- 3. Open, renew and close (§5) --------------------------------------------------------------------------------------

-- A new pass: 32 random bytes, base64url without padding. Only its sha256 is kept.
create function public.qorpera_folder_view_new_pass()
returns text language sql volatile set search_path = '' as $$
	select rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=')
$$;

-- Opens a view and returns {viewId, pass, leaseUntil}. For a run box the opener is the run actor; for a desktop or a
-- coding session it is the platform (the office service or the coding executor), naming the anchor. Everything else
-- (agent, member, worker access, activation, machine, node) is derived from the anchor.
create function public.qorpera_folder_view_open(p_environment_id uuid, p_opener jsonb, p_kind text, p_anchor jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_resolved jsonb; v_view public.qorpera_folder_views%rowtype;
	v_screen public.qorpera_runtime_office_screens%rowtype; v_office public.qorpera_runtime_offices%rowtype;
	v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_holder_run uuid; v_holder_user uuid; v_member uuid; v_staff uuid; v_access text; v_activation uuid; v_machine uuid;
	v_node text; v_pass text; v_root public.qorpera_company_path_resources%rowtype; v_previous uuid;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder views open at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_kind not in ('run_box','computer_desktop','coding_session') or jsonb_typeof(p_anchor) is distinct from 'object' then
		raise exception 'Folder view is invalid' using errcode = '22023'; end if;
	v_pass := public.qorpera_folder_view_new_pass();

	if p_kind = 'run_box' then
		-- The run's own box: the run actor opens it, under the run check (pause, job KEY SHARE, fence, principals).
		v_resolved := public.qorpera_folder_run_enter(p_environment_id, v_file.profile_id, p_opener);
		insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access,
			run_id, job_id, runner_id, client_lease_id, pass_sha256, lease_until)
		values (p_environment_id, v_file.profile_id, 'run_box', (v_resolved ->> 'staffAgentId')::uuid,
			(v_resolved ->> 'requesterUserId')::uuid, v_resolved ->> 'workerAccess', (p_opener ->> 'runId')::uuid,
			(p_opener ->> 'jobId')::uuid, (p_opener ->> 'runnerId')::uuid, (p_opener ->> 'assignmentId')::uuid,
			extensions.digest(v_pass, 'sha256'), clock_timestamp() + interval '120 seconds')
		returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until);
	end if;

	if p_opener is distinct from '{"kind":"platform"}'::jsonb then
		raise exception 'Folder view opener is invalid' using errcode = '22023'; end if;

	if p_kind = 'computer_desktop' then
		if coalesce(p_anchor ->> 'screenId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or (p_anchor ? 'holderRunId') = (p_anchor ? 'holderUserId') then
			raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		v_holder_run := (p_anchor ->> 'holderRunId')::uuid; v_holder_user := (p_anchor ->> 'holderUserId')::uuid;
		-- The screen's older views first (the open one, and the newest, whose read set this view carries), which waits
		-- out their last save and release; then the screen; then the checks, in new statements.
		perform 1 from public.qorpera_folder_views where screen_id = (p_anchor ->> 'screenId')::uuid and (state = 'open'
			or id = (select v.id from public.qorpera_folder_views v where v.screen_id = (p_anchor ->> 'screenId')::uuid
				order by v.created_at desc, v.id desc limit 1)) for update;
		perform 1 from public.qorpera_runtime_office_screens where id = (p_anchor ->> 'screenId')::uuid for share;
		select * into v_screen from public.qorpera_runtime_office_screens where id = (p_anchor ->> 'screenId')::uuid;
		select * into v_office from public.qorpera_runtime_offices where id = v_screen.office_id;
		-- coalesce: a screen with no holder must refuse, not compare to null.
		if v_screen.id is null or v_office.environment_id <> p_environment_id or v_screen.drain_pending
			or not coalesce(
				(v_holder_run is not null and v_screen.run_id = v_holder_run and v_screen.lease_expires_at > clock_timestamp()
					and v_office.privacy_state = 'shared')
				or (v_holder_user is not null and (v_screen.takeover_user_id = v_holder_user
					or (v_office.privacy_state in ('entering','private') and v_office.privacy_challenge ->> 'memberId' = v_holder_user::text
						and v_office.privacy_challenge ->> 'screenId' = v_screen.id::text))), false) then
			raise exception 'Folder view holder is not current' using errcode = '42501'; end if;
		v_staff := v_screen.staff_agent_id;
		if v_holder_run is not null then
			select requested_by_user_id into v_member from public.qorpera_execution_runs where id = v_holder_run;
			v_access := (public.qorpera_run_worker(v_holder_run)).access;
		else
			v_member := v_holder_user;
		end if;
		select a.activation_id, a.allocation_id into v_activation, v_machine from public.qorpera_runtime_office_activations a
		where a.office_id = v_office.id and a.superseded_at is null order by a.computer_generation desc limit 1;
		if v_activation is null or not exists (select 1 from public.qorpera_runtime_office_access x
			where x.office_id = v_office.id and x.staff_agent_id = v_staff and x.state = 'active') then
			raise exception 'Folder view computer is unavailable' using errcode = '42501'; end if;
	else
		if coalesce(p_anchor ->> 'workerId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or coalesce(p_anchor ->> 'attachmentToken', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Folder view anchor is invalid' using errcode = '22023'; end if;
		perform 1 from public.qorpera_folder_views where worker_id = (p_anchor ->> 'workerId')::uuid and (state = 'open'
			or id = (select v.id from public.qorpera_folder_views v where v.worker_id = (p_anchor ->> 'workerId')::uuid
				order by v.created_at desc, v.id desc limit 1)) for update;
		perform 1 from public.qorpera_coding_sessions where worker_id = (p_anchor ->> 'workerId')::uuid for share;
		select * into v_session from public.qorpera_coding_sessions where worker_id = (p_anchor ->> 'workerId')::uuid;
		select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
		if v_session.worker_id is null or v_session.environment_id <> p_environment_id
			or v_session.attachment_token is distinct from (p_anchor ->> 'attachmentToken')::uuid
			or public.qorpera_coding_attachment_refusal(v_session, v_worker,
				(select m from public.qorpera_coding_machines m where m.id = v_session.attached_machine_id)) is not null then
			raise exception 'Folder view attachment is not current' using errcode = '42501'; end if;
		v_staff := v_worker.staff_agent_id; v_member := v_worker.owner_user_id; v_access := v_worker.access;
		select id into v_machine from public.qorpera_runtime_machine_allocations where coding_machine_id = v_session.attached_machine_id;
	end if;
	select node_id into v_node from public.qorpera_runtime_node_demands where allocation_id = v_machine and released_at is null;

	-- The principals, and for a desktop the company-wide view: the agent and the member both read the root resource.
	if not exists (select 1 from public.qorpera_profile_staff where profile_id = v_file.profile_id and staff_agent_id = v_staff
			and employment_status = 'active')
		or not exists (select 1 from public.qorpera_profile_members where profile_id = v_file.profile_id and user_id = v_member) then
		raise exception 'Folder view principals are unavailable' using errcode = '42501'; end if;
	if p_kind = 'computer_desktop' then
		select * into v_root from public.qorpera_company_path_resources where environment_id = p_environment_id and path = '';
		if not public.qorpera_folder_principal_allowed(v_file.profile_id, v_root, 'member', v_member, 'read')
			or not public.qorpera_folder_principal_allowed(v_file.profile_id, v_root, 'staff_agent', v_staff, 'read') then
			raise exception 'Folder view needs the company-wide view' using errcode = '42501'; end if;
	end if;

	-- The machine's previous view, open or not (locked above): its read set follows the machine while the machine runs
	-- on (§6). A desktop carries it within one seat assignment and one power-on (the same generation and activation); a
	-- coding session while it stays on the same machine. A restart, a seat changing agent or a move to another machine
	-- starts clean: that is also the way out for a machine whose programs saw a file that has since been narrowed.
	select id into v_previous from (select v.* from public.qorpera_folder_views v
		where v.environment_id = p_environment_id and ((p_kind = 'computer_desktop' and v.screen_id = v_screen.id)
			or (p_kind = 'coding_session' and v.worker_id = v_session.worker_id))
		order by v.created_at desc, v.id desc limit 1) newest
	where (p_kind = 'computer_desktop' and newest.screen_generation = v_screen.generation and newest.activation_id = v_activation)
		or (p_kind = 'coding_session' and newest.machine_id = v_machine);
	update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'superseded'
	where state = 'open' and ((p_kind = 'computer_desktop' and screen_id = v_screen.id)
		or (p_kind = 'coding_session' and worker_id = v_session.worker_id));
	insert into public.qorpera_folder_views(environment_id, profile_id, kind, staff_agent_id, member_user_id, worker_access,
		screen_id, screen_generation, activation_id, holder_run_id, holder_user_id, worker_id, attachment_token, node_id, machine_id,
		pass_sha256, lease_until)
	values (p_environment_id, v_file.profile_id, p_kind, v_staff, v_member, v_access,
		v_screen.id, v_screen.generation, v_activation, v_holder_run, v_holder_user, v_session.worker_id, v_session.attachment_token,
		v_node, v_machine, extensions.digest(v_pass, 'sha256'), clock_timestamp() + interval '120 seconds')
	returning * into v_view;
	-- The programs still hold what they read through the previous view: its pairs and its read records (one record per
	-- resource, keyed by the new view's id) move to the new view, which rechecks them on every save.
	if v_previous is not null then
		insert into public.qorpera_folder_view_reads(view_id, environment_id, resource_id, grant_id, resource_revision, grant_revision)
		select v_view.id, environment_id, resource_id, grant_id, resource_revision, grant_revision
		from public.qorpera_folder_view_reads where view_id = v_previous;
		insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
		select v_view.id, v_view.id, p_environment_id, rec.resource_id,
			jsonb_agg(distinct x order by x), repeat('0', 64)
		from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
		where rec.view_id = v_previous group by rec.resource_id;
	end if;
	return jsonb_build_object('schema','qorpera.folder-view/v1','viewId',v_view.id,'pass',v_pass,'leaseUntil',v_view.lease_until);
end $$;

-- Renews a view for 120 s, with the folder service's unsaved_since. A view that no longer matches its anchor, or whose
-- principals are gone, is closed ('ended') and reported, not raised, so the close stays.
create function public.qorpera_folder_view_renew(p_view_id uuid, p_pass text, p_unsaved_since timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype; v_ok boolean;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_view from public.qorpera_folder_views where id = p_view_id for no key update;
	if not found or v_view.pass_sha256 <> extensions.digest(coalesce(p_pass, ''), 'sha256') then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	if v_view.state = 'closed' then
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason); end if;
	v_ok := public.qorpera_folder_view_valid(v_view)
		and exists (select 1 from public.qorpera_profile_staff where profile_id = v_view.profile_id
			and staff_agent_id = v_view.staff_agent_id and employment_status = 'active')
		and exists (select 1 from public.qorpera_profile_members where profile_id = v_view.profile_id and user_id = v_view.member_user_id);
	if not v_ok then
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(),
			close_reason = case when v_view.lease_until <= clock_timestamp() then 'expired' else 'ended' end
		where id = v_view.id returning * into v_view;
		return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','closed','reason',v_view.close_reason);
	end if;
	update public.qorpera_folder_views set lease_until = clock_timestamp() + interval '120 seconds', renewed_at = clock_timestamp(),
		unsaved_since = p_unsaved_since
	where id = v_view.id returning * into v_view;
	return jsonb_build_object('schema','qorpera.folder-view-renew/v1','state','open','leaseUntil',v_view.lease_until);
end $$;

create function public.qorpera_folder_view_close(p_view_id uuid, p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_view public.qorpera_folder_views%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	select * into v_view from public.qorpera_folder_views where id = p_view_id for update;
	if not found or v_view.pass_sha256 <> extensions.digest(coalesce(p_pass, ''), 'sha256') then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	if v_view.state = 'open' then
		update public.qorpera_folder_views set state = 'closed', closed_at = clock_timestamp(), close_reason = 'closed'
		where id = v_view.id returning * into v_view;
	end if;
	return jsonb_build_object('schema','qorpera.folder-view-close/v1','state','closed','reason',v_view.close_reason);
end $$;

-- 4. Reads and releases (§6) -----------------------------------------------------------------------------------------

-- The receipt check of C1b-2's record_release, for any actor: per (resource, grant) a pair passes when its resource
-- covers each path now at the receipt's revision and its grant is null only on rules/ (else a live read grant of the
-- actor's agent on that resource version); otherwise each path is re-resolved, check and receipt in one statement,
-- and a path no longer readable raises 42501. Returns {upserts, filed}: the read-set pairs and the reads with their
-- receipts.
create function public.qorpera_folder_release_pairs(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_reads jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_group record; v_read jsonb; v_receipt jsonb; v_pass boolean; v_ok boolean; v_upserts jsonb := '[]'::jsonb;
	v_filed jsonb := '[]'::jsonb;
begin
	for v_group in
		select (r -> 'authority' ->> 'resourceId')::uuid as resource_id, (r -> 'authority' ->> 'grantId')::uuid as grant_id,
			(r -> 'authority' ->> 'resourceRevision')::bigint as rrev, (r -> 'authority' ->> 'grantRevision')::bigint as grev,
			jsonb_agg(r) as reads
		from jsonb_array_elements(p_reads) r group by 1, 2, 3, 4
	loop
		select exists (select 1 from public.qorpera_company_path_resources res
				where res.id = v_group.resource_id and res.environment_id = p_environment_id and res.authority_revision = v_group.rrev
					and not exists (select 1 from jsonb_array_elements(v_group.reads) x
						where (public.qorpera_folder_path_resource(p_environment_id, x ->> 'path')).id is distinct from res.id)
					and case when v_group.grant_id is null then res.scope = 'company_rules'
						else exists (select 1 from public.qorpera_company_path_grants g
							where g.id = v_group.grant_id and g.revision = v_group.grev and g.resource_id = res.id
								and g.resource_version = res.version and g.principal_kind = 'staff_agent'
								and g.principal_id = (p_actor ->> 'staffAgentId')::uuid and 'read' = any (g.permissions)
								and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())) end)
				-- The company-wide view: a desktop view's pair passes only on the root or rules/.
				and (not coalesce((p_actor -> 'view' ->> 'companyWide')::boolean, false) or exists (select 1
					from public.qorpera_company_path_resources res where res.id = v_group.resource_id
						and ((res.path = '' and res.scope = 'company_shared') or res.scope = 'company_rules')))
		into v_pass;
		if v_pass then
			v_upserts := v_upserts || jsonb_build_array(jsonb_build_object('resourceId', v_group.resource_id, 'grantId', v_group.grant_id,
				'resourceRevision', v_group.rrev, 'grantRevision', v_group.grev));
			v_filed := v_filed || v_group.reads;
		else
			for v_read in select value from jsonb_array_elements(v_group.reads) loop
				-- The check and the receipt in one statement: the receipt is never newer than the check (C1b-2).
				select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_read ->> 'path', 'read'),
					public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_read ->> 'path')
				into v_ok, v_receipt;
				if not v_ok then raise exception 'A released read is no longer readable' using errcode = '42501'; end if;
				v_upserts := v_upserts || jsonb_build_array(v_receipt);
				v_filed := v_filed || jsonb_build_array(v_read || jsonb_build_object('authority', v_receipt));
			end loop;
		end if;
	end loop;
	return jsonb_build_object('upserts', v_upserts, 'filed', v_filed);
end $$;

-- Rank 10 for a view's own read set: C1b-2's write_read_set, keyed by view.
create function public.qorpera_folder_view_write_read_set(p_environment_id uuid, p_view_id uuid, p_upserts jsonb, p_restamps jsonb,
	p_deletes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item record;
begin
	for v_item in
		select 'upsert' as op, (u ->> 'resourceId')::uuid as resource_id, (u ->> 'grantId')::uuid as grant_id,
			min((u ->> 'resourceRevision')::bigint) as rrev, min((u ->> 'grantRevision')::bigint) as grev, null::bigint as old_rrev,
			null::bigint as old_grev
		from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) u group by 2, 3
		union all
		select 'restamp', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, (u ->> 'resourceRevision')::bigint,
			(u ->> 'grantRevision')::bigint, (u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_restamps, '[]'::jsonb)) u
		union all
		select 'delete', (u ->> 'resourceId')::uuid, (u ->> 'grantId')::uuid, null, null,
			(u ->> 'recordedResourceRevision')::bigint, (u ->> 'recordedGrantRevision')::bigint
		from jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) u
		order by 2, 3 nulls first, 1 desc
	loop
		if v_item.op = 'upsert' then
			insert into public.qorpera_folder_view_reads(view_id, environment_id, resource_id, grant_id, resource_revision, grant_revision)
			values (p_view_id, p_environment_id, v_item.resource_id, v_item.grant_id, v_item.rrev, v_item.grev)
			on conflict (view_id, resource_id, grant_id) do update set
				resource_revision = least(public.qorpera_folder_view_reads.resource_revision, excluded.resource_revision),
				grant_revision = least(public.qorpera_folder_view_reads.grant_revision, excluded.grant_revision),
				updated_at = clock_timestamp();
		elsif v_item.op = 'restamp' then
			update public.qorpera_folder_view_reads set resource_revision = v_item.rrev, grant_revision = v_item.grev, updated_at = clock_timestamp()
			where view_id = p_view_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		else
			delete from public.qorpera_folder_view_reads
			where view_id = p_view_id and resource_id = v_item.resource_id and grant_id is not distinct from v_item.grant_id
				and resource_revision = v_item.old_rrev and grant_revision is not distinct from v_item.old_grev;
		end if;
	end loop;
end $$;

-- The recheck for a view's own read set (§6): C1b-2's run_reads_current, keyed by view, for the view's resolved actor.
create function public.qorpera_folder_view_reads_current(p_environment_id uuid, p_profile_id uuid, p_view_id uuid, p_actor jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
	v_row record; v_prefixes text[]; v_path text; v_receipt jsonb; v_ok boolean;
	v_upserts jsonb := '[]'::jsonb; v_restamps jsonb := '[]'::jsonb; v_deletes jsonb := '[]'::jsonb; v_changed integer := 0;
begin
	for v_row in
		select rr.resource_id, rr.grant_id, rr.resource_revision, rr.grant_revision,
			r.id is not null as resource_exists, r.authority_revision as current_rrev, r.path as resource_path,
			(rr.grant_id is null and r.scope is distinct from 'company_rules') as grant_missing,
			g.revision as current_grev,
			(g.id is not null and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())) as grant_live
		from public.qorpera_folder_view_reads rr
		left join public.qorpera_company_path_resources r on r.id = rr.resource_id
		left join public.qorpera_company_path_grants g on g.id = rr.grant_id
		where rr.view_id = p_view_id
		order by rr.resource_id, rr.grant_id nulls first
	loop
		if v_row.resource_exists and v_row.current_rrev = v_row.resource_revision and not v_row.grant_missing
			and (v_row.grant_id is null or (v_row.grant_live and v_row.current_grev = v_row.grant_revision)) then continue; end if;
		v_changed := v_changed + 1;
		if not v_row.resource_exists then
			v_prefixes := null;
		elsif v_row.grant_missing
			or (v_row.grant_id is not null and (not v_row.grant_live or v_row.current_grev is distinct from v_row.grant_revision)) then
			v_prefixes := array[public.qorpera_folder_key(v_row.resource_path)];
		else
			select array_agg(distinct c.prefix) into v_prefixes from public.qorpera_folder_authority_changes c
			where c.environment_id = p_environment_id and c.resource_id = v_row.resource_id and c.revision > v_row.resource_revision;
			v_prefixes := coalesce(v_prefixes, array[public.qorpera_folder_key(v_row.resource_path)]);
		end if;
		for v_path in
			select distinct x ->> 'path' from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x
			where rec.view_id = p_view_id and (
				(v_prefixes is null and rec.resource_id = v_row.resource_id)
				or exists (select 1 from unnest(v_prefixes) p(prefix)
					where public.qorpera_folder_key_under(public.qorpera_folder_key(x ->> 'path'), p.prefix)))
		loop
			select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, v_path, 'read'),
				public.qorpera_folder_read_receipt(p_environment_id, p_profile_id, p_actor, v_path)
			into v_ok, v_receipt;
			if not v_ok then raise exception 'A read is no longer readable' using errcode = '42501'; end if;
			if v_receipt is not null then v_upserts := v_upserts || jsonb_build_array(v_receipt); end if;
		end loop;
		if not v_row.resource_exists or v_row.grant_missing or (v_row.grant_id is not null and not v_row.grant_live) then
			v_deletes := v_deletes || jsonb_build_array(jsonb_build_object('resourceId', v_row.resource_id, 'grantId', v_row.grant_id,
				'recordedResourceRevision', v_row.resource_revision, 'recordedGrantRevision', v_row.grant_revision));
		else
			v_restamps := v_restamps || jsonb_build_array(jsonb_build_object('resourceId', v_row.resource_id, 'grantId', v_row.grant_id,
				'resourceRevision', v_row.current_rrev, 'grantRevision', v_row.current_grev,
				'recordedResourceRevision', v_row.resource_revision, 'recordedGrantRevision', v_row.grant_revision));
		end if;
	end loop;
	if v_changed > 0 then
		perform public.qorpera_folder_view_write_read_set(p_environment_id, p_view_id, v_upserts, v_restamps, v_deletes);
	end if;
	return v_changed;
end $$;

-- A run's reading authority from its row, live or not (§6): its agent, requester, audience, session kind and worker
-- access, as run_resolve gives them. For rechecking the read set of a run whose reads reached a view's machine: a
-- desktop's holder run after it let go of the screen, a coding session's leased turn.
create function public.qorpera_folder_run_reader(p_profile_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
begin
	select * into v_run from public.qorpera_execution_runs where id = p_run_id and profile_id = p_profile_id;
	if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
	v_worker := public.qorpera_run_worker(v_run.id);
	return jsonb_build_object('kind','staff_agent','staffAgentId',v_run.staff_agent_id,'runId',v_run.id,
		'requesterUserId',v_run.requested_by_user_id,
		'audience',jsonb_build_object('kind',v_run.audience_kind,'userId',v_run.audience_user_id),
		'sessionKind',case when v_worker.species = 'coding' then 'coding' else 'in_house' end,'workerAccess',v_worker.access);
end $$;

-- A view's release (§6): the view's own read set and records always; with a live run (a run box, a desktop's holder
-- run) or a coding view's leased turn, that run's as well, under the run check (its job KEY SHARE among it, so the
-- turn's completion waits for releases in flight). A member-held view records no reads.
create function public.qorpera_folder_record_view_release(p_environment_id uuid, p_profile_id uuid, p_actor jsonb, p_release_id uuid,
	p_reads jsonb, p_output_sha256 text, p_content text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_view_id uuid := (p_actor ->> 'viewId')::uuid; v_existing public.qorpera_folder_view_releases%rowtype; v_resolved jsonb;
	v_early jsonb; v_run_actor jsonb; v_late_run jsonb; v_pairs jsonb; v_result jsonb;
begin
	-- A replay needs the view's pass too.
	if not exists (select 1 from public.qorpera_folder_views where id = v_view_id and environment_id = p_environment_id
		and pass_sha256 = extensions.digest(p_actor ->> 'pass', 'sha256')) then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	select * into v_existing from public.qorpera_folder_view_releases where view_id = v_view_id and release_id = p_release_id;
	if not found then
		-- The commit's order (§4): a plain resolve; the job of the run the view acts or reads through, KEY SHARE (so
		-- the turn's completion waits for releases in flight); the view row KEY SHARE, which an open superseding the
		-- view (FOR UPDATE) waits for; the resolve again; then the run check with its fence and principal rows. An
		-- open that got there first makes it refuse; a view that now names a run whose job it does not hold refuses
		-- as retryable.
		v_early := public.qorpera_folder_view_resolve(p_environment_id, p_profile_id, p_actor);
		if v_early ->> 'kind' = 'member' then
			raise exception 'A member-held view records no reads' using errcode = '22023'; end if;
		v_run_actor := nullif(coalesce(v_early -> 'view' -> 'runActor', v_early -> 'view' -> 'turnRunActor'), 'null'::jsonb);
		if v_run_actor is not null then
			perform 1 from public.qorpera_runner_jobs where id = (v_run_actor ->> 'jobId')::uuid and run_id = (v_run_actor ->> 'runId')::uuid
			for key share;
			if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
		end if;
		perform 1 from public.qorpera_folder_views where id = v_view_id for key share;
		v_resolved := public.qorpera_folder_view_resolve(p_environment_id, p_profile_id, p_actor);
		if v_resolved ->> 'kind' = 'member' then
			raise exception 'A member-held view records no reads' using errcode = '22023'; end if;
		v_late_run := nullif(coalesce(v_resolved -> 'view' -> 'runActor', v_resolved -> 'view' -> 'turnRunActor'), 'null'::jsonb);
		if v_late_run is not null and (v_run_actor is null or v_late_run ->> 'jobId' <> v_run_actor ->> 'jobId') then
			raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder view changed',
				'details', 'folder_view_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
		end if;
		v_run_actor := v_late_run;
		if v_run_actor is not null then
			perform public.qorpera_folder_run_enter(p_environment_id, p_profile_id, v_run_actor);
		end if;
		insert into public.qorpera_folder_view_releases(view_id, release_id, environment_id, content_sha256, result)
		values (v_view_id, p_release_id, p_environment_id, p_content, '{}'::jsonb) on conflict do nothing;
		if not found then
			select * into v_existing from public.qorpera_folder_view_releases where view_id = v_view_id and release_id = p_release_id;
		end if;
	end if;
	if v_existing.view_id is not null then
		if v_existing.content_sha256 <> p_content then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		return v_existing.result || jsonb_build_object('replay', true);
	end if;
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, p_profile_id, v_resolved, p_reads);
	perform public.qorpera_folder_view_write_read_set(p_environment_id, v_view_id, v_pairs -> 'upserts', null, null);
	insert into public.qorpera_folder_view_read_records(view_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_view_id, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
	from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	if v_run_actor is not null then
		-- The run's records are keyed by release id too: an id the run already used is refused, never half-filed.
		if exists (select 1 from public.qorpera_folder_run_releases where run_id = (v_run_actor ->> 'runId')::uuid and release_id = p_release_id)
			or exists (select 1 from public.qorpera_folder_run_read_records
				where run_id = (v_run_actor ->> 'runId')::uuid and release_id = p_release_id) then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		perform public.qorpera_folder_write_read_set(p_environment_id, (v_run_actor ->> 'runId')::uuid, v_pairs -> 'upserts', null, null);
		insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
		select (v_run_actor ->> 'runId')::uuid, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
			jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
		from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	end if;
	v_result := jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
		'reads',jsonb_array_length(p_reads),'replay',false,'runId',v_run_actor ->> 'runId');
	update public.qorpera_folder_view_releases set result = v_result where view_id = v_view_id and release_id = p_release_id;
	return v_result;
end $$;

-- Releases take view actors; the run path is C1b-2's, now through the shared receipt check.
create or replace function public.qorpera_folder_record_release(p_environment_id uuid, p_actor jsonb, p_release_id uuid, p_reads jsonb,
	p_output_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_run uuid; v_content text; v_existing public.qorpera_folder_run_releases%rowtype;
	v_actor jsonb; v_pairs jsonb; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder releases run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_release_id is null or coalesce(p_output_sha256, '') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_reads) is distinct from 'array'
		or jsonb_array_length(p_reads) > 10000
		or exists (select 1 from jsonb_array_elements(p_reads) r
			where jsonb_typeof(r) <> 'object' or not public.qorpera_company_path_valid(coalesce(r ->> 'path', ''))
				or jsonb_typeof(r -> 'authority') is distinct from 'object'
				or coalesce(r -> 'authority' ->> 'resourceId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				or coalesce(r -> 'authority' ->> 'resourceRevision', '') !~ '^[0-9]{1,18}$') then
		raise exception 'Folder release is invalid' using errcode = '22023'; end if;
	v_content := encode(extensions.digest(convert_to(jsonb_build_array(p_reads, p_output_sha256)::text, 'utf8'), 'sha256'), 'hex');
	if p_actor ->> 'kind' = 'view' then
		if p_actor - array['kind','viewId','pass'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'viewId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or coalesce(p_actor ->> 'pass', '') !~ '^[A-Za-z0-9_-]{43}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		return public.qorpera_folder_record_view_release(p_environment_id, v_file.profile_id, p_actor, p_release_id, p_reads,
			p_output_sha256, v_content);
	end if;
	v_run := (p_actor ->> 'runId')::uuid;
	-- A release id is used once: the same content replays, other content is refused. The id is claimed first, as a
	-- commit claims its operation key: a concurrent release of the same id waits for this one and then replays.
	select * into v_existing from public.qorpera_folder_run_releases where run_id = v_run and release_id = p_release_id;
	if not found then
		-- The pause, before the claim: stop never queues behind new effects (C1B §7). A replay is answered even so.
		if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000'; end if;
		insert into public.qorpera_folder_run_releases(run_id, release_id, environment_id, content_sha256, result)
		values (v_run, p_release_id, p_environment_id, v_content, '{}'::jsonb) on conflict do nothing;
		if not found then
			select * into v_existing from public.qorpera_folder_run_releases where run_id = v_run and release_id = p_release_id;
		end if;
	end if;
	if v_existing.run_id is not null then
		if v_existing.content_sha256 <> v_content then
			raise exception 'Release id was used for other reads' using errcode = '22023'; end if;
		return v_existing.result || jsonb_build_object('replay', true);
	end if;
	v_actor := public.qorpera_folder_run_enter(p_environment_id, v_file.profile_id, p_actor);
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, v_file.profile_id, v_actor, p_reads);
	perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_pairs -> 'upserts', null, null);
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_run, p_release_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), p_output_sha256
	from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	v_result := jsonb_build_object('schema','qorpera.folder-release/v1','releaseId',p_release_id,
		'reads',jsonb_array_length(p_reads),'replay',false);
	update public.qorpera_folder_run_releases set result = v_result where run_id = v_run and release_id = p_release_id;
	return v_result;
end $$;

-- Inheritance (§6): a run takes in a view's reads as a release. Only a view of the run's own agent and member; each
-- pair is checked for the run's agent and re-resolved where it fails; the view's records are copied, so the run's
-- recheck finds the paths. Idempotent per inherit id.
create function public.qorpera_folder_run_inherit_view_reads(p_environment_id uuid, p_run_actor jsonb, p_view_id uuid, p_inherit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype; v_run uuid := (p_run_actor ->> 'runId')::uuid;
	v_existing public.qorpera_folder_run_inheritances%rowtype; v_resolved jsonb; v_view public.qorpera_folder_views%rowtype;
	v_reads jsonb; v_pairs jsonb; v_result jsonb;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder releases run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	if p_view_id is null or p_inherit_id is null then raise exception 'Folder inheritance is invalid' using errcode = '22023'; end if;
	select * into v_existing from public.qorpera_folder_run_inheritances where run_id = v_run and inherit_id = p_inherit_id;
	if not found then
		if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000'; end if;
		insert into public.qorpera_folder_run_inheritances(run_id, inherit_id, environment_id, view_id, result)
		values (v_run, p_inherit_id, p_environment_id, p_view_id, '{}'::jsonb) on conflict do nothing;
		if not found then
			select * into v_existing from public.qorpera_folder_run_inheritances where run_id = v_run and inherit_id = p_inherit_id;
		end if;
	end if;
	if v_existing.run_id is not null then
		if v_existing.view_id <> p_view_id then raise exception 'Inherit id was used for another view' using errcode = '22023'; end if;
		return v_existing.result || jsonb_build_object('replay', true);
	end if;
	v_resolved := public.qorpera_folder_run_enter(p_environment_id, v_file.profile_id, p_run_actor);
	select * into v_view from public.qorpera_folder_views where id = p_view_id;
	if not found or v_view.environment_id <> p_environment_id or v_view.staff_agent_id <> (v_resolved ->> 'staffAgentId')::uuid
		or v_view.member_user_id <> (v_resolved ->> 'requesterUserId')::uuid then
		raise exception 'A run inherits only its own agent''s and member''s views' using errcode = '42501'; end if;
	select coalesce(jsonb_agg(x), '[]'::jsonb) into v_reads
	from public.qorpera_folder_view_read_records rec, jsonb_array_elements(rec.reads) x where rec.view_id = p_view_id;
	v_pairs := public.qorpera_folder_release_pairs(p_environment_id, v_file.profile_id, v_resolved, v_reads);
	perform public.qorpera_folder_write_read_set(p_environment_id, v_run, v_pairs -> 'upserts', null, null);
	insert into public.qorpera_folder_run_read_records(run_id, release_id, environment_id, resource_id, reads, output_sha256)
	select v_run, p_inherit_id, p_environment_id, (f -> 'authority' ->> 'resourceId')::uuid,
		jsonb_agg(f order by public.qorpera_folder_key(f ->> 'path')), repeat('0', 64)
	from jsonb_array_elements(v_pairs -> 'filed') f group by 4;
	v_result := jsonb_build_object('schema','qorpera.folder-inherit/v1','inheritId',p_inherit_id,'viewId',p_view_id,
		'reads',jsonb_array_length(v_reads),'replay',false);
	update public.qorpera_folder_run_inheritances set result = v_result where run_id = v_run and inherit_id = p_inherit_id;
	return v_result;
end $$;

-- 5. The commit (§3, §4, §7) -----------------------------------------------------------------------------------------

-- C1b-2's commit, with the view actor, the company row at rank 0, a view's read sets at rank 10, the anchor step
-- before the clock, and the view on the commit row.
create or replace function public.qorpera_folder_commit(p_environment_id uuid, p_actor jsonb, p_operation_key text, p_units jsonb,
	p_review_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_file public.qorpera_company_files%rowtype;
	v_actor_kind text; v_actor_id uuid; v_role public.qorpera_profile_role;
	c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
	v_scope uuid := c_nil; v_digest_actor jsonb; v_resolved jsonb; v_auth_actor jsonb; v_hook_actor jsonb;
	v_fence_revision bigint; v_targets jsonb := '[]'::jsonb; v_review public.qorpera_folder_reviews%rowtype;
	v_class text; v_dec jsonb; v_problems jsonb; v_approver uuid; v_used_review uuid; v_change_set_sha text;
	v_attr jsonb := '{}'::jsonb;
	v_request_sha text; v_commit_id uuid := extensions.gen_random_uuid(); v_existing record;
	v_unit jsonb; v_no integer; v_op text; v_path text; v_to text; v_key text; v_to_key text; v_parent text;
	v_row public.qorpera_folder_entries%rowtype; v_target public.qorpera_folder_entries%rowtype;
	v_parent_row public.qorpera_folder_entries%rowtype;
	v_outcomes jsonb := '[]'::jsonb; v_saved integer := 0; v_seq bigint; v_version uuid;
	v_file_json jsonb; v_as_of bigint; v_ancestor text; v_decided_as_of bigint;
	v_view public.qorpera_folder_views%rowtype; v_view_early jsonb; v_run_actor jsonb; v_view_agent boolean := false; v_turn_run uuid;
	v_ok boolean; v_reason text; v_eff_path text; v_eff_to text;
	v_locks jsonb := '{}'::jsonb; v_claims text[] := '{}'; v_lock record; v_invalid boolean;
	c_subtree_bound constant integer := 50000;
	-- key_text sits in two btree indexes, whose rows hold at most 2704 bytes: a longer key cannot be stored.
	c_key_bound constant integer := 2600;
	v_longest_path integer; v_longest_key integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Folder commits run at read committed' using errcode = '25000'; end if;
	select * into v_file from public.qorpera_company_files where environment_id = p_environment_id;
	if not found or v_file.core <> 'folder-v2' then
		raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
	v_actor_kind := p_actor ->> 'kind';
	if jsonb_typeof(p_actor) is distinct from 'object' or v_actor_kind is null then
		raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	if v_actor_kind = 'member' then
		if p_actor - array['kind','userId'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'userId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_actor_id := (p_actor ->> 'userId')::uuid;
	elsif v_actor_kind = 'platform' then
		if p_actor - array['kind'] <> '{}'::jsonb then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
	elsif v_actor_kind = 'run' then
		if p_actor - array['kind','runId','jobId','runnerId','assignmentId'] <> '{}'::jsonb
			or exists (select 1 from unnest(array['runId','jobId','runnerId','assignmentId']) f(name)
				where coalesce(p_actor ->> f.name, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_scope := (p_actor ->> 'runId')::uuid;
	elsif v_actor_kind = 'view' then
		if p_actor - array['kind','viewId','pass'] <> '{}'::jsonb
			or coalesce(p_actor ->> 'viewId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
			or coalesce(p_actor ->> 'pass', '') !~ '^[A-Za-z0-9_-]{43}$' then
			raise exception 'Folder actor is invalid' using errcode = '22023'; end if;
		v_scope := (p_actor ->> 'viewId')::uuid;
	else
		raise exception 'Folder actor is invalid' using errcode = '22023';
	end if;
	-- Reviews bind a run's change set (a view's only when it acts through a live run); members and the platform are
	-- never reviewed.
	if p_review_id is not null and v_actor_kind not in ('run','view') then
		raise exception 'Only a run carries a review' using errcode = '22023'; end if;
	if p_operation_key is null or p_operation_key !~ '^[A-Za-z0-9._:-]{8,200}$' then
		raise exception 'Operation key is invalid' using errcode = '22023'; end if;
	if jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) not between 1 and 1000 then
		raise exception 'Change set is invalid' using errcode = '22023'; end if;

	-- The shape of each unit. Only malformed requests raise; everything else is an outcome.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_op := v_unit ->> 'op';
		if jsonb_typeof(v_unit) is distinct from 'object' or v_op is null
			or v_op not in ('write','mkdir','new_folder','delete','move','copy') then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		if v_path is null or not public.qorpera_company_path_valid(v_path)
			or (v_op in ('move','copy') and (v_to is null or not public.qorpera_company_path_valid(v_to)))
			or (v_op not in ('move','copy') and v_to is not null)
			or (v_op = 'write' and jsonb_typeof(v_unit -> 'file') is distinct from 'object')
			or (v_op = 'new_folder' and (jsonb_typeof(v_unit -> 'contents') is distinct from 'array'
				or jsonb_array_length(v_unit -> 'contents') > 10000
				or exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
					where jsonb_typeof(c.value) is distinct from 'object' or c.value ->> 'path' is null
						or not public.qorpera_company_path_valid(v_path || '/' || (c.value ->> 'path'))))) then
			raise exception 'Change set unit % is invalid', v_no using errcode = '22023'; end if;
	end loop;

	-- The request digest leaves a run's lease binding out (C1B §4), so a replay after a lease re-claim matches. A
	-- review id is part of it: a retry with another review is another change set.
	v_digest_actor := case when v_actor_kind = 'run' then jsonb_build_object('kind','run','runId',p_actor ->> 'runId')
		when v_actor_kind = 'view' then jsonb_build_object('kind','view','viewId',p_actor ->> 'viewId') else p_actor end;
	v_request_sha := encode(extensions.digest(convert_to((case when p_review_id is null then jsonb_build_array(v_digest_actor, p_units)
		else jsonb_build_array(v_digest_actor, p_units, p_review_id) end)::text, 'utf8'), 'sha256'), 'hex');

	-- Step 0. A replay is answered first, even while the company is paused. A key reused for a different change set
	-- is refused. A view's replay needs its pass.
	if v_actor_kind = 'view' and not exists (select 1 from public.qorpera_folder_views
		where id = (p_actor ->> 'viewId')::uuid and environment_id = p_environment_id
			and pass_sha256 = extensions.digest(coalesce(p_actor ->> 'pass', ''), 'sha256')) then
		raise exception 'Folder view is unavailable' using errcode = '42501'; end if;
	select k.request_sha256, c.id, c.seq, c.units into v_existing
	from public.qorpera_folder_operation_keys k join public.qorpera_folder_commits c on c.id = k.commit_id
	where k.environment_id = p_environment_id and k.scope_id = v_scope and k.operation_key = p_operation_key;
	if found then
		if v_existing.request_sha256 is distinct from v_request_sha then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_existing.id,'seq',v_existing.seq,
			'replay',true,'units',v_existing.units);
	end if;
	-- Then the pause, for a run, before any lock: stop never queues behind new effects (C1B §7).
	if v_actor_kind = 'run' and exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
		raise exception 'Company execution is paused' using errcode = '55000'; end if;
	-- A view resolves early with plain reads: it refuses an ended view quickly, and a view acting as an agent refuses
	-- while paused (C1B "C1b-3: views" §4 step 2). The binding check is the anchor step.
	if v_actor_kind = 'view' then
		v_view_early := public.qorpera_folder_view_resolve(p_environment_id, v_file.profile_id, p_actor);
		v_view_agent := v_view_early ->> 'kind' = 'staff_agent';
		v_run_actor := nullif(v_view_early -> 'view' -> 'runActor', 'null'::jsonb);
		if p_review_id is not null and v_run_actor is null then
			raise exception 'Only a run carries a review' using errcode = '22023'; end if;
	end if;

	-- The clock value this commit decides under (C1B-2 §1): a plain read, before any authority decision. A narrowing
	-- journaled after it refuses the commit once the commit holds the clock.
	select last_seq into v_decided_as_of from public.qorpera_folder_clocks where environment_id = p_environment_id;
	if v_decided_as_of is null then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;

	-- Step 1. The operation key. A concurrent claim that commits first makes this a replay.
	insert into public.qorpera_folder_operation_keys(environment_id, scope_id, operation_key, commit_id, request_sha256)
	values (p_environment_id, v_scope, p_operation_key, v_commit_id, v_request_sha) on conflict do nothing;
	if not found then
		select k.request_sha256, c.id, c.seq, c.units into v_existing
		from public.qorpera_folder_operation_keys k join public.qorpera_folder_commits c on c.id = k.commit_id
		where k.environment_id = p_environment_id and k.scope_id = v_scope and k.operation_key = p_operation_key;
		if v_existing.request_sha256 is distinct from v_request_sha then
			raise exception 'Operation key was used for a different change set' using errcode = '22023'; end if;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_existing.id,'seq',v_existing.seq,
			'replay',true,'units',v_existing.units);
	end if;

	if v_actor_kind = 'run' then
		-- Step 2. The job FOR KEY SHARE: every change that ends its lease takes FOR UPDATE and so waits for this commit.
		perform 1 from public.qorpera_runner_jobs where id = (p_actor ->> 'jobId')::uuid and run_id = (p_actor ->> 'runId')::uuid
		for key share;
		if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
		-- Step 3. The folder fence FOR KEY SHARE, then the pause again: an effect that read "not paused" and then
		-- waited behind a stop refuses.
		select revision into v_fence_revision from public.qorpera_folder_fences where profile_id = v_file.profile_id for key share;
		if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
		if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
			raise exception 'Company execution is paused' using errcode = '55000'; end if;
		v_resolved := public.qorpera_folder_run_resolve(p_environment_id, v_file.profile_id, p_actor);
		v_actor_id := (v_resolved ->> 'staffAgentId')::uuid;
		v_attr := v_resolved -> 'attribution';
		v_targets := coalesce(v_resolved -> 'lockTargets', '[]'::jsonb);
		v_auth_actor := (v_resolved - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', v_fence_revision);
		v_hook_actor := v_auth_actor;
	elsif v_actor_kind = 'view' then
		-- Step 2. For a view acting through a live run, that run's job FOR KEY SHARE, as for the run; then the view row
		-- FOR KEY SHARE, which closing and superseding (FOR UPDATE) wait for.
		if v_run_actor is not null then
			perform 1 from public.qorpera_runner_jobs where id = (v_run_actor ->> 'jobId')::uuid
				and run_id = (v_run_actor ->> 'runId')::uuid for key share;
			if not found then raise exception 'Run is unavailable' using errcode = '42501'; end if;
		end if;
		select * into v_view from public.qorpera_folder_views where id = (p_actor ->> 'viewId')::uuid for key share;
		-- Step 3. A view acting as an agent takes the fence and re-reads the pause, as a run does.
		if v_view_agent then
			select revision into v_fence_revision from public.qorpera_folder_fences where profile_id = v_file.profile_id for key share;
			if not found then raise exception 'Company folder is unavailable' using errcode = '42501'; end if;
			if exists (select 1 from public.qorpera_company_execution_pauses where profile_id = v_file.profile_id) then
				raise exception 'Company execution is paused' using errcode = '55000'; end if;
		end if;
		v_resolved := public.qorpera_folder_view_resolve(p_environment_id, v_file.profile_id, p_actor);
		if v_resolved ->> 'kind' = 'member' then
			v_actor_id := (v_resolved ->> 'userId')::uuid;
			v_auth_actor := v_resolved;
			v_hook_actor := jsonb_build_object('kind','member','userId',v_resolved ->> 'userId');
		else
			v_actor_id := (v_resolved ->> 'staffAgentId')::uuid;
			v_attr := coalesce(v_resolved -> 'attribution', '{}'::jsonb);
			v_targets := coalesce(v_resolved -> 'lockTargets', '[]'::jsonb);
			if v_resolved ->> 'runId' is null then
				-- Detached: the agent's row at rank 2, as a run's resolve names it.
				v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 2, 'tbl', 'qorpera_profile_staff',
					'key', v_file.profile_id::text || ':' || (v_resolved ->> 'staffAgentId'), 'mode', 'keyshare', 'required', true));
			end if;
			v_auth_actor := (v_resolved - 'lockTargets' - 'attribution') || jsonb_build_object('fenceRevision', v_fence_revision);
			v_hook_actor := v_auth_actor - 'view';
			-- A view that was detached at the early resolve and now acts through a run holds no job lock for it: the
			-- holder came back in between. The caller retries, and the retry takes the job first.
			if v_resolved ->> 'runId' is not null and (v_run_actor is null or v_run_actor ->> 'jobId' <> v_resolved ->> 'jobId') then
				raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder view changed',
					'details', 'folder_view_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
			end if;
			v_turn_run := nullif(v_resolved -> 'view' -> 'turnRunActor', 'null'::jsonb) ->> 'runId';
		end if;
	elsif v_actor_kind = 'member' then
		v_auth_actor := p_actor; v_hook_actor := p_actor;
	else
		v_hook_actor := p_actor;
	end if;

	-- The lock set: each unit's targets and sources FOR UPDATE, and every ancestor of them FOR KEY SHARE. The
	-- stronger mode wins. A copy's source is held FOR UPDATE too, so its subtree cannot change between the
	-- checks and the copy (writers below it hold it KEY SHARE). A key past the bound is never claimed (it could
	-- not be stored); its unit is refused as too_long.
	for v_unit in select value from jsonb_array_elements(p_units) loop
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		foreach v_ancestor in array public.qorpera_folder_ancestors(v_path) || coalesce(public.qorpera_folder_ancestors(v_to), '{}') loop
			v_key := public.qorpera_folder_key(v_ancestor);
			if octet_length(v_key) <= c_key_bound and not v_locks ? v_key then
				v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_ancestor, 'mode', 'keyshare'));
			end if;
		end loop;
		v_key := public.qorpera_folder_key(v_path);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_path, 'mode', 'update'));
		end if;
		v_key := public.qorpera_folder_key(v_to);
		if octet_length(v_key) <= c_key_bound then
			v_locks := v_locks || jsonb_build_object(v_key, jsonb_build_object('path', v_to, 'mode', 'update'));
		end if;
	end loop;

	-- Step 4. One merged list of the rows to lock before the paths (C1B §8): the commit's own (the member actor or a
	-- run's requester at rank 1; a run's agent at 2 and its wake's room or routine at 4 or 5) and the structured-file
	-- hook's targets, at any rank. Covering resources are not locked: authority is ordered through the clock (C1B-2
	-- §1). Rows merge by (table, key), the stronger mode wins, and a row the commit relies on must exist. The commit
	-- locks ranks 1, 3, 6 and 7; the hook's lock takes 2, 4, 5, 8 and 9. Nothing is locked twice or upgraded.
	if v_actor_kind = 'member' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || v_actor_id::text, 'mode', 'keyshare', 'required', true));
	elsif v_actor_kind = 'run' or (v_actor_kind = 'view' and v_resolved ->> 'kind' = 'staff_agent') then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || (v_resolved ->> 'requesterUserId'), 'mode', 'keyshare', 'required', true));
	elsif v_actor_kind = 'view' then
		v_targets := v_targets || jsonb_build_array(jsonb_build_object('rank', 1, 'tbl', 'qorpera_profile_members',
			'key', v_file.profile_id::text || ':' || v_actor_id::text, 'mode', 'keyshare', 'required', true));
	end if;
	v_targets := v_targets || coalesce((select jsonb_agg(to_jsonb(t))
			from public.qorpera_folder_structured_targets(p_environment_id, v_hook_actor, p_units) t), '[]'::jsonb);

	-- Every target names a rank 0-9, a table, a key and a known mode; anything else is a defect, never a silent skip.
	-- Rank 0 is the company row, KEY SHARE, and the company row is rank 0 only: an old copy of a hook that still asks
	-- for it later (the #462 deadlock) fails loudly (C1B "C1b-3: views" §4).
	if exists (select 1 from jsonb_array_elements(v_targets) t
		where jsonb_typeof(t) <> 'object' or coalesce(t ->> 'rank', '') !~ '^[0-9]$' or t ->> 'tbl' is null or t ->> 'key' is null
			or coalesce(t ->> 'mode', '') not in ('keyshare','share','nokeyupdate','update')
			or (t ->> 'rank' = '0') <> (t ->> 'tbl' = 'qorpera_profiles')
			or (t ->> 'tbl' = 'qorpera_profiles' and (t ->> 'mode' <> 'keyshare' or t ->> 'key' <> v_file.profile_id::text))) then
		raise exception 'Folder lock targets are malformed' using errcode = 'XX000'; end if;
	-- Resources and grants are held KEY SHARE at most: a shared lock on the root would starve authority changes.
	if exists (select 1 from jsonb_array_elements(v_targets) t where t ->> 'rank' in ('6','7') and t ->> 'mode' <> 'keyshare') then
		raise exception 'Folder lock targets on resources and grants are key share only' using errcode = 'XX000'; end if;
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 0::smallint, 0::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 1::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 2::smallint, 2::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 3::smallint);
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 4::smallint, 5::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 6::smallint);
	perform public.qorpera_folder_lock_commit_rank(p_environment_id, v_targets, 7::smallint);

	-- Rank 7b: the review, FOR SHARE, which an answer's FOR NO KEY UPDATE waits for (and the other way round).
	if p_review_id is not null then
		select * into v_review from public.qorpera_folder_reviews
		where id = p_review_id and environment_id = p_environment_id for share;
		if not found then v_review := null; end if;
	end if;
	v_change_set_sha := public.qorpera_folder_change_set_sha256(p_units);

	-- Ranks 8 and 9: vault rows and unique-key claims, the hook's.
	perform public.qorpera_folder_structured_lock(p_environment_id, v_targets, 8::smallint, 9::smallint);

	-- Rank 10: a run's released reads still hold (C1B-2 §3). A narrowing that commits after this is caught after the
	-- clock.
	if v_actor_kind = 'run' then
		perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id, v_auth_actor);
	elsif v_actor_kind = 'view' and v_resolved ->> 'kind' = 'staff_agent' then
		-- A view's own read set, under the view's actor; a live run's read set under the run's own authority, without
		-- the company-wide restriction (§6).
		perform public.qorpera_folder_view_reads_current(p_environment_id, v_file.profile_id, v_view.id, v_auth_actor);
		if v_resolved ->> 'runId' is not null then
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id, v_auth_actor - 'view');
		elsif v_view.holder_run_id is not null then
			-- A detached desktop: what its holder run read may still be on the screen.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, v_view.holder_run_id));
		elsif v_turn_run is not null then
			-- A coding view during a leased turn: what the turn read may be in the session's files. The executor saves
			-- the session's changes before it completes the turn.
			perform public.qorpera_folder_run_reads_current(p_environment_id, v_file.profile_id,
				public.qorpera_folder_run_reader(v_file.profile_id, v_turn_run));
		end if;
	end if;

	-- Step 5. Paths, in one increasing key order. Ancestors sort before descendants, so every transaction
	-- takes a parent before its children.
	for v_lock in select l.key collate "C" as key, l.value ->> 'path' as path, l.value ->> 'mode' as mode
		from jsonb_each(v_locks) l order by l.key collate "C" loop
		if public.qorpera_folder_lock_path(p_environment_id, v_lock.path, v_lock.mode) then
			v_claims := v_claims || v_lock.key;
		end if;
	end loop;

	-- The commit row, before any unit is applied (units reference it); outcomes and seq are written at the end.
	insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id, requester_kind, requester_id,
		run_id, causal_wake_id, audience, session_kind, routine_id, routine_version, sponsor_binding_id, sponsor_version,
		provider_connection_id, runtime_bundle_id, units, as_of_seq, view_id, view_kind, turn_run_id)
	values (v_commit_id, p_environment_id, p_operation_key,
		case when v_actor_kind = 'run' then 'staff_agent' when v_actor_kind = 'view' then v_resolved ->> 'kind' else v_actor_kind end,
		v_actor_id,
		case when v_actor_kind in ('run','view') then 'member' else v_actor_kind end,
		case when v_actor_kind = 'run' or (v_actor_kind = 'view' and v_resolved ->> 'kind' = 'staff_agent')
			then (v_resolved ->> 'requesterUserId')::uuid else v_actor_id end,
		(v_resolved ->> 'runId')::uuid, (v_resolved ->> 'causalWakeId')::uuid, v_resolved -> 'audience',
		v_resolved ->> 'sessionKind', (v_resolved ->> 'routineId')::uuid, (v_resolved ->> 'routineVersion')::bigint,
		(v_attr ->> 'sponsorBindingId')::uuid, (v_attr ->> 'sponsorVersion')::bigint,
		(v_attr ->> 'providerConnectionId')::uuid, (v_attr ->> 'runtimeBundleId')::uuid, '[]', v_decided_as_of,
		v_view.id, v_view.kind, v_turn_run);

	-- Steps 7-8. Decide each unit from the locked rows, in order, and apply each clean one before the next is
	-- decided. Failures are outcomes, not exceptions.
	for v_unit, v_no in select value, ordinality::integer from jsonb_array_elements(p_units) with ordinality loop
		v_ok := true; v_reason := null; v_version := null; v_problems := null;
		v_op := v_unit ->> 'op';
		v_path := case when v_op in ('move','copy') then v_unit ->> 'from' else v_unit ->> 'path' end;
		v_to := v_unit ->> 'to';
		v_key := public.qorpera_folder_key(v_path);
		v_to_key := case when v_to is not null then public.qorpera_folder_key(v_to) end;
		select * into v_row from public.qorpera_folder_entries
		where environment_id = p_environment_id and key_sha256 = extensions.digest(v_key, 'sha256') and kind <> 'claim';
		if not found then v_row := null; end if;
		-- The path a new name takes: its existing parent's spelling plus its own name.
		v_parent := public.qorpera_folder_parent_path(coalesce(v_to, v_path));
		v_parent_row := null;
		if v_parent is not null then
			select * into v_parent_row from public.qorpera_folder_entries
			where environment_id = p_environment_id and kind = 'folder'
				and key_sha256 = extensions.digest(public.qorpera_folder_key(v_parent), 'sha256');
			if not found then v_parent_row := null; end if;
		end if;
		v_eff_path := case when v_op in ('move','copy') then coalesce(v_row.path, v_path)
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_path, '^.*/', '')
			else v_path end;
		v_eff_to := case when v_to is null then null
			when v_parent_row.path is not null then v_parent_row.path || '/' || regexp_replace(v_to, '^.*/', '')
			else v_to end;

		-- A request key past the bound was never locked: refused before anything else is decided.
		if octet_length(v_key) > c_key_bound or octet_length(v_to_key) > c_key_bound then
			v_ok := false; v_reason := 'too_long';
		end if;

		-- Names the folder never holds, on every path the unit produces.
		if v_ok and (public.qorpera_folder_path_reserved(coalesce(v_to_key, v_key))
			or (v_op in ('move','copy') and exists (select 1 from public.qorpera_folder_entries e
				where e.environment_id = p_environment_id and e.kind <> 'claim'
					and e.key_text like public.qorpera_folder_under(v_key)
					and public.qorpera_folder_path_reserved(v_to_key || substr(e.key_text, char_length(v_key) + 1))))
			or (v_op = 'new_folder' and exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c
				where public.qorpera_folder_path_reserved(public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path')))))) then
			v_ok := false; v_reason := 'reserved';
		end if;

		-- Authority on every path the unit touches (a subtree's boundaries included): write on what changes,
		-- read on a copy's source. A member as C1a; a run's agent for its requester and audience (C1B §3).
		if v_ok and v_actor_kind in ('member','run','view') then
			if v_op in ('write','mkdir') then
				v_ok := public.qorpera_folder_actor_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path, 'write');
			elsif v_op = 'new_folder' then
				v_ok := public.qorpera_folder_actor_keys_allowed(p_environment_id, v_file.profile_id, v_auth_actor, v_path,
					array(select public.qorpera_folder_key(v_path || '/' || (c.value ->> 'path'))
						from jsonb_array_elements(v_unit -> 'contents') c), 'write');
			elsif v_op = 'delete' then
				v_ok := public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
					v_key, v_path, 'write');
			elsif v_op in ('move','copy') then
				v_ok := public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
						v_key, v_path, case when v_op = 'copy' then 'read' else 'write' end)
					and public.qorpera_folder_actor_subtree_allowed(p_environment_id, v_file.profile_id, v_auth_actor,
						v_key, v_to, 'write');
			end if;
			if not v_ok then v_reason := 'denied'; end if;
		end if;

		if v_ok and v_op = 'write' then
			if v_unit ? 'expectedVersion' and v_unit -> 'expectedVersion' <> 'null'::jsonb then
				if v_row.kind is distinct from 'file' or v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
					v_ok := false; v_reason := 'version_changed'; end if;
			elsif v_row.kind is not null then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op = 'mkdir' then
			if v_row.kind is not null then v_ok := false; v_reason := 'exists'; end if;
		elsif v_ok and v_op = 'new_folder' then
			-- Contents: no duplicate keys, each parent a folder inside the unit, valid files, nothing already there.
			-- Keys are computed once and matched as sets (hash aggregate, EXCEPT), never per pair: the planner
			-- estimates jsonb_array_elements at 100 rows and would pick a nested loop for NOT EXISTS.
			with c as materialized (
				select value, value ->> 'kind' as kind, public.qorpera_folder_key(value ->> 'path') as key,
					public.qorpera_folder_key(public.qorpera_folder_parent_path(value ->> 'path')) as parent_key
				from jsonb_array_elements(v_unit -> 'contents')
			)
			select exists (select 1 from c group by key having count(*) > 1)
				or exists (select 1 from c where kind is distinct from 'folder' and kind is distinct from 'file')
				or exists (select parent_key from c where parent_key is not null except select key from c where kind = 'folder')
				or exists (select 1 from c where kind = 'file'
					and (jsonb_typeof(value -> 'file') is distinct from 'object'
						or jsonb_typeof(value -> 'file' -> 'executable') is distinct from 'boolean'
						or coalesce(value -> 'file' ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
						or coalesce(value -> 'file' ->> 'bytes', '') !~ '^[0-9]{1,15}$'))
			into v_invalid;
			if v_row.kind is not null then v_ok := false; v_reason := 'exists';
			elsif v_invalid then
				v_ok := false; v_reason := 'invalid';
			elsif exists (select 1 from jsonb_array_elements(v_unit -> 'contents') c where c.value ->> 'kind' = 'file'
				and not exists (select 1 from public.qorpera_verified_company_file_objects v
					where v.profile_id = v_file.profile_id and v.manifest_sha256 = c.value -> 'file' ->> 'manifestSha256'
						and v.file_sha256 = c.value -> 'file' ->> 'fileSha256'
						and v.bytes = (c.value -> 'file' ->> 'bytes')::bigint)) then
				v_ok := false; v_reason := 'bytes_unverified';
			elsif exists (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
				and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key)) then
				v_ok := false; v_reason := 'exists';
			end if;
		elsif v_ok and v_op in ('delete','move','copy') then
			if v_row.kind is null then
				v_ok := false; v_reason := 'missing';
			elsif (v_op <> 'copy' or v_unit ? 'expectedVersion') and v_row.version::text is distinct from v_unit ->> 'expectedVersion' then
				v_ok := false; v_reason := 'version_changed';
			elsif v_row.kind = 'folder' then
				-- A subtree delete or move refuses a change its writer did not see (core §3, units).
				v_as_of := case when v_unit ->> 'asOfSeq' ~ '^[0-9]{1,18}$' then (v_unit ->> 'asOfSeq')::bigint end;
				if v_op <> 'copy' and v_as_of is null then
					v_ok := false; v_reason := 'as_of_seq_required';
				elsif v_op <> 'copy' and exists (select 1 from public.qorpera_folder_entries e
					join public.qorpera_folder_commits c on c.id = e.commit_id
					where e.environment_id = p_environment_id and e.kind <> 'claim'
						and (e.key_sha256 = v_row.key_sha256 or e.key_text like public.qorpera_folder_under(v_key))
						and c.seq > v_as_of) then
					v_ok := false; v_reason := 'unseen_change';
				elsif (select count(*) from (select 1 from public.qorpera_folder_entries e where e.environment_id = p_environment_id
					and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key) limit c_subtree_bound + 1) s) > c_subtree_bound then
					v_ok := false; v_reason := 'too_large';
				end if;
			end if;
		end if;
		if v_ok and v_to is not null then
			select * into v_target from public.qorpera_folder_entries
			where environment_id = p_environment_id and key_sha256 = extensions.digest(v_to_key, 'sha256') and kind <> 'claim';
			if found and (v_op = 'copy' or v_to_key <> v_key) then
				v_ok := false; v_reason := 'exists';
			elsif v_to_key like public.qorpera_folder_under(v_key) then
				v_ok := false; v_reason := 'into_itself';
			end if;
		end if;
		-- A missing parent is refused unless an earlier unit of this change set made it.
		if v_ok and v_op in ('write','mkdir','new_folder','move','copy') and v_parent is not null and v_parent_row.path is null then
			v_ok := false; v_reason := 'parent_missing';
		end if;
		-- Every path the unit produces stays within the path limit, spelled as it will be stored, and every key
		-- within the key bound. Descendants of a moved or copied folder carry their ancestors' stored bytes, and
		-- keys compose over '/', so the longest one below the source decides.
		v_longest_path := null; v_longest_key := null;
		if v_ok and v_op in ('move','copy') and v_row.kind = 'folder' then
			select max(octet_length(e.path)), max(octet_length(e.key_text)) into v_longest_path, v_longest_key
			from public.qorpera_folder_entries e
			where e.environment_id = p_environment_id and e.kind <> 'claim' and e.key_text like public.qorpera_folder_under(v_key);
		end if;
		if v_ok and (octet_length(coalesce(v_eff_to, v_eff_path)) > 4096
			or octet_length(v_eff_to) - octet_length(v_row.path) + v_longest_path > 4096
			or octet_length(v_to_key) - octet_length(v_key) + v_longest_key > c_key_bound
			or (v_op = 'new_folder' and exists (select 1 from public.qorpera_folder_spelled_contents(v_eff_path, v_unit -> 'contents') c
				where octet_length(c.path) > 4096 or octet_length(public.qorpera_folder_key(c.path)) > c_key_bound))) then
			v_ok := false; v_reason := 'too_long';
		end if;
		-- Bytes (step 6): a written file must be verified content of this company. Its manifest object is held
		-- KEY SHARE; the full reference invariants of core §8 arrive with C1d.
		if v_ok and v_op = 'write' then
			v_file_json := v_unit -> 'file';
			if jsonb_typeof(v_file_json -> 'executable') is distinct from 'boolean'
				or coalesce(v_file_json ->> 'mediaType', '') !~ '^[a-z0-9!#$&^_.+-]{1,127}/[a-z0-9!#$&^_.+-]{1,127}$'
				or coalesce(v_file_json ->> 'bytes', '') !~ '^[0-9]{1,15}$' then
				v_ok := false; v_reason := 'invalid';
			elsif not exists (select 1 from public.qorpera_verified_company_file_objects
				where profile_id = v_file.profile_id and manifest_sha256 = v_file_json ->> 'manifestSha256'
					and file_sha256 = v_file_json ->> 'fileSha256' and bytes = (v_file_json ->> 'bytes')::bigint) then
				v_ok := false; v_reason := 'bytes_unverified';
			else
				perform 1 from public.qorpera_profile_objects o where o.profile_id = v_file.profile_id
					and o.sha256 = v_file_json ->> 'manifestSha256' for key share;
				if not found then v_ok := false; v_reason := 'bytes_unverified'; end if;
			end if;
		end if;

		-- The structured-file hook's checks, after the generic ones (§5; a stub until C2).
		if v_ok then
			v_dec := public.qorpera_folder_structured_decide(p_environment_id, v_hook_actor, v_commit_id, v_no, v_unit, v_eff_path, v_eff_to);
			if coalesce((v_dec ->> 'ok')::boolean, false) is not true then
				v_ok := false; v_reason := coalesce(v_dec ->> 'reason', 'structured_invalid'); v_problems := v_dec -> 'problems';
			end if;
		end if;

		-- Review (C1B §6): an in-house run's delete or move is a deletion; any other unit takes the hook's class.
		-- Members, the platform and coding sessions are never reviewed.
		if v_ok and (v_actor_kind = 'run' or (v_actor_kind = 'view' and v_auth_actor ->> 'kind' = 'staff_agent'))
			and v_auth_actor ->> 'sessionKind' = 'in_house' then
			v_class := case when v_op in ('delete','move') then 'deletion'
				else public.qorpera_folder_structured_review_class(p_environment_id, v_hook_actor, v_unit, v_eff_path, v_eff_to) end;
			if v_class is distinct from 'plain' then
				if v_review.id is null or v_review.run_id is distinct from (v_auth_actor ->> 'runId')::uuid
					or v_review.change_set_sha256 is distinct from v_change_set_sha or not (v_no = any (v_review.units)) then
					v_ok := false; v_reason := 'review_required';
				elsif v_review.decision = 'deny' or v_review.answer = 'deny' then
					v_ok := false; v_reason := 'review_denied';
				elsif v_review.decision = 'ask' and v_review.answer is null then
					v_ok := false; v_reason := 'waiting_for_review';
				else
					v_used_review := v_review.id;
					if v_review.answer = 'allow' then v_approver := v_review.answered_by_user_id; end if;
				end if;
			end if;
		end if;

		if v_ok then
			v_version := public.qorpera_folder_apply_unit(p_environment_id, v_commit_id, v_no, v_op, v_eff_path, v_eff_to, v_unit);
			perform public.qorpera_folder_structured_apply(p_environment_id, v_commit_id, v_no, v_unit, v_eff_path, v_eff_to);
			v_saved := v_saved + 1;
		end if;
		v_outcomes := v_outcomes || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('unit', v_no, 'op', v_op,
			'path', case when v_ok and v_op not in ('move','copy') then v_eff_path else v_path end,
			'to', case when v_ok then v_eff_to else v_to end, 'version', v_version,
			'outcome', case when v_ok then 'saved' when v_reason in ('denied','review_required','review_denied') then 'denied'
				when v_reason = 'waiting_for_review' then 'waiting_for_review'
				when v_reason in ('version_changed','exists','unseen_change','missing') then 'conflict' else 'refused' end,
			'reason', v_reason, 'problems', v_problems)));
	end loop;

	-- Claims that did not become live never outlive the transaction.
	delete from public.qorpera_folder_entries e
	where e.environment_id = p_environment_id and e.kind = 'claim'
		and e.key_sha256 = any (array(select extensions.digest(k, 'sha256') from unnest(v_claims) k));

	if v_saved = 0 then
		update public.qorpera_folder_commits set units = v_outcomes where id = v_commit_id;
		return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',null,'replay',false,
			'units',v_outcomes);
	end if;

	-- Step 9. The hook's check that every index row written points at its entry's current version.
	perform public.qorpera_folder_structured_verify(p_environment_id, v_commit_id);

	-- The anchor step (C1B "C1b-3: views" §3, §4): the view's anchor FOR SHARE, which the legacy paths' plain
	-- UPDATEs wait for; then, in a new statement, the view row and the full predicate, which see any change that
	-- committed while this waited. Taken last, so it is held only to the end.
	if v_view.id is not null then
		if v_view.kind = 'computer_desktop' then
			perform 1 from public.qorpera_runtime_office_screens where id = v_view.screen_id for share;
		elsif v_view.kind = 'coding_session' then
			perform 1 from public.qorpera_coding_sessions where worker_id = v_view.worker_id for share;
		end if;
		select * into v_view from public.qorpera_folder_views where id = v_view.id;
		if not public.qorpera_folder_view_valid(v_view) then
			raise exception 'Folder view has ended' using errcode = '42501'; end if;
	end if;

	-- Step 11. The clock, last. Sequence order is commit order; an abort rolls the increment back.
	-- The clock is locked first and incremented only once the authority check passed, so a refused commit leaves no
	-- updater on the clock row, which every commit holds KEY SHARE through its foreign keys.
	select last_seq + 1 into v_seq from public.qorpera_folder_clocks where environment_id = p_environment_id for no key update;
	-- The authority check (C1B-2 §1): a narrowing journaled after this commit started deciding refuses it, and the
	-- caller retries with the same operation key. A change still in flight waits for the clock this commit holds, and
	-- so is ordered after it. The platform acts under no grant.
	if v_actor_kind <> 'platform' and exists (select 1 from public.qorpera_folder_journal j
		where j.environment_id = p_environment_id and j.seq > v_decided_as_of and j.seq < v_seq and j.kind = 'authority'
			and (j.authority ->> 'narrowing')::boolean) then
		raise sqlstate 'PGRST' using message = jsonb_build_object('code', 'QRC01', 'message', 'Company folder authority changed',
			'details', 'folder_authority_changed', 'hint', null)::text, detail = '{"status":409,"headers":{}}';
	end if;
	update public.qorpera_folder_clocks set last_seq = v_seq where environment_id = p_environment_id;
	update public.qorpera_folder_commits set seq = v_seq, units = v_outcomes, review_id = v_used_review, approver_user_id = v_approver
	where id = v_commit_id;
	insert into public.qorpera_folder_journal(environment_id, seq, kind, commit_id)
	values (p_environment_id, v_seq, 'change_set', v_commit_id);
	return jsonb_build_object('schema','qorpera.folder-commit/v1','commitId',v_commit_id,'seq',v_seq,'replay',false,
		'units',v_outcomes);
end $$;

-- 6. Patches (§4, §9) ------------------------------------------------------------------------------------------------

create function pg_temp.views_replace(p_definition text, p_old text, p_new text, p_count integer, p_what text)
returns text language plpgsql as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1b-3a patch anchor not found % time(s): %', p_count, p_what; end if;
	return replace(p_definition, p_old, p_new);
end $$;

-- F2's roster targets take the company row at rank 0, which the commit above now accepts and requires (§4). Exactly the
-- four sites of the current definition (F2-4's, as redefined with the todo branches by F2-5a, 20260929210000, whose
-- comments still say rank 2); anything else is a definition this patch was not written for.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.views_replace(v_definition, $old$rank := 2; tbl := 'qorpera_profiles'$old$,
		$new$rank := 0; tbl := 'qorpera_profiles'$new$, 4, 'structured targets company row');
	execute v_definition;
end $$;

-- A seat whose open desktop view has unsaved changes is in use, so take_seat does not recycle it (§9). A view whose
-- lease lapsed (its folder service is gone) no longer holds the seat.
do $$
declare v_definition text := pg_get_functiondef('public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure);
begin
	v_definition := pg_temp.views_replace(v_definition, $old$select p_screen.lease_id is not null$old$,
		$new$select exists (select 1 from public.qorpera_folder_views view_row where view_row.screen_id = p_screen.id
			and view_row.state = 'open' and view_row.unsaved_since is not null and view_row.lease_until > clock_timestamp())
		or p_screen.lease_id is not null$new$, 1, 'screen in use');
	execute v_definition;
end $$;
-- The seat function may have a private owner in production (as #411 found): it must read the views.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid = 'public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office seat function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_folder_views to %I', v_owner); end if;
end $$;

-- 7. Grants --------------------------------------------------------------------------------------------------------

revoke all on function public.qorpera_folder_view_valid(public.qorpera_folder_views),
	public.qorpera_folder_view_live_run(public.qorpera_folder_views),
	public.qorpera_folder_view_resolve(uuid, uuid, jsonb),
	public.qorpera_folder_view_new_pass(),
	public.qorpera_folder_release_pairs(uuid, uuid, jsonb, jsonb),
	public.qorpera_folder_view_write_read_set(uuid, uuid, jsonb, jsonb, jsonb),
	public.qorpera_folder_view_reads_current(uuid, uuid, uuid, jsonb),
	public.qorpera_folder_record_view_release(uuid, uuid, jsonb, uuid, jsonb, text, text),
	public.qorpera_folder_run_reader(uuid, uuid)
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_view_open(uuid, jsonb, text, jsonb),
	public.qorpera_folder_view_renew(uuid, text, timestamptz),
	public.qorpera_folder_view_close(uuid, text),
	public.qorpera_folder_run_inherit_view_reads(uuid, jsonb, uuid, uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_folder_view_open(uuid, jsonb, text, jsonb),
	public.qorpera_folder_view_renew(uuid, text, timestamptz),
	public.qorpera_folder_view_close(uuid, text),
	public.qorpera_folder_run_inherit_view_reads(uuid, jsonb, uuid, uuid)
	to service_role;
