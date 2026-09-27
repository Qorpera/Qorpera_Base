-- Member pictures: a member uploads only into their own folder (four objects at
-- most), chooses only an object that exists there, and their current picture is
-- visible to themselves, to people they share a company with and to their
-- friends, never to strangers, nor to someone who only sent them a friend
-- request. Every assertion runs as the real PostgREST role named just above it.

insert into auth.users (id, email, email_confirmed_at)
values
	('95000000-0000-4000-8000-00000000000a', 'picture-owner@example.test', statement_timestamp()),
	('95000000-0000-4000-8000-00000000000b', 'picture-colleague@example.test', statement_timestamp()),
	('95000000-0000-4000-8000-00000000000c', 'picture-friend@example.test', statement_timestamp()),
	('95000000-0000-4000-8000-00000000000d', 'picture-stranger@example.test', statement_timestamp());

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
select set_config('qorpera_test.picture_profile', public.qorpera_create_hosted_profile('Pictures', 'main', 1) ->> 'profile_id', false);
reset role;

-- The colleague shares the company; the "friend" has only sent the owner a
-- request, which the owner has not accepted yet.
insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	current_setting('qorpera_test.picture_profile')::uuid,
	'95000000-0000-4000-8000-00000000000b',
	'picture-colleague@example.test',
	'Colleague',
	'contributor'
);
insert into public.qorpera_friendships (user_low, user_high, requested_by)
values ('95000000-0000-4000-8000-00000000000a', '95000000-0000-4000-8000-00000000000c', '95000000-0000-4000-8000-00000000000c');

do $$
begin
	if not exists (select 1 from storage.buckets where id = 'qorpera-member-pictures' and not public and file_size_limit = 524288) then
		raise exception 'the member picture bucket is missing, public, or has no size limit';
	end if;
end
$$;

-- The owner uploads and chooses pictures.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_me text := '95000000-0000-4000-8000-00000000000a';
	v_first text := '95000000-0000-4000-8000-00000000000a/' || repeat('1', 64) || '.webp';
	v_second text := '95000000-0000-4000-8000-00000000000a/' || repeat('2', 64) || '.jpg';
	v_result jsonb;
	v_seen integer;
	v_ok boolean;
begin
	if current_user <> 'authenticated' then
		raise exception 'owner block is not running as authenticated (got %)', current_user;
	end if;

	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-member-pictures', v_first, '{"size":"900"}');

	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000b/' || repeat('3', 64) || '.webp', '{}');
		raise exception 'a member uploaded into another member''s folder';
	exception when insufficient_privilege then null;
	end;
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-member-pictures', v_me || '/portrait.webp', '{}');
		raise exception 'a picture without a content hash name was accepted';
	exception when insufficient_privilege then null;
	end;
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-member-pictures', v_me || '/' || repeat('4', 64) || '.svg', '{}');
		raise exception 'an SVG picture name was accepted';
	exception when insufficient_privilege then null;
	end;

	v_ok := false;
	begin
		perform public.qorpera_set_member_picture(v_me || '/' || repeat('5', 64) || '.webp');
	exception when no_data_found then v_ok := true;
	end;
	if not v_ok then raise exception 'a picture that was never uploaded was chosen'; end if;

	v_ok := false;
	begin
		perform public.qorpera_set_member_picture('95000000-0000-4000-8000-00000000000b/' || repeat('1', 64) || '.webp');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'a picture in another member''s folder was chosen'; end if;

	v_ok := false;
	begin
		perform public.qorpera_set_member_picture('../' || v_first);
	exception when invalid_parameter_value then v_ok := true;
	end;
	if not v_ok then raise exception 'a malformed picture name was accepted'; end if;

	v_result := public.qorpera_set_member_picture(v_first);
	if v_result ->> 'object_name' <> v_first or v_result -> 'previous_object_name' <> 'null'::jsonb then
		raise exception 'first picture returned %', v_result;
	end if;
	-- Choosing the same picture again replaces nothing.
	v_result := public.qorpera_set_member_picture(v_first);
	if v_result -> 'previous_object_name' <> 'null'::jsonb then
		raise exception 'choosing the current picture again reported a replaced picture: %', v_result;
	end if;

	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-member-pictures', v_second, '{"size":"800"}');
	v_result := public.qorpera_set_member_picture(v_second);
	if v_result ->> 'previous_object_name' <> v_first then
		raise exception 'replacing a picture did not return the old one: %', v_result;
	end if;

	delete from storage.objects where bucket_id = 'qorpera-member-pictures' and name = v_first;
	get diagnostics v_seen = row_count;
	if v_seen <> 1 then raise exception 'the owner could not delete their replaced picture'; end if;

	-- An upload that never became the picture stays the owner's alone.
	insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-member-pictures', v_me || '/' || repeat('3', 64) || '.png', '{"size":"700"}');
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name like v_me || '/%';
	if v_seen <> 2 then raise exception 'the owner does not see their whole folder (got %)', v_seen; end if;
	v_result := public.qorpera_own_member_picture_objects();
	if jsonb_array_length(v_result) <> 2
		or not v_result @> jsonb_build_array(jsonb_build_object('object_name', v_second))
		or v_result -> 0 ->> 'created_at' is null
	then
		raise exception 'the own-folder listing is wrong: %', v_result;
	end if;

	-- The current picture cannot be deleted while it is the picture.
	delete from storage.objects where bucket_id = 'qorpera-member-pictures' and name = v_second;
	get diagnostics v_seen = row_count;
	if v_seen <> 0 then raise exception 'the owner deleted their current picture'; end if;

	v_result := public.qorpera_member_pictures(array[v_me::uuid]);
	if jsonb_array_length(v_result) <> 1 or v_result -> 0 ->> 'object_name' <> v_second then
		raise exception 'the owner does not see their own picture: %', v_result;
	end if;

	begin
		perform 1 from public.qorpera_member_pictures;
		raise exception 'the picture table is readable directly';
	exception when insufficient_privilege then null;
	end;

	v_ok := false;
	begin
		perform public.qorpera_member_pictures(array_fill(v_me::uuid, array[201]));
	exception when invalid_parameter_value then v_ok := true;
	end;
	if not v_ok then raise exception 'more than 200 pictures were read at once'; end if;
