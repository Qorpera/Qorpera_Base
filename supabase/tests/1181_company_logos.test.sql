-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Company logos (20260930696000): the official logo is the company folder's QorperaOS/brand/logo.png; a member who
-- may write the folder publishes a copy into the qorpera-company-logos bucket, named by the file's sha256, and only
-- that copy. Members, people with an open invitation and accepted friends of members see the copy; viewers see it but
-- cannot publish; strangers see nothing. The fixture's company: owner …01, contributor …02, viewer …03, admin …04,
-- outsider …05 (no member).

-- The folder's logo, as the brand agent (here: the owner) saves it.
do $$
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'logo-0001', jsonb_build_array(
		jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/brand'),
		jsonb_build_object('op', 'write', 'path', 'QorperaOS/brand/logo.png', 'file', pg_temp.base_stage('first logo'))));
end
$$;
select set_config('qorpera_test.logo_sha', encode(extensions.digest(convert_to('first logo', 'utf8'), 'sha256'), 'hex'), false);

-- The friend (…06) is an accepted friend of the contributor; the invitee (…07) has an open invitation; the stranger
-- (…08) knows nobody.
insert into auth.users (id, email, email_confirmed_at) values
	('92400000-0000-4000-8000-000000000006', 'logo-friend@example.test', statement_timestamp()),
	('92400000-0000-4000-8000-000000000007', 'logo-invitee@example.test', statement_timestamp()),
	('92400000-0000-4000-8000-000000000008', 'logo-stranger@example.test', statement_timestamp());
insert into public.qorpera_friendships (user_low, user_high, requested_by, status, responded_at)
values ('92400000-0000-4000-8000-000000000002', '92400000-0000-4000-8000-000000000006',
	'92400000-0000-4000-8000-000000000006', 'accepted', statement_timestamp());
insert into public.qorpera_profile_invitations (profile_id, email, role, invited_by_user_id, expires_at)
values ('92400000-0000-4000-8000-000000000010', 'logo-invitee@example.test', 'contributor',
	'92400000-0000-4000-8000-000000000001', statement_timestamp() + interval '7 days');

do $$
begin
	if not exists (select 1 from storage.buckets where id = 'qorpera-company-logos' and not public
		and file_size_limit = 1048576 and allowed_mime_types = array['image/png']) then
		raise exception 'the company logo bucket is missing, public, or unbounded';
	end if;
end
$$;

-- The contributor's app sees the folder's logo is not published yet, uploads the copy and publishes it.
create function pg_temp.logo_as(p_user uuid) returns void language plpgsql as $$
begin
	perform pg_temp.base_claims('authenticated', p_user);
	set local role authenticated;
end $$;
create function pg_temp.logo_back() returns void language plpgsql as $$
begin
	reset role;
	perform pg_temp.base_claims('service_role');
end $$;

do $$
declare
	v jsonb;
	v_copy text := '92400000-0000-4000-8000-000000000010/' || current_setting('qorpera_test.logo_sha') || '.png';
	v_wrong text := '92400000-0000-4000-8000-000000000010/' || repeat('e', 64) || '.png';
	v_ok boolean := false;
begin
	perform pg_temp.logo_as('92400000-0000-4000-8000-000000000002');
	select public.qorpera_company_logos(array['92400000-0000-4000-8000-000000000010'::uuid]) into v;
	if jsonb_array_length(v) <> 1 or v -> 0 ->> 'object_name' is not null or not (v -> 0 ->> 'publisher')::boolean
		or v -> 0 ->> 'source_sha256' <> current_setting('qorpera_test.logo_sha') then
		raise exception 'the contributor does not see an unpublished folder logo: %', v;
	end if;
	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-company-logos', v_copy, '{"size":"10"}');
	insert into storage.objects (bucket_id, name, metadata) values ('qorpera-company-logos', v_wrong, '{"size":"10"}');
	-- A copy that is not the folder's current logo is refused.
	begin
		perform public.qorpera_publish_company_logo('92400000-0000-4000-8000-000000000010', v_wrong);
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'a copy that is not the folder logo was published'; end if;
	-- Taking the copy away while the folder still holds a logo is refused.
	v_ok := false;
	begin
		perform public.qorpera_publish_company_logo('92400000-0000-4000-8000-000000000010', null);
	exception when sqlstate '22023' then v_ok := true;
	end;
	if not v_ok then raise exception 'the copy went away while the folder holds a logo'; end if;
	select public.qorpera_publish_company_logo('92400000-0000-4000-8000-000000000010', v_copy) into v;
	if v ->> 'object_name' <> v_copy or v ->> 'previous_object_name' is not null then
		raise exception 'the copy was not published: %', v;
	end if;
	-- The current copy cannot be deleted; the stray upload can.
	delete from storage.objects where bucket_id = 'qorpera-company-logos' and name = v_copy;
	delete from storage.objects where bucket_id = 'qorpera-company-logos' and name = v_wrong;
	perform pg_temp.logo_back();
	if not exists (select 1 from storage.objects where bucket_id = 'qorpera-company-logos' and name = v_copy)
		or exists (select 1 from storage.objects where bucket_id = 'qorpera-company-logos' and name = v_wrong) then
		raise exception 'deletes in the logo folder did not follow the current copy';
	end if;
