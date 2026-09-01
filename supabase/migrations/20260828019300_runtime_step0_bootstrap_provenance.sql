-- Runtime Order 0 completion: cloud-owned company bootstrap, exact first-run
-- admission, audience propagation, and immutable runtime provenance.

create table public.qorpera_runtime_bundles (
	id uuid primary key default extensions.gen_random_uuid(),
	bundle_key text not null,
	version bigint not null check (version > 0),
	manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 65536),
	sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default statement_timestamp(),
	unique (bundle_key,version),
	unique (id,sha256),
	check (sha256 = encode(extensions.digest(convert_to(manifest::text,'utf8'),'sha256'),'hex'))
);
create table public.qorpera_active_runtime_bundle (
	singleton boolean primary key default true check (singleton),
	runtime_bundle_id uuid not null,
	runtime_bundle_sha256 text not null,
	activated_at timestamptz not null default statement_timestamp(),
	foreign key (runtime_bundle_id,runtime_bundle_sha256)
		references public.qorpera_runtime_bundles(id,sha256) on delete restrict
);
alter table public.qorpera_runtime_bundles enable row level security;
alter table public.qorpera_active_runtime_bundle enable row level security;
revoke all on public.qorpera_runtime_bundles,public.qorpera_active_runtime_bundle
	from public,anon,authenticated,service_role;

insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
select 'qorpera.cloud-runtime',1,manifest,
	encode(extensions.digest(convert_to(manifest::text,'utf8'),'sha256'),'hex')
from (select jsonb_build_object(
	'schema','qorpera.runtime-bundle/v1',
	'constitution','qorpera.runtime-constitution/order-0',
	'contextComposer','qorpera.native-company-context/v1',
	'toolAuthority','qorpera.native-tool-authority/v1',
	'companyPathKernel','qorpera.company-path-operation/v1',
	'organizationProjection','qorpera.company-organization/v1',
	'secretCustody','qorpera.cloud-secret-custody/v1'
) manifest) value;
insert into public.qorpera_active_runtime_bundle(runtime_bundle_id,runtime_bundle_sha256)
select id,sha256 from public.qorpera_runtime_bundles where bundle_key = 'qorpera.cloud-runtime' and version = 1;

create function public.qorpera_reject_runtime_bundle_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	raise exception 'Runtime bundles are immutable' using errcode = '42501';
end
$$;
create trigger qorpera_runtime_bundles_immutable
before update or delete on public.qorpera_runtime_bundles
for each row execute function public.qorpera_reject_runtime_bundle_mutation();

alter table public.qorpera_session_inputs
	add column actor_kind text,
	add column runtime_bundle_id uuid,
	add column runtime_bundle_sha256 text;
update public.qorpera_session_inputs input set
	actor_kind = case when input.kind = 'kickoff' then 'control_plane' else 'human' end,
	runtime_bundle_id = bundle.runtime_bundle_id,
	runtime_bundle_sha256 = bundle.runtime_bundle_sha256
from public.qorpera_active_runtime_bundle bundle where bundle.singleton;
alter table public.qorpera_session_inputs
	alter column actor_kind set not null,
	alter column runtime_bundle_id set not null,
	alter column runtime_bundle_sha256 set not null,
	add check (actor_kind in ('human','control_plane')),
	add check ((kind = 'kickoff') = (actor_kind = 'control_plane')),
	add foreign key (runtime_bundle_id,runtime_bundle_sha256)
		references public.qorpera_runtime_bundles(id,sha256) on delete restrict;

create function public.qorpera_pin_session_input_provenance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	if tg_op = 'UPDATE' and (new.actor_kind,new.runtime_bundle_id,new.runtime_bundle_sha256)
		is distinct from (old.actor_kind,old.runtime_bundle_id,old.runtime_bundle_sha256) then
		raise exception 'Session input provenance is immutable' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
		new.actor_kind := case when new.kind = 'kickoff' then 'control_plane' else 'human' end;
		new.runtime_bundle_id := v_bundle.runtime_bundle_id;
		new.runtime_bundle_sha256 := v_bundle.runtime_bundle_sha256;
	end if;
	return new;
end
$$;
create trigger qorpera_session_input_provenance
before insert or update of kind,actor_kind,runtime_bundle_id,runtime_bundle_sha256
on public.qorpera_session_inputs for each row execute function public.qorpera_pin_session_input_provenance();

create function public.qorpera_assert_session_parent_audience()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_parent public.qorpera_shared_sessions%rowtype;
begin
	if new.parent_session_id is null then return new; end if;
	select * into v_parent from public.qorpera_shared_sessions where id = new.parent_session_id;
	if not found or v_parent.profile_id <> new.profile_id or v_parent.environment_id <> new.environment_id
		or v_parent.audience_kind <> new.audience_kind
		or v_parent.audience_user_id is distinct from new.audience_user_id then
		raise exception 'Session parent audience differs' using errcode = '42501'; end if;
	if new.id is not null and exists (
		with recursive ancestors(id,parent_session_id) as (
			select v_parent.id,v_parent.parent_session_id
			union all select session.id,session.parent_session_id
			from public.qorpera_shared_sessions session join ancestors on session.id = ancestors.parent_session_id
		) select 1 from ancestors where id = new.id
	) then raise exception 'Session parent cycle is invalid' using errcode = '22023'; end if;
	return new;
end
$$;
do $$ begin
	if exists (select 1 from public.qorpera_shared_sessions child
		join public.qorpera_shared_sessions parent on parent.id = child.parent_session_id
		where (child.profile_id,child.environment_id,child.audience_kind,child.audience_user_id)
			is distinct from (parent.profile_id,parent.environment_id,parent.audience_kind,parent.audience_user_id)) then
		raise exception 'Existing session parent audiences differ'; end if;
end $$;
create trigger qorpera_shared_session_parent_audience
before insert or update of parent_session_id,profile_id,environment_id,audience_kind,audience_user_id
on public.qorpera_shared_sessions for each row execute function public.qorpera_assert_session_parent_audience();

alter table public.qorpera_execution_runs
	add column audience_kind text,
	add column audience_user_id uuid,
	add column runtime_bundle_id uuid,
	add column runtime_bundle_sha256 text;
update public.qorpera_execution_runs run set
	audience_kind = coalesce((select session.audience_kind from public.qorpera_shared_sessions session
		where session.id = run.session_id),'company'),
	audience_user_id = (select session.audience_user_id from public.qorpera_shared_sessions session
		where session.id = run.session_id),
	runtime_bundle_id = coalesce((select source.runtime_bundle_id from public.qorpera_session_inputs source
		where source.id = any(run.input_ids) order by source.position limit 1),bundle.runtime_bundle_id),
	runtime_bundle_sha256 = coalesce((select source.runtime_bundle_sha256 from public.qorpera_session_inputs source
		where source.id = any(run.input_ids) order by source.position limit 1),bundle.runtime_bundle_sha256)
from public.qorpera_active_runtime_bundle bundle
where bundle.singleton;
alter table public.qorpera_execution_runs
	alter column audience_kind set not null,
	alter column runtime_bundle_id set not null,
	alter column runtime_bundle_sha256 set not null,
	add check (audience_kind in ('company','member_private')),
	add check ((audience_kind = 'member_private') = (audience_user_id is not null)),
	add foreign key (profile_id,audience_user_id)
		references public.qorpera_profile_members(profile_id,user_id) on delete restrict,
	add foreign key (runtime_bundle_id,runtime_bundle_sha256)
		references public.qorpera_runtime_bundles(id,sha256) on delete restrict;

create function public.qorpera_pin_execution_run_audience()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_shared_sessions%rowtype; v_bundle public.qorpera_active_runtime_bundle%rowtype;
	v_input record;
begin
	if tg_op = 'UPDATE' and (new.audience_kind,new.audience_user_id,new.runtime_bundle_id,new.runtime_bundle_sha256)
		is distinct from (old.audience_kind,old.audience_user_id,old.runtime_bundle_id,old.runtime_bundle_sha256) then
		raise exception 'Execution audience provenance is immutable' using errcode = '42501'; end if;
	if tg_op = 'INSERT' then
		select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
		if new.session_id is null then
			new.audience_kind := 'company'; new.audience_user_id := null;
		else
			select * into v_session from public.qorpera_shared_sessions where id = new.session_id;
			if not found or v_session.profile_id <> new.profile_id or v_session.environment_id <> new.environment_id
				or v_session.staff_agent_id is distinct from new.staff_agent_id::text then
				raise exception 'Execution session audience is unavailable' using errcode = '42501'; end if;
			new.audience_kind := v_session.audience_kind; new.audience_user_id := v_session.audience_user_id;
			if new.audience_kind = 'member_private' and new.requested_by_user_id <> new.audience_user_id then
				raise exception 'Execution requester differs from private audience' using errcode = '42501'; end if;
		end if;
		select min(input.runtime_bundle_id::text) bundle_id,min(input.runtime_bundle_sha256) bundle_sha,
			count(distinct (input.runtime_bundle_id::text || ':' || input.runtime_bundle_sha256)) variants
		into v_input from public.qorpera_session_inputs input where input.id = any(new.input_ids);
		if coalesce(v_input.variants,0) > 1 then
			raise exception 'Execution inputs use different runtime bundles' using errcode = '42501'; end if;
		new.runtime_bundle_id := coalesce(v_input.bundle_id::uuid,v_bundle.runtime_bundle_id);
		new.runtime_bundle_sha256 := coalesce(v_input.bundle_sha,v_bundle.runtime_bundle_sha256);
	end if;
	return new;
