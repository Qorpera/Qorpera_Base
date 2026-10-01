-- Authorization before the row lock, the rest (20260929750000 did eight functions). Each function below locked the
-- row its arguments name and only then checked the caller: a runner job (its model policy), a proposal review
-- assignment, an artifact retention hold, an operation receipt (resolving, completing and staging objects for it), a
-- run operation receipt (resolving it, on either Company File core), an object reachability graph (appending to and
-- completing it, by a member or by a runner), an event hook, an execution sponsor binding, a logical computer, a
-- provider connection, a cloud secret (granting it to agents, and rotating it), a member's Company File edit command
-- and a shared session (a turn in a member's private conversation). A caller who knew or guessed the ids could queue
-- for that row and, by repeating the call, make the company's own writers wait. For the runner job, the review, the
-- hold, the run receipt, both graph lanes, the binding, the computer and the connection the publishable key was
-- enough: anon can call those functions through the platform default.
--
-- Each now reads the row without a lock and refuses before the lock a caller its locked check would refuse, with the
-- same error, so a refusal tells no more than before: an id nobody has gets the error it got (the 409 for a runner's
-- unknown graph; "query returned no rows" for an unknown secret). The plain check is the locked check's own test of
-- the caller, without the row's status, which may change while a call waits. A caller who passes takes the lock as
-- before, and everything after it is unchanged: the locked checks still refuse a member who lost the role while the
-- call waited. The checks already before the lock keep their place, first (folder-v2 refusals and dispatch, the
-- secret capture's scope, the Company File actor).
--
-- Two plain checks are new rather than earlier copies:
-- * A runner's graph page and graph completion call qorpera_runner_broker_job before the graph lock. It is the check
--   qorpera_runner_company_revision_snapshot makes first under that lock (through qorpera_runner_broker_locked_job),
--   lock-free, with the same errors; only the graph's existence (its 409) comes before it, as before.
-- * A turn in a member's private conversation: qorpera_request_session_turn_v2 checked the company role, and the
--   conversation's audience only when qorpera_append_session_input appended the turn's input, after the request's
--   other checks. A member of the company outside the conversation is now refused before the lock, with the error
--   that append gives ('session write access is required'), and so before the request's other checks. Callers
--   without the company role are untouched here (20260929750000 refuses them before the lock).
--
-- Exact-text patches, all in one statement: each fails unless its function locks its row once, with the text given.

create function pg_temp.own_row_auth_second_patch(p_function regprocedure, p_lock text, p_check text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_lock, ''))) / length(p_lock) <> 1 then
		raise exception '% does not lock its row where this migration expects', p_function; end if;
	execute replace(v_definition, p_lock, p_check || p_lock);
end
$patch$;

