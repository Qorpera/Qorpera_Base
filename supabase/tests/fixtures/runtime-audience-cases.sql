-- Composed with SQL 290's real native admission by test-runtime-provenance.mjs.
-- The session is made private BEFORE its canonical input/run is admitted.
-- No authority helper, run provenance, or model execution record is replaced.
create function pg_temp.audience_assert(p_value boolean,p_message text)
returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end
$$;

do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_environment uuid := '29000000-0000-4000-8000-000000000020';
	v_actor jsonb; v_plan jsonb; v_result jsonb; v_head uuid; v_proposal uuid; v_digest text;
	v_prepared jsonb; v_tree text; v_applied jsonb; v_probe text; v_private jsonb; v_resource jsonb;
begin
	perform pg_temp.audience_assert(exists(select 1 from public.qorpera_execution_runs
		where id = (v_binding ->> 'runId')::uuid and audience_kind = 'member_private'
		and audience_user_id = '29000000-0000-4000-8000-000000000001'),
		'Canonical private admission did not pin the audience');
	set local role service_role;
	perform pg_temp.path_begin(v_binding);
	perform pg_temp.audience_assert(public.qorpera_describe_company_run_context(v_binding) #>> '{audience,kind}' = 'member_private',
		'Native context lost its private audience');
	perform public.qorpera_read_company_path(v_environment,'shared-note.md',v_binding);
	reset role;
	v_actor := public.qorpera_company_path_actor(v_environment,v_binding);
	begin
		update public.qorpera_company_path_grants set revoked_at = clock_timestamp()
		where id = current_setting('qorpera_test.path_grant')::uuid;
		set local role service_role;
		begin perform public.qorpera_read_company_path(v_environment,'shared-note.md',v_binding);
			raise exception 'Private audience bypassed the staff path grant';
		exception when insufficient_privilege then null; end;
		raise exception using errcode = 'QT320';
	exception when sqlstate 'QT320' then null; end;
	reset role;
	v_plan := pg_temp.path_plan('private-to-shared','shared-note.md',
		pg_temp.path_stage_file('shared-note.md','Draft originating in a private conversation'));
	select head_snapshot_id into v_head from public.qorpera_company_files where environment_id = v_environment;
	set local role service_role;
	perform pg_temp.audience_assert(public.qorpera_check_company_path_mutation(v_environment,v_binding,v_plan) ->> 'state' = 'protected',
		'Private output received direct shared-write preflight');
	v_result := pg_temp.path_commit(v_plan);
	perform pg_temp.audience_assert(pg_temp.path_commit(v_plan) = v_result,'Proposal replay changed its receipt');
	reset role;
	v_proposal := (v_result ->> 'proposalId')::uuid;
	select plan_sha256 into strict v_digest from public.qorpera_company_path_proposals where id = v_proposal;
	perform pg_temp.audience_assert(v_result ->> 'state' = 'proposed' and
		(select head_snapshot_id = v_head from public.qorpera_company_files where environment_id = v_environment)
		and not exists(select 1 from public.qorpera_company_path_entries where path = 'shared-note.md'),
		'Private conversation changed shared state without approval');
	-- Even an internal caller bypassing preflight cannot publish private output.
	v_tree := pg_temp.path_stage_tree(jsonb_build_array(v_plan -> 'entry'));
	begin
		perform public.qorpera_publish_company_path(v_actor,v_binding,v_plan,v_head,v_tree,
			(v_result ->> 'receiptId')::uuid,null);
		raise exception 'Last SQL publication boundary accepted unapproved private output';
	exception when insufficient_privilege then
		if sqlerrm <> 'Private-to-shared publication requires its audience owner approval' then raise; end if;
	end;
	-- Another owner of the COMPANY is not the audience owner of this draft.
	update public.qorpera_profile_members set role = 'contributor' where user_id = '29000000-0000-4000-8000-000000000001';
	update public.qorpera_profile_members set role = 'owner' where user_id = '29000000-0000-4000-8000-000000000002';
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	begin perform public.qorpera_get_company_path_proposal(v_proposal);
		raise exception 'Another owner read a private draft'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,'approve');
		raise exception 'Another owner approved a private draft'; exception when insufficient_privilege then null; end;
	begin perform public.qorpera_authorize_member_company_proposal_object(v_proposal,v_digest,v_plan #>> '{entry,file,fileSha256}');
		raise exception 'Another owner read staged private bytes'; exception when insufficient_privilege then null; end;
	perform pg_temp.audience_assert(public.qorpera_list_company_path_proposals(v_environment) -> 'items' = '[]'::jsonb,
		'Proposal listing leaked a private draft');
	reset role;
	-- Ordinary shared work needs ordinary write authority plus the originator's
	-- consent, not an unrelated promotion to owner/admin.
	update public.qorpera_profile_members set role = 'contributor' where user_id = '29000000-0000-4000-8000-000000000001';
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform pg_temp.audience_assert(public.qorpera_get_company_path_proposal(v_proposal) -> 'plan' = v_plan,
		'Originator could not inspect their exact draft');
	perform public.qorpera_authorize_member_company_proposal_object(v_proposal,v_digest,v_plan #>> '{entry,file,fileSha256}');
	begin perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,null);
		raise exception 'NULL approval decision was accepted'; exception when invalid_parameter_value then null; end;
	perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,'approve');
	perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,'skip');
	reset role;
	perform pg_temp.path_claims('service_role');
	set local role service_role;
	begin perform public.qorpera_prepare_company_path_approval(v_proposal,v_digest);
		raise exception 'Dismissal retained private publication consent'; exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,'approve');
	reset role;
	perform pg_temp.path_claims('service_role');
	foreach v_probe in array array['expired','grant','resource','audience'] loop
		begin
			if v_probe = 'expired' then
				update public.qorpera_company_path_proposals set approval_expires_at = clock_timestamp() - interval '1 second' where id = v_proposal;
			elsif v_probe = 'grant' then
				update public.qorpera_company_path_grants set revoked_at = clock_timestamp() where id = current_setting('qorpera_test.path_grant')::uuid;
			elsif v_probe = 'resource' then
				update public.qorpera_company_path_resources set version = extensions.gen_random_uuid() where path = '';
			else
				update public.qorpera_company_path_proposals set approved_by_user_id = '29000000-0000-4000-8000-000000000002' where id = v_proposal;
			end if;
			set local role service_role;
			begin perform public.qorpera_apply_company_path_approval(v_proposal,v_digest,v_head,v_tree);
				raise exception 'Private publication ignored %',v_probe;
			exception when insufficient_privilege then null; end;
			raise exception using errcode = 'QT320';
		exception when sqlstate 'QT320' then null; end;
	end loop;
	set local role service_role;
	v_prepared := public.qorpera_prepare_company_path_approval(v_proposal,v_digest);
	v_applied := public.qorpera_apply_company_path_approval(v_proposal,v_digest,(v_prepared ->> 'snapshotId')::uuid,v_tree);
	perform pg_temp.audience_assert(public.qorpera_apply_company_path_approval(v_proposal,v_digest,v_head,v_tree) = v_applied,
		'Approved publication replay changed its result');
	reset role;
	perform pg_temp.audience_assert(exists(select 1 from public.qorpera_company_path_revisions revision
		join public.qorpera_execution_runs run on run.id = revision.run_id
		where revision.proposal_id = v_proposal and revision.audience_kind = 'company' and revision.audience_user_id is null
			and run.audience_kind = 'member_private' and run.audience_user_id = revision.approver_user_id
			and revision.requester_user_id = run.requested_by_user_id and revision.sponsor_binding_id = run.sponsor_binding_id
			and revision.runtime_bundle_id = run.runtime_bundle_id),
		'Published effect lost its shared audience or private-source attribution');
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	perform public.qorpera_read_company_path(v_environment,'shared-note.md');
	begin perform public.qorpera_get_company_path_proposal(v_proposal);
		raise exception 'Publishing exposed the original private draft'; exception when insufficient_privilege then null; end;
	reset role;
	perform pg_temp.path_claims('service_role');
	v_plan := pg_temp.path_plan('private-protected-delete','shared-note.md',null,
		(select version from public.qorpera_company_path_entries where path = 'shared-note.md'));
	set local role service_role;
	v_result := pg_temp.path_commit(v_plan);
	reset role;
	v_proposal := (v_result ->> 'proposalId')::uuid;
	select plan_sha256 into v_digest from public.qorpera_company_path_proposals where id = v_proposal;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	begin perform public.qorpera_review_company_path_proposal(v_proposal,v_digest,'approve');
		raise exception 'Private consent bypassed protected-delete authorization'; exception when insufficient_privilege then null; end;
	reset role;
	-- Private files remain private: one grant for this agent is not a grant to
	-- its other conversations, another member, or a company-audience run.
	update public.qorpera_profile_members set role = 'admin' where user_id = '29000000-0000-4000-8000-000000000001';
	set local role authenticated;
	v_resource := public.qorpera_set_company_path_resource(v_environment,'private-note.md','exact','member_private','normal');
	perform public.qorpera_grant_company_path((v_resource ->> 'resourceId')::uuid,(v_resource ->> 'version')::uuid,
		'staff_agent','29000000-0000-4000-8000-000000000030',array['read','write']);
	reset role;
	perform pg_temp.path_claims('service_role');
	v_private := pg_temp.path_plan('own-private-note','private-note.md',pg_temp.path_stage_file('private-note.md','Private working note'));
	set local role service_role;
	perform pg_temp.audience_assert(pg_temp.path_commit(v_private) ->> 'state' = 'applied',
		'Private-audience write to own private data required shared publication');
	perform public.qorpera_read_company_path(v_environment,'private-note.md',v_binding);
	reset role;
	v_actor := public.qorpera_company_path_actor(v_environment,v_binding);
	perform pg_temp.audience_assert(not public.qorpera_company_path_allowed(v_actor || '{"audience":"company","audienceUserId":null}',
		'private-note.md','read'),'Company audience inherited a private file grant');
	perform pg_temp.audience_assert(not public.qorpera_company_path_allowed(v_actor ||
		'{"userId":"29000000-0000-4000-8000-000000000002","audienceUserId":"29000000-0000-4000-8000-000000000002"}',
		'private-note.md','read'),'Another private audience inherited the agent grant');
	perform pg_temp.audience_assert(not public.qorpera_company_path_allowed(v_actor,'shared-note.md',null),
		'NULL permission was treated as a grant');