end
$$;

reset role;

-- The colleague and the friend see the picture; neither can remove it.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000b","email":"picture-colleague@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_owner uuid := '95000000-0000-4000-8000-00000000000a';
	v_picture text := '95000000-0000-4000-8000-00000000000a/' || repeat('2', 64) || '.jpg';
	v_result jsonb;
	v_seen integer;
begin
	if current_user <> 'authenticated' then
		raise exception 'colleague block is not running as authenticated (got %)', current_user;
	end if;
	v_result := public.qorpera_member_pictures(array[v_owner, '95000000-0000-4000-8000-00000000000d'::uuid]);
	if jsonb_array_length(v_result) <> 1 or v_result -> 0 ->> 'object_name' <> v_picture then
		raise exception 'a colleague does not see the owner''s picture: %', v_result;
	end if;
	select count(*) into v_seen from storage.objects where bucket_id = 'qorpera-member-pictures' and name = v_picture;
	if v_seen <> 1 then raise exception 'a colleague cannot download the owner''s picture'; end if;
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name like v_owner::text || '/%';
	if v_seen <> 1 then raise exception 'a colleague sees more of the owner''s folder than the current picture (got %)', v_seen; end if;
	delete from storage.objects where bucket_id = 'qorpera-member-pictures' and name = v_picture;
	get diagnostics v_seen = row_count;
	if v_seen <> 0 then raise exception 'a colleague deleted the owner''s picture'; end if;
end
$$;

reset role;

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000c","email":"picture-friend@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_result jsonb := public.qorpera_member_pictures(array['95000000-0000-4000-8000-00000000000a'::uuid]);
	v_seen integer;
begin
	if jsonb_array_length(v_result) <> 0 then
		raise exception 'sending a friend request revealed the picture: %', v_result;
	end if;
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name like '95000000-0000-4000-8000-00000000000a/%';
	if v_seen <> 0 then raise exception 'sending a friend request opened the picture folder'; end if;
end
$$;

reset role;

-- The owner sees the picture of the member who asked them (the asker agreed to be seen)...
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
begin
	if not public.qorpera_can_see_member_picture('95000000-0000-4000-8000-00000000000c') then
		raise exception 'the member asked cannot see the asker';
	end if;
end
$$;
reset role;

-- ...and once the owner accepts, the friend sees the owner's picture.
update public.qorpera_friendships set status = 'accepted', responded_at = statement_timestamp()
where user_low = '95000000-0000-4000-8000-00000000000a' and user_high = '95000000-0000-4000-8000-00000000000c';

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000c","email":"picture-friend@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_result jsonb := public.qorpera_member_pictures(array['95000000-0000-4000-8000-00000000000a'::uuid]);
begin
	if jsonb_array_length(v_result) <> 1 then
		raise exception 'a friend does not see the picture: %', v_result;
	end if;
