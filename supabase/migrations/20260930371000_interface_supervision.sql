-- Interfaces I9b: supervision consent (deploy/first-node/RUNTIME-INTERFACES.md §5.1 "Supervision", §6.1 rule 8).
-- Folder-v2 only.
--
-- 1. qorpera_interface_supervisions: a member's consent to supervise the agents of one row of tables/areas. It is made
--    when the member's own save puts them in that row's `supervisor` (a take, or an offer they accept), and it ends
--    withdrawn (the member says so), released (the cell names someone else or no one), gone (the row went, or its key
--    changed) or left (the member left the company). A `supervisor` cell with no live consent decides nothing. The
--    areas table itself is seeded: never deleted or moved, so it never retires under a consent.
-- 2. An agent's self (rule 8) is the supervisor of the area whose `agents` holds it, while their consent is live and
--    they are a member: it takes or releases a claimed cell as them. An agent still never changes an area's owner,
--    supervisor or agents, and never accepts an offer.
-- 3. Members withdraw a consent, consent again to a cell that names them, and list the live consents, through three
--    calls. Everyone a consent's end concerns is told (member notification interface_supervision_ended): the owners and
--    admins, the area's owner and the supervisor, but not whoever ended it.
-- 4. An area's supervisor can now be offered as any claimed cell (I9c's refusal goes). Every patched body carries the
--    marker 20260930371000 for the deploy guard.
--
-- Locks: the areas table's index row first (a commit holds it FOR NO KEY UPDATE, the calls FOR SHARE), then the
-- member's row (FOR KEY SHARE, so a member leaving waits for the save that names them, or goes first), then the
-- consents, always in id order. A member's leaving ends their consents under their deleted row; an agent's commit holds
-- the consent it acts under FOR SHARE.

set local lock_timeout = '3s';

