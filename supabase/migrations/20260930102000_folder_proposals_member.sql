-- Company folder core, P40c (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8): a member's open proposals on the web.
-- A change an agent saved through a view that needs review waits as a proposal for the member whose run saved it (P40a,
-- P40b). The web shows the caller's own in the agent's thread, with a Discard button.
--
-- * qorpera_member_folder_agent_proposals(env, staffAgentId, request) (authenticated): the caller's open proposals of
--   one agent, as the run's list gives them: oldest first, at most 4 per page after `cursor`, each with its first 50
--   units. A proposal is listed (and counted) only while the member may read every path it names, as decided now. Each
--   structured file carries only the strings of its parse a card names it by (name, title, role, status).
-- * qorpera_member_folder_discard_proposal(env, proposalId) (authenticated): the core's member discard, as the caller's
--   own actor. The member it waits for, owners and admins discard it; a decided proposal answers as it stands. A
--   company being deleted refuses (55000); a paused one does not, since a discard writes nothing to the folder.
-- * The core's discard (service_role only; no grant to authenticated) now also takes a member's own actor, as the core
--   reads do since P27a (qorpera_folder_caller_allowed). One line is patched by exact text, with this slice's marker.
--
-- Later: an owner's or admin's list of the proposals that wait for a removed member or an archived agent.

set local lock_timeout = '3s';

create function pg_temp.p40c_replace(p_function regprocedure, p_old text, p_new text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '% does not have the text P40c expects: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end
$patch$;

-- 1. The core's discard takes a member's own actor ---------------------------------------------------------------------

select pg_temp.p40c_replace('public.qorpera_folder_member_discard_proposal(uuid,jsonb,uuid)',
	$old$	if auth.role() is distinct from 'service_role' then
$old$,
	$new$	-- 20260930102000 (P40c): service_role, or a member's own actor through qorpera_member_folder_discard_proposal.
	if not public.qorpera_folder_caller_allowed(p_actor) then
$new$);
drop function pg_temp.p40c_replace(regprocedure, text, text);

-- 2. The caller's open proposals of one agent -----------------------------------------------------------------------------

create function public.qorpera_member_folder_agent_proposals(p_environment_id uuid, p_staff_agent_id uuid,
	p_request jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id); v_auth jsonb; v_profile uuid;
	v_user uuid; v_after public.qorpera_folder_proposals%rowtype; v_rows public.qorpera_folder_proposals[]; v_more bigint;
	c_page constant integer := 4; c_units constant integer := 50;
begin
	-- P40c (20260930102000): a member of a folder-v2 company (42501 otherwise), not being deleted (55000).
	v_auth := public.qorpera_folder_read_actor(p_environment_id, v_actor);
	v_user := (v_actor ->> 'userId')::uuid;
	select file.profile_id into v_profile from public.qorpera_company_files as file
	where file.environment_id = p_environment_id and file.core = 'folder-v2';
	if p_staff_agent_id is null or jsonb_typeof(p_request) is distinct from 'object'
		or exists (select 1 from jsonb_object_keys(p_request) k where k <> 'cursor')
		or (p_request ? 'cursor' and coalesce(p_request ->> 'cursor', '')
			!~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
		raise exception 'Proposal request is invalid' using errcode = '22023'; end if;
	if p_request ? 'cursor' then
		select * into v_after from public.qorpera_folder_proposals q where q.id = (p_request ->> 'cursor')::uuid
			and q.environment_id = p_environment_id and q.staff_agent_id = p_staff_agent_id and q.member_user_id = v_user;
		if v_after.id is null then
			raise exception 'Proposal cursor is unavailable; list again without it' using errcode = 'P0002'; end if;
	end if;
	v_rows := array(select q from public.qorpera_folder_proposals q
		where q.environment_id = p_environment_id and q.staff_agent_id = p_staff_agent_id and q.member_user_id = v_user
			and q.status = 'open' and (v_after.id is null or (q.created_at, q.id) > (v_after.created_at, v_after.id))
			and public.qorpera_folder_proposal_readable(p_environment_id, v_profile, v_auth, q.id)
		order by q.created_at, q.id limit c_page + 1);
	v_more := greatest(cardinality(v_rows) - c_page, 0);
	if v_more > 0 then
		select count(*) into v_more from public.qorpera_folder_proposals q
		where q.environment_id = p_environment_id and q.staff_agent_id = p_staff_agent_id and q.member_user_id = v_user
			and q.status = 'open' and (q.created_at, q.id) > ((v_rows[c_page]).created_at, (v_rows[c_page]).id)
			and public.qorpera_folder_proposal_readable(p_environment_id, v_profile, v_auth, q.id);
	end if;
	return jsonb_build_object('schema', 'qorpera.member-folder-proposals/v1',
		'proposals', coalesce((select jsonb_agg(jsonb_build_object('proposalId', (v_rows[i]).id, 'createdAt', (v_rows[i]).created_at,
				'viewKind', (v_rows[i]).view_kind,
				'createsAgent', public.qorpera_folder_units_create_agent(p_environment_id, (v_rows[i]).units),
				'unitCount', jsonb_array_length((v_rows[i]).units),
				'units', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('unit', u.o, 'op', u.v ->> 'op',
						'path', coalesce(u.v ->> 'from', u.v ->> 'path'), 'to', u.v ->> 'to',
						'structured', (select jsonb_agg(jsonb_build_object('path', s.value ->> 'path', 'kind', s.value ->> 'kind',
								'parse', (select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
									from jsonb_each(s.value -> 'parse') f
									where f.key in ('name', 'title', 'role', 'status') and jsonb_typeof(f.value) = 'string'))
								order by s.ord)
							from jsonb_array_elements(case when jsonb_typeof(u.v -> 'structured') = 'array' then u.v -> 'structured'
								else '[]'::jsonb end) with ordinality s(value, ord)
							where jsonb_typeof(s.value -> 'parse') = 'object'))) order by u.o)
					from jsonb_array_elements((v_rows[i]).units) with ordinality u(v, o) where u.o <= c_units),
				'moreUnits', greatest(jsonb_array_length((v_rows[i]).units) - c_units, 0)) order by i)
			from generate_series(1, least(cardinality(v_rows), c_page)) i), '[]'::jsonb),
		'moreProposals', v_more,
		'nextCursor', case when v_more > 0 then to_jsonb((v_rows[c_page]).id) else 'null'::jsonb end);
