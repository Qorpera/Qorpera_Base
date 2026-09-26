-- Ordinary company work must produce durable files. The historical default
-- granted only read, so new agents could never save reports without an owner
-- manually granting write. Keep the existing grant origin/helper names so
-- revocations and all creation/reactivation callers retain their identities.
-- Explicit grants, child resources and protected-path approval are unchanged.
create or replace function public.qorpera_ensure_default_agent_read_grants(p_profile_id uuid, p_staff_agent_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_inserted integer := 0; v_recovered integer; v_resource record; v_staff record;
begin
	v_owner := public.qorpera_company_owner_user_id(p_profile_id);
	if v_owner is null then return 0; end if;
	for v_resource in
		select resource.id, resource.version from public.qorpera_company_path_resources as resource
		join public.qorpera_company_environments as environment on environment.id = resource.environment_id
		where environment.profile_id = p_profile_id and resource.path = '' and resource.path_match = 'subtree'
			and resource.scope = 'company_shared' and resource.revoked_at is null
	loop
		for v_staff in
			select staff.staff_agent_id from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.employment_status = 'active'
				and (p_staff_agent_id is null or staff.staff_agent_id = p_staff_agent_id)
		loop
			-- Upgrade only live platform defaults, including a returning agent's
			-- old default. Never widen an explicit read-only grant.
			update public.qorpera_company_path_grants as grant_row
			set permissions = array['read','write']::text[]
			where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
				and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
				and grant_row.origin = 'default_agent_read' and grant_row.revoked_at is null
				and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
				and grant_row.permissions = array['read']::text[];
			-- The old rollover trigger omitted defaults while staff were archived.
			-- Recover only wholly valid platform-default history, with no current
			-- grant or owner restriction. Keep its earliest expiry and attribution;
			-- an older valid row must never revive a later revoked/expired grant.
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, created_at, created_by_user_id, origin)
			select v_resource.id, v_resource.version, 'staff_agent', v_staff.staff_agent_id,
				array['read','write']::text[], history.expires_at, history.created_at, history.created_by_user_id, 'default_agent_read'
			from public.qorpera_company_path_grants as history
			where history.resource_id = v_resource.id and history.principal_kind = 'staff_agent'
				and history.principal_id = v_staff.staff_agent_id and history.origin = 'default_agent_read'
				and not exists (
					select 1 from public.qorpera_company_path_grants as current_grant
					where current_grant.resource_id = v_resource.id and current_grant.resource_version = v_resource.version
						and current_grant.principal_kind = 'staff_agent' and current_grant.principal_id = v_staff.staff_agent_id)
				and not exists (
					select 1 from public.qorpera_company_path_grants as restriction
					where restriction.resource_id = v_resource.id and restriction.principal_kind = 'staff_agent'
						and restriction.principal_id = v_staff.staff_agent_id
						and (restriction.origin <> 'default_agent_read' or restriction.revoked_at is not null
							or restriction.expires_at <= clock_timestamp()))
			order by history.expires_at nulls last, history.created_at, history.id limit 1;
			get diagnostics v_recovered = row_count;
			v_inserted := v_inserted + v_recovered;
			if not exists (
				select 1 from public.qorpera_company_path_grants as grant_row
				where grant_row.resource_id = v_resource.id and grant_row.resource_version = v_resource.version
					and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id
					and 'read' = any(grant_row.permissions) and grant_row.revoked_at is null
					and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp()))
			and not exists (
				-- Prior access is not a missing default. Preserve explicit access
				-- decisions as well as defaults omitted by older rollover triggers,
				-- including expired and revoked grants at historical versions.
				select 1 from public.qorpera_company_path_grants as grant_row
				where grant_row.resource_id = v_resource.id
					and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = v_staff.staff_agent_id) then
				insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
					permissions, expires_at, created_by_user_id, origin)
				values (v_resource.id, v_resource.version, 'staff_agent', v_staff.staff_agent_id,
					array['read','write']::text[], null, v_owner, 'default_agent_read');
				v_inserted := v_inserted + 1;
			end if;
		end loop;
	end loop;
	return v_inserted;
end
$$;

-- Policy approval borrows an owner's identity but is not that member's consent.
-- Preserve that distinction through the later publication transaction. Old
-- pending hires have no proof of member consent; require the creator bound or
-- a fresh member review. Include pending new rooms so their existing policy
-- approval remains renewable. Completed receipts retain their replay semantics.
alter table public.qorpera_company_path_proposals add column approval_origin text not null default 'member'
	check (approval_origin in ('member','agent_policy'));
update public.qorpera_company_path_proposals set approval_origin = 'agent_policy'
where status = 'approved' and public.qorpera_agent_creatable_path_kind(plan ->> 'path') in ('agent','room')
	and plan -> 'expectedVersion' = 'null'::jsonb and plan -> 'entry' <> 'null'::jsonb;