create function pg_temp.i9b_supervision_replace(p_function regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'I9b anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The consents ---------------------------------------------------------------------------------------------------

create table public.qorpera_interface_supervisions (
	id uuid primary key default extensions.gen_random_uuid(),
	environment_id uuid not null,
	-- The areas table's id (its index row).
	table_id uuid not null,
	-- The row's typed key (qorpera_interface_rows), while the consent is live.
	row_key jsonb,
	user_id uuid not null,
	state text not null default 'live' check (state in ('live','withdrawn','released','gone','left')),
	created_at timestamptz not null default clock_timestamp(),
	ended_at timestamptz,
	foreign key (environment_id, table_id) references public.qorpera_folder_table_index(environment_id, id) on delete cascade,
	check ((state = 'live') = (ended_at is null)),
	check ((state = 'live') = (row_key is not null))
);
-- One live consent per row.
create unique index qorpera_interface_supervisions_live on public.qorpera_interface_supervisions
	(environment_id, table_id, md5(row_key::text)) where state = 'live';
-- A member's live consents, for their leaving.
create index qorpera_interface_supervisions_user on public.qorpera_interface_supervisions (user_id, environment_id)
	where state = 'live';
-- Every consent of a table, ended ones too, for the cascade when its index row goes (erasure, a company's deletion).
create index qorpera_interface_supervisions_table on public.qorpera_interface_supervisions (environment_id, table_id);
alter table public.qorpera_interface_supervisions enable row level security;
revoke all on public.qorpera_interface_supervisions from public, anon, authenticated, service_role;
grant select on public.qorpera_interface_supervisions to service_role;
comment on table public.qorpera_interface_supervisions is
	'I9b: a member''s consent to supervise the agents of one row of tables/areas (RUNTIME-INTERFACES.md §5.1); the '
	'platform''s own records, never in the file.';

-- A consent as members see it.
create function public.qorpera_interface_supervision_json(p_supervision public.qorpera_interface_supervisions, p_folder text)
returns jsonb language sql stable set search_path = '' as $$
	select jsonb_build_object('id', p_supervision.id, 'table', p_supervision.table_id, 'folder', p_folder,
		'key', p_supervision.row_key, 'user', p_supervision.user_id, 'state', p_supervision.state,
		'at', public.qorpera_company_state_instant_text(p_supervision.created_at),
		'endedAt', public.qorpera_company_state_instant_text(p_supervision.ended_at))
$$;
revoke all on function public.qorpera_interface_supervision_json(public.qorpera_interface_supervisions, text)
	from public, anon, authenticated, service_role;

-- The typed rows of tables/areas as the folder holds them now ('[]' while it has none).
create function public.qorpera_interface_area_rows(p_environment_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_definition jsonb := public.qorpera_interface_stored(p_environment_id, 'tables/areas/table.toml');
	v_rows jsonb := public.qorpera_interface_stored(p_environment_id, 'tables/areas/rows.csv');
begin
	-- 20260930371000 (I9b)
	if v_definition is null or v_rows is null then return '[]'::jsonb; end if;
	return coalesce(public.qorpera_interface_rows(v_definition, v_rows) -> 'rows', '[]'::jsonb);
end $$;
revoke all on function public.qorpera_interface_area_rows(uuid) from public, anon, authenticated, service_role;

-- Tells everyone a consent's end concerns, once per consent: the company's owners and admins, the supervisor and the
-- member the area's `owner` names, each while a member who may read the areas, but never `p_by` (who ended it).
create function public.qorpera_interface_supervision_notify(p_environment_id uuid, p_profile_id uuid, p_supervision uuid,
	p_table uuid, p_key jsonb, p_user uuid, p_reason text, p_by uuid)
returns void language plpgsql set search_path = '' as $$
declare v_folder text; v_owner text;
begin
	-- 20260930371000 (I9b)
	if not exists (select 1 from public.qorpera_profiles p where p.id = p_profile_id) then return; end if;
	select i.folder_path into v_folder from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.id = p_table;
	select a.value -> 'values' ->> 'owner' into v_owner
	from jsonb_array_elements(public.qorpera_interface_area_rows(p_environment_id)) a
	where a.value -> 'key' = p_key limit 1;
	insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
	select p_profile_id, m.user_id, 'interface_supervision_ended', jsonb_build_object(
		'schema', 'qorpera.member-notification.interface-supervision-ended/v1', 'supervisionId', p_supervision,
		'tableId', p_table, 'key', case when octet_length(p_key::text) <= 1024 then p_key end, 'supervisorUserId', p_user,
		'reason', p_reason, 'byUserId', p_by, 'at', statement_timestamp()), p_supervision::text
	from public.qorpera_profile_members m
	where m.profile_id = p_profile_id and m.user_id is distinct from p_by
		and (m.role::text in ('owner','admin') or m.user_id = p_user or m.user_id::text = v_owner)
		and v_folder is not null
		and public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id,
			jsonb_build_object('kind', 'member', 'userId', m.user_id), v_folder || '/rows.csv', 'read')
	on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
end $$;
revoke all on function public.qorpera_interface_supervision_notify(uuid, uuid, uuid, uuid, jsonb, uuid, text, uuid)
	from public, anon, authenticated, service_role;

-- An areas table's consents against its files as they are now (apply, after its definition or its rows change): a
-- consent whose row is gone ends 'gone'; one whose row's supervisor no longer names its member ends 'released'. A save
-- of the rows by a member makes a consent for each row whose supervisor names them now and did not before (their own
-- save: a take, or an offer accepted). `p_version` is the path version the apply has just recorded: of table.toml
-- (`p_rows` false) or of rows.csv (true).
create function public.qorpera_interface_supervision_settle(p_environment_id uuid, p_profile_id uuid, p_commit_id uuid,
	p_folder_key text, p_version uuid, p_rows boolean)
returns void language plpgsql set search_path = '' as $$
declare v_table uuid; v_by uuid; v_member boolean := false; v_definition jsonb; v_typed jsonb; v_prior_definition jsonb;
	v_prior_rows jsonb; v_prior jsonb := '[]'::jsonb; v_ended jsonb; v_made bigint := 0; v_end jsonb;
begin
	-- 20260930371000 (I9b)
	if p_folder_key is distinct from 'tables/areas' then return; end if;
	-- A definition saved with the rows in one unit: the rows' settle, which follows it, reads both.
	if not p_rows and exists (select 1 from public.qorpera_folder_path_versions d
		join public.qorpera_folder_path_versions r on r.commit_id = d.commit_id and r.unit_no = d.unit_no
			and r.key_sha256 = extensions.digest(p_folder_key || '/rows.csv', 'sha256') and r.op in ('write','copy')
		where d.version = p_version) then return; end if;
	select i.id into v_table from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = p_folder_key;
	if v_table is null then return; end if;
	select case when c.actor_kind = 'member' then c.actor_id end into v_by from public.qorpera_folder_commits c
	where c.id = p_commit_id;
	-- The saver, held against leaving before the consents are (a member leaving holds their row, then their consents).
	if p_rows and v_by is not null then
		perform 1 from public.qorpera_profile_members m where m.profile_id = p_profile_id and m.user_id = v_by for key share;
		v_member := found;
	end if;
	v_definition := public.qorpera_interface_stored(p_environment_id, p_folder_key || '/table.toml');
	v_typed := public.qorpera_interface_area_rows(p_environment_id);

	perform 1 from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_table and s.state = 'live' order by s.id for update;
	with ended as (
		update public.qorpera_interface_supervisions s set state = x.state, ended_at = clock_timestamp(), row_key = null
		from (select s2.id, s2.row_key, case when r.typed is null then 'gone' else 'released' end as state
			from public.qorpera_interface_supervisions s2
			left join lateral (select t.value as typed from jsonb_array_elements(v_typed) t
				where t.value -> 'key' = s2.row_key limit 1) r on true
			where s2.environment_id = p_environment_id and s2.table_id = v_table and s2.state = 'live'
				and (r.typed is null or r.typed -> 'values' -> 'supervisor' is distinct from to_jsonb(s2.user_id::text))) x
		where s.id = x.id and s.state = 'live'
		returning s.id, x.row_key, s.user_id, s.state)
	select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'key', e.row_key, 'user', e.user_id, 'state', e.state)
		order by e.id), '[]'::jsonb)
	into v_ended from ended e;

	if v_member then
		-- The rows before this save, typed by the definition they were saved under (this unit's earlier one, if it saved one).
		select pv.structured -> 'parse' into v_prior_rows from public.qorpera_folder_path_versions r
		join public.qorpera_folder_path_versions pv on pv.version = r.prior_version
		where r.version = p_version;
		select pv.structured -> 'parse' into v_prior_definition from public.qorpera_folder_path_versions r
		join public.qorpera_folder_path_versions d on d.commit_id = r.commit_id and d.unit_no = r.unit_no
			and d.key_sha256 = extensions.digest(p_folder_key || '/table.toml', 'sha256') and d.op in ('write','copy')
		join public.qorpera_folder_path_versions pv on pv.version = d.prior_version
		where r.version = p_version;
		if v_prior_rows is not null and coalesce(v_prior_definition, v_definition) is not null then
			v_prior := coalesce(public.qorpera_interface_rows(coalesce(v_prior_definition, v_definition), v_prior_rows) -> 'rows',
				'[]'::jsonb);
		end if;
		insert into public.qorpera_interface_supervisions(environment_id, table_id, row_key, user_id)
		select p_environment_id, v_table, t.value -> 'key', v_by from jsonb_array_elements(v_typed) t
		where t.value -> 'values' -> 'supervisor' = to_jsonb(v_by::text)
			and not exists (select 1 from jsonb_array_elements(v_prior) p
				where p.value -> 'key' = t.value -> 'key' and p.value -> 'values' -> 'supervisor' = to_jsonb(v_by::text))
		on conflict (environment_id, table_id, md5(row_key::text)) where state = 'live' do nothing;
		get diagnostics v_made = row_count;
	end if;

	for v_end in select e.value from jsonb_array_elements(v_ended) e loop
		-- A row whose key the member changed in this save took their consent with it: nobody is told it went. (So is a
		-- row they deleted in a save that also made them a consent elsewhere; the rows alone cannot tell the two apart.)
		if v_end ->> 'state' = 'gone' and (v_end ->> 'user')::uuid = v_by and v_made > 0 then continue; end if;
		perform public.qorpera_interface_supervision_notify(p_environment_id, p_profile_id, (v_end ->> 'id')::uuid, v_table,
			v_end -> 'key', (v_end ->> 'user')::uuid, v_end ->> 'state', v_by);
	end loop;
end $$;
revoke all on function public.qorpera_interface_supervision_settle(uuid, uuid, uuid, text, uuid, boolean)
	from public, anon, authenticated, service_role;

-- 2. An agent's self -------------------------------------------------------------------------------------------------

-- The member who supervises an agent: the supervisor of the area whose `agents` holds it, while their consent is live
-- and they are a member; null otherwise. The consent is held FOR SHARE, so a withdrawal or a leaving waits for the
-- commit that acts under it, or ends it first.
create function public.qorpera_interface_agent_supervisor(p_environment_id uuid, p_profile_id uuid, p_staff_agent_id text)
returns uuid language plpgsql volatile set search_path = '' as $$
declare v_table uuid; v_area jsonb; v_user uuid;
begin
	-- 20260930371000 (I9b)
	if p_staff_agent_id is null then return null; end if;
	select i.id into v_table from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.retired_at is null and i.folder_key = 'tables/areas';
	if v_table is null then return null; end if;
	-- One area per agent (rule 9).
	select a.value into v_area from jsonb_array_elements(public.qorpera_interface_area_rows(p_environment_id)) a
	where jsonb_typeof(a.value -> 'values' -> 'agents') = 'array' and (a.value -> 'values' -> 'agents') ? p_staff_agent_id
	limit 1;
	if jsonb_typeof(v_area -> 'values' -> 'supervisor') is distinct from 'string' then return null; end if;
	select s.user_id into v_user from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_table and s.state = 'live'
		and md5(s.row_key::text) = md5((v_area -> 'key')::text) and s.row_key = v_area -> 'key'
		and s.user_id::text = v_area -> 'values' ->> 'supervisor'
		and exists (select 1 from public.qorpera_profile_members m where m.profile_id = p_profile_id and m.user_id = s.user_id)
	for share of s;
	return v_user;
end $$;
revoke all on function public.qorpera_interface_agent_supervisor(uuid, uuid, text) from public, anon, authenticated, service_role;

select pg_temp.i9b_supervision_replace(
	'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	$old$		-- Self: the member; an agent has none until supervision is built (I9b).
		v_self := case when p_actor ->> 'kind' = 'member' then to_jsonb(p_actor ->> 'userId') end;$old$,
	$new$		-- Self: the member; an agent's is its area's supervisor while their consent is live (20260930371000, I9b).
		v_self := case when p_actor ->> 'kind' = 'member' then to_jsonb(p_actor ->> 'userId')
			when v_agent and cardinality(v_columns) > 0 then to_jsonb(public.qorpera_interface_agent_supervisor(p_environment_id,
				p_profile_id, p_actor ->> 'staffAgentId')::text) end;$new$);

-- 3. The members' calls ---------------------------------------------------------------------------------------------

create function public.qorpera_interface_supervision_refused(p_reason text, p_message text)
returns jsonb language sql immutable set search_path = '' as $$
	select jsonb_build_object('schema', 'qorpera.interface-supervision/v1', 'ok', false, 'reason', p_reason,
		'message', p_message)
$$;
revoke all on function public.qorpera_interface_supervision_refused(text, text) from public, anon, authenticated, service_role;

-- A live consent ended by its member (withdrawn): the cell keeps naming them, and their area's agents act for no one
-- until they consent again. Not while it is live: changed false and the consent as it is. Members may do this while
-- the company is paused.
create function public.qorpera_withdraw_interface_supervision(p_environment_id uuid, p_supervision uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
	v_user uuid := (v_actor ->> 'userId')::uuid; v_profile uuid; v_supervision public.qorpera_interface_supervisions;
	v_folder text; v_key jsonb; v_changed boolean := false;
begin
	-- 20260930371000 (I9b)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select * into v_supervision from public.qorpera_interface_supervisions s
	where s.id = p_supervision and s.environment_id = p_environment_id;
	if v_supervision.id is null then raise exception 'Supervision is unknown' using errcode = '22023'; end if;
	if v_supervision.user_id <> v_user then
		raise exception 'This supervision is not yours to withdraw' using errcode = '42501'; end if;
	-- Held against commits, as a consent is made: a commit that ends it settles first.
	select i.folder_path into v_folder from public.qorpera_folder_table_index i
	where i.environment_id = p_environment_id and i.id = v_supervision.table_id for share;
	select * into v_supervision from public.qorpera_interface_supervisions s where s.id = p_supervision for update;
	if v_supervision.state = 'live' then
		v_key := v_supervision.row_key;
		update public.qorpera_interface_supervisions s set state = 'withdrawn', ended_at = clock_timestamp(), row_key = null
		where s.id = p_supervision
		returning * into v_supervision;
		v_changed := true;
		select file.profile_id into v_profile from public.qorpera_company_files as file
		where file.environment_id = p_environment_id and file.core = 'folder-v2';
		perform public.qorpera_interface_supervision_notify(p_environment_id, v_profile, v_supervision.id,
			v_supervision.table_id, v_key, v_user, 'withdrawn', v_user);
	end if;
	return jsonb_build_object('schema', 'qorpera.interface-supervision/v1', 'ok', true, 'changed', v_changed,
		'supervision', public.qorpera_interface_supervision_json(v_supervision, v_folder));
end $$;

-- A member consents again to supervise an area whose `supervisor` names them: {key}, the row's typed key as the client
-- parses it. Refused (ok false) when the areas or the row are gone (or unreadable to them), or the cell does not name
-- them. Consenting while a consent is live answers that one.
create function public.qorpera_consent_interface_supervision(p_environment_id uuid, p_request jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
	v_writer jsonb := public.qorpera_member_folder_writer(p_environment_id);
	v_actor jsonb := v_writer -> 'actor'; v_profile uuid := (v_writer ->> 'profileId')::uuid;
	v_user uuid := (v_writer -> 'actor' ->> 'userId')::uuid;
	v_row public.qorpera_folder_table_index; v_found jsonb; v_supervision public.qorpera_interface_supervisions;
begin
	-- 20260930371000 (I9b)
	if jsonb_typeof(p_request) is distinct from 'object' or p_request - 'key' <> '{}'::jsonb
		or jsonb_typeof(p_request -> 'key') is distinct from 'array' or jsonb_array_length(p_request -> 'key') = 0
		or octet_length((p_request -> 'key')::text) > 4096 then
		raise exception 'Supervision request is invalid' using errcode = '22023'; end if;

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
		return public.qorpera_interface_supervision_refused('gone', 'This area is gone.');
	end if;
	if v_found -> 'values' -> 'supervisor' is distinct from to_jsonb(v_user::text) then
		return public.qorpera_interface_supervision_refused('not_yours', 'Only the member it names as supervisor can consent.');
	end if;
	-- Held against leaving, as a save that names them is.
	perform 1 from public.qorpera_profile_members m where m.profile_id = v_profile and m.user_id = v_user for key share;
	if not found then raise exception 'Not a member of this company' using errcode = '42501'; end if;

	insert into public.qorpera_interface_supervisions(environment_id, table_id, row_key, user_id)
	values (p_environment_id, v_row.id, v_found -> 'key', v_user)
	on conflict (environment_id, table_id, md5(row_key::text)) where state = 'live' do nothing
	returning * into v_supervision;
	if v_supervision.id is not null then
		return jsonb_build_object('schema', 'qorpera.interface-supervision/v1', 'ok', true, 'created', true,
			'supervision', public.qorpera_interface_supervision_json(v_supervision, v_row.folder_path));
	end if;
	select * into v_supervision from public.qorpera_interface_supervisions s
	where s.environment_id = p_environment_id and s.table_id = v_row.id and s.state = 'live'
		and md5(s.row_key::text) = md5((v_found -> 'key')::text);
	return jsonb_build_object('schema', 'qorpera.interface-supervision/v1', 'ok', true, 'created', false,
		'supervision', public.qorpera_interface_supervision_json(v_supervision, v_row.folder_path));
end $$;

-- The live consents on live tables the member may read, of current members, newest first (at most 500).
create function public.qorpera_member_interface_supervisions(p_environment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
	v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_profile uuid; v_supervisions jsonb;
begin
	-- 20260930371000 (I9b)
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	select coalesce(jsonb_agg(public.qorpera_interface_supervision_json(x.supervision, x.folder_path)
		order by x.created_at desc, x.id), '[]'::jsonb)
	into v_supervisions
	from (select s as supervision, s.created_at, s.id, i.folder_path from public.qorpera_interface_supervisions s
		join public.qorpera_folder_table_index i on i.environment_id = s.environment_id and i.id = s.table_id
			and i.retired_at is null
		where s.environment_id = p_environment_id and s.state = 'live'
			and exists (select 1 from public.qorpera_profile_members m where m.profile_id = v_profile and m.user_id = s.user_id)
			and public.qorpera_folder_actor_allowed(p_environment_id, v_profile, v_actor, i.folder_path || '/rows.csv', 'read')
		order by s.created_at desc, s.id
		limit 501) x;
	return jsonb_build_object('schema', 'qorpera.member-interface-supervisions/v1',
		'supervisions', case when jsonb_array_length(v_supervisions) > 500 then v_supervisions - 500 else v_supervisions end,
		'truncated', jsonb_array_length(v_supervisions) > 500);
end $$;

revoke all on function public.qorpera_withdraw_interface_supervision(uuid, uuid) from public, anon, service_role;
revoke all on function public.qorpera_consent_interface_supervision(uuid, jsonb) from public, anon, service_role;
revoke all on function public.qorpera_member_interface_supervisions(uuid) from public, anon, service_role;
grant execute on function public.qorpera_withdraw_interface_supervision(uuid, uuid) to authenticated;
grant execute on function public.qorpera_consent_interface_supervision(uuid, jsonb) to authenticated;
grant execute on function public.qorpera_member_interface_supervisions(uuid) to authenticated;

-- 4. A member's leaving ----------------------------------------------------------------------------------------------

-- A member who leaves ends their live consents (left). Their cells are cleared later, by the platform.
create function public.qorpera_interface_supervision_left()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ended jsonb; v_end jsonb;
begin
	-- 20260930371000 (I9b)
	perform 1 from public.qorpera_interface_supervisions s
	where s.user_id = old.user_id and s.state = 'live' and s.environment_id in (select f.environment_id
		from public.qorpera_company_files f where f.profile_id = old.profile_id and f.core = 'folder-v2')
	order by s.id for update;
	with ended as (
		update public.qorpera_interface_supervisions s set state = 'left', ended_at = clock_timestamp(), row_key = null
		from (select s2.id, s2.row_key from public.qorpera_interface_supervisions s2
			where s2.user_id = old.user_id and s2.state = 'live' and s2.environment_id in (select f.environment_id
				from public.qorpera_company_files f where f.profile_id = old.profile_id and f.core = 'folder-v2')) x
		where s.id = x.id and s.state = 'live'
		returning s.id, s.environment_id, s.table_id, x.row_key)
	select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'environment', e.environment_id, 'table', e.table_id,
		'key', e.row_key) order by e.id), '[]'::jsonb)
	into v_ended from ended e;
	for v_end in select e.value from jsonb_array_elements(v_ended) e loop
		perform public.qorpera_interface_supervision_notify((v_end ->> 'environment')::uuid, old.profile_id,
			(v_end ->> 'id')::uuid, (v_end ->> 'table')::uuid, v_end -> 'key', old.user_id, 'left', null);
	end loop;
	return null;
end $$;
revoke all on function public.qorpera_interface_supervision_left() from public, anon, authenticated, service_role;
create trigger qorpera_interface_supervision_left
	after delete on public.qorpera_profile_members
	for each row execute function public.qorpera_interface_supervision_left();

-- 5. The notification ------------------------------------------------------------------------------------------------

-- The kinds as they are, and this one (so a kind another change added is kept).
do $kinds$
declare v_kinds text[];
begin
	select array(select distinct k from unnest(array(select m.parts[1]
			from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m(parts)
			where c.conrelid = 'public.qorpera_member_notifications'::regclass and c.conname = 'qorpera_member_notifications_kind')
		|| array['interface_supervision_ended']) k order by k)
	into v_kinds;
	if cardinality(v_kinds) < 7 then
		raise exception 'I9b could not read the notification kinds'; end if;
	execute format('alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind, '
		'add constraint qorpera_member_notifications_kind check (kind = any (%L::text[]))', v_kinds);
end $kinds$;

-- 6. Apply settles an area's consents; an area's supervisor can be offered ------------------------------------------

select pg_temp.i9b_supervision_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				-- 20260930105000 (I9c): the table's open offers against its new definition.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));$old$,
	$new$				-- 20260930105000 (I9c): the table's open offers against its new definition.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));
				-- 20260930371000 (I9b): an area's consents against its new definition.
				perform public.qorpera_interface_supervision_settle(p_environment_id, v_profile, p_commit_id,
					public.qorpera_interface_table_folder(v_file.key), v_version, false);$new$);