end
$$;
create trigger qorpera_execution_run_audience
before insert or update of session_id,profile_id,environment_id,staff_agent_id,requested_by_user_id,
	audience_kind,audience_user_id,runtime_bundle_id,runtime_bundle_sha256
on public.qorpera_execution_runs for each row execute function public.qorpera_pin_execution_run_audience();

alter table public.qorpera_company_path_revisions
	alter column parent_snapshot_id drop not null,
	add column requester_user_id uuid,
	add column sponsor_binding_id uuid,
	add column sponsor_version bigint,
	add column approver_user_id uuid,
	add column audience_kind text,
	add column audience_user_id uuid,
	add column operation_key text,
	add column runtime_bundle_id uuid,
	add column runtime_bundle_sha256 text;
update public.qorpera_company_path_revisions revision set
	requester_user_id = coalesce((select run.requested_by_user_id from public.qorpera_execution_runs run
		where run.id = revision.run_id),revision.actor_user_id),
	sponsor_binding_id = (select run.sponsor_binding_id from public.qorpera_execution_runs run where run.id = revision.run_id),
	sponsor_version = (select run.sponsor_version from public.qorpera_execution_runs run where run.id = revision.run_id),
	approver_user_id = (select proposal.approved_by_user_id from public.qorpera_company_path_proposals proposal
		where proposal.id = revision.proposal_id),
	audience_kind = coalesce((select run.audience_kind from public.qorpera_execution_runs run
		where run.id = revision.run_id),'company'),
	audience_user_id = (select run.audience_user_id from public.qorpera_execution_runs run where run.id = revision.run_id),
	operation_key = coalesce(revision.change #>> '{plan,operationKey}','historical-import'),
	runtime_bundle_id = coalesce((select run.runtime_bundle_id from public.qorpera_execution_runs run
		where run.id = revision.run_id),bundle.runtime_bundle_id),
	runtime_bundle_sha256 = coalesce((select run.runtime_bundle_sha256 from public.qorpera_execution_runs run
		where run.id = revision.run_id),bundle.runtime_bundle_sha256)
from public.qorpera_active_runtime_bundle bundle
where bundle.singleton;
alter table public.qorpera_company_path_revisions
	alter column requester_user_id set not null,
	alter column audience_kind set not null,
	alter column operation_key set not null,
	alter column runtime_bundle_id set not null,
	alter column runtime_bundle_sha256 set not null,
	add check (audience_kind in ('company','member_private')),
	add check ((audience_kind = 'member_private') = (audience_user_id is not null)),
	add check (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
	add foreign key (requester_user_id) references auth.users(id) on delete restrict,
	add foreign key (approver_user_id) references auth.users(id) on delete restrict,
	add foreign key (runtime_bundle_id,runtime_bundle_sha256)
		references public.qorpera_runtime_bundles(id,sha256) on delete restrict;

create function public.qorpera_pin_company_path_revision_provenance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_proposal public.qorpera_company_path_proposals%rowtype;
	v_resource public.qorpera_company_path_resources%rowtype; v_bundle public.qorpera_active_runtime_bundle%rowtype;
begin
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	if new.run_id is not null then
		select * into strict v_run from public.qorpera_execution_runs where id = new.run_id;
		new.requester_user_id := v_run.requested_by_user_id;
		new.sponsor_binding_id := v_run.sponsor_binding_id; new.sponsor_version := v_run.sponsor_version;
		new.audience_kind := v_run.audience_kind; new.audience_user_id := v_run.audience_user_id;
		new.runtime_bundle_id := v_run.runtime_bundle_id; new.runtime_bundle_sha256 := v_run.runtime_bundle_sha256;
	else
		new.requester_user_id := new.actor_user_id;
		new.runtime_bundle_id := v_bundle.runtime_bundle_id; new.runtime_bundle_sha256 := v_bundle.runtime_bundle_sha256;
		select * into v_resource from public.qorpera_company_path_resources
		where id = nullif(new.change ->> 'resourceId','')::uuid;
		new.audience_kind := case when v_resource.scope = 'member_private' then 'member_private' else 'company' end;
		new.audience_user_id := case when v_resource.scope = 'member_private' then v_resource.owner_user_id else null end;
	end if;
	if new.proposal_id is not null then
		select * into strict v_proposal from public.qorpera_company_path_proposals where id = new.proposal_id;
		new.approver_user_id := v_proposal.approved_by_user_id;
	end if;
	new.operation_key := coalesce(new.change #>> '{plan,operationKey}',new.operation_key,'company-bootstrap');
	return new;
end
$$;
create trigger qorpera_company_path_revision_provenance
before insert on public.qorpera_company_path_revisions
for each row execute function public.qorpera_pin_company_path_revision_provenance();

create table public.qorpera_company_first_runs (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null,
	cofounder_staff_agent_id uuid not null,
	formation_id uuid not null,
	session_id uuid not null unique references public.qorpera_shared_sessions(id) on delete restrict,
	input_id uuid not null unique references public.qorpera_session_inputs(id) on delete restrict,
	assignment jsonb not null check (jsonb_typeof(assignment) = 'object' and pg_column_size(assignment) <= 16384),
	created_at timestamptz not null default statement_timestamp(),
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,cofounder_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	foreign key (formation_id) references public.qorpera_company_formations(id) on delete restrict
);

create table public.qorpera_company_bootstrap_jobs (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null unique references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null unique,
	created_by_user_id uuid not null references auth.users(id) on delete restrict,
	cofounder_staff_agent_id uuid not null,
	formation_id uuid not null,
	member_session_id uuid not null,
	formation_document text not null check (octet_length(convert_to(formation_document,'utf8')) between 2 and 32768),
	cofounder_agent_document text not null
		check (octet_length(convert_to(cofounder_agent_document,'utf8')) between 2 and 32768),
	-- The Co-Founder holds the company-level responsibilities (contract 14.2).
	-- Their canonical documents are minted once at enqueue so every attempt
	-- stages and finalizes the same identities and bytes.
	cofounder_responsibility_documents jsonb not null default '{}'::jsonb check (
		jsonb_typeof(cofounder_responsibility_documents) = 'object'
		and pg_column_size(cofounder_responsibility_documents) <= 262144
	),
	cofounder_responsibility_manifest_sha256 jsonb not null default '{}'::jsonb check (
		jsonb_typeof(cofounder_responsibility_manifest_sha256) = 'object'
	),
	hidden_until_ready boolean not null,
	first_run_required boolean not null,
	state text not null default 'queued' check (state in ('queued','leased','completed','blocked')),
	attempt integer not null default 0 check (attempt between 0 and 1000),
	lease_owner uuid,
	lease_expires_at timestamptz,
	formation_manifest_sha256 text check (formation_manifest_sha256 is null or formation_manifest_sha256 ~ '^[0-9a-f]{64}$'),
	cofounder_agent_manifest_sha256 text check (
		cofounder_agent_manifest_sha256 is null or cofounder_agent_manifest_sha256 ~ '^[0-9a-f]{64}$'
	),
	tree_sha256 text check (tree_sha256 is null or tree_sha256 ~ '^[0-9a-f]{64}$'),
	base_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	base_tree_sha256 text check (base_tree_sha256 is null or base_tree_sha256 ~ '^[0-9a-f]{64}$'),
	base_tree_bytes integer check (base_tree_bytes is null or base_tree_bytes between 1 and 8388608),
	candidate_snapshot_id uuid unique,
	output_snapshot_id uuid references public.qorpera_company_snapshots(id) on delete restrict,
	last_error text check (last_error is null or char_length(last_error) between 1 and 2048),
	created_at timestamptz not null default statement_timestamp(),
	updated_at timestamptz not null default statement_timestamp(),
	completed_at timestamptz,
	foreign key (profile_id,environment_id)
		references public.qorpera_company_files(profile_id,environment_id) on delete cascade,
	foreign key (profile_id,cofounder_staff_agent_id)
		references public.qorpera_profile_staff(profile_id,staff_agent_id) on delete restrict,
	foreign key (formation_id) references public.qorpera_company_formations(id) on delete restrict,
	foreign key (member_session_id) references public.qorpera_shared_sessions(id) on delete restrict,
	check ((base_snapshot_id is null) = (base_tree_sha256 is null)
		and (base_snapshot_id is null) = (base_tree_bytes is null)),
	check ((state = 'leased') = (lease_owner is not null and lease_expires_at is not null)),
	check ((state = 'completed') = (completed_at is not null and output_snapshot_id is not null))
);
create index qorpera_company_bootstrap_jobs_ready on public.qorpera_company_bootstrap_jobs(state,lease_expires_at,created_at);
alter table public.qorpera_company_first_runs enable row level security;
alter table public.qorpera_company_bootstrap_jobs enable row level security;
revoke all on public.qorpera_company_first_runs,public.qorpera_company_bootstrap_jobs
	from public,anon,authenticated,service_role;

create or replace function public.qorpera_enforce_company_workspace_writer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace public.qorpera_company_workspaces%rowtype;
begin
	select * into v_workspace from public.qorpera_company_workspaces where id = new.workspace_id;
	if not found or v_workspace.profile_id <> new.profile_id or v_workspace.environment_id <> new.environment_id then
		raise exception 'company snapshot workspace is invalid' using errcode = '22023'; end if;
	if exists (select 1 from public.qorpera_company_bootstrap_jobs job
		where job.candidate_snapshot_id = new.id and job.profile_id = new.profile_id
			and job.environment_id = new.environment_id and job.created_by_user_id = new.created_by_user_id
			and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
			and job.tree_sha256 = new.tree_manifest_sha256) then return new; end if;
	if exists (select 1 from public.qorpera_company_path_revisions revision
		join public.qorpera_company_files file on file.environment_id = revision.environment_id
		where revision.snapshot_id = new.id and revision.environment_id = new.environment_id
			and file.profile_id = new.profile_id and file.canonical_workspace_id = new.workspace_id
			and file.path_gateway_version = 1 and revision.parent_snapshot_id is not distinct from new.parent_snapshot_id
			and revision.tree_sha256 = new.tree_manifest_sha256 and revision.tree_bytes = new.tree_manifest_bytes
			and new.tree_contract_version = 3 and revision.file_count = new.file_count
			and revision.total_bytes = new.total_bytes and revision.actor_user_id = new.created_by_user_id) then return new; end if;
	if auth.uid() is not null and v_workspace.created_by_user_id = auth.uid() and new.created_by_user_id = auth.uid() then return new; end if;
	if exists (select 1 from public.qorpera_runner_company_revision_intents intent
		where intent.client_revision_id = new.client_snapshot_id and intent.profile_id = new.profile_id
			and intent.environment_id = new.environment_id and intent.workspace_id = new.workspace_id
			and intent.parent_snapshot_id is not distinct from new.parent_snapshot_id
			and intent.tree_manifest_sha256 = new.tree_manifest_sha256
			and intent.tree_manifest_bytes = new.tree_manifest_bytes
			and intent.tree_contract_version = new.tree_contract_version and intent.file_count = new.file_count
			and intent.total_bytes = new.total_bytes and intent.created_by_user_id = new.created_by_user_id) then return new; end if;
	raise exception 'company workspace head belongs to another writer' using errcode = '42501';
end
$$;

create function public.qorpera_company_bootstrap_document(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'schema','qorpera.company-formation/v1','formationId',formation.id,
		'cofounderStaffAgentId',cofounder.staff_agent_id,'state','source_inventory',
		'status','active','revision',1
	)::text
	from public.qorpera_company_formations formation
	join public.qorpera_company_cofounders cofounder on cofounder.formation_id = formation.id
	where formation.profile_id = p_profile_id
$$;

create function public.qorpera_company_bootstrap_agent_document(p_profile_id uuid)
returns text language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'schema','qorpera.company-agent/v1','agentId',staff.staff_agent_id,'revision',staff.version,
		'displayName',staff.display_name,'role',staff.role,
		'hireOverlay',jsonb_build_object('charter',staff.charter,'templateId',staff.template_id),
		'appearance',jsonb_build_object('color',staff.appearance_color,'shape',staff.appearance_shape,
			'creature',staff.appearance_creature),
		'modelPolicy',jsonb_build_object('provider',staff.model_provider,'modelId',staff.model_id),
		'reasoningPolicy',jsonb_build_object('effort','low'),
		'grants',jsonb_build_object('responsibilities','[]'::jsonb,'projects','[]'::jsonb,'rooms','[]'::jsonb,'resources','[]'::jsonb),
		'startupInstructions','Begin the durable company-formation workflow at source_inventory. Determine whether the founder is starting fresh or has prior company work, then create only the Company File objects the work needs.',
		'employmentStatus',staff.employment_status,'lifecycleState',staff.lifecycle_state,'createdAt',staff.created_at
	)::text
	from public.qorpera_company_cofounders cofounder
	join public.qorpera_profile_staff staff on staff.profile_id = cofounder.profile_id
		and staff.staff_agent_id = cofounder.staff_agent_id
	where cofounder.profile_id = p_profile_id
$$;

-- The four company-level responsibilities the Co-Founder holds: direction,
-- the responsibility map, resourcing, and the founder relationship. Each is
-- a real responsibility with a measure and live sources, accountable to the
-- Co-Founder with the founding owner as its accountable member; none is a
-- ceremonial name. Their loops land with Orders 3 and 8 like any other.
create function public.qorpera_company_bootstrap_responsibility_documents(p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype; v_owner uuid; v_result jsonb := '{}'::jsonb;
	v_id uuid; v_measure uuid; v_seed record;
begin
	select * into strict v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select user_id into strict v_owner from public.qorpera_profile_members
	where profile_id = p_profile_id and role = 'owner';
	for v_seed in select * from (values
		(1,'direction','Direction',
			'The ratified company direction stays current against evidence. A material deviation between direction and evidence reaches the founder with a recommended position, not a menu of options.',
			'weekly','direction-currency','Direction currency',
			'Whether the ratified direction was reviewed against current evidence within its cadence and no material deviation is left unresolved.',
			'observe',jsonb_build_object('unresolvedMaterialDeviations',0),
			jsonb_build_array(jsonb_build_object('path','organization/formation.json','pathMatch','exact'),
				jsonb_build_object('path','organization/projects','pathMatch','subtree'))),
		(2,'responsibility-map','Responsibility map',
			'Everything the company cares about has exactly one accountable owner with fresh measures. New responsibilities are proposed and dead ones retired.',
			'weekly','owned-outcomes','Owned outcomes',
			'Active responsibilities whose accountable agent is employed and whose measures were refreshed within their cadence, against responsibilities that lack either.',
			'observe',jsonb_build_object('responsibilitiesWithoutFreshOwner',0),
			jsonb_build_array(jsonb_build_object('path','organization/responsibilities','pathMatch','subtree'),
				jsonb_build_object('path','organization/agents','pathMatch','subtree'))),
		(3,'resourcing','Resourcing',
			'The company has the agents, budgets, effort policy, and projects its ratified goals need, and no more.',
			'weekly','active-capacity','Active capacity',
			'Employed agents and open projects against the work the ratified goals require.',
			'observe',jsonb_build_object('idleAgents',0,'unstaffedActiveProjects',0),
			jsonb_build_array(jsonb_build_object('path','organization/agents','pathMatch','subtree'),
				jsonb_build_object('path','organization/projects','pathMatch','subtree'))),
		(4,'founder-relationship','Founder relationship',
			'The founder receives one coherent synthesis of results, blockers, and genuine decision requests, and every gated decision waits for the founder instead of being assumed.',
			'daily','founder-decision-queue','Founder decision queue',
			'Open decisions awaiting the founder and the age of the oldest, read from the formation state and open projects.',
			'lower_is_better',jsonb_build_object('oldestOpenDecisionDays',2),
			jsonb_build_array(jsonb_build_object('path','organization/formation.json','pathMatch','exact'),
				jsonb_build_object('path','organization/projects','pathMatch','subtree')))
	) seed(ordinal,slug,name,outcome,cadence,measure_key,measure_label,measure_definition,direction,target,sources)
	order by ordinal loop
		v_id := extensions.gen_random_uuid(); v_measure := extensions.gen_random_uuid();
		v_result := v_result || jsonb_build_object('organization/responsibilities/' || v_id::text || '.json',
			jsonb_build_object('schema','qorpera.responsibility/v1','responsibilityId',v_id,'slug',v_seed.slug,
				'name',v_seed.name,'outcome',v_seed.outcome,'accountableStaffAgentId',v_cofounder.staff_agent_id,
				'accountableUserId',v_owner,'attentionCadence',v_seed.cadence,
				'escalationThreshold',jsonb_build_object('mode','material-deviation'),
				'escalationTarget',jsonb_build_object('kind','accountable_member','id',null),
				'effortPolicy',jsonb_build_object('attended','low'),'budgetPolicy','{}'::jsonb,
				'concurrencyPolicy','{}'::jsonb,'routineIds','[]'::jsonb,'listenerIds','[]'::jsonb,
				'externalOperationGrants','[]'::jsonb,'resources','[]'::jsonb,'status','active','version',1,
				'measures',jsonb_build_array(jsonb_build_object('measureId',v_measure,'key',v_seed.measure_key,
					'label',v_seed.measure_label,'definition',v_seed.measure_definition,'direction',v_seed.direction,
					'target',v_seed.target,'guardrails','[]'::jsonb,'cadence',v_seed.cadence,'status','active',
					'sources',v_seed.sources)))::text);
	end loop;
	return v_result;
end
$$;

create function public.qorpera_enqueue_company_bootstrap(p_profile_id uuid,p_hidden_until_ready boolean)
returns public.qorpera_company_bootstrap_jobs language plpgsql security definer set search_path = '' as $$
declare v_cofounder public.qorpera_company_cofounders%rowtype; v_session uuid;
	v_job public.qorpera_company_bootstrap_jobs%rowtype; v_owner uuid;
begin
	select * into strict v_cofounder from public.qorpera_company_cofounders where profile_id = p_profile_id;
	select user_id into strict v_owner from public.qorpera_profile_members where profile_id = p_profile_id and role = 'owner';
	select id into strict v_session from public.qorpera_shared_sessions where profile_id = p_profile_id
		and staff_agent_id = v_cofounder.staff_agent_id::text and audience_kind = 'member_private'
		and audience_user_id = v_owner and status = 'open';
	insert into public.qorpera_company_bootstrap_jobs(profile_id,environment_id,created_by_user_id,
		cofounder_staff_agent_id,formation_id,member_session_id,formation_document,cofounder_agent_document,
		cofounder_responsibility_documents,hidden_until_ready,first_run_required)
	values (p_profile_id,v_cofounder.environment_id,v_owner,v_cofounder.staff_agent_id,v_cofounder.formation_id,
		v_session,public.qorpera_company_bootstrap_document(p_profile_id),
		public.qorpera_company_bootstrap_agent_document(p_profile_id),
		public.qorpera_company_bootstrap_responsibility_documents(p_profile_id),p_hidden_until_ready,p_hidden_until_ready)
	on conflict (profile_id) do update set hidden_until_ready =
		public.qorpera_company_bootstrap_jobs.hidden_until_ready or excluded.hidden_until_ready
	returning * into v_job;
	return v_job;
end
$$;

-- Profiles which predate the cloud bootstrap worker stay visible while their
-- canonical organization upgrade drains. Newly created profiles are hidden.
do $$ declare v_profile uuid; begin
	for v_profile in select profile_id from public.qorpera_company_cofounders order by profile_id loop
		perform public.qorpera_enqueue_company_bootstrap(v_profile,false);
	end loop;
end $$;

create or replace function public.qorpera_list_hosted_profiles()
returns jsonb language sql stable security definer set search_path = '' as $$
	select coalesce(jsonb_agg(jsonb_build_object(
		'profile_id',profile.id,'environment_id',environment.id,'profile_name',profile.name,
		'environment_name',environment.name,'role',member.role,'contract_version',environment.contract_version,
		'created_at',profile.created_at,'bootstrap_state',coalesce(job.state,'legacy')
	) order by profile.created_at,environment.created_at),'[]'::jsonb)
	from public.qorpera_profile_members member
	join public.qorpera_profiles profile on profile.id = member.profile_id
	join public.qorpera_company_environments environment on environment.profile_id = profile.id
	left join public.qorpera_company_bootstrap_jobs job on job.profile_id = profile.id
	where member.user_id = auth.uid() and not (coalesce(job.hidden_until_ready,false) and job.state <> 'completed')
$$;

create or replace function public.qorpera_create_cloud_company(
	p_client_creation_id uuid,p_company_name text,p_contract_version integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := auth.uid(); v_name text := btrim(p_company_name);
	v_request public.qorpera_company_creation_requests%rowtype; v_profile jsonb;
	v_file public.qorpera_company_files%rowtype; v_cofounder jsonb; v_job public.qorpera_company_bootstrap_jobs%rowtype;
begin
	if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if p_client_creation_id is null or char_length(v_name) not between 1 and 120 or p_contract_version is distinct from 2 then
		raise exception 'company creation is invalid' using errcode = '22023'; end if;
	insert into public.qorpera_company_creation_requests(created_by_user_id,client_creation_id,profile_name,contract_version)
	values (v_user_id,p_client_creation_id,v_name,p_contract_version)
	on conflict (created_by_user_id,client_creation_id) do nothing returning * into v_request;
	if not found then
		select * into strict v_request from public.qorpera_company_creation_requests
		where created_by_user_id = v_user_id and client_creation_id = p_client_creation_id for update;
		if v_request.profile_name <> v_name or v_request.contract_version <> p_contract_version then
			raise exception 'company creation id is already bound to another request' using errcode = '23505'; end if;
	end if;
	if v_request.profile_id is null then
		v_profile := public.qorpera_create_hosted_profile(v_name,v_name,p_contract_version);
		update public.qorpera_company_creation_requests set profile_id = (v_profile ->> 'profile_id')::uuid
		where created_by_user_id = v_user_id and client_creation_id = p_client_creation_id returning * into v_request;
		v_cofounder := public.qorpera_seed_company_cofounder((v_profile ->> 'profile_id')::uuid,v_user_id);
		v_job := public.qorpera_enqueue_company_bootstrap((v_profile ->> 'profile_id')::uuid,true);
	else
		select jsonb_build_object('profile_id',profile.id,'environment_id',environment.id,
			'profile_name',profile.name,'environment_name',environment.name,'role',member.role,
			'contract_version',environment.contract_version,'created_at',profile.created_at) into strict v_profile
		from public.qorpera_profiles profile join public.qorpera_profile_members member on member.profile_id = profile.id
		join public.qorpera_company_environments environment on environment.profile_id = profile.id
		where profile.id = v_request.profile_id and member.user_id = v_user_id;
		select * into strict v_job from public.qorpera_company_bootstrap_jobs where profile_id = v_request.profile_id;
		v_cofounder := jsonb_build_object('staff_agent_id',v_job.cofounder_staff_agent_id,
			'formation_id',v_job.formation_id,'member_session_id',v_job.member_session_id);
	end if;
	select * into strict v_file from public.qorpera_company_files file where file.profile_id = v_job.profile_id;
	return v_profile || jsonb_build_object('company_file',public.qorpera_company_file_json(v_file),
		'bootstrap_state',v_job.state,'organization',case when v_job.state = 'completed' then
		jsonb_build_object('schema','qorpera.company-organization-bootstrap/v1','cofounder',v_cofounder,
			'formation_state','source_inventory') else null end);
end
$$;

create function public.qorpera_claim_company_bootstrap(p_worker_id uuid,p_lease_seconds integer default 60)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.qorpera_company_bootstrap_jobs%rowtype; v_file public.qorpera_company_files%rowtype;
	v_snapshot public.qorpera_company_snapshots%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_worker_id is null or p_lease_seconds not between 15 and 300 then
		raise exception 'Company bootstrap worker authority is required' using errcode = '42501'; end if;
	select * into v_job from public.qorpera_company_bootstrap_jobs job
	where job.state = 'queued' or (job.state = 'leased' and job.lease_expires_at <= clock_timestamp())
	order by job.updated_at,job.id for update skip locked limit 1;
	if not found then return null; end if;
	select * into strict v_file from public.qorpera_company_files where environment_id = v_job.environment_id for update;
	if v_file.head_snapshot_id is not null then
		select * into strict v_snapshot from public.qorpera_company_snapshots where id = v_file.head_snapshot_id;
	end if;
	update public.qorpera_company_bootstrap_jobs set state = 'leased',lease_owner = p_worker_id,
		lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),attempt = attempt + 1,
		last_error = null,updated_at = clock_timestamp(),base_snapshot_id = v_file.head_snapshot_id,
		base_tree_sha256 = v_snapshot.tree_manifest_sha256,base_tree_bytes = v_snapshot.tree_manifest_bytes,
		formation_manifest_sha256 = case when base_snapshot_id is not distinct from v_file.head_snapshot_id
			and base_tree_sha256 is not distinct from v_snapshot.tree_manifest_sha256
			and base_tree_bytes is not distinct from v_snapshot.tree_manifest_bytes then formation_manifest_sha256 end,
		cofounder_agent_manifest_sha256 = case when base_snapshot_id is not distinct from v_file.head_snapshot_id
			and base_tree_sha256 is not distinct from v_snapshot.tree_manifest_sha256
			and base_tree_bytes is not distinct from v_snapshot.tree_manifest_bytes then cofounder_agent_manifest_sha256 end,
		cofounder_responsibility_manifest_sha256 = case when base_snapshot_id is not distinct from v_file.head_snapshot_id
			and base_tree_sha256 is not distinct from v_snapshot.tree_manifest_sha256
			and base_tree_bytes is not distinct from v_snapshot.tree_manifest_bytes
			then cofounder_responsibility_manifest_sha256 else '{}'::jsonb end,
		tree_sha256 = case when base_snapshot_id is not distinct from v_file.head_snapshot_id
			and base_tree_sha256 is not distinct from v_snapshot.tree_manifest_sha256
			and base_tree_bytes is not distinct from v_snapshot.tree_manifest_bytes then tree_sha256 end,
		candidate_snapshot_id = case when base_snapshot_id is not distinct from v_file.head_snapshot_id
			and base_tree_sha256 is not distinct from v_snapshot.tree_manifest_sha256
			and base_tree_bytes is not distinct from v_snapshot.tree_manifest_bytes then candidate_snapshot_id end
	where id = v_job.id returning * into v_job;
	return jsonb_build_object('schema','qorpera.company-bootstrap-claim/v1','jobId',v_job.id,
		'profileId',v_job.profile_id,'environmentId',v_job.environment_id,'leaseOwner',p_worker_id,
		'leaseExpiresAt',v_job.lease_expires_at,'createdByUserId',v_job.created_by_user_id,
		'cofounderStaffAgentId',v_job.cofounder_staff_agent_id,'formationId',v_job.formation_id,
		'memberSessionId',v_job.member_session_id,'formationDocument',v_job.formation_document,
		'cofounderAgentDocument',v_job.cofounder_agent_document,
		'cofounderResponsibilityDocuments',v_job.cofounder_responsibility_documents,
		'pathGatewayVersion',v_file.path_gateway_version,
		'baseSnapshotId',v_job.base_snapshot_id,'baseTreeSha256',v_job.base_tree_sha256,
		'baseTreeBytes',v_job.base_tree_bytes);
end
$$;

create function public.qorpera_stage_company_bootstrap_object(
	p_job_id uuid,p_worker_id uuid,p_kind text,p_sha256 text,p_bytes bigint,p_confirm boolean,
	p_path text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_job public.qorpera_company_bootstrap_jobs%rowtype; v_expected text; v_expected_bytes bigint;
begin
	if auth.role() is distinct from 'service_role' or p_kind not in (
		'formation_content','formation_manifest','cofounder_agent_content','cofounder_agent_manifest',
		'cofounder_responsibility_content','cofounder_responsibility_manifest','tree'
	)
		or p_sha256 !~ '^[0-9a-f]{64}$' or p_bytes not between 1 and 8388608
		or (p_kind = 'cofounder_responsibility_manifest') <> (p_path is not null) then
		raise exception 'Company bootstrap object authority is invalid' using errcode = '22023'; end if;
	select * into strict v_job from public.qorpera_company_bootstrap_jobs where id = p_job_id for update;
	if v_job.state <> 'leased' or v_job.lease_owner <> p_worker_id or v_job.lease_expires_at <= clock_timestamp() then
		raise exception 'Company bootstrap lease is unavailable' using errcode = '42501'; end if;
	if p_kind = 'formation_content' then
		v_expected := encode(extensions.digest(convert_to(v_job.formation_document,'utf8'),'sha256'),'hex');
		v_expected_bytes := octet_length(v_job.formation_document);
		if p_sha256 <> v_expected or p_bytes <> v_expected_bytes then
			raise exception 'Company bootstrap formation differs' using errcode = '22023'; end if;
	elsif p_kind = 'cofounder_agent_content' then
		v_expected := encode(extensions.digest(convert_to(v_job.cofounder_agent_document,'utf8'),'sha256'),'hex');
		v_expected_bytes := octet_length(v_job.cofounder_agent_document);
		if p_sha256 <> v_expected or p_bytes <> v_expected_bytes then
			raise exception 'Company bootstrap Co-Founder agent differs' using errcode = '22023'; end if;
	elsif p_kind = 'formation_manifest' then
		if v_job.formation_manifest_sha256 is null then
			update public.qorpera_company_bootstrap_jobs set formation_manifest_sha256 = p_sha256 where id = p_job_id;
		elsif v_job.formation_manifest_sha256 <> p_sha256 then
			raise exception 'Company bootstrap manifest differs' using errcode = '23505'; end if;
	elsif p_kind = 'cofounder_agent_manifest' then
		if v_job.cofounder_agent_manifest_sha256 is null then
			update public.qorpera_company_bootstrap_jobs set cofounder_agent_manifest_sha256 = p_sha256 where id = p_job_id;
		elsif v_job.cofounder_agent_manifest_sha256 <> p_sha256 then
			raise exception 'Company bootstrap Co-Founder manifest differs' using errcode = '23505'; end if;
	elsif p_kind = 'cofounder_responsibility_content' then
		if not exists (select 1 from jsonb_each_text(v_job.cofounder_responsibility_documents) stored
			where encode(extensions.digest(convert_to(stored.value,'utf8'),'sha256'),'hex') = p_sha256
				and octet_length(stored.value) = p_bytes) then
			raise exception 'Company bootstrap responsibility differs' using errcode = '22023'; end if;
	elsif p_kind = 'cofounder_responsibility_manifest' then
		if not (v_job.cofounder_responsibility_documents ? p_path) then
			raise exception 'Company bootstrap responsibility path is unknown' using errcode = '22023'; end if;
		if v_job.cofounder_responsibility_manifest_sha256 ->> p_path is null then
			update public.qorpera_company_bootstrap_jobs set cofounder_responsibility_manifest_sha256 =
				cofounder_responsibility_manifest_sha256 || jsonb_build_object(p_path,p_sha256) where id = p_job_id;
		elsif v_job.cofounder_responsibility_manifest_sha256 ->> p_path <> p_sha256 then
			raise exception 'Company bootstrap responsibility manifest differs' using errcode = '23505'; end if;
	else
		if v_job.tree_sha256 is null then update public.qorpera_company_bootstrap_jobs set tree_sha256 = p_sha256 where id = p_job_id;
		elsif v_job.tree_sha256 <> p_sha256 then raise exception 'Company bootstrap tree differs' using errcode = '23505'; end if;
	end if;
	if p_confirm then perform public.qorpera_confirm_profile_object_upload(v_job.profile_id,p_sha256,p_bytes,'nas-object-gateway'); end if;
	return v_job.profile_id;
end
$$;

create function public.qorpera_finalize_company_bootstrap(
	p_job_id uuid,p_worker_id uuid,p_formation_document text,p_formation_manifest_text text,
	p_cofounder_agent_manifest_text text,p_tree_manifest_text text,p_organization_documents jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.qorpera_company_bootstrap_jobs%rowtype; v_file public.qorpera_company_files%rowtype;
	v_tree public.qorpera_company_path_tree_cache%rowtype; v_base_tree public.qorpera_company_path_tree_cache%rowtype;
	v_manifest jsonb; v_agent_manifest jsonb; v_entries jsonb; v_formation_entry jsonb; v_agent_entry jsonb;
	v_formation_document jsonb; v_agent_document jsonb; v_agent_document_text text; v_agent_path text;
	v_snapshot uuid := extensions.gen_random_uuid(); v_graph uuid := extensions.gen_random_uuid();
	v_objects jsonb; v_object_count integer; v_storage_bytes bigint; v_closure_sha text; v_restricted_sha text;
	v_formation_path_version uuid; v_agent_path_version uuid;
	v_bundle public.qorpera_active_runtime_bundle%rowtype; v_input uuid; v_assignment jsonb;
	v_actor jsonb; v_plan jsonb; v_result jsonb; v_current_entry public.qorpera_company_path_entries%rowtype;
	v_formation public.qorpera_company_formations%rowtype; v_document record; v_document_text text;
	v_changed_entry jsonb; v_changed_path text; v_changed_count integer;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Company bootstrap publisher authority is required' using errcode = '42501'; end if;
	perform public.qorpera_verify_company_path_file((select profile_id from public.qorpera_company_bootstrap_jobs where id=p_job_id),
		p_formation_manifest_text);
	perform public.qorpera_verify_company_path_file((select profile_id from public.qorpera_company_bootstrap_jobs where id=p_job_id),
		p_cofounder_agent_manifest_text);
	perform public.qorpera_verify_company_path_tree((select profile_id from public.qorpera_company_bootstrap_jobs where id=p_job_id),
		p_tree_manifest_text);
	select * into strict v_job from public.qorpera_company_bootstrap_jobs where id = p_job_id for update;
	if v_job.state = 'completed' then
		return jsonb_build_object('schema','qorpera.company-bootstrap-result/v1','state','completed',
			'profileId',v_job.profile_id,'environmentId',v_job.environment_id,'snapshotId',v_job.output_snapshot_id,
			'firstRunInputId',(select input_id from public.qorpera_company_first_runs where profile_id = v_job.profile_id)); end if;
	if v_job.state <> 'leased' or v_job.lease_owner <> p_worker_id or v_job.lease_expires_at <= clock_timestamp() then
		raise exception 'Company bootstrap lease is unavailable' using errcode = '42501'; end if;
	select * into strict v_file from public.qorpera_company_files where environment_id = v_job.environment_id for update;
	if v_file.head_snapshot_id is distinct from v_job.base_snapshot_id then
		raise exception 'Company bootstrap base changed' using errcode = 'PT409'; end if;
	if v_job.base_snapshot_id is not null then
		perform 1 from public.qorpera_company_snapshots snapshot where snapshot.id = v_job.base_snapshot_id
			and snapshot.profile_id = v_job.profile_id and snapshot.environment_id = v_job.environment_id
			and snapshot.tree_manifest_sha256 = v_job.base_tree_sha256
			and snapshot.tree_manifest_bytes = v_job.base_tree_bytes for share;
		if not found then raise exception 'Company bootstrap base differs' using errcode = 'PT409'; end if;
		select * into strict v_base_tree from public.qorpera_company_path_tree_cache
		where profile_id = v_job.profile_id and sha256 = v_job.base_tree_sha256 and bytes = v_job.base_tree_bytes;
	end if;
	v_manifest := p_formation_manifest_text::jsonb;
	if v_manifest ->> 'schema' <> 'qorpera.cloud-file-manifest/v1'
		or v_manifest ->> 'fileSha256' <> encode(extensions.digest(convert_to(p_formation_document,'utf8'),'sha256'),'hex')
		or (v_manifest ->> 'bytes')::bigint <> octet_length(p_formation_document)
		or encode(extensions.digest(convert_to(p_formation_manifest_text,'utf8'),'sha256'),'hex') <> v_job.formation_manifest_sha256 then
		raise exception 'Company bootstrap manifest is invalid' using errcode = '22023'; end if;
	v_agent_manifest := p_cofounder_agent_manifest_text::jsonb;
	v_agent_path := 'organization/agents/' || v_job.cofounder_staff_agent_id::text || '.json';
	if jsonb_typeof(p_organization_documents) <> 'object'
		or octet_length(convert_to(p_organization_documents::text,'utf8')) > 8388608
		or exists (select 1 from jsonb_each(p_organization_documents) document
			where jsonb_typeof(document.value) <> 'string') then
		raise exception 'Company bootstrap organization documents are invalid' using errcode = '22023'; end if;
	v_agent_document_text := coalesce(p_organization_documents ->> v_agent_path,v_job.cofounder_agent_document);
	v_agent_document := v_agent_document_text::jsonb;
	if v_agent_manifest ->> 'schema' <> 'qorpera.cloud-file-manifest/v1'
		or v_agent_manifest ->> 'fileSha256' <>
			encode(extensions.digest(convert_to(v_agent_document_text,'utf8'),'sha256'),'hex')
		or (v_agent_manifest ->> 'bytes')::bigint <> octet_length(v_agent_document_text)
		or encode(extensions.digest(convert_to(p_cofounder_agent_manifest_text,'utf8'),'sha256'),'hex') <>
			v_job.cofounder_agent_manifest_sha256
		or v_agent_document ->> 'schema' <> 'qorpera.company-agent/v1'
		or (v_agent_document ->> 'agentId')::uuid <> v_job.cofounder_staff_agent_id
		or v_agent_document ->> 'employmentStatus' <> 'active'
		or v_agent_document ->> 'lifecycleState' not in ('setup','active')
		or (v_job.first_run_required and (
			v_agent_document_text <> v_job.cofounder_agent_document
			or v_agent_document ->> 'lifecycleState' <> 'setup'
		)) then
		raise exception 'Company bootstrap Co-Founder agent document is invalid' using errcode = '22023'; end if;
	if v_job.first_run_required and exists (
		select 1 from jsonb_each_text(v_job.cofounder_responsibility_documents) stored
		where p_organization_documents ->> stored.key is distinct from stored.value) then
		raise exception 'Company bootstrap responsibility documents differ' using errcode = '22023'; end if;
	v_formation_document := p_formation_document::jsonb;
	select * into strict v_formation from public.qorpera_company_formations
	where id = v_job.formation_id and profile_id = v_job.profile_id and environment_id = v_job.environment_id;
	if jsonb_typeof(v_formation_document) <> 'object'
		or v_formation_document - array['schema','formationId','cofounderStaffAgentId','state','status','revision'] <> '{}'::jsonb
		or v_formation_document ->> 'schema' <> 'qorpera.company-formation/v1'
		or (v_formation_document ->> 'formationId')::uuid <> v_job.formation_id
		or (v_formation_document ->> 'cofounderStaffAgentId')::uuid <> v_job.cofounder_staff_agent_id
		or v_formation_document ->> 'state' <> v_formation.state
		or v_formation_document ->> 'status' <> v_formation.status
		or (v_formation_document ->> 'revision')::bigint <> v_formation.revision
		or (v_job.first_run_required and p_formation_document <> v_job.formation_document) then
		raise exception 'Company bootstrap formation document is invalid' using errcode = '22023'; end if;
	select * into strict v_tree from public.qorpera_company_path_tree_cache
	where profile_id = v_job.profile_id and sha256 = encode(extensions.digest(convert_to(p_tree_manifest_text,'utf8'),'sha256'),'hex');
	if v_tree.sha256 <> v_job.tree_sha256 then
		raise exception 'Company bootstrap tree is invalid' using errcode = '22023'; end if;
	v_entries := v_tree.manifest -> 'entries';
	if v_file.path_gateway_version is null and (
		not (v_entries @> jsonb_build_array(jsonb_build_object('path','organization','kind','directory')))
		or not (v_entries @> jsonb_build_array(jsonb_build_object('path','organization/agents','kind','directory')))
		or not (v_entries @> jsonb_build_array(jsonb_build_object('path','organization/responsibilities','kind','directory')))
		or not (v_entries @> jsonb_build_array(jsonb_build_object('path','organization/projects','kind','directory')))
	) then
		raise exception 'Company bootstrap tree layout is invalid' using errcode = '22023'; end if;
	if v_job.base_snapshot_id is null then
		if jsonb_array_length(v_entries) <> 6 + (select count(*) from jsonb_object_keys(v_job.cofounder_responsibility_documents)) then
			raise exception 'Company bootstrap genesis tree is invalid' using errcode = '22023'; end if;
	elsif exists (select 1 from jsonb_array_elements(v_base_tree.manifest -> 'entries') base
		where base ->> 'path' not in ('organization/formation.json',v_agent_path)
			and not exists (select 1 from jsonb_array_elements(v_entries) candidate where candidate = base))
		or exists (select 1 from jsonb_array_elements(v_entries) candidate
			where candidate ->> 'path' not in ('organization','organization/agents','organization/responsibilities',
				'organization/projects','organization/formation.json',v_agent_path)
			and not (v_job.cofounder_responsibility_documents ? (candidate ->> 'path'))
			and not exists (select 1 from jsonb_array_elements(v_base_tree.manifest -> 'entries') base where base = candidate)) then
		raise exception 'Company bootstrap upgrade changed existing Company File state' using errcode = '22023';
	end if;
	select value into v_formation_entry from jsonb_array_elements(v_entries) where value ->> 'path' = 'organization/formation.json';
	if v_formation_entry is not null and (v_formation_entry #>> '{file,manifestSha256}' <> v_job.formation_manifest_sha256
		or v_formation_entry #>> '{file,fileSha256}' <> v_manifest ->> 'fileSha256'
		or (v_formation_entry #>> '{file,bytes}')::bigint <> octet_length(p_formation_document)) then
		raise exception 'Company bootstrap formation entry is invalid' using errcode = '22023'; end if;
	select value into v_agent_entry from jsonb_array_elements(v_entries) where value ->> 'path' = v_agent_path;
	if v_agent_entry is not null and (v_agent_entry #>> '{file,manifestSha256}' <> v_job.cofounder_agent_manifest_sha256
		or v_agent_entry #>> '{file,fileSha256}' <> v_agent_manifest ->> 'fileSha256'
		or (v_agent_entry #>> '{file,bytes}')::bigint <> octet_length(v_agent_document_text)) then
		raise exception 'Company bootstrap Co-Founder agent entry is invalid' using errcode = '22023'; end if;
	if v_job.base_snapshot_id is null and (v_formation_entry is null or v_agent_entry is null
		or exists (select 1 from jsonb_object_keys(v_job.cofounder_responsibility_documents) required(path)
			where not exists (select 1 from jsonb_array_elements(v_entries) entry
				where entry ->> 'path' = required.path and entry ->> 'kind' = 'file'))) then
		raise exception 'Company bootstrap genesis documents are missing' using errcode = '22023'; end if;
	if v_job.first_run_required and exists (
		select 1 from jsonb_object_keys(v_job.cofounder_responsibility_documents) required(path)
		left join lateral (select value from jsonb_array_elements(v_entries) entry(value)
			where entry.value ->> 'path' = required.path) entry on true
		where entry.value #>> '{file,manifestSha256}' is distinct from
			v_job.cofounder_responsibility_manifest_sha256 ->> required.path) then
		raise exception 'Company bootstrap responsibility manifest is invalid' using errcode = '22023'; end if;
	for v_document in select value entry from jsonb_array_elements(v_entries) value
		where value ->> 'kind' = 'file' and (public.qorpera_organization_path_kind(value ->> 'path') is not null
			or public.qorpera_company_agent_path_id(value ->> 'path') is not null) loop
		v_document_text := p_organization_documents ->> (v_document.entry ->> 'path');
		if v_document_text is null
			or encode(extensions.digest(convert_to(v_document_text,'utf8'),'sha256'),'hex')
				<> v_document.entry #>> '{file,fileSha256}'
			or octet_length(v_document_text) <> (v_document.entry #>> '{file,bytes}')::bigint then
			raise exception 'Company bootstrap organization document differs from the tree' using errcode = '22023'; end if;
	end loop;
	if (select count(*) from jsonb_object_keys(p_organization_documents)) <> (select count(*)
		from jsonb_array_elements(v_entries) value where value ->> 'kind' = 'file'
			and (public.qorpera_organization_path_kind(value ->> 'path') is not null
				or public.qorpera_company_agent_path_id(value ->> 'path') is not null))
		or (v_formation_entry is not null
			and p_organization_documents ->> 'organization/formation.json' <> p_formation_document)
		or (v_agent_entry is not null
			and p_organization_documents ->> v_agent_path <> v_agent_document_text) then
		raise exception 'Company bootstrap organization document set is invalid' using errcode = '22023'; end if;
	select jsonb_agg(object order by object ->> 'sha256') into v_objects from (
		select distinct object.value object from jsonb_array_elements(v_entries) entry
		join public.qorpera_verified_company_file_objects proof on proof.profile_id = v_job.profile_id
			and proof.manifest_sha256 = entry #>> '{file,manifestSha256}'
		cross join lateral jsonb_array_elements(proof.objects) object(value)
		where entry ->> 'kind' = 'file'
		union select jsonb_build_object('sha256',v_tree.sha256,'bytes',v_tree.bytes)
	) closure;
	select count(*),sum((value ->> 'bytes')::bigint),encode(extensions.digest(convert_to(string_agg(
		(value ->> 'sha256') || ':' || (value ->> 'bytes'),E'\n' order by value ->> 'sha256'),'utf8'),'sha256'),'hex')
	into v_object_count,v_storage_bytes,v_closure_sha from jsonb_array_elements(v_objects);
	if exists (select 1 from jsonb_array_elements(v_objects) object
		left join public.qorpera_profile_objects stored on stored.profile_id = v_job.profile_id
			and stored.sha256 = object ->> 'sha256'
		where stored.sha256 is null or stored.bytes <> (object ->> 'bytes')::bigint) then
		raise exception 'Company bootstrap closure is unavailable' using errcode = '55000'; end if;
	select * into strict v_bundle from public.qorpera_active_runtime_bundle where singleton;
	select encode(extensions.digest(convert_to(coalesce(jsonb_agg(value order by value ->> 'path'),
		'[]'::jsonb)::text,'utf8'),'sha256'),'hex') into v_restricted_sha
	from jsonb_array_elements(v_entries) where public.qorpera_company_path_key(value ->> 'path')
		in ('authority.toml','agents.md','claude.md','.qorpera/authority.sig.json');
	if v_file.path_gateway_version = 1 then
		if v_file.path_index_snapshot_id is distinct from v_job.base_snapshot_id then
			raise exception 'Company bootstrap path index changed' using errcode = 'PT409'; end if;
		if exists (select 1 from public.qorpera_company_path_entries current_entry
			where current_entry.environment_id = v_job.environment_id and current_entry.entry is not null
				and not exists (select 1 from jsonb_array_elements(v_entries) candidate
					where extensions.digest(public.qorpera_company_path_key(candidate ->> 'path'),'sha256') =
						current_entry.path_key_sha256)) then
			raise exception 'Company bootstrap upgrade cannot delete Company File state' using errcode = '22023'; end if;
		select count(*),min(candidate.value ->> 'path'),min(candidate.value::text)::jsonb
		into v_changed_count,v_changed_path,v_changed_entry
		from jsonb_array_elements(v_entries) candidate(value)
		where not exists (select 1 from public.qorpera_company_path_entries current_entry
			where current_entry.environment_id = v_job.environment_id
				and current_entry.path_key_sha256 = extensions.digest(
					public.qorpera_company_path_key(candidate.value ->> 'path'),'sha256')
				and current_entry.entry = candidate.value);
		if v_changed_count > 1 then
			raise exception 'Company bootstrap upgrade must advance one path per durable snapshot' using errcode = 'PT409'; end if;
		v_actor := jsonb_build_object('companyId',v_job.profile_id,'environmentId',v_job.environment_id,
			'userId',v_job.created_by_user_id,'audience','human');
		if v_changed_count = 1 then
			select * into v_current_entry from public.qorpera_company_path_entries
			where environment_id = v_job.environment_id and path_key_sha256 =
				extensions.digest(public.qorpera_company_path_key(v_changed_path),'sha256');
			v_plan := jsonb_build_object('schema','qorpera.company-path-mutation/v1',
				'operationKey','company-bootstrap-upgrade:' || v_job.id::text || ':' || v_job.attempt::text,
				'path',v_changed_path,'expectedVersion',case when found then to_jsonb(v_current_entry.version) else 'null'::jsonb end,
				'entry',v_changed_entry);
			v_result := public.qorpera_publish_company_path(
				v_actor,null,v_plan,v_job.base_snapshot_id,v_tree.sha256,null,null
			);
			v_snapshot := (v_result ->> 'snapshotId')::uuid;
			if public.qorpera_organization_path_kind(v_changed_path) is not null then
				perform public.qorpera_project_organization_document(v_actor,v_plan,
					p_organization_documents ->> v_changed_path,v_snapshot,(v_result ->> 'version')::uuid);
			elsif public.qorpera_company_agent_path_id(v_changed_path) is not null then
				perform public.qorpera_project_company_agent_document(v_actor,v_plan,
					p_organization_documents ->> v_changed_path,v_snapshot,(v_result ->> 'version')::uuid);
			end if;
			update public.qorpera_company_bootstrap_jobs set state = 'queued',lease_owner = null,
				lease_expires_at = null,candidate_snapshot_id = null,updated_at = clock_timestamp()
			where id = v_job.id;
			return jsonb_build_object('schema','qorpera.company-bootstrap-result/v1','state','provisioning',
				'profileId',v_job.profile_id,'environmentId',v_job.environment_id,'snapshotId',v_snapshot,
				'firstRunInputId',null);
		end if;
		if v_formation_entry is null or v_agent_entry is null
			or exists (select 1 from jsonb_object_keys(v_job.cofounder_responsibility_documents) required(path)
				where not exists (select 1 from jsonb_array_elements(v_entries) entry
					where entry ->> 'path' = required.path and entry ->> 'kind' = 'file')) then
			raise exception 'Company bootstrap upgrade is incomplete' using errcode = '55000'; end if;
		v_snapshot := v_job.base_snapshot_id;
		select * into strict v_current_entry from public.qorpera_company_path_entries
		where environment_id = v_job.environment_id and path_key_sha256 =
			extensions.digest(public.qorpera_company_path_key('organization/formation.json'),'sha256');
		v_formation_path_version := v_current_entry.version;
		if v_formation.projection_status <> 'verified'
			or v_formation.source_path_version <> v_current_entry.version
			or v_formation.source_file_sha256 <> v_formation_entry #>> '{file,fileSha256}' then
			v_plan := jsonb_build_object('schema','qorpera.company-path-mutation/v1','operationKey','company-bootstrap-project',
				'path','organization/formation.json','expectedVersion',v_current_entry.version,'entry',v_formation_entry);
			perform public.qorpera_project_organization_document(
				v_actor,v_plan,p_formation_document,v_snapshot,v_current_entry.version
			);
		end if;
		select * into strict v_current_entry from public.qorpera_company_path_entries
		where environment_id = v_job.environment_id and path_key_sha256 =
			extensions.digest(public.qorpera_company_path_key(v_agent_path),'sha256');
		v_agent_path_version := v_current_entry.version;
		if not exists (select 1 from public.qorpera_profile_staff staff
			where staff.profile_id = v_job.profile_id and staff.staff_agent_id = v_job.cofounder_staff_agent_id
				and staff.source_path_key_sha256 = v_current_entry.path_key_sha256
				and staff.source_path_version = v_current_entry.version
				and staff.source_file_sha256 = v_agent_entry #>> '{file,fileSha256}') then
			v_plan := jsonb_build_object('schema','qorpera.company-path-mutation/v1','operationKey','company-bootstrap-agent-project',
				'path',v_agent_path,'expectedVersion',v_current_entry.version,'entry',v_agent_entry);
			perform public.qorpera_project_company_agent_document(
				v_actor,v_plan,v_agent_document_text,v_snapshot,v_current_entry.version
			);
		end if;
	elsif v_file.path_gateway_version is null then
		update public.qorpera_company_bootstrap_jobs set candidate_snapshot_id = v_snapshot where id = v_job.id;
		insert into public.qorpera_company_snapshots(id,profile_id,environment_id,workspace_id,client_snapshot_id,
			parent_snapshot_id,tree_manifest_sha256,tree_manifest_bytes,tree_contract_version,file_count,total_bytes,created_by_user_id)
		values (v_snapshot,v_job.profile_id,v_job.environment_id,v_file.canonical_workspace_id,v_snapshot,v_job.base_snapshot_id,
			v_tree.sha256,v_tree.bytes,3,v_tree.file_count,v_tree.total_bytes,v_job.created_by_user_id);
		insert into public.qorpera_company_snapshot_publications(snapshot_id,expected_head_snapshot_id,restricted_content_sha256,
			status,published_at) values (v_snapshot,v_job.base_snapshot_id,v_restricted_sha,'published',clock_timestamp());
		insert into public.qorpera_object_reachability_graphs(id,profile_id,environment_id,root_kind,root_id,client_graph_id,
			root_object_sha256,contract_version,content_sha256,object_count,storage_bytes,status,created_by_user_id,
			completed_at,closure_verified)
		values (v_graph,v_job.profile_id,v_job.environment_id,'company_snapshot',v_snapshot,v_graph,v_tree.sha256,1,
			v_closure_sha,v_object_count,v_storage_bytes,'complete',v_job.created_by_user_id,clock_timestamp(),true);
		insert into public.qorpera_object_reachability_entries(graph_id,object_sha256,bytes)
		select v_graph,value ->> 'sha256',(value ->> 'bytes')::bigint from jsonb_array_elements(v_objects);
		insert into public.qorpera_object_restore_proofs(graph_id,profile_id,client_proof_id,restored_content_sha256,
			restored_bytes,verified_by_user_id)
		values (v_graph,v_job.profile_id,v_graph,v_tree.sha256,v_tree.total_bytes,v_job.created_by_user_id);
		update public.qorpera_company_files set head_snapshot_id = v_snapshot,logical_bytes = v_tree.total_bytes,
			state = 'ready',updated_at = clock_timestamp() where environment_id = v_job.environment_id;
		update public.qorpera_company_workspaces set head_snapshot_id = v_snapshot,updated_at = clock_timestamp()
		where id = v_file.canonical_workspace_id;
		perform public.qorpera_enable_company_path_gateway_v3(v_job.environment_id,v_snapshot,
			v_job.created_by_user_id,p_organization_documents);
		select version into strict v_formation_path_version from public.qorpera_company_path_entries
		where environment_id = v_job.environment_id and path = 'organization/formation.json';
		select version into strict v_agent_path_version from public.qorpera_company_path_entries
		where environment_id = v_job.environment_id and path = v_agent_path;
		insert into public.qorpera_company_path_revisions(snapshot_id,environment_id,parent_snapshot_id,tree_sha256,tree_bytes,
			file_count,total_bytes,actor_user_id,change,requester_user_id,audience_kind,operation_key,
			runtime_bundle_id,runtime_bundle_sha256)
		values (v_snapshot,v_job.environment_id,v_job.base_snapshot_id,v_tree.sha256,v_tree.bytes,v_tree.file_count,v_tree.total_bytes,
			v_job.created_by_user_id,jsonb_build_object('schema','qorpera.company-bootstrap-change/v1',
				'plan',jsonb_build_object('operationKey','company-bootstrap','path','organization/formation.json'),
				'formationPathVersion',v_formation_path_version,'cofounderAgentPathVersion',v_agent_path_version),
			v_job.created_by_user_id,'company','company-bootstrap',
			v_bundle.runtime_bundle_id,v_bundle.runtime_bundle_sha256);
	else
		raise exception 'Company bootstrap path gateway version is unsupported' using errcode = '55000';
	end if;
	if v_job.first_run_required then
		v_assignment := jsonb_build_object('schema','qorpera.company-first-run/v1','assignment',jsonb_build_object(
			'kind','company_formation','companyId',v_job.profile_id,'formationId',v_job.formation_id,
			'cofounderStaffAgentId',v_job.cofounder_staff_agent_id,'startState','source_inventory'));
		insert into public.qorpera_session_inputs(session_id,client_input_id,kind,author_user_id,body)
		values (v_job.member_session_id,v_job.id,'kickoff',v_job.created_by_user_id,v_assignment)
		returning id into v_input;
		insert into public.qorpera_company_first_runs(profile_id,environment_id,cofounder_staff_agent_id,formation_id,
			session_id,input_id,assignment)
		values (v_job.profile_id,v_job.environment_id,v_job.cofounder_staff_agent_id,v_job.formation_id,
			v_job.member_session_id,v_input,v_assignment);
	end if;
	insert into public.qorpera_agent_first_runs(profile_id,environment_id,staff_agent_id,session_id,input_id,
		source_path_version,startup_assignment)
	select first_run.profile_id,first_run.environment_id,first_run.cofounder_staff_agent_id,
		first_run.session_id,first_run.input_id,v_agent_path_version,first_run.assignment
	from public.qorpera_company_first_runs first_run where first_run.profile_id = v_job.profile_id
	on conflict (profile_id,staff_agent_id) do nothing;
	update public.qorpera_company_bootstrap_jobs set state = 'completed',lease_owner = null,lease_expires_at = null,
		output_snapshot_id = v_snapshot,completed_at = clock_timestamp(),updated_at = clock_timestamp()
	where id = v_job.id;
	return jsonb_build_object('schema','qorpera.company-bootstrap-result/v1','state','completed',
		'profileId',v_job.profile_id,'environmentId',v_job.environment_id,'snapshotId',v_snapshot,
		'firstRunInputId',v_input);
end
$$;

create or replace function public.qorpera_company_organization_bootstrap(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_job public.qorpera_company_bootstrap_jobs%rowtype;
begin
	if not public.qorpera_can_write_profile(p_profile_id) then
		raise exception 'company organization write access is required' using errcode = '42501'; end if;
	select * into strict v_job from public.qorpera_company_bootstrap_jobs where profile_id = p_profile_id;
	if v_job.state <> 'completed' then
		raise exception 'company organization bootstrap is provisioning' using errcode = '55000'; end if;
	return jsonb_build_object('schema','qorpera.company-organization-bootstrap/v1','cofounder',jsonb_build_object(
		'staff_agent_id',v_job.cofounder_staff_agent_id,'formation_id',v_job.formation_id,
		'member_session_id',(select session.id from public.qorpera_shared_sessions session
			where session.profile_id = p_profile_id and session.staff_agent_id = v_job.cofounder_staff_agent_id::text
				and session.audience_kind = 'member_private' and session.audience_user_id = auth.uid()
				and session.status = 'open' limit 1)),'formation_state','source_inventory');
end
$$;

create or replace function public.qorpera_execution_run_json(p_run public.qorpera_execution_runs)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object(
		'run_id',p_run.id,'profile_id',p_run.profile_id,'environment_id',p_run.environment_id,
		'source_kind',p_run.source_kind,'source_id',p_run.source_id,'session_id',p_run.session_id,'job_id',p_run.job_id,
		'substrate_version_id',p_run.substrate_version_id,'company_snapshot_id',p_run.company_snapshot_id,
		'staff_agent_id',p_run.staff_agent_id,'staff_version',p_run.staff_version,
		'model_provider',p_run.model_provider,'model_id',p_run.model_id,'model_selection',p_run.model_selection,
		'model_mapping_version',p_run.model_mapping_version,'input_ids',to_jsonb(p_run.input_ids),
		'sponsor_binding_id',p_run.sponsor_binding_id,'sponsor_version',p_run.sponsor_version,
		'required_capability',p_run.required_capability,'job_type',p_run.job_type,'payload_sha256',p_run.payload_sha256,
		'publication_mode',p_run.publication_mode,'review_policy_key',p_run.review_policy_key,
		'reviewer_staff_ids',to_jsonb(p_run.reviewer_staff_ids),'logical_computer_id',p_run.logical_computer_id,
		'compute_identity_id',p_run.compute_identity_id,
		'compute_identity_ownership_kind',(select identity.ownership_kind from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'compute_identity_owner_user_id',(select identity.owner_user_id from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'compute_identity_owner_scope_key',(select identity.owner_scope_key from public.qorpera_member_compute_identities identity where identity.id=p_run.compute_identity_id),
		'worker_class',p_run.worker_class,'requested_by_user_id',p_run.requested_by_user_id,
		'sponsored_by_user_id',p_run.sponsored_by_user_id,'audience_kind',p_run.audience_kind,
		'audience_user_id',p_run.audience_user_id,'runtime_bundle_id',p_run.runtime_bundle_id,
		'runtime_bundle_sha256',p_run.runtime_bundle_sha256,'transcript_start_sequence',p_run.transcript_start_sequence,
		'status',coalesce((select event.event_type from public.qorpera_execution_run_events event
			where event.run_id=p_run.id order by event.id desc limit 1),'queued'),
		'created_by_user_id',p_run.created_by_user_id,'created_at',p_run.created_at,'deadline_at',p_run.deadline_at)
$$;

revoke all on function public.qorpera_reject_runtime_bundle_mutation(),public.qorpera_pin_session_input_provenance(),
	public.qorpera_assert_session_parent_audience(),public.qorpera_pin_execution_run_audience(),
	public.qorpera_pin_company_path_revision_provenance(),public.qorpera_company_bootstrap_document(uuid),
	public.qorpera_company_bootstrap_agent_document(uuid),
	public.qorpera_company_bootstrap_responsibility_documents(uuid),
	public.qorpera_enqueue_company_bootstrap(uuid,boolean),public.qorpera_claim_company_bootstrap(uuid,integer),
	public.qorpera_stage_company_bootstrap_object(uuid,uuid,text,text,bigint,boolean,text),
	public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb)
	from public,anon,authenticated,service_role;
do $$
declare v_entry_owner name;
begin
	select role.rolname into v_entry_owner
	from pg_proc procedure
	join pg_roles role on role.oid = procedure.proowner
	where procedure.oid = 'public.qorpera_create_cloud_company(uuid,text,integer)'::regprocedure;
	if v_entry_owner is null then
		raise exception 'Company creation function owner is unavailable' using errcode = '55000';
	end if;
	execute format(
		'grant execute on function public.qorpera_enqueue_company_bootstrap(uuid,boolean) to %I',
		v_entry_owner
	);
end
$$;
grant execute on function public.qorpera_claim_company_bootstrap(uuid,integer),
	public.qorpera_stage_company_bootstrap_object(uuid,uuid,text,text,bigint,boolean,text),
	public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb) to service_role;
