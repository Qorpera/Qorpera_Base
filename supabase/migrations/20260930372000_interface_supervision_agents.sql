-- Interfaces I9b: adding agents needs the supervisor's yes (deploy/first-node/RUNTIME-INTERFACES.md §5.1
-- "Supervision", §6.1 rule 9). Folder-v2 only.
--
-- 1. An offer of an agent: a row of qorpera_interface_offers with the agent and the consent it is offered under. It is
--    made by a member who is not the area's supervisor, to the member whose consent is live, and asks them to add the
--    agent to the area's `agents`. The file changes only when the supervisor adds it with their own save, which accepts
--    the offer (an agent in another area moves). It closes as any offer (declined by the supervisor, withdrawn by its
--    maker) and lapses when its consent ends.
-- 2. While an area has a live consent, a save by anyone but its member that adds an agent to the area's `agents` is
--    refused (rule 9): they offer the agent instead. Removing an agent stays free.
-- 3. Agent offers keep out of the claimed cells' offers: their own open index, apply's settle of a table's offers skips
--    them, and offering a cell matches only cell offers. The offer as members see it carries `agent` (null for a
--    cell). Every patched body carries the marker 20260930372000 for the deploy guard.
--
-- Locks: as I9b's, then the offers. The areas' index row first (a commit that writes the areas holds it FOR NO KEY
-- UPDATE; the offer call holds it FOR SHARE, as closing an offer does), then the consents in id order, then the offers.
-- The offer call holds the consent it offers under FOR SHARE, so a withdrawal or a leaving waits for it and lapses its
-- offer, or ends the consent first and the call is refused.

set local lock_timeout = '3s';

create function pg_temp.i9b_agents_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'I9b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The agent offers ------------------------------------------------------------------------------------------------

alter table public.qorpera_interface_offers
	-- The agent offered to an area's supervisor (its `column_name` is `agents` while open); null for a cell's offer.
	add column agent_id uuid,
	-- The consent the agent is offered under: its end lapses the offer.
	add column supervision_id uuid references public.qorpera_interface_supervisions(id) on delete cascade,
	add constraint qorpera_interface_offers_agent check ((agent_id is null) = (supervision_id is null)),
	add constraint qorpera_interface_offers_agent_cell check (agent_id is null
		or (was_user is null and (state <> 'open' or column_name = 'agents')));
-- One open offer of a cell to a member, among the cells' offers.
drop index public.qorpera_interface_offers_open;
create unique index qorpera_interface_offers_open on public.qorpera_interface_offers
	(environment_id, table_id, md5(row_key::text), column_name, to_user) where state = 'open' and agent_id is null;
-- One open offer of an agent to an area.
create unique index qorpera_interface_offers_agent_open on public.qorpera_interface_offers
	(environment_id, table_id, md5(row_key::text), agent_id) where state = 'open' and agent_id is not null;
-- A consent's offers, for its end and the cascade.
create index qorpera_interface_offers_supervision on public.qorpera_interface_offers (supervision_id)
	where supervision_id is not null;

-- A consent that ends lapses the open offers of agents made under it.
create function public.qorpera_interface_supervision_offers_lapse()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	-- 20260930372000 (I9b)
	update public.qorpera_interface_offers o set state = 'lapsed', closed_at = clock_timestamp(), row_key = null,
		column_name = null
	where o.supervision_id = new.id and o.state = 'open';
	return null;
end $$;
revoke all on function public.qorpera_interface_supervision_offers_lapse() from public, anon, authenticated, service_role;
create trigger qorpera_interface_supervision_offers_lapse
	after update of state on public.qorpera_interface_supervisions
	for each row when (old.state = 'live' and new.state <> 'live')
	execute function public.qorpera_interface_supervision_offers_lapse();

-- 2. The members' call -----------------------------------------------------------------------------------------------

