-- A member's pinned login follows them to their new login (28 Sep 2026, S2 step 1b).
--
-- Routine versions pin (sponsor binding, version), and a coding session pins its owner's
-- (binding, version) at dispatch. When a member signs in again (a new connection) and the old
-- connection is revoked, those pins stopped working: routines were cancelled and paused after
-- three refusals, and a coding session could not take another turn. Agent follow-up work already
-- resolves the starter's live login when it is created (20260928170000).
--
-- qorpera_move_member_login_pins moves every binding that currently pays with the member's old
-- connection to their new one, as a new version of the same binding (the shape of the
-- usage-limit handoff: same owner, same kind). Routine wakes and coding turns created afterwards
-- take the binding's latest same-owner version, and routine authorization, the wake policy and
-- coding admission accept a later same-owner version of the pinned binding. The Stateless Compute
-- vault calls it when it switches a member's old node login off (S1, 20260928188000); a member's
-- login still pays only for that member's work (the new version has the same owner).
--
-- Row locks only (the moved bindings, the two connection rows); no company-wide lock.

-- A later version of the same binding stands for the pinned one only when it has the same kind
-- and pays with a connection of the same owner, company and provider.
create function public.qorpera_sponsor_version_follows(p_binding_id uuid, p_pinned bigint, p_candidate bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_candidate = p_pinned or coalesce((
		select p_candidate > p_pinned and later.sponsor_kind = pinned.sponsor_kind
			and later_connection.profile_id = pinned_connection.profile_id
			and later_connection.provider = pinned_connection.provider
			and later_connection.owner_user_id is not distinct from pinned_connection.owner_user_id
		from public.qorpera_execution_sponsor_versions as pinned
		join public.qorpera_provider_connections as pinned_connection on pinned_connection.id = pinned.provider_connection_id
		join public.qorpera_execution_sponsor_versions as later on later.binding_id = pinned.binding_id and later.version = p_candidate
		join public.qorpera_provider_connections as later_connection on later_connection.id = later.provider_connection_id
		where pinned.binding_id = p_binding_id and pinned.version = p_pinned), false)
$$;
revoke all on function public.qorpera_sponsor_version_follows(uuid, bigint, bigint) from public, anon, authenticated;

-- The version a new wake takes for a pinned (binding, version): the binding's latest version when
-- it follows the pinned one, else the pinned version.
create function public.qorpera_live_sponsor_version(p_binding_id uuid, p_pinned bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	select coalesce((
		select latest.version from public.qorpera_execution_sponsor_versions as latest
		where latest.binding_id = p_binding_id
			and latest.version = (select max(newest.version) from public.qorpera_execution_sponsor_versions as newest
				where newest.binding_id = p_binding_id)
			and public.qorpera_sponsor_version_follows(p_binding_id, p_pinned, latest.version)), p_pinned)
$$;
revoke all on function public.qorpera_live_sponsor_version(uuid, bigint) from public, anon, authenticated;

create function public.qorpera_move_member_login_pins(p_profile_id uuid, p_member_user_id uuid,
	p_old_connection_id uuid, p_new_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_old public.qorpera_provider_connections%rowtype;
	v_new public.qorpera_provider_connections%rowtype;
	v_new_version public.qorpera_provider_connection_versions%rowtype;
	v_binding record;
	v_next bigint;
	v_moved jsonb := '[]'::jsonb;
	v_bindings uuid[] := '{}'::uuid[];
	v_routines integer;
	v_coding integer;
begin
	-- Connection rows in id order, so two moves between the same logins never wait on each other.
	perform 1 from public.qorpera_provider_connections
	where id in (p_old_connection_id, p_new_connection_id) order by id for share;
	select * into v_old from public.qorpera_provider_connections where id = p_old_connection_id;
	select * into v_new from public.qorpera_provider_connections where id = p_new_connection_id;
	if p_profile_id is null or p_member_user_id is null or v_old.id is null or v_new.id is null or v_old.id = v_new.id
		or v_old.profile_id <> p_profile_id or v_new.profile_id <> p_profile_id
		or v_old.owner_user_id is distinct from p_member_user_id or v_new.owner_user_id is distinct from p_member_user_id
		or v_old.provider <> v_new.provider
		or exists (select 1 from public.qorpera_provider_connection_versions as version
			where version.connection_id in (v_old.id, v_new.id) and version.native_harness = 'claude-code') then
		raise exception 'Member login pins move is invalid' using errcode = '22023'; end if;
	select * into v_new_version from public.qorpera_provider_connection_versions
	where connection_id = v_new.id order by version desc limit 1;
	if v_new.status <> 'active' or v_new_version.authorization_state is distinct from 'active'
		or not public.qorpera_provider_execution_enabled(v_new.provider, v_new_version.authentication_mode,
			v_new_version.native_harness) then
		return jsonb_build_object('schema','qorpera.member-login-pins/v1','status','refused','reason','new_login_unavailable');
	end if;
	-- A binding that allows unattended use keeps it, or nothing moves.
	if not v_new_version.allow_autonomous and exists (
		select 1 from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
			and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
				where latest.binding_id = binding.id)
		where binding.profile_id = p_profile_id and binding.status = 'active'
			and sponsor.sponsor_kind = 'member_connection' and sponsor.provider_connection_id = v_old.id
			and sponsor.allow_autonomous) then
		return jsonb_build_object('schema','qorpera.member-login-pins/v1','status','refused','reason','new_login_not_autonomous');
	end if;
	-- Every active binding whose latest version pays with the old connection, locked in id order.
	for v_binding in
		select binding.id, binding.created_by_user_id, sponsor.version, sponsor.sponsor_kind, sponsor.allow_autonomous
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
			and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
				where latest.binding_id = binding.id)
		where binding.profile_id = p_profile_id and binding.status = 'active'
			and sponsor.sponsor_kind = 'member_connection' and sponsor.provider_connection_id = v_old.id
		order by binding.id
		for update of binding
	loop
		select coalesce(max(version), 0) + 1 into v_next from public.qorpera_execution_sponsor_versions
		where binding_id = v_binding.id;
		insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
			provider_connection_version, allow_autonomous, created_by_user_id)
		values (v_binding.id, v_next, v_binding.sponsor_kind, v_new.id, v_new_version.version,
			v_binding.allow_autonomous and v_new_version.allow_autonomous, v_binding.created_by_user_id);
		v_bindings := v_bindings || v_binding.id;
		v_moved := v_moved || jsonb_build_array(jsonb_build_object('bindingId', v_binding.id,
			'fromVersion', v_binding.version, 'toVersion', v_next));
	end loop;
	select count(*) into v_routines from public.qorpera_cloud_routines as routine
	join public.qorpera_cloud_routine_versions as version on version.routine_id = routine.id
		and version.version = routine.current_version
	where routine.profile_id = p_profile_id and routine.status in ('active','paused')
		and version.sponsor_binding_id = any(v_bindings);
	select count(*) into v_coding from public.qorpera_runtime_workers as worker
	where worker.profile_id = p_profile_id and worker.species = 'coding'
		and worker.owner_sponsor_binding_id = any(v_bindings)
		and (worker.state = 'active' or worker.completion_state = 'waiting');
	return jsonb_build_object('schema','qorpera.member-login-pins/v1','status','moved','bindings',v_moved,
		'routineVersions',v_routines,'codingWorkers',v_coding);
