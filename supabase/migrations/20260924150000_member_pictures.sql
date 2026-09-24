-- Member pictures: the photo a member chooses for their account.
--
-- A picture belongs to the account, not to a company membership, so it
-- follows the member into every company and shows before they join one. The
-- bytes live in a private bucket as <user UUID>/<sha256>.<ext>: the member
-- uploads into their own folder only (a few objects at most), and a name is
-- immutable, so a new picture is a new object and the old one is removed by its
-- owner. Who sees a picture is decided here, never by the client: the member,
-- anyone who shares a company with them, their friends, and anyone they sent a
-- friend request to (a request received is no consent to be seen). Others read
-- only the current picture, never what else lies in the folder. The web app
-- downloads pictures with the member's token; the page's image policy only
-- admits blob: and data: sources, so no picture URL ever leaves this project.
--
-- `qorpera_profile_members.avatar_url` (copied from an OAuth provider's
-- metadata at join time) is left as it is; this table is the member's choice.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
	'qorpera-member-pictures',
	'qorpera-member-pictures',
	false,
	524288,
	array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set public = false,
	file_size_limit = excluded.file_size_limit,
	allowed_mime_types = excluded.allowed_mime_types;

create table public.qorpera_member_pictures (
	user_id uuid primary key references auth.users(id) on delete cascade,
	object_name text not null check (
		object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
		and split_part(object_name, '/', 1) = user_id::text
	),
	updated_at timestamptz not null default statement_timestamp()
);

create unique index qorpera_member_pictures_object_name on public.qorpera_member_pictures (object_name);

alter table public.qorpera_member_pictures enable row level security;
revoke all on public.qorpera_member_pictures from anon, authenticated;