end
$$;

-- The official human membership command must work with real active AND
-- terminal private work. It revokes authority, not historical identities.
do $$
declare v_binding jsonb := current_setting('qorpera_test.path_binding')::jsonb;
	v_run public.qorpera_execution_runs%rowtype; v_context jsonb; v_input_count integer;
begin
	select * into strict v_run from public.qorpera_execution_runs where id = (v_binding ->> 'runId')::uuid;
	select count(*) into v_input_count from public.qorpera_session_inputs where id = any(v_run.input_ids);
	begin
		perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
		set local role authenticated;
		perform public.qorpera_remove_profile_member(v_run.profile_id,'29000000-0000-4000-8000-000000000001');
		reset role;
		perform pg_temp.path_claims('service_role');
		set local role service_role;
		begin perform public.qorpera_describe_company_run_context(v_binding);
			raise exception 'Removed audience retained native work authority'; exception when insufficient_privilege then null; end;
		reset role;
		perform pg_temp.audience_assert(exists(select 1 from public.qorpera_execution_runs where id = v_run.id)
			and exists(select 1 from public.qorpera_shared_sessions where id = v_run.session_id and status = 'closed'),
			'Removal erased active history or left its private session open');
		raise exception using errcode = 'QT320';
	exception when sqlstate 'QT320' then null; end;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	perform public.qorpera_cancel_session_run(v_run.session_id,v_run.id);
	reset role;
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000002');
	set local role authenticated;
	perform public.qorpera_remove_profile_member(v_run.profile_id,'29000000-0000-4000-8000-000000000001');
	reset role;
	perform pg_temp.audience_assert(exists(select 1 from public.qorpera_execution_runs where id = v_run.id
		and audience_user_id = v_run.audience_user_id and runtime_bundle_id = v_run.runtime_bundle_id)
		and exists(select 1 from public.qorpera_runner_jobs where id = v_run.job_id and status = 'cancelled')
		and (select count(*) = v_input_count from public.qorpera_session_inputs where id = any(v_run.input_ids))
		and not exists(select 1 from public.qorpera_session_execution_bindings where session_id = v_run.session_id),
		'Removal changed history or retained an execution binding');
	perform pg_temp.path_claims('authenticated','29000000-0000-4000-8000-000000000001');
	set local role authenticated;
	begin perform public.qorpera_read_session_events(v_run.session_id);
		raise exception 'Removed member read private history'; exception when insufficient_privilege then null; end;
	reset role;
	insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
	values (v_run.profile_id,'29000000-0000-4000-8000-000000000001','path-owner@example.test','Reinvited member','admin');
	perform pg_temp.audience_assert(exists(select 1 from public.qorpera_shared_sessions where id = v_run.session_id and status = 'closed')
		and not exists(select 1 from public.qorpera_session_execution_bindings where session_id = v_run.session_id),
		'Reinvitation resumed a previously private execution');
	-- New private audience state cannot refer to a removed/non-member identity.
	begin
		insert into auth.users(id,email) values ('29000000-0000-4000-8000-000000000199','not-member@example.test');
		insert into public.qorpera_shared_sessions(client_session_id,profile_id,environment_id,title,status,
			created_by_user_id,audience_kind,audience_user_id)
		values ('29000000-0000-4000-8000-000000000198',v_run.profile_id,v_run.environment_id,'Unauthorized private audience','open',
			'29000000-0000-4000-8000-000000000199','member_private','29000000-0000-4000-8000-000000000199');
		raise exception 'Historical FK fix allowed a new non-member private audience';
	exception when insufficient_privilege then null; end;
end
$$;
set constraints all immediate;
rollback;
