-- @fixture 375_runtime_agent_hiring.test.sql until "-- Still gated or closed:"
-- Exercise actual policy approval, authenticated member review and publication.
-- Raw ACL edits simulate restriction changes without invoking default repair.
alter table public.qorpera_company_path_grants disable trigger user;

do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000008aa'; v_path text; v_doc text; v_entry jsonb;
	v_result jsonb; v_approved jsonb; v_prepared jsonb; v_tree text; v_proposal uuid; v_root uuid;
	v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb;
begin
	v_path := 'organization/agents/' || v_id || '.json'; v_doc := pg_temp.hire_document(v_id,'Restricted creator hire');
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	select id into strict v_root from public.qorpera_company_path_resources
	where environment_id = '30000000-0000-4000-8000-000000000020' and path = '';
	update public.qorpera_company_path_grants set permissions = array['read']
	where principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	v_result := pg_temp.path_commit(pg_temp.path_plan('hire-restricted',v_path,v_entry));
	v_proposal := (v_result ->> 'proposalId')::uuid;
	perform pg_temp.wake_error(format('select public.qorpera_self_approve_organization_proposal(%L,%L)',v_binding,v_proposal),
		'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	perform pg_temp.wake_assert((select status = 'open' from public.qorpera_company_path_proposals where id = v_proposal),
		'Read-only creator leaves a durable open proposal');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_profile_staff where staff_agent_id = v_id),
		'Refused policy approval creates no child');
	-- Even a still-live finite write grant cannot mint a nonexpiring child grant.
	update public.qorpera_company_path_grants set permissions = array['read','write'], expires_at = clock_timestamp() + interval '1 day'
	where principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	perform pg_temp.wake_error(format('select public.qorpera_self_approve_organization_proposal(%L,%L)',v_binding,v_proposal),
		'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	update public.qorpera_company_path_grants set expires_at = null where principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	v_approved := public.qorpera_self_approve_organization_proposal(v_binding,v_proposal);
	perform pg_temp.wake_assert((select approval_origin = 'agent_policy' from public.qorpera_company_path_proposals where id = v_proposal),
		'Policy approval is distinguished from member consent');
	v_prepared := public.qorpera_prepare_company_path_approval(v_proposal,v_approved ->> 'planSha256');
	select pg_temp.path_stage_tree(jsonb_agg(value order by value ->> 'path')) into v_tree
	from jsonb_array_elements((v_prepared -> 'entries') || jsonb_build_array(v_entry));
	-- The owner restricts the creator after staging but before publication.
	update public.qorpera_company_path_grants set permissions = array['read']
	where principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	perform pg_temp.wake_error(format('select public.qorpera_prepare_company_path_approval(%L,%L)',v_proposal,v_approved ->> 'planSha256'),
		'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	perform pg_temp.wake_error(format('select public.qorpera_apply_company_path_approval_v3(%L,%L,%L,%L,%L)',
		v_proposal,v_approved ->> 'planSha256',v_prepared ->> 'snapshotId',v_tree,v_doc),'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_profile_staff where staff_agent_id = v_id),
		'Permission change after prepare prevents child publication');
	-- A fresh authenticated member decision can replace even an expired policy
	-- approval (including conservative migration of a legacy pending hire).
	update public.qorpera_company_path_proposals set approval_expires_at = clock_timestamp() - interval '1 minute' where id = v_proposal;
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
	perform public.qorpera_review_company_path_proposal(v_proposal,v_approved ->> 'planSha256','approve');
	perform pg_temp.wake_assert((select approval_origin = 'member' from public.qorpera_company_path_proposals where id = v_proposal),
		'Authenticated review records member consent');
	perform pg_temp.path_claims('service_role');
	perform public.qorpera_self_approve_organization_proposal(v_binding,v_proposal);
	perform pg_temp.wake_assert((select approval_origin = 'member' from public.qorpera_company_path_proposals where id = v_proposal),
		'An agent retry preserves member approval despite read-only creator');
	perform pg_temp.wake_assert(pg_temp.self_apply(v_result,v_entry,v_doc) ->> 'state' = 'applied',
		'Member can authorize a hire from a restricted creator');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_path_grants
		where principal_id = v_id and resource_id = v_root and permissions = array['read','write'] and expires_at is null),
		'Member-approved child receives usable default write access');
	-- A completed policy hire in the fixture still replays after creator restriction.
	select id, jsonb_build_object('planSha256',plan_sha256) into v_proposal,v_approved
	from public.qorpera_company_path_proposals where plan ->> 'path' = 'organization/agents/30000000-0000-4000-8000-0000000004aa.json';
	perform pg_temp.wake_assert(public.qorpera_self_approve_organization_proposal(v_binding,v_proposal) ->> 'state' = 'applied',
		'Completed policy approval replay does not create new authority');
	perform public.qorpera_company_path_approved_actor(v_proposal,v_approved ->> 'planSha256');
end $$;

-- Defaults cover every company environment, including roots outside this run.
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('30000000-0000-4000-8000-000000000820','30000000-0000-4000-8000-000000000010','Second environment',1,
	'30000000-0000-4000-8000-000000000001');
insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,policy,created_by_user_id)
values ('30000000-0000-4000-8000-000000000820','','subtree','company_shared','normal','30000000-0000-4000-8000-000000000001');
do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000008bb'; v_path text; v_doc text; v_entry jsonb; v_result jsonb;
	v_binding jsonb := current_setting('qorpera_test.wake_binding')::jsonb; v_root uuid; v_version uuid;
begin
	update public.qorpera_company_path_grants set permissions = array['read','write']
	where principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	select id,version into strict v_root,v_version from public.qorpera_company_path_resources
	where environment_id = '30000000-0000-4000-8000-000000000820' and path = '';
	update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
	where resource_id = v_root and principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	v_path := 'organization/agents/' || v_id || '.json'; v_doc := pg_temp.hire_document(v_id,'Other environment hire');
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	v_result := pg_temp.path_commit(pg_temp.path_plan('hire-other-env',v_path,v_entry));
	perform pg_temp.wake_error(format('select public.qorpera_self_approve_organization_proposal(%L,%L)',v_binding,v_result ->> 'proposalId'),
		'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	-- A grant for a historical resource version cannot satisfy the bound either.
	update public.qorpera_company_path_grants set revoked_at = null, resource_version = extensions.gen_random_uuid()
	where resource_id = v_root and principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	perform pg_temp.wake_error(format('select public.qorpera_self_approve_organization_proposal(%L,%L)',v_binding,v_result ->> 'proposalId'),
		'42501','Hiring requires member approval: creator cannot delegate default Company File access');
	update public.qorpera_company_path_grants set resource_version = v_version
	where resource_id = v_root and principal_id = '30000000-0000-4000-8000-000000000030'::uuid;
	perform pg_temp.wake_assert(pg_temp.self_apply(v_result,v_entry,v_doc) ->> 'state' = 'applied',
		'Full current nonexpiring authority across all roots permits automatic hiring');
end $$;
alter table public.qorpera_company_path_grants enable trigger user;
rollback;
