-- Signed hooks, build step W1b (Q1; contract section 19, 2026-09-29 amendment "events wake agents", item 8;
-- design deploy/first-node/RUNTIME-EVENT-INTAKE.md, "Verification in the vault (W1b)").
--
-- Owners and admins may now create hooks proven by a Stripe, GitHub or Standard Webhooks (proof hmac-sha256)
-- signature. The sender's signing secret is a company vault secret, connector event_hook and name h<hook id
-- without hyphens>, which an owner or admin saves through the vault's capture; the hook descriptor names it and
-- says whether it is in the vault. Until it is, the hook answers not_ready; removing the hook revokes it. A
-- signed delivery is stored as received, without a sender id or a type. The broker that serves the company
-- (the company's own broker, or the shared vault where it has something due) claims it, opens the secret in
-- memory, checks the signature and records verified with a sender id the signature covers and the event's
-- type, duplicate, or refused with a reason. The secret and its plaintext never leave the broker; this
-- database hands the broker only the sealed envelope, and the broker hands back only a verdict.
--
-- A claim holds a delivery for 60 seconds and counts an attempt. A retry (the broker could not open the
-- secret) waits a minute, then five times longer after each attempt; the fifth attempt without a verdict
-- refuses the delivery (about two and a half hours), and one still received after 24 hours is refused by the
-- purge (W1a). A verdict re-checks the hook and its secret, so nothing is verified after either is gone.
-- verified_at is stamped with clock_timestamp() in a one-row transaction, as event wakes need (W2: listeners'
-- watermarks trail the clock by a minute). A refused delivery keeps no body.
--
-- Lock order: a claim takes its broker authority row shared, then deliveries of that company (skip locked); a
-- finish takes the authority row shared, then one delivery. Neither locks the hook or the company row. A
-- receive inserts a delivery and reads the vault's secret row without locking it. Removing a hook takes the
-- hook row, then (its trigger) its secret row; nothing takes them the other way round.

set local lock_timeout = '3s';

create function pg_temp.signed_hooks_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Signed hooks integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- 1. A delivery's claim by a broker
-- ---------------------------------------------------------------------------
alter table public.qorpera_event_deliveries
	add column verify_claim uuid,
	add column verify_claim_until timestamptz,
	add column verify_attempts integer not null default 0;
-- The broker asks every five seconds; signed deliveries wait here only until it answers.
create index qorpera_event_deliveries_unverified on public.qorpera_event_deliveries (profile_id, received_at, id)
	where status = 'received';

-- ---------------------------------------------------------------------------
-- 2. A hook's signing secret in the vault
-- ---------------------------------------------------------------------------
-- Bound to the hook's id, so a new hook never picks up a removed hook's secret.
create function public.qorpera_event_hook_secret_name(p_hook_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
	select 'h' || replace(p_hook_id::text, '-', '')
$$;
revoke all on function public.qorpera_event_hook_secret_name(uuid) from public, anon, authenticated, service_role;

-- The hook's live signing secret: the company's own, never a member's of the same name; null when there is none.
create function public.qorpera_event_hook_secret(p_hook public.qorpera_event_hooks)
returns public.qorpera_cloud_secrets
language sql
stable
set search_path = ''
as $$
	select secret from public.qorpera_cloud_secrets as secret
	where secret.profile_id = p_hook.profile_id and secret.environment_id = p_hook.environment_id
		and secret.owner_kind = 'company' and secret.owner_user_id is null
		and secret.connector_id = 'event_hook' and secret.secret_name = public.qorpera_event_hook_secret_name(p_hook.id)
		and secret.status = 'active'
$$;
revoke all on function public.qorpera_event_hook_secret(public.qorpera_event_hooks)
	from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Signed hooks may be created, and their descriptor says how to save the secret
-- ---------------------------------------------------------------------------
select pg_temp.signed_hooks_patch('public.qorpera_create_event_hook(uuid,uuid,text,text,text,integer,integer)'::regprocedure,
	$old$	if p_proof <> 'address' then
		raise exception 'Only address-proven hooks can be created yet' using errcode = '0A000';
	end if;
$old$,
	'');

select pg_temp.signed_hooks_patch('public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure,
	$old$		'proof', p_hook.proof,
$old$,
	$new$		'proof', p_hook.proof,
		-- A signed hook's secret: where a member saves it (the vault's capture), and whether it is there.
		'signingSecret', case when p_hook.proof in ('stripe', 'github', 'hmac-sha256') then jsonb_build_object(
			'connectorId', 'event_hook', 'secretName', public.qorpera_event_hook_secret_name(p_hook.id),
			'ready', (public.qorpera_event_hook_secret(p_hook)).id is not null) end,
$new$);

-- A removed hook's signing secret is revoked with it, as a member's revoke would, however the hook is removed
-- (the name is bound to this hook, so nothing else uses it).
create function public.qorpera_event_hook_revoke_signing_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	with revoked as (
		update public.qorpera_cloud_secrets as secret
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = auth.uid(),
			updated_at = statement_timestamp()
		where secret.profile_id = new.profile_id and secret.environment_id = new.environment_id
			and secret.owner_kind = 'company' and secret.connector_id = 'event_hook'
			and secret.secret_name = public.qorpera_event_hook_secret_name(new.id) and secret.status = 'active'
		returning secret.*
	)
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id, environment_id, secret_id, secret_version, event_type, actor_user_id, connector_id
	)
	select revoked.profile_id, revoked.environment_id, revoked.id, revoked.current_version, 'secret_revoked',
		auth.uid(), revoked.connector_id
	from revoked;
	return null;
