-- 20260930248000: the legacy sweep, step F1e (an agent's messages, its interaction requests and review rules, and a
-- member's room post). Five functions keep only their folder-v2 path (folder-v2 only, the founder's decision of
-- 3 October). Each one's first statement handed a folder-v2 call to the folder core; now it hands every call there:
-- - qorpera_send_coworker_message -> qorpera_folder_send_coworker_message;
-- - qorpera_send_native_agent_message -> qorpera_folder_send_agent_message;
-- - qorpera_append_native_interaction_request -> qorpera_folder_append_interaction_request;
-- - qorpera_add_agent_review_rule -> qorpera_folder_add_agent_review_rule;
-- - qorpera_post_company_room_message -> qorpera_folder_post_room_message.
-- Each call is the live text; create or replace keeps every grant, and the defaults are restated.

set local lock_timeout = '3s';

create or replace function public.qorpera_send_coworker_message(p_binding jsonb, p_recipient_staff_id uuid,
	p_operation_key text, p_text text, p_priority boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930248000 (legacy sweep F1e): folder-v2 only, so the folder core serves every call.
	return public.qorpera_folder_send_coworker_message(p_binding, p_recipient_staff_id, p_operation_key, p_text,
		p_priority);
end
$function$;

create or replace function public.qorpera_send_native_agent_message(p_lease_id uuid, p_run_id uuid, p_job_id uuid,
	p_runner_id uuid, p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid, p_provider text,
	p_native_harness text, p_idempotency_key text, p_text text, p_phase text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930248000 (legacy sweep F1e): folder-v2 only, so the folder core serves every call.
	return public.qorpera_folder_send_agent_message(jsonb_build_object('leaseId', p_lease_id, 'runId', p_run_id,
		'jobId', p_job_id, 'runnerId', p_runner_id, 'assignmentId', p_assignment_id,
		'credentialCapsuleId', p_credential_capsule_id, 'computeIdentityId', p_compute_identity_id,
		'provider', p_provider, 'nativeHarness', p_native_harness,
		'model', (select run.model_id from public.qorpera_execution_runs run where run.id = p_run_id)),
		p_idempotency_key, p_text, p_phase);
end
$function$;

create or replace function public.qorpera_append_native_interaction_request(p_lease_id uuid, p_run_id uuid,
	p_job_id uuid, p_runner_id uuid, p_assignment_id uuid, p_credential_capsule_id uuid, p_compute_identity_id uuid,
	p_provider text, p_native_harness text, p_event_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930248000 (legacy sweep F1e): folder-v2 only, so the folder core serves every call.
	return public.qorpera_folder_append_interaction_request(jsonb_build_object('leaseId', p_lease_id, 'runId', p_run_id,
		'jobId', p_job_id, 'runnerId', p_runner_id, 'assignmentId', p_assignment_id,
		'credentialCapsuleId', p_credential_capsule_id, 'computeIdentityId', p_compute_identity_id,
		'provider', p_provider, 'nativeHarness', p_native_harness,
		'model', (select run.model_id from public.qorpera_execution_runs run where run.id = p_run_id)), p_event_id,
		p_data);
end
$function$;

create or replace function public.qorpera_add_agent_review_rule(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930248000 (legacy sweep F1e): folder-v2 only, so the folder core serves every call.
	return public.qorpera_folder_add_agent_review_rule(p_binding, p_request);
end
$function$;

create or replace function public.qorpera_post_company_room_message(p_room_id uuid, p_client_input_id uuid,
	p_body jsonb, p_sponsor_binding_id uuid, p_sponsor_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
	-- 20260930248000 (legacy sweep F1e): folder-v2 only, so the folder core serves every call.
	return public.qorpera_folder_post_room_message(p_room_id, p_client_input_id, p_body, p_sponsor_binding_id,
		p_sponsor_version);
end
$function$;
