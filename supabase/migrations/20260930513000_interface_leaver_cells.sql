-- 20260930513000: C6d, Members and a member's leaving (QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md §2). A member
-- who leaves keeps every cell that names them: nothing is cleared (their consents end 'left', 20260930371000). Such a
-- cell counts as empty for the members who stay:
-- * Rule 8 (the claim rule): a member takes a cell that names someone who is no longer a member of the company, and
--   accepts an open offer of one, as they would an empty cell. Not an agent: its self is its area's supervisor
--   (20260930371000), and an agent never changes an area's owner, supervisor or agents, so a leaver's cells are the
--   members' to take. Release stays the holder's own, so a member who wants it empty takes it and releases it.
-- * qorpera_offer_interface_cell: any member offers such a cell, as they would an empty one.
-- A cell naming a current member is theirs as before. Whether a cell's member left is read for each changed cell,
-- under the commit's own locks: a member who rejoins holds their cells again. The offers table drops its check that an offer's `was` is the member who
-- makes it (a leaver's cell is offered by another member); consents and the leave trigger are unchanged. The same rule
-- holds in the web's local check (tableClaimProblems with `members`); an agent's table_write keeps today's rule.
-- Every patched body names this migration (20260930513000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.c6d_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_i integer; v_count integer;
begin
	for v_i in 1 .. coalesce(array_length(p_edits, 1), 0) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, p_edits[2 * v_i - 1], ''))) / nullif(length(p_edits[2 * v_i - 1]), 0);
		if v_count is distinct from 1 then
			raise exception 'C6d anchor found % time(s) in %: %', coalesce(v_count, 0), p_target, left(p_edits[2 * v_i - 1], 120); end if;
		v_definition := replace(v_definition, p_edits[2 * v_i - 1], p_edits[2 * v_i]);
	end loop;
	execute v_definition;
end $$;

-- Whether a member cell's value names someone who is not a member of the company (anymore): false for an empty cell
-- or anything but an id.
create function public.qorpera_interface_cell_left(p_profile_id uuid, p_cell jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
begin
	if jsonb_typeof(p_cell) is distinct from 'string'
		or p_cell #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
		return false;
	end if;
	return not exists (select 1 from public.qorpera_profile_members m
		where m.profile_id = p_profile_id and m.user_id = (p_cell #>> '{}')::uuid);
end $$;
revoke all on function public.qorpera_interface_cell_left(uuid, jsonb) from public, anon, authenticated, service_role;

select pg_temp.c6d_patch('public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure,
	array[$old$			elsif not ((v_cell.was = 'null'::jsonb and v_cell.now = v_self) or (v_cell.was = v_self and v_cell.now = 'null'::jsonb)
$old$,
	$new$			elsif not ((v_cell.was = 'null'::jsonb and v_cell.now = v_self) or (v_cell.was = v_self and v_cell.now = 'null'::jsonb)
				-- 20260930513000 (C6d): a member takes a cell that names someone who left: it counts as empty. Not an
				-- agent, whose self is its area's supervisor: the leaver's cells are the members' to take.
				or (not v_agent and v_cell.now = v_self and public.qorpera_interface_cell_left(p_profile_id, v_cell.was))
$new$,
	$old$							and (o.was_user is null or o.from_user = o.was_user)))) then$old$,
	$new$							and (o.was_user is null or o.from_user = o.was_user
								-- 20260930513000 (C6d): or `was` names someone who left, so the cell counts as empty.
								or public.qorpera_interface_cell_left(p_profile_id, v_cell.was))))) then$new$]);

select pg_temp.c6d_patch('public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure,
	array[$old$	if v_was is not null and v_was <> v_user then$old$,
	$new$	-- 20260930513000 (C6d): a cell that names someone who left counts as empty: any member offers it.
	if v_was is not null and v_was <> v_user and not public.qorpera_interface_cell_left(v_profile, to_jsonb(v_was::text)) then$new$]);

-- An offer's `was` may now name someone who left, not only the member who makes it: the offers table's check that held
-- the two equal (20260928509110) goes. The offer call and rule 8's accept keep that rule for a current member's cell.
do $offers$
declare v_names text[] := array(select c.conname from pg_constraint c
	where c.conrelid = 'public.qorpera_interface_offers'::regclass and c.contype = 'c'
		and pg_get_constraintdef(c.oid) like '%was_user = from_user%');
begin
	if cardinality(v_names) <> 1 then raise exception 'C6d expected one offers check of was_user = from_user, found %', v_names; end if;
	execute format('alter table public.qorpera_interface_offers drop constraint %I', v_names[1]);
end $offers$;

-- The deploy guard: both patched bodies carry the marker, and the earlier ones stay.
do $guard$
declare
	v_rules text := (select prosrc from pg_proc
		where oid = 'public.qorpera_company_state_interface_rules(uuid,uuid,jsonb,uuid,text,jsonb,jsonb)'::regprocedure);
	v_offer text := (select prosrc from pg_proc where oid = 'public.qorpera_offer_interface_cell(uuid,jsonb)'::regprocedure);
begin
	if (length(v_rules) - length(replace(v_rules, '20260930513000', ''))) / length('20260930513000') <> 2
		or strpos(v_rules, '20260930105000') = 0 or strpos(v_rules, '20260930371000') = 0
		or strpos(v_rules, '20260930372000') = 0
		or strpos(v_offer, '20260930513000') = 0 or strpos(v_offer, '20260930105000') = 0
		or strpos(v_offer, '20260930372000') = 0 then
		raise exception 'C6d did not reach the claim rule and the offer'; end if;
end $guard$;