create function public.qorpera_can_see_member_picture(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.uid() is not null
		and p_user_id is not null
		and (
			p_user_id = auth.uid()
			or exists (
				select 1
				from public.qorpera_profile_members mine
				join public.qorpera_profile_members theirs on theirs.profile_id = mine.profile_id
				where mine.user_id = auth.uid() and theirs.user_id = p_user_id
			)
			or exists (
				select 1
				from public.qorpera_friendships friendship
				where friendship.user_low = least(auth.uid(), p_user_id)
					and friendship.user_high = greatest(auth.uid(), p_user_id)
					and (friendship.status = 'accepted' or friendship.requested_by = p_user_id)
			)
		)
$$;

-- What a member may read in the bucket: anything in their own folder, and
-- another member's current picture when they may see that member.
create function public.qorpera_can_read_member_picture(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select auth.uid() is not null
		and (
			split_part(p_object_name, '/', 1) = auth.uid()::text
			or exists (
				select 1
				from public.qorpera_member_pictures picture
				where picture.object_name = p_object_name
					and public.qorpera_can_see_member_picture(picture.user_id)
			)
		)
$$;

-- How many objects the caller's own folder holds; the upload policy refuses a
-- fifth early, in Storage's preflight, before any bytes are sent. The trigger
-- below is what enforces the limit on the final write. The lock makes parallel
-- checks count one after another (volatile: each count sees what the uploads
-- before it committed).
create function public.qorpera_member_picture_objects()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_count integer;
begin
	if v_actor is null then
		return 0;
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-member-pictures:' || v_actor::text, 0));
	select count(*)::integer into v_count
	from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name like v_actor::text || '/%';
	return v_count;
end
$$;

-- Whether an object is the caller's current picture, which they cannot delete
-- until another picture (or none) has taken its place. It takes the folder lock
-- qorpera_set_member_picture takes, so a delete and a choice of the same object
-- happen one after the other, never across each other.
create function public.qorpera_is_current_member_picture(p_object_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
begin
	if v_actor is null then
		return false;
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-member-pictures:' || v_actor::text, 0));
	return exists (
		select 1 from public.qorpera_member_pictures
		where user_id = v_actor and object_name = p_object_name
	);
end
$$;

-- The caller's own folder, for tidying uploads that never became the picture.
-- A storage list() would run the bucket's read policy over every member's
-- objects; this reads one folder.
create function public.qorpera_own_member_picture_objects()
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
	-- The age is the cloud's, so no device clock decides what is old.
	select coalesce(jsonb_agg(jsonb_build_object(
		'object_name', object.name,
		'created_at', object.created_at,
		'age_seconds', greatest(0, floor(extract(epoch from statement_timestamp() - object.created_at)))::bigint
	) order by object.created_at, object.name), '[]'::jsonb)
	into v_result
	from storage.objects object
	where object.bucket_id = 'qorpera-member-pictures'
		and object.name like v_actor::text || '/%';
	return v_result;
end
$$;

-- The CASE keeps the UUID cast behind the name check: a policy's AND gives no
-- evaluation order, and a malformed name must be refused, not raise.
create policy qorpera_member_pictures_insert
	on storage.objects
	for insert
	to authenticated
	with check (
		bucket_id = 'qorpera-member-pictures'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
				then (storage.foldername(name))[1] = auth.uid()::text
					and public.qorpera_member_picture_objects() < 4
			else false
		end
	);

create policy qorpera_member_pictures_read
	on storage.objects
	for select
	to authenticated
	using (
		bucket_id = 'qorpera-member-pictures'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
				then public.qorpera_can_read_member_picture(name)
			else false
		end
	);

create policy qorpera_member_pictures_delete
	on storage.objects
	for delete
	to authenticated
	using (
		bucket_id = 'qorpera-member-pictures'
		and case
			when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
				then (storage.foldername(name))[1] = auth.uid()::text
					and not public.qorpera_is_current_member_picture(name)
			else false
		end
	);

-- The four-object limit where Storage writes the row. The upload policy above
-- only runs in Storage's permission preflight (inserted and rolled back); the
-- final row is written later by the storage service, past row security. Here
-- both are counted, and parallel uploads into one folder wait for each other.
create function public.qorpera_guard_member_picture_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_folder text := split_part(new.name, '/', 1);
	v_count integer;
begin
	if new.bucket_id <> 'qorpera-member-pictures' then
		return new;
	end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera-member-pictures:' || v_folder, 0));
	select count(*)::integer into v_count
	from storage.objects
	where bucket_id = 'qorpera-member-pictures'
		and name like v_folder || '/%'
		and name <> new.name;
	if v_count >= 4 then
		raise exception 'a member picture folder holds four objects at most' using errcode = '42501';
	end if;
	return new;
end
$$;

create trigger qorpera_guard_member_picture_insert
before insert on storage.objects
for each row execute function public.qorpera_guard_member_picture_insert();

-- The pictures the caller may see among the given accounts. Accounts without a
-- picture, or whose picture the caller may not see, are simply absent.
create function public.qorpera_member_pictures(p_user_ids uuid[])
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
	if coalesce(cardinality(p_user_ids), 0) > 200 then
		raise exception 'ask for at most 200 pictures at a time' using errcode = '22023';
	end if;
	select coalesce(jsonb_agg(jsonb_build_object(
		'user_id', picture.user_id,
		'object_name', picture.object_name,
		'updated_at', picture.updated_at
	) order by picture.user_id), '[]'::jsonb)
	into v_result
	from public.qorpera_member_pictures picture
	where picture.user_id = any(coalesce(p_user_ids, array[]::uuid[]))
		and public.qorpera_can_see_member_picture(picture.user_id);
	return v_result;
end
$$;

-- Makes an object the caller uploaded into their own folder their picture.
-- Returns the picture it replaced, which the caller then deletes.
create function public.qorpera_set_member_picture(p_object_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_previous text;
	v_updated_at timestamptz;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if p_object_name is null
		or p_object_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}\.(webp|jpg|png)$'
	then
		raise exception 'a picture is named <account>/<sha256>.webp, .jpg or .png' using errcode = '22023';
	end if;
	if split_part(p_object_name, '/', 1) <> v_actor::text then
		raise exception 'a picture must be uploaded into your own folder' using errcode = '42501';
	end if;
	-- The folder lock the delete policy takes: the object cannot vanish between
	-- this check and the commit.
	perform pg_advisory_xact_lock(hashtextextended('qorpera-member-pictures:' || v_actor::text, 0));
	if not exists (
		select 1 from storage.objects
		where bucket_id = 'qorpera-member-pictures' and name = p_object_name
	) then
		raise exception 'upload the picture before choosing it' using errcode = 'P0002';
	end if;
	select object_name into v_previous
	from public.qorpera_member_pictures
	where user_id = v_actor
	for update;
	insert into public.qorpera_member_pictures (user_id, object_name)
	values (v_actor, p_object_name)
	on conflict (user_id) do update
	set object_name = excluded.object_name,
		updated_at = statement_timestamp()
	returning updated_at into v_updated_at;
	return jsonb_build_object(
		'object_name', p_object_name,
		'updated_at', v_updated_at,
		'previous_object_name', case when v_previous = p_object_name then null else v_previous end
	);
end
$$;

-- Goes back to initials. Returns the removed picture, which the caller deletes.
create function public.qorpera_clear_member_picture()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := auth.uid();
	v_previous text;
begin
	if v_actor is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	delete from public.qorpera_member_pictures
	where user_id = v_actor
	returning object_name into v_previous;
	return jsonb_build_object('previous_object_name', v_previous);
end
$$;

revoke all on function public.qorpera_can_see_member_picture(uuid) from public, anon;
revoke all on function public.qorpera_can_read_member_picture(text) from public, anon;
revoke all on function public.qorpera_member_picture_objects() from public, anon;
revoke all on function public.qorpera_is_current_member_picture(text) from public, anon;
revoke all on function public.qorpera_own_member_picture_objects() from public, anon;
revoke all on function public.qorpera_guard_member_picture_insert() from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_pictures(uuid[]) from public, anon;
revoke all on function public.qorpera_set_member_picture(text) from public, anon;
revoke all on function public.qorpera_clear_member_picture() from public, anon;
grant execute on function public.qorpera_can_see_member_picture(uuid) to authenticated;
-- Both run inside the bucket's policies, which evaluate as the member.
grant execute on function public.qorpera_can_read_member_picture(text) to authenticated;
grant execute on function public.qorpera_member_picture_objects() to authenticated;
grant execute on function public.qorpera_is_current_member_picture(text) to authenticated;
grant execute on function public.qorpera_own_member_picture_objects() to authenticated;
grant execute on function public.qorpera_member_pictures(uuid[]) to authenticated;
grant execute on function public.qorpera_set_member_picture(text) to authenticated;
grant execute on function public.qorpera_clear_member_picture() to authenticated;
