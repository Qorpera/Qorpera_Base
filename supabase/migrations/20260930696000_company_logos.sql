-- A company's logo (Jonas, 9 Nov 2026; CLIENT-CONTRACT.md request 10).
--
-- The official logo is a file in the company folder, QorperaOS/brand/logo.png: the company's Branding & Identity
-- agent makes and updates it, and an owner or admin can choose another in Settings → Company, the way a member
-- chooses their own picture. The folder is the one source of truth; agents and people edit the same file.
--
-- People outside the company see the logo too: a friend on the leaderboard, someone invited to join. They cannot
-- read the company folder, so a copy of the current logo sits in a private bucket, as <profile UUID>/<sha256>.png,
-- the way member pictures do (20260924150000). A member of the company keeps the copy current: their app uploads
-- the folder's logo and publishes it, and publishing accepts only a copy whose name carries the sha256 of the
-- folder's current logo file. Who sees the copy is decided here: the company's members, anyone with an open
-- invitation to it, and the accepted friends of its members. Everyone else keeps the company's figure.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('qorpera-company-logos', 'qorpera-company-logos', false, 1048576, array['image/png'])
on conflict (id) do update
set public = false,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

create table public.qorpera_company_logos (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	object_name text not null check (
		object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
		and split_part(object_name, '/', 1) = profile_id::text
	),
	updated_at timestamptz not null default statement_timestamp(),
	published_by_user_id uuid references auth.users(id) on delete set null
);

create unique index qorpera_company_logos_object_name on public.qorpera_company_logos (object_name);

alter table public.qorpera_company_logos enable row level security;
revoke all on public.qorpera_company_logos from public, anon, authenticated;

-- The folder path of the official logo, and the sha256 of the logo file the company's folder holds now (null when it
-- holds none).
create function public.qorpera_company_logo_source(p_profile_id uuid)
returns table (file_sha256 text, bytes bigint, media_type text)
language sql
stable
security definer
set search_path = ''
as $$
	select entry.file_sha256, entry.bytes, entry.media_type
	from public.qorpera_company_environments environment
	join public.qorpera_folder_entries entry
		on entry.environment_id = environment.id
		and entry.key_sha256 = extensions.digest(public.qorpera_folder_key('QorperaOS/brand/logo.png'), 'sha256')
	where environment.profile_id = p_profile_id
		and entry.kind = 'file'
	order by entry.updated_at desc
	limit 1
$$;

