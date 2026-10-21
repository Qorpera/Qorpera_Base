-- Run after the Step 2 migrations, including the independent broker role.
-- A production-schema replay also exercises the retained legacy trigger.
begin;

do $$
declare
	v_guard regprocedure := to_regprocedure('public.qorpera_company_computer_binding_guard()');
	v_role text;
	v_functions text[];
begin
	if v_guard is not null then
		if not exists (
			select 1 from pg_proc where oid = v_guard and prorettype = 'trigger'::regtype
		) then
			raise exception 'Retained Company Computer guard changed its signature';
		end if;
		foreach v_role in array array['anon', 'authenticated', 'service_role', 'qorpera_secret_broker'] loop
			if has_function_privilege(v_role, v_guard, 'EXECUTE') then
				raise exception 'Legacy Company Computer guard is exposed to %', v_role;
			end if;
		end loop;
		if not exists (select 1 from pg_trigger where tgfoid = v_guard and not tgisinternal) then
			raise exception 'Legacy Company Computer guard lost its existing trigger';
		end if;
	end if;

	-- Exact signatures, not names: Step 7 added a second signature of the
	-- capture completion (account label), and a name-only check would also pass
	-- any other overload the broker inherited. Bundle v88 added the coding
	-- executor's repository credential. Member-reviewed email adds only the
	-- capability-bound claim and provider-receipt completion functions. Model
	-- logins in the vault (Stateless Compute step 1) add handing a live run its
	-- login and saving or giving back one renewal; a member's sign-in to the vault adds reading
	-- and completing that sign-in, and the vault's usage reads add reading, recording and
	-- completing an account refresh. Company delete D6 adds claiming and completing the broker's
	-- queued connector token revocations. ChatGPT plan logins (20260928329830) add the v2 sign-in
	-- read, completing a plan sign-in, saving a plan renewal, and taking and finishing a plan login's
	-- revocation. Company accounts (20260928419970) add reading what an opening seals, opening, using, versioning
	-- and recording the state of a company website account, each bound to the agent's effect receipt; filling
	-- one into the Company Computer (20260928429975) adds reading it for a vault_fill browser call. G2-6a
	-- (20260930152000) adds the lease proof the runtime routes ask before they serve a run binding; it takes no
	-- principal, because it only answers whether the caller's lease token is that run's job's. Signed hooks
	-- (20260930160000) add describing and opening a GitHub or HMAC hook whose secret the broker makes, each bound to
	-- the agent's manage_hook run, and reading that secret for a vault_fill browser call. Stripe hooks
	-- (20260930344000) add opening a Stripe hook with its capture key, describing and replacing that key, and reading
	-- and storing a secret a vault_capture browser call took from Stripe's screen. Coding environment secrets
	-- (20260930438000) add reading a coding session's environment, bound to its live lease. Coding MCP sign-ins
	-- (20260930440000) add reading one MCP server's sign-in and the repository fetch of a running session, each bound
	-- to its live lease. The company bank sync (20260930523000) adds claiming the company's due sync, keeping its booked
	-- transactions and finishing it, each on the company's own authority, and the shared vault's list of due companies.
	select array_agg(function.oid::regprocedure::text order by function.oid::regprocedure::text collate "C") into v_functions
	from pg_proc as function
	join pg_namespace as namespace on namespace.oid = function.pronamespace
	where namespace.nspname = 'public'
		and function.proname like 'qorpera_%'
		and has_function_privilege('qorpera_secret_broker', function.oid, 'EXECUTE');
	if v_functions is distinct from array[
		'qorpera_add_company_account_version(uuid,text,jsonb,uuid,text,text,uuid,bigint,text,text,bytea,text)',
		'qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)',
		'qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)',
		'qorpera_authorize_coding_mcp_sign_in(uuid,text,uuid,uuid,text,text)',
		'qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)',
		'qorpera_authorize_coding_repository_fetch(uuid,text,uuid,uuid,text)',
		'qorpera_broker_principal_bank_syncs_due(uuid,text)',
		'qorpera_broker_principal_companies(uuid,text)',
		'qorpera_broker_principal_event_verifications_due(uuid,text)',
		'qorpera_claim_bank_sync(uuid,text)',
		'qorpera_claim_connector_token_revocations(uuid,text,integer)',
		'qorpera_claim_email_draft_action(uuid,text,uuid,text)',
		'qorpera_claim_event_verifications(uuid,text,integer)',
		'qorpera_commit_chatgpt_plan_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)',
		'qorpera_commit_model_login_renewal(uuid,text,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone)',
		'qorpera_complete_chatgpt_plan_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone)',
		'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)',
		'qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)',
		'qorpera_complete_connector_token_revocation(uuid,text,uuid,bigint,text,text)',
		'qorpera_complete_model_login_account_refresh(uuid,text,uuid,text)',
		'qorpera_complete_model_login_sign_in(uuid,text,uuid,text,uuid,text,text,text,timestamp with time zone,timestamp with time zone,text,text)',
		'qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)',
		'qorpera_describe_company_account_open(uuid,text,jsonb,uuid,text,text)',
		'qorpera_describe_model_login_account_refresh(uuid,text,uuid,text)',
		'qorpera_describe_model_login_sign_in(uuid,text,uuid,text)',
		'qorpera_describe_model_login_sign_in_v2(uuid,text,uuid,text)',
		'qorpera_fill_company_account(uuid,text,jsonb,uuid,text,text)',
		'qorpera_fill_event_hook_secret(uuid,text,jsonb,uuid,text,text)',
		'qorpera_finish_bank_sync(uuid,text,uuid,bigint,text,jsonb,timestamp with time zone,boolean,text)',
		'qorpera_finish_chatgpt_plan_revocation(uuid,text,uuid,uuid,bigint)',
		'qorpera_finish_email_draft_action(uuid,text,uuid,text,jsonb)',
		'qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)',
		'qorpera_folder_describe_hook_capture_key(uuid,text,jsonb,uuid)',
		'qorpera_folder_describe_signed_hook(uuid,text,jsonb)',
		'qorpera_folder_open_signed_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,bytea,text)',
		'qorpera_folder_open_stripe_hook(uuid,text,jsonb,jsonb,uuid,uuid,uuid,text,text)',
		'qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)',
		'qorpera_folder_replace_hook_capture_key(uuid,text,jsonb,uuid,text,text)',
		'qorpera_folder_store_hook_capture(uuid,text,jsonb,uuid,text,text,uuid,bigint,uuid,uuid,text,bytea,text)',
		'qorpera_issue_model_login(uuid,text,jsonb,bigint,boolean)',
		'qorpera_model_login_broker_company(uuid,text)',
		'qorpera_model_logins_without_account(uuid,text)',
		'qorpera_native_binding_proven(jsonb,text)',
		'qorpera_open_company_account(uuid,text,jsonb,uuid,text,text,uuid,uuid,uuid,text,text[],text,text,uuid,text,bytea,text)',
		'qorpera_record_bank_transactions(uuid,text,uuid,bigint,jsonb,jsonb)',
		'qorpera_record_model_login_account(uuid,text,uuid,text)',
		'qorpera_record_model_login_account_metadata(uuid,text,uuid,text,uuid,uuid,bigint,text,jsonb,text)',
		'qorpera_register_company_with_broker_principal(uuid,text,uuid,text)',
		'qorpera_release_model_login_renewal(uuid,text,uuid,uuid,bigint,boolean,text)',
		'qorpera_set_company_account_state(uuid,text,jsonb,uuid,text,text,uuid,text)',
		'qorpera_switch_off_replaced_node_logins(uuid,text)',
		'qorpera_take_chatgpt_plan_revocation(uuid,text)',
		'qorpera_take_idle_model_login_renewal(uuid,text)',
		'qorpera_use_company_account(uuid,text,jsonb,uuid,text,text,uuid)'
	]::text[] then
		raise exception 'Broker inherited a function outside its fixed custody calls';
	end if;
	if has_schema_privilege('qorpera_secret_broker', 'public', 'CREATE') then
		raise exception 'Broker can create objects in the public schema';
	end if;
end
$$;

rollback;
