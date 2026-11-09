-- 20260930702000: the Co-Founder deals the team out between the members (Jonas, 9 Nov 2026: "let's give the co-founder
-- the tools to deal agents to the co-founders/members too").
--
-- 20260930700000 lets members move agents between them by an ask the other side says yes to. The Co-Founder now asks
-- too: with two or more founders it offers each of them the agents of the areas that fit them, so every founder's
-- ChatGPT carries part of the team, and later it offers a member's agents to another when one carries far more or
-- someone's ChatGPT is full. Nothing moves until the member asked says yes on the Members page.
--
-- * qorpera_cofounder_crew(binding): the company's members (name, role, their login's state as the Members page shows
--   it) and its agents with the member each works for, and the open asks. The Co-Founder's run only.
-- * qorpera_offer_agents_to_member(binding, {member, agents, why}): asks the member (a user id, an email, a full name or
--   a first name that names one member) to take each agent (an id or a name), with a short reason shown to them. An
--   agent that already works for that member, or already has an open ask, is left as it is and said so; a viewer is
--   never asked. All or none: an agent or member it cannot find refuses the whole call, naming who there is.
-- * Each ask keeps its reason (`why`) and the offer it came in (`batch`), and the Members page's read gives both.
-- * Two agents with the same name are told apart by id: a name that names more than one refuses, listing them.
-- Locks: the company's member rows FOR SHARE first, then the agents' staff rows, as a member's ask takes them
-- (20260930700000): a member leaving comes wholly before or after an offer. Every body carries 20260930702000.

alter table public.qorpera_agent_works_for_asks
	add column why text check (why is null or char_length(why) between 1 and 280),
	-- The asks one offer made together (the page answers them as one card); null for a member's single ask.
	add column batch uuid;

-- The Co-Founder's run whose wake allows work (never a worker's).
create function public.qorpera_cofounder_offer_run(p_binding jsonb)
returns public.qorpera_execution_runs
language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	-- 20260930702000
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null
		or not exists (select 1 from public.qorpera_company_cofounders as cofounder
			where cofounder.profile_id = v_run.profile_id and cofounder.staff_agent_id = v_run.staff_agent_id) then
		raise exception 'Only the Co-Founder deals agents to members' using errcode = '42501'; end if;
	return v_run;
end $$;
revoke all on function public.qorpera_cofounder_offer_run(jsonb) from public, anon, authenticated, service_role;