-- A member offers a hired agent to the supervisor of an area: {key, agent}. `key` is the row's typed key as the client
-- parses it. Refused (ok false) when the areas or the row are gone (or unreadable to them), the agent is not one the
-- company has hired or is in the area already, nobody's consent on the area is live or it is the caller's (they add the
-- agent themselves), or the caller or the supervisor may not write the rows. Offering again what is already offered
-- answers the open offer.
create function public.qorpera_offer_interface_agent(p_environment_id uuid, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_writer jsonb := public.qorpera_member_folder_writer(p_environment_id);
	v_actor jsonb := v_writer -> 'actor'; v_profile uuid := (v_writer ->> 'profileId')::uuid;
	v_user uuid := (v_writer -> 'actor' ->> 'userId')::uuid;
	v_agent text; v_row public.qorpera_folder_table_index; v_definition jsonb; v_found jsonb;
	v_supervision public.qorpera_interface_supervisions; v_offer public.qorpera_interface_offers;
begin
	-- 20260930372000 (I9b)
	if jsonb_typeof(p_request) is distinct from 'object' or p_request - array['key','agent'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'key') is distinct from 'array' or jsonb_array_length(p_request -> 'key') = 0
		or octet_length((p_request -> 'key')::text) > 4096
		or jsonb_typeof(p_request -> 'agent') is distinct from 'string'
		or not public.qorpera_interface_agent_ids(array[p_request ->> 'agent']) then
		raise exception 'Offer request is invalid' using errcode = '22023'; end if;
	v_agent := p_request ->> 'agent';

	-- The areas' row, held against commits; the files are read after it, as the last commit left them.
	select * into v_row from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = 'tables/areas'
	for share;
	if v_row.id is not null
		and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_row.folder_path || '/rows.csv', 'read') then
		select a.value into v_found from jsonb_array_elements(public.qorpera_interface_area_rows(p_environment_id)) a
		where a.value -> 'key' = p_request -> 'key' limit 1;
	end if;
	if v_found is null then
		return public.qorpera_interface_offer_refused('gone', 'This area is gone.');
	end if;
	if not exists (select 1 from public.qorpera_profile_staff st
		where st.profile_id = v_profile and st.staff_agent_id = v_agent::uuid and st.employment_status = 'active') then
		return public.qorpera_interface_offer_refused('agent', 'Offer an agent the company has hired.');
	end if;
	if jsonb_typeof(v_found -> 'values' -> 'agents') = 'array' and (v_found -> 'values' -> 'agents') ? v_agent then
		return public.qorpera_interface_offer_refused('changed', 'The agent is in this area already.');
	end if;
	-- The area's live consent, held FOR SHARE: a withdrawal or a leaving waits for this call, and lapses its offer.
	select * into v_supervision from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_row.id and s.state = 'live'
		and md5(s.row_key::text) = md5((v_found -> 'key')::text) and s.row_key = v_found -> 'key'
	for share;
	if v_supervision.id is null then
		return public.qorpera_interface_offer_refused('supervisor', 'Nobody supervises this area: add the agent yourself.');
	end if;
	if v_supervision.user_id = v_user then
		return public.qorpera_interface_offer_refused('supervisor', 'You supervise this area: add the agent yourself.');
	end if;
	-- Both may write the rows: the table's [write] (rule 5) and the folder.
	v_definition := public.qorpera_interface_stored(p_environment_id, v_row.folder_key || '/table.toml');
	if exists (select 1 from (values (v_actor), (jsonb_build_object('kind', 'member', 'userId', v_supervision.user_id))) a(actor)
		where not (v_definition -> 'write' ->> 'members' = 'all'
				or (v_definition -> 'write' ->> 'members' = 'owners' and public.qorpera_interface_owner_actor(v_profile, a.actor)))
			or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, a.actor, v_row.folder_path || '/rows.csv',
				'write')) then
		return public.qorpera_interface_offer_refused('write', 'You or they may not change this table''s rows.');
	end if;

	-- An open offer answers the call, held FOR SHARE so a decline or a withdrawal waits for this call to end; one that
	-- closed between the insert and the lock left the agent free, so try again.
	loop
		insert into public.qorpera_interface_offers(environment_id, table_id, row_key, column_name, from_user, to_user,
			agent_id, supervision_id)
		values (p_environment_id, v_row.id, v_found -> 'key', 'agents', v_user, v_supervision.user_id, v_agent::uuid,
			v_supervision.id)
		on conflict (environment_id, table_id, md5(row_key::text), agent_id) where state = 'open' and agent_id is not null
		do nothing
		returning * into v_offer;
		if v_offer.id is not null then
			return jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', true, 'created', true,
				'offer', public.qorpera_interface_offer_json(v_offer, v_row.folder_path));
		end if;
		select * into v_offer from public.qorpera_interface_offers o
		where o.environment_id = p_environment_id and o.table_id = v_row.id and o.state = 'open'
			and md5(o.row_key::text) = md5((v_found -> 'key')::text) and o.agent_id = v_agent::uuid
		for share;
		if v_offer.id is not null then
			return jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', true, 'created', false,
				'offer', public.qorpera_interface_offer_json(v_offer, v_row.folder_path));
		end if;
	end loop;
end $$;
revoke all on function public.qorpera_offer_interface_agent(uuid, jsonb) from public, anon, service_role;
grant execute on function public.qorpera_offer_interface_agent(uuid, jsonb) to authenticated;

-- 3. Rule 9: only the supervisor adds an area's agents ---------------------------------------------------------------