select pg_temp.i9b_supervision_replace('public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure,
	$old$				-- 20260930105000 (I9c): the table's open offers against its new rows.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));$old$,
	$new$				-- 20260930105000 (I9c): the table's open offers against its new rows.
				perform public.qorpera_interface_offers_settle(p_environment_id, public.qorpera_interface_table_folder(v_file.key));
				-- 20260930371000 (I9b): an area's consents against its new rows, and those its member's save makes.
				perform public.qorpera_interface_supervision_settle(p_environment_id, v_profile, p_commit_id,
					public.qorpera_interface_table_folder(v_file.key), v_version, true);$new$);

select pg_temp.i9b_supervision_replace('public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure,
	$old$	if not exists (select 1 from jsonb_array_elements(v_definition -> 'columns') c
			where c ->> 'name' = v_column and c ->> 'type' = 'member' and c -> 'needsYes' = 'true'::jsonb)
		or (v_row.folder_key = 'tables/areas' and v_column = 'supervisor') then$old$,
	$new$	-- 20260930371000 (I9b): an area's supervisor too; accepting it is the taker's consent.
	if not exists (select 1 from jsonb_array_elements(v_definition -> 'columns') c
			where c ->> 'name' = v_column and c ->> 'type' = 'member' and c -> 'needsYes' = 'true'::jsonb) then$new$);

-- The deploy guard: every patched body carries the marker.
do $guard$
declare v_apply text := (select prosrc from pg_proc
	where oid = 'public.qorpera_folder_structured_apply(uuid,uuid,integer,jsonb,text,text)'::regprocedure);
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure),
			'20260930371000') = 0
		or strpos((select prosrc from pg_proc where oid = 'public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure),
			'20260930371000') = 0
		or (length(v_apply) - length(replace(v_apply, '20260930371000', ''))) / length('20260930371000') <> 2 then
		raise exception 'I9b did not reach the rules, apply and offers'; end if;
end $guard$;