-- Whether the caller sees this company's logo: a member, an open invitation to the caller's confirmed address, or an
-- accepted friend of one of its members.
create function public.qorpera_can_see_company_logo(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.uid() is not null
		and p_profile_id is not null
		and (
			exists (
				select 1 from public.qorpera_profile_members member
				where member.profile_id = p_profile_id and member.user_id = auth.uid()
			)
			or exists (
				select 1
				from public.qorpera_profile_invitations invitation
				join auth.users account on account.id = auth.uid()
				where invitation.profile_id = p_profile_id
					and invitation.email = lower(account.email)
					and account.email_confirmed_at is not null
					and invitation.expires_at > statement_timestamp()
			)
			or exists (
				select 1
				from public.qorpera_profile_members member
				join public.qorpera_friendships friendship
					on friendship.user_low = least(auth.uid(), member.user_id)
					and friendship.user_high = greatest(auth.uid(), member.user_id)
				where member.profile_id = p_profile_id
					and friendship.status = 'accepted'
			)
		)
$$;

-- Whether the caller may keep the copy current: a member who may write the company's folder.
create function public.qorpera_can_publish_company_logo(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.uid() is not null and exists (
		select 1 from public.qorpera_profile_members member
		where member.profile_id = p_profile_id and member.user_id = auth.uid() and member.role <> 'viewer'
	)
$$;

-- What a caller may read in the bucket: a company's current copy when they see its logo, and anything in the folder
-- of a company whose copy they may keep current (an upload on its way to being published).
create function public.qorpera_can_read_company_logo(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.uid() is not null
		and (
			public.qorpera_can_publish_company_logo(split_part(p_object_name, '/', 1)::uuid)
			or exists (
				select 1 from public.qorpera_company_logos logo
				where logo.object_name = p_object_name and public.qorpera_can_see_company_logo(logo.profile_id)
			)
		)
$$;

-- How many objects a company's folder in the bucket holds; uploads stop at four, as member pictures do. The lock
-- makes parallel uploads count one after another.
create function public.qorpera_company_logo_objects(p_profile_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_count integer;
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-logos:' || p_profile_id::text, 0));
	select count(*)::integer into v_count
	from storage.objects
	where bucket_id = 'qorpera-company-logos' and name like p_profile_id::text || '/%';
	return v_count;
end
$$;

-- Whether an object is a company's current copy, which nobody deletes until another copy (or none) has taken its
-- place. It takes the lock publishing takes.
create function public.qorpera_is_current_company_logo(p_object_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-logos:' || split_part(p_object_name, '/', 1), 0));
	return exists (select 1 from public.qorpera_company_logos where object_name = p_object_name);
end
$$;

-- The CASE keeps the UUID cast behind the name check: a policy's AND gives no evaluation order.
create policy qorpera_company_logos_insert
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'qorpera-company-logos'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
				then public.qorpera_can_publish_company_logo((storage.foldername(name))[1]::uuid)
					and public.qorpera_company_logo_objects((storage.foldername(name))[1]::uuid) < 4
			else false
		end
	);

create policy qorpera_company_logos_read
	on storage.objects
	for select
	to authenticated
	using (
		bucket_id = 'qorpera-company-logos'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
				then public.qorpera_can_read_company_logo(name)
			else false
		end
	);

create policy qorpera_company_logos_delete
	on storage.objects
	for delete
	to authenticated
	using (
		bucket_id = 'qorpera-company-logos'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
				then public.qorpera_can_publish_company_logo((storage.foldername(name))[1]::uuid)
					and not public.qorpera_is_current_company_logo(name)
			else false
		end
	);

-- The four-object limit where Storage writes the row (the insert policy runs only in Storage's preflight).
create function public.qorpera_guard_company_logo_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_folder text := split_part(new.name, '/', 1);
	v_count integer;
begin
	if new.bucket_id <> 'qorpera-company-logos'
		or new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
	then
		return new;
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-logos:' || v_folder, 0));
	select count(*)::integer into v_count
	from storage.objects
	where bucket_id = 'qorpera-company-logos'
		and left(name, 37) = v_folder || '/'
		and name <> new.name
		and not (tg_op = 'UPDATE' and old.bucket_id = 'qorpera-company-logos' and name = old.name);
	if v_count >= 4 then
		raise exception 'a company logo folder holds four objects at most' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_guard_company_logo_insert
before insert or update of bucket_id, name on storage.objects
for each row execute function public.qorpera_guard_company_logo_insert();

-- The logos the caller may see among the given companies. For a company the caller may keep current, also the
-- folder's logo file (`source_sha256`, null when the folder has none), so the app knows when its copy is behind.
create function public.qorpera_company_logos(p_profile_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_result jsonb;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if coalesce(cardinality(p_profile_ids), 0) > 200 then
		raise exception 'ask for at most 200 logos at a time' using errcode = '22023';
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'profile_id', company.id,
		'object_name', logo.object_name,
		'updated_at', logo.updated_at,
		'publisher', public.qorpera_can_publish_company_logo(company.id),
		'source_sha256', case when public.qorpera_can_publish_company_logo(company.id)
			then (select source.file_sha256 from public.qorpera_company_logo_source(company.id) source) end,
		'source_bytes', case when public.qorpera_can_publish_company_logo(company.id)
			then (select source.bytes from public.qorpera_company_logo_source(company.id) source) end
	) order by company.id), '[]'::jsonb)
	into v_result
	from public.qorpera_profiles company
	left join public.qorpera_company_logos logo on logo.profile_id = company.id
	where company.id = any(coalesce(p_profile_ids, array[]::uuid[]))
		and public.qorpera_can_see_company_logo(company.id)
		and (logo.object_name is not null or public.qorpera_can_publish_company_logo(company.id));
	return v_result;
end
$$;

-- Makes the uploaded copy the company's logo copy, or takes the copy away (`p_object_name` null) once the folder holds
-- no logo. The copy's name must carry the sha256 of the folder's current QorperaOS/brand/logo.png. Returns the copy it
-- replaced, which the caller then deletes.
create function public.qorpera_publish_company_logo(p_profile_id uuid, p_object_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_source text;
	v_previous text;
	v_updated_at timestamptz;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_profile_id is null or not public.qorpera_can_publish_company_logo(p_profile_id) then
		raise exception 'only a member who may write the company folder publishes its logo' using errcode = '42501';
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-company-logos:' || p_profile_id::text, 0));
	select source.file_sha256 into v_source from public.qorpera_company_logo_source(p_profile_id) source;
	select object_name into v_previous from public.qorpera_company_logos where profile_id = p_profile_id for update;
	if p_object_name is null then
		if v_source is not null then
			raise exception 'the company folder still holds a logo' using errcode = '22023';
		end if;
		delete from public.qorpera_company_logos where profile_id = p_profile_id;
		return jsonb_build_object('object_name', null, 'previous_object_name', v_previous);
	end if;
	if p_object_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.png$'
		or split_part(p_object_name, '/', 1) <> p_profile_id::text
	then
		raise exception 'a logo copy is named <company>/<sha256>.png' using errcode = '22023';
	end if;
	if v_source is null or split_part(split_part(p_object_name, '/', 2), '.', 1) <> v_source then
		raise exception 'the copy is not the company folder''s current logo' using errcode = '22023';
	end if;
	if not exists (select 1 from storage.objects where bucket_id = 'qorpera-company-logos' and name = p_object_name) then
		raise exception 'upload the copy before publishing it' using errcode = 'P0002';
	end if;
	insert into public.qorpera_company_logos (profile_id, object_name, published_by_user_id)
	values (p_profile_id, p_object_name, v_actor)
	on conflict (profile_id) do update
	set object_name = excluded.object_name,
		published_by_user_id = excluded.published_by_user_id,
		updated_at = statement_timestamp()
	returning updated_at into v_updated_at;
	return jsonb_build_object(
		'object_name', p_object_name,
		'updated_at', v_updated_at,
		'previous_object_name', case when v_previous = p_object_name then null else v_previous end
	);
end
$$;

revoke all on function public.qorpera_company_logo_source(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_can_see_company_logo(uuid) from public, anon;
revoke all on function public.qorpera_can_publish_company_logo(uuid) from public, anon;
revoke all on function public.qorpera_can_read_company_logo(text) from public, anon;
revoke all on function public.qorpera_company_logo_objects(uuid) from public, anon;
revoke all on function public.qorpera_is_current_company_logo(text) from public, anon;
revoke all on function public.qorpera_guard_company_logo_insert() from public, anon, authenticated, service_role;
revoke all on function public.qorpera_company_logos(uuid[]) from public, anon;
revoke all on function public.qorpera_publish_company_logo(uuid, text) from public, anon;
-- The four below run inside the bucket's policies, which evaluate as the member.
grant execute on function public.qorpera_can_see_company_logo(uuid) to authenticated;
grant execute on function public.qorpera_can_publish_company_logo(uuid) to authenticated;
grant execute on function public.qorpera_can_read_company_logo(text) to authenticated;
grant execute on function public.qorpera_company_logo_objects(uuid) to authenticated;
grant execute on function public.qorpera_is_current_company_logo(text) to authenticated;
grant execute on function public.qorpera_company_logos(uuid[]) to authenticated;
grant execute on function public.qorpera_publish_company_logo(uuid, text) to authenticated;
