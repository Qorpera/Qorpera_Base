-- 20260930330000: the legacy sweep, step D1 (company creation and the bootstrap). The old chain that set a company
-- up from a snapshot goes (folder-v2 only, the founder's decision of 3 October): the two create RPCs and the local
-- profile promotion, the bootstrap job's enqueue, claim, staging and finalize, the Co-Founder seed, the bootstrap
-- documents, the old roster writers and the old gateway's v3 enable. A company is made only by C2's open, seed and
-- create (P14a). Eleven functions keep their folder-v2 path; each is patched in place from its live text, so its
-- header, its grants and the other migrations' changes to it stay; each anchor must occur exactly once.
-- 1. Company creation: C2's open, seed, enable and create no longer look for a bootstrap job; the create's
--    'old_chain' answer goes.
-- 2. Founding: the lobby's open no longer refuses a company with a bootstrap job. Its gc-fence branch (the company
--    row FOR UPDATE off folder-v2) stays for G, with the other lobby functions'.
-- 3. The departure guard, the team info's leave capability, the company list and a deletion's stop no longer read a
--    bootstrap job. The list keeps its bootstrap_state key ('legacy', what a folder-v2 company always had) for
--    clients until C2.
-- 4. The old Company File gateway's agent projection and its snapshot writer check lose their bootstrap branch.
-- 5. Dropped: the fourteen functions of the old chain, the roster write guard (its whole body was a bootstrap check)
--    with its trigger, and the tables qorpera_company_bootstrap_jobs and qorpera_company_first_runs, which must be
--    empty. qorpera_verify_company_path_tree stays (the runtime calls it until C-P7).
-- Every patched body names this migration (20260930330000), and every earlier marker in it stays.
set local lock_timeout = '3s';

create function pg_temp.d1_patch(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Legacy sweep D1 anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Company creation (C2's open, seed, enable and create) no longer looks for the old chain's job. -------------------

select pg_temp.d1_patch('public.qorpera_folder_company_open(uuid,uuid,text)'::regprocedure,
$old$		-- A creation id the old path used names a company with a bootstrap job: never a folder-v2 company.
$old$,
$new$		-- 20260930330000 (legacy sweep D1): a creation id names a folder-v2 company or none (the old chain is gone).
$new$);

select pg_temp.d1_patch('public.qorpera_folder_company_open(uuid,uuid,text)'::regprocedure,
$old$		if v_request.profile_id is null or v_environment is null
			or exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_request.profile_id) then
$old$,
$new$		if v_request.profile_id is null or v_environment is null then
$new$);

select pg_temp.d1_patch('public.qorpera_folder_company_seed(uuid,jsonb)'::regprocedure,
$old$	if v_environment is null or exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = p_profile_id)
		or exists (select 1 from public.qorpera_company_cofounders where profile_id = p_profile_id) then
$old$,
$new$	-- 20260930330000 (legacy sweep D1): the old chain's bootstrap job is gone, so it no longer refuses a seed.
	if v_environment is null
		or exists (select 1 from public.qorpera_company_cofounders where profile_id = p_profile_id) then
$new$);

