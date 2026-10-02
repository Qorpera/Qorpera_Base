-- A missing capability or digest refuses (found by #653's review, where the same fix went into
-- qorpera_company_account_call). In PL/pgSQL, `if a <> b then raise` does not raise when either side is NULL: the
-- condition is unknown, and unknown skips the branch. Three of the functions the shared vault's database login
-- (qorpera_secret_broker) may call compared the caller's proof with `<>` or `!~`:
--
-- - qorpera_describe_cloud_secret_capture: the broker capability and the capture capability.
-- - qorpera_complete_cloud_secret_capture (seven arguments; the six-argument form calls it): the broker capability,
--   the envelope's digest and length, and the capture capability.
-- - qorpera_authorize_cloud_secret_operation: the broker capability, the five operation facts the broker pins
--   (connector, operation, version, adapter digest, destination), the receipt's input digest and the downstream
--   idempotency digest.
--
-- Every company's broker and the shared vault use that one login; the capability hash is the only proof that a call
-- is for the company (deploy/first-node/RUNTIME-LOGIN-VAULT.md). A holder of the login who knew a company's authority
-- id could pass NULL and describe or seal that company's capture ticket, or, with a run binding, a grant and an
-- executing receipt, read the company's sealed envelope and record an authorized effect on its receipt. Each of those
-- comparisons is now null-safe: `is distinct from` against a NOT NULL column, and `coalesce(... , true)` around a
-- pattern or length test of an argument. Nothing else changes: the same errors, the same order, the same locks; a
-- comparison already after one of these (the envelope's digest against the decoded bytes, the stored downstream
-- digest) only ever sees a non-NULL argument now. The other 33 functions the login may call already compared
-- null-safely (the PR lists each).
--
-- Exact-text patches, as 20260929999900: each fails unless its text is found exactly once, so a function changed
-- since then stops this migration instead of losing that change. Each patched function names this migration in a
-- comment, for deploy guards. create or replace keeps each function's owner and grants.

set local lock_timeout = '3s';

create function pg_temp.cloud_secret_null_safe_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'cloud secret null-safe patch anchor differs in %', p_target;
	end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- Describe a capture ticket: the broker capability and the ticket's capture capability.
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure,
$old$	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256 then$old$,
$new$	-- 20260929999990: null-safe; a missing capability refuses.
	if v_authority.status <> 'active' or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then$new$);
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure,
$old$		or v_ticket.capture_capability_sha256 <> p_capture_capability_sha256
		or v_ticket.status <> 'pending'$old$,
$new$		or v_ticket.capture_capability_sha256 is distinct from p_capture_capability_sha256
		or v_ticket.status <> 'pending'$new$);

-- Seal a capture: the broker capability, the envelope's digest and length (a NULL envelope decodes to NULL, and every
-- later test of it was unknown too), and the ticket's capture capability.
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
$old$	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256
		or p_envelope_sha256 !~ '^[0-9a-f]{64}$'
		or char_length(p_encrypted_envelope_base64) not between 1 and 180000 then$old$,
$new$	-- 20260929999990: null-safe; a missing capability, digest or envelope refuses.
	if v_authority.status <> 'active' or v_authority.capability_sha256 is distinct from p_broker_capability_sha256
		or coalesce(p_envelope_sha256 !~ '^[0-9a-f]{64}$', true)
		or coalesce(char_length(p_encrypted_envelope_base64) not between 1 and 180000, true) then$new$);
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
$old$	if v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.capture_capability_sha256 <> p_capture_capability_sha256 then$old$,
$new$	if v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.capture_capability_sha256 is distinct from p_capture_capability_sha256 then$new$);

-- Authorize an agent's connector call: the broker capability, the operation facts, the input and downstream digests.
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure,
$old$	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256 then$old$,
$new$	-- 20260929999990: null-safe; a missing capability, operation fact or digest refuses.
	if v_authority.status <> 'active' or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then$new$);
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure,
$old$	if v_operation.connector_id <> p_connector_id or v_operation.operation_id <> p_operation_id
		or v_operation.version <> p_operation_version or v_operation.adapter_sha256 <> p_adapter_sha256
		or v_operation.destination_origin <> p_destination_origin or v_operation.status <> 'active' then$old$,
$new$	if v_operation.connector_id is distinct from p_connector_id or v_operation.operation_id is distinct from p_operation_id
		or v_operation.version is distinct from p_operation_version
		or v_operation.adapter_sha256 is distinct from p_adapter_sha256
		or v_operation.destination_origin is distinct from p_destination_origin or v_operation.status <> 'active' then$new$);
select pg_temp.cloud_secret_null_safe_patch('public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure,
$old$		or v_receipt.input_sha256 <> p_input_sha256
		or p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$'$old$,
$new$		or v_receipt.input_sha256 is distinct from p_input_sha256
		or coalesce(p_downstream_idempotency_sha256 !~ '^[0-9a-f]{64}$', true)$new$);

drop function pg_temp.cloud_secret_null_safe_patch(regprocedure, text, text);
