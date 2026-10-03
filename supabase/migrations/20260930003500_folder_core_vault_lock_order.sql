-- Company folder core C1c-3d-2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md; the coordinator's audit P03): the
-- vault's own changes take their locks in core §3's order on folder-v2 companies, so they never deadlock with an agent's
-- tool call or with a member change. Folder-v2 only and inert: no folder-v2 company exists yet. Snapshot-v1 keeps its
-- order, where the gc fence (the company row FOR UPDATE of every tool call) makes them take turns (20260928419980).
--
-- Rank 8 (vault rows) has an inner order: capture tickets, then grants, then secrets, each by id. A folder-v2 tool call
-- takes the company row only KEY SHARE (rank 0) and then its grant FOR SHARE before the grant's secret
-- (qorpera_native_connector_locked_grant); a member change takes the member FOR UPDATE (rank 1) and then the member's
-- tickets, grants and secrets (qorpera_folder_member_change_enter). Today's functions took other orders:
-- * Disconnect (qorpera_revoke_cloud_secret) locked the secret and then updated its grants: against an agent call holding
--   one of those grants and waiting for the secret, a cycle. It now locks the secret's active grants first.
-- * Sharing (qorpera_grant_cloud_connector) locked the secret and then the (agent, tool) grants it replaces: the same
--   cycle. It now locks those grants first.
-- * The broker's seal of a company connection (qorpera_complete_cloud_secret_capture, a first capture or a rotation,
--   sharing through qorpera_share_company_connection) took the secret, or none, and then the agents' grants of the
--   connector's tools one by one by agent and operation: against an agent call, or a Disconnect taking them by id, a
--   cycle. It now locks those grants by id before the secret. (The share itself is unchanged: the seal is its only
--   caller and then already holds those grants.) It also locked the ticket before its creator's member row: against a
--   removal or demotion of that creator (member, then the creator's tickets), a cycle. It now takes the member row
--   first.
-- * A rotation's start (qorpera_begin_cloud_secret_capture) locked the secret and the stale tickets before the ticket
--   insert's member check (the caller's member row FOR SHARE): against the caller's removal (member, then its own
--   secrets), a cycle. It now takes the member row, then the stale tickets, then the secret.
-- * Granting one operation (qorpera_grant_cloud_secret_operation) took the agent's staff row (rank 2) after the secret.
--   It now takes it before.
-- The grant locks these take before the secret can miss a grant created while they waited. A Disconnect takes a grant
-- on the secret that it did not pre-lock NOWAIT once the secret is held: an agent call may hold it and wait for the
-- secret. A share or a seal (qorpera_grant_cloud_connector_operations) takes every grant it did not pre-lock NOWAIT,
-- whichever secret it is on: its holder may wait for a grant this change holds. Either way 55P03 refuses retryably
-- (never 40001: test 361). A rotation's start takes a pending ticket that expired while it waited for the secret NOWAIT
-- too: the broker's seal of that ticket may hold it and wait for the secret.
--
-- Exact-text patches: each fails unless its text is found exactly once. Each patched function names this migration
-- (20260930003500) in a comment, for deploy guards.

set local lock_timeout = '3s';

create function pg_temp.folder_vault_order_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% differs from the text this migration patches, near %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- Disconnect: the secret's active grants before the secret.
select pg_temp.folder_vault_order_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$old$,
$new$	-- Folder-v2 (20260930003500): an agent call holds its grant and then waits for the secret, so the grants come first.
	if public.qorpera_company_is_folder_v2(p_profile_id) then
		perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.secret_id = p_secret_id and grant_row.profile_id = p_profile_id and grant_row.status = 'active'
		order by grant_row.id for update;
	end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id for update;$new$);
