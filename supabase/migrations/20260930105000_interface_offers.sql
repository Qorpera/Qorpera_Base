-- Interfaces I9c: offers of a claimed cell (deploy/first-node/RUNTIME-INTERFACES.md §5 "The claim rule", §6.1 rule 8).
-- Folder-v2 only.
--
-- 1. qorpera_interface_offers: the offers the platform keeps. An offer names a table (by its id, so it follows a moved
--    folder), a row key, a needs_yes member column, who offered it (`from`), the cell as it was (`was`) and the member
--    it is offered to (`to`). It changes nothing in the file. An open offer holds its key and column; a closed one
--    keeps only who and when.
-- 2. Members offer, decline and withdraw through three calls, each under the table's index row FOR SHARE, so they wait
--    for a commit that holds it (rank 5, FOR NO KEY UPDATE) and read the files as that commit left them. A fourth
--    lists the open offers; it reads no files, so it takes no lock.
-- 3. Rule 8's accept: a member putting self where an open offer names that row key, that column and self; the offer's
--    `was` equals the cell as stored; and, unless `was` is empty, the offer's `from` equals `was`.
-- 4. Apply settles a table's open offers after its definition or rows change: a cell that now names `to` accepts the
--    offer; a cell still as it was keeps it open; anything else (another value, the row or the claim gone) lapses it. A
--    table folder deleted lapses them all. Every patched body carries the marker 20260930105000 for the deploy guard.

set local lock_timeout = '3s';

create function pg_temp.i9c_offers_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'I9c anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The offers -----------------------------------------------------------------------------------------------------

create table public.qorpera_interface_offers (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null,
	-- The table's id (its index row), so an offer follows its folder through a move.
	table_id uuid not null,
	-- The row's typed key (qorpera_interface_rows) and the column, while the offer is open.
	row_key jsonb,
	column_name text,
	from_user uuid not null,
	-- The cell when it was offered: empty, or the member who offered it.
	was_user uuid,
	to_user uuid not null,
	state text not null default 'open' check (state in ('open','accepted','declined','withdrawn','lapsed')),
	created_at timestamptz not null default clock_timestamp(),
	closed_at timestamptz,
	foreign key (environment_id, table_id) references public.qorpera_folder_table_index(environment_id, id) on delete cascade,
	check ((state = 'open') = (closed_at is null)),
	check ((state = 'open') = (row_key is not null and column_name is not null)),
	check (to_user <> from_user),
	check (was_user is null or was_user = from_user)
);
-- One open offer of a cell to a member.
create unique index qorpera_interface_offers_open on public.qorpera_interface_offers
	(environment_id, table_id, md5(row_key::text), column_name, to_user) where state = 'open';
