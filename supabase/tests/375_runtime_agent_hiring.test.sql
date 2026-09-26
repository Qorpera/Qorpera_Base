-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- An agent holding the default read/write grant hires a coworker and opens a
-- group chat with no member step: the run approves its own NEW agent or room
-- by policy and the ordinary approval lane applies and projects it.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','hire-ack');

create function pg_temp.hire_document(p_id uuid,p_name text) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.company-agent/v1','agentId',p_id,'revision',1,'displayName',p_name,'role','Sales development',
		'hireOverlay',jsonb_build_object('charter','Own outbound design-partner conversations.','templateId',null),
		'appearance',jsonb_build_object('color','native','shape','round','creature','flame'),
		'modelPolicy',jsonb_build_object('provider',null,'modelId',null),'reasoningPolicy',jsonb_build_object('effort','low'),
		'grants',jsonb_build_object('responsibilities','[]'::jsonb,'projects','[]'::jsonb,'rooms','[]'::jsonb,'resources','[]'::jsonb),
		'startupInstructions','Introduce yourself and list the first ten salons to contact.','employmentStatus','active',
		'lifecycleState','setup','createdAt','2026-09-19T20:00:00Z')::text
$$;
-- What the runtime does after a proposed result: approve by policy, stage the tree, apply with the document text.
create function pg_temp.self_apply(p_result jsonb,p_entry jsonb,p_document text) returns jsonb language plpgsql as $$
declare v_approved jsonb; v_prepared jsonb; v_entries jsonb;
begin
	v_approved := public.qorpera_self_approve_organization_proposal(current_setting('qorpera_test.wake_binding')::jsonb,(p_result ->> 'proposalId')::uuid);
	v_prepared := public.qorpera_prepare_company_path_approval((p_result ->> 'proposalId')::uuid,v_approved ->> 'planSha256');
	select coalesce(jsonb_agg(value order by value ->> 'path'),'[]') into v_entries from (
		select value from jsonb_array_elements(v_prepared -> 'entries') where value ->> 'path' <> p_entry ->> 'path' union all select p_entry) entries;
	return public.qorpera_apply_company_path_approval_v3((p_result ->> 'proposalId')::uuid,v_approved ->> 'planSha256',
		(v_prepared ->> 'snapshotId')::uuid,pg_temp.path_stage_tree(v_entries),p_document);
end $$;

do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000004aa'; v_path text; v_result jsonb; v_entry jsonb; v_doc text; v_applied jsonb;
begin
	-- The folders an agent document needs may not exist yet.
	perform pg_temp.path_commit(pg_temp.path_plan('org-dir','organization','{"path":"organization","kind":"directory"}'));
	perform pg_temp.path_commit(pg_temp.path_plan('agents-dir','organization/agents','{"path":"organization/agents","kind":"directory"}'));
	v_path := 'organization/agents/' || v_id || '.json'; v_doc := pg_temp.hire_document(v_id,'Mikkel');
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	v_result := pg_temp.path_commit(pg_temp.path_plan('hire-mikkel',v_path,v_entry));
	perform pg_temp.wake_assert(v_result ->> 'state' = 'proposed','The governed write of a new agent document is a proposal');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_profile_staff where staff_agent_id = v_id),'Nothing exists before it is applied');
	v_applied := pg_temp.self_apply(v_result,v_entry,v_doc);
	perform pg_temp.wake_assert(v_applied ->> 'state' = 'applied','The run approves and applies its own new hire');
	perform pg_temp.wake_assert((select employment_status = 'active' and display_name = 'Mikkel'
		from public.qorpera_profile_staff where staff_agent_id = v_id),'The coworker exists with no member step');
	perform pg_temp.wake_assert((select count(*) from public.qorpera_agent_first_runs where staff_agent_id = v_id) = 1,
		'Exactly one first run is seeded');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_path_grants
		where principal_kind = 'staff_agent' and principal_id = v_id and permissions = array['read','write']),'The new agent can read and write ordinary company files');
	perform pg_temp.wake_assert((select approved_by_user_id = '30000000-0000-4000-8000-000000000001' and status = 'applied'
		from public.qorpera_company_path_proposals where id = (v_result ->> 'proposalId')::uuid),
		'The approval is recorded in the name of the requesting owner');
end $$;

-- Still gated or closed: an existing agent document, another run's proposal, ordinary paths.
alter table public.qorpera_company_path_grants disable trigger user;
update public.qorpera_company_path_grants set permissions = array['read']
where principal_kind = 'staff_agent' and principal_id = '30000000-0000-4000-8000-000000000030';
alter table public.qorpera_company_path_grants enable trigger user;
do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000004aa'; v_path text; v_version uuid;
begin
	v_path := 'organization/agents/' || v_id || '.json';
	select version into v_version from public.qorpera_company_path_entries where path = v_path;
	perform pg_temp.wake_error(format($q$select pg_temp.path_commit(pg_temp.path_plan('retire-mikkel',%L,
		pg_temp.path_stage_file(%L,replace(pg_temp.hire_document(%L,'Mikkel'),'"revision": 1','"revision": 2')),%L))$q$,
		v_path,v_path,v_id,v_version),'42501','Company File path is unavailable');
end $$;
select pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('note-1','notes/plan.md',pg_temp.path_stage_file('notes/plan.md','Plan')))$q$,
	'42501','Company File path is unavailable');
select pg_temp.wake_error($q$select public.qorpera_self_approve_organization_proposal(current_setting('qorpera_test.wake_binding')::jsonb,extensions.gen_random_uuid())$q$,'42501');