select pg_temp.folder_vault_order_patch('public.qorpera_revoke_cloud_secret(uuid,uuid)'::regprocedure,
$old$		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$old$,
$new$		-- A grant created while this waited (20260930003500): an agent call may hold it and wait for the secret.
		if public.qorpera_company_is_folder_v2(p_profile_id) then
			perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
			where grant_row.secret_id = v_secret.id and grant_row.status = 'active' order by grant_row.id for update nowait;
		end if;
		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked',revoked_at = statement_timestamp(),revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and status = 'active';$new$);

-- Sharing: the grants it may replace (the agents' active grants of the connector's tools) before the secret.
select pg_temp.folder_vault_order_patch(
	'public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[])'::regprocedure,
$old$	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$old$,
$new$	-- Folder-v2 (20260930003500): the grants this may replace before the secret, as an agent call takes them.
	if public.qorpera_company_is_folder_v2(p_profile_id) then
		perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id = p_profile_id and grant_row.environment_id = p_environment_id
			and grant_row.status = 'active'
			and (p_staff_agent_ids is null or grant_row.staff_agent_id = any (p_staff_agent_ids))
			and grant_row.tool_name in (select operation.tool_name from public.qorpera_cloud_connector_operations as operation
				join public.qorpera_cloud_secrets as secret on secret.connector_id = operation.connector_id
				-- A secret of another company or environment locks nothing: the strict select below refuses it.
				where secret.id = p_secret_id and secret.profile_id = p_profile_id
					and secret.environment_id = p_environment_id and operation.status = 'active')
		order by grant_row.id for update;
	end if;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$new$);

-- The grants a share or a seal replaces, once the secret is held: on folder-v2, NOWAIT.
select pg_temp.folder_vault_order_patch(
	'public.qorpera_grant_cloud_connector_operations(uuid,uuid,uuid,uuid,uuid[])'::regprocedure,
$old$			select existing.* into v_existing from public.qorpera_cloud_secret_operation_grants as existing
			where existing.profile_id = p_profile_id and existing.environment_id = p_environment_id
				and existing.staff_agent_id = v_agent and existing.tool_name = v_operation.tool_name
				and existing.status = 'active'
			for update;$old$,
$new$			-- Folder-v2 (20260930003500): the share and the seal locked the agents' active grants of these tools by id
			-- before the secret, so they hold these already. One they do not hold was created while they waited, and its
			-- holder (an agent call, a Disconnect of another secret) may wait for a row they hold: NOWAIT, 55P03. The
			-- third caller, the staff trigger granting a new or returning agent, finds none but its own: such an agent
			-- has no active grants (archiving revokes them, and a grant needs active staff).
			if public.qorpera_company_is_folder_v2(p_profile_id) then
				select existing.* into v_existing from public.qorpera_cloud_secret_operation_grants as existing
				where existing.profile_id = p_profile_id and existing.environment_id = p_environment_id
					and existing.staff_agent_id = v_agent and existing.tool_name = v_operation.tool_name
					and existing.status = 'active'
				for update nowait;
			else
				select existing.* into v_existing from public.qorpera_cloud_secret_operation_grants as existing
				where existing.profile_id = p_profile_id and existing.environment_id = p_environment_id
					and existing.staff_agent_id = v_agent and existing.tool_name = v_operation.tool_name
					and existing.status = 'active'
				for update;
			end if;$new$);

-- The seal: the creator's member row before the ticket; a company connection's grants before the secret.
select pg_temp.folder_vault_order_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
$old$	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;$old$,
$new$	-- Folder-v2 (20260930003500): the creator's member row (rank 1) before the ticket (rank 8), as a member change
	-- takes them.
	perform 1 from public.qorpera_profile_members as member
	join public.qorpera_cloud_secret_capture_tickets as ticket on ticket.id = p_ticket_id
		and ticket.broker_authority_id = v_authority.id
	where public.qorpera_company_is_folder_v2(ticket.profile_id)
		and member.profile_id = ticket.profile_id and member.user_id = ticket.created_by_user_id
	for share of member;
	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;$new$);