select pg_temp.i9b_agents_replace(
	'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$	-- Rule 9: one area per agent.$old$,
	$new$	-- Rule 9: while an area's consent is live, only its member adds agents to the area; anyone else offers the agent
	-- to them (qorpera_offer_interface_agent). Removing one stays free (20260930372000, I9b).
	if v_folder = 'tables/areas' and v_row.id is not null and exists (
		with old_rows as materialized (select r -> 'key' as key, r -> 'values' -> 'agents' as agents
			from jsonb_array_elements(case when v_stored_rows is null then '[]'::jsonb
				else public.qorpera_interface_rows(v_definition, v_stored_rows) -> 'rows' end) r)
		select 1 from jsonb_array_elements(v_check -> 'rows') n
		join public.qorpera_interface_supervisions s on s.environment_id = p_environment_id and s.table_id = v_row.id
			and s.state = 'live' and md5(s.row_key::text) = md5((n -> 'key')::text) and s.row_key = n -> 'key'
		cross join lateral jsonb_array_elements_text(case when jsonb_typeof(n -> 'values' -> 'agents') = 'array'
			then n -> 'values' -> 'agents' else '[]'::jsonb end) a(id)
		where (p_actor ->> 'kind' is distinct from 'member' or s.user_id::text is distinct from p_actor ->> 'userId')
			and not exists (select 1 from old_rows o
				where o.key = n -> 'key' and jsonb_typeof(o.agents) = 'array' and o.agents ? a.id)) then
		return public.qorpera_interface_refused('areas', 'only the area''s supervisor adds its agents; offer the agent to them');
	end if;
	-- Rule 9: one area per agent.$new$);

-- 4. The cells' offers keep to cells; a consent's save accepts its agents' offers -------------------------------------

select pg_temp.i9b_agents_replace('public.qorpera_interface_offers_settle(uuid,text)'::regprocedure,
	$old$		where o2.environment_id = p_environment_id and o2.table_id = v_table and o2.state = 'open') s$old$,
	$new$		where o2.environment_id = p_environment_id and o2.table_id = v_table and o2.state = 'open'
			-- 20260930372000 (I9b): an agent's offer settles with its consent.
			and o2.agent_id is null) s$new$);

select pg_temp.i9b_agents_replace('public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure,
	$old$	on conflict (environment_id, table_id, md5(row_key::text), column_name, to_user) where state = 'open' do nothing$old$,
	$new$	-- 20260930372000 (I9b): among the cells' offers.
	on conflict (environment_id, table_id, md5(row_key::text), column_name, to_user) where state = 'open' and agent_id is null
	do nothing$new$);
select pg_temp.i9b_agents_replace('public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure,
	$old$		and md5(o.row_key::text) = md5((v_found -> 'key')::text) and o.column_name = v_column and o.to_user = v_to;$old$,
	$new$		and md5(o.row_key::text) = md5((v_found -> 'key')::text) and o.column_name = v_column and o.to_user = v_to
		and o.agent_id is null;$new$);

select pg_temp.i9b_agents_replace('public.qorpera_interface_offer_json(public.qorpera_interface_offers,text)'::regprocedure,
	$old$		'state', p_offer.state,$old$,
	$new$		'state', p_offer.state, 'agent', p_offer.agent_id /* 20260930372000 (I9b) */,$new$);

-- After a save of the areas, before the consents it ends: an agent offered under a consent that is still live is
-- accepted when the consent's member saves the rows and its row holds the agent. Only they add it there (rule 9); a
-- definition saved alone checks no rows, and a new key can name another row that holds the agent, so no other save
-- accepts.
select pg_temp.i9b_agents_replace(
	'public.qorpera_interface_supervision_settle(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure,
	$old$	perform 1 from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_table and s.state = 'live' order by s.id for update;$old$,
	$new$	perform 1 from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_table and s.state = 'live' order by s.id for update;
	-- 20260930372000 (I9b): the agents offered to a consent's member that its row holds after their save of the rows.
	update public.qorpera_interface_offers o set state = 'accepted', closed_at = clock_timestamp(), row_key = null,
		column_name = null
	from public.qorpera_interface_supervisions s
	where v_member and o.environment_id = p_environment_id and o.table_id = v_table and o.state = 'open'
		and o.agent_id is not null and s.id = o.supervision_id and s.state = 'live' and s.user_id = v_by
		and exists (select 1 from jsonb_array_elements(v_typed) t
			where t.value -> 'key' = s.row_key and jsonb_typeof(t.value -> 'values' -> 'agents') = 'array'
				and (t.value -> 'values' -> 'agents') ? o.agent_id::text);$new$);

-- The deploy guard: every patched body carries the marker.
do $guard$
declare v_cell text := (select prosrc from pg_proc where oid = 'public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure);
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure),
			'20260930372000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_interface_offers_settle(uuid,text)'::regprocedure),
			'20260930372000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_interface_offer_json(public.qorpera_interface_offers,text)'::regprocedure),
			'20260930372000') = 0
		or strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_interface_supervision_settle(uuid,uuid,uuid,text,uuid,boolean)'::regprocedure),
			'20260930372000') = 0
		or strpos(v_cell, '20260930372000') = 0 or strpos(v_cell, 'and o.agent_id is null;') = 0 then
		raise exception 'I9b did not reach the rules, the offers'' settle, json and cell call, and the consents'' settle'; end if;
end $guard$;