select pg_temp.d1_patch('public.qorpera_folder_enable_internal(uuid)'::regprocedure,
$old$	-- 20260930010000 (P14a): a bootstrap job (the old chain) makes a company touched (#444).
$old$,
$new$	-- 20260930010000 (P14a): only an untouched company takes the folder core (#444). 20260930330000 (legacy sweep D1):
	-- the old chain's bootstrap job is gone, so it is no longer one of the signs.
$new$);

select pg_temp.d1_patch('public.qorpera_folder_enable_internal(uuid)'::regprocedure,
$old$		or exists (select 1 from public.qorpera_event_hooks where environment_id = p_environment_id and status <> 'removed')
		or exists (select 1 from public.qorpera_company_bootstrap_jobs where environment_id = p_environment_id) then
$old$,
$new$		or exists (select 1 from public.qorpera_event_hooks where environment_id = p_environment_id and status <> 'removed') then
$new$);

select pg_temp.d1_patch('public.qorpera_folder_company_create(uuid,uuid,bigint,jsonb)'::regprocedure,
$old$	-- The old chain never ran, nobody recorded a Co-Founder, and the member who started it is still here (the
	-- departure guard holds them while the creation is queued or leased; this is the check behind it).
	if exists (select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_creation.profile_id) then
		v_problem := 'old_chain';
	elsif exists (select 1 from public.qorpera_company_cofounders where profile_id = v_creation.profile_id) then
$old$,
$new$	-- Nobody recorded a Co-Founder, and the member who started it is still here (the departure guard holds them while
	-- the creation is queued or leased; this is the check behind it). 20260930330000 (legacy sweep D1): the old
	-- chain is gone, and with it the 'old_chain' answer.
	if exists (select 1 from public.qorpera_company_cofounders where profile_id = v_creation.profile_id) then
$new$);

-- 2. Founding: the lobby's open no longer looks for the old chain's job. ----------------------------------------------

select pg_temp.d1_patch('public.qorpera_open_company_founding(uuid,text)'::regprocedure,
$old$		-- Only a company made just now becomes a table: the caller alone, as owner, with no setup
		-- queued (a company made the old way always has a bootstrap job).
$old$,
$new$		-- Only a company made just now becomes a table: the caller alone, as owner. 20260930330000
		-- (legacy sweep D1): the old chain that queued setup is gone.
$new$);

select pg_temp.d1_patch('public.qorpera_open_company_founding(uuid,text)'::regprocedure,
$old$			or not exists(select 1 from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user)
			or exists(select 1 from public.qorpera_company_bootstrap_jobs where profile_id = v_profile) then
$old$,
$new$			or not exists(select 1 from public.qorpera_profile_members where profile_id = v_profile and user_id = v_user) then
$new$);

-- 3. Members, the company list and deletion no longer read the old chain's job. ---------------------------------------

select pg_temp.d1_patch('public.qorpera_guard_founder_departure()'::regprocedure,
$old$	-- Company setup acts for the founder it was queued for.
	if exists (select 1 from public.qorpera_company_bootstrap_jobs as job
		where job.profile_id = old.profile_id and job.created_by_user_id = old.user_id
			and job.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	-- 20260930010000 (P14a): so does a folder-v2 creation, for the member who started it.
$old$,
$new$	-- Company setup acts for the founder it was queued for: a folder-v2 creation, for the member who started it
	-- (20260930010000, P14a). 20260930330000 (legacy sweep D1): the old chain's bootstrap job is gone.
$new$);

select pg_temp.d1_patch('public.qorpera_profile_team_info(uuid)'::regprocedure,
$old$				and not exists (select 1 from public.qorpera_company_bootstrap_jobs as job
					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased'))
				-- 20260930010000 (P14a): nor a folder-v2 creation.
$old$,
$new$				-- 20260930010000 (P14a): nor a folder-v2 creation they started. 20260930330000 (legacy sweep D1): the old
				-- chain's bootstrap job is gone.
$new$);

select pg_temp.d1_patch('public.qorpera_list_hosted_profiles()'::regprocedure,
$old$'created_at',profile.created_at,'bootstrap_state',coalesce(job.state,'legacy')
$old$,
$new$'created_at',profile.created_at,'bootstrap_state','legacy'
$new$);

select pg_temp.d1_patch('public.qorpera_list_hosted_profiles()'::regprocedure,
$old$	left join public.qorpera_company_bootstrap_jobs job on job.profile_id = profile.id
	where member.user_id = auth.uid() and not (coalesce(job.hidden_until_ready,false) and job.state <> 'completed')
$old$,
$new$	-- 20260930330000 (legacy sweep D1): the old chain's bootstrap job is gone; bootstrap_state stays 'legacy' for
	-- clients until C2.
	where member.user_id = auth.uid()
$new$);

select pg_temp.d1_patch('public.qorpera_stop_company_work(uuid)'::regprocedure,
$old$	update public.qorpera_company_bootstrap_jobs
	set state = 'blocked', lease_owner = null, lease_expires_at = null, last_error = 'Company deleted',
		updated_at = clock_timestamp()
	where profile_id = p_profile_id and state in ('queued', 'leased');
$old$,
$new$	-- 20260930330000 (legacy sweep D1): the old chain's bootstrap job is gone; nothing to block.
$new$);

-- 4. The old Company File gateway's agent projection and snapshot writer check lose their bootstrap branch. -----------

select pg_temp.d1_patch('public.qorpera_project_company_agent_document(jsonb,jsonb,text,uuid,uuid)'::regprocedure,
$old$	if v_staff.profile_id is not null and v_staff.source_path is null and exists (
		select 1 from public.qorpera_company_cofounders cofounder
		join public.qorpera_company_bootstrap_jobs job on job.profile_id = cofounder.profile_id
		where cofounder.profile_id = v_profile_id and cofounder.staff_agent_id = v_id
			and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
			and job.cofounder_agent_document::jsonb = v_document
	) then
		if (v_document ->> 'revision')::bigint <> v_staff.version
			or v_document ->> 'employmentStatus' <> 'active' or v_document ->> 'lifecycleState' <> 'setup'
			or v_created_at <> v_staff.created_at or v_document ->> 'displayName' <> v_staff.display_name
			or v_document ->> 'role' <> v_staff.role or v_hire ->> 'charter' <> v_staff.charter
			or nullif(v_hire ->> 'templateId','') is distinct from v_staff.template_id
			or v_appearance ->> 'color' <> v_staff.appearance_color
			or v_appearance ->> 'shape' <> v_staff.appearance_shape
			or nullif(v_appearance ->> 'creature','') is distinct from v_staff.appearance_creature
			or nullif(v_model ->> 'provider','') is distinct from v_staff.model_provider
			or nullif(v_model ->> 'modelId','') is distinct from v_staff.model_id then
			raise exception 'Co-Founder agent document differs from its bootstrap identity' using errcode = '42501'; end if;
		update public.qorpera_profile_staff set source_path = p_plan ->> 'path',source_path_version = p_path_version,
			source_environment_id = v_environment_id,source_snapshot_id = p_snapshot_id,
			source_file_sha256 = p_plan #>> '{entry,file,fileSha256}',hire_overlay = v_hire,
			reasoning_policy = v_reasoning,startup_instructions = v_document ->> 'startupInstructions',
			updated_at = statement_timestamp(),updated_by_user_id = v_user_id
		where profile_id = v_profile_id and staff_agent_id = v_id;
		perform public.qorpera_project_company_agent_grants(
			p_actor,v_id,v_grants,p_path_version,true
		);
		return;
	end if;
$old$,
$new$	-- 20260930330000 (legacy sweep D1): the old chain's Co-Founder branch (a leased bootstrap job's agent
	-- document) is gone.
$new$);

select pg_temp.d1_patch('public.qorpera_enforce_company_workspace_writer()'::regprocedure,
$old$	if exists (select 1 from public.qorpera_company_bootstrap_jobs job
		where job.candidate_snapshot_id = new.id and job.profile_id = new.profile_id
			and job.environment_id = new.environment_id and job.created_by_user_id = new.created_by_user_id
			and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
			and job.tree_sha256 = new.tree_manifest_sha256) then return new; end if;
$old$,
$new$	-- 20260930330000 (legacy sweep D1): the old chain's bootstrap job is gone, so it writes no snapshot.
$new$);

-- 5. The old chain goes ---------------------------------------------------------------------------------------------

-- The roster write guard refused a member's staff write once a bootstrap job had completed; nothing else.
drop trigger qorpera_profile_staff_company_file_writer on public.qorpera_profile_staff;
drop function public.qorpera_guard_company_file_staff_write();

drop function public.qorpera_create_cloud_company(uuid,text,integer);
drop function public.qorpera_create_hosted_profile(text,text,integer);
drop function public.qorpera_promote_local_profile(uuid,text,text,integer);
drop function public.qorpera_seed_company_cofounder(uuid,uuid);
drop function public.qorpera_enqueue_company_bootstrap(uuid,boolean);
drop function public.qorpera_claim_company_bootstrap(uuid,integer);
drop function public.qorpera_stage_company_bootstrap_object(uuid,uuid,text,text,bigint,boolean,text);
drop function public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb);
drop function public.qorpera_company_bootstrap_document(uuid);
drop function public.qorpera_company_bootstrap_agent_document(uuid);
drop function public.qorpera_company_organization_bootstrap(uuid);
drop function public.qorpera_put_profile_staff(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,
	timestamp with time zone,bigint);
drop function public.qorpera_delete_profile_staff(uuid,uuid,bigint);
drop function public.qorpera_enable_company_path_gateway_v3(uuid,uuid,uuid,jsonb);

-- Last, because dropping the tables locks every table their foreign keys name (auth.users, the company, its Company
-- File row, staff, formations, sessions, inputs and snapshots) until the migration commits. They go only while
-- empty; the lock keeps a job or a first run from arriving between the check and the drop. All in one statement, as
-- 20260928489270 does: a bare LOCK TABLE fails where each statement commits.
do $$
begin
	lock table public.qorpera_company_bootstrap_jobs, public.qorpera_company_first_runs in access exclusive mode;
	if exists (select 1 from public.qorpera_company_bootstrap_jobs)
		or exists (select 1 from public.qorpera_company_first_runs) then
		raise exception 'Legacy sweep D1 drops the old chain''s bootstrap jobs and first runs only while there are none'
			using errcode = '55000'; end if;
	drop table public.qorpera_company_first_runs;
	drop table public.qorpera_company_bootstrap_jobs;
end $$;

-- Nothing that runs may still name the old chain.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and procedure.prosrc ~ ('qorpera_company_(bootstrap_jobs|first_runs)\M'
				|| '|qorpera_(create_cloud_company|create_hosted_profile|promote_local_profile|seed_company_cofounder)\M'
				|| '|qorpera_(enqueue|claim|finalize)_company_bootstrap\M|qorpera_stage_company_bootstrap_object\M'
				|| '|qorpera_company_(bootstrap_document|bootstrap_agent_document|organization_bootstrap)\M'
				|| '|qorpera_(put|delete)_profile_staff\M|qorpera_enable_company_path_gateway_v3\M'
				|| '|qorpera_guard_company_file_staff_write\M')
	loop
		raise exception 'Function % still names the old chain', v_name;
	end loop;
end $$;