-- What the Co-Founder sees: members, agents and whom they work for, open asks.
create function public.qorpera_cofounder_crew(p_binding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	-- 20260930702000
	v_run := public.qorpera_cofounder_offer_run(p_binding);
	return jsonb_build_object('schema', 'qorpera.cofounder-crew/v1', 'runId', v_run.id,
		'members', coalesce((select jsonb_agg(jsonb_build_object(
				'userId', member.user_id,
				'name', coalesce(nullif(btrim(member.display_name), ''), member.email),
				'role', member.role,
				'login', public.qorpera_works_for_login_state(v_run.profile_id, member.user_id) - 'user_id')
			order by member.joined_at, member.user_id)
			from public.qorpera_profile_members as member where member.profile_id = v_run.profile_id), '[]'::jsonb),
		'agents', coalesce((select jsonb_agg(jsonb_build_object(
				'agentId', agent.staff_agent_id,
				'name', staff.display_name,
				-- Two agents with one name are offered by id.
				'sameName', exists (select 1 from public.qorpera_profile_staff as other
					where other.profile_id = v_run.profile_id and other.staff_agent_id <> agent.staff_agent_id
						and other.employment_status = 'active' and lower(other.display_name) = lower(staff.display_name)),
				'role', staff.role,
				'worksFor', public.qorpera_agent_works_for_user(v_run.profile_id, agent.staff_agent_id))
			order by staff.display_name, agent.staff_agent_id)
			from public.qorpera_works_for_agents(v_run.profile_id) as agent
			join public.qorpera_profile_staff as staff on staff.profile_id = v_run.profile_id
				and staff.staff_agent_id = agent.staff_agent_id), '[]'::jsonb),
		'asks', coalesce((select jsonb_agg(jsonb_build_object(
				'agentId', ask.staff_agent_id, 'to', ask.to_user_id, 'answerBy', ask.answer_by_user_id,
				'byAgent', ask.asked_by_staff_agent_id is not null, 'why', ask.why, 'at', ask.created_at)
			order by ask.created_at, ask.id)
			from public.qorpera_agent_works_for_asks as ask
			where ask.profile_id = v_run.profile_id and ask.status = 'open'), '[]'::jsonb));
end $$;
revoke all on function public.qorpera_cofounder_crew(jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_cofounder_crew(jsonb) to service_role;

-- Asks a member to take agents.
create function public.qorpera_offer_agents_to_member(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_member public.qorpera_profile_members%rowtype;
	v_names text;
	v_why text;
	v_wanted text;
	v_agent uuid;
	v_agents uuid[] := '{}';
	v_from uuid;
	v_asked jsonb := '[]';
	v_already jsonb := '[]';
	v_waiting jsonb := '[]';
	v_found integer;
	v_batch uuid := gen_random_uuid();
begin
	-- 20260930702000
	v_run := public.qorpera_cofounder_offer_run(p_binding);
	-- The members as they are until the offer is made: one who leaves meanwhile waits, or went first.
	perform public.qorpera_works_for_hold_members(v_run.profile_id);
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'member') is distinct from 'string'
		or jsonb_typeof(p_request -> 'agents') is distinct from 'array'
		or jsonb_array_length(p_request -> 'agents') not between 1 and 20
		or (p_request ? 'why' and jsonb_typeof(p_request -> 'why') not in ('string', 'null')) then
		raise exception 'Offer: member is a member, agents a list of 1 to 20 agents, why a short reason' using errcode = '22023';
	end if;
	v_why := nullif(btrim(p_request ->> 'why'), '');
	if v_why is not null and char_length(v_why) > 280 then
		raise exception 'Offer: why is at most 280 characters' using errcode = '22023'; end if;
	select string_agg(coalesce(nullif(btrim(m.display_name), ''), m.email), ', ' order by m.joined_at)
	into v_names from public.qorpera_profile_members as m where m.profile_id = v_run.profile_id and m.role <> 'viewer';
	-- The member: an id, an email, a full name, else a first name only one member has.
	v_wanted := btrim(p_request ->> 'member');
	select count(*) into v_found from public.qorpera_profile_members as m
	where m.profile_id = v_run.profile_id and (m.user_id::text = lower(v_wanted) or lower(m.email) = lower(v_wanted)
		or lower(btrim(m.display_name)) = lower(v_wanted));
	if v_found = 0 then
		select count(*) into v_found from public.qorpera_profile_members as m
		where m.profile_id = v_run.profile_id and lower(split_part(btrim(m.display_name), ' ', 1)) = lower(v_wanted);
		if v_found = 1 then
			select * into v_member from public.qorpera_profile_members as m
			where m.profile_id = v_run.profile_id and lower(split_part(btrim(m.display_name), ' ', 1)) = lower(v_wanted);
		end if;
	elsif v_found = 1 then
		select * into v_member from public.qorpera_profile_members as m
		where m.profile_id = v_run.profile_id and (m.user_id::text = lower(v_wanted) or lower(m.email) = lower(v_wanted)
			or lower(btrim(m.display_name)) = lower(v_wanted));
	end if;
	if v_member.user_id is null then
		raise exception 'Offer: % names no one member. The members are: %', v_wanted, coalesce(v_names, 'none')
			using errcode = '22023'; end if;
	if v_member.role = 'viewer' then
		raise exception 'Offer: % is a viewer and cannot take agents. The members are: %',
			coalesce(nullif(btrim(v_member.display_name), ''), v_member.email), coalesce(v_names, 'none') using errcode = '22023';
	end if;
	-- The agents: an id or a name, each one of the company's agents other than the Co-Founder.
	for v_wanted in select btrim(value) from jsonb_array_elements_text(p_request -> 'agents') loop
		select count(*), min(agent.staff_agent_id::text)::uuid into v_found, v_agent
		from public.qorpera_works_for_agents(v_run.profile_id) as agent
		join public.qorpera_profile_staff as staff on staff.profile_id = v_run.profile_id
			and staff.staff_agent_id = agent.staff_agent_id
		where agent.staff_agent_id::text = lower(v_wanted) or lower(staff.display_name) = lower(v_wanted);
		if v_found > 1 then
			raise exception 'Offer: % agents are called %: %. Name one by its id.', v_found, v_wanted,
				(select string_agg(format('%s (%s)', agent.staff_agent_id, staff.role), ', ' order by agent.staff_agent_id)
					from public.qorpera_works_for_agents(v_run.profile_id) as agent
					join public.qorpera_profile_staff as staff on staff.profile_id = v_run.profile_id
						and staff.staff_agent_id = agent.staff_agent_id
					where lower(staff.display_name) = lower(v_wanted)) using errcode = '22023';
		end if;
		if v_agent is null then
			raise exception 'Offer: no agent called %. Agents that can be offered: %', v_wanted,
				coalesce((select string_agg(staff.display_name, ', ' order by staff.display_name)
					from public.qorpera_works_for_agents(v_run.profile_id) as agent
					join public.qorpera_profile_staff as staff on staff.profile_id = v_run.profile_id
						and staff.staff_agent_id = agent.staff_agent_id), 'none') using errcode = '22023';
		end if;
		if not v_agent = any(v_agents) then v_agents := v_agents || v_agent; end if;
		v_agent := null;
	end loop;
	-- One change at a time per agent, in id order.
	perform 1 from public.qorpera_profile_staff
		where profile_id = v_run.profile_id and staff_agent_id = any(v_agents)
		order by staff_agent_id for update;
	foreach v_agent in array (select array_agg(id order by id) from unnest(v_agents) as id) loop
		v_from := public.qorpera_agent_works_for_user(v_run.profile_id, v_agent);
		if v_from is not distinct from v_member.user_id then
			v_already := v_already || to_jsonb((select display_name from public.qorpera_profile_staff
				where profile_id = v_run.profile_id and staff_agent_id = v_agent));
		elsif exists (select 1 from public.qorpera_agent_works_for_asks
			where profile_id = v_run.profile_id and staff_agent_id = v_agent and status = 'open') then
			v_waiting := v_waiting || to_jsonb((select display_name from public.qorpera_profile_staff
				where profile_id = v_run.profile_id and staff_agent_id = v_agent));
		else
			insert into public.qorpera_agent_works_for_asks(profile_id, staff_agent_id, from_user_id, to_user_id,
				asked_by_staff_agent_id, answer_by_user_id, why, batch)
			values (v_run.profile_id, v_agent, v_from, v_member.user_id, v_run.staff_agent_id, v_member.user_id, v_why, v_batch);
			v_asked := v_asked || to_jsonb((select display_name from public.qorpera_profile_staff
				where profile_id = v_run.profile_id and staff_agent_id = v_agent));
		end if;
	end loop;
	return jsonb_build_object('schema', 'qorpera.agent-offers/v1', 'runId', v_run.id,
		'member', coalesce(nullif(btrim(v_member.display_name), ''), v_member.email),
		'asked', v_asked, 'alreadyTheirs', v_already, 'alreadyAsked', v_waiting);
end $$;
revoke all on function public.qorpera_offer_agents_to_member(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_offer_agents_to_member(jsonb, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_cofounder_crew', 'binding'), ('qorpera_offer_agents_to_member', 'binding');

-- The tools' names among the operations a run's observations may name, after update_wall (20260930573000).
create function pg_temp.offers702_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if position('20260930702000' in v_definition) > 0 then
		raise exception '20260930702000 is already in %', p_function; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930702000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.offers702_replace('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$/* 20260930573000 */'update_wall',$old$,
	$new$/* 20260930573000 */'update_wall',/* 20260930702000 */'crew_and_members','offer_agents_to_member',$new$);

-- The Members page's read gives each ask's reason.
select pg_temp.offers702_replace('public.qorpera_read_works_for(uuid)'::regprocedure,
	$old$				'created_at', ask.created_at) order by ask.created_at, ask.id)$old$,
	$new$				'created_at', ask.created_at,
				-- 20260930702000: the reason the asker gave, and the offer the ask came in.
				'why', ask.why, 'batch', ask.batch) order by ask.created_at, ask.id)$new$);

drop function pg_temp.offers702_replace(regprocedure, text, text);
