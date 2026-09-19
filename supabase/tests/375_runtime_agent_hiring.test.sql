-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- An agent with only the default read grant proposes a coworker; nothing
-- exists until a member approves; an ordinary agent cannot touch an existing
-- agent document; ordinary protected paths stay closed to a read-only agent.
select pg_temp.path_claims('service_role');
select pg_temp.wake_public_send(current_setting('qorpera_test.wake_binding')::jsonb,'progress','hire-ack');
alter table public.qorpera_company_path_grants disable trigger user;
update public.qorpera_company_path_grants set permissions = array['read']
where principal_kind = 'staff_agent' and principal_id = '30000000-0000-4000-8000-000000000030';
alter table public.qorpera_company_path_grants enable trigger user;

create function pg_temp.hire_document(p_id uuid,p_name text) returns text language sql as $$
	select jsonb_build_object('schema','qorpera.company-agent/v1','agentId',p_id,'revision',1,'displayName',p_name,'role','Sales development',
		'hireOverlay',jsonb_build_object('charter','Own outbound design-partner conversations.','templateId',null),
		'appearance',jsonb_build_object('color','native','shape','round','creature','flame'),
		'modelPolicy',jsonb_build_object('provider',null,'modelId',null),'reasoningPolicy',jsonb_build_object('effort','low'),
		'grants',jsonb_build_object('responsibilities','[]'::jsonb,'projects','[]'::jsonb,'rooms','[]'::jsonb,'resources','[]'::jsonb),
		'startupInstructions','Introduce yourself and list the first ten salons to contact.','employmentStatus','active',
		'lifecycleState','setup','createdAt','2026-09-19T20:00:00Z')::text
$$;

do $$
declare v_id uuid := '30000000-0000-4000-8000-0000000004aa'; v_path text; v_result jsonb;
begin
	v_path := 'organization/agents/' || v_id || '.json';
	v_result := pg_temp.path_commit(pg_temp.path_plan('hire-mikkel',v_path,pg_temp.path_stage_file(v_path,pg_temp.hire_document(v_id,'Mikkel'))));
	perform pg_temp.wake_assert(v_result ->> 'state' = 'proposed' and v_result ->> 'proposalId' is not null,
		'A read-only agent can propose a new coworker');
	perform pg_temp.wake_assert(not exists (select 1 from public.qorpera_profile_staff where staff_agent_id = v_id)
		and not exists (select 1 from public.qorpera_company_path_entries where path = v_path),
		'A proposed hire creates no agent and no file before a member approves');
	perform pg_temp.wake_assert((select proposal.status = 'open' and run.staff_agent_id = '30000000-0000-4000-8000-000000000030'
		from public.qorpera_company_path_proposals proposal join public.qorpera_execution_runs run on run.id = proposal.run_id
		where proposal.id = (v_result ->> 'proposalId')::uuid),
		'The open proposal is bound to the proposing agent''s run');
end $$;

-- Ordinary files stay closed to a read-only agent, protected or not.
select pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('note-1','notes/plan.md',pg_temp.path_stage_file('notes/plan.md','Plan')))$q$,
	'42501','Company File path is unavailable');
select pg_temp.wake_error($q$select pg_temp.path_commit(pg_temp.path_plan('org-1','organization/agents/readme.md',pg_temp.path_stage_file('organization/agents/readme.md','x')))$q$,
	'42501','Company File path is unavailable');

rollback;