end
$$;

-- A viewer sees the copy but may not publish or upload.
do $$
declare v jsonb; v_ok boolean := false;
begin
	perform pg_temp.logo_as('92400000-0000-4000-8000-000000000003');
	select public.qorpera_company_logos(array['92400000-0000-4000-8000-000000000010'::uuid]) into v;
	if v -> 0 ->> 'object_name' is null or (v -> 0 ->> 'publisher')::boolean or v -> 0 ->> 'source_sha256' is not null then
		raise exception 'the viewer''s answer is not as expected: %', v;
	end if;
	begin
		perform public.qorpera_publish_company_logo('92400000-0000-4000-8000-000000000010', null);
	exception when sqlstate '42501' then v_ok := true;
	end;
	if not v_ok then raise exception 'a viewer published the logo'; end if;
	v_ok := false;
	begin
		insert into storage.objects (bucket_id, name, metadata)
		values ('qorpera-company-logos', '92400000-0000-4000-8000-000000000010/' || repeat('a', 64) || '.png', '{}');
	exception when insufficient_privilege then v_ok := true;
	end;
	if not v_ok then raise exception 'a viewer uploaded into the logo folder'; end if;
	perform pg_temp.logo_back();
end
$$;

-- The friend of a member and the invitee see the copy and can read its object; the stranger sees nothing.
do $$
declare v jsonb; v_user uuid;
begin
	foreach v_user in array array['92400000-0000-4000-8000-000000000006'::uuid, '92400000-0000-4000-8000-000000000007'::uuid] loop
		perform pg_temp.logo_as(v_user);
		select public.qorpera_company_logos(array['92400000-0000-4000-8000-000000000010'::uuid]) into v;
		if jsonb_array_length(v) <> 1 or v -> 0 ->> 'object_name' is null or (v -> 0 ->> 'publisher')::boolean
			or v -> 0 ->> 'source_sha256' is not null then
			raise exception '% does not see the logo copy alone: %', v_user, v;
		end if;
		if not exists (select 1 from storage.objects where bucket_id = 'qorpera-company-logos' and name = v -> 0 ->> 'object_name') then
			raise exception '% cannot read the logo copy', v_user;
		end if;
		perform pg_temp.logo_back();
	end loop;
	perform pg_temp.logo_as('92400000-0000-4000-8000-000000000008');
	select public.qorpera_company_logos(array['92400000-0000-4000-8000-000000000010'::uuid]) into v;
	if jsonb_array_length(v) <> 0 or exists (select 1 from storage.objects where bucket_id = 'qorpera-company-logos') then
		raise exception 'a stranger sees the company logo: %', v;
	end if;
	perform pg_temp.logo_back();
end
$$;

-- A new folder logo leaves the copy behind until a member publishes again; a deleted one lets the copy go.
do $$
declare v jsonb;
begin
	perform pg_temp.base_commit(pg_temp.base_owner(), 'logo-0002', jsonb_build_array(jsonb_build_object(
		'op', 'write', 'path', 'QorperaOS/brand/logo.png', 'file', pg_temp.base_stage('second logo'),
		'expectedVersion', pg_temp.base_version('QorperaOS/brand/logo.png'))));
	perform pg_temp.logo_as('92400000-0000-4000-8000-000000000004');
	select public.qorpera_company_logos(array['92400000-0000-4000-8000-000000000010'::uuid]) into v;
	if v -> 0 ->> 'source_sha256' <> encode(extensions.digest(convert_to('second logo', 'utf8'), 'sha256'), 'hex')
		or v -> 0 ->> 'object_name' not like '%' || current_setting('qorpera_test.logo_sha') || '.png' then
		raise exception 'the admin does not see that the copy is behind: %', v;
	end if;
	perform pg_temp.logo_back();
	perform pg_temp.base_commit(pg_temp.base_owner(), 'logo-0003', jsonb_build_array(jsonb_build_object(
		'op', 'delete', 'path', 'QorperaOS/brand/logo.png', 'expectedVersion', pg_temp.base_version('QorperaOS/brand/logo.png'))));
	perform pg_temp.logo_as('92400000-0000-4000-8000-000000000004');
	select public.qorpera_publish_company_logo('92400000-0000-4000-8000-000000000010', null) into v;
	if v ->> 'object_name' is not null or v ->> 'previous_object_name' is null then
		raise exception 'the copy did not go with the folder logo: %', v;
	end if;
	perform pg_temp.logo_back();
end
$$;

rollback;
