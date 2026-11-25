-- Generated source-only activation; run the rollout gates before applying.
-- After this migration is shipped, use a NEW activation migration for a new bundle.
-- Historical v282 runs/inputs are not silently relabelled as v283.
-- This manifest's runtime needs 20260930539000, 20260930540000, 20260930545000, 20260930546000 and 20260930547000 (live with v191), 20260930550000 (company sites: publish_site and unpublish_site call its functions through the native host; live with v193), 20260930551000 (a coding session's failed turn names why its login cannot pay; its owner moves it to another login), 20260930554000 (the account logins list says enabled only where sign-ins go to the vault), 20260930556000 (github create_repository, which this runtime's connector catalog names), 20260930559000 (a first login choice ranks logins by comparable room; all four live with v194), 20260930560000 (a failed coding turn reads as its own, in plain words), 20260930562000 (private app links: share_app calls its functions through the native host; both live with v195), 20260930563000 (a claim release waits while another provider holds the attempt's machine reservation, instead of counting a dispatch failure; its marker in qorpera_release_runner_job_claim's body; live with v197), 20260930564000 (Claude sign-in in the shared vault, coding only; its table qorpera_claude_logins; live with v198), 20260930565000 (listener routines: a dynamic routine's run may wait for a todo or human task with after, which this runtime's routine tools write; qorpera_routine_listener_state; live with v198), 20260930566000 (good will: a company's monthly share of customer sales; the finance agent's good_will_list/good_will_mark call qorpera_good_will_agent_list and qorpera_good_will_agent_mark; live with v199), 20260930567000 (those two tools join the observed tool operations; its marker in qorpera_record_runtime_observation's body; live with v199), 20260930568000 (a worker's approval card waits in its agent's thread; qorpera_list_member_waiting_approvals; live with v200), 20260930569000 (a coworker message to an agent hired a moment ago waits while it starts; its marker in qorpera_folder_send_coworker_message's body; live with v200), 20260930570000 (routine follow-ups: an open todo brings its agent's dynamic routine run forward; qorpera_routine_follow_up; live with v200), 20260930571000 (good will follow-ups: a card Stripe could not charge is told; qorpera_good_will_card_notice; live with v200), 20260930572000 (save_app and post_app join the observed tool operations; its marker in qorpera_record_runtime_observation's body; live with v200), 20260930573000 (update_wall joins the observed tool operations; its marker in qorpera_record_runtime_observation's body; live with v201), 20260930575000 (work at a usage limit waits on its own login and goes on by itself; the vault's daily usage check qorpera_begin_model_login_usage_recheck, its marker in that body; live with v202), 20260930577000 (a usage-limit wall with no reset holds to the reset its login's reading names; its marker in qorpera_native_account_usage_limit_reset_company's body; live with v203) and 20260930578000 (a question card's option may carry a picture, its preview, which the kernel's validator lets in; its marker in qorpera_interaction_request_valid's body; live with v204); refuse to activate without them on a database past 20260930534000 (a fresh chain in file order reaches them only after this file). v210 carries no migration of its own. 20260930606000, 20260930611000, 20260930615000, 20260930616000 and 20260930617000 (the perf sprint's, recorded on production by hand on 7 Nov) are no need of this runtime, so they are not named here.
do $$ begin if to_regprocedure('public.qorpera_os_relative(text)') is not null and (to_regprocedure('public.qorpera_memory_run_resume_receipts(jsonb)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_folder_assert_run_reads(uuid,jsonb,text[])') and 'lock_timeout=3s' = any(proconfig)) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)') and 'lock_timeout=3s' = any(proconfig)) or not exists (select 1 from pg_proc where oid in (to_regprocedure('public.qorpera_folder_send_agent_message(jsonb,text,text,text)'), to_regprocedure('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)'), to_regprocedure('public.qorpera_folder_add_agent_review_rule(jsonb,jsonb)')) and strpos(prosrc, '20260930545000') > 0) or not exists (select 1 from pg_proc where oid in (to_regprocedure('public.qorpera_begin_action_review(jsonb,jsonb)'), to_regprocedure('public.qorpera_record_action_review(jsonb,jsonb)'), to_regprocedure('public.qorpera_send_agent_mail(jsonb,text,jsonb)')) and strpos(prosrc, '20260930546000') > 0) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_run_resumes_from_receipts(uuid)') and strpos(prosrc, '20260930547000') > 0) or to_regprocedure('public.qorpera_site_publish_begin(jsonb,text,jsonb,uuid)') is null or to_regprocedure('public.qorpera_choose_coding_session_login(uuid,uuid)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_list_account_model_logins(uuid)') and strpos(prosrc, '20260930554000') > 0) or not exists (select 1 from public.qorpera_cloud_connector_operations where connector_id = 'github' and operation_id = 'create_repository' and version = 1 and status = 'active') or to_regprocedure('public.qorpera_native_account_rank(uuid,bigint)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)') and strpos(prosrc, '20260930560000') > 0) or to_regprocedure('public.qorpera_site_share_check(jsonb,text,text,integer)') is null or to_regprocedure('public.qorpera_site_share_app(jsonb,text,jsonb,uuid)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)') and strpos(prosrc, '20260930563000') > 0) or to_regclass('public.qorpera_claude_logins') is null or to_regprocedure('public.qorpera_routine_listener_state(uuid,text)') is null or to_regprocedure('public.qorpera_good_will_agent_list(jsonb,text)') is null or to_regprocedure('public.qorpera_good_will_agent_mark(jsonb,jsonb)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') and strpos(prosrc, '20260930567000') > 0) or to_regprocedure('public.qorpera_list_member_waiting_approvals(uuid)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_folder_send_coworker_message(jsonb,uuid,text,text,boolean)') and strpos(prosrc, '20260930569000') > 0) or to_regprocedure('public.qorpera_routine_follow_up(public.qorpera_cloud_routines,jsonb)') is null or to_regprocedure('public.qorpera_good_will_card_notice(public.qorpera_good_will_months)') is null or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') and strpos(prosrc, '20260930572000') > 0) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)') and strpos(prosrc, '20260930573000') > 0) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_begin_model_login_usage_recheck(uuid,text,text)') and strpos(prosrc, '20260930575000') > 0) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_native_account_usage_limit_reset_company(uuid)') and strpos(prosrc, '20260930577000') > 0) or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_interaction_request_valid(jsonb)') and strpos(prosrc, '20260930578000') > 0)) then
	raise exception 'Activation requires migrations 20260930539000_memory_run_resume_receipts, 20260930540000_runtime_run_row_read_lock_bound, 20260930545000_memory_run_resume_send_fence, 20260930546000_resume_review_mail_fences, 20260930547000_memory_run_resume_not_after_final, 20260930550000_company_sites, 20260930551000_coding_session_login, 20260930554000_account_login_list_sign_in_url, 20260930556000_github_create_repository, 20260930559000_login_choice_comparable_room, 20260930560000_coding_turn_failure_plain_words, 20260930562000_company_app_sites, 20260930563000_runtime_attempt_reserved_elsewhere_waits, 20260930564000_claude_account_sign_in, 20260930565000_routine_listeners, 20260930566000_good_will, 20260930567000_good_will_tools, 20260930568000_worker_approval_cards_in_agent_thread, 20260930569000_coworker_send_new_hire_waits, 20260930570000_routine_follow_ups, 20260930571000_good_will_follow_ups, 20260930572000_interface_app_tools, 20260930573000_agent_wall_tool, 20260930575000_usage_limit_waits_and_resumes, 20260930577000_usage_wall_holds_to_reading_reset and 20260930578000_question_option_previews'; end if; end $$;
-- The model policy in this manifest needs the thread-effort kernel (20260924120000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_set_session_model(uuid,text,bigint,text)') is null then
	raise exception 'Activation requires migration 20260924120000_thread_model_effort'; end if; end $$;
-- The coding executor in this manifest plans one machine per member, agent, repository and setup (20260930394000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text,text)') is null then
	raise exception 'Activation requires migration 20260928549390_coding_machine_identity'; end if; end $$;
-- The Codex build in this manifest sends any number of tool outputs per model request (20260924230000); refuse to activate without it.
do $$ declare v_definition text := coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)')),'');
begin if v_definition not like '%pg_column_size(p_view) > 16777216%'
	or v_definition like '%jsonb_array_length(p_view -> ''outputs'') > 128%'
	or coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.qorpera_native_context_views'::regclass
		and conname = 'qorpera_native_context_views_view_check'),'') not like '%16777216%' then
	raise exception 'Activation requires migration 20260924230000_runtime_native_view_no_output_count'; end if; end $$;
-- The runtime in this manifest counts open work (20260925112000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_describe_agent_open_work(jsonb)') is null then
	raise exception 'Activation requires migration 20260925112000_runtime_todo_worker_pages'; end if; end $$;
-- The coding runtime in this manifest reads each turn's own history (20260925113000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_read_coding_turn_context(jsonb)') is null then
	raise exception 'Activation requires migration 20260925113000_runtime_coding_turn_continuity'; end if; end $$;
-- Email draft cards require the member action kernel and the Gmail draft catalog.
do $$ begin if to_regprocedure('public.qorpera_get_email_draft(uuid,uuid)') is null
	or not exists (select 1 from public.qorpera_cloud_connector_operations where connector_id = 'gmail' and operation_id = 'create_draft' and status = 'active') then
	raise exception 'Activation requires Gmail draft catalog and member email draft migrations'; end if; end $$;
-- Fleet command routing and office selection must be installed before this bundle.
do $$ begin if to_regprocedure('public.qorpera_route_coding_command(jsonb,jsonb,text,uuid,text)') is null
	or to_regprocedure('public.qorpera_place_runtime_office_fleet(jsonb,bigint)') is null then
	raise exception 'Activation requires coding and office fleet migrations'; end if; end $$;
