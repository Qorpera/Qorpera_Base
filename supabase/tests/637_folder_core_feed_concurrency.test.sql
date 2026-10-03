-- @fixture 631_folder_core_concurrency.test.sql until "-- A. Disjoint paths never wait"
-- Company folder core, C1f: the feed under concurrent commits (RUNTIME-COMPANY-FOLDER-CORE.md §3 step 11,
-- §6). A commit in flight holds the clock, so a reader never sees its seq early, a later commit takes the
-- next seq only after it, and a reader continuing from `next` gets both, in order, with nothing skipped.
-- Reading the feed never waits on a commit. Reuses 631's committed fixture and connections, and removes it.

create function pg_temp.feed(p_after bigint, p_limit integer default 1000) returns jsonb language sql as $$
	select public.qorpera_folder_feed('63100000-0000-4000-8000-000000000020', '{"kind":"platform"}', p_after, p_limit)
$$;

do $$
declare v jsonb; v_after bigint; r jsonb;
begin
	v := pg_temp.feed(0);
	if (v ->> 'asOfSeq')::bigint <> pg_temp.seq() or (v ->> 'more')::boolean then
		raise exception 'The fixture feed is wrong: %', v; end if;
	v_after := (v -> 'next' ->> 'afterSeq')::bigint;

	-- race_one commits and stays open, holding the clock; race_two's disjoint commit waits for it.
	perform dblink_exec('race_one', 'begin');
	perform * from dblink('race_one', pg_temp.sql_commit('feed-race-1', jsonb_build_array(jsonb_build_object('op','write',
		'path','feed-one.txt','file',current_setting('qorpera_test.race_one')::jsonb)))) as t(r jsonb);
	perform dblink_send_query('race_two', pg_temp.sql_commit('feed-race-2', jsonb_build_array(jsonb_build_object('op','write',
		'path','feed-two.txt','file',current_setting('qorpera_test.race_two')::jsonb))));
	if not pg_temp.waits_for('race_two', 'race_one') then raise exception 'A second commit did not wait for the clock'; end if;

	-- Reading the feed meanwhile neither waits nor shows the commit in flight.
	perform dblink_send_query('race_zero', format('select public.qorpera_folder_feed(%L, %L, %s, 1000)',
		'63100000-0000-4000-8000-000000000020', '{"kind":"platform"}', v_after));
	if not pg_temp.finishes_unblocked('race_zero', 'race_one') then raise exception 'Reading the feed waited on a commit'; end if;
	r := pg_temp.result('race_zero');
	if r -> 'events' <> '[]'::jsonb or (r ->> 'asOfSeq')::bigint <> v_after or (r ->> 'more')::boolean then
		raise exception 'A reader saw a commit in flight: %', r; end if;

	perform dblink_exec('race_one', 'commit');
	r := pg_temp.one(pg_temp.result('race_two'));
	if r ->> 'outcome' <> 'saved' then raise exception 'The waiting commit failed: %', r; end if;

	-- Continuing from `next` gives both commits, in commit order, once each.
	v := pg_temp.feed(v_after);
	if jsonb_array_length(v -> 'events') <> 2 or (v -> 'events' -> 0 ->> 'seq')::bigint <> v_after + 1
		or (v -> 'events' -> 1 ->> 'seq')::bigint <> v_after + 2
		or v -> 'events' -> 0 -> 'changes' -> 0 ->> 'path' <> 'feed-one.txt'
		or v -> 'events' -> 1 -> 'changes' -> 0 ->> 'path' <> 'feed-two.txt'
		or (v ->> 'asOfSeq')::bigint <> v_after + 2 or (v ->> 'more')::boolean then
		raise exception 'A follower skipped or reordered commits: %', v; end if;
end $$;

select dblink_disconnect(name) from unnest(array['race_zero','race_one','race_two']) name;

-- The committed fixture leaves the shared suite database.
delete from public.qorpera_folder_journal where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_path_versions where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_entries where environment_id = '63100000-0000-4000-8000-000000000020';
delete from public.qorpera_folder_commits where environment_id = '63100000-0000-4000-8000-000000000020';
-- Version-2 objects are catalog rows of the object gateway (no Storage mirror, no link to the company), so they go by
-- hand, with their proofs and chunk rows; the intents go with the company.
delete from public.qorpera_profile_objects where profile_id = '63100000-0000-4000-8000-000000000010';
delete from public.qorpera_profiles where id = '63100000-0000-4000-8000-000000000010';
delete from storage.objects where bucket_id = 'qorpera-profile-objects' and name like '63100000-0000-4000-8000-000000000010/%';
delete from auth.users where id = '63100000-0000-4000-8000-000000000001';
do $$
begin
	if exists (select 1 from public.qorpera_company_files where environment_id = '63100000-0000-4000-8000-000000000020')
		or exists (select 1 from public.qorpera_folder_clocks where environment_id = '63100000-0000-4000-8000-000000000020')
		or exists (select 1 from storage.objects where name like '63100000-0000-4000-8000-000000000010/%')
		or exists (select 1 from public.qorpera_profile_objects where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_folder_upload_intents where profile_id = '63100000-0000-4000-8000-000000000010')
		or exists (select 1 from public.qorpera_verified_company_file_objects where profile_id = '63100000-0000-4000-8000-000000000010') then
		raise exception 'The feed race fixture must be removed'; end if;
end $$;
