-- Company folder core, C4 (E3c-4, Q1): a Stripe hook whose captured secret does not match is held
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-EVENTS.md §5.8 point 5; agreed with the coordinator on 9 October 2026).
--
-- E3c-1 (20260930344000) stores the secret the vault reads off Stripe's page. If the vault read a wrong value, every
-- delivery would fail its signature check, and Stripe gives up on a delivery after 3 days of retries. So the first
-- delivery refused because its signature does not match holds the hook until the next capture: the hook answers
-- not_ready (intake's 409), and Stripe keeps the deliveries and sends them again.
-- * qorpera_event_hook_capture_keys (Stripe hooks only) keeps the newest version of the hook's secret a delivery verified
--   under, and the version held, with the held delivery's receipt time.
-- * qorpera_finish_event_verification: a refusal with the broker's words 'The Stripe signature does not match' holds the
--   version the delivery was checked under, unless a delivery verified under that version or a newer one. The answer
--   stays {"outcome": "refused"}. A verified delivery records its version, and lifts a hold on it or an older one (a
--   delivery checked beside the refused one).
-- * qorpera_receive_event answers not_ready while the hook's current version is held. It writes nothing then.
-- * qorpera_folder_read_hook_capture offers no current version while it is held, so the next capture stores a new
--   version even of the same value, and the new version is not held.
-- * The hook descriptor's lastRefusal says the hook is held, with the held delivery's receipt time.
-- GitHub and HMAC hooks have no capture key, so they are never held. A forged delivery can hold a version that never
-- verified (the risk §5.8 accepts): the hook then takes nothing until the next capture.
-- Locks: finish takes the broker authority (FOR SHARE), the delivery (FOR UPDATE), then the hook's capture key (UPDATE).
-- A capture takes the hook (FOR SHARE), its capture key (FOR UPDATE), the secret (FOR UPDATE), then the receipt. Claims
-- and receives lock no capture key, so the orders make no cycle.
-- Every inserted text names this migration (20260930345000), for the deploy guards.

do $$ begin
	if to_regclass('public.qorpera_event_hook_capture_keys') is null or position('20260930344000' in pg_get_functiondef(
		'public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure)) = 0 then
		raise exception 'E3c-4 (20260930345000) needs E3c-1 (20260930344000)'; end if;
	if position('20260930345000' in pg_get_functiondef(
		'public.qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure)) > 0 then
		raise exception 'E3c-4 (20260930345000) is already applied'; end if;
end $$;

set local lock_timeout = '3s';

-- E3c-1's helper under this migration's name: several (old, new) pairs, applied in order; each old text occurs exactly
-- once in the definition as the earlier pairs left it. The result is executed once.
create function pg_temp.e3c4_patch(p_function regprocedure, p_pairs text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception 'E3c-4 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception 'E3c-4 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	execute v_definition;
end $$;

-- 1. The hold's state, on the Stripe hook's capture key -------------------------------------------------------------------

alter table public.qorpera_event_hook_capture_keys
	add column verified_secret_version bigint check (verified_secret_version > 0),
	add column held_secret_version bigint check (held_secret_version > 0),
	add column held_at timestamptz,
	add constraint qorpera_event_hook_capture_keys_held_check check ((held_secret_version is null) = (held_at is null));
comment on column public.qorpera_event_hook_capture_keys.verified_secret_version is
	'20260930345000 (E3c-4): the newest version of the hook''s secret a delivery verified under. A version this old or older is never held.';
comment on column public.qorpera_event_hook_capture_keys.held_secret_version is
	'20260930345000 (E3c-4): the version a delivery was refused under because its Stripe signature did not match. While it is the secret''s current version, the hook answers not_ready and the broker''s capture read offers no current version.';
comment on column public.qorpera_event_hook_capture_keys.held_at is
	'20260930345000 (E3c-4): when the delivery that holds the hook was received; null when nothing is held.';

-- 2. The broker's verdict holds a version, or proves it ---------------------------------------------------------------

select pg_temp.e3c4_patch('public.qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure,
	array[
	$old$	if v_reason is not null then
		update public.qorpera_event_deliveries
$old$,
	$new$	if v_reason is not null then
		-- 20260930345000 (E3c-4): a Stripe signature that does not match holds the version it was checked under, unless a
		-- delivery verified under that version or a newer one. The hook takes nothing more until the next capture.
		if p_verdict = 'refused' and p_reason = 'The Stripe signature does not match' then
			update public.qorpera_event_hook_capture_keys as capture
			set held_secret_version = v_delivery.verify_secret_version, held_at = v_delivery.received_at
			where capture.hook_id = v_delivery.hook_id and capture.secret_id = v_delivery.verify_secret_id
				and coalesce(capture.verified_secret_version, 0) < v_delivery.verify_secret_version
				and coalesce(capture.held_secret_version, 0) < v_delivery.verify_secret_version;
		end if;
		update public.qorpera_event_deliveries
$new$,
	$old$	-- A sender id is unique per hook among verified deliveries; the index decides a race.
$old$,
	$new$	-- 20260930345000 (E3c-4): the signature matched under this version, so it is never held, and a hold on it (or on an
	-- older one) is lifted. A Stripe hook's capture key only; the other hooks have none.
	update public.qorpera_event_hook_capture_keys as capture
	set verified_secret_version = v_delivery.verify_secret_version,
		held_secret_version = case when capture.held_secret_version <= v_delivery.verify_secret_version then null
			else capture.held_secret_version end,
		held_at = case when capture.held_secret_version <= v_delivery.verify_secret_version then null else capture.held_at end
	where capture.hook_id = v_delivery.hook_id and capture.secret_id = v_delivery.verify_secret_id
		and coalesce(capture.verified_secret_version, 0) < v_delivery.verify_secret_version;
	-- A sender id is unique per hook among verified deliveries; the index decides a race.
$new$]);

-- 3. A held hook takes nothing until the next capture -------------------------------------------------------------------

select pg_temp.e3c4_patch('public.qorpera_receive_event(text,text,jsonb,text)'::regprocedure, array[
	$old$		if (public.qorpera_event_hook_secret(v_hook)).id is null then
			return jsonb_build_object('outcome', 'not_ready');
$old$,
	$new$		-- 20260930345000 (E3c-4): nor while a Stripe signature that did not match holds the secret's current version. The
		-- next capture makes a new version, which is not held.
		if (public.qorpera_event_hook_secret(v_hook)).id is null or exists (
			select 1 from public.qorpera_event_hook_secret(v_hook) as secret
			join public.qorpera_event_hook_capture_keys as capture on capture.hook_id = v_hook.id
				and capture.secret_id = secret.id and capture.held_secret_version = secret.current_version
		) then
			return jsonb_build_object('outcome', 'not_ready');
$new$]);

-- The broker's capture read offers no held version as current, so the broker never answers "unchanged" for it: a value
-- read again is stored as a new version.
select pg_temp.e3c4_patch('public.qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)'::regprocedure, array[
	$old$		|| case when v_version.broker_authority_id = v_authority.id and v_version.key_id = v_authority.key_id
$old$,
	$new$		|| case when v_version.broker_authority_id = v_authority.id and v_version.key_id = v_authority.key_id
			-- 20260930345000 (E3c-4): not while the version is held.
			and not exists (select 1 from public.qorpera_event_hook_capture_keys as capture
				where capture.hook_id = v_context.hook_id and capture.held_secret_version = v_version.version)
$new$]);

-- 4. The descriptor says the hook is held ------------------------------------------------------------------------------

select pg_temp.e3c4_patch('public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'::regprocedure, array[
	$old$			'lastRefusal', case when p_hook.proof = 'stripe' then (select jsonb_build_object('receivedAt', delivery.received_at,
				'reason', delivery.reason) from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = p_hook.id and delivery.status = 'refused' and delivery.verify_secret_id = secret.id
					and delivery.verify_secret_version = secret.current_version
				order by delivery.received_at desc, delivery.id desc limit 1) end)
$old$,
	$new$			-- 20260930345000 (E3c-4): while the current version is held, the refusal that holds it.
			'lastRefusal', case when p_hook.proof = 'stripe' then coalesce((select jsonb_build_object('receivedAt', capture.held_at,
				'reason', 'held: the captured secret does not match') from public.qorpera_event_hook_capture_keys as capture
				where capture.hook_id = p_hook.id and capture.secret_id = secret.id
					and capture.held_secret_version = secret.current_version),
				(select jsonb_build_object('receivedAt', delivery.received_at,
				'reason', delivery.reason) from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = p_hook.id and delivery.status = 'refused' and delivery.verify_secret_id = secret.id
					and delivery.verify_secret_version = secret.current_version
				order by delivery.received_at desc, delivery.id desc limit 1)) end)
$new$]);

-- 5. The deploy guard: every patched body carries the marker ----------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_finish_event_verification(uuid,text,uuid,uuid,text,text,text,text)',
		'public.qorpera_receive_event(text,text,jsonb,text)',
		'public.qorpera_folder_read_hook_capture(uuid,text,jsonb,uuid,text,text)',
		'public.qorpera_event_hook_descriptor(public.qorpera_event_hooks,boolean)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930345000') = 0 then
			raise exception 'E3c-4 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
