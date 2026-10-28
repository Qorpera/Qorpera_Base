-- @fixture 708_folder_state_routines.test.sql until "-- 1. The company and two agents"
-- Company state files (migration 20260930056000; C1C §6.9, from Q1's review of #775): a routine file saved past its end
-- does not revive its routine. The file of an ended routine still says `status: active`; a save ends a routine whose
-- `ends` has passed at once, keeps an ended one ended unless its end is later than now (or removed) and runs remain, and
-- is no restart while it leaves the routine ended, so a member whose login does not pay can still save it.

-- A save the rules refuse for want of the saver's paying login.
create function pg_temp.needs_login(p_result jsonb) returns void language plpgsql as $$
begin
	if not pg_temp.refused(p_result) or position('AI login' in coalesce(p_result -> 'units' -> 0 -> 'problems' -> 0 ->> 'message', '')) = 0 then
		raise exception 'Expected a refusal for the saver''s login, got %', p_result; end if;
end $$;

do $$
declare r jsonb; i integer;
begin
	r := pg_temp.commit('{"kind":"platform"}', 'seed-0001', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','QorperaOS'),
		jsonb_build_object('op','mkdir','path','QorperaOS/vision'), pg_temp.vision('Nordlys Ends'),
		jsonb_build_object('op','mkdir','path','QorperaOS/agents'),
		pg_temp.write('QorperaOS/agents/sections.md', 'sections', E'# Sections\n', '{"kind":"sections","sections":[]}'),
		pg_temp.hire('co-founder', '70700000-0000-4000-8000-0000000000c0', 'Co-Founder', 'co-founder')));
	for i in 1..6 loop perform pg_temp.expect(r, i, 'saved'); end loop;
	r := pg_temp.commit(pg_temp.owner(), 'hire-0001', jsonb_build_array(pg_temp.hire('nora', '70700000-0000-4000-8000-0000000000a1', 'Nora'),
		jsonb_build_object('op','mkdir','path','QorperaOS/agents/nora/routines')));
	for i in 1..2 loop perform pg_temp.expect(r, i, 'saved'); end loop;
end $$;

-- 1. An end that has passed ends the routine at the save; a save that keeps it past keeps it ended, by anyone --------------
do $$
declare e1 constant uuid := '86700000-0000-4000-8000-0000000000e1'; x public.qorpera_cloud_routines; r jsonb;
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ends-0001', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-01-01T00:00:00Z"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'active' then raise exception 'Fixture: an active routine'; end if;
	-- Its end moved into the past: ended now, not at the next sweep.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ends-0002', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2020-01-01T00:00:00Z"}')))), 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'expired' or x.pause_reason is not null or x.expires_at is distinct from '2020-01-01T00:00:00Z'::timestamptz then
		raise exception 'An end that has passed ends the routine at the save: %', to_jsonb(x); end if;
	-- The member whose login does not pay changes only its quiet hours: saved, still ended (no restart, no login needed).
	r := pg_temp.commit(pg_temp.mem(), 'ends-0003', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2020-01-01T00:00:00Z",
			"quiet":{"start":"22:00","end":"06:00","timezone":"Europe/Copenhagen"}}'))));
	perform pg_temp.expect(r, 1, 'saved');
	x := pg_temp.rt(e1);
	if x.status is distinct from 'expired' or x.quiet_start is distinct from '22:00'::time then
		raise exception 'A save past the end keeps the routine ended: %', to_jsonb(x); end if;
	-- An end moved later but still past is no restart either.
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'ends-0004', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2021-01-01T00:00:00Z"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'expired' then raise exception 'A later end in the past revived it'; end if;
	-- An end later than now revives it: a restart, which the member's own login must pay for.
	perform pg_temp.needs_login(pg_temp.commit(pg_temp.mem(), 'ends-0005', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-01-01T00:00:00Z"}')))));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ends-0006', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2031-01-01T00:00:00Z"}')))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'active' then raise exception 'A later end revives it: %', to_jsonb(pg_temp.rt(e1)); end if;
	-- Removing the end revives an ended routine too.
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ends-0007', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every(), '{"ends":"2020-01-01T00:00:00Z"}')))), 1, 'saved');
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'ends-0008', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/inbox.md',
		pg_temp.rparse(e1, 'Inbox', pg_temp.every())))), 1, 'saved');
	if (pg_temp.rt(e1)).status is distinct from 'active' or (pg_temp.rt(e1)).expires_at is not null then
		raise exception 'Removing the end revives it: %', to_jsonb(pg_temp.rt(e1)); end if;
end $$;

-- 2. Used-up runs keep it ended, whoever saves it; more runs revive it (a restart the saver's login pays for) ------------
do $$
declare e2 constant uuid := '86700000-0000-4000-8000-0000000000e2';
begin
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'runs-0001', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/digest.md',
		pg_temp.rparse(e2, 'Digest', pg_temp.every(), '{"runs":1}')))), 1, 'saved');
	perform pg_temp.occurred(e2);
	perform pg_temp.fx(format($q$update public.qorpera_cloud_routines set status = 'expired', expired_while_active = true where id = %L$q$, e2));
	perform pg_temp.expect(pg_temp.commit(pg_temp.mem(), 'runs-0002', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/digest.md',
		pg_temp.rparse(e2, 'Digest', pg_temp.every(), '{"runs":1,"quiet":{"start":"22:00","end":"06:00","timezone":"Europe/Copenhagen"}}')))),
		1, 'saved');
	if (pg_temp.rt(e2)).status is distinct from 'expired' then raise exception 'Used-up runs keep it ended: %', to_jsonb(pg_temp.rt(e2)); end if;
	perform pg_temp.needs_login(pg_temp.commit(pg_temp.mem(), 'runs-0003', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/digest.md',
		pg_temp.rparse(e2, 'Digest', pg_temp.every(), '{"runs":2}')))));
	perform pg_temp.expect(pg_temp.commit(pg_temp.owner(), 'runs-0004', jsonb_build_array(pg_temp.routine('QorperaOS/agents/nora/routines/digest.md',
		pg_temp.rparse(e2, 'Digest', pg_temp.every(), '{"runs":2}')))), 1, 'saved');
	if (pg_temp.rt(e2)).status is distinct from 'active' then raise exception 'More runs revive it: %', to_jsonb(pg_temp.rt(e2)); end if;
end $$;

-- 3. The marker -----------------------------------------------------------------------------------------------------------
do $$
begin
	if position('20260930056000' in pg_get_functiondef('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) = 0
		or position('20260930056000' in pg_get_functiondef(
			'public.qorpera_company_state_routine_restarts(public.qorpera_cloud_routines,jsonb,jsonb,text)'::regprocedure)) = 0 then
		raise exception 'The bodies carry the marker'; end if;
end $$;

rollback;
