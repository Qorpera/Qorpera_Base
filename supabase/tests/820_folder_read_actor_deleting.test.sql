-- @fixture 647_folder_core_run_fence.test.sql until "-- The checks start here: a test that runs after this file's fixture part stops at this line."
-- Folder core slice P01 (20260930001000; F3's P1): a company being deleted serves its folder to no one. Members and the
-- platform get 55000 'Company is being deleted' from the actor check, read, list and the feed; a run keeps its 'Company
-- execution is paused'; another company's deletion changes nothing; once the deletion row is gone they read again. The
-- check reads, never locks.

create function pg_temp.reads_ok(p_actor jsonb) returns void language plpgsql as $$
declare c_env constant uuid := '63400000-0000-4000-8000-000000000020';
begin
	perform public.qorpera_folder_read_actor(c_env, p_actor);
	if public.qorpera_folder_list(c_env, p_actor, '', null, 10) -> 'entries' is null then
		raise exception 'No listing for %', p_actor; end if;
	if (public.qorpera_folder_read(c_env, p_actor, 'deleting/plan.md') -> 'entry' ->> 'path') is distinct from 'deleting/plan.md' then
		raise exception 'No read for %', p_actor; end if;
	perform public.qorpera_folder_feed(c_env, p_actor, 0, 100);
end $$;

do $$
declare
	c_env constant uuid := '63400000-0000-4000-8000-000000000020'; c_profile constant uuid := '63400000-0000-4000-8000-000000000010';
	c_other constant uuid := '82000000-0000-4000-8000-000000000010';
	p jsonb := pg_temp.run('63400000-0000-4000-8000-0000000000a1', 'human', '63400000-0000-4000-8000-000000000002');
	a jsonb; x jsonb;
begin
	x := pg_temp.commit('{"kind":"platform"}', 'deleting-setup', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','deleting'),
		jsonb_build_object('op','write','path','deleting/plan.md','file',pg_temp.stage('the plan'))));
	perform pg_temp.expect(x, 2, 'saved');

	-- Before: the platform and a member read, list and follow the feed.
	foreach a in array array['{"kind":"platform"}'::jsonb, pg_temp.member(2)] loop perform pg_temp.reads_ok(a); end loop;

	-- Another company being deleted changes nothing here.
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id) values (%L)', c_other));
	foreach a in array array['{"kind":"platform"}'::jsonb, pg_temp.member(2)] loop perform pg_temp.reads_ok(a); end loop;

	-- This company being deleted: members and the platform stop at the actor check, and so do read, list and the feed.
	perform pg_temp.fx(format('insert into public.qorpera_company_deletions(profile_id, requested_by_user_id) values (%L, %L)',
		c_profile, '63400000-0000-4000-8000-000000000001'));
	foreach a in array array['{"kind":"platform"}'::jsonb, pg_temp.member(1), pg_temp.member(2)] loop
		perform pg_temp.raises_like(format('select public.qorpera_folder_read_actor(%L, %L)', c_env, a), '55000', 'Company is being deleted');
		perform pg_temp.raises_like(format('select public.qorpera_folder_list(%L, %L, %L, null, 10)', c_env, a, ''), '55000',
			'Company is being deleted');
		perform pg_temp.raises_like(format('select public.qorpera_folder_read(%L, %L, %L)', c_env, a, 'deleting/plan.md'), '55000',
			'Company is being deleted');
		perform pg_temp.raises_like(format('select public.qorpera_folder_feed(%L, %L, 0, 100)', c_env, a), '55000',
			'Company is being deleted');
	end loop;
	-- A run stops as before, with the text the runtime reads.
	perform pg_temp.raises_like(format('select public.qorpera_folder_read_actor(%L, %L)', c_env, p), '55000', 'Company execution is paused');

	-- The deletion row gone (as in a test reset; a real deletion purges the company), they read again.
	perform pg_temp.fx(format('delete from public.qorpera_company_deletions where profile_id in (%L, %L)', c_profile, c_other));
	foreach a in array array['{"kind":"platform"}'::jsonb, pg_temp.member(2)] loop perform pg_temp.reads_ok(a); end loop;
end $$;

-- The body carries its release marker, and the read path still takes no lock (as 632 checks).
do $$
begin
	if position('20260930001000' in pg_get_functiondef('public.qorpera_folder_read_actor(uuid,jsonb)'::regprocedure)) = 0 then
		raise exception 'qorpera_folder_read_actor lacks the P01 marker'; end if;
	if exists (select 1 from pg_proc where proname = 'qorpera_folder_read_actor'
			and prosrc ~* '\mfor\s+(update|share|key\s+share|no\s+key\s+update)\M') then
		raise exception 'qorpera_folder_read_actor takes a lock'; end if;
end $$;

rollback;
