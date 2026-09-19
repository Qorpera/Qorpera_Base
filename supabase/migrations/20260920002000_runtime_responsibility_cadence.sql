-- Order 8, part 2: a responsibility keeps its own cadence (contract 14.3, 19).
--
-- "attention cadence: how often the owner reviews the outcome absent events" was
-- recorded on every responsibility but nothing acted on it, so a responsibility
-- was only looked at when somebody asked. An active responsibility with a
-- recognised cadence now owns one schedule routine that wakes its accountable
-- agent. The routine follows the responsibility: a new owner, a new cadence, a
-- pause or a retirement changes or stops it in the same transaction.
--
-- A routine that is waiting for a model account (this one, or one an agent set
-- up for itself) starts by itself when a member allows unattended use of an
-- account. Nobody has to come back and resume it.

alter table public.qorpera_cloud_routines
	add column responsibility_id uuid,
	add constraint qorpera_cloud_routines_responsibility check (
		(origin = 'responsibility') = (responsibility_id is not null));
create unique index qorpera_cloud_routines_responsibility_once
	on public.qorpera_cloud_routines(responsibility_id) where origin = 'responsibility';

-- Minutes for a recognised cadence, else null. The scheduler's longest interval
-- is one week; a longer or free-text cadence stays a human-read field.
create function public.qorpera_responsibility_cadence_minutes(p_cadence text)
returns integer language plpgsql immutable set search_path = '' as $$
declare v_text text := lower(btrim(coalesce(p_cadence,''))); v_match text[]; v_minutes bigint;
begin
	if v_text = 'hourly' then return 60; elsif v_text = 'daily' then return 1440;
	elsif v_text = 'weekly' then return 10080; end if;
	v_match := regexp_match(v_text, '^every ([1-9][0-9]{0,3}) (minute|hour|day|week)s?$');
	if v_match is null then return null; end if;
	v_minutes := v_match[1]::bigint * case v_match[2] when 'minute' then 1 when 'hour' then 60 when 'day' then 1440 else 10080 end;
	if v_minutes between 5 and 10080 then return v_minutes::integer; end if;
	return null;
end
$$;

-- The account an unattended run for this member may use: a preferred binding
-- when it qualifies, else the member's own most recent one, else a company one.
create function public.qorpera_unattended_sponsor(p_profile_id uuid, p_user_id uuid, p_prefer_binding uuid default null)
returns table(binding_id uuid, version bigint)
language sql stable security definer set search_path = '' as $$
	select binding.id, sponsor.version
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	where binding.profile_id = p_profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and public.qorpera_provider_autonomous_authority(connection.id, sponsor.provider_connection_version)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and (binding.id = p_prefer_binding or sponsor.sponsor_kind <> 'member_connection'
			or connection.owner_user_id = p_user_id)
	order by (binding.id = p_prefer_binding) desc, (connection.owner_user_id = p_user_id) desc,
		sponsor.created_at desc, binding.id
	limit 1
