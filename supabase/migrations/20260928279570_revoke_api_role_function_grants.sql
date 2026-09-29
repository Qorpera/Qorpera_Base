-- Security fix: internal functions callable with the publishable key.
--
-- Supabase's default privileges grant EXECUTE on every new function in `public` to anon,
-- authenticated and service_role (deploy/first-node/RUNTIME-STEP-1.md, "A production permission
-- audit found direct API-role grants inherited from Supabase default privileges"). The migrations
-- that created the functions below only revoked PUBLIC, which does not remove those role grants, so
-- the API could call them. None checks its caller. The worst: anyone with the publishable key could
-- lease every company's pending invitation emails and mark them delivered, append forged rows to a
-- company's operation journal, and hold a company's GC fence rows locked.
--
-- Their real callers are unaffected:
-- * security definer functions and triggers call them SQL-to-SQL as the owner, which needs no role grant;
-- * the profile-invitation-email Edge Function calls the three delivery functions with a secret key
--   (service_role), which keeps its grant (20260816007000);
-- * three validators back CHECK constraints on tables service_role may write directly. PostgreSQL
--   checks EXECUTE on a CHECK expression's functions as the writing role, so service_role keeps them;
--   anon and authenticated cannot write those tables;
-- * qorpera_session_profile_id is a member RPC in supabase/CLIENT-CONTRACT.md, and for an
--   authenticated caller it checks qorpera_can_read_session. Only other roles skip that check, so
--   anon and service_role lose it and authenticated keeps its explicit grant (20260816000000).
-- Named roles, as in 20260818005000 and 20260827004500. Test 749 pins the result.
set local lock_timeout = '3s';

-- No caller over the API: revoke from all three roles.
revoke execute on function
	public.qorpera_lock_profile_gc_fence(uuid),
	public.qorpera_append_company_operation(uuid, uuid, text, uuid, bigint, jsonb, uuid),
	public.qorpera_reserve_execution_sponsor_authority(uuid),
	public.qorpera_quarantine_runner_model_requests(uuid, text),
	public.qorpera_append_runner_audit(uuid, uuid, uuid, text, jsonb, uuid),
	public.qorpera_append_artifact_gc_audit(public.qorpera_artifact_gc_plans, text, jsonb, uuid),
	public.qorpera_ensure_current_company_substrate(uuid, uuid, uuid, uuid, uuid),
	public.qorpera_artifact_gc_initial_guard_ready(uuid),
	public.qorpera_object_root_creator(text, uuid),
	public.qorpera_object_root_has_current_proof(text, uuid),
	public.qorpera_object_graph_objects_available(uuid),
	public.qorpera_profile_reachability_coverage_ready(uuid),
	public.qorpera_provider_execution_enabled(text, text, text),
	public.qorpera_current_email_verified(),
	public.qorpera_runner_session_valid(uuid, text),
	public.qorpera_artifact_gc_plan_json(public.qorpera_artifact_gc_plans),
	public.qorpera_runner_json(public.qorpera_runners),
	public.qorpera_execution_run_json(public.qorpera_execution_runs),
	public.qorpera_execution_work_json(public.qorpera_runner_job_claims),
	public.qorpera_artifact_json(public.qorpera_artifacts),
	public.qorpera_artifact_index_json(public.qorpera_artifact_indexes),
	public.qorpera_artifact_retention_hold_json(public.qorpera_artifact_retention_holds),
	public.qorpera_company_substrate_version_json(public.qorpera_company_substrate_versions),
	public.qorpera_object_reachability_graph_json(public.qorpera_object_reachability_graphs),
	public.qorpera_object_restore_proof_json(public.qorpera_object_restore_proofs),
	public.qorpera_runner_job_json(public.qorpera_runner_jobs),
	public.qorpera_runner_model_policy_json(public.qorpera_runner_model_policies),
	public.qorpera_runner_usage_json(public.qorpera_runner_usage_observations),
	public.qorpera_runner_model_gateway_authority(uuid),
	public.qorpera_profile_invitation_delivery_json(uuid),
	public.qorpera_execution_compute_available(public.qorpera_execution_runs),
	public.qorpera_execution_sponsor_available(public.qorpera_execution_runs),
	public.qorpera_compute_policy_sha256(jsonb),
	public.qorpera_interaction_host_valid(text),
	public.qorpera_interaction_request_valid(jsonb),
	public.qorpera_interaction_text_valid(jsonb, integer, integer),
	public.qorpera_runner_transcript_entry_valid(text, jsonb)
	from anon, authenticated, service_role;

-- The invitation delivery worker (service_role) and CHECK constraint validators: service_role keeps them.
revoke execute on function
	public.qorpera_claim_profile_invitation_deliveries(integer, uuid),
	public.qorpera_complete_profile_invitation_delivery(uuid, uuid, text),
	public.qorpera_fail_profile_invitation_delivery(uuid, uuid, text, boolean),
	public.qorpera_provider_quota_policy_valid(jsonb),
	public.qorpera_runner_capabilities_valid(jsonb),
	public.qorpera_uuid_array_is_unique(uuid[])
	from anon, authenticated;

-- A member RPC: authenticated keeps it.
revoke execute on function public.qorpera_session_profile_id(uuid) from anon, service_role;