create function public.qorpera_assert_agent_default_delegation(p_profile_id uuid, p_staff_agent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
	-- The caller holds the company profile fence, which serializes ACL changes.
	-- New staff receive defaults in every environment, not only the run's one.
	-- A finite parent grant cannot delegate the child's nonexpiring default.
	if not exists (select 1 from public.qorpera_profile_staff staff
		where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id
			and staff.employment_status = 'active') or exists (
		select 1 from public.qorpera_company_path_resources resource
		join public.qorpera_company_environments environment on environment.id = resource.environment_id
		where environment.profile_id = p_profile_id and resource.path = '' and resource.path_match = 'subtree'
			and resource.scope = 'company_shared' and resource.revoked_at is null
			and not exists (select 1 from public.qorpera_company_path_grants grant_row
				where grant_row.resource_id = resource.id and grant_row.resource_version = resource.version
					and grant_row.principal_kind = 'staff_agent' and grant_row.principal_id = p_staff_agent_id
					and grant_row.permissions = array['read','write']::text[]
					and grant_row.revoked_at is null and grant_row.expires_at is null)) then
		raise exception 'Hiring requires member approval: creator cannot delegate default Company File access' using errcode = '42501';
	end if;
end
$$;
revoke all on function public.qorpera_assert_agent_default_delegation(uuid,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Patch the current definitions so later authority fixes and the removal of
-- hiring-count limits stay intact. Fail the migration if an anchor changes.
create function pg_temp.default_write_patch(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition,p_old,''))) / length(p_old) <> 1 then
		raise exception 'Default write authority patch differs: %', p_function; end if;
	execute replace(v_definition,p_old,p_new);
end
$$;
select pg_temp.default_write_patch('public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure,
	$old$	select member.role into v_role from public.qorpera_profile_members member$old$,
	$new$	if v_proposal.status = 'approved' and v_proposal.approval_origin = 'member' then
		-- An agent retry neither renews nor replaces an authenticated decision.
		if v_proposal.approval_expires_at <= clock_timestamp() then
			raise exception 'Company File approval expired' using errcode = '42501'; end if;
		return jsonb_build_object('proposalId', v_proposal.id, 'planSha256', v_proposal.plan_sha256, 'state', 'approved');
	end if;
	if v_kind = 'agent' then
		perform public.qorpera_assert_agent_default_delegation(v_run.profile_id,v_run.staff_agent_id);
	end if;
	select member.role into v_role from public.qorpera_profile_members member$new$);
select pg_temp.default_write_patch('public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure,
	$old$set status = 'approved', approved_by_user_id = v_approver,$old$,
	$new$set status = 'approved', approved_by_user_id = v_approver, approval_origin = 'agent_policy',$new$);
select pg_temp.default_write_patch('public.qorpera_review_company_path_proposal(uuid,text,text)'::regprocedure,
	$old$		if v_proposal.status = 'approved' then$old$,
	$new$		if v_proposal.status = 'approved' and v_proposal.approval_origin = 'member' then$new$);
select pg_temp.default_write_patch('public.qorpera_review_company_path_proposal(uuid,text,text)'::regprocedure,
	$old$	return jsonb_build_object('state',case p_decision$old$,
	$new$	update public.qorpera_company_path_proposals set approval_origin = 'member' where id = p_proposal_id;
	return jsonb_build_object('state',case p_decision$new$);
select pg_temp.default_write_patch('public.qorpera_company_path_approved_actor(uuid,text)'::regprocedure,
	$old$	select * into strict v_run from public.qorpera_execution_runs where id = v_proposal.run_id;$old$,
	$new$	select * into strict v_run from public.qorpera_execution_runs where id = v_proposal.run_id;
	if v_proposal.approval_origin = 'agent_policy'
		and public.qorpera_agent_creatable_path_kind(v_proposal.plan ->> 'path') = 'agent' then
		perform public.qorpera_assert_agent_default_delegation(v_run.profile_id,v_run.staff_agent_id);
	end if;$new$);

create or replace function public.qorpera_default_agent_read_on_resource()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid;
begin
	if new.path = '' and new.path_match = 'subtree' and new.scope = 'company_shared' and new.revoked_at is null then
		select environment.profile_id into v_profile from public.qorpera_company_environments as environment
		where environment.id = new.environment_id;
		if tg_op = 'UPDATE' and new.version is distinct from old.version then
			-- Preserve the complete grant, including expiry and revocation, so a
			-- later reactivation cannot recreate access an owner withdrew.
			insert into public.qorpera_company_path_grants(resource_id, resource_version, principal_kind, principal_id,
				permissions, expires_at, revoked_at, created_at, created_by_user_id, origin)
			select new.id, new.version, 'staff_agent', grant_row.principal_id, grant_row.permissions,
				grant_row.expires_at, grant_row.revoked_at, grant_row.created_at, grant_row.created_by_user_id, 'default_agent_read'
			from public.qorpera_company_path_grants as grant_row
			where grant_row.resource_id = new.id and grant_row.resource_version = old.version
				and grant_row.origin = 'default_agent_read'
				and exists (select 1 from public.qorpera_profile_staff as staff where staff.profile_id = v_profile
					and staff.staff_agent_id = grant_row.principal_id);
		elsif tg_op = 'INSERT' and v_profile is not null then
			perform public.qorpera_ensure_default_agent_read_grants(v_profile, null);
		end if;
	end if;
	return new;
end
$$;

-- Existing agents receive the same usable default as newly created agents.
-- The helper excludes revoked resources, inactive staff and expired grants.
do $$
declare v_profile uuid;
begin
	for v_profile in
		select distinct environment.profile_id from public.qorpera_company_path_resources as resource
		join public.qorpera_company_environments as environment on environment.id = resource.environment_id
		where resource.path = '' and resource.path_match = 'subtree' and resource.scope = 'company_shared'
			and resource.revoked_at is null
	loop
		perform public.qorpera_ensure_default_agent_read_grants(v_profile, null);
	end loop;
end
$$;
