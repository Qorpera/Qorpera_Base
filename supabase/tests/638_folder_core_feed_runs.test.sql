-- @fixture 632_folder_core_agents.test.sql until "-- A leased run of agent A saves as the agent"
-- Company folder core, C1f with C1b-1's run actors: a run follows the feed with exactly the authority it reads
-- with (the paths qorpera_folder_read shows it), in a company and in a member-private conversation; a paused
-- company refuses a run's feed as it refuses its reads; a malformed run actor is refused.

create function pg_temp.feed(p_actor jsonb, p_after bigint default 0, p_limit integer default 1000) returns jsonb language sql as $$
	select public.qorpera_folder_feed('63200000-0000-4000-8000-000000000020', p_actor, p_after, p_limit)
$$;
-- Every path the feed gives an actor, following it to the clock.
create function pg_temp.feed_paths(p_actor jsonb, p_limit integer default 1000) returns text[] language plpgsql as $$
declare v jsonb; v_after bigint := 0; v_cursor jsonb; v_out text[] := '{}';
begin
	loop
		v := public.qorpera_folder_feed('63200000-0000-4000-8000-000000000020', p_actor, v_after, p_limit, v_cursor);
		v_out := v_out || array(select c.value ->> 'path' from jsonb_array_elements(v -> 'events') e,
			jsonb_array_elements(coalesce(e.value -> 'changes', '[]')) c);
		exit when not (v ->> 'more')::boolean;
		v_after := (v -> 'next' ->> 'afterSeq')::bigint; v_cursor := v -> 'next' -> 'cursor';
	end loop;
	return v_out;
end $$;

do $$
declare
	c_member constant uuid := '63200000-0000-4000-8000-000000000002';
	c_private constant text := 'members/63200000-0000-4000-8000-000000000002/private';
	c_other constant text := 'members/63200000-0000-4000-8000-000000000004/private';
	v_all text[]; v_run jsonb; v_private_run jsonb; v_actor jsonb; v_seen text[]; v_path text; v_limit integer;
begin
	insert into public.qorpera_company_path_resources(environment_id,path,path_match,scope,owner_user_id,policy,created_by_user_id)
	values ('63200000-0000-4000-8000-000000000020', c_private, 'subtree', 'member_private', c_member, 'normal', c_member),
		('63200000-0000-4000-8000-000000000020', c_other, 'subtree', 'member_private', '63200000-0000-4000-8000-000000000004',
			'normal', '63200000-0000-4000-8000-000000000004');
	perform pg_temp.expect(pg_temp.commit('{"kind":"platform"}', 'feed-runs-1', jsonb_build_array(
		jsonb_build_object('op','mkdir','path','members'),
		jsonb_build_object('op','mkdir','path','members/63200000-0000-4000-8000-000000000002'),
		jsonb_build_object('op','mkdir','path',c_private),
		jsonb_build_object('op','write','path',c_private || '/note.txt','file',pg_temp.stage('mine')),
		jsonb_build_object('op','mkdir','path','members/63200000-0000-4000-8000-000000000004'),
		jsonb_build_object('op','mkdir','path',c_other),
		jsonb_build_object('op','write','path',c_other || '/note.txt','file',pg_temp.stage('theirs')),
		jsonb_build_object('op','mkdir','path','shared'),
		jsonb_build_object('op','write','path','shared/a.txt','file',pg_temp.stage('alpha')))), 9, 'saved');
	v_all := pg_temp.feed_paths('{"kind":"platform"}');
	if cardinality(v_all) <> 9 then raise exception 'The platform feed is wrong: %', v_all; end if;

	-- A company conversation's run and a member-private one each see exactly what they may read.
	v_run := pg_temp.run('human', c_member);
	v_private_run := pg_temp.run('human', c_member, 'member_private');
	foreach v_actor in array array[v_run, v_private_run] loop
		foreach v_limit in array array[1000, 2, 1] loop
			v_seen := pg_temp.feed_paths(v_actor, v_limit);
			foreach v_path in array v_all loop
				if (v_path = any (v_seen)) <> (pg_temp.read(v_path, v_actor) ->> 'found')::boolean then
					raise exception 'A run''s feed and its reads disagree on % (%): %', v_path, v_actor, v_seen; end if;
			end loop;
			if exists (select 1 from unnest(v_seen) p where p like c_other || '%') then
				raise exception 'A run saw another member''s private folder: %', v_seen; end if;
		end loop;
	end loop;
	if not ('shared/a.txt' = any (pg_temp.feed_paths(v_run))) then
		raise exception 'A run misses a shared file'; end if;

	-- A malformed run actor is refused; a paused company refuses a run's feed as it refuses its reads.
	perform pg_temp.raises(format('select pg_temp.feed(%L)', v_run - 'jobId'), '22023');
	perform public.qorpera_folder_pause('63200000-0000-4000-8000-000000000010', '63200000-0000-4000-8000-000000000001', 'test');
	perform public.qorpera_folder_pause_drain('63200000-0000-4000-8000-000000000010');
	perform pg_temp.raises(format('select pg_temp.feed(%L)', v_run), '55000');
	if jsonb_array_length(pg_temp.feed(pg_temp.member(2)) -> 'events') = 0 then
		raise exception 'A member''s feed stopped during a pause'; end if;
	perform public.qorpera_folder_resume('63200000-0000-4000-8000-000000000010');
	if cardinality(pg_temp.feed_paths(v_run)) = 0 then raise exception 'A run''s feed did not come back after resume'; end if;
end $$;

rollback;