select pg_temp.own_row_auth_second_patch(patch.function_signature::regprocedure, patch.lock_text, patch.check_text)
from (values
-- A runner job's model policy: the company's owners and admins.
('public.qorpera_configure_runner_model_policy(uuid,jsonb,integer,bigint,bigint)',
	$lock$	select job.* into v_job from public.qorpera_runner_jobs as job where job.id = p_job_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile(
		(select job.profile_id from public.qorpera_runner_jobs as job where job.id = p_job_id)) then
		raise exception 'runner model policy requires authorization access' using errcode = '42501';
	end if;
$check$),
-- Retrying a failed proposal review: the company's owners and admins.
('public.qorpera_retry_company_proposal_review(uuid)',
	$lock$	select review.* into v_review
	from public.qorpera_company_proposal_review_assignments as review
	where review.id = p_assignment_id for update;$lock$,
	$check$	if auth.uid() is null or not public.qorpera_can_authorize_profile((select review.profile_id
		from public.qorpera_company_proposal_review_assignments as review where review.id = p_assignment_id)) then
		raise exception 'proposal review recovery requires authorize access' using errcode = '42501';
	end if;
$check$),
-- Releasing an artifact retention hold: the company's owners and admins.
('public.qorpera_release_artifact_retention_hold(uuid)',
	$lock$	select hold.* into v_hold
	from public.qorpera_artifact_retention_holds as hold
	where hold.id = p_hold_id
	for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile(
		(select hold.profile_id from public.qorpera_artifact_retention_holds as hold where hold.id = p_hold_id)) then
		raise exception 'artifact retention requires full access' using errcode = '42501';
	end if;
$check$),
-- Resolving an ambiguous operation receipt: the company's owners and admins.
('public.qorpera_resolve_operation_receipt(uuid,text,jsonb)',
	$lock$	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id
	for update;$lock$,
	$check$	if not public.qorpera_can_authorize_profile(
		(select receipt.profile_id from public.qorpera_operation_receipts as receipt where receipt.id = p_operation_id)) then
		raise exception 'operation recovery authorization is required' using errcode = '42501';
	end if;
$check$),
-- Completing an operation receipt and staging its objects: the member who claimed it, while they may write.
('public.qorpera_complete_operation_receipt(uuid,uuid,uuid,jsonb)',
	$lock$	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
	for update;$lock$,
	$check$	if not exists (select 1 from public.qorpera_operation_receipts as receipt
		where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
			and (not public.qorpera_can_write_profile(receipt.profile_id)
				or receipt.claimed_by_user_id <> v_user_id) is not true) then
		raise exception 'operation receipt access is required' using errcode = '42501';
	end if;
$check$),
('public.qorpera_stage_operation_receipt_objects(uuid,uuid,uuid,jsonb)',
	$lock$	select receipt.* into v_receipt
	from public.qorpera_operation_receipts as receipt
	where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
	for update;$lock$,
	$check$	if not exists (select 1 from public.qorpera_operation_receipts as receipt
		where receipt.id = p_operation_id and receipt.execution_id = p_execution_id
			and (not public.qorpera_can_write_profile(receipt.profile_id) or receipt.claimant_id <> p_claimant_id
				or receipt.claimed_by_user_id <> v_user_id) is not true) then
		raise exception 'live operation receipt ownership is required' using errcode = '42501';
	end if;
$check$),
-- Resolving an ambiguous run operation receipt: the company's owners and admins, after the folder-v2 dispatch, and in
-- the folder-v2 resolution it dispatches to.
('public.qorpera_resolve_run_operation_receipt(uuid,text,jsonb,uuid,uuid)',
	$lock$	select receipt.* into v_receipt
	from public.qorpera_run_operation_receipts as receipt where receipt.id = p_receipt_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile((select run.profile_id
		from public.qorpera_run_operation_receipts as receipt join public.qorpera_execution_runs as run on run.id = receipt.run_id
		where receipt.id = p_receipt_id)) then
		raise exception 'operation recovery requires authorize access' using errcode = '42501';
	end if;
$check$),
('public.qorpera_folder_resolve_run_receipt(uuid,text,jsonb,uuid,uuid)',
	$lock$	select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt where receipt.id = p_receipt_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile((select run.profile_id
		from public.qorpera_run_operation_receipts as receipt join public.qorpera_execution_runs as run on run.id = receipt.run_id
		where receipt.id = p_receipt_id)) then
		raise exception 'operation recovery requires authorize access' using errcode = '42501';
	end if;
$check$),
-- Appending to and completing an object reachability graph: the member who began it, while they may write.
('public.qorpera_append_object_reachability_entries(uuid,jsonb)',
	$lock$	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
	for update;$lock$,
	$check$	if auth.uid() is null or not exists (select 1 from public.qorpera_object_reachability_graphs as graph
		where graph.id = p_graph_id and graph.created_by_user_id = auth.uid()
			and public.qorpera_can_write_profile(graph.profile_id)) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
$check$),
('public.qorpera_complete_object_reachability_graph(uuid)',
	$lock$	select graph.* into v_graph
	from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id
	for update;$lock$,
	$check$	if auth.uid() is null or not exists (select 1 from public.qorpera_object_reachability_graphs as graph
		where graph.id = p_graph_id and graph.created_by_user_id = auth.uid()
			and public.qorpera_can_write_profile(graph.profile_id)) then
		raise exception 'object reachability requires graph-creator access' using errcode = '42501';
	end if;
$check$),
-- A runner's Company File revision graph: the runner holding the job's lease, checked as the snapshot check under
-- the lock checks it first. A graph nobody has still gets its 409 at the lock.
('public.qorpera_runner_append_company_revision_graph(uuid,text,uuid,text,uuid,uuid,jsonb)',
	$lock$	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;$lock$,
	$check$	if exists (select 1 from public.qorpera_object_reachability_graphs as graph
		where graph.id = p_graph_id and graph.root_kind = 'company_snapshot') then
		perform public.qorpera_runner_broker_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);
	end if;
$check$),
('public.qorpera_runner_complete_company_revision_graph(uuid,text,uuid,text,uuid,uuid)',
	$lock$	select graph.* into v_graph from public.qorpera_object_reachability_graphs as graph
	where graph.id = p_graph_id and graph.root_kind = 'company_snapshot' for update;$lock$,
	$check$	if exists (select 1 from public.qorpera_object_reachability_graphs as graph
		where graph.id = p_graph_id and graph.root_kind = 'company_snapshot') then
		perform public.qorpera_runner_broker_job(p_runner_id, p_session_token_sha256, p_job_id, p_lease_token_sha256);
	end if;
$check$),
-- Pausing, resuming and removing an event hook: the company's owners and admins.
('public.qorpera_set_event_hook_status(uuid,text)',
	$lock$	-- No key changes, so a receive's foreign key check (key share) does not wait for this lock.
	select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = p_hook_id for no key update;$lock$,
	$check$	if auth.uid() is null or coalesce(public.qorpera_member_role(
		(select hook.profile_id from public.qorpera_event_hooks as hook where hook.id = p_hook_id))::text not in ('owner', 'admin'), true) then
		raise exception 'Only owners and admins can change hooks' using errcode = '42501';
	end if;
$check$),
-- An execution sponsor binding's and a logical computer's status: the named company's owners and admins.
('public.qorpera_set_execution_sponsor_status(uuid,uuid,text)',
	$lock$	select binding.* into v_binding from public.qorpera_execution_sponsor_bindings as binding
	where binding.id = p_binding_id and binding.profile_id = p_profile_id for update;$lock$,
	$check$	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'execution sponsor lifecycle requires authorize access' using errcode = '42501';
	end if;
$check$),
('public.qorpera_set_logical_computer_status(uuid,uuid,text)',
	$lock$	select computer.* into v_computer from public.qorpera_logical_computers as computer
	where computer.id = p_logical_computer_id and computer.profile_id = p_profile_id for update;$lock$,
	$check$	if auth.uid() is null or not public.qorpera_can_authorize_profile(p_profile_id) then
		raise exception 'logical computer lifecycle requires authorize access' using errcode = '42501';
	end if;
$check$),
-- A provider connection's status: the named company's owners and admins, or its owner revoking it.
('public.qorpera_set_provider_connection_status(uuid,uuid,text)',
	$lock$	select connection.* into v_connection from public.qorpera_provider_connections as connection
	where connection.id = p_connection_id and connection.profile_id = p_profile_id for update;$lock$,
	$check$	if auth.uid() is null or not (
		public.qorpera_can_authorize_profile(p_profile_id)
		or ((select connection.owner_user_id from public.qorpera_provider_connections as connection
			where connection.id = p_connection_id and connection.profile_id = p_profile_id) = auth.uid() and p_status = 'revoked')
	) then
		raise exception 'provider connection lifecycle requires authorize access' using errcode = '42501';
	end if;
$check$),
-- Granting a company-owned secret to the company's agents: its owners and admins (the role was read first).
('public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[])',
	$lock$	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$lock$,
	$check$	if exists (select 1 from public.qorpera_cloud_secrets as secret
		where secret.id = p_secret_id and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
			and (secret.owner_kind <> 'company' or v_role is null or v_role not in ('owner','admin'))) then
		raise exception 'secret grant authority is unavailable' using errcode = '42501';
	end if;
$check$),
-- Rotating a cloud secret: the secret named as it is, by an owner or admin for the company's, by its owner for a
-- member's (the caller's write access and the scope they name were checked first).
('public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)',
	$lock$		select secret.* into strict v_secret
		from public.qorpera_cloud_secrets as secret
		where secret.id = p_existing_secret_id
			and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
		for update;$lock$,
	$check$		if exists (select 1 from public.qorpera_cloud_secrets as secret
			where secret.id = p_existing_secret_id
				and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
				and (secret.owner_kind <> p_owner_kind or secret.owner_user_id is distinct from p_owner_user_id
					or secret.connector_id <> p_connector_id or secret.secret_name <> p_secret_name
					or (secret.owner_kind = 'company' and v_role not in ('owner','admin'))
					or (secret.owner_kind = 'member' and secret.owner_user_id <> v_user_id))) then
			raise exception 'secret rotation authority is unavailable' using errcode = '42501';
		end if;
$check$),
-- Reviewing a member's Company File edit: the member who made it, with its plan. The Company File actor (membership,
-- then the company's fence) stays first; the command was already read without a lock for it.
('public.qorpera_review_member_company_path_command(uuid,text,text)',
	$lock$	select * into strict v_command from public.qorpera_member_company_path_commands where id = p_command_id for update;$lock$,
	$check$	if v_command.user_id is distinct from auth.uid() or v_command.plan_sha256 is distinct from p_plan_sha256
		or p_decision is null or p_decision not in ('approve','reject','skip') then
		raise exception 'Company File edit review is unavailable' using errcode = '42501'; end if;
$check$),
-- A turn in a member's private conversation: its member. Only callers with the company role reach this check.
('public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
	$lock$	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;$lock$,
	$check$	if v_user_id is not null and public.qorpera_can_write_profile(
		(select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id))
		and not public.qorpera_can_write_session(p_session_id) then
		raise exception 'session write access is required' using errcode = '42501';
	end if;
$check$)
) as patch(function_signature, lock_text, check_text);

drop function pg_temp.own_row_auth_second_patch(regprocedure, text, text);