select pg_temp.folder_vault_order_patch(
	'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)'::regprocedure,
$old$	if v_ticket.target_version = 1 then
		insert into public.qorpera_cloud_secrets ($old$,
$new$	-- Folder-v2 (20260930003500): a company connection's share (first capture or rotation) replaces grants an agent
	-- call may hold while it waits for the secret, so they come by id before the secret's insert or update.
	if v_ticket.owner_kind = 'company'
		and public.qorpera_company_is_folder_v2(v_ticket.profile_id) then
		perform 1 from public.qorpera_cloud_secret_operation_grants as grant_row
		where grant_row.profile_id = v_ticket.profile_id and grant_row.environment_id = v_ticket.environment_id
			and grant_row.status = 'active'
			and grant_row.tool_name in (select operation.tool_name from public.qorpera_cloud_connector_operations as operation
				where operation.connector_id = v_ticket.connector_id and operation.status = 'active')
		order by grant_row.id for update;
	end if;
	if v_ticket.target_version = 1 then
		insert into public.qorpera_cloud_secrets ($new$);

-- A rotation's start: the caller's member row, then the stale tickets, then the secret.
select pg_temp.folder_vault_order_patch(
	'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure,
$old$			perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
		end if;
		select secret.* into strict v_secret$old$,
$new$			perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
			-- Folder-v2 (20260930003500): the caller's member row (rank 1; the ticket insert checks it), then the stale
			-- tickets this expires, then the secret (rank 8: tickets, grants, secrets).
			if public.qorpera_company_is_folder_v2(p_profile_id) then
				perform 1 from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id and member.user_id = v_user_id for share;
				perform 1 from public.qorpera_cloud_secret_capture_tickets as ticket
				where ticket.secret_id = p_existing_secret_id and ticket.target_version > 1 and ticket.status = 'pending'
					and ticket.expires_at <= statement_timestamp()
				order by ticket.id for update;
			end if;
		end if;
		select secret.* into strict v_secret$new$);

-- The rotation's start expires the stale tickets: those it locked before the secret, and NOWAIT one that expired while
-- it waited (a seal that checked the ticket in time may hold it and wait for the secret: 55P03, never a deadlock).
select pg_temp.folder_vault_order_patch(
	'public.qorpera_begin_cloud_secret_capture(uuid,uuid,text,uuid,text,text,text,uuid)'::regprocedure,
$old$		where secret_id = v_secret.id and target_version > 1 and status = 'pending'
			and expires_at <= clock_timestamp();$old$,
$new$		where secret_id = v_secret.id and target_version > 1 and status = 'pending'
			and expires_at <= clock_timestamp()
			-- Folder-v2 (20260930003500): a ticket that expired since the pre-lock is taken NOWAIT.
			and (not public.qorpera_company_is_folder_v2(p_profile_id) or id in (
				select stale.id from public.qorpera_cloud_secret_capture_tickets as stale
				where stale.secret_id = v_secret.id and stale.target_version > 1 and stale.status = 'pending'
					and stale.expires_at <= clock_timestamp()
				for update nowait));$new$);

-- Granting one operation: the agent's staff row (rank 2) before the secret (rank 8).
select pg_temp.folder_vault_order_patch(
	'public.qorpera_grant_cloud_secret_operation(uuid,uuid,uuid,uuid,text,text,bigint,timestamptz)'::regprocedure,
$old$	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$old$,
$new$	-- Folder-v2 (20260930003500): the agent's staff row (rank 2) before the secret (rank 8).
	if public.qorpera_company_is_folder_v2(p_profile_id) then
		perform 1 from public.qorpera_profile_staff staff where staff.profile_id = p_profile_id
			and staff.staff_agent_id = p_staff_agent_id for share;
	end if;
	select secret.* into v_secret from public.qorpera_cloud_secrets secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;$new$);

drop function pg_temp.folder_vault_order_patch(regprocedure, text, text);