$$;
revoke all on function public.qorpera_unattended_sponsor(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- A new head version of a routine: same identity, new content or sponsor.
create function public.qorpera_put_system_routine_version(p_routine_id uuid, p_staff uuid, p_title text, p_prompt text,
	p_trigger jsonb, p_binding uuid, p_sponsor_version bigint, p_user uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_content jsonb; v_sha text; v_next bigint;
	v_head public.qorpera_cloud_routine_versions%rowtype; v_triggers jsonb := jsonb_build_array(p_trigger);
begin
	select * into strict v_routine from public.qorpera_cloud_routines where id = p_routine_id for update;
	v_content := jsonb_build_object('staff_agent_id', p_staff, 'title', p_title, 'prompt', p_prompt, 'triggers', v_triggers,
		'effort', 'low', 'sponsor_binding_id', p_binding, 'sponsor_version', p_sponsor_version, 'logical_computer_id', null,
		'required_capability', 'agent_turn', 'job_type', 'agent_turn', 'publication_mode', 'automatic',
		'review_policy_key', null, 'reviewer_staff_ids', '[]'::jsonb);
	v_sha := encode(extensions.digest(convert_to(v_content::text,'utf8'),'sha256'),'hex');
	select * into v_head from public.qorpera_cloud_routine_versions
	where routine_id = p_routine_id and version = v_routine.current_version;
	if v_head.content_sha256 is not distinct from v_sha then return v_routine.current_version; end if;
	v_next := v_routine.current_version + 1;
	insert into public.qorpera_cloud_routine_versions(routine_id, version, client_version_id, profile_id, environment_id,
		staff_agent_id, title, prompt, triggers, effort, sponsor_binding_id, sponsor_version, logical_computer_id,
		required_capability, job_type, publication_mode, review_policy_key, reviewer_staff_ids, content_sha256, created_by_user_id)
	values (p_routine_id, v_next, extensions.gen_random_uuid(), v_routine.profile_id, v_routine.environment_id, p_staff,
		p_title, p_prompt, v_triggers, 'low', p_binding, p_sponsor_version, null, 'agent_turn', 'agent_turn', 'automatic',
		null, '{}', v_sha, p_user);
	insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id)
	select p_routine_id, v_next, p_trigger ->> 'id' where p_trigger ->> 'kind' = 'schedule';
	update public.qorpera_cloud_routines set current_version = v_next, updated_at = statement_timestamp()
	where id = p_routine_id;
	return v_next;
end
$$;
revoke all on function public.qorpera_put_system_routine_version(uuid, uuid, text, text, jsonb, uuid, bigint, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_sync_responsibility_cadence(p_responsibility_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
	v_r public.qorpera_company_responsibilities%rowtype; v_routine public.qorpera_cloud_routines%rowtype;
	v_minutes integer; v_user uuid; v_binding uuid; v_version bigint; v_wanted boolean; v_trigger jsonb; v_prompt text;
	v_head public.qorpera_cloud_routine_versions%rowtype;
begin
	select * into v_r from public.qorpera_company_responsibilities where id = p_responsibility_id;
	select * into v_routine from public.qorpera_cloud_routines
	where origin = 'responsibility' and responsibility_id = p_responsibility_id for update;
	v_minutes := public.qorpera_responsibility_cadence_minutes(v_r.attention_cadence);
	v_wanted := v_r.id is not null and v_r.status in ('active','degraded') and v_minutes is not null
		and exists (select 1 from public.qorpera_profile_staff staff where staff.profile_id = v_r.profile_id
			and staff.staff_agent_id = v_r.accountable_staff_agent_id and staff.employment_status = 'active'
			and staff.deleted_at is null);
	if not v_wanted then
		if v_routine.id is not null and v_routine.status in ('active','paused') then
			update public.qorpera_cloud_routines set
				status = case when v_r.id is null or v_r.status = 'retired' then 'retired' else 'paused' end,
				pause_reason = null, updated_at = statement_timestamp() where id = v_routine.id;
			return 'stopped';
		end if;
		return 'none';
	end if;
	select head.* into v_head from public.qorpera_cloud_routine_versions head
	where head.routine_id = v_routine.id and head.version = v_routine.current_version;
	-- Whose account carries the review: the accountable member, else the company
	-- owner, else whoever recorded the responsibility. Each must still be a member.
	foreach v_user in array array[v_r.accountable_user_id, public.qorpera_company_owner_user_id(v_r.profile_id), v_r.created_by_user_id] loop
		continue when v_user is null or not exists (select 1 from public.qorpera_profile_members member
			where member.profile_id = v_r.profile_id and member.user_id = v_user);
		select sponsor.binding_id, sponsor.version into v_binding, v_version
		from public.qorpera_unattended_sponsor(v_r.profile_id, v_user, v_head.sponsor_binding_id) sponsor;
		exit when v_binding is not null;
	end loop;
	if v_binding is null then
		v_user := coalesce(v_r.accountable_user_id, public.qorpera_company_owner_user_id(v_r.profile_id), v_r.created_by_user_id);
		-- A version must pin a sponsor, so without any unattended account there is
		-- nothing to save yet. The consent trigger below calls back in.
		if v_routine.id is not null and v_routine.status = 'active' then
			update public.qorpera_cloud_routines set status = 'paused', pause_reason = 'needs_model_account',
				updated_at = statement_timestamp() where id = v_routine.id;
		end if;
		insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
		values (v_r.profile_id, v_user, 'routine_needs_model_account',
			jsonb_build_object('staffAgentId', v_r.accountable_staff_agent_id, 'responsibilityId', v_r.id, 'title', v_r.name),
			'agent:' || v_r.accountable_staff_agent_id::text) on conflict do nothing;
		return 'needs_model_account';
	end if;
	v_trigger := jsonb_build_object('id','cadence','kind','schedule','intervalMinutes',v_minutes,'replyPolicy','optional',
		'startAt', to_char(date_trunc('milliseconds', coalesce(
			(select (head.triggers #>> '{0,startAt}')::timestamptz from public.qorpera_cloud_routine_versions head
				where head.routine_id = v_routine.id and head.version = v_routine.current_version
					and (head.triggers #>> '{0,intervalMinutes}')::integer = v_minutes),
			statement_timestamp() + make_interval(mins => v_minutes))) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
	v_prompt := 'Attention review of your responsibility "' || v_r.name || '". Read ' || v_r.source_path ||
		' for the current outcome, measures, sources, targets, guardrails and escalation threshold, then read the sources. ' ||
		'Observe, interpret, prioritize, execute what your standing authority allows, verify and record. ' ||
		'Escalate through escalate_responsibility only when the recorded threshold calls for it. ' ||
		'When nothing material changed, finish without sending.';
	if v_routine.id is null then
		insert into public.qorpera_cloud_routines(profile_id, environment_id, client_routine_id, status, created_by_user_id,
			origin, owner_staff_agent_id, routine_key, responsibility_id)
		values (v_r.profile_id, v_r.environment_id, extensions.gen_random_uuid(), 'paused', v_user, 'responsibility',
			v_r.accountable_staff_agent_id, 'responsibility.' || v_r.id::text, v_r.id)
		returning * into v_routine;
	end if;
	perform public.qorpera_put_system_routine_version(v_routine.id, v_r.accountable_staff_agent_id,
		left('Review: ' || v_r.name, 160), v_prompt, v_trigger, v_binding, v_version, v_user);
	update public.qorpera_cloud_routines set status = 'active', pause_reason = null, authorization_failures = 0,
		owner_staff_agent_id = v_r.accountable_staff_agent_id, updated_at = statement_timestamp()
	where id = v_routine.id and (status <> 'active' or owner_staff_agent_id <> v_r.accountable_staff_agent_id);
	return 'active';
end
$$;
revoke all on function public.qorpera_sync_responsibility_cadence(uuid) from public, anon, authenticated, service_role;

create function public.qorpera_responsibility_cadence_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_sync_responsibility_cadence(coalesce(new.id, old.id));
	return null;
end
$$;
create trigger qorpera_company_responsibility_cadence
	after insert or delete or update of attention_cadence, accountable_staff_agent_id, accountable_user_id, status, name
	on public.qorpera_company_responsibilities
	for each row execute function public.qorpera_responsibility_cadence_changed();

-- A member allows unattended use of an account: everything that was waiting
-- for one in that company starts.
create function public.qorpera_unattended_account_available()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_routine record; v_head public.qorpera_cloud_routine_versions%rowtype;
	v_binding uuid; v_version bigint; v_id uuid;
begin
	if not new.allow_autonomous then return null; end if;
	select binding.profile_id into v_profile from public.qorpera_execution_sponsor_bindings binding where binding.id = new.binding_id;
	for v_id in select responsibility.id from public.qorpera_company_responsibilities responsibility
		where responsibility.profile_id = v_profile and responsibility.status in ('active','degraded')
			and not exists (select 1 from public.qorpera_cloud_routines routine
				where routine.responsibility_id = responsibility.id and routine.status = 'active')
	loop perform public.qorpera_sync_responsibility_cadence(v_id); end loop;
	for v_routine in select routine.* from public.qorpera_cloud_routines routine
		where routine.profile_id = v_profile and routine.origin = 'agent' and routine.status = 'paused'
			and routine.pause_reason = 'needs_model_account' for update
	loop
		select * into v_head from public.qorpera_cloud_routine_versions head
		where head.routine_id = v_routine.id and head.version = v_routine.current_version;
		select sponsor.binding_id, sponsor.version into v_binding, v_version
		from public.qorpera_unattended_sponsor(v_profile, v_routine.created_by_user_id, v_head.sponsor_binding_id) sponsor;
		continue when v_binding is null;
		perform public.qorpera_put_system_routine_version(v_routine.id, v_head.staff_agent_id, v_head.title, v_head.prompt,
			v_head.triggers -> 0, v_binding, v_version, v_routine.created_by_user_id);
		update public.qorpera_cloud_routines set status = 'active', pause_reason = null, authorization_failures = 0,
			updated_at = statement_timestamp() where id = v_routine.id;
	end loop;
	return null;
end
$$;
create trigger qorpera_execution_sponsor_unattended after insert on public.qorpera_execution_sponsor_versions
	for each row execute function public.qorpera_unattended_account_available();

-- Responsibilities that already exist get their cadence now.
do $$
declare v_id uuid;
begin
	for v_id in select id from public.qorpera_company_responsibilities where status in ('active','degraded')
	loop perform public.qorpera_sync_responsibility_cadence(v_id); end loop;
end
$$;