end
$$;
-- Gated by grants: the service role, or a SECURITY DEFINER caller owned by the migration owner
-- (the vault's switch-off runs under the broker's database login, without JWT claims).
revoke all on function public.qorpera_move_member_login_pins(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.qorpera_move_member_login_pins(uuid, uuid, uuid, uuid) to service_role;

-- Each patch below replaces exact text of the current definition, once, and fails loudly when
-- that text differs (a later migration changed the function first).
create function pg_temp.login_pins_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'login pins follow: % differs', p_what; end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_pin_wake_occurrence()'::regprocedure);
begin
	v_definition := pg_temp.login_pins_replace(v_definition, $old$		new.sponsor_binding_id := v_version.sponsor_binding_id; new.sponsor_version := v_version.sponsor_version;$old$,
$new$		new.sponsor_binding_id := v_version.sponsor_binding_id;
		new.sponsor_version := public.qorpera_live_sponsor_version(v_version.sponsor_binding_id, v_version.sponsor_version);$new$, 'routine wake version');
	v_definition := pg_temp.login_pins_replace(v_definition, $old$			select w.owner_sponsor_binding_id, w.owner_sponsor_version into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;$old$,
$new$			select w.owner_sponsor_binding_id, public.qorpera_live_sponsor_version(w.owner_sponsor_binding_id, w.owner_sponsor_version)
			into new.sponsor_binding_id, new.sponsor_version
			from public.qorpera_runtime_workers w where w.id = new.source_id;$new$, 'coding turn version');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure);
begin
	v_definition := pg_temp.login_pins_replace(v_definition, $old$			and v.sponsor_binding_id = p_wake.sponsor_binding_id and v.sponsor_version = v_standing_version$old$,
$new$			and v.sponsor_binding_id = p_wake.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version, v_standing_version)$new$, 'routine authorization version');
	v_definition := pg_temp.login_pins_replace(v_definition, $old$					and w.owner_sponsor_binding_id = p_wake.sponsor_binding_id and w.owner_sponsor_version = p_wake.sponsor_version$old$,
$new$					and w.owner_sponsor_binding_id = p_wake.sponsor_binding_id
					and public.qorpera_sponsor_version_follows(w.owner_sponsor_binding_id, w.owner_sponsor_version, p_wake.sponsor_version)$new$, 'coding authorization version');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
begin
	v_definition := pg_temp.login_pins_replace(v_definition, $old$			and v.sponsor_binding_id = v_run.sponsor_binding_id and v.sponsor_version = public.qorpera_wake_standing_sponsor_version(v_wake)$old$,
$new$			and v.sponsor_binding_id = v_run.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version,
				public.qorpera_wake_standing_sponsor_version(v_wake))$new$, 'wake policy routine version');
	execute v_definition;
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_manage_agent_routine(jsonb,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.login_pins_replace(v_definition, $old$				where sponsor.binding_id = v_version.sponsor_binding_id and sponsor.version = v_version.sponsor_version) then$old$,
$new$				where sponsor.binding_id = v_version.sponsor_binding_id
					and public.qorpera_sponsor_version_follows(sponsor.binding_id, v_version.sponsor_version, sponsor.version)) then$new$, 'routine resume version');
	execute v_definition;
end
$$;
