-- Member pictures: a member uploads only into their own folder, chooses only an
-- object that exists there, and their picture is visible to themselves, to
-- people they share a company with and to their friends, never to strangers.
-- Every assertion runs as the real PostgREST role named just above it.

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

-- The colleague shares the company; the friend has only a pending request.
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
begin
	if jsonb_array_length(v_result) <> 1 then
		raise exception 'a friend (request pending) does not see the picture: %', v_result;
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

-- The owner goes back to initials.
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-00000000000a","email":"picture-owner@example.test","role":"authenticated","user_metadata":{}}', false);
set role authenticated;

do $$
declare
	v_owner uuid := '95000000-0000-4000-8000-00000000000a';
	v_result jsonb := public.qorpera_clear_member_picture();
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
end
$$;

reset role;