-- Every offer of a table, closed ones too, for the cascade when its index row goes (erasure, a company's deletion).
create index qorpera_interface_offers_table on public.qorpera_interface_offers (environment_id, table_id);
alter table public.qorpera_interface_offers enable row level security;
revoke all on public.qorpera_interface_offers from public, anon, authenticated, service_role;
grant select on public.qorpera_interface_offers to service_role;
comment on table public.qorpera_interface_offers is
	'I9c: offers of a needs_yes member cell of a table (RUNTIME-INTERFACES.md §5); the platform''s own records, never in '
	'the file.';

-- An offer as members see it.
create function public.qorpera_interface_offer_json(p_offer public.qorpera_interface_offers, p_folder text)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('id', p_offer.id, 'table', p_offer.table_id, 'folder', p_folder, 'key', p_offer.row_key,
		'column', p_offer.column_name, 'from', p_offer.from_user, 'was', p_offer.was_user, 'to', p_offer.to_user,
		'state', p_offer.state, 'at', public.qorpera_company_state_instant_text(p_offer.created_at),
		'closedAt', public.qorpera_company_state_instant_text(p_offer.closed_at))
$$;
revoke all on function public.qorpera_interface_offer_json(public.qorpera_interface_offers, text)
	from public, anon, authenticated, service_role;

-- A table's open offers against its files as they are now (apply, after a definition or rows change): the cell names
-- `to`, accepted; the cell as it was, still open; anything else, or the row or the claim gone, lapsed.
create function public.qorpera_interface_offers_settle(p_environment_id uuid, p_folder_key text)
returns void language plpgsql set search_path = '' as $$
declare v_table uuid; v_definition jsonb; v_rows jsonb; v_typed jsonb := '[]'::jsonb;
begin
	-- 20260930105000 (I9c)
	select i.id into v_table from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = p_folder_key;
	if v_table is null or not exists (select 1 from public.qorpera_interface_offers o
		where o.environment_id = p_environment_id and o.table_id = v_table and o.state = 'open') then return; end if;
	v_definition := public.qorpera_interface_stored(p_environment_id, p_folder_key || '/table.toml');
	v_rows := public.qorpera_interface_stored(p_environment_id, p_folder_key || '/rows.csv');
	if v_definition is not null and v_rows is not null then
		v_typed := public.qorpera_interface_rows(v_definition, v_rows) -> 'rows';
	end if;
	update public.qorpera_interface_offers o set state = s.state, closed_at = clock_timestamp(), row_key = null,
		column_name = null
	from (select o2.id, case
			when x.typed is null or not exists (select 1 from jsonb_array_elements(coalesce(v_definition -> 'columns', '[]'::jsonb)) c
				where c ->> 'name' = o2.column_name and c ->> 'type' = 'member' and c -> 'needsYes' = 'true'::jsonb) then 'lapsed'
			when x.typed -> 'values' -> o2.column_name = to_jsonb(o2.to_user::text) then 'accepted'
			when coalesce(x.typed -> 'values' -> o2.column_name, 'null'::jsonb)
				= coalesce(to_jsonb(o2.was_user::text), 'null'::jsonb) then null
			else 'lapsed' end as state
		from public.qorpera_interface_offers o2
		left join lateral (select r.value as typed from jsonb_array_elements(v_typed) r
			where r.value -> 'key' = o2.row_key limit 1) x on true
		where o2.environment_id = p_environment_id and o2.table_id = v_table and o2.state = 'open') s
	where o.id = s.id and s.state is not null;
end $$;
revoke all on function public.qorpera_interface_offers_settle(uuid, text) from public, anon, authenticated, service_role;

-- 2. The members' calls ---------------------------------------------------------------------------------------------

create function public.qorpera_interface_offer_refused(p_reason text, p_message text)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', false, 'reason', p_reason, 'message', p_message)
$$;
revoke all on function public.qorpera_interface_offer_refused(text, text) from public, anon, authenticated, service_role;

-- A member offers a cell to another member: {table, key, column, was, to}. `key` is the row's typed key as the client
-- parses it, `was` the cell as the caller read it (null when empty). Refused (ok false) when the table or row is gone,
-- the column is not a needs_yes member column (or is an area's supervisor, which waits for consent records), the cell
-- changed, the cell names someone else, `to` is the caller or no member, or either of them may not write the rows.
-- Offering again what is already offered answers the open offer.
create function public.qorpera_offer_interface_cell(p_environment_id uuid, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
	v_writer jsonb := public.qorpera_member_folder_writer(p_environment_id);
	v_actor jsonb := v_writer -> 'actor'; v_profile uuid := (v_writer ->> 'profileId')::uuid;
	v_user uuid := (v_writer -> 'actor' ->> 'userId')::uuid;
	v_to uuid; v_was uuid; v_column text; v_to_actor jsonb;
	v_row public.qorpera_folder_table_index; v_definition jsonb; v_rows jsonb; v_found jsonb;
	v_offer public.qorpera_interface_offers;
begin
	-- 20260930105000 (I9c)
	if jsonb_typeof(p_request) is distinct from 'object' or p_request - array['table','key','column','was','to'] <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'table') is distinct from 'string' or p_request ->> 'table' !~ c_uuid
		or jsonb_typeof(p_request -> 'key') is distinct from 'array' or jsonb_array_length(p_request -> 'key') = 0
		or octet_length((p_request -> 'key')::text) > 4096
		or jsonb_typeof(p_request -> 'column') is distinct from 'string' or char_length(p_request ->> 'column') not between 1 and 200
		or jsonb_typeof(p_request -> 'was') is null
		or (jsonb_typeof(p_request -> 'was') <> 'null'
			and (jsonb_typeof(p_request -> 'was') <> 'string' or p_request ->> 'was' !~ c_uuid))
		or jsonb_typeof(p_request -> 'to') is distinct from 'string' or p_request ->> 'to' !~ c_uuid then
		raise exception 'Offer request is invalid' using errcode = '22023'; end if;
	v_to := (p_request ->> 'to')::uuid; v_was := (p_request ->> 'was')::uuid; v_column := p_request ->> 'column';
	v_to_actor := jsonb_build_object('kind', 'member', 'userId', v_to);

	-- The table's row, held against commits; the files are read after it, as the last commit left them.
	select * into v_row from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.id = (p_request ->> 'table')::uuid and i.retired_at is null
	for share;
	v_definition := public.qorpera_interface_stored(p_environment_id, v_row.folder_key || '/table.toml');
	v_rows := public.qorpera_interface_stored(p_environment_id, v_row.folder_key || '/rows.csv');
	if v_row.id is null or v_definition is null
		or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, v_row.folder_path || '/rows.csv', 'read') then
		return public.qorpera_interface_offer_refused('gone', 'This table is gone.');
	end if;
	if not exists (select 1 from jsonb_array_elements(v_definition -> 'columns') c
			where c ->> 'name' = v_column and c ->> 'type' = 'member' and c -> 'needsYes' = 'true'::jsonb)
		or (v_row.folder_key = 'tables/areas' and v_column = 'supervisor') then
		return public.qorpera_interface_offer_refused('column', 'Only a member column that needs a yes can be offered.');
	end if;
	select r.value into v_found from jsonb_array_elements(case when v_rows is null then '[]'::jsonb
			else public.qorpera_interface_rows(v_definition, v_rows) -> 'rows' end) r
	where r.value -> 'key' = p_request -> 'key' limit 1;
	if v_found is null then
		return public.qorpera_interface_offer_refused('gone', 'This row is gone.');
	end if;
	if coalesce(v_found -> 'values' -> v_column, 'null'::jsonb) is distinct from coalesce(to_jsonb(v_was::text), 'null'::jsonb) then
		return public.qorpera_interface_offer_refused('changed', 'That changed while you were looking.');
	end if;
	if v_was is not null and v_was <> v_user then
		return public.qorpera_interface_offer_refused('not_yours', 'Only the member it names can offer it.');
	end if;
	if v_to = v_user or not exists (select 1 from public.qorpera_profile_members m
		where m.profile_id = v_profile and m.user_id = v_to) then
		return public.qorpera_interface_offer_refused('member', 'Offer it to another member of the company.');
	end if;
	-- Both may write the rows: the table's [write] (rule 5) and the folder.
	if exists (select 1 from (values (v_actor), (v_to_actor)) a(actor)
		where not (v_definition -> 'write' ->> 'members' = 'all'
				or (v_definition -> 'write' ->> 'members' = 'owners' and public.qorpera_interface_owner_actor(v_profile, a.actor)))
			or not public.qorpera_folder_actor_allowed(p_environment_id, v_profile, a.actor, v_row.folder_path || '/rows.csv',
				'write')) then
		return public.qorpera_interface_offer_refused('write', 'You or they may not change this table''s rows.');
	end if;

	insert into public.qorpera_interface_offers(environment_id, table_id, row_key, column_name, from_user, was_user, to_user)
	values (p_environment_id, v_row.id, v_found -> 'key', v_column, v_user, v_was, v_to)
	on conflict (environment_id, table_id, md5(row_key::text), column_name, to_user) where state = 'open' do nothing
	returning * into v_offer;
	if v_offer.id is not null then
		return jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', true, 'created', true,
			'offer', public.qorpera_interface_offer_json(v_offer, v_row.folder_path));
	end if;
	select * into v_offer from public.qorpera_interface_offers o
	where o.environment_id = p_environment_id and o.table_id = v_row.id and o.state = 'open'
		and md5(o.row_key::text) = md5((v_found -> 'key')::text) and o.column_name = v_column and o.to_user = v_to;
	return jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', true, 'created', false,
		'offer', public.qorpera_interface_offer_json(v_offer, v_row.folder_path));
