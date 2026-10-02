-- The company row first in a member's or the broker's change to a vault row (found by #653's review, reproduced on a
-- local database). A connector tool call validates its lease, which locks the company's profile row FOR UPDATE (the
-- gc fence), and then share-locks its grant and the grant's secret (qorpera_native_connector_locked_grant,
-- qorpera_authorize_cloud_secret_operation). Six functions took the other order: they locked a secret, a grant or a
-- capture ticket first, and the company row only at their first insert, whose foreign key to qorpera_profiles takes
-- its key share (a grant, a capture ticket or the audit row). When both ran on one secret, each waited for the other:
-- "deadlock detected" on qorpera_profiles, and one side was killed. That was a member's Disconnect of a Gmail, Drive
-- or GitHub connection (qorpera_revoke_cloud_secret), giving an agent one operation of it
-- (qorpera_grant_cloud_secret_operation), withdrawing an agent's grant (qorpera_revoke_cloud_secret_grant), sharing
-- it with agents (qorpera_grant_cloud_connector) or starting its rotation (qorpera_begin_cloud_secret_capture), and
-- the broker sealing a rotation (qorpera_complete_cloud_secret_capture), each while an agent call used the secret.
--
-- Each now takes the company row's key share before any vault row, as rank 0 of the one lock order
-- (deploy/first-node/RUNTIME-COMPANY-FOLDER-CORE.md §3 step 4, §9) and as
-- qorpera_authorize_coding_repository_credential already does. An agent call that holds the company row makes the
-- change wait at that row, holding nothing the call needs; a change that holds the key share makes the next agent
-- call's lease wait for it. Both land.
--
-- Who still never waits: a caller the function refuses for its authority, or for an id nobody has. The plain checks
-- stay before the key share; refusals that depend on a row's state (a revoked secret, an inactive agent, a capture's
-- code) are decided under the locks, as before, and now wait at the company row first. The three member functions
-- that read the caller's membership FOR SHARE first now read it plainly, refuse there and in their plain check of
-- the row (20260928339820's), take the key share, and then read the membership FOR SHARE again (members are rank 1),
-- so a member who lost the role while the call waited is still refused, as before. The share read the role once,
-- without a lock, so an admin who lost the role while it waited still shared; it now reads it again after the key
-- share too. qorpera_revoke_cloud_secret_grant had no plain check of the grant: it locked the grant and then checked
-- the caller. It now refuses before any lock the caller its locked check refuses, with the same error. The share and
-- the rotation take the key share only for a secret that exists: their plain checks have refused every other caller
-- of an existing secret by then, and a call for a secret nobody has gets its error as before, without waiting. The
-- broker takes it only for a ticket its own authority issued. Each inserted lock names this migration, for deploy
-- guards.
--
-- Exact-text patches: each fails unless its text is found exactly once.

set local lock_timeout = '3s';

create function pg_temp.cloud_secret_lock_order_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% differs from the text this migration patches, near %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- Disconnecting a connection: an owner or admin for the company's, its owner for a member's.
select pg_temp.cloud_secret_lock_order_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	if not exists$old$,
$new$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null then raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	if not exists$new$);
select pg_temp.cloud_secret_lock_order_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$old$,
$new$	-- The company row first (rank 0, 20260929999900): the audit row's key needs it, and an agent call on this
	-- secret holds it.
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then raise exception 'secret revocation is unavailable' using errcode = '42501'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$new$);

-- Giving an agent one operation of a connection: as the revocation, and never by a viewer.
select pg_temp.cloud_secret_lock_order_patch(
	'public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamp with time zone)'::regprocedure,
$old$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role = 'viewer' then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	if not exists$old$,
$new$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null or v_role = 'viewer' then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	if not exists$new$);
select pg_temp.cloud_secret_lock_order_patch(
	'public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamp with time zone)'::regprocedure,
$old$	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$old$,
$new$	-- The company row first (rank 0, 20260929999900): the grant's and the audit row's keys need it, and an agent
	-- call on this secret holds it.
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null or v_role = 'viewer' then
		raise exception 'secret grant authority is unavailable' using errcode = '42501'; end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$new$);