end $$;

-- 3. The caller's discard -------------------------------------------------------------------------------------------------

create function public.qorpera_member_folder_discard_proposal(p_environment_id uuid, p_proposal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := public.qorpera_member_folder_actor(p_environment_id);
begin
	-- P40c (20260930102000): a member of a folder-v2 company (42501 otherwise), not being deleted (55000); then the
	-- core's discard decides as for any member.
	perform public.qorpera_folder_read_actor(p_environment_id, v_actor);
	return public.qorpera_folder_member_discard_proposal(p_environment_id, v_actor, p_proposal_id);
end $$;

revoke all on function public.qorpera_member_folder_agent_proposals(uuid, uuid, jsonb) from public, anon, service_role;
revoke all on function public.qorpera_member_folder_discard_proposal(uuid, uuid) from public, anon, service_role;
grant execute on function public.qorpera_member_folder_agent_proposals(uuid, uuid, jsonb) to authenticated;
grant execute on function public.qorpera_member_folder_discard_proposal(uuid, uuid) to authenticated;

-- 4. The deploy guard: the patched body carries the marker ---------------------------------------------------------------

do $guard$
begin
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_folder_member_discard_proposal(uuid,jsonb,uuid)'::regprocedure), '20260930102000') = 0 then
		raise exception 'P40c did not reach qorpera_folder_member_discard_proposal'; end if;
end $guard$;
