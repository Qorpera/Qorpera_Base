set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_member_coding_default(uuid,uuid)') is not null then
		raise exception '20260930909000 is already applied';
	end if;
	if to_regclass('public.qorpera_member_default_models') is null
		or to_regprocedure('public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)') is null
		or to_regprocedure('public.qorpera_claude_login_run(uuid,text,jsonb,boolean,boolean)') is null
		or to_regprocedure('public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions,public.qorpera_runtime_workers)') is null then
		raise exception '20260930909000 requires member default models, Claude parallel runs, and surface code-repo coding sessions';
	end if;
end $$;

create function pg_temp.ccd_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930909000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930909000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

alter table public.qorpera_runtime_workers
	drop constraint qorpera_runtime_workers_claude_code,
	add constraint qorpera_runtime_workers_claude_code check (harness is null or species in ('in-house', 'coding'));

alter table public.qorpera_coding_executors
	alter column harnesses set default array['codex', 'claude-code'];

update public.qorpera_coding_executors
set harnesses = array['codex', 'claude-code'],
	updated_at = clock_timestamp()
where enabled and harnesses = array['codex'];

create or replace function public.qorpera_coding_executor_enroll(p_environment_id uuid, p_harness text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
	v_owner text;
	v_like public.qorpera_coding_executors%rowtype;
begin
	if exists (select 1 from public.qorpera_coding_executors where environment_id = p_environment_id) then
		return;
	end if;
	select executor.owner into v_owner
	from public.qorpera_coding_executors executor
	where executor.enabled and p_harness = any(executor.harnesses)
	group by executor.owner
	order by count(*), executor.owner
	limit 1;
	if v_owner is null then
		return;
	end if;
	select * into v_like
	from public.qorpera_coding_executors executor
	where executor.owner = v_owner and executor.enabled and p_harness = any(executor.harnesses)
	order by executor.updated_at desc, executor.environment_id
	limit 1;
	insert into public.qorpera_coding_executors(
		environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds
	)
	values (
		p_environment_id, v_owner, true, v_like.harnesses, v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds
	)
	on conflict (environment_id, owner) do nothing;
end $$;

create function public.qorpera_coding_claude_driver_ready()
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (
		select 1
		from public.qorpera_active_runtime_bundle active
		join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
		where active.singleton
			and bundle.manifest -> 'implementation' ? 'packages/runtime/src/cloud-claude-mcp-bridge.ts'
	)
$$;

create function public.qorpera_claude_worker_active_count(p_owner_user_id uuid, p_exclude_worker_id uuid default null)
returns integer language sql stable security definer set search_path = '' as $$
	select (
		(select count(*)::integer
		 from public.qorpera_claude_worker_leases lease
		 where lease.owner_user_id = p_owner_user_id
			and (p_exclude_worker_id is null or lease.worker_id is distinct from p_exclude_worker_id)
			and public.qorpera_claude_worker_lease_live(lease))
		+ (select count(*)::integer
		   from public.qorpera_coding_sessions cs
		   join public.qorpera_runtime_workers w on w.id = cs.worker_id
		   where w.species = 'coding'
			and w.harness = 'claude-code'
			and w.claude_login_id is not null
			and coalesce(w.requested_by_user_id, w.owner_user_id) = p_owner_user_id
			and (p_exclude_worker_id is null or w.id is distinct from p_exclude_worker_id)
			and cs.phase in ('preparing', 'running', 'publishing')
			and cs.lease_until > clock_timestamp()
			and not exists (
				select 1 from public.qorpera_claude_worker_leases lease
				where lease.owner_user_id = p_owner_user_id
					and lease.worker_id = w.id
					and public.qorpera_claude_worker_lease_live(lease)
			))
	)
$$;

create or replace function public.qorpera_claude_worker_waits(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_worker.harness is not distinct from 'claude-code'
		and coalesce(p_worker.requested_by_user_id, p_worker.owner_user_id) is not null
		and public.qorpera_claude_worker_active_count(
			coalesce(p_worker.requested_by_user_id, p_worker.owner_user_id),
			p_worker.id
		) >= public.qorpera_claude_worker_run_cap(coalesce(p_worker.requested_by_user_id, p_worker.owner_user_id))
$$;

create or replace function public.qorpera_claude_worker_lease_take(p_worker public.qorpera_runtime_workers, p_wake_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
	v_owner uuid := coalesce(p_worker.requested_by_user_id, p_worker.owner_user_id);
	v_taken uuid;
	v_cap integer;
	v_slot integer;
begin
	if p_worker.harness is distinct from 'claude-code' or v_owner is null or p_wake_id is null then
		raise exception 'Only a Claude Code worker takes a Claude Code lease' using errcode = '22023';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera_claude_worker_lease:' || v_owner::text, 0));
	v_cap := public.qorpera_claude_worker_run_cap(v_owner);
	if public.qorpera_claude_worker_active_count(v_owner, p_worker.id) >= v_cap then
		return false;
	end if;
	for v_slot in 1..v_cap loop
		insert into public.qorpera_claude_worker_leases as lease (owner_user_id, slot, worker_id, wake_id, claude_login_id)
		values (v_owner, v_slot, p_worker.id, p_wake_id, p_worker.claude_login_id)
		on conflict (owner_user_id, slot) do update set
			worker_id = excluded.worker_id,
			wake_id = excluded.wake_id,
			claude_login_id = excluded.claude_login_id,
			taken_at = clock_timestamp()
		where not public.qorpera_claude_worker_lease_live(lease)
		returning lease.wake_id into v_taken;
		if v_taken is not distinct from p_wake_id then
			return true;
		end if;
		v_taken := null;
	end loop;
	return false;
end $$;

create or replace function public.qorpera_claude_login_run(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_binding jsonb,
	p_lock boolean,
	p_at_work boolean
)
returns public.qorpera_claude_logins
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_lease public.qorpera_native_provider_connection_leases%rowtype;
	v_run public.qorpera_execution_runs%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_owner uuid;
	v_principal public.qorpera_cloud_secret_broker_principals%rowtype;
	v_login public.qorpera_claude_logins%rowtype;
	v_claude public.qorpera_claude_worker_leases%rowtype;
begin
	v_authority := public.qorpera_model_login_authority(p_broker_authority_id, p_broker_capability_sha256);
	v_lease := public.qorpera_model_login_run_binding(p_binding);
	select run.* into v_run from public.qorpera_execution_runs run where run.id = v_lease.run_id;
	v_worker := public.qorpera_run_worker(v_run.id);
	v_owner := coalesce(v_worker.requested_by_user_id, v_worker.owner_user_id);
	select principal.* into v_principal
	from public.qorpera_cloud_secret_broker_principals principal
	where principal.id = v_authority.principal_id and principal.status = 'active';
	select lease.* into v_claude
	from public.qorpera_claude_worker_leases lease
	where lease.owner_user_id = v_owner
		and lease.worker_id = v_worker.id
		and lease.wake_id = v_worker.occurrence_id
	order by lease.slot
	limit 1;
	if p_lock then
		select login.* into v_login from public.qorpera_claude_logins login where login.id = v_claude.claude_login_id for update;
	else
		select login.* into v_login from public.qorpera_claude_logins login where login.id = v_claude.claude_login_id;
	end if;
	if v_run.id is null or v_run.profile_id is distinct from v_authority.profile_id
		or v_worker.id is null or v_worker.species not in ('in-house', 'coding')
		or v_worker.harness is distinct from 'claude-code' or (p_at_work and v_worker.state is distinct from 'active')
		or v_principal.id is null or public.qorpera_company_account_vault(v_authority.profile_id) is distinct from v_principal.id
		or v_login.id is null or v_login.principal_id is distinct from v_principal.id
		or v_login.owner_user_id is distinct from v_owner
		or v_claude.owner_user_id is null or v_claude.worker_id is distinct from v_worker.id
		or v_claude.wake_id is distinct from v_worker.occurrence_id
		or not exists (select 1 from public.qorpera_wake_occurrences wake where wake.id = v_claude.wake_id and wake.run_id = v_run.id)
		or not public.qorpera_claude_worker_lease_live(v_claude) then
		raise exception 'Claude login is unavailable to this run' using errcode = '42501';
	end if;
	return v_login;
end $$;

create or replace function public.qorpera_record_claude_run_usage(p_binding jsonb, p_usage jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype;
	v_recorded boolean;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude run usage is the runtime''s' using errcode = '42501';
	end if;
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	v_worker := public.qorpera_run_worker(v_run.id);
	if v_worker.id is null or v_worker.harness is distinct from 'claude-code' or v_worker.claude_login_id is null then
		raise exception 'The run is no Claude Code worker''s' using errcode = '42501';
	end if;
	if not public.qorpera_claude_usage_valid(p_usage)
		or (p_usage ->> 'observedAt')::timestamptz > statement_timestamp() + interval '60 seconds'
		or exists (select 1 from jsonb_array_elements(p_usage -> 'windows') as item(window_row)
			where item.window_row ->> 'id' = 'seven_day_model') then
		raise exception 'Claude run usage is invalid' using errcode = '22023';
	end if;
	update public.qorpera_claude_logins as claude
	set usage = jsonb_set(p_usage, '{windows}',
		(p_usage -> 'windows') || coalesce((select jsonb_agg(item.window_row)
			from jsonb_array_elements(claude.usage -> 'windows') as item(window_row)
			where item.window_row ->> 'id' = 'seven_day_model'
				and claude.usage_read_at > statement_timestamp() - interval '10 minutes'), '[]'::jsonb))
	where claude.id = v_worker.claude_login_id
		and claude.status = 'active'
		and claude.owner_user_id = coalesce(v_worker.requested_by_user_id, v_worker.owner_user_id)
		and (claude.usage is null or (claude.usage ->> 'observedAt')::timestamptz < (p_usage ->> 'observedAt')::timestamptz);
	v_recorded := found;
	return jsonb_build_object('schema', 'qorpera.claude-run-usage/v1', 'recorded', v_recorded);
end $$;

create function public.qorpera_coding_claude_login(p_profile_id uuid, p_owner_user_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select login.id
	from public.qorpera_claude_logins login
	where login.owner_user_id = p_owner_user_id
		and login.status = 'active'
		and login.in_use
		and exists (
			select 1 from public.qorpera_profile_members member
			where member.profile_id = p_profile_id and member.user_id = p_owner_user_id
		)
		and public.qorpera_claude_sign_in_open(p_profile_id, p_owner_user_id)
	limit 1
$$;

create function public.qorpera_member_coding_default(p_profile_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_row public.qorpera_member_default_models%rowtype;
	v_policy jsonb;
	v_claude_login uuid;
	v_model text;
	v_effort text;
	v_harness text;
	v_explicit boolean := false;
begin
	if p_user_id is not null then
		select * into v_row from public.qorpera_member_default_models where user_id = p_user_id;
	end if;
	select bundle.manifest -> 'modelPolicy' into v_policy
	from public.qorpera_active_runtime_bundle active
	join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id
	where active.singleton;
	if p_profile_id is not null and p_user_id is not null then
		v_claude_login := public.qorpera_coding_claude_login(p_profile_id, p_user_id);
	end if;

	if v_row.coding_model in ('claude-fable-5-2', 'claude-opus-5-5') then
		-- WHY: Explicit Claude coding preference never silently falls back to GPT/Codex.
		v_harness := 'claude-code';
		v_model := v_row.coding_model;
		v_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
		v_explicit := true;
	elsif v_row.coding_model in ('gpt-6.2-sol', 'gpt-6-astra') then
		v_harness := 'codex';
		v_model := v_row.coding_model;
		v_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
		if v_effort in ('xhigh', 'max') then
			v_effort := 'high';
		end if;
		v_explicit := true;
	elsif v_claude_login is not null and public.qorpera_coding_claude_driver_ready() then
		v_harness := 'claude-code';
		v_model := 'claude-opus-5-5';
		v_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
	else
		v_harness := 'codex';
		v_model := 'gpt-6.2-sol';
		v_effort := coalesce(v_row.coding_effort, v_policy ->> 'unattended', 'high');
		if v_effort in ('xhigh', 'max') then
			v_effort := 'high';
		end if;
	end if;

	return jsonb_build_object(
		'harness', v_harness,
		'model', v_model,
		'effort', v_effort,
		'explicit', v_explicit
	);
end $$;

create function public.qorpera_surface_resolve_coding_provider_binding(
	p_profile_id uuid,
	p_owner_user_id uuid,
	p_member_initiated boolean,
	p_harness text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_provider text := case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
	v_native text := case p_harness when 'codex' then 'codex-cli' when 'claude-code' then 'claude-code' end;
	v_conn_id uuid;
	v_conn_ver bigint;
	v_allow_auto boolean := false;
	v_version public.qorpera_provider_connection_versions%rowtype;
	v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_client_hex text;
	v_client uuid;
	v_seed text;
begin
	if v_provider is null then
		return null;
	end if;

	select login.connection_id, login.connection_version, coalesce(login.allow_autonomous, false)
	into v_conn_id, v_conn_ver, v_allow_auto
	from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness) as login;

	if v_conn_id is not null and (p_member_initiated or v_allow_auto) then
		select * into v_version
		from public.qorpera_provider_connection_versions v
		where v.connection_id = v_conn_id and v.version = v_conn_ver and v.authorization_state = 'active';
		if v_version.connection_id is not null
			and public.qorpera_provider_execution_enabled(v_provider, v_version.authentication_mode, v_version.native_harness)
			and (v_version.authentication_mode <> 'native_subscription' or exists (
				select 1 from public.qorpera_native_credential_capsules c
				where c.id = v_version.credential_capsule_id and c.status = 'active'
			)) then
			select sponsor.* into v_sponsor
			from public.qorpera_execution_sponsor_versions sponsor
			join public.qorpera_execution_sponsor_bindings b on b.id = sponsor.binding_id
			where b.profile_id = p_profile_id and b.status = 'active'
				and sponsor.sponsor_kind = 'member_connection'
				and sponsor.provider_connection_id = v_conn_id
				and sponsor.provider_connection_version = v_conn_ver
				and sponsor.created_by_user_id = p_owner_user_id
				and (sponsor.allow_autonomous or p_member_initiated)
				and sponsor.version = (
					select max(later.version) from public.qorpera_execution_sponsor_versions later
					where later.binding_id = b.id
				)
			order by sponsor.allow_autonomous desc, sponsor.created_at desc
			limit 1;

			if v_sponsor.binding_id is null then
				v_seed := case when v_allow_auto then 'qorpera-coding-owner:' else 'qorpera-surface-coding-owner:' end
					|| v_conn_id::text || ':' || v_conn_ver::text;
				v_client_hex := encode(extensions.digest(convert_to(v_seed, 'utf8'), 'sha256'), 'hex');
				v_client := (left(v_client_hex, 8) || '-' || substr(v_client_hex, 9, 4) || '-4' || substr(v_client_hex, 14, 3)
					|| '-8' || substr(v_client_hex, 18, 3) || '-' || substr(v_client_hex, 21, 12))::uuid;
				select * into v_binding
				from public.qorpera_execution_sponsor_bindings
				where profile_id = p_profile_id and client_binding_id = v_client
				for update;
				if v_binding.id is null then
					insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
					values (p_profile_id, v_client, p_owner_user_id)
					returning * into v_binding;
				elsif v_binding.created_by_user_id <> p_owner_user_id or v_binding.status <> 'active' then
					v_binding := null;
				end if;
				if v_binding.id is not null then
					select sponsor.* into v_sponsor
					from public.qorpera_execution_sponsor_versions sponsor
					where sponsor.binding_id = v_binding.id
					order by sponsor.version desc
					limit 1;
					if v_sponsor.binding_id is null
						or v_sponsor.provider_connection_version <> v_conn_ver
						or (v_allow_auto and not v_sponsor.allow_autonomous) then
						insert into public.qorpera_execution_sponsor_versions (
							binding_id, version, sponsor_kind, provider_connection_id,
							provider_connection_version, allow_autonomous, created_by_user_id
						)
						values (
							v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'member_connection', v_conn_id,
							v_conn_ver, v_allow_auto, p_owner_user_id
						)
						returning * into v_sponsor;
					end if;
				end if;
			end if;

			if v_sponsor.binding_id is not null then
				return jsonb_build_object('bindingId', v_sponsor.binding_id, 'version', v_sponsor.version);
			end if;
		end if;
	end if;

	v_conn_id := null;
	v_conn_ver := null;
	v_allow_auto := false;
	v_sponsor := null;
	v_binding := null;

	select c.id, v.version, coalesce(v.allow_autonomous, false)
	into v_conn_id, v_conn_ver, v_allow_auto
	from public.qorpera_provider_connections c
	cross join lateral (
		select pv.version, pv.allow_autonomous, pv.authentication_mode, pv.native_harness, pv.credential_capsule_id
		from public.qorpera_provider_connection_versions pv
		where pv.connection_id = c.id and pv.authorization_state = 'active' and pv.native_harness = v_native
		order by pv.version desc limit 1
	) v
	where c.profile_id = p_profile_id and c.owner_user_id is null
		and c.provider = v_provider and c.status = 'active'
		and (v.allow_autonomous or p_member_initiated)
		and public.qorpera_provider_execution_enabled(v_provider, v.authentication_mode, v.native_harness)
		and (v.authentication_mode <> 'native_subscription' or exists (
			select 1 from public.qorpera_native_credential_capsules cap
			where cap.id = v.credential_capsule_id and cap.status = 'active'
		))
	order by not coalesce(v.allow_autonomous, false), c.created_at desc, c.id
	limit 1;

	if v_conn_id is null then
		return null;
	end if;

	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions sponsor
	join public.qorpera_execution_sponsor_bindings b on b.id = sponsor.binding_id
	where b.profile_id = p_profile_id and b.status = 'active'
		and sponsor.sponsor_kind = 'company_connection'
		and sponsor.provider_connection_id = v_conn_id
		and sponsor.provider_connection_version = v_conn_ver
		and (sponsor.allow_autonomous or p_member_initiated)
		and sponsor.version = (
			select max(later.version) from public.qorpera_execution_sponsor_versions later
			where later.binding_id = b.id
		)
	order by sponsor.allow_autonomous desc, sponsor.created_at desc
	limit 1;

	if v_sponsor.binding_id is null then
		v_seed := 'qorpera-surface-coding-company:' || v_conn_id::text || ':' || v_conn_ver::text;
		v_client_hex := encode(extensions.digest(convert_to(v_seed, 'utf8'), 'sha256'), 'hex');
		v_client := (left(v_client_hex, 8) || '-' || substr(v_client_hex, 9, 4) || '-4' || substr(v_client_hex, 14, 3)
			|| '-8' || substr(v_client_hex, 18, 3) || '-' || substr(v_client_hex, 21, 12))::uuid;
		select * into v_binding
		from public.qorpera_execution_sponsor_bindings
		where profile_id = p_profile_id and client_binding_id = v_client
		for update;
		if v_binding.id is null then
			insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
			values (p_profile_id, v_client, p_owner_user_id)
			returning * into v_binding;
		elsif v_binding.status <> 'active' then
			return null;
		end if;
		select sponsor.* into v_sponsor
		from public.qorpera_execution_sponsor_versions sponsor
		where sponsor.binding_id = v_binding.id
		order by sponsor.version desc
		limit 1;
		if v_sponsor.binding_id is null
			or v_sponsor.provider_connection_version <> v_conn_ver
			or (v_allow_auto and not v_sponsor.allow_autonomous) then
			insert into public.qorpera_execution_sponsor_versions (
				binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id
			)
			values (
				v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'company_connection', v_conn_id,
				v_conn_ver, v_allow_auto, p_owner_user_id
			)
			returning * into v_sponsor;
		end if;
	end if;

	if v_sponsor.binding_id is null then
		return null;
	end if;
	return jsonb_build_object('bindingId', v_sponsor.binding_id, 'version', v_sponsor.version);
end $$;

create or replace function public.qorpera_surface_resolve_coding_sponsor(
	p_profile_id uuid,
	p_environment_id uuid,
	p_owner_user_id uuid,
	p_member_initiated boolean,
	p_preferred_harness text default null,
	p_require_preferred boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_enabled_harnesses text[];
	v_driver_ready boolean := public.qorpera_coding_claude_driver_ready();
	v_saw_unready_claude boolean := false;
	v_default jsonb;
	v_default_harness text;
	v_explicit boolean;
	v_candidates text[] := '{}'::text[];
	v_harness text;
	v_claude_login uuid;
	v_binding jsonb;
	v_claude_model text;
	v_claude_effort text;
	v_codex_model text;
begin
	if not exists (
		select 1 from public.qorpera_profile_members
		where profile_id = p_profile_id and user_id = p_owner_user_id
	) then
		return jsonb_build_object('status', 'no_member');
	end if;

	if exists (select 1 from public.qorpera_coding_executors where environment_id = p_environment_id) then
		select coalesce(array_agg(distinct h order by h), '{}'::text[])
		into v_enabled_harnesses
		from public.qorpera_coding_executors e, unnest(e.harnesses) as h
		where e.environment_id = p_environment_id and e.enabled;
	else
		select coalesce(array_agg(distinct h order by h), '{}'::text[])
		into v_enabled_harnesses
		from public.qorpera_coding_executors e, unnest(e.harnesses) as h
		where e.enabled;
	end if;

	if coalesce(cardinality(v_enabled_harnesses), 0) = 0 then
		return jsonb_build_object('status', 'no_coding_executor');
	end if;

	v_default := public.qorpera_member_coding_default(p_profile_id, p_owner_user_id);
	v_default_harness := v_default ->> 'harness';
	v_explicit := coalesce((v_default ->> 'explicit')::boolean, false);

	if p_require_preferred then
		if p_preferred_harness is null or not (p_preferred_harness = any(v_enabled_harnesses)) then
			return jsonb_build_object('status', 'no_coding_executor');
		end if;
		v_candidates := array[p_preferred_harness];
	elsif p_preferred_harness is not null then
		if p_preferred_harness = any(v_enabled_harnesses) then
			v_candidates := array_append(v_candidates, p_preferred_harness);
		elsif v_explicit then
			return jsonb_build_object('status', 'no_coding_executor');
		end if;
		if not v_explicit then
			foreach v_harness in array array[v_default_harness, 'codex', 'claude-code'] loop
				if v_harness is not null
					and v_harness = any(v_enabled_harnesses)
					and (v_harness <> 'claude-code' or v_driver_ready)
					and not (v_harness = any(v_candidates)) then
					v_candidates := array_append(v_candidates, v_harness);
				end if;
			end loop;
		end if;
	elsif v_explicit then
		-- WHY: Explicit Coding & working model selection never silently falls back to the other harness.
		if not (v_default_harness = any(v_enabled_harnesses)) then
			return jsonb_build_object('status', 'no_coding_executor');
		end if;
		v_candidates := array[v_default_harness];
	else
		foreach v_harness in array array[v_default_harness, 'codex', 'claude-code'] loop
			if v_harness is not null
				and v_harness = any(v_enabled_harnesses)
				and (v_harness <> 'claude-code' or v_driver_ready)
				and not (v_harness = any(v_candidates)) then
				v_candidates := array_append(v_candidates, v_harness);
			end if;
		end loop;
	end if;

	if coalesce(cardinality(v_candidates), 0) = 0 then
		return jsonb_build_object('status', 'no_coding_executor');
	end if;

	v_claude_model := case when v_default_harness = 'claude-code' then v_default ->> 'model' else 'claude-opus-5-5' end;
	v_claude_effort := coalesce(v_default ->> 'effort', 'high');
	v_codex_model := case when v_default_harness = 'codex' then v_default ->> 'model' else 'gpt-6.2-sol' end;

	foreach v_harness in array v_candidates loop
		if v_harness = 'claude-code' then
			v_claude_login := public.qorpera_coding_claude_login(p_profile_id, p_owner_user_id);
			if v_claude_login is not null then
				v_binding := coalesce(
					public.qorpera_surface_resolve_coding_provider_binding(p_profile_id, p_owner_user_id, p_member_initiated, 'codex'),
					public.qorpera_surface_resolve_coding_provider_binding(p_profile_id, p_owner_user_id, p_member_initiated, 'claude-code')
				);
				if v_binding is not null then
					if not v_driver_ready then
						if p_require_preferred or v_explicit then
							return jsonb_build_object('status', 'no_coding_executor');
						end if;
						v_saw_unready_claude := true;
						continue;
					end if;
					return jsonb_build_object(
						'status', 'ok',
						'harness', 'claude-code',
						'bindingId', (v_binding ->> 'bindingId')::uuid,
						'version', (v_binding ->> 'version')::bigint,
						'model', v_claude_model,
						'claudeLoginId', v_claude_login,
						'claudeModel', v_claude_model,
						'claudeEffort', v_claude_effort
					);
				end if;
			else
				v_binding := public.qorpera_surface_resolve_coding_provider_binding(
					p_profile_id, p_owner_user_id, p_member_initiated, 'claude-code'
				);
				if v_binding is not null then
					if not v_driver_ready then
						if p_require_preferred or v_explicit then
							return jsonb_build_object('status', 'no_coding_executor');
						end if;
						v_saw_unready_claude := true;
						continue;
					end if;
					return jsonb_build_object(
						'status', 'ok',
						'harness', 'claude-code',
						'bindingId', (v_binding ->> 'bindingId')::uuid,
						'version', (v_binding ->> 'version')::bigint,
						'model', v_claude_model,
						'claudeModel', v_claude_model,
						'claudeEffort', v_claude_effort
					);
				end if;
			end if;
		else
			v_binding := public.qorpera_surface_resolve_coding_provider_binding(
				p_profile_id, p_owner_user_id, p_member_initiated, 'codex'
			);
			if v_binding is not null then
				return jsonb_build_object(
					'status', 'ok',
					'harness', 'codex',
					'bindingId', (v_binding ->> 'bindingId')::uuid,
					'version', (v_binding ->> 'version')::bigint,
					'model', v_codex_model
				);
			end if;
		end if;
	end loop;

	if v_saw_unready_claude then
		return jsonb_build_object('status', 'no_coding_executor');
	end if;
	return jsonb_build_object('status', 'no_sponsor');
end $$;

create or replace function public.qorpera_coding_owner_problem(
	p_profile_id uuid,
	p_owner_user_id uuid,
	p_harness text,
	p_run_binding_id uuid
)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
	v_provider text := case p_harness when 'codex' then 'openai' when 'claude-code' then 'anthropic' end;
	v_connection uuid;
	v_allowed boolean;
	v_claude_login uuid;
begin
	if not exists (
		select 1 from public.qorpera_profile_members
		where profile_id = p_profile_id and user_id = p_owner_user_id
	) then
		return 'The session owner is not a member of this company';
	end if;
	if p_harness = 'claude-code' then
		v_claude_login := public.qorpera_coding_claude_login(p_profile_id, p_owner_user_id);
		if v_claude_login is not null then
			select login.connection_id, login.allow_autonomous into v_connection, v_allowed
			from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, 'codex') login;
			if v_connection is not null and v_allowed
				and (not public.qorpera_connection_is_chatgpt_plan(v_connection)
					or v_connection is not distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id)) then
				return null;
			end if;
			if p_run_binding_id is not null and exists (
				select 1
				from public.qorpera_execution_sponsor_bindings b
				join public.qorpera_execution_sponsor_versions sv on sv.binding_id = b.id
				join public.qorpera_provider_connections c on c.id = sv.provider_connection_id and c.status = 'active'
				join public.qorpera_provider_connection_versions cv on cv.connection_id = c.id
					and cv.version = sv.provider_connection_version and cv.authorization_state = 'active'
				where b.id = p_run_binding_id and b.profile_id = p_profile_id and b.status = 'active'
					and sv.allow_autonomous and cv.allow_autonomous
					and sv.version = (select max(later.version) from public.qorpera_execution_sponsor_versions later where later.binding_id = b.id)
			) then
				return null;
			end if;
			return 'No model account is set up for background work by this agent';
		end if;
	end if;
	select login.connection_id, login.allow_autonomous into v_connection, v_allowed
	from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, p_harness) login;
	if v_connection is null then
		return format('The session owner has no active %s account connected for %s', v_provider, p_harness);
	end if;
	if not v_allowed then
		return format('The session owner has not allowed background work on their %s account', v_provider);
	end if;
	if public.qorpera_connection_is_chatgpt_plan(v_connection)
		and v_connection is distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id) then
		return 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it';
	end if;
	return null;
end $$;

create or replace function public.qorpera_coding_owner_payer(
	p_profile_id uuid,
	p_owner_user_id uuid,
	p_harness text,
	p_run_binding_id uuid
)
returns table(binding_id uuid, version bigint) language plpgsql security definer set search_path = '' as $$
declare
	v_connection uuid;
	v_allowed boolean;
	v_run_version bigint;
begin
	if p_harness = 'claude-code' and public.qorpera_coding_claude_login(p_profile_id, p_owner_user_id) is not null then
		select login.connection_id, login.allow_autonomous into v_connection, v_allowed
		from public.qorpera_coding_owner_login(p_profile_id, p_owner_user_id, 'codex') login;
		if v_connection is not null and v_allowed
			and (not public.qorpera_connection_is_chatgpt_plan(v_connection)
				or v_connection is not distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id)) then
			select sponsor.binding_id, sponsor.version into binding_id, version
			from public.qorpera_coding_owner_sponsor(p_profile_id, p_owner_user_id, 'codex') sponsor;
			return next;
			return;
		end if;
		if p_run_binding_id is not null then
			select sv.version into v_run_version
			from public.qorpera_execution_sponsor_bindings b
			join public.qorpera_execution_sponsor_versions sv on sv.binding_id = b.id
			join public.qorpera_provider_connections c on c.id = sv.provider_connection_id and c.status = 'active'
			join public.qorpera_provider_connection_versions cv on cv.connection_id = c.id
				and cv.version = sv.provider_connection_version and cv.authorization_state = 'active'
			where b.id = p_run_binding_id and b.profile_id = p_profile_id and b.status = 'active'
				and sv.allow_autonomous and cv.allow_autonomous
			order by sv.version desc
			limit 1;
			if v_run_version is not null then
				binding_id := p_run_binding_id;
				version := v_run_version;
				return next;
				return;
			end if;
		end if;
		raise exception 'No model account is set up for background work by this agent' using errcode = '55000';
	end if;
	select sponsor.binding_id, sponsor.version, sponsor.connection_id into binding_id, version, v_connection
	from public.qorpera_coding_owner_sponsor(p_profile_id, p_owner_user_id, p_harness) sponsor;
	if public.qorpera_connection_is_chatgpt_plan(v_connection)
		and v_connection is distinct from public.qorpera_sponsor_binding_connection(p_run_binding_id) then
		raise exception 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it'
			using errcode = '55000';
	end if;
	return next;
end $$;

create or replace function public.qorpera_coding_session_claim_json(
	p_session public.qorpera_coding_sessions,
	p_worker public.qorpera_runtime_workers
)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.coding-session-claim/v1','workerId',p_worker.id,'sequence',p_worker.sequence,
		'leaseToken',p_session.lease_token,'leaseUntil',p_session.lease_until,'profileId',p_worker.profile_id,'environmentId',p_worker.environment_id,
		'agentId',p_worker.staff_agent_id,'ownerUserId',p_worker.owner_user_id,
		'sponsor',jsonb_build_object('bindingId',p_worker.owner_sponsor_binding_id,'version',p_worker.owner_sponsor_version),
		'harness',p_session.harness,'model',p_session.model,'repository',p_session.repository,'branch',p_session.branch,'baseSha',p_session.base_sha,
		'worktreeCreatedAt',p_session.worktree_created_at,
		'harnessSessionRef',p_session.harness_session_ref,'pullRequest',p_session.pull_request,'title',p_worker.title,
		'dispatch',p_worker.dispatch,'followUp',p_worker.dispatch ->> 'followUp','todoId',p_worker.todo_id)
		|| case when p_worker.claude_model is null then '{}'::jsonb
			else jsonb_build_object('claude', jsonb_build_object('model', p_worker.claude_model, 'effort', p_worker.claude_effort)) end
		|| case when p_session.surface_session_id is null then '{}'::jsonb else coalesce((
			select jsonb_build_object('surfaceSession', jsonb_build_object(
				'sessionId', ss.id,
				'surfaceId', surf.id,
				'slug', surf.slug,
				'title', coalesce(nullif(btrim(public.qorpera_surface_utf8_left(surf.title, 320)), ''), surf.slug)
			))
			from public.qorpera_surface_sessions ss
			join public.qorpera_surfaces surf on surf.id = ss.surface_id
			where ss.id = p_session.surface_session_id
		), '{}'::jsonb) end
$$;

select pg_temp.ccd_patch(
	'public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)'::regprocedure,
	array[
$old$	select case
		when p_worker.owner_sponsor_binding_id is null then null$old$,
$new$	select case
		when p_worker.harness = 'claude-code' and p_worker.claude_login_id is not null and not exists (
			select 1 from public.qorpera_claude_logins claude
			where claude.id = p_worker.claude_login_id and claude.status = 'active'
		) then 'removed'
		when p_worker.harness = 'claude-code' and p_worker.claude_login_id is not null
			and not public.qorpera_claude_sign_in_open(
				p_worker.profile_id,
				coalesce(p_worker.requested_by_user_id, p_worker.owner_user_id)
			) then 'unavailable'
		when p_worker.owner_sponsor_binding_id is null then null$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_authorize_coding_turn(jsonb)'::regprocedure,
	array[
$old$		'surfaceSessionId', v_session.surface_session_id,$old$,
$new$		'surfaceSessionId', v_session.surface_session_id,
		'claude', case when v_worker.claude_model is not null
			then jsonb_build_object('model', v_worker.claude_model, 'effort', v_worker.claude_effort)
			else null end,$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_begin_native_coding_execution(jsonb,text,text,text,text,text,integer)'::regprocedure,
	array[
$old$	v_is_surface boolean;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_is_surface := nullif(coalesce(v_authority #>> '{coding,surfaceSessionId}', ''), '') is not null;$old$,
$new$	v_is_surface boolean;
	v_is_claude boolean;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_is_surface := nullif(coalesce(v_authority #>> '{coding,surfaceSessionId}', ''), '') is not null;
	v_is_claude := v_authority #>> '{coding,harness}' = 'claude-code';$new$,
$old$	if jsonb_array_length(v_catalog -> 'tools') not between 4 and (case when v_is_surface then 8 else 6 end)$old$,
$new$	if jsonb_array_length(v_catalog -> 'tools') not between (case when v_is_claude then 1 else 4 end) and (case when v_is_surface then 8 else 6 end)$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_claim_coding_session(text,integer)'::regprocedure,
	array[
$old$				and (not public.qorpera_coding_session_waits_for_usage_limit(session.worker_id)
					or public.qorpera_surface_is_preview_builder(session.worker_id))$old$,
$new$				and (not public.qorpera_coding_session_waits_for_usage_limit(session.worker_id)
					or public.qorpera_surface_is_preview_builder(session.worker_id))
				and (session.harness <> 'claude-code' or public.qorpera_coding_claude_driver_ready())
				and (not exists (
					select 1 from public.qorpera_runtime_workers cw
					where cw.id = session.worker_id
						and cw.harness = 'claude-code'
						and cw.claude_login_id is not null
						and public.qorpera_claude_worker_waits(cw)
				) or public.qorpera_surface_is_preview_builder(session.worker_id))$new$,
$old$			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner,$old$,
$new$			if v_session.harness = 'claude-code' and not public.qorpera_coding_claude_driver_ready() then
				raise exception 'Coding candidate skipped' using errcode = 'QSK01';
			end if;
			if v_worker.harness = 'claude-code' and v_worker.claude_login_id is not null
				and not public.qorpera_surface_is_preview_builder(v_worker.id) then
				-- WHY: Serialize concurrent claims for the same owner under the Claude lease lock before marking preparing so cap-1 never over-claims.
				perform pg_advisory_xact_lock(hashtextextended(
					'qorpera_claude_worker_lease:' || coalesce(v_worker.requested_by_user_id, v_worker.owner_user_id)::text, 0
				));
				if public.qorpera_claude_worker_waits(v_worker) then
					raise exception 'Coding candidate skipped' using errcode = 'QSK01';
				end if;
			end if;
			update public.qorpera_coding_sessions set phase = 'preparing', lease_owner = p_owner,$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
	array[
$old$	perform public.qorpera_folder_admit_wakes(v_worker.profile_id);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,$old$,
$new$	if v_worker.harness = 'claude-code' and v_worker.claude_login_id is not null then
		if not public.qorpera_claude_worker_lease_take(v_worker, v_occurrence) then
			return '{"state":"refused","reason":"CLAUDE_PARALLEL_LIMIT_REACHED"}'::jsonb;
		end if;
	end if;
	perform public.qorpera_folder_admit_wakes(v_worker.profile_id);
	insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_defer_coding_session(uuid,uuid,text)'::regprocedure,
	array[
$old$	v_step constant text := case when p_reason = 'COMPUTER_HOURS_EXHAUSTED' then 'Waiting for computer hours'
		else 'Waiting for a coding machine' end; v_waiting boolean;$old$,
$new$	v_step constant text := case
		when p_reason = 'COMPUTER_HOURS_EXHAUSTED' then 'Waiting for computer hours'
		when p_reason = 'CLAUDE_PARALLEL_LIMIT_REACHED' then 'Waiting for a Claude Code slot'
		else 'Waiting for a coding machine' end; v_waiting boolean;$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
	array[
$old$			insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				surface_backed, surface_session_id
			)
			values (
				v_session.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
				'surface-' || replace(v_session.id::text, '-', ''), 'coding', v_title,
				'read', 'each', v_dispatch, 'active', 1, v_requester, null,
				v_requester, (v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint,
				true, v_session.id
			)
			returning * into v_worker;$old$,
$new$			insert into public.qorpera_runtime_workers(
				profile_id, environment_id, staff_agent_id, todo_id, worker_key, species, title,
				access, revival, dispatch, state, sequence, requested_by_user_id, steering_run_id,
				owner_user_id, owner_sponsor_binding_id, owner_sponsor_version,
				harness, claude_login_id, claude_model, claude_effort,
				surface_backed, surface_session_id
			)
			values (
				v_session.profile_id, v_cofounder.environment_id, v_cofounder.staff_agent_id, null,
				'surface-' || replace(v_session.id::text, '-', ''), 'coding', v_title,
				'read', 'each', v_dispatch, 'active', 1, v_requester, null,
				v_requester, (v_coding_sponsor ->> 'bindingId')::uuid, (v_coding_sponsor ->> 'version')::bigint,
				case when v_harness = 'claude-code' then 'claude-code' else null end,
				case when v_harness = 'claude-code' then nullif(v_coding_sponsor ->> 'claudeLoginId', '')::uuid else null end,
				case when v_harness = 'claude-code' then nullif(v_coding_sponsor ->> 'claudeModel', '') else null end,
				case when v_harness = 'claude-code' then nullif(v_coding_sponsor ->> 'claudeEffort', '') else null end,
				true, v_session.id
			)
			returning * into v_worker;$new$,
$old$			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness, v_repo,
				'qorpera/coding/' || v_worker.id::text, null,
				'queued', v_session.id
			)
			returning * into v_coding_session;$old$,
$new$			insert into public.qorpera_coding_sessions(
				worker_id, profile_id, environment_id, session_id, harness, model, repository, branch, base_sha,
				phase, surface_session_id
			)
			values (
				v_worker.id, v_session.profile_id, v_cofounder.environment_id, null, v_harness,
				nullif(v_coding_sponsor ->> 'model', ''), v_repo,
				'qorpera/coding/' || v_worker.id::text, null,
				'queued', v_session.id
			)
			returning * into v_coding_session;$new$,
$old$				owner_user_id = v_requester,
				requested_by_user_id = v_requester,
				owner_sponsor_binding_id = (v_coding_sponsor ->> 'bindingId')::uuid,
				owner_sponsor_version = (v_coding_sponsor ->> 'version')::bigint,
				dispatch = jsonb_set(dispatch, '{followUp}', to_jsonb(v_followup)),$old$,
$new$				owner_user_id = v_requester,
				requested_by_user_id = v_requester,
				owner_sponsor_binding_id = (v_coding_sponsor ->> 'bindingId')::uuid,
				owner_sponsor_version = (v_coding_sponsor ->> 'version')::bigint,
				harness = case when v_harness = 'claude-code' then 'claude-code' else null end,
				claude_login_id = case when v_harness = 'claude-code'
					then nullif(v_coding_sponsor ->> 'claudeLoginId', '')::uuid else null end,
				claude_model = case when v_harness = 'claude-code'
					then coalesce(nullif(v_coding_sponsor ->> 'claudeModel', ''), claude_model) else null end,
				claude_effort = case when v_harness = 'claude-code'
					then coalesce(nullif(v_coding_sponsor ->> 'claudeEffort', ''), claude_effort) else null end,
				dispatch = jsonb_set(dispatch, '{followUp}', to_jsonb(v_followup)),$new$,
$old$			update public.qorpera_coding_sessions
			set
				phase = 'input_ready',
				finished_at = null,
				lease_owner = null,
				lease_token = null,
				lease_until = null,
				claim_after = null,
				updated_at = v_now
			where worker_id = v_worker.id$old$,
$new$			update public.qorpera_coding_sessions
			set
				phase = 'input_ready',
				model = coalesce(nullif(v_coding_sponsor ->> 'model', ''), model),
				finished_at = null,
				lease_owner = null,
				lease_token = null,
				lease_until = null,
				claim_after = null,
				updated_at = v_now
			where worker_id = v_worker.id$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	array[
$old$			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_executors executor
				where executor.environment_id = p_environment_id and executor.enabled
					and (v_request ->> 'harness') = any(executor.harnesses))$old$,
$new$			elsif v_species = 'coding' and v_request ->> 'harness' = 'codex'
				and coalesce((public.qorpera_member_coding_default(p_profile_id, (p_actor ->> 'requesterUserId')::uuid) ->> 'explicit')::boolean, false)
				and public.qorpera_member_coding_default(p_profile_id, (p_actor ->> 'requesterUserId')::uuid) ->> 'harness' = 'claude-code' then
				v_problem := 'The member chose Claude Code as their Coding & working default; dispatch with harness claude-code instead of codex';
			elsif v_species = 'coding' and not exists (select 1 from public.qorpera_coding_executors executor
				where executor.environment_id = p_environment_id and executor.enabled
					and (v_request ->> 'harness') = any(executor.harnesses))$new$,
$old$			elsif v_species = 'coding' and public.qorpera_coding_owner_problem(p_profile_id,
					(p_actor ->> 'requesterUserId')::uuid, v_request ->> 'harness', v_run.sponsor_binding_id) is not null then
				v_problem := public.qorpera_coding_owner_problem(p_profile_id, (p_actor ->> 'requesterUserId')::uuid,
					v_request ->> 'harness', v_run.sponsor_binding_id);$old$,
$new$			elsif v_species = 'coding' and public.qorpera_coding_owner_problem(p_profile_id,
					(p_actor ->> 'requesterUserId')::uuid, v_request ->> 'harness', v_run.sponsor_binding_id) is not null then
				v_problem := public.qorpera_coding_owner_problem(p_profile_id, (p_actor ->> 'requesterUserId')::uuid,
					v_request ->> 'harness', v_run.sponsor_binding_id);
			elsif v_species = 'coding' and v_request ->> 'harness' = 'claude-code'
				and not public.qorpera_coding_claude_driver_ready() then
				v_problem := 'Claude Code coding sessions are not active on this runtime bundle yet';$new$,
$old$			elsif v_worker.harness = 'claude-code' and not v_worker.harness_default
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then
				v_problem := public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id);$old$,
$new$			elsif v_worker.species = 'in-house' and v_worker.harness = 'claude-code' and not v_worker.harness_default
				and public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id) is not null then
				v_problem := public.qorpera_claude_worker_problem(p_profile_id, v_staff, v_run.id);
			elsif v_worker.species = 'coding' and v_worker.harness = 'claude-code' and v_worker.claude_login_id is not null
				and public.qorpera_coding_claude_login(p_profile_id, v_worker.owner_user_id) is null then
				v_problem := 'Claude Code needs the session owner''s active Claude sign-in in Settings, AI subscriptions';$new$
	]
);

select pg_temp.ccd_patch(
	'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
	array[
$old$	v_binding uuid; v_version bigint; -- 20260930077000 (C3a): a coding owner's sponsor$old$,
$new$	v_binding uuid; v_version bigint;
	v_coding_default jsonb; v_coding_model text; v_coding_claude_login uuid; v_coding_claude_effort text;$new$,
$old$			insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, repository, branch, claimed_paths)
			values (v_worker.id, p_profile_id, p_environment_id,
				(select run.session_id from public.qorpera_execution_runs run where run.id = v_commit.run_id),
				p_parse ->> 'harness', p_parse -> 'repository', 'qorpera/coding/' || v_worker.id::text,
				coalesce((select array_agg(e #>> '{}') from jsonb_array_elements(coalesce(v_request -> 'claimedPaths', '[]'::jsonb)) as e), '{}'::text[]));$old$,
$new$			v_coding_default := public.qorpera_member_coding_default(p_profile_id, v_commit.requester_id);
			if p_parse ->> 'harness' = 'claude-code' then
				v_coding_claude_login := public.qorpera_coding_claude_login(p_profile_id, v_commit.requester_id);
				v_coding_model := case when v_coding_default ->> 'harness' = 'claude-code'
					then v_coding_default ->> 'model' else 'claude-opus-5-5' end;
				v_coding_claude_effort := coalesce(v_coding_default ->> 'effort', 'high');
				update public.qorpera_runtime_workers
				set harness = 'claude-code',
					claude_login_id = v_coding_claude_login,
					claude_model = v_coding_model,
					claude_effort = v_coding_claude_effort
				where id = v_worker.id
				returning * into v_worker;
			else
				v_coding_model := case when v_coding_default ->> 'harness' = 'codex'
					then v_coding_default ->> 'model' else 'gpt-6.2-sol' end;
			end if;
			insert into public.qorpera_coding_sessions(worker_id, profile_id, environment_id, session_id, harness, model, repository, branch, claimed_paths)
			values (v_worker.id, p_profile_id, p_environment_id,
				(select run.session_id from public.qorpera_execution_runs run where run.id = v_commit.run_id),
				p_parse ->> 'harness', v_coding_model, p_parse -> 'repository', 'qorpera/coding/' || v_worker.id::text,
				coalesce((select array_agg(e #>> '{}') from jsonb_array_elements(coalesce(v_request -> 'claimedPaths', '[]'::jsonb)) as e), '{}'::text[]));$new$,
$old$		if v_worker.harness_default then
			v_worker := public.qorpera_claude_worker_resolve(v_worker.id, v_commit.run_id, v_commit.requester_id);
		elsif v_worker.harness = 'claude-code' then$old$,
$new$		if v_worker.harness_default then
			v_worker := public.qorpera_claude_worker_resolve(v_worker.id, v_commit.run_id, v_commit.requester_id);
		elsif v_worker.harness = 'claude-code' and v_worker.species = 'coding' then
			update public.qorpera_runtime_workers
			set claude_login_id = public.qorpera_coding_claude_login(p_profile_id, coalesce(v_worker.owner_user_id, v_worker.requested_by_user_id))
			where id = v_worker.id returning * into v_worker;
		elsif v_worker.harness = 'claude-code' then$new$
	]
);

drop function pg_temp.ccd_patch(regprocedure, text[]);

revoke all on function
	public.qorpera_coding_executor_enroll(uuid, text),
	public.qorpera_coding_claude_driver_ready(),
	public.qorpera_claude_worker_active_count(uuid, uuid),
	public.qorpera_claude_worker_waits(public.qorpera_runtime_workers),
	public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers, uuid),
	public.qorpera_claude_login_run(uuid, text, jsonb, boolean, boolean),
	public.qorpera_record_claude_run_usage(jsonb, jsonb),
	public.qorpera_coding_claude_login(uuid, uuid),
	public.qorpera_member_coding_default(uuid, uuid),
	public.qorpera_surface_resolve_coding_provider_binding(uuid, uuid, boolean, text),
	public.qorpera_surface_resolve_coding_sponsor(uuid, uuid, uuid, boolean, text, boolean),
	public.qorpera_coding_owner_problem(uuid, uuid, text, uuid),
	public.qorpera_coding_owner_payer(uuid, uuid, text, uuid),
	public.qorpera_coding_session_claim_json(public.qorpera_coding_sessions, public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_record_claude_run_usage(jsonb, jsonb) to service_role;

do $$
declare
	v_owner name;
begin
	for v_owner in
		select distinct pg_get_userbyid(proowner)
		from pg_proc
		where oid = any(array[
			'public.qorpera_surface_resolve_coding_sponsor(uuid,uuid,uuid,boolean,text,boolean)'::regprocedure,
			'public.qorpera_surface_enqueue_session_run(uuid,uuid)'::regprocedure,
			'public.qorpera_coding_owner_problem(uuid,uuid,text,uuid)'::regprocedure,
			'public.qorpera_coding_owner_payer(uuid,uuid,text,uuid)'::regprocedure,
			'public.qorpera_company_state_worker_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
			'public.qorpera_company_state_index_worker(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
			'public.qorpera_claim_coding_session(text,integer)'::regprocedure,
			'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
			'public.qorpera_defer_coding_session(uuid,uuid,text)'::regprocedure,
			'public.qorpera_coding_session_login_state(public.qorpera_runtime_workers)'::regprocedure
		])
	loop
		if v_owner in ('anon', 'authenticated', 'service_role', 'qorpera_secret_broker') then
			raise exception '20260930909000: patched function has an API owner: %', v_owner;
		end if;
		execute format(
			'grant execute on function public.qorpera_coding_claude_driver_ready(), '
			|| 'public.qorpera_claude_worker_active_count(uuid, uuid), '
			|| 'public.qorpera_coding_claude_login(uuid, uuid), '
			|| 'public.qorpera_member_coding_default(uuid, uuid), '
			|| 'public.qorpera_surface_resolve_coding_provider_binding(uuid, uuid, boolean, text), '
			|| 'public.qorpera_claude_worker_waits(public.qorpera_runtime_workers), '
			|| 'public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers, uuid) to %I',
			v_owner
		);
	end loop;
end $$;