end
$$;
revoke all on function public.qorpera_event_hook_revoke_signing_secret() from public, anon, authenticated, service_role;
create trigger qorpera_event_hooks_revoke_signing_secret
	after update of status on public.qorpera_event_hooks
	for each row
	when (new.status = 'removed' and old.status is distinct from 'removed'
		and new.proof in ('stripe', 'github', 'hmac-sha256'))
	execute function public.qorpera_event_hook_revoke_signing_secret();

-- ---------------------------------------------------------------------------
-- 4. A signed delivery waits for the vault
-- ---------------------------------------------------------------------------
select pg_temp.signed_hooks_patch('public.qorpera_receive_event(text,text,jsonb,text)'::regprocedure,
	$old$	if v_hook.proof <> 'address' then
		-- Signed hooks are verified by the vault (W1b); until then they take nothing.
		return jsonb_build_object('outcome', 'not_ready');
	end if;
$old$,
	$new$	if v_hook.proof <> 'address' then
		-- Without its secret in the vault a signed hook takes nothing. With it, the delivery is stored as
		-- received, without a sender id or a type, until the company's broker checks its signature (W1b).
		if (public.qorpera_event_hook_secret(v_hook)).id is null then
			return jsonb_build_object('outcome', 'not_ready');
		end if;
		insert into public.qorpera_event_deliveries (
			id, hook_id, profile_id, status, content_type, headers, body, body_bytes, body_sha256
		) values (
			v_delivery_id, v_hook.id, v_hook.profile_id, 'received', p_content_type, v_headers, v_body,
			octet_length(v_body), encode(extensions.digest(v_body, 'sha256'), 'hex')
		);
		insert into public.qorpera_event_intake_usage as usage (profile_id, hour, deliveries, bytes)
		values (v_hook.profile_id, v_hour, 1, v_header_bytes + octet_length(v_body))
		on conflict (profile_id, hour) do update
		set deliveries = usage.deliveries + 1, bytes = usage.bytes + excluded.bytes;
		return jsonb_build_object('outcome', 'accepted', 'deliveryId', v_delivery_id);
	end if;
$new$);

