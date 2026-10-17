-- F3 step 5j-4 (review r3 of #1272, F1; design agreed with the coordinator on 17 October 2026): a coding machine's
-- masking history, from the vault.
--
-- The executor masks a command's output with the values it asked the broker for. After a rotation and an executor
-- restart, a process that outlived both could print an older value the new executor never saw. So:
-- 1. Each environment_secret_used row records the machine the session was attached to (coding_machine_id; null when
--    it had none).
-- 2. qorpera_authorize_coding_environment also answers maskSecrets: the older versions used on that machine by the
--    session's member, sealed as the vault keeps them, for the broker to open for the output's mask only. They never
--    go into an environment, and serving them writes no audit row (they were audited when they were used).
-- Only what the vault still serves comes back: a revoked secret (Disconnect, its member's departure) never does.
-- A broker older than this one refuses an answer with maskSecrets, so this goes out with the runtime that reads it or
-- after. The patched body names 20260930514000, for the deploy guard.

set local lock_timeout = '3s';

-- A second run stops here, before anything changes; so does a database without 5j-6a's patch of the function.
do $$ begin
	if exists (select 1 from pg_attribute where attrelid = 'public.qorpera_cloud_secret_audit_events'::regclass
		and attname = 'coding_machine_id' and not attisdropped) then
		raise exception '5j-4 (20260930514000) is already applied'; end if;
	if position('20260930440000' in pg_get_functiondef(
		'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure)) = 0 then
		raise exception '5j-4 (20260930514000) needs 5j-6a (20260930440000)'; end if;
end $$;

create function pg_temp.mask_history_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% differs from the text this migration patches, near %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The machine on the audit row ------------------------------------------------------------------------------------

-- A plain uuid, as coding_worker_id is: the row outlives the machine's record.
alter table public.qorpera_cloud_secret_audit_events
	add column coding_machine_id uuid,
	add constraint qorpera_cloud_secret_audit_events_coding_machine check (
		event_type = 'environment_secret_used' or coding_machine_id is null
	);

comment on column public.qorpera_cloud_secret_audit_events.coding_machine_id is
	'20260930514000 (5j-4): the coding machine the session was attached to when an environment secret was used (null '
	'when it had none); set only on environment_secret_used. A machine''s masks are built from these rows.';

-- The history read: one machine's uses of one version, newest first.
create index qorpera_cloud_secret_audit_coding_machine
	on public.qorpera_cloud_secret_audit_events (coding_machine_id, secret_id, secret_version, created_at desc, id desc)
	where event_type = 'environment_secret_used' and coding_machine_id is not null;

-- 2. The broker's read -----------------------------------------------------------------------------------------------

-- Each use names the session's machine. The answer's maskSecrets: the versions used on that machine by a session of
-- the same member, newest use first, at most 64 and 256 KiB of envelopes, never one this answer serves.
select pg_temp.mask_history_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$	v_member_role public.qorpera_profile_members.role%type; -- 20260930440000 (5j-6a)
$old$,
	$new$	v_member_role public.qorpera_profile_members.role%type; -- 20260930440000 (5j-6a)
	v_mask_secrets jsonb; -- 20260930514000 (5j-4)
$new$);
select pg_temp.mask_history_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$			profile_id,environment_id,secret_id,secret_version,event_type,connector_id,coding_worker_id
		) values (
			v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,
			'environment_secret_used',v_secret.connector_id,v_worker.id
		);
$old$,
	$new$			profile_id,environment_id,secret_id,secret_version,event_type,connector_id,coding_worker_id,
			coding_machine_id
		) values (
			v_secret.profile_id,v_secret.environment_id,v_secret.id,v_secret.current_version,
			'environment_secret_used',v_secret.connector_id,v_worker.id,
			v_session.attached_machine_id -- 20260930514000 (5j-4): the machine, for its masks' history
		);
$new$);
select pg_temp.mask_history_patch(
	'public.qorpera_authorize_coding_environment(uuid,text,uuid,uuid,text)'::regprocedure,
	$old$	return jsonb_build_object(
		'schema','qorpera.coding-environment-authorization/v1',
		'companyId',v_session.profile_id,'environmentId',v_session.environment_id,
		'workerId',v_worker.id,'repository',v_session.repository,
		'secrets',v_secrets
	);
$old$,
	$new$	-- 20260930514000 (5j-4): the older versions used on the session's machine by a session of its member, for the
	-- output's mask only, never an environment. Only those of a secret the vault still serves here (active, this
	-- environment's, named as above), sealed by this broker under its current key (others are skipped), and none this
	-- answer serves; newest use first, at most 64 and 256 KiB of envelopes. No session attached, none. Versions are
	-- never changed, so this reads without a lock: a Disconnect that commits meanwhile drops its versions from the next
	-- answer. They were audited when used; serving them here writes no row.
	select coalesce(jsonb_agg(jsonb_build_object(
		'name',upper(history.secret_name),'secretId',history.secret_id,'secretVersion',history.version,
		'keyId',history.key_id,'ownerKind',history.owner_kind,
		'encryptedEnvelopeBase64',encode(history.encrypted_envelope,'base64'),
		'envelopeSha256',history.envelope_sha256
	) order by history.used_at desc, history.used_id desc), '[]'::jsonb) into v_mask_secrets
	from (
		select secret.secret_name, secret.owner_kind, version.secret_id, version.version, version.key_id,
			version.encrypted_envelope, version.envelope_sha256, used.created_at as used_at, used.id as used_id,
			row_number() over newest as nth, sum(octet_length(version.encrypted_envelope)) over newest as bytes
		from public.qorpera_cloud_secrets as secret
		join public.qorpera_cloud_secret_versions as version on version.secret_id = secret.id
		cross join lateral (
			select audit.id, audit.created_at
			from public.qorpera_cloud_secret_audit_events as audit
			join public.qorpera_runtime_workers as used_by on used_by.id = audit.coding_worker_id
			where audit.coding_machine_id = v_session.attached_machine_id
				and audit.event_type = 'environment_secret_used'
				and audit.secret_id = version.secret_id and audit.secret_version = version.version
				and audit.profile_id = v_session.profile_id and audit.environment_id = v_session.environment_id
				and used_by.profile_id = v_session.profile_id and used_by.owner_user_id = v_worker.owner_user_id
			order by audit.created_at desc, audit.id desc
			limit 1
		) as used
		where secret.profile_id = v_session.profile_id and secret.environment_id = v_session.environment_id
			and secret.connector_id = 'environment' and secret.status = 'active'
			and secret.broker_authority_id = v_authority.id
			and public.qorpera_coding_environment_name_allowed(secret.secret_name)
			and (secret.owner_kind = 'company' or secret.owner_user_id = v_worker.owner_user_id)
			and version.broker_authority_id = v_authority.id and version.key_id = v_authority.key_id
			and not (secret.id = any(v_secret_ids) and version.version = secret.current_version)
		window newest as (order by used.created_at desc, used.id desc rows between unbounded preceding and current row)
	) as history
	where history.nth <= 64 and history.bytes <= 262144;
	return jsonb_build_object(
		'schema','qorpera.coding-environment-authorization/v1',
		'companyId',v_session.profile_id,'environmentId',v_session.environment_id,
		'workerId',v_worker.id,'repository',v_session.repository,
		'secrets',v_secrets,'maskSecrets',v_mask_secrets
	);
$new$);

drop function pg_temp.mask_history_patch(regprocedure, text, text);