-- Withdrawing an agent's grant: as the revocation of its secret. The plain check is the locked check's test of the
-- caller; an id nobody has is refused with the error it got.
select pg_temp.cloud_secret_lock_order_patch('public.qorpera_revoke_cloud_secret_grant(uuid,uuid)'::regprocedure,
$old$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	select grant_row.* into v_grant from public.qorpera_cloud_secret_operation_grants grant_row
	where grant_row.id = p_grant_id and grant_row.profile_id = p_profile_id for update;$old$,
$new$	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	if v_role is null then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_cloud_secret_operation_grants as grant_row
		join public.qorpera_cloud_secrets as secret on secret.id = grant_row.secret_id
		where grant_row.id = p_grant_id and grant_row.profile_id = p_profile_id
			and ((secret.owner_kind = 'company' and v_role not in ('owner','admin'))
				or (secret.owner_kind = 'member' and secret.owner_user_id is distinct from v_user_id)) is not true) then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	-- The company row first (rank 0, 20260929999900): the audit row's key needs it, and an agent call on this
	-- grant holds it.
	perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
	select member.role into v_role from public.qorpera_profile_members member
	where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	if v_role is null then
		raise exception 'secret grant revocation is unavailable' using errcode = '42501'; end if;
	select grant_row.* into v_grant from public.qorpera_cloud_secret_operation_grants grant_row
	where grant_row.id = p_grant_id and grant_row.profile_id = p_profile_id for update;$new$);

-- Sharing a company connection with agents: an owner or admin, who passed the plain check above when the secret
-- exists, and is one still after the key share (the locked check reads the role read there).
select pg_temp.cloud_secret_lock_order_patch('public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[])'::regprocedure,
$old$	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$old$,
$new$	-- The company row first (rank 0, 20260929999900): the grants' and audit rows' keys need it, and an agent call
	-- on this secret holds it. Not for a secret nobody has, whose error stays the strict select's. The role is read
	-- again under the lock.
	if exists (select 1 from public.qorpera_cloud_secrets as secret
		where secret.id = p_secret_id and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id) then
		perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
		select member.role::text into v_role from public.qorpera_profile_members as member
		where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
	end if;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$new$);

-- Starting a rotation: the secret's rotator, who passed the plain check above when the secret exists.
select pg_temp.cloud_secret_lock_order_patch(
	'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure,
$old$		select secret.* into strict v_secret
		from public.qorpera_cloud_secrets as secret
		where secret.id = p_existing_secret_id
			and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
		for update;$old$,
$new$		-- The company row first (rank 0, 20260929999900): the ticket's and the audit row's keys need it, and an
		-- agent call on this secret holds it. Not for a secret nobody has, whose error stays the strict select's.
		if exists (select 1 from public.qorpera_cloud_secrets as secret
			where secret.id = p_existing_secret_id
				and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id) then
			perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
		end if;
		select secret.* into strict v_secret
		from public.qorpera_cloud_secrets as secret
		where secret.id = p_existing_secret_id
			and secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
		for update;$new$);

-- The broker sealing a capture: the company of a ticket its own authority issued.
select pg_temp.cloud_secret_lock_order_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
$old$	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;$old$,
$new$	-- The company row first (rank 0, 20260929999900), before the ticket and the secret: the audit row's key needs
	-- it, and an agent call on a rotated secret holds it.
	perform 1 from public.qorpera_profiles as profile where profile.id = (select ticket.profile_id
		from public.qorpera_cloud_secret_capture_tickets as ticket
		where ticket.id = p_ticket_id and ticket.broker_authority_id = v_authority.id) for key share;
	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;$new$);

drop function pg_temp.cloud_secret_lock_order_patch(regprocedure, text, text);
