-- @fixture 856_folder_company_creation.test.sql until "-- 4. No usable login"

create function pg_temp.sao_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
	if not coalesce(p_condition, false) then
		raise exception 'surface_automation_owner: %', p_message;
	end if;
end $$;

create function pg_temp.sao_as(p_user_id uuid)
returns void language sql as $$
	select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text, true)::text::void
$$;

create function pg_temp.sao_payer(p_binding uuid)
returns uuid language sql as $$
	select created_by_user_id from public.qorpera_execution_sponsor_bindings where id = p_binding
$$;

create function pg_temp.sao_offer(p_user uuid, p_automation uuid, p_to uuid)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.sao_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_offer_surface_automation(p_automation, p_to);
	reset role;
	return v_result;
end $$;

create function pg_temp.sao_answer(p_user uuid, p_offer uuid, p_yes boolean)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
	perform pg_temp.sao_as(p_user);
	set local role authenticated;
	v_result := public.qorpera_answer_surface_automation_offer(p_offer, p_yes);
	reset role;
	return v_result;
end $$;

create function pg_temp.sao_listed(p_user uuid, p_company uuid, p_automation uuid)
returns jsonb language plpgsql as $$
declare v_item jsonb;
begin
	perform pg_temp.sao_as(p_user);
	set local role authenticated;
	select elem into v_item from jsonb_array_elements(public.qorpera_list_automations(p_company)) elem
	where (elem ->> 'id')::uuid = p_automation;
	reset role;
	return v_item;
end $$;

create function pg_temp.sao_refused(p_user uuid, p_sql text, p_state text)
returns void language plpgsql as $$
begin
	perform pg_temp.sao_as(p_user);
	set local role authenticated;
	begin
		execute p_sql;
	exception when others then
		reset role;
		if sqlstate is distinct from p_state then
			raise exception 'surface_automation_owner: expected %, got % (%) from %', p_state, sqlstate, sqlerrm, p_sql;
		end if;
		return;
	end;
	reset role;
	raise exception 'surface_automation_owner: expected % from %', p_state, p_sql;
end $$;

create function pg_temp.sao_due(p_automation uuid)
returns jsonb language plpgsql as $$
declare v_claimed jsonb;
begin
	update public.qorpera_surface_automations
	set next_run_at = clock_timestamp() - interval '1 minute'
	where id = p_automation;
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_due_automations(16);
	reset role;
	return (select elem from jsonb_array_elements(v_claimed) elem where (elem ->> 'automationId')::uuid = p_automation);
end $$;

create function pg_temp.sao_enqueue(p_session uuid)
returns jsonb language plpgsql as $$
declare
	v_claimed jsonb;
	v_lease uuid;
	v_enq jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_claimed := public.qorpera_surface_claim_pending_jobs_for_lane(16, 'sessions');
	select (elem ->> 'leaseToken')::uuid into strict v_lease
	from jsonb_array_elements(v_claimed -> 'sessions') elem
	where (elem ->> 'sessionId')::uuid = p_session;
	v_enq := public.qorpera_surface_enqueue_session_run(p_session, v_lease);
	reset role;
	return v_enq;
end $$;

create function pg_temp.sao_settle(p_session uuid)
returns void language plpgsql as $$
begin
	update public.qorpera_wake_occurrences
	set status = 'cancelled', finished_at = clock_timestamp(), blocked_reason = 'turn settled by the test'
	where source_id = p_session and status = 'queued';
	update public.qorpera_surface_sessions
	set state = 'ready', lease_token = null, lease_expires_at = null, wake_id = null, updated_at = clock_timestamp()
	where id = p_session;
end $$;

do $$
declare
	v_claim jsonb := current_setting('qorpera_test.claim')::jsonb;
	v_anna constant uuid := '85600000-0000-4000-8000-000000000001';
	v_bo constant uuid := '85600000-0000-4000-8000-000000000002';
	v_dee constant uuid := '13500000-0000-4000-8000-000000000004';
	v_vic constant uuid := '13500000-0000-4000-8000-000000000005';
	v_eve constant uuid := '13500000-0000-4000-8000-000000000006';
	v_company uuid := (v_claim ->> 'profileId')::uuid;
	v_automation uuid;
	v_agent_automation uuid;
	v_offer uuid;
	v_result jsonb;
	v_item jsonb;
	v_due jsonb;
	v_enq jsonb;
	v_wake public.qorpera_wake_occurrences%rowtype;
	v_row public.qorpera_surface_automations%rowtype;
	v_session public.qorpera_surface_sessions%rowtype;
	v_kept_session uuid;
	v_last_run timestamptz;
