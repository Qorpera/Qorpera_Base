-- Sign in with ChatGPT: a member's own "Turn on" also starts the routines that wait only for it (coordinator's
-- decision, 2026-10-01 09:18Z; follows the founder's decision 1: the card exists so the routine runs). Built
-- switched off with plan logins.
--
-- An agent's routine save for a member whose ChatGPT plan is not turned on finds no payer: the version pins the
-- run's own sponsor and the routine waits (paused, needs_model_account) until it is saved again. Now, when the member
-- turns the plan on (qorpera_set_chatgpt_plan_work_while_away, p_on true, from Settings' switch or the first-routine
-- card), the same call starts each routine that:
-- * waits for a payer (paused, needs_model_account), was made by an agent, and is in that company;
-- * runs for that member (its current version's creator, the web's runs_for_user_id) and is paid by that same plan
--   (its current version's sponsor version pays with this connection);
-- * has no listener (a file change or an event: a plan never pays for one), is no folder-v2 file routine, and is not
--   past its end;
-- and only in a company that is not being deleted (qorpera_member_role) and not folder-v2 (qorpera_company_is_folder_v2,
-- the agent tools' own refusal: there the agents write routine files).
-- Each is re-pinned and resumed: the plan's unattended binding for the version just turned on, made as
-- qorpera_ensure_unattended_sponsor makes it (the same derived client id, binding and sponsor version 1), so a later
-- agent save or ensure finds this one; a new routine version that copies the current one with only the sponsor, the
-- version number, its own id and time changed, and content_sha256 computed as qorpera_manage_agent_routine computes
-- it (so the agent's next identical save is not a new version); each schedule trigger's cursor from
-- qorpera_routine_version_schedule_position (paused to active, as an agent's save); and the routine active. Nothing
-- comes from the caller beyond the three arguments: the content, schedule and agent stay as the agent and admins set
-- them. Turning a plan off starts nothing. A dynamic routine's next run comes from the tick
-- (qorpera_restore_dynamic_routine_runs), not from this call, so a refused wake never fails the member's switch.
-- The answer is the consent call's, plus resumed_routines (the started routines' ids, in id order; [] when none).
--
-- The record: the new version itself, marked resume_reason = 'plan_turned_on'. Its creator is the member and its
-- created_at the time, so it reads "resumed when <member> turned on work while away". qorpera_list_cloud_routines,
-- which the routines view reads, names it on the routine while that version is current (resume_reason, resumed_at,
-- resumed_by_user_id). A later save writes a version without the mark. No table or notification kind is added.
--
-- Locks, in this order, and only when the member has such a routine (with none, the call is the consent as before):
-- 1. The company row FOR KEY SHARE. The new version's foreign key to the company takes this lock anyway (every routine
--    save's insert does); here it is taken first, before the routines and the connection. An agent's tool call takes
--    the company row FOR UPDATE (its fence) before a routine or a login (#377's order), and holds its run's login FOR
--    SHARE; a call that held the plan's connection and then waited for the company row at the insert would deadlock
--    with an agent's call that runs on that plan. It waits only for calls in flight in this company, as the insert
--    would; the wake materializer takes the row NOWAIT and skips the company meanwhile.
-- 2. The routines FOR UPDATE SKIP LOCKED, in id order, before the connection (an agent's save takes its routine, then
--    its login). A routine busy elsewhere (an agent's save, a run's commit holding it KEY SHARE, the expiry sweep, the
--    dynamic tick) is left waiting, never waited for. Each locked routine is read again under its lock.
-- 3. The consent call's own locks, unchanged: the member row FOR SHARE, then the connection FOR UPDATE.
-- 4. Writes: the binding (its derived client id is one per connection version, and the connection lock serializes
--    its makers), versions and cursors of locked routines (keys no one else can write), the routine rows. Their
--    triggers: the new version's listener activation returns at once (no listener); the routine's pending trigger
--    cancels the old version's queued wakes, its listener sync updates old cursors of this routine, its status
--    triggers clear the pause reason, and the resume-restarts-schedule trigger does not fire (the version changes).
-- No company-wide lock beyond that key share, and no wait for a routine. Every wait of the call is bounded, also
-- the consent's (up to the API role's 8 s before, 20260913000100): the function's lock_timeout is 2 s, and a lock
-- timeout anywhere in it answers 55P03 "Busy right now. Try again in a moment." with nothing changed, so a member's
-- toggle never hangs behind a long hold (an agent's fence, the GC, a deletion).

set local lock_timeout = '3s';

-- The record of a resume: the version a member's turn-on wrote. Null for every other version.
alter table public.qorpera_cloud_routine_versions add column resume_reason text
	constraint qorpera_cloud_routine_versions_resume_reason check (resume_reason is null or resume_reason = 'plan_turned_on');

-- Whether a routine waits only for its member's ChatGPT plan: an agent's routine waiting for a payer, whose current
-- version runs for p_user_id and is paid by p_connection_id, with no listener, no folder file, not past its end.
create function public.qorpera_routine_waits_for_member_plan(p_routine_id uuid, p_user_id uuid, p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_cloud_routines as routine
		join public.qorpera_cloud_routine_versions as version
			on version.routine_id = routine.id and version.version = routine.current_version
		join public.qorpera_execution_sponsor_versions as sponsor
			on sponsor.binding_id = version.sponsor_binding_id and sponsor.version = version.sponsor_version
		where routine.id = p_routine_id and routine.status = 'paused' and routine.pause_reason = 'needs_model_account'
			and routine.origin = 'agent' and routine.folder_path is null
			and (routine.expires_at is null or routine.expires_at > statement_timestamp())
			and version.created_by_user_id = p_user_id and sponsor.provider_connection_id = p_connection_id
			and not exists (select 1 from jsonb_array_elements(version.triggers) as trigger(value)
				where trigger.value ->> 'kind' = 'listener'))
$$;
revoke all on function public.qorpera_routine_waits_for_member_plan(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.qorpera_set_chatgpt_plan_work_while_away(p_profile_id uuid, p_connection_id uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_user uuid := auth.uid(); v_result jsonb; v_id uuid;
	v_waiting uuid[] := '{}'; v_locked uuid[] := '{}'; v_ready uuid[] := '{}'; v_resumed uuid[] := '{}';
	v_routine public.qorpera_cloud_routines%rowtype; v_current public.qorpera_cloud_routine_versions%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
	v_connection_version bigint; v_hex text; v_client uuid; v_binding uuid; v_at timestamptz; v_sha text;
begin
	-- A wait for any one lock ends after 2 s (the function's lock_timeout, below) as a plain "busy" the web shows
	-- (55P03, a retry code PostgREST does not replay); this block's rollback undoes all the call did, the member's choice mark included. Every
	-- other error is raised as it was.
	begin
		if v_user is null or p_on is null or p_connection_id is null or p_profile_id is null
			or not exists (select 1 from public.qorpera_provider_connections as connection
				where connection.id = p_connection_id and connection.profile_id = p_profile_id
					and connection.owner_user_id = v_user and connection.status = 'active')
			or not public.qorpera_connection_is_chatgpt_plan(p_connection_id) then
			raise exception 'ChatGPT plan login is unavailable' using errcode = '42501'; end if;
		-- Turning the plan on also starts the member's routines that wait only for it (20260929985000): found here
		-- without locks, then locked (header: company row, routines, then the consent's member row and connection).
		if p_on and public.qorpera_member_role(p_profile_id) is not null
			and not public.qorpera_company_is_folder_v2(p_profile_id) then
			v_waiting := array(select routine.id from public.qorpera_cloud_routines as routine
				where routine.profile_id = p_profile_id and routine.status = 'paused'
					and routine.pause_reason = 'needs_model_account'
					and public.qorpera_routine_waits_for_member_plan(routine.id, v_user, p_connection_id)
				order by routine.id);
		end if;
		if cardinality(v_waiting) > 0 then
			perform 1 from public.qorpera_profiles as profile where profile.id = p_profile_id for key share;
			for v_id in select routine.id from public.qorpera_cloud_routines as routine
				where routine.id = any(v_waiting) order by routine.id for update skip locked loop
				v_locked := v_locked || v_id;
			end loop;
		end if;
		perform set_config('qorpera.chatgpt_plan_member_choice', p_connection_id::text, true);
		v_result := public.qorpera_consent_provider_connection_autonomous(p_profile_id, p_connection_id, p_on);
		perform set_config('qorpera.chatgpt_plan_member_choice', '', true);
		-- Read again under the locks: the routine, the company (a deletion request takes the company row FOR UPDATE,
		-- which the key share holds off; the folder core is switched on only for an untouched company), and the consent's
		-- answer.
		if cardinality(v_locked) > 0 and (v_result ->> 'allow_autonomous') = 'true'
			and public.qorpera_member_role(p_profile_id) is not null and not public.qorpera_company_is_folder_v2(p_profile_id) then
			v_ready := array(select locked.id from unnest(v_locked) as locked(id)
				where public.qorpera_routine_waits_for_member_plan(locked.id, v_user, p_connection_id) order by locked.id);
		end if;
		if cardinality(v_ready) = 0 then
			return v_result || jsonb_build_object('resumed_routines', '[]'::jsonb);
		end if;

		-- The plan's unattended binding for the version just turned on, as qorpera_ensure_unattended_sponsor makes it.
		v_connection_version := (v_result ->> 'version')::bigint;
		v_hex := encode(extensions.digest(convert_to('qorpera.unattended-sponsor/v1:' || p_connection_id::text || ':' ||
			v_connection_version::text, 'utf8'), 'sha256'), 'hex');
		v_client := (substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-4' || substr(v_hex, 14, 3) || '-8'
			|| substr(v_hex, 18, 3) || '-' || substr(v_hex, 21, 12))::uuid;
		select binding.id into v_binding from public.qorpera_execution_sponsor_bindings as binding
		where binding.profile_id = p_profile_id and binding.client_binding_id = v_client;
		if v_binding is null then
			insert into public.qorpera_execution_sponsor_bindings(profile_id, client_binding_id, created_by_user_id)
			values (p_profile_id, v_client, v_user) returning id into v_binding;
			insert into public.qorpera_execution_sponsor_versions(binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id)
			values (v_binding, 1, 'member_connection', p_connection_id, v_connection_version, true, v_user);
		end if;
		select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_binding order by sponsor.version desc limit 1;
		-- Only on that same plan: a binding that pays with another login now, or is switched off, starts nothing.
		if v_sponsor.provider_connection_id is distinct from p_connection_id or not v_sponsor.allow_autonomous
			or v_sponsor.sponsor_kind <> 'member_connection'
			or not exists (select 1 from public.qorpera_execution_sponsor_bindings as binding
				where binding.id = v_binding and binding.status = 'active') then
			return v_result || jsonb_build_object('resumed_routines', '[]'::jsonb);
		end if;

		foreach v_id in array v_ready loop
			select * into strict v_routine from public.qorpera_cloud_routines where id = v_id;
			select * into strict v_current from public.qorpera_cloud_routine_versions
			where routine_id = v_id and version = v_routine.current_version;
			v_at := clock_timestamp();
			-- What qorpera_manage_agent_routine hashes, with the new sponsor.
			v_sha := encode(extensions.digest(convert_to(jsonb_build_object('staff_agent_id', v_current.staff_agent_id,
				'title', v_current.title, 'prompt', v_current.prompt, 'triggers', v_current.triggers, 'effort', v_current.effort,
				'sponsor_binding_id', v_binding, 'sponsor_version', v_sponsor.version,
				'logical_computer_id', v_current.logical_computer_id, 'required_capability', v_current.required_capability,
				'job_type', v_current.job_type, 'publication_mode', v_current.publication_mode,
				'review_policy_key', v_current.review_policy_key,
				'reviewer_staff_ids', to_jsonb(v_current.reviewer_staff_ids))::text, 'utf8'), 'sha256'), 'hex');
			insert into public.qorpera_cloud_routine_versions
			select (jsonb_populate_record(null::public.qorpera_cloud_routine_versions, to_jsonb(v_current)
				|| jsonb_build_object('version', v_routine.current_version + 1, 'client_version_id', extensions.gen_random_uuid(),
					'sponsor_binding_id', v_binding, 'sponsor_version', v_sponsor.version, 'content_sha256', v_sha,
					'created_at', v_at, 'resume_reason', 'plan_turned_on'))).*;
			-- Each schedule trigger's position, as an agent's save that switches a paused routine on.
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id,
				last_scheduled_for, next_due_at)
			select v_id, v_routine.current_version + 1, trigger.value ->> 'id', position.last_scheduled_for, position.next_due_at
			from jsonb_array_elements(v_current.triggers) as trigger(value)
			cross join lateral public.qorpera_routine_version_schedule_position(v_id, v_routine.current_version,
				trigger.value, v_at, false, true) as position
			where trigger.value ->> 'kind' = 'schedule';
			update public.qorpera_cloud_routines set current_version = v_routine.current_version + 1, status = 'active',
				pause_reason = null, authorization_failures = 0, updated_at = statement_timestamp()
			where id = v_id;
			v_resumed := v_resumed || v_id;
		end loop;
		return v_result || jsonb_build_object('resumed_routines', to_jsonb(v_resumed));
	exception when lock_not_available then
		raise exception 'Busy right now. Try again in a moment.' using errcode = '55P03';
	end;
end
$$;
revoke all on function public.qorpera_set_chatgpt_plan_work_while_away(uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.qorpera_set_chatgpt_plan_work_while_away(uuid, uuid, boolean) to authenticated;
-- A member's switch waits at most 2 s for any one lock, so it never hangs behind a long hold (the GC fence, a
-- deletion), as the folder byte functions (20260928339780). lock_timeout is a function setting PostgreSQL allows
-- any owner (only custom qorpera.* settings need a superuser). A later `create or replace` must repeat it (779 checks).
alter function public.qorpera_set_chatgpt_plan_work_while_away(uuid, uuid, boolean) set lock_timeout = '2s';

-- The routine list names a resume while its version is current.
create function pg_temp.qorpera_plan_resume_20260929985000_patch(p_target regprocedure, p_anchor text, p_replacement text)
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target); v_count integer;
begin
	if position('20260929985000' in v_definition) > 0 then return; end if;
	v_count := (length(v_definition) - length(replace(v_definition, p_anchor, ''))) / length(p_anchor);
	if v_count <> 1 then
		raise exception '% source differs (anchor matches % times)', p_target, v_count; end if;
	execute replace(v_definition, p_anchor, p_replacement);
end
$patch$;

select pg_temp.qorpera_plan_resume_20260929985000_patch('public.qorpera_list_cloud_routines(uuid)'::regprocedure,
	$a0$			'runs_for_user_id', version.created_by_user_id,
$a0$, $r0$			'runs_for_user_id', version.created_by_user_id,
			-- The current version is a resume: its member turned on work while away for the plan that pays
			-- (20260929985000). Null for any other version.
			'resume_reason', version.resume_reason,
			'resumed_at', case when version.resume_reason is not null then version.created_at end,
			'resumed_by_user_id', case when version.resume_reason is not null then version.created_by_user_id end,
$r0$);