-- The auto-review step in this manifest reads rules and records verdicts through the rules kernel (20260926130000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_begin_action_review(jsonb,jsonb)') is null
	or to_regprocedure('public.qorpera_await_action_review(jsonb,uuid,boolean,boolean)') is null
	or to_regprocedure('public.qorpera_add_agent_review_rule(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260926130000_runtime_auto_review_rules'; end if; end $$;
-- The kernel in this manifest locks a coding session's rows in one order (20260925117000): every patched function must carry it; refuse to activate without it.
do $$ declare v_missing text; begin
	select string_agg(expected.target, ', ') into v_missing from (values
		('public.qorpera_coding_session_owner_row(uuid)', 'and species = ''coding'';'),
		('public.qorpera_answer_coding_session(uuid,text,uuid)', 'v_worker := public.qorpera_lock_coding_worker(v_worker.id);'),
		('public.qorpera_complete_coding_turn(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,text,integer,jsonb)', 'v_worker := public.qorpera_lock_coding_worker(p_worker_id);'),
		('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)', 'v_worker := public.qorpera_lock_coding_worker(p_worker_id);'),
		('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)', 'where id = p_worker_id for update;'),
		('public.qorpera_authorize_coding_machine_custody(uuid,text,text,text,text,uuid,uuid)', 'where worker_id = p_worker_id for update; end if;')) expected(target, marker)
	where position(expected.marker in coalesce(pg_get_functiondef(to_regprocedure(expected.target)), '')) = 0;
	if v_missing is not null then
		raise exception 'Activation requires migration 20260925117000_runtime_coding_lock_order (%)', v_missing; end if; end $$;
-- A member's save keeps the routine's schedule position (20260926132000); refuse to activate without it.
do $$ begin if position('and public.qorpera_routine_occurrence_count(new.routine_id) >= v_routine.max_occurrences then' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_routine_occurrence_lifecycle()')),'')) = 0 then
	raise exception 'Activation requires migration 20260926132000_runtime_member_routine_cursor'; end if; end $$;
-- The coding runtime in this manifest reads fitted turn context (20260926162500); refuse to activate without it.
do $$ begin if position('(count(*) filter (where not (sized.running <= 49152 or sized.sequence = v_sequence - 1)))::integer' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_read_coding_turn_context(jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260926162500_runtime_coding_turn_review_fixes'; end if; end $$;
-- A member's Stop reaches room and wake runs in the conversation (20260926183100); refuse to activate without it.
do $$ begin if position('run.source_kind in (''session_turn'',''room_delivery'',''wake'')' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_cancel_session_run_profile_scope(uuid,uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260926183100_member_stop_thread_wake_runs'; end if; end $$;
-- A run a member stopped is no failure in the activity list (20260926192436); refuse to activate without it.
do $$ begin if position('when job.cancelled_by_user_id is not null then 0' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260926192436_member_stop_settled_activity'; end if; end $$;
-- The runtime in this manifest reports a missing parent folder as parent_missing (20260926203300); refuse to activate without it.
do $$ begin if position('''parent_missing''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260926203300_company_file_missing_parent'; end if; end $$;
-- Approval cards carry the call as an object (20260926210000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_action_review_call(text)') is null then
	raise exception 'Activation requires migration 20260926210000_runtime_auto_review_fixes'; end if; end $$;
-- Every coding machine call takes the company fence first (20260925123000): the company folder's since the legacy sweep's F2c (20260930292000), which dropped the gc fence; refuse to activate without each patch.
do $$ begin if position('qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)')),'')) = 0
	or position('qorpera_folder_machine_fence(worker.profile_id) from public.qorpera_runtime_workers worker where worker.id = p_worker_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_plan_coding_machine(uuid,uuid,text,text)')),'')) = 0
	or position('qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_suspend_coding_machine(uuid,text,text,text)')),'')) = 0
	or position('qorpera_folder_machine_fence(machine.profile_id) from public.qorpera_coding_machines machine where machine.id = p_machine_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_release_coding_machine(uuid,text,text,text)')),'')) = 0
	or position('where authority.id = p_broker_authority_id) for key share;' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260925123000_runtime_coding_machine_lock_order'; end if; end $$;
-- The orchestrator shipped with this cut raises a routine's first slot (20260927020000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_advance_routine_next_due(uuid,bigint,text,timestamptz,timestamptz)') is null
	or position('and (cursor.last_scheduled_for is null' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_routine_next_run_at(uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260927020000_runtime_routine_first_slot'; end if; end $$;
-- NAS replica copies take the company fence first in the storage quota trigger, and the legacy run enqueue
-- does not (20260927150000); refuse otherwise.
do $$ declare v_wrong text; begin
	select string_agg(target, ', ') into v_wrong from (values
		('public.qorpera_enforce_company_storage_quota()', true),
		('public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)', false)) expected(target, fenced)
	where (position('qorpera_lock_profile_gc_fence' in coalesce(pg_get_functiondef(to_regprocedure(target)), '')) > 0) <> fenced
		or (target = 'public.qorpera_enforce_company_storage_quota()'
			and position('if new.user_metadata -> ''qorpera_nas_replica'' = ''true''::jsonb and auth.role() = ''service_role'' then' in pg_get_functiondef(to_regprocedure(target))) = 0);
	if v_wrong is not null then
		raise exception 'Activation requires migration 20260927150000_company_file_writer_fence (%)', v_wrong; end if; end $$;
-- A closed computer panel takes its wake back (20260927110000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)') is null
	or position('qorpera_runtime_office_wake_withdrawn(c)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_reconcile_runtime_office_idle(jsonb,bigint,uuid,text,integer)')),'')) = 0 then
	raise exception 'Activation requires migration 20260927110000_runtime_office_wake_withdrawal'; end if; end $$;
-- The model policy in this manifest declares thread fast mode (20260927161500); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_set_session_service_tier(uuid,text,bigint)') is null then
	raise exception 'Activation requires migration 20260927161500_thread_fast_mode'; end if; end $$;
-- The node observer and login gateway in this release attach and report a shared execution host's identity devices (20260927190000); refuse to activate without it.
do $$ begin if coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_runtime_node_inventory_context(uuid)')),'') not like '%acceptedIdentities%'
	or coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'') not like '%Node inventory reports identity devices its policy does not declare%'
	or coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_enroll_runtime_node_inventory(jsonb)')),'') not like '%identityVolumes%' then
	raise exception 'Activation requires migration 20260927190000_runtime_exec_host_identity_devices'; end if; end $$;
-- The runtime in this manifest observes read_skill, search_skills and update_skill (20260928032000); refuse to activate without it.
do $$ begin if position('''read_skill'',''search_skills'',''update_skill''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_record_runtime_observation(uuid,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928032000_runtime_agent_skills'; end if; end $$;
-- The node observer in this release reads a declared build space (20260928180500); refuse to activate without it.
do $$ begin if position('BUILD_SPACE_EXCEEDED' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928180500_runtime_node_build_space'; end if; end $$;
-- Orchestrators of a switched-off node claim nothing new (20260928180700); refuse to activate without it.
do $$ begin if position('qorpera_runtime_orchestrator_nodes(v_adapter)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928180700_runtime_node_serving_switch'; end if; end $$;
-- A run is claimed only by an orchestrator that declared its bundle (20260928182000); refuse to activate without it.
do $$ begin if position('declared.runtime_bundle_sha256' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928182000_runtime_orchestrator_runtime_bundle'; end if; end $$;
-- Runs follow the placement: fast hosts claim first, overflow after (20260928183000); refuse to activate without it.
do $$ begin if position('qorpera_runtime_claim_turn(p_orchestrator_id, job, run)' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_claim_runner_job_for_orchestrator(uuid,uuid,integer)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928183000_runtime_runs_follow_placement'; end if; end $$;
-- The node observer lists the fast host by its role and pins its image to a node release (20260928186000); refuse to activate without it.
do $$ begin if position('''INSTANCE_IMAGE_NOT_RELEASED''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928186000_runtime_node_exec_host_role'; end if; end $$;
-- Coding sessions keep their attachments between turns (20260928187000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)') is null then
	raise exception 'Activation requires migration 20260928187000_runtime_coding_session_standby'; end if; end $$;
-- A run's payer must serve its requester (the member who started the work pays) (20260928230000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_sponsor_serves_requester(uuid,uuid,bigint,uuid)') is null then
	raise exception 'Activation requires migration 20260928230000_runtime_member_who_started_pays'; end if; end $$;
-- Wakes pin the starter's own sponsor (20260928230000); refuse to activate without it.
do $$ begin if position('qorpera_starter_sponsor(new.profile_id, new.requested_by_user_id' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_pin_wake_occurrence()')),'')) = 0 then
	raise exception 'Activation requires migration 20260928230000_runtime_member_who_started_pays'; end if; end $$;
-- Runs refuse a payer that does not serve the requester (20260928230000); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_trigger where tgname = 'qorpera_execution_run_payer_serves_requester' and tgrelid = 'public.qorpera_execution_runs'::regclass) then
	raise exception 'Activation requires migration 20260928230000_runtime_member_who_started_pays'; end if; end $$;
-- A member's pinned logins follow their live login (20260928231000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_move_member_login_pins(uuid,uuid,uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928231000_runtime_member_login_pins_follow'; end if; end $$;
-- A pending runner without a machine can be rebound to another provider (20260928235000); refuse to activate without it.
do $$ begin if position('A pending runner no machine was ever reserved for' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_provision_execution_runner(uuid,uuid,text,text)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928235000_runtime_runner_rebind_pending'; end if; end $$;
-- The vault renews idle logins (20260928236000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_take_idle_model_login_renewal(uuid,text)') is null then
	raise exception 'Activation requires migration 20260928236000_runtime_model_login_upkeep'; end if; end $$;
-- The folder feed answers machines polling for changes (20260928237000); refuse to activate without it.
do $$ begin if position('''schema'',''qorpera.folder-feed/v1''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_folder_feed(uuid,jsonb,bigint,integer,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928237000_folder_core_feed'; end if; end $$;
-- Several company machines per company, computers as seats; scale-out ships switched off (20260928237200); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_runtime_office_scale_out') is null then
	raise exception 'Activation requires migration 20260928237200_runtime_company_computer_seats'; end if; end $$;
-- Node inventory takes allocation rows in one order, key share first (20260928242000); refuse to activate without it.
do $$ begin if position('for key share' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_observe_runtime_node_inventory(jsonb,text,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928242000_runtime_inventory_allocation_lock_order'; end if; end $$;
-- The vault switches a replaced node login off by itself (20260928243500); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_switch_off_replaced_node_logins(uuid,text)') is null then
	raise exception 'Activation requires migration 20260928243500_runtime_model_login_switch_off'; end if; end $$;
-- An agent never waits for a full company machine; its start picks the machine at call time (20260928244200); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_runtime_office_start_decision(public.qorpera_runtime_offices)') is null then
	raise exception 'Activation requires migration 20260928244200_runtime_company_computer_no_wait'; end if; end $$;
-- Computer hours are metered per company (20260928248000); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_computer_hour_log') is null then
	raise exception 'Activation requires migration 20260928248000_runtime_computer_hours_meter'; end if; end $$;
-- Several founders per company (20260928248100); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_founders(uuid)') is null then
	raise exception 'Activation requires migration 20260928248100_company_founders'; end if; end $$;
-- The founding table for a new company (20260928248200); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_start_company_founding(uuid,bigint,uuid)') is null then
	raise exception 'Activation requires migration 20260928248200_company_founding_lobby'; end if; end $$;
-- Metered computer hours are charged as a dry run (20260928248300); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_computer_hour_draws') is null then
	raise exception 'Activation requires migration 20260928248300_runtime_computer_hours_ledger'; end if; end $$;
-- Computer hours payments in Stripe test mode (20260928248910); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_computer_hour_stripe_events') is null then
	raise exception 'Activation requires migration 20260928248910_runtime_computer_hours_payments'; end if; end $$;
-- A company that has used its agents can be deleted (20260928248920); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_purge_company(uuid)') is null then
	raise exception 'Activation requires migration 20260928248920_company_delete_after_runs'; end if; end $$;
-- The shared vault's broker principal registers new companies (20260928248930); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_cloud_secret_broker_principals') is null then
	raise exception 'Activation requires migration 20260928248930_runtime_vault_by_default'; end if; end $$;
-- Node health receipts are deleted by the hourly receipt retention, not by each health observation (20260930485000): an early migration, applied in production before this activation; on the release branch it sorts after it, so cut181-roll.sh prodcheck proves it, not a guard.
-- Hours are not credited to a company that is gone or being deleted (20260928248970); refuse to activate without it.
do $$ begin if not exists(select 1 from pg_trigger where tgname = 'qorpera_computer_hour_credit_company_guard' and not tgisinternal) then
	raise exception 'Activation requires migration 20260928248970_computer_hour_credits_deleted_company'; end if; end $$;
-- A machine's folder authority names each parent resource (20260928249000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_parent_resource(uuid,text)') is null then
	raise exception 'Activation requires migration 20260928249000_folder_core_authority'; end if; end $$;
-- The company state files index vision and agents (20260928249020); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_state_path_problems(text,boolean)') is null then
	raise exception 'Activation requires migration 20260928249020_folder_state_vision_agents'; end if; end $$;
-- The company state files index groups and sections (20260928249100); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_state_index_group(uuid,uuid,uuid,uuid,text,uuid,jsonb)') is null then
	raise exception 'Activation requires migration 20260928249100_folder_state_groups_sections'; end if; end $$;
-- The company state files index connections (20260928249140); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_folder_connection_index') is null then
	raise exception 'Activation requires migration 20260928249140_folder_state_connections'; end if; end $$;
-- A founder can ask to delete a company (20260928249150); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_request_company_deletion(uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928249150_company_delete_request'; end if; end $$;
-- Founders get hour notices by email (20260928249160); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_computer_hour_notices') is null then
	raise exception 'Activation requires migration 20260928249160_runtime_computer_hour_notices'; end if; end $$;
-- Deleting an account keeps its companies; the last member cannot leave (20260928249180); refuse to activate without it.
do $$ begin if position('The last member cannot leave; delete the company instead' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_guard_founder_departure()')),'')) = 0 then
	raise exception 'Activation requires migration 20260928249180_account_deletion_keeps_companies'; end if; end $$;
-- The company state files index rules (20260928249190); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_state_index_rule(uuid,uuid,uuid,uuid,text,uuid,jsonb)') is null then
	raise exception 'Activation requires migration 20260928249190_folder_state_rules'; end if; end $$;
-- A company with no hours left does not wait (20260928249200); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_at_zero(uuid,timestamptz)') is null then
	raise exception 'Activation requires migration 20260928249200_runtime_computer_hours_zero_wait'; end if; end $$;
-- A failed start moves the run to its next attempt on another node (20260928249240); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_runtime_run_start_failures') is null then
	raise exception 'Activation requires migration 20260928249240_runtime_failed_start_next_attempt'; end if; end $$;
-- A company at zero hours keeps its own state (20260928249250); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_computer_hour_zero_state') is null then
	raise exception 'Activation requires migration 20260928249250_runtime_computer_hours_zero_state'; end if; end $$;
-- Agents start company machines (20260928259050); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_admit_company_machine(uuid,text)') is null then
	raise exception 'Activation requires migration 20260928259050_runtime_company_machines'; end if; end $$;
-- Workers use machines too (20260928259055); refuse to activate without it.
do $$ begin if position('(public.qorpera_run_worker(v_receipt.run_id)).id is null' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_native_machine_start(jsonb,text,text,uuid,text)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928259055_runtime_machine_workers'; end if; end $$;
-- The company state files index todos (20260928259210); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_state_todo_key(text)') is null then
	raise exception 'Activation requires migration 20260928259210_folder_state_todos'; end if; end $$;
-- Runner guests still waiting after their job ended are retired (20260928259220); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_runtime_ended_runners(uuid[])') is null then
	raise exception 'Activation requires migration 20260928259220_runtime_ended_runners'; end if; end $$;
-- The folder hook targets take the company row at rank 0 (20260928259230); refuse to activate without it.
do $$ begin if position('rank := 0; tbl := ''qorpera_profiles''' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928259230_folder_core_views'; end if; end $$;
-- Events reach the company through hooks (20260928259260); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_event_hooks') is null then
	raise exception 'Activation requires migration 20260928259260_runtime_event_intake'; end if; end $$;
-- Runs get an hour to finish after hours run out (20260928259270); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_computer_hour_finish_window_over(uuid,timestamptz)') is null then
	raise exception 'Activation requires migration 20260928259270_runtime_computer_hours_finish_window'; end if; end $$;
-- Members can ask whether the company waits for hours (20260928259280); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_waiting_for_hours(uuid)') is null then
	raise exception 'Activation requires migration 20260928259280_company_waiting_for_hours'; end if; end $$;
-- The zero checks are bounded (20260928259300); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_computer_hour_left_many(uuid[])') is null then
	raise exception 'Activation requires migration 20260928259300_runtime_computer_hours_bounded_checks'; end if; end $$;
-- The company state files index routines (20260928259310); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_company_state_index_routine') is null then
	raise exception 'Activation requires migration 20260928259310_folder_state_routines'; end if; end $$;
-- A deleted company's Company Computer is retired (20260928259320); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_retire_runtime_office(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928259320_runtime_office_retirement'; end if; end $$;
-- Members see the hours left (20260928259330); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_computer_hour_member_hours_left(uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928259330_company_hours_left_read'; end if; end $$;
-- Machine tools are offered only once a node can serve them (20260928259350); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_machines_available()') is null then
	raise exception 'Activation requires migration 20260928259350_runtime_company_machines_gate'; end if; end $$;
-- Legacy paths refuse folder-v2 companies (20260928259430); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_is_folder_v2(uuid)') is null then
	raise exception 'Activation requires migration 20260928259430_folder_core_refusals'; end if; end $$;
-- Agents wake on events through today's routines (20260928269290); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_read_agent_event(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928269290_runtime_event_wakes'; end if; end $$;
-- A deleted company's agent machines are deleted with it (20260928269360); refuse to activate without it.
do $$ begin if position('agentMachinesDeleted' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_stop_company_work(uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928269360_runtime_company_delete_machines'; end if; end $$;
-- Agent folders by storage core and the routine login setup (20260928269440); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_prepare_routine_login(jsonb)') is null then
	raise exception 'Activation requires migration 20260928269440_folder_state_run_facts'; end if; end $$;
-- A deleted company's sign-in identities are retired (20260928269450); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_identities_retirable(uuid)') is null then
	raise exception 'Activation requires migration 20260928269450_runtime_identity_retirement'; end if; end $$;
-- A deleted company's storage is removed (20260928269480); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_company_storage_deletions') is null then
	raise exception 'Activation requires migration 20260928269480_company_storage_deletion'; end if; end $$;
-- A deleted company's connector tokens are revoked (20260928269500); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_token_revocations_open(uuid)') is null then
	raise exception 'Activation requires migration 20260928269500_connector_token_revocation'; end if; end $$;
-- Threads open at their newest messages (20260928279410); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_read_session_events_tail' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279410_transcript_tail_read'; end if; end $$;
-- The folder core's run fence (20260928279470); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_tool_run' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279470_folder_core_run_fence'; end if; end $$;
-- The folder core's byte path (20260928279520); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_folder_upload_intents') is null then
	raise exception 'Activation requires migration 20260928279520_folder_core_bytes'; end if; end $$;
-- The folder core's run receipts (20260928279540); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_begin_run_receipt' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279540_folder_core_run_receipts'; end if; end $$;
-- The folder core's run effects (20260928279560); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_send_agent_message' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279560_folder_core_run_effects'; end if; end $$;
-- Internal functions are closed to the API roles (20260928279570); refuse to activate without it.
do $$ begin if has_function_privilege('anon', 'public.qorpera_reserve_execution_sponsor_authority(uuid)', 'execute') then
	raise exception 'Activation requires migration 20260928279570_revoke_api_role_function_grants'; end if; end $$;
-- The folder core's run wakes (20260928279580); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_admit_wakes' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279580_folder_core_run_wakes'; end if; end $$;
-- The folder core's run completion (20260928279600); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_complete_run_job' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928279600_folder_core_run_completion'; end if; end $$;
-- The API roles lose the staff activity list; validators stay with service_role (20260928289610); refuse to activate without it.
do $$ begin if has_function_privilege('anon', 'public.qorpera_list_staff_execution_activity(uuid)', 'execute') then
	raise exception 'Activation requires migration 20260928289610_api_role_grant_guard'; end if; end $$;
-- The folder core's member actions (20260928289620); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_catalog.pg_proc where proname = 'qorpera_folder_company_enter' and pronamespace = 'public'::regnamespace) then
	raise exception 'Activation requires migration 20260928289620_folder_core_member_actions'; end if; end $$;
-- Company mailboxes receive email as event deliveries (20260928299650); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_receive_mail(text,text[],text)') is null then
	raise exception 'Activation requires migration 20260928299650_runtime_company_mailboxes'; end if; end $$;
-- A node refuses new machines while a company has no computer hours (20260928309700); refuse to activate without it.
do $$ begin if position('COMPUTER_HOURS_EXHAUSTED' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928309700_runtime_computer_hours_node_refusal'; end if; end $$;
-- The folder quota is checked before the write (20260928309710); refuse to activate without it.
do $$ begin if position('qorpera_folder_storage_quota_check' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928309710_folder_core_quota_before_write'; end if; end $$;
-- Company Computers wait and power off at zero hours (20260928309720); refuse to activate without it.
do $$ begin if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qorpera_runtime_office_idle_cycles' and column_name = 'wake_reported_at') then
	raise exception 'Activation requires migration 20260928309720_runtime_computer_hours_zero_offices'; end if; end $$;
-- Agents send mail from company mailboxes (20260928309740); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_send_agent_mail(jsonb,text,jsonb)') is null then
	raise exception 'Activation requires migration 20260928309740_runtime_company_mail_sending'; end if; end $$;
-- Batched observation writes and their retention (20260928319370); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_record_runtime_observation_batch') is null then
	raise exception 'Activation requires migration 20260928319370_runtime_observation_batches_retention'; end if; end $$;
-- Orchestrator wake-ups over Realtime, switched off (20260928319550); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_orchestrator_wake_settings') is null then
	raise exception 'Activation requires migration 20260928319550_runtime_orchestrator_wake'; end if; end $$;
-- The folder core's member answers (20260928319670); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_folder_enter_agent_thread') is null then
	raise exception 'Activation requires migration 20260928319670_folder_core_member_answers'; end if; end $$;
-- Agents' machines wait at zero computer hours (20260928319730); refuse to activate without it.
do $$ begin if position('COMPUTER_HOURS_EXHAUSTED' in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_admit_company_machine(uuid,text)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928319730_runtime_computer_hours_zero_agent_machines'; end if; end $$;
-- Coding machines at zero behind their own switch (20260928319760); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_company_coding_at_zero') is null then
	raise exception 'Activation requires migration 20260928319760_runtime_computer_hours_zero_coding'; end if; end $$;
-- Agents list todos from the folder index (20260928319770); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_folder_agent_todos') is null then
	raise exception 'Activation requires migration 20260928319770_folder_state_agent_todo_list'; end if; end $$;
-- Mail sender names cannot read as Qorpera (20260928319810); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_mail_name_reads_as_qorpera') is null then
	raise exception 'Activation requires migration 20260928319810_runtime_company_mail_sender_names'; end if; end $$;
-- Members' functions check membership before the company fence (20260928329660); refuse to activate without it.
do $$ begin if position($m$if not exists(select 1 from public.qorpera_profile_members where profile_id=v_company and user_id=auth.uid()) then$m$ in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_member_office_catalog(uuid,uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928329660_member_auth_before_company_fence'; end if; end $$;
-- ChatGPT plan logins, switched off (20260928329830); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_begin_chatgpt_plan_sign_in') is null then
	raise exception 'Activation requires migration 20260928329830_runtime_chatgpt_plan_login'; end if; end $$;
-- Readers share the company fence (20260928339380); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_company_fence_shared') is null then
	raise exception 'Activation requires migration 20260928339380_company_fence_shared_readers'; end if; end $$;
-- One call fences the native context (20260928339400); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_fence_native_context') is null then
	raise exception 'Activation requires migration 20260928339400_runtime_one_call_context_fence'; end if; end $$;
-- Object RPCs keep a lock budget (20260928339630); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_object_rpc_lock_budget') is null then
	raise exception 'Activation requires migration 20260928339630_object_rpc_lock_budget'; end if; end $$;
-- Folder byte functions have a 2 s lock budget (20260928339780); refuse to activate without it.
do $$ begin if not coalesce((select proconfig @> array['lock_timeout=2s'] from pg_proc where oid = to_regprocedure('public.qorpera_folder_open_upload(uuid,jsonb,text)')), false) then
	raise exception 'Activation requires migration 20260928339780_folder_core_byte_lock_budget'; end if; end $$;
-- Only a connection's owner may revoke it (20260928339790); refuse to activate without it.
do $$ begin if position($m$coalesce(v_connection.owner_user_id = auth.uid() and p_status = 'revoked', false)$m$ in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_set_provider_connection_status(uuid,uuid,text)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928339790_provider_connection_revoke_owner_only'; end if; end $$;
-- Quiet coding check-ins (20260928349850; asked by the folder drain since 20260928519100, and the legacy ask went in the legacy sweep's F3a, 20260930294000); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_coding_quiet_mark(timestamptz)') is null then
	raise exception 'Activation requires migration 20260928349850_runtime_coding_quiet_checkins'; end if; end $$;
-- Folder object garbage collection, switched off (20260928349860); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_folder_object_gc') is null then
	raise exception 'Activation requires migration 20260928349860_folder_core_object_gc'; end if; end $$;
-- Archiving a coding session cancels its queued quiet question (20260928349870); refuse to activate without it.
do $$ begin if position($m$occurrence_key like 'coding-quiet:%'$m$ in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_archive_coding_worker(public.qorpera_runtime_workers,text,uuid,uuid,uuid)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928349870_runtime_coding_quiet_checkins_zero'; end if; end $$;
-- A usage limit stops the run (20260928349910); refuse to activate without it.
do $$ begin if position($m$v_handoff := null;$m$ in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_fail_runner_job(uuid,text,uuid,text,text,boolean)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928349910_runtime_usage_limit_stops_work'; end if; end $$;
-- A run starts in one round trip (20260928359930); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_start_runner_assignment') is null then
	raise exception 'Activation requires migration 20260928359930_runtime_runner_start'; end if; end $$;
-- The rules a ChatGPT plan login keeps, switched off (20260928359950); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_connection_plan_awaits_consent') is null then
	raise exception 'Activation requires migration 20260928359950_runtime_chatgpt_plan_rules'; end if; end $$;
-- Deleting a company ends its ChatGPT plan logins, switched off (20260928359960); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_revoke_company_chatgpt_plan_logins') is null then
	raise exception 'Activation requires migration 20260928359960_runtime_chatgpt_plan_company_delete'; end if; end $$;
-- What the web reads for ChatGPT plan logins, switched off (20260928369970); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_record_chatgpt_plan_routine_offer') is null then
	raise exception 'Activation requires migration 20260928369970_runtime_chatgpt_plan_member_reads'; end if; end $$;
-- A plan's consent only through its member's own switch (20260928369980); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_set_chatgpt_plan_work_while_away') is null then
	raise exception 'Activation requires migration 20260928369980_runtime_chatgpt_plan_consent_guard'; end if; end $$;
-- A routine version's resume fields (20260928369985; turning a plan on resumes no routine since the legacy sweep's F3a, 20260930294000); refuse to activate without them.
do $$ begin if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='qorpera_cloud_routine_versions' and column_name='resume_reason') then
	raise exception 'Activation requires migration 20260928369985_runtime_chatgpt_plan_turn_on_resumes'; end if; end $$;
-- Coding takes a login that may work while away (20260928379920); refuse to activate without it.
do $$ begin if position($m$20260929992000$m$ in coalesce(pg_get_functiondef(to_regprocedure('public.qorpera_coding_owner_sponsor(uuid,uuid,text)')),'')) = 0 then
	raise exception 'Activation requires migration 20260928379920_runtime_coding_payer_consented_first'; end if; end $$;
-- The usage-limit signal reaches the member (20260928379930); refuse to activate without it.
do $$ begin if to_regproc('public.qorpera_coding_turn_usage_limit') is null then
	raise exception 'Activation requires migration 20260928379930_runtime_usage_limit_payer'; end if; end $$;
-- Folder member management: the member-change prelude (20260928399690); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_member_change_enter(uuid,uuid,text)') is null then
	raise exception 'Activation requires migration 20260928399690_folder_core_member_management'; end if; end $$;
-- The folder review recorder (20260928399890); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_record_review(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928399890_folder_core_review_recorder'; end if; end $$;
-- Restricted hire and the hire writer's review (20260928399940); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_agent_delegates_default(uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928399940_folder_state_restricted_hire'; end if; end $$;
-- Routine resume rule and the routine read (20260928399960); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_agent_routines(uuid,jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928399960_folder_state_routine_resume_and_read'; end if; end $$;
-- A refresh request's expiry from its own creation time (20260928409940); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_account_refresh_expiry_from_created()') is null then
	raise exception 'Activation requires migration 20260928409940_runtime_account_refresh_expiry_from_created'; end if; end $$;
-- The runs switch and placement by bundle (20260928409960); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_set_runtime_node_runs(uuid,boolean,bigint,text)') is null then
	raise exception 'Activation requires migration 20260928409960_runtime_node_runs_switch'; end if; end $$;
-- Signed webhooks checked by the vault (20260928409980); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_claim_event_verifications(uuid,text,integer)') is null then
	raise exception 'Activation requires migration 20260928409980_runtime_event_signed_hooks'; end if; end $$;
-- Native host entry points without the service key (20260928409985); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_native_host_call(uuid,text,text,jsonb)') is null then
	raise exception 'Activation requires migration 20260928409985_runtime_native_host_call'; end if; end $$;
-- A job's end ends its presence device and screen leases (20260928419960); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_native_presence_end()') is null then
	raise exception 'Activation requires migration 20260928419960_runtime_native_host_end_cleanup'; end if; end $$;
-- The vault's records for company website accounts (20260928419970); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_company_accounts') is null then
	raise exception 'Activation requires migration 20260928419970_runtime_company_accounts'; end if; end $$;
-- Vault changes take the company row before the secret (20260928419980); refuse to activate without it.
do $$ begin if position('20260929999900' in pg_get_functiondef('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928419980_runtime_cloud_secret_lock_order'; end if; end $$;
-- Human-task and contact files in the folder core (20260928429900); refuse to activate without it.
do $$ begin if position('20260929999000' in pg_get_functiondef('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928429900_folder_state_human_tasks_contacts'; end if; end $$;
-- Company account fill, database side (20260928429975); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_computer_fill_key_valid(text)') is null then
	raise exception 'Activation requires migration 20260928429975_runtime_company_account_fill'; end if; end $$;
-- find_mail and plus addresses (20260928429982); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_find_agent_mail(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928429982_runtime_company_mail_find_and_tags'; end if; end $$;
-- The human-task index (20260928429986); refuse to activate without it.
do $$ begin if position('20260929999980' in pg_get_functiondef('public.qorpera_folder_structured_targets(uuid,jsonb,jsonb)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928429986_folder_state_human_task_index'; end if; end $$;
-- Vault checks refuse a missing proof (20260928429988); refuse to activate without it.
do $$ begin if position('20260929999990' in pg_get_functiondef('public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928429988_runtime_cloud_secret_null_safe_checks'; end if; end $$;
-- The folder core checks a website account's connection file (20260928439950); refuse to activate without it.
do $$ begin if position('20260929999950' in pg_get_functiondef('public.qorpera_company_state_parse_problems(text,jsonb)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928439950_folder_state_website_accounts'; end if; end $$;
-- The account mail mark (20260928439960); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_account_mail(uuid,uuid,text[])') is null then
	raise exception 'Activation requires migration 20260928439960_runtime_company_account_mail'; end if; end $$;
-- The account tool's database side (20260928439965); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_find_company_accounts(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928439965_runtime_company_account_tool'; end if; end $$;
-- The run's own folder view for search (20260928439970); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_run_view_open(uuid,jsonb)') is null then
	raise exception 'Activation requires migration 20260928439970_folder_run_view_open'; end if; end $$;
-- Overflow waits for every fast host (20260928439975); refuse to activate without it.
do $$ begin if position('20260929999997' in pg_get_functiondef('public.qorpera_runtime_claim_turn(uuid,public.qorpera_runner_jobs,public.qorpera_execution_runs)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928439975_runtime_overflow_waits_for_fast_hosts'; end if; end $$;
-- Members read company mail (20260928439980); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_mail_message_ids_due(integer)') is null then
	raise exception 'Activation requires migration 20260928439980_runtime_company_mail_member_read'; end if; end $$;
-- Machine commands record the member their run works for (20260928449950); refuse to activate without it.
do $$ begin if exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'qorpera_company_machine_commands' and column_name = 'requested_by_user_id') is not true then
	raise exception 'Activation requires migration 20260928449950_runtime_machine_command_requester'; end if; end $$;
-- The folder search tool's observation name (20260928449960); refuse to activate without it.
do $$ begin if position('''company_search''' in pg_get_functiondef('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure)) = 0 then
	raise exception 'Activation requires migration 20260928449960_folder_company_search'; end if; end $$;
-- _member_message_quotes (20260928459100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930000100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459100_member_message_quotes'; end if; end $$;
-- _folder_read_actor_deleting (20260928459110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930001000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459110_folder_read_actor_deleting'; end if; end $$;
-- _folder_core_company_machines (20260928459120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459120_folder_core_company_machines'; end if; end $$;
-- _folder_core_renewal_no_key_update (20260928459130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002200' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459130_folder_core_renewal_no_key_update'; end if; end $$;
-- _folder_core_runner_broker (20260928459140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002210' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459140_folder_core_runner_broker'; end if; end $$;
-- _runtime_run_no_progress_notice (20260928459150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002600' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459150_runtime_run_no_progress_notice'; end if; end $$;
-- _folder_core_member_joins_and_lobby (20260928459160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002650' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459160_folder_core_member_joins_and_lobby'; end if; end $$;
-- _runtime_company_mail_waiting_session (20260928459170); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002660' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459170_runtime_company_mail_waiting_session'; end if; end $$;
-- _runtime_member_stops_worker_run (20260928459180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002800' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459180_runtime_member_stops_worker_run'; end if; end $$;
-- _folder_core_vault_lock_order (20260928459190); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930003500' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928459190_folder_core_vault_lock_order'; end if; end $$;
-- _runtime_node_receipt_retention (20260928459200); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_purge_runtime_node_receipts(integer)') is null then
	raise exception 'Activation requires migration 20260928459200_runtime_node_receipt_retention'; end if; end $$;
-- _folder_verify_path_file_refuses_v2 (20260928469100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930001100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469100_folder_verify_path_file_refuses_v2'; end if; end $$;
-- _folder_review_skill_delete (20260928469110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930001200' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469110_folder_review_skill_delete'; end if; end $$;
-- _folder_core_coding_machines (20260928469120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930002300' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469120_folder_core_coding_machines'; end if; end $$;
-- _folder_state_worker_files (20260928469130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930003000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469130_folder_state_worker_files'; end if; end $$;
-- _runtime_native_identity_call (20260928469140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930005000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469140_runtime_native_identity_call'; end if; end $$;
-- _folder_connection_file_marks (20260928469150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930006000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469150_folder_connection_file_marks'; end if; end $$;
-- _member_draft_quotes (20260928469160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930008000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469160_member_draft_quotes'; end if; end $$;
-- _folder_core_gc_switch (20260928469170); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_gc_enabled()') is null or to_regclass('public.qorpera_folder_gc_settings') is null then
	raise exception 'Activation requires migration 20260928469170_folder_core_gc_switch'; end if; end $$;
-- _folder_core_gc_uncatalogued (20260928469180); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_gc_catalog_state(uuid,text)') is null then
	raise exception 'Activation requires migration 20260928469180_folder_core_gc_uncatalogued'; end if; end $$;
-- _folder_core_erasure (20260928469190); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_folder_erasures') is null or to_regclass('public.qorpera_folder_erasure_needles') is null then
	raise exception 'Activation requires migration 20260928469190_folder_core_erasure'; end if; end $$;
-- _folder_core_erasure_agents (20260928469200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930009300' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469200_folder_core_erasure_agents'; end if; end $$;
-- _folder_core_dynamic_routine_tick (20260928469210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930009500' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469210_folder_core_dynamic_routine_tick'; end if; end $$;
-- _folder_company_creation (20260928469220); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930010000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469220_folder_company_creation'; end if; end $$;
-- _runtime_execution_host_call (20260928469230); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930011000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469230_runtime_execution_host_call'; end if; end $$;
-- _folder_core_office_start (20260928469240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930012000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469240_folder_core_office_start'; end if; end $$;
-- _folder_core_member_reads (20260928469250); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930013000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469250_folder_core_member_reads'; end if; end $$;
-- _folder_core_member_hint (20260928469260); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930013100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469260_folder_core_member_hint'; end if; end $$;
-- _folder_core_member_file_page (20260928469270); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930013200' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469270_folder_core_member_file_page'; end if; end $$;
-- _folder_core_deletion_drain (20260928469280); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930015000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469280_folder_core_deletion_drain'; end if; end $$;
-- _folder_state_interfaces_tables (20260928469290); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930016000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469290_folder_state_interfaces_tables'; end if; end $$;
-- _realtime_topic_equality (20260928469300); refuse to activate without it.
do $$ begin if (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages' and ((policyname in ('qorpera_presence_member_receive', 'qorpera_room_drafts_member_receive') and qual like '%topic = ( SELECT realtime.topic()%') or (policyname = 'qorpera_presence_member_publish' and with_check like '%topic = ( SELECT realtime.topic()%'))) <> 3 then
	raise exception 'Activation requires migration 20260928469300_realtime_topic_equality'; end if; end $$;
-- _folder_core_runs_materializer (20260928469310); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930018000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469310_folder_core_runs_materializer'; end if; end $$;
-- _folder_core_office_screens (20260928469320); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930019000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469320_folder_core_office_screens'; end if; end $$;
-- _folder_core_read_set_set_based (20260928469330); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930019500' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928469330_folder_core_read_set_set_based'; end if; end $$;
-- _folder_state_worker_drain (20260928479100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930003100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479100_folder_state_worker_drain'; end if; end $$;
-- _folder_core_office_access (20260928479110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930019100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479110_folder_core_office_access'; end if; end $$;
-- _folder_core_listener (20260928479120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930020000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479120_folder_core_listener'; end if; end $$;
-- _folder_core_member_writes (20260928479130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930021000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479130_folder_core_member_writes'; end if; end $$;
-- _folder_state_follow_up_queue (20260928479140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930022000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479140_folder_state_follow_up_queue'; end if; end $$;
-- _folder_core_coding_turns (20260928479150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930026000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479150_folder_core_coding_turns'; end if; end $$;
-- _folder_core_routine_expiry (20260928479160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930027000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479160_folder_core_routine_expiry'; end if; end $$;
-- _folder_core_erasure_tables (20260928479170); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930028000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479170_folder_core_erasure_tables'; end if; end $$;
-- _folder_core_office_agent_start (20260928479180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930030000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479180_folder_core_office_agent_start'; end if; end $$;
-- _folder_core_office_screenshot (20260928479190); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930030200' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479190_folder_core_office_screenshot'; end if; end $$;
-- _folder_founding_on (20260928479200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930031000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479200_folder_founding_on'; end if; end $$;
-- _folder_core_observability (20260928479210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930032000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479210_folder_core_observability'; end if; end $$;
-- _folder_core_sign_in_machines (20260928479220); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930035000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479220_folder_core_sign_in_machines'; end if; end $$;
-- _folder_core_member_routine_files (20260928479230); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930038000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479230_folder_core_member_routine_files'; end if; end $$;
-- _founding_lobby_hardening (20260928479240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930039000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479240_founding_lobby_hardening'; end if; end $$;
-- _folder_core_upload_readable (20260928479250); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930039500' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479250_folder_core_upload_readable'; end if; end $$;
-- _runtime_office_runs_in_use (20260928479260); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930040000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479260_runtime_office_runs_in_use'; end if; end $$;
-- _folder_core_run_machines_node_drains (20260928479280); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930046000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479280_folder_core_run_machines_node_drains'; end if; end $$;
-- _folder_core_bytes_check_per_object (20260928479290); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930047000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479290_folder_core_bytes_check_per_object'; end if; end $$;
-- _folder_core_identity_recovery (20260928479300); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930049000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479300_folder_core_identity_recovery'; end if; end $$;
-- _runtime_run_stall_tool_calls (20260928479310); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930051000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479310_runtime_run_stall_tool_calls'; end if; end $$;
-- _folder_state_routine_expired_save (20260928479320); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930056000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928479320_folder_state_routine_expired_save'; end if; end $$;
-- _runtime_office_shell (20260928489100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930029000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489100_runtime_office_shell'; end if; end $$;
-- _folder_conflict_copies (20260928489110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930042000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489110_folder_conflict_copies'; end if; end $$;
-- _folder_bytes_possession_first (20260928489120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930043000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489120_folder_bytes_possession_first'; end if; end $$;
-- _folder_core_erasure_copies (20260928489130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930045000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489130_folder_core_erasure_copies'; end if; end $$;
-- _runtime_machine_idle_rule (20260928489140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930055000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489140_runtime_machine_idle_rule'; end if; end $$;
-- _folder_core_office_screenshots (20260928489150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930057000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489150_folder_core_office_screenshots'; end if; end $$;
-- _folder_core_machine_events (20260928489160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930058000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489160_folder_core_machine_events'; end if; end $$;
-- _runtime_payer_never_swaps (20260928489170); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930059000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489170_runtime_payer_never_swaps'; end if; end $$;
-- _folder_core_hooks_mailboxes (20260928489180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930060000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489180_folder_core_hooks_mailboxes'; end if; end $$;
-- _folder_upload_quota_no_oracle (20260928489190); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930062000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489190_folder_upload_quota_no_oracle'; end if; end $$;
-- _folder_state_human_task_wakes (20260928489200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930065000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489200_folder_state_human_task_wakes'; end if; end $$;
-- _folder_first_run_before_converge (20260928489210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930067000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489210_folder_first_run_before_converge'; end if; end $$;
-- _folder_account_downgrade_usage (20260928489220); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930068000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489220_folder_account_downgrade_usage'; end if; end $$;
-- _folder_company_accounts (20260928489230); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930072000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489230_folder_company_accounts'; end if; end $$;
-- _folder_proposals (20260928489240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930074000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489240_folder_proposals'; end if; end $$;
-- _folder_state_worker_followup_status (20260928489250); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930075000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489250_folder_state_worker_followup_status'; end if; end $$;
-- _folder_coding_dispatch (20260928489260); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930077000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489260_folder_coding_dispatch'; end if; end $$;
-- _company_pause_outlives_its_member (20260928489270): no function body carries its marker; its foreign key is gone and the column comment names it. Refuse to activate without it.
do $$ begin if exists (select 1 from pg_constraint where conrelid = to_regclass('public.qorpera_company_execution_pauses') and conname = 'qorpera_company_execution_pauses_paused_by_user_id_fkey')
	or position('20260930079000' in coalesce(col_description(to_regclass('public.qorpera_company_execution_pauses'), (select attnum from pg_attribute where attrelid = to_regclass('public.qorpera_company_execution_pauses') and attname = 'paused_by_user_id')), '')) = 0 then
	raise exception 'Activation requires migration 20260928489270_company_pause_outlives_its_member'; end if; end $$;
-- _folder_state_agent_model (20260928489280); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930081000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489280_folder_state_agent_model'; end if; end $$;
-- _folder_upload_own_puts (20260928489290); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930083000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489290_folder_upload_own_puts'; end if; end $$;
-- _member_quote_words_hold_no_marks (20260928489300); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930087000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928489300_member_quote_words_hold_no_marks'; end if; end $$;
-- _runtime_node_agent_exit_health (20260928489310): no function body carries its marker; its table and three functions exist. Refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_runtime_node_agent_exit') is null
	or to_regprocedure('public.qorpera_assert_runtime_node_agent_exit(jsonb)') is null
	or to_regprocedure('public.qorpera_observe_runtime_node_agent_exit(jsonb)') is null
	or to_regprocedure('public.qorpera_runtime_node_agent_exit_ready(uuid)') is null then
	raise exception 'Activation requires migration 20260928489310_runtime_node_agent_exit_health'; end if; end $$;
-- _folder_core_office_wake (20260928499100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930030100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499100_folder_core_office_wake'; end if; end $$;
-- _folder_core_event_wakes (20260928499110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930061000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499110_folder_core_event_wakes'; end if; end $$;
-- _folder_proposals_runtime (20260928499120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930093000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499120_folder_proposals_runtime'; end if; end $$;
-- _runtime_routine_payer_never_swaps (20260928499130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930095000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499130_runtime_routine_payer_never_swaps'; end if; end $$;
-- _folder_coding_archive (20260928499140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930097000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499140_folder_coding_archive'; end if; end $$;
-- _runtime_shell_checkins (20260928499150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930098000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499150_runtime_shell_checkins'; end if; end $$;
-- _folder_conflict_copies_of (20260928499160); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_conflict_copies_of(uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928499160_folder_conflict_copies_of'; end if; end $$;
-- _folder_proposals_member (20260928499170); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930102000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499170_folder_proposals_member'; end if; end $$;
-- _native_holder_storage_realtime (20260928499180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930103000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928499180_native_holder_storage_realtime'; end if; end $$;
-- _folder_view_renew_machine (20260928509100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930104000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509100_folder_view_renew_machine'; end if; end $$;
-- _interface_offers (20260928509110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930105000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509110_interface_offers'; end if; end $$;
-- _runtime_coding_busy_checkins (20260928509120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930109000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509120_runtime_coding_busy_checkins'; end if; end $$;
-- _runtime_fence_long_budget (20260928509130); refuse to activate without it.
do $$ begin if not exists (select 1 from public.qorpera_native_host_calls where name = 'qorpera_fence_native_context' and budget = 'long') or not exists (select 1 from pg_proc where oid = to_regprocedure('public.qorpera_fence_native_context(uuid,jsonb,text[],jsonb)') and 'statement_timeout=25s' = any(proconfig)) then
	raise exception 'Activation requires migration 20260928509130_runtime_fence_long_budget'; end if; end $$;
-- _memory_generation (20260928509140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930110000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509140_memory_generation'; end if; end $$;
-- _memory_tree_files (20260928509150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930111000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509150_memory_tree_files'; end if; end $$;
-- _folder_erasure_block_history (20260928509160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930120000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928509160_folder_erasure_block_history'; end if; end $$;
-- _native_binding_proven (20260928509170); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_native_binding_proven(jsonb,text)') is null then
	raise exception 'Activation requires migration 20260928509170_native_binding_proven'; end if; end $$;
-- _folder_coding_checkins (20260928519100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930107500' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519100_folder_coding_checkins'; end if; end $$;
-- _folder_coding_results (20260928519110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930108000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519110_folder_coding_results'; end if; end $$;
-- _runtime_run_resume_from_log (20260928519120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930170000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519120_runtime_run_resume_from_log'; end if; end $$;
-- _memory_worker_view_reference (20260928519130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930171000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519130_memory_worker_view_reference'; end if; end $$;
-- _runtime_machine_busy_checkins (20260928519140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930181000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519140_runtime_machine_busy_checkins'; end if; end $$;
-- _drop_native_company_objects (20260928519150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930190000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928519150_drop_native_company_objects'; end if; end $$;
-- _interface_agent_tools (20260928529100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930200000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928529100_interface_agent_tools'; end if; end $$;
-- _folder_agent_manage_hook (20260928539100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930106000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539100_folder_agent_manage_hook'; end if; end $$;
-- _folder_signed_hooks (20260928539110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930160000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539110_folder_signed_hooks'; end if; end $$;
-- _folder_view_shell_commands (20260928539120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930183000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539120_folder_view_shell_commands'; end if; end $$;
-- _runtime_always_on_checkins (20260928539130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930201000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539130_runtime_always_on_checkins'; end if; end $$;
-- _memory_zoom (20260928539140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930202000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539140_memory_zoom'; end if; end $$;
-- _memory_release (20260928539150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930203000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539150_memory_release'; end if; end $$;
-- _memory_view (20260928539160); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_memory_view(jsonb)') is null then
	raise exception 'Activation requires migration 20260928539160_memory_view'; end if; end $$;
-- _memory_branches (20260928539170); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_memory_branches(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928539170_memory_branches'; end if; end $$;
-- _agent_exit_network_rules (20260928539180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930230000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539180_agent_exit_network_rules'; end if; end $$;
-- _drop_company_execution_pause (20260928539190); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_set_company_execution_pause(uuid,boolean,text)') is not null then
	raise exception 'Activation requires migration 20260928539190_drop_company_execution_pause'; end if; end $$;
-- _office_dispose_replay_under_the_office_lock (20260928539200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930241000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539200_office_dispose_replay_under_the_office_lock'; end if; end $$;
-- _founder_guard_read_committed (20260928539210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930242000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539210_founder_guard_read_committed'; end if; end $$;
-- _legacy_routines_folder_only (20260928539220); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930244000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539220_legacy_routines_folder_only'; end if; end $$;
-- _legacy_wakes_folder_only (20260928539230); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930245000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539230_legacy_wakes_folder_only'; end if; end $$;
-- _folder_member_signed_hooks_refused (20260928539240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930280000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928539240_folder_member_signed_hooks_refused'; end if; end $$;
-- _memory_run_logs (20260928549100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930231000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549100_memory_run_logs'; end if; end $$;
-- _legacy_receipts_folder_only (20260928549110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930246000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549110_legacy_receipts_folder_only'; end if; end $$;
-- _legacy_runner_jobs_folder_only (20260928549120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930247000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549120_legacy_runner_jobs_folder_only'; end if; end $$;
-- _legacy_messages_folder_only (20260928549130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930248000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549130_legacy_messages_folder_only'; end if; end $$;
-- _chat_images (20260928549140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930260000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549140_chat_images'; end if; end $$;
-- _runtime_run_resume_gate (20260928549150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930270000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549150_runtime_run_resume_gate'; end if; end $$;
-- _memory_worker_parent_step (20260928549160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930271000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549160_memory_worker_parent_step'; end if; end $$;
-- _legacy_office_starts_folder_only (20260928549170); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930290000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549170_legacy_office_starts_folder_only'; end if; end $$;
-- _legacy_office_use_folder_only (20260928549180); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930291000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549180_legacy_office_use_folder_only'; end if; end $$;
-- _legacy_machines_folder_only (20260928549190); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930292000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549190_legacy_machines_folder_only'; end if; end $$;
-- _legacy_sign_in_folder_only (20260928549200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930293000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549200_legacy_sign_in_folder_only'; end if; end $$;
-- _legacy_quiet_checkins_folder_only (20260928549210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930294000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549210_legacy_quiet_checkins_folder_only'; end if; end $$;
-- _legacy_wake_drains_dropped (20260928549220); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_drain_worker_wakes(integer)') is not null then
	raise exception 'Activation requires migration 20260928549220_legacy_wake_drains_dropped'; end if; end $$;
-- _memory_group_chat_view (20260928549230); refuse to activate without it.
do $$ begin if coalesce(obj_description(to_regclass('public.qorpera_memory_tree_companies'), 'pg_class'), '') not like '%group chat%' then
	raise exception 'Activation requires migration 20260928549230_memory_group_chat_view'; end if; end $$;
-- _legacy_company_creation_folder_only (20260928549240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930330000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549240_legacy_company_creation_folder_only'; end if; end $$;
-- _legacy_proposals_substrates_dropped (20260928549250); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_get_company_proposal(uuid)') is not null then
	raise exception 'Activation requires migration 20260928549250_legacy_proposals_substrates_dropped'; end if; end $$;
-- _legacy_office_transfers_dropped (20260928549260); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_runtime_office_file_imports') is not null then
	raise exception 'Activation requires migration 20260928549260_legacy_office_transfers_dropped'; end if; end $$;
-- _legacy_mail_attachment_save_dropped (20260928549270); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_native_mail_attachment(jsonb,jsonb)') is not null then
	raise exception 'Activation requires migration 20260928549270_legacy_mail_attachment_save_dropped'; end if; end $$;
-- _legacy_runner_broker_whole_tree_dropped (20260928549280); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_runner_model_gateway_authority(uuid)') is not null then
	raise exception 'Activation requires migration 20260928549280_legacy_runner_broker_whole_tree_dropped'; end if; end $$;
-- _legacy_kernel_row_writers_dropped (20260928549290); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_company_path_live_sha256(uuid,text)') is not null then
	raise exception 'Activation requires migration 20260928549290_legacy_kernel_row_writers_dropped'; end if; end $$;
-- _legacy_mail_attachment_fetches_dropped (20260928549300); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_claim_mail_attachment_fetches(integer,uuid)') is not null then
	raise exception 'Activation requires migration 20260928549300_legacy_mail_attachment_fetches_dropped'; end if; end $$;
-- _folder_view_networked_commands (20260928549310); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930342000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549310_folder_view_networked_commands'; end if; end $$;
-- _folder_stripe_hook_capture (20260928549320); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930344000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549320_folder_stripe_hook_capture'; end if; end $$;
-- _folder_stripe_hook_hold (20260928549330); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930345000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549330_folder_stripe_hook_hold'; end if; end $$;
-- _chat_images_runtime (20260928549340); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930360000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549340_chat_images_runtime'; end if; end $$;
-- _interface_change_notes (20260928549350); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_note_interface_changes(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928549350_interface_change_notes'; end if; end $$;
-- _interface_supervision (20260928549360); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930371000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549360_interface_supervision'; end if; end $$;
-- _interface_supervision_agents (20260928549370); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930372000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549370_interface_supervision_agents'; end if; end $$;
-- _folder_links (20260928549380); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930380000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549380_folder_links'; end if; end $$;
-- _coding_machine_identity (20260928549390); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930394000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549390_coding_machine_identity'; end if; end $$;
-- _folder_test_machine_views (20260928549400); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930420000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549400_folder_test_machine_views'; end if; end $$;
-- _folder_test_machine_credits (20260928549410); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930421000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549410_folder_test_machine_credits'; end if; end $$;
-- _runtime_coding_machine_stopped (20260928549420); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930431000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549420_runtime_coding_machine_stopped'; end if; end $$;
-- _coding_snapshots (20260928549430); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930435000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549430_coding_snapshots'; end if; end $$;
-- _coding_environment_secrets (20260928549440); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930438000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549440_coding_environment_secrets'; end if; end $$;
-- _memory_message_erase (20260928549450); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930441000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549450_memory_message_erase'; end if; end $$;
-- _memory_tree_prune (20260928549460); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930442000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549460_memory_tree_prune'; end if; end $$;
-- _coding_machine_read_set (20260928549470); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930445000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928549470_coding_machine_read_set'; end if; end $$;
-- _coding_turn_runs (20260928559100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930250000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559100_coding_turn_runs'; end if; end $$;
-- _memory_tree_writer (20260928559110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930300000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559110_memory_tree_writer'; end if; end $$;
-- _native_admission_split (20260928559120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930300100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559120_native_admission_split'; end if; end $$;
-- _memory_run_resume (20260928559130); refuse to activate without it.
do $$ begin if to_regclass('public.qorpera_memory_run_resumes') is null or to_regprocedure('public.qorpera_memory_run_resume_record(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928559130_memory_run_resume'; end if; end $$;
-- _memory_worker_binding (20260928559140); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_worker_parent_run(jsonb)') is null or to_regprocedure('public.qorpera_memory_view_reference_check_run(jsonb,jsonb)') is null then
	raise exception 'Activation requires migration 20260928559140_memory_worker_binding'; end if; end $$;
-- _runtime_node_code_hosts (20260928559150); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930397000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559150_runtime_node_code_hosts'; end if; end $$;
-- _legacy_workspaces_snapshots_dropped (20260928559160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930410000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559160_legacy_workspaces_snapshots_dropped'; end if; end $$;
-- _legacy_session_turn_wake_executor_dropped (20260928559170); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_complete_wake(uuid,text,uuid)') is not null then
	raise exception 'Activation requires migration 20260928559170_legacy_session_turn_wake_executor_dropped'; end if; end $$;
-- _legacy_plain_sessions_receipts_dropped (20260928559180); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_list_shared_sessions(uuid)') is not null then
	raise exception 'Activation requires migration 20260928559180_legacy_plain_sessions_receipts_dropped'; end if; end $$;
-- _legacy_company_computer_bindings_dropped (20260928559190); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930415000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559190_legacy_company_computer_bindings_dropped'; end if; end $$;
-- _folder_test_machine_retire (20260928559200); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930424000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559200_folder_test_machine_retire'; end if; end $$;
-- _coding_mcp_sign_ins (20260928559210); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930440000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559210_coding_mcp_sign_ins'; end if; end $$;
-- _memory_message_erase_turns (20260928559220); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_memory_message_erase_due(integer,uuid[])') is null then
	raise exception 'Activation requires migration 20260928559220_memory_message_erase_turns'; end if; end $$;
-- _folder_view_served_by_code_host (20260928559230); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930446000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559230_folder_view_served_by_code_host'; end if; end $$;
-- _memory_message_erase_copies (20260928559240); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930470000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559240_memory_message_erase_copies'; end if; end $$;
-- _folder_test_machine_reads (20260928559250); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930480000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928559250_folder_test_machine_reads'; end if; end $$;
-- _code_hosts_deleting (20260928569100); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_code_hosts_deleting(text,text,uuid[])') is null then
	raise exception 'Activation requires migration 20260928569100_code_hosts_deleting'; end if; end $$;
-- _folder_code_names (20260928569110); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930446100' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928569110_folder_code_names'; end if; end $$;
-- _folder_git_rules (20260928569120); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930446200' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928569120_folder_git_rules'; end if; end $$;
-- _folder_git_leases (20260928569130); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930446300' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928569130_folder_git_leases'; end if; end $$;
-- _folder_git_expiry (20260928569140); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930446400' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928569140_folder_git_expiry'; end if; end $$;
-- _folder_office_inherit_command_reads (20260928569150); refuse to activate without it.
do $$ begin if to_regprocedure('public.qorpera_folder_office_inherit_command_reads(uuid,uuid,uuid)') is null then
	raise exception 'Activation requires migration 20260928569150_folder_office_inherit_command_reads'; end if; end $$;
-- _folder_test_machine_served_by (20260928569160); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930496000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928569160_folder_test_machine_served_by'; end if; end $$;
-- _memory_run_log_gate (20260928579100); refuse to activate without it.
do $$ begin if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and position('20260930352000' in p.prosrc) > 0) then
	raise exception 'Activation requires migration 20260928579100_memory_run_log_gate'; end if; end $$;
-- This release's 20260930900000_surface_discard_worktree_cleanup (#2370 (discarded code_repo worktree cleanup): bundle 283 pairs with qorpera_surface_complete_cleanup and qorpera_surface_lock_coding_workers_for_sessions); refuse to activate without it on a database past 20260930534000 (a fresh chain in file order reaches it only after this file).
do $$ begin if to_regprocedure('public.qorpera_os_relative(text)') is not null and not (to_regprocedure('public.qorpera_surface_complete_cleanup(uuid,text,text,uuid)') is not null and to_regprocedure('public.qorpera_surface_lock_coding_workers_for_sessions(uuid[])') is not null) then
	raise exception 'Activation requires migration 20260930900000_surface_discard_worktree_cleanup'; end if; end $$;
-- This release's 20260930901000_surface_update_change_in_place (#2365 (surface update change in place): bundle 283 pairs with qorpera_surface_reply_target_change_id and 14/16-arg change recording signatures); refuse to activate without it on a database past 20260930534000 (a fresh chain in file order reaches it only after this file).
do $$ begin if to_regprocedure('public.qorpera_os_relative(text)') is not null and not (to_regprocedure('public.qorpera_surface_reply_target_change_id(uuid)') is not null and to_regprocedure('public.qorpera_record_surface_change(uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,text,text,uuid)') is not null and to_regprocedure('public.qorpera_native_surface_record_change(uuid,uuid,text,text,text,text,text,uuid[],text[],jsonb,jsonb,boolean,uuid,text,text,uuid)') is not null) then
	raise exception 'Activation requires migration 20260930901000_surface_update_change_in_place'; end if; end $$;
-- Keep the predecessor check, insertion and pointer update in one atomic statement.
-- A stale deployment must never replace a newer active runtime.
do $$ begin
	perform 1 from public.qorpera_active_runtime_bundle where singleton for update;
	if not found or not exists (
		select 1 from public.qorpera_active_runtime_bundle a
		join public.qorpera_runtime_bundles b on b.id=a.runtime_bundle_id and b.sha256=a.runtime_bundle_sha256
		where a.singleton and b.bundle_key='qorpera.cloud-runtime' and b.version=282
		and b.sha256='c8e468a4259d98372ee4535002f910a9988168b5e28b33a5a8e310c2331b56fc'
	) then raise exception 'Activation requires exact active runtime v282' using errcode='55000'; end if;
insert into public.qorpera_runtime_bundles(bundle_key,version,manifest,sha256)
values ('qorpera.cloud-runtime',283,'{"schema": "qorpera.runtime-bundle/v2", "components": {"kernel": "5b24131bbf31d09f20e5dcd931679a4547de5954b7be6ce92189e7b08339aa26", "toolCatalog": "eb9fa48794b34a099790cf6a174830d78664a18bf5fdc4ac786038602e1ea514", "constitution": "4933d6091e3566a3562e9465ee3ca1edb0bcadbdc9800c12c9743cc63fe3ba7a", "authorization": "4fd9ecd6a9ea48e8f84f17fcf7fda342c68f84c1b68ec5212cc3eac9d103d2c7", "inboundSafety": "4126b91c0f00d1eb820cbc5e9a7875c8c2441e71afe8fa46ed7c3c37dffb7f25", "outboundSafety": "f263b07e1b7bd9ae971582515a8284aecbc02879250e3e83090ef998630b9ea3", "wakeAndSilence": "5c176755a17670eb50f9f4a85b663d52c55c08be49e01398d750bc89f0b997b7", "contextComposer": "0072b0f51d62959eee99ec2011d1d065b825e130e90201aeacb9b639795fffbe", "memoryAndSkills": "9d44c37f2bdfd93081c93b8418307510e559dbed212f34bed5a8a3eaf6a8e261", "workerLifecycle": "aa223028303daa0674ef2670ade51bbfd5287aa969acfbd9f01c878b3d86c957", "providerBootstrap": "8c29ab43ad7ecea4b99fd8738c2ee2de46e173af92bdd3979725af02f902f396", "interactionSurfaces": "21219a6795d19e0b2aa58e57a4d5d9777eb0932a88fdfa052d3798c790dc35ea"}, "modelPolicy": {"effort": "low", "schema": "qorpera.model-reasoning/v1", "allowed": ["low", "medium", "high"], "fastMode": "thread", "overrides": "routine-and-thread", "unattended": "high", "claudeChoice": "thread", "geminiChoice": "thread", "threadEfforts": ["xhigh"]}, "implementation": {"package-lock.json": "3ad39ad9aef153f7ababc264286deac44cd3af888a9b0d12593b7910fe716c57", "supabase/migrations": "4fd9ecd6a9ea48e8f84f17fcf7fda342c68f84c1b68ec5212cc3eac9d103d2c7", "scripts/package-service.mjs": "4ac7a2419e9f923e27d1b186c9af58195e211c55d229c09104a596bcd24a4113", "packages/runtime/package.json": "d3494035d7e5c5a846526449e43d62c62eae98afef8191d7c5700769897f06c0", "deploy/coding-worker/control.ts": "f7b75f115bc923f178139217a9520b39d53877583763717039ffd3f6aeec6ad3", "packages/contracts/package.json": "a140d635f57f59d5f8612d9e28ec1fafd5eb2f7615ceb0a03eac14d249a32bc9", "packages/contracts/src/index.ts": "cdee9135bbace536bd9b6e22049b045a206ed86a8c4c7ffae1021de837bdded7", "deploy/coding-worker/executor.ts": "115770adecde98f970b4ac21ce1864d52e1124402b10b428dc437f88e9ef7293", "packages/runtime/kits/map/KIT.md": "e1baa28feb17be03fb6b950775e2d634acdefcb4f71b561167d48697bcbbd0f1", "scripts/package-coding-guest.mjs": "b9b211a172fc437e73fccea9c14b74c01742695e37ea5db8d2bbe7c80ecb452b", "packages/runtime/kits/flow/KIT.md": "f751ed33311fdceab1c03fa3aa4386004c4a7c03c927c1c7fa801d683d48d615", "packages/runtime/kits/path/KIT.md": "2fdaf23140738b82ded32ac18d109e4571e85ce9ca58416cb10f1ead59229f63", "packages/runtime/kits/ring/KIT.md": "28572b3d3d9a03b4bf54d4c17bbc4a3c0bfd850c0ee73d4dbab7f9e18aec673a", "scripts/runtime-assets-plugin.mjs": "169ce941c1066b62159aa58df486e2893d7bb39897967dc0f9dadc34a5e21466", "packages/cloud-client/package.json": "66026be2cb89a382d537e25a5d9c0c65acb91de3e40ffde8effb772abf1c42d6", "packages/contracts/src/surfaces.ts": "f8b5456bc0a4c7a4b0620940a620492a9d7f2847d9f42c93cf04714a0ab61797", "packages/runtime/kits/board/KIT.md": "f7cec71338a5af89a34093eaa90607c3dcdbf4eb3c0ee73680521af65c344d25", "packages/runtime/kits/curve/KIT.md": "859b1b7ada355be9d4a27cffb17dea06f624a929e94b19211f5d2c4f1fdc4cda", "packages/runtime/kits/model/KIT.md": "47f3bb9e9e15624faa989ca1ab25f66fcf058563a580b237062c50a308fd2a1f", "packages/runtime/kits/shelf/KIT.md": "cd28068add5f25c4c3dc52005cf90f29e4b834410479f59b803392bc4b59e702", "packages/runtime/kits/stack/KIT.md": "2e6dfd21cd345d901b647b2b1411dc4275eea6fcb2541d828165a5c8d91910d4", "deploy/coding-worker/credentials.ts": "067c88556d70a381b9065a901c45f6c0242a61eb2b5d85026438ebfb5ad006db", "packages/contracts/src/idle-rule.ts": "bf776510e33dec46e8f2197f20885d45bb8ee706cac7b4ea1e793d3c026cd4b7", "packages/runtime/kits/map/engine.js": "478265306af7a6867c1535fa54f4dae4bd58ebbd30f65f102b1fd74af874c41d", "packages/runtime/kits/object/KIT.md": "3bf6481619ade95940a1ceec0fd0bff3947a8a56aa3de75ac2aa1576ae4ee016", "packages/runtime/src/abort-scope.ts": "d6fa1f4988e13978bac4d3cbc943a565e2cc22dbf832e5e0b24e088ac630ea35", "packages/runtime/src/database-ca.ts": "22a219ef5c2a7fffedf1c8c709e643fe6f5f604d31d6a202eb099fe85069dbb1", "scripts/native-company-artifact.mjs": "e394bc799104f188769de07cd3be14e6c732a1a672113ea45d349a29d8e0ca63", "scripts/package-coding-executor.mjs": "30e89beb2952a28f975c395e34f6306163145dffaceca88161599867d4ed4765", "packages/contracts/src/folder-key.ts": "f069c9cc4f361d7113a28e857766757af725084cc181cf782b511735400e9ec1", "packages/runtime/kits/flow/engine.js": "2af43b8c53aba8719ee6142c2c22642ac1b41b36d6809f0b3b5884377b7fd9ec", "packages/runtime/kits/path/engine.js": "d739c06d2487653bf553654c267d509374e8ebf9083d321156cab538765a5e33", "packages/runtime/kits/ring/engine.js": "00d04416a41bfa7de13e46225611f9e7324b2eeb1fa59ec3097b5e556a98943e", "scripts/package-ephemeral-runner.mjs": "b38e2467bbd2bb107585deb2a9ce965d151df03b9fef8c2b7f9748c9b77f46a4", "scripts/package-lxd-runner-guest.mjs": "1f8d6b729000a3f41b36702d8997c9a05d6b0a15df68d1ed1c25018389eb45d3", "deploy/coding-worker/host-watchdog.ts": "4fceb80cc82963b0e7b5fc1650437975c8fe5e22a3c33439b6dc25c3ce594a58", "deploy/ephemeral-runner/image/run-job": "8cf020104cf575e956a34710d50967d334be6f5988a5a6e3c6c17d8a99703fa4", "packages/contracts/src/abort-scope.ts": "245bbe8bcad4df15048477b14241abe044b20a481d5fcd8ec5b240e13475cac0", "packages/contracts/src/wire-values.ts": "1ec3bd0acff40e7a2ee29070fa9001930d52ad1a355e4eed7417ebf3150b6875", "packages/runtime/kits/board/engine.js": "9e9b72b7b89dbf7da8f5b8b9fb143eccbc26ea02b3c4093fed83bdd0b19981c1", "packages/runtime/kits/curve/engine.js": "dc5a6b02075ec017f5896be61be8c428ee004ca2bd3c4b4035151a319b5c7f5d", "packages/runtime/kits/model/engine.js": "e3c1a59cd88f302c74f9c520c7cf13c219e88302d090a9a3ec756d74f3baf220", "packages/runtime/kits/shelf/engine.js": "4be3627b40d1ebf5007738ded9e0d1512b3d48062c238ba66e797093e4ff4392", "packages/runtime/kits/stack/engine.js": "f5f1bfbec1993a9c5946b5d265d2b43836ec722f6db892b63e1f906bab222060", "packages/runtime/src/cloud-run-log.ts": "abffabbf0ffb0aff173f0d99bf6fd4336f37c31c378ebfdcbd475b78023e92ce", "scripts/package-coding-guest.test.mjs": "5d041660812b5dce8cee0a43f382f7f3e4c948239ab99d93b13d9e9c101d3d64", "deploy/coding-worker/member-control.ts": "f44c7cbf4395946eec9752fb02e7024f8c60e1e79d721a71ecfe8afd9c2f5606", "deploy/coding-worker/timeout-signal.ts": "64034f2499497537cde7b460da0b4935947075d2c0430c12697ab2145f6e3bce", "packages/cloud-client/src/app-icons.ts": "bc6e27b538ff2e2b50b1c7d2ce76cecf126423bb87eaeb14d07ac984f13efad4", "packages/contracts/src/cloud-coding.ts": "d5e4d3878a2913845e16fbc6be2fa070fd08368a3baabe7eeb103ea22893046d", "packages/runtime/kits/object/engine.js": "cc942cb867fee504fdebca014d0210caa3082ac932ed78ef26c359f76bf80f9f", "packages/runtime/src/cloud-app-kits.ts": "869f06ac03e78b3338b1d4ce11a80708fade9bf9c2e77ec6638110505e49e26f", "packages/runtime/src/cloud-wake-bus.ts": "9525d0de90a513c02d494a987e6c33c2adb53b942cbb571d151a1f077180a560", "scripts/package-coding-guest-agent.mjs": "246b70a83818d90818e4b8be7410453da67c66093196d455393ed06a8536a19f", "deploy/coding-worker/command-routing.ts": "47daf6216b1bc3772b170aca29baf62640f3cdb4e25718f8ec6e9e59484b06c5", "packages/cloud-client/src/agent-wall.ts": "0755e19fa908e0e0401470b331a08f26576e631075cf602bf89bd67f73f2e402", "packages/cloud-client/src/app-groups.ts": "6a85950e64149a4b2e342c1edc3c841a425be2d639c5b63b82a4844adc331bf9", "packages/cloud-client/src/interfaces.ts": "3cd055345d13cc859f8f9d592cd98cd62aa0db683be5879243bee325a0e49f6a", "packages/contracts/src/cloud-machine.ts": "d0916e9de7247c319030281c377753761b49becc20c4b811832cd7219763d714", "packages/contracts/src/surface-merge.ts": "1c49786a4de6bf60ba83d8a27481614bcac21b97fc6fee17d060016e13874a87", "packages/runtime/kits/figures/bolt.webp": "5679e2be9cdcf08926b2b1b300c57c05bdfc630a698ba07fa72e1eb0793acc44", "packages/runtime/kits/figures/moon.webp": "4e1aad0ad63b237291a26b2078e5599a2594b1336e077becd5577bbd6e691b61", "packages/runtime/kits/figures/star.webp": "836f70caecc720a67985827f23189ff635450239ffbe7914f06b37a2fe07dfa9", "packages/runtime/src/cloud-bank-sync.ts": "c93e0f21ef726e71ff31982be2dc30dddcaccafe61622590fa0a9bf93a8982d3", "packages/runtime/src/cloud-light-ask.ts": "f295dff5a0444ef3da514380f64e9def9cb2db739a4148db08562be0eb0ae2a9", "packages/runtime/src/cloud-tool-json.ts": "b554c7c600f93c91f69486b032de28b33c9543083e7ebd14be70339ab5f82cb9", "deploy/coding-worker/repository-fetch.ts": "c8dc0ad8ec19e4f99faba2ebcaeff269ed32e43a4a51137021fe7c90314a17ba", "packages/cloud-client/src/app-program.ts": "f45baff0fcb7eb297ee27adc28569bcd7e950c30f6580e9111c7afa5c1721b1b", "packages/cloud-client/src/app-retired.ts": "9c10d9f3111c1b5f35e222651a5bcbe66d0f26bc69a02b745dd3036c5dc67bf5", "packages/cloud-client/src/toml-subset.ts": "988b2584ae13f5943919402aca108485a6963ed96320bfbf3c3d3603029e8078", "packages/contracts/src/surface-layout.ts": "1031f4ed1f1dbada0556e6144eacca386c608ed485cc5a2c11aef3d146ce7b63", "packages/runtime/kits/figures/acorn.webp": "5261c3db0e89c692fb3d2d3cbdca350f8470e40e7daa0b0f8f759fa634ed7372", "packages/runtime/kits/figures/cloud.webp": "64ed3c6561ee7b179a33e26e4630ff02a590bb0049dc799751c58ac069563a18", "packages/runtime/kits/figures/crown.webp": "e2cd7e528abfd696b26fe3d6743f6e0055f1cb0c984f1ebf84977e5e8f6e3fed", "packages/runtime/kits/figures/flame.webp": "1cbdf30836762b5969310e2c2158de6124a89c07d7c109daa53e162afc3ae88d", "packages/runtime/kits/figures/heart.webp": "943934e77721745d2372b88baf95091e9f3907d8c95b92fc95cb1da597584513", "packages/runtime/src/cloud-agent-head.ts": "6e9a0b097712b3874cc388fa03db94ca717d3219c33379f5167df19b92b1360b", "packages/runtime/src/cloud-app-guides.ts": "ab5c74b5d2e8a891e5163603bc7191c4014636dc76ab316de7d076c9e1735420", "packages/runtime/src/cloud-claude-box.ts": "09a220ae126a056b1855ec152152f4a46874bd301ea170922fee004500b14095", "packages/runtime/src/cloud-code-tools.ts": "3d2fe8b781702dab0e2efa4877106ff6d0862946ac8bb6f29125c928db09e91d", "packages/runtime/src/cloud-codex-home.ts": "655fb60d1e766b70430ba23f5a781e92626d4cc28abce0cb3d92b8907283a412", "packages/runtime/src/cloud-data-tools.ts": "c3ecd6fc4b09e3f54b1c9cd62b4b7fd8b65763eb2461b616f1b9075cf04e0448", "packages/runtime/src/cloud-gemini-tts.ts": "fb2e08fb7446ff66172847757819b3159bf08b802a99d2eaf272d1dd29e196ba", "packages/runtime/src/cloud-run-resume.ts": "43a886b497fe1bd4b9fdbeb32718fab683857bf85f25a1fc11bc1d4ed693de9f", "packages/runtime/src/cloud-site-tools.ts": "e7e2f801c3b378d564c007c8651e43f2f4bd384d32242ec0f2e29096ddf5439f", "packages/runtime/src/cloud-x25519-box.ts": "a1115e24b00da96e2d77529606c36a9c11bf47bad1eecf93dd013d1aa1854fc3", "packages/runtime/src/memory-tree/fold.ts": "ce2fa0b9b6c235c8675496d30a473500105e33d4448e909663861f1a9e09b3c4", "packages/runtime/src/memory-tree/tree.ts": "bc27714f82ad47b62229863e0673251fb004616224a38a963a21747f1629df35", "deploy/coding-worker/command-authority.ts": "081148617aa074917237fb077b158805172c90e4e1c8faeaf1f5de319c4dc6d6", "deploy/coding-worker/qorpera-coding.slice": "c27ab0c329b42cde3b6dabc9fc83ee43b80674527eb989589207433b18cf49cf", "packages/runtime/kits/explainer/engine.js": "32eeafbb5b489a13c10e261231d5344a9afc7cf9d54de70573390003c95d346a", "packages/runtime/kits/figures/planet.webp": "32300513535732096564f03ffe98ff632283cbeab04aa0310b14a4b847df49b7", "packages/runtime/kits/figures/puzzle.webp": "020190462105e5ac2666291f8d0335912b3e2946d2f99862456dd6f663601e73", "packages/runtime/kits/figures/rocket.webp": "98444d6eb691c4e39e38eb582b9d7c1db186b1a66171214271879f43416835ef", "packages/runtime/src/cloud-agent-mouth.ts": "353d19677af4917d8524c7034b877aa45053a1be6255fb123b4b06e5c1d0c408", "packages/runtime/src/cloud-code-checks.ts": "576bf547ffc0f39093db0677d7041a0c5647b9e25f01422c0ffe62ad49e381cc", "packages/runtime/src/cloud-event-tools.ts": "39c7d9dd195b0f7d11b528c0ba95e21378d5f791cc2ef389f1a88d956a4b4779", "packages/runtime/src/cloud-skill-tools.ts": "11082ea34ce64562d9c522c5e28a00c436cbd3f1f84428646e046ca3128dc284", "packages/runtime/src/digital-post-memo.ts": "2e7f9e5b256eb10611733eeef9fda736dfb8bc2683fbc3c474f21fea92d25eb4", "scripts/generate-cloud-runtime-bundle.mjs": "da622f4b9d9a75c0b5d7605fc5b5e705770f9a03571e20f45e7ed5f1290f272d", "deploy/coding-worker/coding-environment.ts": "19d6beedfcb2151904e43b4d5492f0ac4e131bc6b408b1623e4c46a1e5da6f90", "deploy/first-node/native-codex/source.json": "9aaae9fdb4bba175266f54265b9c7bf64194890a7a8b7fc3bd9842c800897499", "packages/cloud-client/src/cloud-request.ts": "4c537ed6915e65a72b52fe480dc3cc3bca9bf1376d6209bd15425ba7112b4530", "packages/cloud-client/src/network-rules.ts": "6a6e1b18ec85cbc05fcb86a133114af9958d7fc075d3ff609cb1b0ae38fff390", "packages/runtime/src/cloud-chatgpt-plan.ts": "3044246e8a02a5cd32ee5dc0b19b8f73d18790b227e97a415e0633ee80669ee4", "packages/runtime/src/cloud-folder-todos.ts": "e6a15d5b324ef44076bf712604d92798ab32439d0ce6745d19a0132f587a5564", "packages/runtime/src/cloud-hiring-tools.ts": "c44d438f7bf47f19211a2af8bc9c21c02cf543c72973c2c735a8b8e12d32eaba", "packages/runtime/src/cloud-home-channel.ts": "f7605d0dcf7aa5b191c965124a87e7dc04923956d00bac2b24889c439430a45f", "packages/runtime/src/cloud-memory-tools.ts": "07c446408c0a7e8973f542a393ed9375b3bc079f9d50b0115868351b35384863", "packages/runtime/src/cloud-routine-pace.ts": "63b34a20c4506c603db58739737a1e2a0983c5987f00862e0ec8d0add772c7dd", "packages/runtime/src/cloud-run-log-open.ts": "a5ed0f4e7da9cac76f77e2241314aa5fd055716b87b58a72f7f33d21174666c7", "packages/runtime/src/cloud-secret-tools.ts": "0a481709ea450169e6804f946ef7b9a3f8fa8f083c38853d3c7d00e5b8e59418", "packages/runtime/src/cloud-worker-tools.ts": "28abd22c3aa8e2e7b5b82567ae40a7dc61aa63553d54f3207211ce1351d7dcda", "packages/runtime/src/memory-tree/render.ts": "77875bfa05035faae69f82767b71e3b4ea2489de77ecca4fd404767624496aa0", "packages/runtime/src/systemd-credential.ts": "1d3eb8038a369c58418cbd8248aecf457662cbb3430cc84847235c2222a82478", "packages/cloud-client/src/interface-apps.ts": "3e417c5e034b3424eef0715873955a6e7132af41bf69700b4c6fd230508cb3ab", "packages/contracts/src/cloud-code-checks.ts": "baafc576424833f2c5625984af3c6bb112836aec9c122c8f5a45fea1b9b56bae", "packages/runtime/kits/figures/mushroom.webp": "47b6a2646ec2f90b559cf66cfeaa86dbc2c665472db3db7fd96c36ee4fad29c0", "packages/runtime/src/bank-summary-reduce.ts": "b4c435a90e2cfd0729fc7dbab0dcaa22b193e342234905811fa905cc120d099c", "packages/runtime/src/cloud-action-review.ts": "8e9ed54e233eecb24ba01c823ddc211f239a5248402d025a74a002c5a89e6334", "packages/runtime/src/cloud-claude-worker.ts": "87a033843bf8e7177b8d70798773bea49e7b777a90a9ef1d46e905253dffd906", "packages/runtime/src/cloud-command-pages.ts": "773566cbf9e384cc7dcfdc46f8fae2f6cba0062b79b3c1ce81b5bda6c0b69f63", "packages/runtime/src/cloud-folder-hiring.ts": "b5a821be6c1962d08f501a2edb03aa3c44df689c2e3108b8ce59ccf81a8df07f", "packages/runtime/src/cloud-folder-images.ts": "10cf44f32ff9626bea5153fb6b95f258968b2c7a1b6ecdf634f2e5441d3d7c25", "packages/runtime/src/cloud-machine-tools.ts": "d9056ad3baa0b7f427ca5d6ac7bc0743a4f497d077b27168f70b9b2c9761c4cc", "packages/runtime/src/cloud-native-egress.ts": "67f2bb50ec0118af93a308e8503a065f4089dfee13efc399f5ab88d902e5809b", "packages/runtime/src/cloud-routine-tools.ts": "8061f01692d493e2f9277d495b897dd0fd0dab432dde646c14254e92fea1ea00", "packages/runtime/src/cloud-runner-broker.ts": "e6ffdb689110d53a3f578bde753befce90f77ac5a3dbf242972aabf6c25ac2f4", "packages/runtime/src/cloud-runner-worker.ts": "a92b99cb45ee29b8b210d7d97940bc0d310dfcf5fb4604bab1d44901327151d9", "packages/runtime/src/cloud-secret-broker.ts": "4784f1dd6230a20a4c41640d44b19fe447d4bca48edfb7345dbe69f7dc732fbd", "packages/runtime/src/cloud-secret-crypto.ts": "1106e22d72b31798694e64ad408e3c0fc8aece5bca643bf107150788a45c3559", "packages/runtime/src/cloud-sidebar-tools.ts": "c35061be154fd7e2fabccd035ba826f15e63d4f06047f01f4c97a7479e6df753", "packages/runtime/src/cloud-surface-tools.ts": "2d97e4cb5b8a7fc7cfd7815e5e56dc9167467ec5731a39bbf5e0359c15b592ee", "packages/runtime/src/cloud-vault-capture.ts": "a9b87c056b2c43da223413e7d4c90a0f078d6419c0eeb72bbc2055306987aeb3", "packages/runtime/src/cloud-voice-channel.ts": "c905a82dec25f014f604ebc76cec85cc94edcea79dc3ed36b89f71b8529dda71", "packages/runtime/src/memory-tree/compact.ts": "2fd53381634c154e14467cdf67772b1a36eb82b58dbbee417834ee998e8f9437", "scripts/package-coding-guest-agent.test.mjs": "b4205b5cfeda6e08ec16c4d9df450080255ae3d7463fa0fbc7af0d782a500602", "deploy/lxd-runner-guest/harness/package.json": "12224f8d58bd2a950ea6e6c3e24a2f1887bc54b22307fe01532dda4da257bd2c", "packages/cloud-client/src/interface-query.ts": "a6bfeef07bdcebe4d6d75206048a063fc1a3cff1e4790fd754b19cf9d51066b6", "packages/contracts/src/cloud-coding-guest.ts": "70748a337212a603f7e9f1d272810f5107956ba2959a02d0c50ce3a31c63d816", "packages/runtime/kits/object/vendor/three.js": "3a05237cd01bd3725d6155c5c4b584d37fdd737d5a867cd203ab35c6bd6b0c63", "packages/runtime/src/cloud-coding-control.ts": "0b7f09d4d7af40cb601844c2af84b9c07d8f9920b8131f749095f3bd6075426c", "packages/runtime/src/cloud-connector-http.ts": "6eaa861ccde364dbedd86a3ab17359133ec7c379c470b18e027d16e6d4bbe064", "packages/runtime/src/cloud-control-errors.ts": "e94eab04f3afefabd1cdadc5186136b295e77499ee6a4dd0938b649eedefe462", "packages/runtime/src/cloud-folder-reading.ts": "9a32c7a1bf1239757b0d5506205ba9f8b8cb723ca5ff8ad062aa234a459cc875", "packages/runtime/src/cloud-folder-sidebar.ts": "a564e235c9ec079f4fceba7ca89db0f37fc303c7165f34e437ea27d0233664d5", "packages/runtime/src/cloud-folder-workers.ts": "ee044af7a031a0430fdeba2bc59d85bb65874ce4be88c63fdaf35ec7a2acd26f", "packages/runtime/src/cloud-machine-screen.ts": "9185d2be7bd54a90bbfacc6c4ab769674c4a69bae232ef195d07fe89f91dc5af", "packages/runtime/src/cloud-native-failure.ts": "86f9f1eb7919ce8d30ec611fc7711940731997fcdcb33de19c66788e561069a7", "packages/runtime/src/cloud-run-log-folder.ts": "9fd2ba9082ce38a35e473c6076b1d273287bdeab175de5ed177979d4474dc130", "packages/runtime/src/cloud-runner-control.ts": "e75fbf16fbc8d394354adb89005e23fb6843a492e4b17ec8d4068f7bc6c3a354", "packages/runtime/src/cloud-runner-sandbox.ts": "62a184202c73fd54215f10641b625c49b26e3a607796bd6a589e7e0b62a128ec", "packages/runtime/src/cloud-runner-service.ts": "f7d9e46fd17045335e22b4b43ff8e3259fb65655fa8e10e001a5af8166b7772f", "packages/runtime/src/cloud-runtime-bundle.ts": "a1602617a4e53cc126d85b78f4a44ad4c308c5b7c963918c93debf6a8be6cd83", "packages/runtime/src/cloud-runtime-policy.ts": "5d38fe082d4f325c815e69f0b91b7f4f049cb58306befcd78d3351c56963c363", "packages/runtime/src/cloud-surface-images.ts": "f66d42cdfe2a95fcafe4086aa6ce5ddd0314ca8edddffc9d9cd0cb61231c0f63", "packages/runtime/src/lxd-runner-bootstrap.ts": "ac2b8e1a2fe3fd6759de0d9ce0f404bd4f54bbdb0f7d3836a475fe8a9c1b525a", "packages/runtime/src/memory-tree/run-work.ts": "adc7a252b0f4856b7ee9a3515b38c57cdbd1b59c37963cab8db51d5f7d7dad27", "deploy/claude-box/qorpera-claude-box-stage.sh": "e414a21dbd9b87d5cd005fd1a18dd18a2cb3ee3911e6599b1a31fac034e9e1ca", "packages/cloud-client/src/cloud-file-bytes.ts": "a78b519d2034593546234c4bfa1ab377964551619d4c3c21084da3099602edb8", "packages/cloud-client/src/cloud-skill-file.ts": "407ede938b61df4f8e298da469c006404cb5bdbbaf69ba0fae4314fd0774016e", "packages/cloud-client/src/memory-run-files.ts": "e26d82e574a72d7ee3297deee8d6cb53ea3aaa56111f20ae929366398f7920a5", "packages/cloud-client/src/staff-characters.ts": "2378c657a62f6a06f1c7bc30160517cb36d0330e338fa77b0460b049f65aa7c6", "packages/runner-orchestrator/src/code-host.ts": "08311587307a1e239d86ca44d08e7d1b5c2b7da709c32e3239c79846405e3d70", "packages/runner-orchestrator/src/code-site.ts": "cd968f5d76d9b3f7aad32726eacf990a8aa9fbc5fa4a9fce8b6fe8b7d29f6051", "packages/runner-orchestrator/src/coding-vm.ts": "df72b6b4cabeaf06fc3caae2ed70fcd34c4590f48376f258c4b3c82f3d3d0d20", "packages/runtime/src/cloud-app-kit-program.ts": "2ceb9c0d25b6180e4b39f06d53714c0ecced32a888724b2468cae854e7fba5fe", "packages/runtime/src/cloud-coding-watchdog.ts": "a472ef690c7d273d96255b6c18a90f6113d6d243e31f7b7d7c924e283c8d1027", "packages/runtime/src/cloud-connector-oauth.ts": "2d958d0e6bcac25cd7f3605ac11a653aa2d502f1ae47a2a1f30bf70d0aef3a62", "packages/runtime/src/cloud-embedded-assets.ts": "b789addc56217fd91590edcaf56423879e48b46fc51207ab78cc3b59d3b5e4f8", "packages/runtime/src/cloud-folder-routines.ts": "c076349fac902e547d821128b6e5969ad7cbfd06f0ac2e6f13e6b2e6208de6fb", "packages/runtime/src/cloud-good-will-tools.ts": "59e552e55a263e485f36b706d8f32097612b584391b4662d30d1f06adc3276b6", "packages/runtime/src/cloud-http-server-kit.ts": "085d209d935efc1e6483deac5183470aed96345b48719fe348c54f901c0ea9db", "packages/runtime/src/cloud-native-provider.ts": "d0a1becde1e029f3dbfb3ec6fdace255a31f19be006e29b2d9ec3b1352d46c35", "packages/runtime/src/cloud-picture-channel.ts": "9d91386f001163b2646439e85b2fc62a46745c3778c2b040aa8e698826174764", "packages/runtime/src/cloud-platform-skills.ts": "49136fac803f3643dcc3cb454caff9e93200175fe74db447d528273dbf192928", "packages/runtime/src/digital-post-pdf-text.ts": "a49a7fec81548adcb2e035a3f61a67fa5a2e36c88a637528385dc9d4ecba4d2a", "packages/runtime/src/native-provider-usage.ts": "25a89a2499aa9a0886534f22c1c4316ac47070e1088e51c2ccdcf57eecc8ceec", "deploy/coding-worker/home-session-authority.ts": "0267255b9164f7b94e189f4db92ccb28a72eda6eb8b7fa98f9db17b37dd934dd", "deploy/coding-worker/repository-credentials.ts": "618c4188ee507130fdaebe37d12081784e589004465745c86a6b0148aeaf8d05", "packages/cloud-client/src/cloud-member-data.ts": "871292c558c524c157b2a74d61a95c68cfe70078073a35db002d9b0d5a21d6c4", "packages/cloud-client/src/cloud-tool-result.ts": "4efd622f934871114268d9ac8932fb133d68045b464c2161c52a7dec7556bd5c", "packages/cloud-client/src/interface-library.ts": "1aaa4abf27dc7874689861a6e713cbf4dfba47e483235b1e54cc9bfe7d09382e", "packages/contracts/src/cloud-coding-command.ts": "60e12a995bf0a25381d8b4be711cd01b79add23a6d8017cf1fed832ced55cb04", "packages/contracts/src/cloud-coding-session.ts": "84e888803d953f8da943e11f9829e445074c5e11b7986d3b04acae1d0fb1340a", "packages/contracts/src/cloud-coding-storage.ts": "e8900813832fa81980d212bceece5f7802ca5ecb22a0bb2b0c03da64b68aa0c8", "packages/runner-orchestrator/src/agent-plug.ts": "637c0d3498f20aa41d9e41a6eb8e97175ca1ccbac8e78feee684ad372432e32d", "packages/runner-orchestrator/src/code-words.ts": "7ab78f2c00a603f63d4fea90dd49c86952d98bbe8fdf4834fa14157bdf250bff", "packages/runner-orchestrator/src/coding-git.ts": "635cae0c907631d48529c5346e7e04f63205b3ef75f2ed97ee18fe1582e635bf", "packages/runner-orchestrator/src/lxd-client.ts": "36fb67b62c9eec2995570e7d9d271b6da754b55e16b21b0e8cfbe088ee8e26ae", "packages/runtime/kits/explainer/voice-peer.cjs": "9bc76604ebe4f1d92f2d00a5256565972aa42e209cb13942d9d8c2006004cac1", "packages/runtime/src/cloud-app-narrate-tool.ts": "b046c8714464122c119bbab06c486e8e8f1d0e408529316c8bc99a4c127e923a", "packages/runtime/src/cloud-coding-git-guest.ts": "b81f17c7a2ade58b645f3dccda080df0a9d96bf65b220226989316da838dff6e", "packages/runtime/src/cloud-command-page-fit.ts": "371893972087926f27bb30e2367fb28fd17cd6e97c8f9e0c24b5522246b8972a", "packages/runtime/src/cloud-company-accounts.ts": "ccb6e1d209c54bbb15bee21ace0f5ad1ffae496c3a2cd90bfd012b91c52d560a", "packages/runtime/src/cloud-connector-github.ts": "a859c8366e3f8504171013e79ea2c6f63d7e3c5cce21f9a0cf4637af44512400", "packages/runtime/src/cloud-connector-google.ts": "c01576be9c179a021edfd81d6e7f160754eff6e32446c8dcb23915756f65a651", "packages/runtime/src/cloud-event-hook-vault.ts": "82d68fff4bdead216bbadd62917fd96f18543b13f34e146103dcd17a2f03c461", "packages/runtime/src/cloud-folder-app-tools.ts": "93a1a571429dd15a227f240d3f1e423646cf55db54d56950496aa4ed8f566edb", "packages/runtime/src/cloud-folder-cache-dir.ts": "e5dd8146254c4df7416ef5f8557c3b3dc3f55e8457ea092f62fc636d03c2df5c", "packages/runtime/src/cloud-folder-notebooks.ts": "68ceb447a1bd15ae1b3813a4bab2ac88dfbf56e1d5e662a5010a4ab6296bb310", "packages/runtime/src/cloud-folder-proposals.ts": "5e9ad6f522d5d70e51348a4ee756fd1fb2cc11b0db30dd2929364fa1a5f43637", "packages/runtime/src/cloud-gemini-key-vault.ts": "edbb13051b88845a5465e05ba527b42a620233d5c85f89fabc267a59f4139f79", "packages/runtime/src/cloud-native-isolation.ts": "fbbf9653791dbc162a0d494e5b742c93a2de76fb4628e1b771dfe2d3595e2884", "packages/runtime/src/cloud-platform-updates.ts": "4dc4c60b7392cfacbcc4af145852b394caf579ac1b284e502612dff325b3a136", "packages/runtime/src/cloud-runner-container.ts": "00ea916f189c1d892153a5afaaaf38145e232d425b202b5e5470f6593cd25da6", "packages/runtime/src/memory-tree/step-lines.ts": "fbee6a7c3f2ed82536f16cd54dcd5c1172bf1970d4166ce52410ed6a724e012a", "deploy/coding-worker/machine-command-routing.ts": "840276f237c46659f99bc19e359ae5bf445726d12f468e40546083403efe8d45", "packages/cloud-client/src/cloud-agent-folder.ts": "934e98cb47f8a49b4d7b7a93744f74eaee2947c0e30679ea8e0e90bebb9fb88d", "packages/cloud-client/src/cloud-runner-model.ts": "042dae5bfdad0f9b251253983c11fccee3d357f4232f162e3fda1dd6f8277aed", "packages/cloud-client/src/cloud-runner-usage.ts": "3d54acf56c1c5dc8db2ad42d71967c98236f07c154b9f73cee7f9af874facef6", "packages/cloud-client/src/staff-template-ids.ts": "d20c8238a569ba49f0ae22a28140ef9319bfa196e41474c39e8f73aec02bdc05", "packages/contracts/src/surface-shared-assets.ts": "822ce76f3ece5210de22745c8184d916906a10bdfb6c2983c631aba1b0154f39", "packages/runner-orchestrator/src/abort-scope.ts": "24c0f38252a0b2d7b113499601c6224a38321edcb82127707044d39587599bf9", "packages/runner-orchestrator/src/code-checks.ts": "40493b82b91e20f8ef75957d6793ba07ebbb0d786da8332c834810897e9b5b20", "packages/runner-orchestrator/src/code-import.ts": "63ecbf308d5a25933db951d7c0946ca781585f2cca7b6a62e4f390ade75752e8", "packages/runtime/skills/custom-surface/SKILL.md": "bdbb80e872124327dcfc66f332765609ff4cad623e49a507c5f2927617ee0716", "packages/runtime/skills/product-studio/SKILL.md": "b55abcdb13a63543593d7960faf4be8f16f50644a576e28c49445c7811e4e644", "packages/runtime/src/cloud-app-kit-explainer.ts": "5e36052292dbd4bde681020fe3191c32d505fe19e17a989d135c630908f3ba62", "packages/runtime/src/cloud-claude-home-shell.ts": "2aa487869b1ac2e84b9c63c383677bf9b908648182a8be7c4a433163a4d9e627", "packages/runtime/src/cloud-coding-error-code.ts": "000163fc98771b058c6b5b0d478085dd0b8822b183da1e83c5857a89628201b4", "packages/runtime/src/cloud-connector-adapter.ts": "ef194cf4e28d0581ca639dc11f69eefde3695c8da56775aecfa62714c1949e09", "packages/runtime/src/cloud-connector-catalog.ts": "b8ec122269829d3454d4b3adbecb850a7323d61c097771b14c8794ed3916745c", "packages/runtime/src/cloud-connector-service.ts": "5e77f434142f9ea7c183dceb1f2b0abed37ca0b6baeb9fb2c4037199ab454cf8", "packages/runtime/src/cloud-digital-post-sync.ts": "ca92650200479c92abb5edd5a20961584178d4c4191e93e720e1b103cc43154e", "packages/runtime/src/cloud-folder-app-groups.ts": "f81eecbb95937696f36bd2ee55d85b14647fc2dc34b62ad93e8d5d9eea90e341", "packages/runtime/src/cloud-folder-file-tools.ts": "8cdf9dacd7acbbddc49e3de256007fb03308042c3aea363cc6eacbe252b0c2ee", "packages/runtime/src/cloud-identity-recovery.ts": "1badfc2f38cb32af9ccde8ff9e2271cca0168cf9d1608961e917202608760c88", "packages/runtime/src/cloud-model-login-vault.ts": "d217db49110bebde236484a48169fcbdf5339d22c467b7ba26bb076555a31809", "packages/runtime/src/cloud-review-rule-tools.ts": "fac9ce624cfa50a809d7d2129f894597606bb85c2465f360ae1bf83f0320f7dd", "packages/runtime/src/lxd-guest-image-updates.ts": "e26ea2cf52158b08e28154fea0e75df1807113f7cdd42b17b951cdd62efe4947", "packages/runtime/src/native-provider-account.ts": "1bab05c1f06759927ed4696d4310eb17319570d567446043582cd150e94f60d2", "deploy/claude-box/qorpera-claude-box-ns.apparmor": "600638f776a8d2687b2ceab43ec228bf98c245ade07a691314f6890a2416bddf", "packages/cloud-client/src/company-path-schema.ts": "fcb79875252f302b30f7ba12c9bcdb1a497823b5f44b1bcccfd9c02dded10953", "packages/cloud-client/src/company-state-files.ts": "26e35274ea55bfa54e4ea861ecad9e3e3f88fca29b4f6557b85075289a77a6f5", "packages/cloud-client/src/presence-signatures.ts": "1f53ed9435bff1a0f55607be093c04fac23f22cc751d5e60fbe8c2348b43c23d", "packages/runner-orchestrator/src/coding-setup.ts": "8c23b70e97d2c9d06276321338021253f8d695db3ecd2e6ce32a0d226c807ac4", "packages/runner-orchestrator/src/orchestrator.ts": "1c4466926bd71691f7cb9c2012c3b9ebc2c7412edfe1f5196f5b15b856f6774b", "packages/runtime/kits/explainer/voice-encode.cjs": "267e6d50884bbfe55ffdd12a566a10cbc1a33460c4a86b7a38ec8c47e9f025b4", "packages/runtime/skills/identity-studio/SKILL.md": "454d7f70b7e8c546583cdd03952808ab05b2c8aca08285dbac04b2ecfeac9b11", "packages/runtime/src/cloud-claude-home-review.ts": "1508b43eab23c3274aa3bba569343c0e8bb4be0a89a820658d502c9456903f3d", "packages/runtime/src/cloud-claude-login-usage.ts": "1c0849b97b4edbfab4f04056a78a8c6dcbd1927627bca09549927096dc4e7db1", "packages/runtime/src/cloud-claude-login-vault.ts": "7b8a9689e55f143c1ba6db04b097bbadf12e2ea91ed1fc7726cb709eb5cf21c7", "packages/runtime/src/cloud-codex-tool-session.ts": "da9eeb39365ad18feb1dabdd060a844c3dea209168cd66b8c29c10286d9e421e", "packages/runtime/src/cloud-coding-command-log.ts": "eb475c9efc3e0fbffea93d5eb3999efdb9d8e1f86e1bf82628a7b22739beb127", "packages/runtime/src/cloud-coding-guest-agent.ts": "b8e040c41e231e486c8ee0cdcc0e163b9ece4a016f71aa60a355e349acce1a06", "packages/runtime/src/cloud-coding-value-names.ts": "0af677bad467e91c6ff9b7f31b003128be232b760f8ae3c9a26c6edde7184ec4", "packages/runtime/src/cloud-coding-value-vault.ts": "3c4bb27da3274b4c306a9a2ffa4593f909ea4acdb0a17798a98ecebd55195b61", "packages/runtime/src/cloud-event-verification.ts": "959d1c3c6287874e63bc1fc44bffd759ab49c3c1a1cf51d086acd3c53f245b0c", "packages/runtime/src/cloud-folder-app-retired.ts": "b2458b901abb32b9f05cb37f706c13f5aeb961bff3d944a0ca3ebaf7dedaf581", "packages/runtime/src/cloud-folder-group-chats.ts": "b25257f2c2d35e63770e0b7061805317608895dc62499ce51ddaaa81ef8ca4bb", "packages/runtime/src/cloud-folder-search-tool.ts": "5d5add42f09449f44174a2e5b8ff70752272a271fd6e9cc3bc191a909025a2a2", "packages/runtime/src/cloud-member-offer-tools.ts": "bbac5875c24187874775daf72bfae1a0f19b74da89a439e8e5e81f6e798eacc9", "packages/runtime/src/cloud-model-login-budget.ts": "20651a72f57aad394810aac81f70accb2d5fee91c6143c33c8e1cff307ecee34", "packages/runtime/src/cloud-model-login-helper.ts": "ff19fdc5bc0053633411451347c92a013bf91f455edcdce5cc1e5db8f46c5522", "packages/runtime/src/cloud-model-login-upkeep.ts": "06e3114d5f90435f7cb8efe8f2969b8ee85fcb6db4d17aa59f45a470390ba174", "packages/runtime/src/cloud-run-log-protection.ts": "36c4c8466383678e22b5a2fec963a246b1224ed41dc3c92b039fec3173dfcf9a", "packages/runtime/src/cloud-secret-broker-http.ts": "872510f377af432ed65837dbc7d26b539246479c41fa8316bdbc31d979408427", "deploy/coding-worker/machine-command-authority.ts": "ea0d5364d932340078c9212194f1c4c612af3a87338072a229b9cdb5dce22198", "deploy/lxd-runner-guest/harness/package-lock.json": "a21bc332bb85402ef0bed2819030572438e28489f0fb28bda77d6e3bc86c6b03", "deploy/lxd-runner-guest/install-image-contract.sh": "e015461dae89d41f42e2bf91c1552cf0b846ab27f24b92eb8f90198c971a5a9d", "packages/cloud-client/src/company-state-shared.ts": "70b91f06b8925ea4b723856337df6502d3abfe0b322a4c12a1ea13e5e8233073", "packages/cloud-client/src/surface-folder-files.ts": "50331756880a3e8e15f480b981fa9df6a29e4434918f2331331bcc85b0170a52", "packages/runner-orchestrator/src/provider-http.ts": "ec7332f72c58c9cbc95bb98fb060b26622304ce0f630932ad788ecb41859ffff", "packages/runtime/src/cloud-claude-login-reader.ts": "9ac6c93175dcde35561edead5eeed473b976c61bea412e2d4db7fb856e6e1341", "packages/runtime/src/cloud-claude-picture-lane.ts": "eca5c96a2a62aa2880d37b990324ac2936a29a6df5655790e6794812c6f46851", "packages/runtime/src/cloud-coding-command-http.ts": "c8d75a327bf0b0a2ab5ede8e7e9429afb0c0fb3564e2466b21c65db1e4f6da15", "packages/runtime/src/cloud-coding-picture-tool.ts": "6cac0555dfba6645eb6f9f0aa89399f7f968b34e57b64a7b11d551776ec6cd95", "packages/runtime/src/cloud-folder-picture-tool.ts": "0427eabf9fb73a06be7b42f5430cc0dc8b2d3ca49e4246baf70d7f31c2679f44", "packages/runtime/src/cloud-gemini-tool-session.ts": "0bd148c30b98f21348e363a9d4bb4c18164488323f6eb0270b86bb9ca49df251", "packages/runtime/src/cloud-home-channel-client.ts": "eb80936fdf60f58c81f279c5c9e9e76866e3c8b26f7618b9a9ba9a93f5f0013e", "packages/runtime/src/cloud-model-login-sign-in.ts": "f9c20e1b937234541c2a9b5dd2d7a3929432fbe1d00d8d75b7050e41d6d526eb", "packages/runtime/src/cloud-native-result-fence.ts": "861dd95163c2971f3e81a39115a023fcd4962d3c0d25aedf33221ab08f1c565d", "packages/runtime/src/cloud-runner-model-socket.ts": "efe87179c6ac79e1f57757f12efe81a650ada29e5c4e1577ac1de5e735ec2cf2", "packages/runtime/src/cloud-runner-service-main.ts": "b8c8a8d4cd2bb0bba08c684fa88fa4fcd044dba03b0381c59c42dbbf8cf2eeb6", "packages/runtime/src/cloud-runner-worker-state.ts": "4aa098c0c8a213f462d673a2174c1848217dec2132145c0e3eeb4be3041378cb", "packages/runtime/src/cloud-secret-broker-relay.ts": "028e4bff9fc7f00ae60c6f6188b817f37bace65ae85c8f58127e44834ad3d5e2", "packages/runtime/src/cloud-thread-interactions.ts": "fae68889d822f3f65086bac244724edd0c7a1609b94478c66dd5573468facdcd", "packages/runtime/src/digital-post-letter-files.ts": "5f9bfd3d9fa2b16d47f0c9a18064444a6856a031842dcfbd5fbf9f49dd228b7a", "packages/runtime/src/lxd-runner-bootstrap-main.ts": "94fb6c6d97ef2deae6284f88a3e33f46705a5dd0da426328364a98f9ad63fc6c", "deploy/coding-worker/qorpera-coding-watchdog.timer": "8af66d8d59c55f9b3e5f5f251010f66de1da844b4c2259e53e82859f2977d6ff", "deploy/coding-worker/qorpera_desktop_streams.slice": "df976df86a5ad2a79fd67e964eb2bbceb24562977972bc277c92cbcdbddae452", "deploy/lxd-runner-guest/runner-image-contract.json": "fb0bc315f357ba16220f729ca2810a2ae8ba9299bf9765daed02a52a9f3c8f38", "packages/cloud-client/src/company-path-presence.ts": "fbe10f6afb119038e8c8aa00f3838b07fceda2e47b8fab21784e5a7722f4fc1b", "packages/cloud-client/src/native-provider-login.ts": "fbe64311ab033239b82ccb32efdf76f61b55124c19b92aec945fa2bc387d0f98", "packages/runner-orchestrator/src/code-host-care.ts": "efe8d6b1b29f94695f04ec905595f3c6173a6f5d3e906ca3d1eab137ca0334eb", "packages/runner-orchestrator/src/code-host-jobs.ts": "ca9cff388faaea8022b20924a2e6816fe7b3062a2b03c1bedab71d95854d527b", "packages/runner-orchestrator/src/code-host-seed.ts": "a94a5fa30ef8b2ffea341774203b82f973881d4963572a8b6858a22f2e1c0469", "packages/runner-orchestrator/src/coding-machine.ts": "ddbe310597fe3ccdd579733155e31f634377c3e22d157418be97374f12ecf058", "packages/runner-orchestrator/src/coding-storage.ts": "58cb71b829ba67bfc2ce641ba8ad3821ab55efd4938cb6c0cb5adf17a8925369", "packages/runner-orchestrator/src/folder-control.ts": "611bcba0043701ac888251097f85535c528efb3201b691fd543096b7f237f994", "packages/runner-orchestrator/src/http-transport.ts": "42e1799012203362e77d32df944ab01063e0033dfc50ca2606ae76edec2b54dd", "packages/runner-orchestrator/src/node-websocket.ts": "c7dd4f7d22c5c18e76c71cb08e1b1e66eff320a81f4bf061a57899475e6fe474", "packages/runtime/kits/explainer/voice-captions.cjs": "95ebab6303abb8bbb9e120f2b522295cd034dd770ad534eec3e9244ea71edf67", "packages/runtime/src/cloud-chatgpt-plan-sign-in.ts": "e0362c3bc6fe19e98f6aa1aafe6d2f4c0460ffa7833b8e78b0a24e2fe5c0e2da", "packages/runtime/src/cloud-claude-login-renewal.ts": "dffd5148f67cb5fd43fbb978ba819f1d183ed37a48c54345893feee8eb87ac40", "packages/runtime/src/cloud-coding-command-guest.ts": "3397314ea3f0b3a472f524225091e4baea8567ac17eb61319d2bb4e547f63af8", "packages/runtime/src/cloud-coding-command-tools.ts": "36eba9e61630cad0e5f45e997bd799110fa07ef457d6aa9e680ef06e12ec740e", "packages/runtime/src/cloud-coding-image-inspect.ts": "5543c3802329bb486ddb564dbf61e25d495d6a548e3191fcccf96ba34f5e5352", "packages/runtime/src/cloud-coding-session-guest.ts": "99611400a500a009fa952d87c8718cd73969a74ae76da244a95d31775478f096", "packages/runtime/src/cloud-coding-storage-guest.ts": "289ca199d1cc40f046053366b2dc36e9b0ea513b56334832cb06df770e219fd0", "packages/runtime/src/cloud-coding-watchdog-main.ts": "133a4bae02618eb44c7ae9b5f68214daf54b75b7c4a9192e8a88fa27782c2ebe", "packages/runtime/src/cloud-company-folder-bytes.ts": "ff14bcb3f3a154cda6f962cf8c982f018a58a4b78ed5c521ba61da212287e2d1", "packages/runtime/src/cloud-company-path-control.ts": "03ec46335b96c81115983db4fb19528c7e6d2e111fbcd4feb4593f3a16c84c3c", "packages/runtime/src/cloud-company-path-gateway.ts": "5b2f528ba4d9e24dffbc30453e13fa16b13c63595e90d5db170479a5be7f71d0", "packages/runtime/src/cloud-company-path-refusal.ts": "510c0e7838769ec9eeec8f11789eced42675ed5b3f1aae3135256ce3f858b5fe", "packages/runtime/src/cloud-machine-account-fill.ts": "a2b8cb780b2bd0ad0e0a58c936a7f0a1e65b959e017e9ef21841f9f2845924b4", "packages/runtime/src/cloud-machine-coding-value.ts": "7b503cd3a06bdb94c01926be6827d8d35fd364f749a11efbde4b6c3c498c6d4c", "packages/runtime/src/cloud-machine-command-http.ts": "f9097906eed7a6eae40cd4e6e76d57133da33c7296cd008e16eb0d1a7e1ef96b", "packages/runtime/src/cloud-native-host-dispatch.ts": "d9c4d4d3f19cbe3335aea7c06a8dff4b3af27fe50c9cb81ff70a83206066b722", "packages/runtime/src/cloud-native-provider-host.ts": "7c5980bd6d0a12c501cec773e016e8618429e05c16bf1eac6fb392c24132706a", "packages/runtime/src/cloud-native-tool-boundary.ts": "e3bcfb9349e01a8b9d8695115ed916bfeb8920c0b90f7b86409cd92b7e6326d3", "packages/runtime/src/cloud-runtime-constitution.ts": "0dfd88d13cbd3e62e7dad41ea850ddf495fac3a3c2450c5b9a8dc093d2204908", "packages/runtime/src/cloud-secret-broker-shared.ts": "0d8d2aa2fba9cb9a1adbf5a8bb175aba96d1a49c0f4362a56fe6fc6dcab95d80", "packages/runtime/src/cloud-surface-narrate-tool.ts": "f610736fad1f513689b9b8a717e8a0a8f11651aaa77ffe679e5545299ac3e5e8", "packages/runtime/src/cloud-surface-turn-context.ts": "a66a6658c3daa9528da7dbdaf99872af96330f1273d1bffc8fcadd33a83f5dc1", "deploy/coding-worker/machine-account-fill-broker.ts": "5344ade194d5da755c56ba795893b95601819573b4625eb598d7b48bfb496607", "deploy/coding-worker/qorpera-coding-forward.service": "72835658895861af33592c9d35ffea53466788cf70fc03f837f36890a0942144", "packages/cloud-client/src/native-account-refresh.ts": "a84095c1907e2dc17c717f1d30fb5c48ae47b7c317a57721245620dd82be0bc5", "packages/cloud-client/src/surface-studio-patches.ts": "41a780284714e8f6e209c0e0754e996474008b4852d48c9e5fd50d84acac89dc", "packages/runner-orchestrator/src/code-host-sites.ts": "a4cfd1e7cf27515a18383d2de31c2e50a841b919681a14ebfcf3bce3534f6b4f", "packages/runner-orchestrator/src/code-host-views.ts": "d8519fcf8deb68154be8f02ddc56151091f8e5041f3fc09f99d94f9e40d8f242", "packages/runner-orchestrator/src/code-import-run.ts": "53e3cf70bf752bd904e78e720f52280956e3d293ff09bd94da1ca1dce76fd45c", "packages/runner-orchestrator/src/coding-executor.ts": "6f06897f870c66fc589597574fdbd32368400202be8a801e84380cea92aadf12", "packages/runner-orchestrator/src/coding-git-seed.ts": "1289aff1514c43263b609dfe8e934d20e556454f320fb1a3248ce9fd7a4686cc", "packages/runner-orchestrator/src/company-machine.ts": "35dcba322f2d88e2091b8b2ab504a7f0d6ca65e6b120d97d58dd74a5ed81a64a", "packages/runner-orchestrator/src/lxd-proc-uptime.ts": "1a99aea9cfb148307ffdfa542f5a96d4f01828839b86bf242629ba7eaaa2457f", "packages/runtime/src/cloud-coding-preflight-land.ts": "681c3b26714d0089ad69c6d09c18ab8fbde31add321b1df7f5d63cd9c3630d58", "packages/runtime/src/cloud-company-account-tools.ts": "04900a41c5838f7910771d5fa6e14d56957bfbdac3426a78e0fa18242c770864", "packages/runtime/src/cloud-company-account-vault.ts": "87424c889831b30d3e5a77889cad9aa7d3cd431f3143f5f5330798e54c3b556c", "packages/runtime/src/cloud-company-folder-client.ts": "50b40a775187c95a43485980de8512d87b2191749d9b0d35aa52667db26a3fdb", "packages/runtime/src/cloud-company-path-presence.ts": "ff749f764e3986b35cd253f645f1779e3f49137b6bf658037c1dbf5caac29b73", "packages/runtime/src/cloud-machine-script-review.ts": "9f9e518dce53892f676a2393a51094868077df7680f070b883d22c1e63c5b69c", "packages/runtime/src/cloud-native-capture-images.ts": "063fa3a75d4ac35298075795462abdbb0c3820e3ca3506749a278b8fb03cea21", "packages/runtime/src/cloud-native-coding-runtime.ts": "4d112d8411e65cbf25ba9e056beef1163ad331a4e030116971804a8a1c51abbe", "packages/runtime/src/cloud-native-company-runner.ts": "ebb0eba266926089470ec0dfe4be5708cf1e906fc6dcca6b721c0834d069e701", "packages/runtime/src/cloud-native-tool-authority.ts": "74ce43e2da0b186f7c60f1cf0775e26c4ddc38679d3b68282a9c4527e6b19f07", "packages/runtime/src/cloud-runner-container-main.ts": "dbd53c4c604ed03162b603236a646b984cb1d338eb00467d46fdd3bcfd7cb36b", "packages/runtime/src/cloud-runtime-hire-overlays.ts": "14387291584d30eff68040a8d50fc7099bff56576dc3d1ecf888f52c4b877ea8", "packages/runtime/src/cloud-runtime-observability.ts": "af52bb6d000f0ff71c08449c51b9708b2dcebb6e225ef069322aa47c99dc817b", "deploy/coding-worker/command-guest-installation.json": "58f63d281790fa1e61897ebd892e0a69816d260722356b978391a42950220a45", "deploy/coding-worker/qorpera-coding-executor.service": "0dd2fe5c3cb33bd6c34e3e05da8bc8c4c3c2ebe5cf76c22a7c78079a71e9dd46", "deploy/coding-worker/qorpera-coding-watchdog.service": "b5974cdfa37f7d4373a79646792d9858da362aa3013bd34f3163f7207dd0b052", "deploy/coding-worker/qorpera-desktop-stream@.service": "cd68601059657f5446f96cc8f83cbbca871501c432f5db8cdbdeefe13e64be77", "packages/cloud-client/src/node/cloud-object-store.ts": "bbabf1b744e2039a13aeaba7fb064cf30f54f293f5342f1304abd9860800f20f", "packages/runner-orchestrator/src/code-host-import.ts": "66ace840571a068ee2e74aa32a079496f7c1aec024b9466e8391b24f1a4d13e0", "packages/runner-orchestrator/src/coding-snapshots.ts": "26f1f358eb0823dcfaddf664aafff39b931ae9420981ee20ffb1bcc70a02aacc", "packages/runner-orchestrator/src/coding-workspace.ts": "a52d7d4b2ca9dcf700ed5fef516ddeaa7218d6bb4cdbb86f27420fc6d1d79880", "packages/runner-orchestrator/src/site-blob-upload.ts": "00cc865debf90ca3ec51e9354cb464a853de06e4aaec155bdb4383363112adc1", "packages/runtime/src/cloud-claude-picture-command.ts": "7e17f3ad46693c695e7c7f71f978f2892036fcbde6557bc760deab54bc543a55", "packages/runtime/src/cloud-connector-digital-post.ts": "0bb9877ddb21031557f09812fd78086e80f4782e886eb2b9bc42b930100d1be4", "packages/runtime/src/cloud-event-hook-capture-box.ts": "53df14ac167c9ab51923e4d04e9c40e5b44c06474eed07b3ceae438a285b57cd", "packages/runtime/src/cloud-folder-interface-tools.ts": "f49fab6505c45542f05151c4f362260894afd2b541e49e302bdeeaedacb4166f", "packages/runtime/src/cloud-native-company-context.ts": "cf3cd13486154062378fbe0f8ed5d8f040d1c9531ceb47a716abe979ca62ce38", "packages/runtime/src/cloud-native-company-runtime.ts": "81de10fcd686d5d915cd857d9789df61a03cf69bcbbc8aac50422ff04133f3b6", "packages/runtime/src/cloud-native-isolation-child.ts": "fe3adea0c110e07217c3b7f474f991818c84888b6a5d14b17d8fa754e7166445", "packages/runtime/src/cloud-native-tool-operations.ts": "404ba68323949db679a073ceeb486df3e449b14ac6a985e2bf26875db7ef7f81", "packages/runtime/src/cloud-native-tools-on-demand.ts": "7f972896c7ff6174d0e07d09c8c11eb2da8a93ba781eeaaf959a3de351316379", "packages/runtime/src/cloud-surface-session-runner.ts": "9955209f95d851c296ac30f65801b7f9eb711873a205e615a1d8ce305b5e8ded", "packages/runtime/src/cloud-vault-database-failure.ts": "58abc3e1d497ecd7938e2613fd0dc1e5468214aa3f65b74262730c2c52f5b52a", "packages/runner-orchestrator/src/app-auto-redeploy.ts": "9f9f6923ed1ee07a03c299dca857b94f669936f709852487737c780258278643", "packages/runner-orchestrator/src/code-bundle-store.ts": "875a5989c982207381eea237c455af65b964b02587e06eeb4dc9056082173fcb", "packages/runner-orchestrator/src/code-folder-names.ts": "13d6831beffc44abedec08c3d0ffd37c91afe3626d309d9bc0852bf26b502a16", "packages/runner-orchestrator/src/code-host-restore.ts": "d837ed3acfc2a97a093903c4bfa3427ca65ca8730485fe1fc26a5456d5266199", "packages/runner-orchestrator/src/code-import-fetch.ts": "953e1aa95d51b2daffa1e4ab635efbf86beafdaf3b477e6e3a9c602bfa6d259c", "packages/runner-orchestrator/src/code-site-uploads.ts": "b6cf7e007915f596676e68b91a16b50c5eefc4667a1bfe272cde8d1b72825c14", "packages/runner-orchestrator/src/coding-host-lease.ts": "0f4c8346ea35cb34d13a33de15b0727867b0b23c66e1c027b1441e8a554469d6", "packages/runner-orchestrator/src/lxd-guest-network.ts": "21bacff10ad32d0af12dd2535a364aba49449e17b9c5e3a436c6b5437e3023c8", "packages/runner-orchestrator/src/orchestrator-wake.ts": "411081bbb59e4b452bd560aa7dc5d4554a99a9994290139ae1b06d01cadce2a8", "packages/runtime/kits/object/vendor/three.LICENSE.txt": "8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc", "packages/runtime/src/cloud-folder-interface-writes.ts": "ff42bd7a645dc054db67e0f6dceaff8846b540abb850191f58f5b0deb6fccc62", "packages/runtime/src/cloud-folder-routine-decision.ts": "606e724aa50a7df4c87995b8b4f2acfd86d199acc88cac9f119754aa43b673ba", "packages/runtime/src/cloud-identity-recovery-guest.ts": "fefaad029108c3d80d1b57c1e5626ebbe68c22209c3a0dfce73777c2182ea335", "packages/runtime/src/cloud-identity-recovery-store.ts": "5503ef03f137387e27fd25ca781c959ec75cae4a8b5826314d25be49224493a1", "packages/runtime/src/cloud-model-login-vault-usage.ts": "c282702d25794907ec7bb2d64622e89dd61eeb62c63e01ca23365e04dabe2d36", "packages/runtime/src/cloud-native-provider-service.ts": "a971521c7ec2dd1e88b9c3e2dc9d14ec22a734233edc7993b50e070999058cf3", "packages/runtime/src/cloud-native-run-tool-session.ts": "cd0dbaea8be41f17e64d1ffabdeef75ee645bcfcd5337941b3b69d87e39b4e25", "packages/runtime/src/cloud-runner-assignment-inbox.ts": "dbc5067d8b7943608a4150eaf8682f3dc2e30eeb86fb2018936e775c7d3f59c3", "packages/runtime/src/cloud-surface-preview-overlay.ts": "5a568cb88a29b572eda7a99e9a0167b8f379518c724c665d7cc828cef52dfd46", "deploy/first-node/native-codex/linux-x64-artifact.json": "117a5f2e6faca21a4cab044c5b35fd53cfe4e928bb60c9bfb45d4f0f43ba6894", "deploy/lxd-runner-guest/qorpera-company-runner.service": "fad32c3dea9d211b9822535b93cd93f88e3028992f73006f7efd633d21da1fb8", "packages/runner-orchestrator/src/code-host-requests.ts": "6e5f6816763d55ff272110b648e98c6890fd3d708e33ffdd37fd2bd6a7512d95", "packages/runner-orchestrator/src/code-host-surfaces.ts": "a96c98b447e8eec110c1de9650cdbd77a58d907f832194da84ad5f85fef0603d", "packages/runner-orchestrator/src/coding-git-sandbox.ts": "0d2dfcbe3cd8723a3c56f954bc9dbe233328e1f20964013c86c7fd23ca594d26", "packages/runner-orchestrator/src/coding-secret-mask.ts": "03f12e5b7176b17cf6284171ca16af34f33e55f71b809a065afd5cab8300cfa6", "packages/runner-orchestrator/src/routine-check-gate.ts": "aa0861d6505c2b7cb28eebd46401576a0aa140683c4296358face357bd1e88c0", "packages/runtime/src/cloud-claude-home-shell-client.ts": "d56facee2e631199ba93eb0ee509a0be9e8fe343bb9b9fc0beca0442f4abde32", "packages/runtime/src/cloud-coding-guest-observation.ts": "df9ccb59c47efd826541a16d969c30c35139c8456806ce4194b46582b09a1f64", "packages/runtime/src/cloud-coding-value-capture-box.ts": "c04d7977f65fd03a1bbd480af93e842a3242138e9137a9874c78e73171272117", "packages/runtime/src/cloud-company-account-fill-box.ts": "bc5f66a3c3dc7d426cf78570bed09a64f582b285fba866be0c73bbca7fbcaebf", "packages/runtime/src/cloud-connector-enable-banking.ts": "adfe8583bcfb5f997d88d25ad1456f0cb1818b68a1a952a8d9f4b9bf7721a94e", "packages/runtime/src/cloud-identity-recovery-config.ts": "9062b21e8d90bec1edb658595f43384f641fe67bb08167d0fb88bc3e82c442de", "packages/runtime/src/cloud-identity-recovery-crypto.ts": "736b33275300369f3bbf5386e3ba971ec5db9ffed13154762dd7a2c9ef73b185", "deploy/coding-worker/qorpera-coding-host-watchdog.timer": "53ee0a3bea99a2ca0a41274aa8c0f2fbbad33abea56b1ce12f87ef40139e02d5", "deploy/first-node/native-claude/linux-x64-artifact.json": "627db070d2b195f74813a63dd0d0e78589c19716fa1498ec58e8fd07808c2124", "packages/cloud-client/src/node/cloud-runner-protocol.ts": "cc3e78092791923142528266cc5f07810002403eac98670f76af4acc9fdfd927", "packages/runner-orchestrator/src/code-change-records.ts": "546ad86ffaf27658b0fc8e9877ad707f98395aa665aacda3fdea4879827ce7f0", "packages/runner-orchestrator/src/coding-error-detail.ts": "009660f176130066c66653be5c705c9e4d8d3a45434158d665f82606485be30e", "packages/runner-orchestrator/src/coding-folder-views.ts": "bddcc1d75ae705fa9926bc3c708765fbf1382c1aecfb93b63994af56721ca47d", "packages/runner-orchestrator/src/coding-git-transfer.ts": "2fe13936b7271a0b0752b5c868d329f390d26d387e65860322cf1c324f0779c0", "packages/runner-orchestrator/src/coding-guest-client.ts": "5846d5bb2c48b5fc4ccd8af8b4df9ec840cf3c8c33ba57655e13f4efd92547d3", "packages/runner-orchestrator/src/coding-standby-pool.ts": "0427d4dde035d53f648dae22b6aba97787408de51bb7dadededecbbc80b22a2c", "packages/runner-orchestrator/src/machine-exec-server.ts": "222e3f6e7e37c0643bf1a4a9c645e526453b25b16ed92335e5c267ffa448bc91", "packages/runner-orchestrator/src/machine-home-folder.ts": "800257505fce3e2ac18a4e2f0308e2e90434a55d44a73330610bcdb5d167de6e", "packages/runner-orchestrator/src/surface-worker-loop.ts": "2f4a1d80cd3cac87e6d6d92a312cfc91e978d550b0a0cea036f58d0aa87f9f2d", "packages/runtime/src/cloud-coding-storage-guest-main.ts": "4d90bf4dff64c9cd16cb02df7a07f2d1064be98b3d73ecced1e27ee3ae1a0696", "packages/runtime/src/cloud-model-login-vault-sign-in.ts": "27304c00202c2184d0d89ff2b40d6f0c81c50b6e60fdb935d7ec5e276a1fbded", "packages/runtime/src/lxd-native-login-bootstrap-main.ts": "2c818882521dc18e0bfa3a9618d92d7b90a09d25fed8053557ff8dca311a52e8", "deploy/lxd-runner-guest/qorpera-ephemeral-runner.service": "4ca462ab1c83b62e316e02e79f6cff97c2831b5a50749f884042813742a9d934", "packages/runner-orchestrator/src/coding-executor-host.ts": "f345ee580d54fb33d45139df7e9ce0683f318315b28a5eaca9f578beb7341a8e", "packages/runner-orchestrator/src/company-machine-disk.ts": "4c5cc7864e40f601021fed9ba07569d9343128c165b7d73556b3097010f3cbaf", "packages/runner-orchestrator/src/company-machine-host.ts": "ba3f620a4abefc71bacbf09ba423ee958efc64d98e12b7b7da8afc46f986e576", "packages/runner-orchestrator/src/native-webapp-deploy.ts": "333acf7cde273ca4bbdf8da90ca573f69b61f2acaa9fc214e1d8af41f4d74b56", "packages/runtime/src/cloud-coding-guest-configuration.ts": "0c6c57b4f6f5dc89c91bd132fda62cd3cb1e0dcfa764f203e121f15d90542604", "packages/runtime/src/cloud-connector-token-revocation.ts": "88676604dc44f0ef6dbe1e9d7e3dadba156cfce09d5b0cff0311bd1a43e54201", "packages/runtime/src/cloud-member-machine-screen-http.ts": "68fed8e6be7955b8ef7532757399d1d76e59f00c5376ef901bd320648040d8f6", "packages/runtime/src/cloud-member-machine-stream-http.ts": "553c8399e3b9341a6e8e5c94ae628b767b583f3b11eac8b9493e2282d3b4a6fe", "packages/runtime/src/cloud-native-context-composition.ts": "df57b657412afa5c0574036591f9e2c3803f01f52b1c97edb6660362853eb7ff", "packages/runtime/src/cloud-native-identity-credential.ts": "bc8584ee52b5593a7f6486ddb7f87d525e5fc29a00e581f7403925c15071b39b", "packages/runtime/src/cloud-secret-broker-service-main.ts": "a0d5b117e1e8ff39a219d336e26640a7be811cfb535dcf58919d4555d860dcf4", "deploy/coding-worker/qorpera-coding-host-watchdog.service": "172a269a7e99d1f54368b83602e1929f334e64cd76c17b618a78e922ad296dde", "packages/runner-orchestrator/src/coding-folder-control.ts": "7d8dbf3e3fc64fb7779b15a41d0066277282e4589861b3d9c2caf69713a09dec", "packages/runner-orchestrator/src/coding-folder-secrets.ts": "e23b08e4bb6f284af0058493a24f7e01435cce464cfe5ef51ef88308da23428e", "packages/runtime/src/cloud-company-computer-site-stops.ts": "163f8c3b5b8382c019de97fd5619548d39ba236493b3f8df21a0599cee3d1537", "packages/contracts/src/company-computer-native-endpoint.ts": "332834633332ea30c1c15f409b2ad35fa8816af50b72a1c39bab25fa327c010a", "packages/runner-orchestrator/src/code-host-repositories.ts": "8941be2fbf1e2d336775d4cdd087f4d76fa5940b571fa93e428a5ad969ba283c", "packages/runner-orchestrator/src/coding-command-secrets.ts": "55be4cf493d319d0d32c85124fdb9225de59dcee20f377644b34f7fcf6b913bb", "packages/runner-orchestrator/src/coding-lease-transport.ts": "c3df468cf753cfa81e59b7503da58182f2519c83a8f79394c3e6f9612c4f6e15", "packages/runner-orchestrator/src/coding-setup-lifecycle.ts": "6eba90046a98d82321be2f9254b5c0408b93972ed0efc889e5a09d91167dde69", "packages/runner-orchestrator/src/company-machine-figure.ts": "3546f663e3ea99bc0dc15f3a9778835b60c5b4a24c24bc93b276d09f96de45e2", "packages/runner-orchestrator/src/company-machine-stream.ts": "206b3ff50969cf3ab4759ba97534f6b2215d22717d8d97218a518dd568cccfdd", "packages/runner-orchestrator/src/surface-preview-runner.ts": "85ee0f96ea283803b00f7fa890d5e16f72ff98adea217aec24d9b332f0b32065", "packages/runtime/src/cloud-coding-configuration-install.ts": "bb2ca55db2b0c198b4df9a5535899bf686688ec379e4dc9457ee41df7dbbc26d", "packages/runtime/src/cloud-company-computer-screenshots.ts": "8096f5c1ed0ab21f2abe9282f226106878379070b4770729646b5d6bba2b8798", "packages/runtime/src/cloud-native-provider-service-main.ts": "e0cad5e39547b8d077930094d8c348631d2a66db093b6b6135b9cb654cd7516e", "deploy/lxd-runner-guest/qorpera-native-company-host.service": "79116c3b818d3732cb40b43209266455313ca3c6ff9c8496a6e6970dc7d8337a", "packages/runner-orchestrator/src/company-machine-secrets.ts": "e4d2a024de5a4c65a96592e29f4b8c605272c38b78ed13d60dba976b68bd0319", "packages/runtime/src/cloud-company-computer-account-fill.ts": "d60080d3363eb9d725aab978c018f6baebc882d4af72053acd24f76194505765", "deploy/first-node/native-codex/0001-cloud-result-fence.patch": "7218a9e25e4857ead3c40ff4e1d780e0f4b232a48373ba6c998d569e3fad8221", "deploy/lxd-runner-guest/qorpera-lxd-runner-bootstrap.service": "9ea14ba35dec5dc8b315890ac3e5e0a5b5e87633bcb92ebe74444ec8b431f603", "deploy/lxd-runner-guest/qorpera-native-provider-host.service": "5375306dd32e54e18efcdad1c9373a255e314c65fdbbe0c759c198de20093ff0", "packages/runner-orchestrator/src/coding-command-transport.ts": "eb6d5a80ec9bdeeeca5b32483279f35f34d13c5eec80b82c1d49ade94514885a", "packages/runner-orchestrator/src/lxd-office-journal-files.ts": "6ba53f4da9a70ec61ef392f6eb75b7c09e3f29065d0c180f457364a52e7129ce", "packages/runner-orchestrator/src/lxd-office-physical-host.ts": "31c9eaf709ec5d7fbfefcc8c220e283f34167c5ca826b172559ea678c30ecac3", "packages/runner-orchestrator/src/surface-code-host-worker.ts": "81501b181e8c311e493ac641c895d08b16abba9ba2a097d508b9f2a3cfac1618", "packages/runner-orchestrator/src/surface-execution-bridge.ts": "1063a53ad2c23fdaa0657d3a652f301f78acefbf1369e8d5922ef453afac5dd7", "packages/runtime/src/cloud-identity-recovery-restore-main.ts": "4045d36563419775bf32d3f6fa3a7a1af7eecfc82d0977bc6eaa93f178f224ff", "packages/runner-orchestrator/src/company-machine-time-zone.ts": "960c58864932889034308e129e2385d7ad70f0910c503cadc77908f7ab3e6c89", "packages/runner-orchestrator/src/lxd-office-host-namespace.ts": "4b4b20cf4ee452bc2d710be88786c3e828a008deecb447358c2a38e51b308d6d", "packages/runner-orchestrator/src/surface-change-dispatcher.ts": "708ac96f2aa6b48e0f5b0d6ec1df9469876dc7f32d9d08e12b497270e888bae6", "packages/runtime/src/cloud-company-computer-private-fields.ts": "5cbf9e1e903b3b75eb7d090c708000e03470365b8c49d72364630e653d30583f", "packages/cloud-client/src/cloud-native-subscription-control.ts": "7f470bcae72c84f1d4936ad4652f9d6cb8698f152026e8d0a0d98b4c96711e06", "packages/runner-orchestrator/src/coding-folder-repositories.ts": "a05697e9ba578864c6b6ecb5e9b2dbbeb3d87ae0faa653c0b0dcbf3b75def76d", "packages/runner-orchestrator/src/lxd-office-physical-policy.ts": "921fdfbb1f6eb1a574e49e15e34ca0bd75281de6fa8627492e6a8223871226ec", "deploy/lxd-runner-guest/qorpera-lxd-native-login-bootstrap.service": "653ef229d8254824cbfa1ff2e91046396818d43e91edc33d221d9e97fecaa66d", "deploy/lxd-runner-guest/qorpera-native-login-provider-host.service": "4b943dfd0501dbb01c576dd3d3d29cc2e6c9e4b94ccfaa4e3847ea2045b75db9", "packages/runner-orchestrator/src/company-machine-stream-process.ts": "1a2189628b7c859ede6cb36f19ecfa7c0ade5cc6d3e20dd177f916bd071d1e1f", "packages/runner-orchestrator/src/coding-folder-command-transport.ts": "75cac6dd1d4cb1b02d51cb8cf95e7c27c8f95eb8b252278bb9d83c085ef7c7f3"}, "nativeBinarySha256": "9d6a86ec6e280e43d76653d9514aa92769ec67ec157e4ff3bb598fb4a4b48211"}'::jsonb,'a56a9fc116035f87b5a125e0e1452118e08dfd84d9b6e2e90ca5fc6fd49ff67e');
update public.qorpera_active_runtime_bundle set runtime_bundle_id = bundle.id,
	runtime_bundle_sha256 = bundle.sha256,activated_at = statement_timestamp()
from public.qorpera_runtime_bundles bundle
where singleton and bundle.bundle_key = 'qorpera.cloud-runtime' and bundle.version = 283;
end $$;