end
$$;
reset role;

-- A stranger sees nothing, not even by guessing the object name.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000d","email":"picture-stranger@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_owner uuid := '95000000-0000-4000-8000-00000000000a';
	v_seen integer;
begin
	if current_user <> 'authenticated' then
		raise exception 'stranger block is not running as authenticated (got %)', current_user;
	end if;
	if jsonb_array_length(public.qorpera_member_pictures(array[v_owner])) <> 0 then
		raise exception 'a stranger read the owner''s picture name';
	end if;
	if jsonb_array_length(public.qorpera_own_member_picture_objects()) <> 0 then
		raise exception 'the own-folder listing showed a stranger someone else''s objects';
	end if;
	if public.qorpera_is_current_member_picture(v_owner::text || '/' || repeat('2', 64) || '.jpg') then
		raise exception 'is_current_member_picture answered about another account';
	end if;
	if public.qorpera_can_see_member_picture(v_owner) then
		raise exception 'can_see_member_picture is true for a stranger';
	end if;
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name like v_owner::text || '/%';
	if v_seen <> 0 then raise exception 'a stranger listed the owner''s pictures'; end if;
end
$$;

reset role;

-- Anti-vacuity: the stranger's empty reads only mean "hidden" if the picture is there.
do $$
begin
	if not exists (
		select 1 from storage.objects
		where bucket_id = 'qorpera-member-pictures'
			and name = '95000000-0000-4000-8000-00000000000a/' || repeat('2', 64) || '.jpg'
	) then
		raise exception 'stranger assertions would be vacuous: the owner has no picture';
	end if;
end
$$;

set role anon;
do $$
begin
	perform public.qorpera_member_pictures(array['95000000-0000-4000-8000-00000000000a'::uuid]);
	raise exception 'anon read member pictures';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- Storage writes the final row as the storage service, past row security; the