end $$;

-- An open offer closed by the member it names (declined) or by the member who made it (withdrawn). Not while it is
-- open: changed false and the offer as it is. Members may do this while the company is paused.
create function public.qorpera_close_interface_offer(p_environment_id uuid, p_offer uuid, p_state text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
	v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
	v_user uuid := (v_actor ->> 'userId')::uuid; v_offer public.qorpera_interface_offers; v_folder text; v_changed boolean;
begin
	-- 20260930105000 (I9c)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select * into v_offer from public.qorpera_interface_offers o where o.id = p_offer and o.environment_id = p_environment_id;
	if v_offer.id is null then raise exception 'Offer is unknown' using errcode = '22023'; end if;
	if (case p_state when 'declined' then v_offer.to_user when 'withdrawn' then v_offer.from_user end) is distinct from v_user then
		raise exception 'This offer is not yours to close' using errcode = '42501'; end if;
	-- Held against commits, as an offer is made: a commit that accepts it settles first.
	select i.folder_path into v_folder from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.id = v_offer.table_id for share;
	update public.qorpera_interface_offers o set state = p_state, closed_at = clock_timestamp(), row_key = null, column_name = null
	where o.id = p_offer and o.state = 'open'
	returning * into v_offer;
	v_changed := found;
	if not v_changed then
		select * into v_offer from public.qorpera_interface_offers o where o.id = p_offer;
	end if;
	return jsonb_build_object('schema', 'qorpera.interface-offer/v1', 'ok', true, 'changed', v_changed,
		'offer', public.qorpera_interface_offer_json(v_offer, v_folder));
end $$;
revoke all on function public.qorpera_close_interface_offer(uuid, uuid, text) from public, anon, authenticated, service_role;

create function public.qorpera_decline_interface_offer(p_environment_id uuid, p_offer uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
	select public.qorpera_close_interface_offer(p_environment_id, p_offer, 'declined') -- 20260930105000 (I9c)
$$;
create function public.qorpera_withdraw_interface_offer(p_environment_id uuid, p_offer uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
	select public.qorpera_close_interface_offer(p_environment_id, p_offer, 'withdrawn') -- 20260930105000 (I9c)
$$;

-- The open offers on live tables the member may read, between current members, newest first (at most 500).
create function public.qorpera_member_interface_offers(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid; v_offers jsonb;
begin
	-- 20260930105000 (I9c)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	select coalesce(jsonb_agg(public.qorpera_interface_offer_json(x.offer, x.folder_path) order by x.created_at desc, x.id), '[]'::jsonb)
	into v_offers
	from (select o as offer, o.created_at, o.id, i.folder_path from public.qorpera_interface_offers o
		join public.qorpera_folder_table_index i on i.environment_id = o.environment_id and i.id = o.table_id
			and i.retired_at is null
		where o.environment_id = p_environment_id and o.state = 'open'
			and exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile and m.user_id = o.from_user)
			and exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile and m.user_id = o.to_user)
			and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, i.folder_path || '/rows.csv', 'read')
		order by o.created_at desc, o.id
		limit 501) x;
	return jsonb_build_object('schema', 'qorpera.member-interface-offers/v1',
		'offers', case when jsonb_array_length(v_offers) > 500 then v_offers - 500 else v_offers end,
		'truncated', jsonb_array_length(v_offers) > 500);
end $$;

revoke all on function public.qorpera_offer_interface_cell(uuid, jsonb) from public, anon, service_role;
revoke all on function public.qorpera_decline_interface_offer(uuid, uuid) from public, anon, service_role;
revoke all on function public.qorpera_withdraw_interface_offer(uuid, uuid) from public, anon, service_role;
revoke all on function public.qorpera_member_interface_offers(uuid) from public, anon, service_role;
grant execute on function public.qorpera_offer_interface_cell(uuid, jsonb) to authenticated;
grant execute on function public.qorpera_decline_interface_offer(uuid, uuid) to authenticated;
grant execute on function public.qorpera_withdraw_interface_offer(uuid, uuid) to authenticated;
grant execute on function public.qorpera_member_interface_offers(uuid) to authenticated;

-- 3. Rule 8's accept --------------------------------------------------------------------------------------------------

select pg_temp.i9c_offers_replace(
	'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			select c.name, coalesce(o.vals -> c.name, 'null'::jsonb) as was, coalesce(n.vals -> c.name, 'null'::jsonb) as now$old$,
	$new$			select c.name, coalesce(o.vals -> c.name, 'null'::jsonb) as was, coalesce(n.vals -> c.name, 'null'::jsonb) as now,
				coalesce(n.key, o.key) as key /* 20260930105000 (I9c) */$new$);
select pg_temp.i9c_offers_replace(
	'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$			elsif not ((v_cell.was = 'null'::jsonb and v_cell.now = v_self) or (v_cell.was = v_self and v_cell.now = 'null'::jsonb)) then$old$,
	$new$			elsif not ((v_cell.was = 'null'::jsonb and v_cell.now = v_self) or (v_cell.was = v_self and v_cell.now = 'null'::jsonb)
				-- 20260930105000 (I9c): accept, a member putting self where an open offer names that row key, that column
				-- and self, the offer's `was` is the cell as stored, and its `from` is `was` unless `was` is empty.
				or (p_actor ->> 'kind' = 'member' and v_cell.now = v_self and v_row.id is not null
					and exists (select 1 from public.qorpera_interface_offers o
						where o.environment_id = p_environment_id and o.table_id = v_row.id and o.state = 'open'
							and o.row_key = v_cell.key and o.column_name = v_cell.name and o.to_user = (p_actor ->> 'userId')::uuid
							and coalesce(to_jsonb(o.was_user::text), 'null'::jsonb) = v_cell.was
							and (o.was_user is null or o.from_user = o.was_user)))) then$new$);

-- 4. Apply settles a table's offers ----------------------------------------------------------------------------------

select pg_temp.i9c_offers_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				perform public.qorpera_company_state_index_table(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');$old$,
	$new$				perform public.qorpera_company_state_index_table(p_environment_id, v_profile, p_commit_id, v_file.path, v_version,
					v_entry -> 'parse');
				-- 20260930105000 (I9c): the table's open offers against its new definition.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));$new$);
select pg_temp.i9c_offers_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				if not found then raise exception 'A table''s rows have no table row' using errcode = 'XX000'; end if;$old$,
	$new$				if not found then raise exception 'A table''s rows have no table row' using errcode = 'XX000'; end if;
				-- 20260930105000 (I9c): the table's open offers against its new rows.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));$new$);
select pg_temp.i9c_offers_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$		-- 20260930016000 (P16): a table's folder removed: its row retires.$old$,
	$new$		-- 20260930105000 (I9c): a table's folder removed: its open offers lapse.
		update public.qorpera_interface_offers o set state = 'lapsed', closed_at = clock_timestamp(), row_key = null,
			column_name = null
		from public.qorpera_folder_table_index i
		where i.environment_id = p_environment_id and i.retired_at is null
			and (i.folder_key = v_key or i.folder_key like public.qorpera_folder_under(v_key))
			and o.environment_id = p_environment_id and o.table_id = i.id and o.state = 'open';
		-- 20260930016000 (P16): a table's folder removed: its row retires.$new$);

-- The deploy guard: every patched body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure),
			'20260930105000') = 0
		or (length((select prosrc from pg_proc
				where oid = 'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure))
			- length(replace((select prosrc from pg_proc
				where oid = 'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure),
				'20260930105000', ''))) / length('20260930105000') <> 3 then
		raise exception 'I9c did not reach the rules and apply'; end if;
end $guard$;