-- ---------------------------------------------------------------------------
-- 5. The broker's functions
-- ---------------------------------------------------------------------------
-- Up to p_limit received deliveries of the broker authority's company, oldest first, each with its hook's
-- proof, the kept headers, the body and the sealed current version of the hook's secret. A delivery whose hook
-- was removed, whose secret is gone or was sealed for another authority, or that was claimed five times, is
-- refused here instead and counted in refused (up to three times p_limit of them a call), so a backlog of those
-- never hides a delivery behind it. A claim carries at most 16 bodies of at most 256 KiB (the hooks' largest).
create function public.qorpera_claim_event_verifications(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_row record;
	v_now timestamptz := clock_timestamp();
	v_claim uuid := extensions.gen_random_uuid();
	v_claimed jsonb := '[]'::jsonb;
	v_refused integer := 0;
	v_reason text;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_limit is null or p_limit not between 1 and 16 then
		raise exception 'event verification claim is invalid' using errcode = '22023';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	for v_row in
		select delivery.id, delivery.hook_id, delivery.received_at, delivery.headers, delivery.body,
			delivery.verify_attempts, hook.proof, hook.environment_id, hook.status as hook_status,
			secret.id as secret_id, secret.current_version, version.key_id, version.encrypted_envelope,
			version.envelope_sha256, version.broker_authority_id as sealed_for
		from public.qorpera_event_deliveries as delivery
		join public.qorpera_event_hooks as hook on hook.id = delivery.hook_id
		-- A function in FROM runs once a row (a row of nulls when the hook has no live secret).
		left join lateral public.qorpera_event_hook_secret(hook) as secret on true
		left join public.qorpera_cloud_secret_versions as version
			on version.secret_id = secret.id and version.version = secret.current_version
		where delivery.status = 'received' and delivery.profile_id = v_authority.profile_id
			and (delivery.verify_claim_until is null or delivery.verify_claim_until <= v_now)
		order by delivery.received_at, delivery.id
		limit p_limit * 4
		for update of delivery skip locked
	loop
		exit when jsonb_array_length(v_claimed) >= p_limit;
		v_reason := case
			when v_row.hook_status = 'removed' then 'The hook was removed'
			when v_row.proof not in ('stripe', 'github', 'hmac-sha256') then 'The hook is not signed'
			when v_row.secret_id is null or v_row.encrypted_envelope is null then 'The hook''s signing secret is gone'
			when v_row.sealed_for is distinct from v_authority.id then 'The hook''s signing secret must be saved again'
			when v_row.body is null then 'The delivery''s body is gone'
			when v_row.verify_attempts >= 5 then 'The vault could not check it'
		end;
		if v_reason is not null then
			update public.qorpera_event_deliveries
			set status = 'refused', reason = v_reason, body = null, verify_claim = null, verify_claim_until = null
			where id = v_row.id;
			v_refused := v_refused + 1;
			continue;
		end if;
		update public.qorpera_event_deliveries
		set verify_claim = v_claim, verify_claim_until = v_now + interval '60 seconds',
			verify_attempts = verify_attempts + 1
		where id = v_row.id;
		v_claimed := v_claimed || jsonb_build_array(jsonb_build_object(
			'schema', 'qorpera.event-verification/v1',
			'deliveryId', v_row.id, 'claim', v_claim,
			'companyId', v_authority.profile_id, 'environmentId', v_row.environment_id, 'hookId', v_row.hook_id,
			'proof', v_row.proof,
			-- Whole seconds since the epoch: signatures' timestamps are measured against the arrival.
			'receivedAt', floor(extract(epoch from v_row.received_at))::bigint,
			'headers', v_row.headers,
			-- One base64 line (Postgres breaks lines at 76 characters).
			'bodyBase64', translate(encode(v_row.body, 'base64'), E'\n', ''),
			'secretId', v_row.secret_id, 'secretVersion', v_row.current_version, 'keyId', v_row.key_id,
			'encryptedEnvelopeBase64', translate(encode(v_row.encrypted_envelope, 'base64'), E'\n', ''),
			'envelopeSha256', v_row.envelope_sha256
		));
	end loop;
	return jsonb_build_object('schema', 'qorpera.event-verification-claim/v1', 'deliveries', v_claimed,
		'refused', v_refused);
end
$$;
revoke all on function public.qorpera_claim_event_verifications(uuid, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_event_verifications(uuid, text, integer) to qorpera_secret_broker;

-- The broker's verdict on one claimed delivery: verified with the sender's id and the event's type (a duplicate
-- when that id was verified before), refused with a reason, or retry (the claim is released and the delivery
-- offered again after a minute times five to the attempts before; the fifth attempt's retry refuses it). Only the
-- claim that holds the delivery may answer; a stale claim changes nothing. A verified verdict is refused instead
-- when the hook was removed or its secret is gone since the claim.
create function public.qorpera_finish_event_verification(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_delivery_id uuid,
	p_claim uuid,
	p_verdict text,
	p_key text,
	p_type text,
	p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_delivery public.qorpera_event_deliveries%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_reason text;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_delivery_id is null or p_claim is null or p_verdict is null or p_verdict not in ('verified', 'refused', 'retry')
		or (p_verdict = 'verified' and (p_key is null or char_length(p_key) > 256 or p_key !~ '^[\x21-\x7e]+$'
			or p_key like 'body:%' or p_reason is not null
			or (p_type is not null and (char_length(p_type) > 128 or p_type !~ '^[\x21-\x7e]+$'))))
		or (p_verdict = 'refused' and (p_reason is null or char_length(p_reason) not between 1 and 500
			or p_reason ~ '[[:cntrl:]]' or p_key is not null or p_type is not null))
		or (p_verdict = 'retry' and (p_key is not null or p_type is not null or p_reason is not null)) then
		raise exception 'event verification verdict is invalid' using errcode = '22023';
	end if;
	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;
	select delivery.* into v_delivery from public.qorpera_event_deliveries as delivery
	where delivery.id = p_delivery_id and delivery.profile_id = v_authority.profile_id for update;
	if v_delivery.id is null or v_delivery.status <> 'received' or v_delivery.verify_claim is distinct from p_claim then
		return jsonb_build_object('outcome', 'stale');
	end if;
	if p_verdict = 'retry' and v_delivery.verify_attempts < 5 then
		update public.qorpera_event_deliveries
		set verify_claim = null,
			verify_claim_until = clock_timestamp() + interval '1 minute' * power(5, v_delivery.verify_attempts - 1)
		where id = p_delivery_id;
		return jsonb_build_object('outcome', 'retry');
	end if;
	if p_verdict = 'verified' then
		select hook.* into v_hook from public.qorpera_event_hooks as hook where hook.id = v_delivery.hook_id;
		v_reason := case
			when v_hook.id is null or v_hook.status = 'removed' then 'The hook was removed'
			when (public.qorpera_event_hook_secret(v_hook)).id is null then 'The hook''s signing secret is gone'
		end;
	else
		v_reason := coalesce(p_reason, 'The vault could not check it');
	end if;
	if v_reason is not null then
		update public.qorpera_event_deliveries
		set status = 'refused', reason = v_reason, body = null, verify_claim = null, verify_claim_until = null
		where id = p_delivery_id;
		return jsonb_build_object('outcome', 'refused');
	end if;
	-- A sender id is unique per hook among verified deliveries; the index decides a race.
	if not exists (
		select 1 from public.qorpera_event_deliveries as earlier
		where earlier.hook_id = v_delivery.hook_id and earlier.status = 'verified' and earlier.delivery_key = p_key
	) then
		begin
			update public.qorpera_event_deliveries
			set status = 'verified', delivery_key = p_key, event_type = p_type, verified_at = clock_timestamp(),
				verify_claim = null, verify_claim_until = null
			where id = p_delivery_id;
			return jsonb_build_object('outcome', 'verified');
		exception when unique_violation then
			null;
		end;
	end if;
	update public.qorpera_event_deliveries
	set status = 'duplicate', delivery_key = p_key, event_type = p_type, verified_at = clock_timestamp(), body = null,
		reason = 'An earlier delivery had this key', verify_claim = null, verify_claim_until = null
	where id = p_delivery_id;
	return jsonb_build_object('outcome', 'duplicate');
end
$$;
revoke all on function public.qorpera_finish_event_verification(uuid, text, uuid, uuid, text, text, text, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_finish_event_verification(uuid, text, uuid, uuid, text, text, text, text)
	to qorpera_secret_broker;

-- The companies of a shared vault's principal that have signed deliveries due a check (at most 1000 a call):
-- one call a pass, so the vault claims only where something waits instead of asking every company it serves.
create function public.qorpera_broker_principal_event_verifications_due(p_principal_id uuid, p_capability_sha256 text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_due jsonb;
begin
	v_principal := public.qorpera_broker_principal(p_principal_id, p_capability_sha256);
	select coalesce(jsonb_agg(due.profile_id order by due.profile_id), '[]'::jsonb) into v_due
	from (
		select distinct delivery.profile_id
		from public.qorpera_event_deliveries as delivery
		join public.qorpera_cloud_secret_broker_authorities as authority
			on authority.profile_id = delivery.profile_id and authority.principal_id = v_principal.id
				and authority.status = 'active'
		where delivery.status = 'received'
			and (delivery.verify_claim_until is null or delivery.verify_claim_until <= clock_timestamp())
		limit 1000
	) as due;
	return jsonb_build_object('schema', 'qorpera.broker-principal-event-verifications/v1', 'companyIds', v_due);
end
$$;
revoke all on function public.qorpera_broker_principal_event_verifications_due(uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_broker_principal_event_verifications_due(uuid, text) to qorpera_secret_broker;