-- limit holds there too, and parallel uploads into one folder count one after
-- another: the second waits for the first to commit, then sees its objects and
-- is refused.
select dblink_connect('picture_a', 'dbname=qorpera_test');
select dblink_connect('picture_b', 'dbname=qorpera_test');
select dblink_exec('picture_a', $$set request.jwt.claims = '{"role":"service_role"}'$$);
select dblink_exec('picture_b', $$set request.jwt.claims = '{"role":"service_role"}'$$);
select dblink_exec('picture_a', 'set role service_role');
select dblink_exec('picture_b', 'set role service_role');
select dblink_exec('picture_a', 'begin');
select dblink_exec('picture_a', $$insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000a/' || repeat('9', 64) || '.webp', '{}')$$);
select dblink_exec('picture_a', $$insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000a/' || repeat('a', 64) || '.webp', '{}')$$);
select dblink_send_query('picture_b', $$insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000a/' || repeat('b', 64) || '.webp', '{}')$$);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('picture_b') <> 1 then
		raise exception 'a parallel upload did not wait for the first one to be counted';
	end if;
end
$$;

select dblink_exec('picture_a', 'commit');

do $$
begin
	perform * from dblink_get_result('picture_b') as result(status text);
	raise exception 'a parallel upload passed the four-object limit';
exception when insufficient_privilege then null;
end
$$;

select dblink_disconnect('picture_b');
select dblink_disconnect('picture_a');

do $$
declare v_seen integer;
begin
	select count(*) into v_seen from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name like '95000000-0000-4000-8000-00000000000a/%';
	if v_seen <> 4 then raise exception 'the folder should hold four objects after the parallel uploads (got %)', v_seen; end if;
	delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name in (
			'95000000-0000-4000-8000-00000000000a/' || repeat('9', 64) || '.webp',
			'95000000-0000-4000-8000-00000000000a/' || repeat('a', 64) || '.webp'
		);
end
$$;

-- Choosing an object and deleting it wait for each other: a delete that comes
-- while the object is being chosen finds it current and leaves it.
select dblink_connect('picture_a', 'dbname=qorpera_test');
select dblink_connect('picture_b', 'dbname=qorpera_test');
select dblink_exec('picture_a', $$set request.jwt.claims = '{"sub":"95000000-0000-4000-8000-00000000000a","role":"authenticated"}'$$);
select dblink_exec('picture_b', $$set request.jwt.claims = '{"sub":"95000000-0000-4000-8000-00000000000a","role":"authenticated"}'$$);
select dblink_exec('picture_a', 'set role authenticated');
select dblink_exec('picture_b', 'set role authenticated');
select dblink_exec('picture_a', 'begin');
select * from dblink('picture_a', $$select public.qorpera_set_member_picture(
	'95000000-0000-4000-8000-00000000000a/' || repeat('3', 64) || '.png')::text$$) as chosen(result text);
select dblink_send_query('picture_b', $$delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name = '95000000-0000-4000-8000-00000000000a/' || repeat('3', 64) || '.png'
	returning name$$);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('picture_b') <> 1 then
		raise exception 'a delete did not wait for the picture being chosen';
	end if;
end
$$;

select dblink_exec('picture_a', 'commit');

do $$
declare v_deleted integer;
begin
	select count(*) into v_deleted from dblink_get_result('picture_b') as deleted(name text);
	if v_deleted <> 0 then raise exception 'a delete removed the picture being chosen'; end if;
end
$$;

select dblink_disconnect('picture_b');
select dblink_disconnect('picture_a');

-- The other order: a delete that holds the folder first leaves nothing to
-- choose, and the choice says so instead of pointing at a missing object.
select dblink_connect('picture_a', 'dbname=qorpera_test');
select dblink_connect('picture_b', 'dbname=qorpera_test');
select dblink_exec('picture_a', $$set request.jwt.claims = '{"sub":"95000000-0000-4000-8000-00000000000a","role":"authenticated"}'$$);
select dblink_exec('picture_b', $$set request.jwt.claims = '{"sub":"95000000-0000-4000-8000-00000000000a","role":"authenticated"}'$$);
select dblink_exec('picture_a', 'set role authenticated');
select dblink_exec('picture_b', 'set role authenticated');
-- First make the spare object stop being the picture again.
select * from dblink('picture_a', $$select public.qorpera_set_member_picture(
	'95000000-0000-4000-8000-00000000000a/' || repeat('2', 64) || '.jpg')::text$$) as chosen(result text);
select dblink_exec('picture_a', 'begin');
select * from dblink('picture_a', $$delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name = '95000000-0000-4000-8000-00000000000a/' || repeat('3', 64) || '.png'
	returning name$$) as deleted(name text);
select dblink_send_query('picture_b', $$select public.qorpera_set_member_picture(
	'95000000-0000-4000-8000-00000000000a/' || repeat('3', 64) || '.png')::text$$);
select pg_sleep(0.2);

do $$
begin
	if dblink_is_busy('picture_b') <> 1 then
		raise exception 'a choice did not wait for the delete holding the folder';
	end if;
end
$$;

select dblink_exec('picture_a', 'commit');

do $$
begin
	perform * from dblink_get_result('picture_b') as chosen(result text);
	raise exception 'a deleted object was chosen as the picture';
exception when no_data_found then null;
end
$$;

select dblink_disconnect('picture_b');
select dblink_disconnect('picture_a');

-- Put the spare object back, and one stored ten minutes ago, for the age check.
insert into storage.objects (bucket_id, name, metadata)
values ('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000a/' || repeat('3', 64) || '.png', '{"size":"700"}');
insert into storage.objects (bucket_id, name, metadata, created_at)
values (
	'qorpera-member-pictures',
	'95000000-0000-4000-8000-00000000000a/' || repeat('4', 64) || '.png',
	'{"size":"700"}',
	statement_timestamp() - interval '10 minutes'
);

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_objects jsonb := public.qorpera_own_member_picture_objects();
	v_old jsonb;
begin
	select value into v_old from jsonb_array_elements(v_objects)
	where value ->> 'object_name' = '95000000-0000-4000-8000-00000000000a/' || repeat('4', 64) || '.png';
	if v_old is null or (v_old ->> 'age_seconds')::bigint < 600 then
		raise exception 'the own-folder listing does not age objects by the cloud''s clock: %', v_objects;
	end if;
end
$$;
reset role;
delete from storage.objects
where bucket_id = 'qorpera-member-pictures'
	and name = '95000000-0000-4000-8000-00000000000a/' || repeat('4', 64) || '.png';

-- A name that is no picture name is refused by the policy, not counted.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
begin
	insert into storage.objects (bucket_id, name, metadata)
	values ('qorpera-member-pictures', '%/' || repeat('5', 64) || '.webp', '{}');
	raise exception 'a malformed picture name was stored';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- A move into a full folder counts like an upload.
do $$
declare v_me text := '95000000-0000-4000-8000-00000000000a';
begin
	insert into storage.objects (bucket_id, name, metadata)
	values
		('qorpera-member-pictures', v_me || '/' || repeat('c', 64) || '.webp', '{}'),
		('qorpera-member-pictures', v_me || '/' || repeat('d', 64) || '.webp', '{}'),
		('qorpera-member-pictures', '95000000-0000-4000-8000-00000000000b/' || repeat('e', 64) || '.webp', '{}');
	-- The folder is full. Names that are no picture names (which the policies
	-- refuse members) are not the trigger's to count or lock: the storage service
	-- may still write them.
	insert into storage.objects (bucket_id, name, metadata)
	values
		('qorpera-member-pictures', '%/' || repeat('5', 64) || '.webp', '{}'),
		('qorpera-member-pictures', v_me || '/portrait.webp', '{}');
	delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name in ('%/' || repeat('5', 64) || '.webp', v_me || '/portrait.webp');
	begin
		update storage.objects
		set name = v_me || '/' || repeat('e', 64) || '.webp'
		where bucket_id = 'qorpera-member-pictures'
			and name = '95000000-0000-4000-8000-00000000000b/' || repeat('e', 64) || '.webp';
		raise exception 'a move into a full folder was allowed';
	exception when insufficient_privilege then null;
	end;
	-- Renaming within the folder does not count the object twice.
	update storage.objects
	set name = v_me || '/' || repeat('f', 64) || '.webp'
	where bucket_id = 'qorpera-member-pictures' and name = v_me || '/' || repeat('d', 64) || '.webp';
	delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name in (
			v_me || '/' || repeat('c', 64) || '.webp',
			v_me || '/' || repeat('f', 64) || '.webp',
			'95000000-0000-4000-8000-00000000000b/' || repeat('e', 64) || '.webp'
		);
end
$$;

-- Back to the earlier picture for the checks below.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;
do $$
declare
	v_result jsonb := public.qorpera_set_member_picture(
		'95000000-0000-4000-8000-00000000000a/' || repeat('2', 64) || '.jpg'
	);
	v_objects jsonb := public.qorpera_own_member_picture_objects();
begin
	if v_result -> 'previous_object_name' <> 'null'::jsonb then
		raise exception 'the earlier picture was not current again: %', v_result;
	end if;
	if (v_objects -> 0 ->> 'age_seconds') is null or (v_objects -> 0 ->> 'age_seconds')::bigint < 0 then
		raise exception 'the own-folder listing has no cloud-side age: %', v_objects;
	end if;
end
$$;
reset role;

-- The owner goes back to initials.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_me text := '95000000-0000-4000-8000-00000000000a';
begin
	-- The folder holds the current picture and the unused upload: two more fit.
	insert into storage.objects (bucket_id, name, metadata)
	values
		('qorpera-member-pictures', v_me || '/' || repeat('6', 64) || '.webp', '{}'),
		('qorpera-member-pictures', v_me || '/' || repeat('7', 64) || '.webp', '{}');
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-member-pictures', v_me || '/' || repeat('8', 64) || '.webp', '{}');
		raise exception 'a fifth object was stored in one member''s folder';
	exception when insufficient_privilege then null;
	end;
	delete from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name in (v_me || '/' || repeat('6', 64) || '.webp', v_me || '/' || repeat('7', 64) || '.webp');
end
$$;

do $$
declare
	v_owner uuid := '95000000-0000-4000-8000-00000000000a';
	v_result jsonb := public.qorpera_clear_member_picture();
	v_seen integer;
begin
	if v_result ->> 'previous_object_name' <> v_owner::text || '/' || repeat('2', 64) || '.jpg' then
		raise exception 'clearing did not return the removed picture: %', v_result;
	end if;
	if jsonb_array_length(public.qorpera_member_pictures(array[v_owner])) <> 0 then
		raise exception 'a cleared picture is still listed';
	end if;
	v_result := public.qorpera_clear_member_picture();
	if v_result -> 'previous_object_name' <> 'null'::jsonb then
		raise exception 'clearing twice returned a picture: %', v_result;
	end if;
	-- Once it is no longer the picture, its owner can delete it.
	delete from storage.objects
	where bucket_id = 'qorpera-member-pictures' and name = v_owner::text || '/' || repeat('2', 64) || '.jpg';
	get diagnostics v_seen = row_count;
	if v_seen <> 1 then raise exception 'the owner could not delete a picture they cleared'; end if;
end
$$;

reset role;
