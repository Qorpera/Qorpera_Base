-- 20260930698000, step 2 of coding value capture (20260930695000): what the broker needs to derive a coding value's
-- capture key before it prepares it (the coordinator, 9 November 2026).
--
-- qorpera_folder_prepare_coding_value_capture takes the key the broker derived: an X25519 pair from the company's key
-- under the authority's current key id, salted with the secret's id and the environment. The broker knows none of the
-- three before it asks, so it asks here, as E3c's hook path asks qorpera_folder_describe_hook_capture_key:
-- * qorpera_folder_describe_coding_value_capture, broker-only, runs the broker's checks (the same authority helper the
--   other three calls use) and the capture's checks and locks with the prepare's leniency (the shared context, bound to
--   the agent's executing computer_browser receipt of exactly this vault_capture call), and answers the company, the
--   environment, the variable and the authority's current key id; the id the value keeps when it keeps one (its active
--   secret's, or the key's reserved id while no secret holds it); and whether the stored capture key is current, with its
--   public half when it is, so the broker can check it is its own and need not prepare again. It writes nothing.
-- Every new body names this migration (20260930698000), for the deploy guard.

do $$ begin
	if to_regprocedure('public.qorpera_folder_describe_coding_value_capture(uuid,text,jsonb,uuid,text,text)') is not null then
		raise exception '20260930698000 is already applied'; end if;
	if to_regprocedure('public.qorpera_folder_coding_value_capture_context(public.qorpera_cloud_secret_broker_authorities,'
			|| 'jsonb,uuid,text,text,boolean)') is null
		or to_regprocedure('public.qorpera_folder_coding_value_authority(uuid,text,jsonb)') is null then
		raise exception '20260930698000 needs coding value capture step 1 (20260930695000)'; end if;
end $$;

set local lock_timeout = '3s';

create function public.qorpera_folder_describe_coding_value_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_receipt_id uuid,
	p_envelope text,
	p_downstream_idempotency_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_context record;
begin
	-- 20260930698000: the broker's checks before any lock, then the capture's checks and locks as a prepare takes them.
	v_authority := public.qorpera_folder_coding_value_authority(p_broker_authority_id, p_broker_capability_sha256, p_binding);
	select context.* into strict v_context from public.qorpera_folder_coding_value_capture_context(v_authority, p_binding,
		p_receipt_id, p_envelope, p_downstream_idempotency_sha256, true) as context;
	return jsonb_build_object('schema', 'qorpera.coding-value-capture-description/v1', 'companyId', v_context.profile_id,
		'environmentId', v_context.environment_id, 'variable', v_context.secret_name, 'keyId', v_authority.key_id,
		'current', v_context.key_current)
		|| case when v_context.secret_id is not null
			then jsonb_build_object('secretId', v_context.secret_id) else '{}'::jsonb end
		|| case when v_context.key_current
			then jsonb_build_object('capturePublicKey', v_context.capture_public_key) else '{}'::jsonb end;
end
$$;
revoke all on function public.qorpera_folder_describe_coding_value_capture(uuid, text, jsonb, uuid, text, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_folder_describe_coding_value_capture(uuid, text, jsonb, uuid, text, text)
	to qorpera_secret_broker;

do $guard$ begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_describe_coding_value_capture(uuid,text,jsonb,uuid,text,text)'::regprocedure),
			'20260930698000') = 0 then
		raise exception '20260930698000 marker is missing'; end if;
end $guard$;