begin
	update public.qorpera_surface_settings set enabled = true, updated_at = clock_timestamp() where singleton = true;
	insert into auth.users(id, email) values
		(v_dee, 'dee-sao@example.test'), (v_vic, 'vic-sao@example.test'), (v_eve, 'eve-sao@example.test');
	insert into public.qorpera_profile_members(profile_id, user_id, email, display_name, role) values
		(v_company, v_dee, 'dee-sao@example.test', 'Dee', 'contributor'),
		(v_company, v_vic, 'vic-sao@example.test', 'Vic', 'viewer'),
		(v_company, v_eve, 'eve-sao@example.test', 'Eve', 'contributor');

	perform pg_temp.sao_as(v_anna);
	set local role authenticated;
	perform public.qorpera_create_surface(v_company, 'Identity', 'identity', 'studio', 'identity', 'spark', '#7c5cff', 'identity', null, true);
	v_result := public.qorpera_create_surface_automation(v_company, 'Tidy notes', 'Tidy the notes', 'Every day · 09:00', 'identity');
	reset role;
	v_automation := (v_result ->> 'id')::uuid;
	perform pg_temp.sao_assert(
		(v_result ->> 'ownerUserId')::uuid = v_anna and (v_result ->> 'ownable')::boolean and v_result -> 'offer' = 'null'::jsonb,
		'a member''s new automation is owned by that member: ' || v_result::text
	);

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_native_surface_manage_automation(v_company, 'create', null, 'Pulse', 'Check things', 'Every day · 09:00', null, true);
	reset role;
	v_agent_automation := (v_result ->> 'id')::uuid;
	perform pg_temp.sao_assert(
		(select owner_user_id from public.qorpera_surface_automations where id = v_agent_automation)
			= (select created_by_user_id from public.qorpera_company_cofounders where profile_id = v_company),
		'an agent''s automation is owned by the member who started the company'
	);
	delete from public.qorpera_surface_automations where id = v_agent_automation;

	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	perform public.qorpera_service_bootstrap_company_surfaces(v_company, null);
	reset role;
	perform pg_temp.sao_assert(
		(select owner_user_id from public.qorpera_surface_automations where profile_id = v_company and key = 'cofounder-pulse')
			= (select created_by_user_id from public.qorpera_company_cofounders where profile_id = v_company),
		'the Co-Founder Pulse is owned by the member who started the company'
	);
	update public.qorpera_surface_automations set enabled = false, next_run_at = null
	where profile_id = v_company and key = 'cofounder-pulse';

	v_due := pg_temp.sao_due(v_automation);
	select * into strict v_session from public.qorpera_surface_sessions where id = (v_due ->> 'sessionId')::uuid;
	perform pg_temp.sao_assert(
		v_session.created_by_user_id = v_anna and (v_session.origin_ref ->> 'automationId')::uuid = v_automation
			and v_session.origin_kind = 'automation',
		'a due run starts a session on the owner''s behalf'
	);
	v_kept_session := v_session.id;

	perform pg_temp.sao_refused(v_dee, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_bo), '42501');
	perform pg_temp.sao_refused(v_anna, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_vic), '22023');
	perform pg_temp.sao_refused(v_vic, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_vic), '42501');

	v_result := pg_temp.sao_offer(v_anna, v_automation, v_bo);
	v_offer := (v_result -> 'automation' -> 'offer' ->> 'id')::uuid;
	perform pg_temp.sao_assert(
		not (v_result ->> 'moved')::boolean and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_anna
			and v_result -> 'automation' -> 'offer' ->> 'status' = 'open'
			and (v_result -> 'automation' -> 'offer' ->> 'toUserId')::uuid = v_bo,
		'handing over opens an offer and keeps the owner: ' || v_result::text
	);
	v_item := pg_temp.sao_listed(v_bo, v_company, v_automation);
	perform pg_temp.sao_assert((v_item -> 'offer' ->> 'id')::uuid = v_offer, 'the teammate sees the offer in the list');
	perform pg_temp.sao_refused(v_anna, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_dee), '55P03');
	perform pg_temp.sao_refused(v_dee, format('select public.qorpera_answer_surface_automation_offer(%L, true)', v_offer), '42501');

	v_result := pg_temp.sao_answer(v_anna, v_offer, false);
	perform pg_temp.sao_assert(
		v_result ->> 'status' = 'withdrawn' and v_result -> 'automation' -> 'offer' = 'null'::jsonb,
		'the owner takes the offer back: ' || v_result::text
	);

	v_offer := (pg_temp.sao_offer(v_anna, v_automation, v_bo) -> 'automation' -> 'offer' ->> 'id')::uuid;
	v_result := pg_temp.sao_answer(v_bo, v_offer, false);
	perform pg_temp.sao_assert(
		v_result ->> 'status' = 'no' and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_anna
			and v_result -> 'automation' -> 'offer' ->> 'status' = 'no',
		'a no closes the offer, keeps the owner and is shown to the owner: ' || v_result::text
	);

	v_offer := (pg_temp.sao_offer(v_anna, v_automation, v_bo) -> 'automation' -> 'offer' ->> 'id')::uuid;
	v_result := pg_temp.sao_answer(v_bo, v_offer, true);
	perform pg_temp.sao_assert(
		v_result ->> 'status' = 'yes' and (v_result ->> 'moved')::boolean
			and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_bo and v_result -> 'automation' -> 'offer' = 'null'::jsonb,
		'a yes makes the teammate the owner: ' || v_result::text
	);

	v_enq := pg_temp.sao_enqueue(v_kept_session);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.sao_assert(
		v_wake.requested_by_user_id = v_anna and pg_temp.sao_payer(v_wake.sponsor_binding_id) = v_anna,
		'a run started before the hand-over keeps the old owner''s login: ' || v_enq::text
	);
	perform pg_temp.sao_settle(v_kept_session);

	v_due := pg_temp.sao_due(v_automation);
	v_enq := pg_temp.sao_enqueue((v_due ->> 'sessionId')::uuid);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.sao_assert(
		v_wake.requested_by_user_id = v_bo and pg_temp.sao_payer(v_wake.sponsor_binding_id) = v_bo
			and not (v_wake.payload ->> 'memberInitiated')::boolean,
		'the new owner''s login pays for runs from then on: ' || v_enq::text
	);
	perform pg_temp.sao_settle((v_due ->> 'sessionId')::uuid);

	perform pg_temp.sao_as(v_anna);
	set local role authenticated;
	perform public.qorpera_reply_surface_session((v_due ->> 'sessionId')::uuid, 'Also tidy the drafts', true);
	reset role;
	v_enq := pg_temp.sao_enqueue((v_due ->> 'sessionId')::uuid);
	select * into strict v_wake from public.qorpera_wake_occurrences where id = (v_enq ->> 'wakeId')::uuid;
	perform pg_temp.sao_assert(
		v_wake.requested_by_user_id = case
			when to_regprocedure('public.qorpera_surface_turn_requester(public.qorpera_surface_sessions)') is null then v_bo
			else v_anna end,
		'a teammate''s reply in an automation''s session is paid by the owner, or by the replier once replies are their own turns: '
			|| v_enq::text
	);
	perform pg_temp.sao_settle((v_due ->> 'sessionId')::uuid);

	v_result := pg_temp.sao_offer(v_anna, v_automation, v_dee);
	v_offer := (v_result -> 'automation' -> 'offer' ->> 'id')::uuid;
	perform pg_temp.sao_assert(
		(v_result -> 'automation' -> 'offer' ->> 'fromUserId')::uuid = v_bo
			and (v_result -> 'automation' -> 'offer' ->> 'offeredByUserId')::uuid = v_anna,
		'a company owner hands over a member''s automation: ' || v_result::text
	);
	perform pg_temp.sao_refused(v_bo, format('select public.qorpera_answer_surface_automation_offer(%L, true)', v_offer), '42501');
	perform pg_temp.sao_assert(
		pg_temp.sao_answer(v_anna, v_offer, false) ->> 'status' = 'withdrawn',
		'the company owner who offered it takes the offer back'
	);

	v_offer := (pg_temp.sao_offer(v_bo, v_automation, v_dee) -> 'automation' -> 'offer' ->> 'id')::uuid;
	update public.qorpera_surface_automations set owner_user_id = v_anna where id = v_automation;
	v_result := pg_temp.sao_answer(v_dee, v_offer, true);
	perform pg_temp.sao_assert(
		v_result ->> 'status' = 'void' and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_anna,
		'a yes after the owner changed moves nothing: ' || v_result::text
	);
	update public.qorpera_surface_automations set owner_user_id = v_bo where id = v_automation;

	v_offer := (pg_temp.sao_offer(v_bo, v_automation, v_eve) -> 'automation' -> 'offer' ->> 'id')::uuid;
	delete from auth.users where id = v_eve;
	perform pg_temp.sao_assert(
		(select status from public.qorpera_surface_automation_offers where id = v_offer) = 'void',
		'an offer to an account that is deleted is void'
	);

	v_offer := (pg_temp.sao_offer(v_bo, v_automation, v_dee) -> 'automation' -> 'offer' ->> 'id')::uuid;
	perform pg_temp.sao_answer(v_dee, v_offer, true);
	select last_run_at into v_last_run from public.qorpera_surface_automations where id = v_automation;
	v_due := pg_temp.sao_due(v_automation);
	select * into strict v_row from public.qorpera_surface_automations where id = v_automation;
	perform pg_temp.sao_assert(
		v_due is null and v_row.status = 'needs_attention' and v_row.last_run_at is not distinct from v_last_run
			and v_row.next_run_at > clock_timestamp()
			and not exists (select 1 from public.qorpera_surface_sessions where origin_ref ->> 'automationId' = v_automation::text
				and created_by_user_id = v_dee),
		'an owner with no login that pays gets no run, and it waits for the next time'
	);
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_trigger_automation(v_automation);
	reset role;
	perform pg_temp.sao_assert(v_result ->> 'reason' = 'no_login', 'a direct start refuses an owner with no login: ' || v_result::text);

	delete from public.qorpera_profile_members where profile_id = v_company and user_id = v_dee;
	v_item := pg_temp.sao_listed(v_anna, v_company, v_automation);
	perform pg_temp.sao_assert(v_item -> 'ownerUserId' = 'null'::jsonb, 'an owner who leaves leaves it with nobody: ' || v_item::text);
	perform pg_temp.sao_assert(pg_temp.sao_due(v_automation) is null, 'an automation nobody owns does not run');
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	set local role service_role;
	v_result := public.qorpera_surface_trigger_automation(v_automation);
	reset role;
	perform pg_temp.sao_assert(v_result ->> 'reason' = 'nobody', 'a direct start refuses nobody''s automation: ' || v_result::text);

	perform pg_temp.sao_refused(v_anna, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_vic), '22023');
	perform pg_temp.sao_refused(v_vic, format('select public.qorpera_offer_surface_automation(%L, %L)', v_automation, v_vic), '42501');
	v_result := pg_temp.sao_offer(v_anna, v_automation, v_bo);
	v_offer := (v_result -> 'automation' -> 'offer' ->> 'id')::uuid;
	perform pg_temp.sao_assert(
		not (v_result ->> 'moved')::boolean and v_result -> 'automation' -> 'offer' -> 'fromUserId' = 'null'::jsonb,
		'a company owner offers nobody''s automation to a member: ' || v_result::text
	);
	perform pg_temp.sao_answer(v_bo, v_offer, false);
	v_result := pg_temp.sao_offer(v_bo, v_automation, v_bo);
	perform pg_temp.sao_assert(
		(v_result ->> 'moved')::boolean and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_bo
			and v_result -> 'automation' ->> 'status' = 'idle',
		'any member takes nobody''s automation at once, and it may run on their login: ' || v_result::text
	);

	update public.qorpera_surface_automations set owner_user_id = null where id = v_automation;
	v_offer := (pg_temp.sao_offer(v_anna, v_automation, v_bo) -> 'automation' -> 'offer' ->> 'id')::uuid;
	v_result := pg_temp.sao_answer(v_bo, v_offer, true);
	perform pg_temp.sao_assert(
		v_result ->> 'status' = 'yes' and (v_result -> 'automation' ->> 'ownerUserId')::uuid = v_bo,
		'a yes to an offer of nobody''s automation makes the member its owner: ' || v_result::text
	);

	v_due := pg_temp.sao_due(v_automation);
	v_kept_session := (v_due ->> 'sessionId')::uuid;
	v_offer := (pg_temp.sao_offer(v_bo, v_automation, v_anna) -> 'automation' -> 'offer' ->> 'id')::uuid;
	update public.qorpera_profile_members set role = 'viewer' where profile_id = v_company and user_id = v_bo;
	select * into strict v_row from public.qorpera_surface_automations where id = v_automation;
	perform pg_temp.sao_assert(
		v_row.owner_user_id is null
			and (select status from public.qorpera_surface_automation_offers where id = v_offer) = 'void',
		'an owner who becomes a viewer leaves it with nobody, and the open offer is void'
	);
	v_enq := pg_temp.sao_enqueue(v_kept_session);
	perform pg_temp.sao_assert(
		v_enq ->> 'status' = 'unavailable' and v_enq ->> 'reason' = 'no_member',
		'a session of an automation never falls to another member''s login: ' || v_enq::text
	);
end $$;