-- A run hires without a count (runtime v92; was three per run): four more hires all apply.
alter table public.qorpera_company_path_grants disable trigger user;
update public.qorpera_company_path_grants set permissions = array['read','write']
where principal_kind = 'staff_agent' and principal_id = '30000000-0000-4000-8000-000000000030';
alter table public.qorpera_company_path_grants enable trigger user;
do $$
declare v_index int; v_id uuid; v_path text; v_doc text; v_entry jsonb; v_result jsonb;
begin
	for v_index in 1..4 loop
		v_id := ('30000000-0000-4000-8000-0000000005a' || v_index)::uuid; v_path := 'organization/agents/' || v_id || '.json';
		v_doc := pg_temp.hire_document(v_id,'Hire ' || v_index); v_entry := pg_temp.path_stage_file(v_path,v_doc);
		v_result := pg_temp.path_commit(pg_temp.path_plan('hire-' || v_index,v_path,v_entry));
		perform pg_temp.self_apply(v_result,v_entry,v_doc);
	end loop;
	if (select count(*) from public.qorpera_company_path_proposals
		where run_id = (current_setting('qorpera_test.wake_binding')::jsonb ->> 'runId')::uuid and status = 'applied'
			and public.qorpera_agent_creatable_path_kind(plan ->> 'path') = 'agent') < 5 then
		raise exception 'A run could not hire more than three coworkers'; end if;
end $$;

-- A group chat with coworkers and the requesting member.
do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000006aa'; v_path text; v_doc text; v_entry jsonb; v_result jsonb;
begin
	perform pg_temp.path_commit(pg_temp.path_plan('rooms-dir','organization/rooms','{"path":"organization/rooms","kind":"directory"}'));
	v_path := 'organization/rooms/' || v_id || '.json';
	v_doc := jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_id,'key','chat-' || v_id,'name','Onboarding sync',
		'purpose','Coordinate salon onboarding.','status','active','projectId',null,'members',jsonb_build_array(
			jsonb_build_object('kind','member','id','30000000-0000-4000-8000-000000000001'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000030'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')),'version',1)::text;
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	v_result := pg_temp.path_commit(pg_temp.path_plan('room-onboarding',v_path,v_entry));
	perform pg_temp.wake_assert(v_result ->> 'state' = 'proposed','A new room document is a proposal');
	perform pg_temp.wake_assert(pg_temp.self_apply(v_result,v_entry,v_doc) ->> 'state' = 'applied','The run opens its own group chat');
	perform pg_temp.wake_assert(exists (select 1 from public.qorpera_company_rooms where id = v_id and status = 'active'),'The room exists');
end $$;

-- A retry after the approval lapsed: the same run renews its own policy approval and finishes;
-- asking again after it was applied is a plain replay.
do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000006bb'; v_path text; v_doc text; v_entry jsonb; v_result jsonb; v_again jsonb;
begin
	v_path := 'organization/rooms/' || v_id || '.json';
	v_doc := jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_id,'key','chat-' || v_id,'name','Retry room',
		'purpose','Retry after a lapsed approval.','status','active','projectId',null,'members',jsonb_build_array(
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000030'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')),'version',1)::text;
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	v_result := pg_temp.path_commit(pg_temp.path_plan('room-retry',v_path,v_entry));
	perform public.qorpera_self_approve_organization_proposal(current_setting('qorpera_test.wake_binding')::jsonb,(v_result ->> 'proposalId')::uuid);
	update public.qorpera_company_path_proposals set approval_expires_at = clock_timestamp() - interval '1 minute'
	where id = (v_result ->> 'proposalId')::uuid;
	perform pg_temp.wake_assert(pg_temp.self_apply(v_result,v_entry,v_doc) ->> 'state' = 'applied','A lapsed policy approval is renewed by the same run');
	v_again := public.qorpera_self_approve_organization_proposal(current_setting('qorpera_test.wake_binding')::jsonb,(v_result ->> 'proposalId')::uuid);
	perform pg_temp.wake_assert(v_again ->> 'state' = 'applied','Asking again after it was applied is a replay');
end $$;

-- The requester is only a contributor: the approval is recorded in the company owner's name.
do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000007aa'; v_path text; v_doc text; v_entry jsonb; v_result jsonb;
begin
	-- Retain a founder and explicitly transfer usage responsibility first.
	update public.qorpera_profile_members set role = 'owner' where user_id = '30000000-0000-4000-8000-000000000002';
	perform pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000002');
	perform public.qorpera_accept_computer_usage_ownership('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001');
	perform pg_temp.path_claims('service_role');
	update public.qorpera_profile_members set role = 'contributor' where user_id = '30000000-0000-4000-8000-000000000001';
	v_path := 'organization/rooms/' || v_id || '.json';
	v_doc := jsonb_build_object('schema','qorpera.company-room/v1','roomId',v_id,'key','chat-' || v_id,'name','Contributor room',
		'purpose','Opened for a contributor.','status','active','projectId',null,'members',jsonb_build_array(
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000030'),
			jsonb_build_object('kind','staff_agent','id','30000000-0000-4000-8000-000000000031')),'version',1)::text;
	v_entry := pg_temp.path_stage_file(v_path,v_doc);
	v_result := pg_temp.path_commit(pg_temp.path_plan('room-contributor',v_path,v_entry));
	perform pg_temp.wake_assert(pg_temp.self_apply(v_result,v_entry,v_doc) ->> 'state' = 'applied','A contributor''s agent still creates without a member step');
	perform pg_temp.wake_assert((select approved_by_user_id = '30000000-0000-4000-8000-000000000002'
		from public.qorpera_company_path_proposals where id = (v_result ->> 'proposalId')::uuid),
		'The approval is recorded in the company owner''s name');
end $$;

rollback;
