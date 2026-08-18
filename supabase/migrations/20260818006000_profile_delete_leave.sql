-- Owner-deletes and member-leaves for hosted profiles.
--
-- qorpera_remove_profile_member has refused self-removal since 20260816001000
-- with "use the leave-profile action" -- an action that never existed. The
-- hub consequently had no server-side way for a member to walk away from a
-- shared company, and no way for an owner to destroy a profile at all;
-- machine-local hiding (0.20.1) treated the symptom. These are the real
-- operations.

create function public.qorpera_leave_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
begin
	if v_actor_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select member.role into v_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if v_role = 'owner' then
		-- Leaving would orphan the profile; owners delete instead. The same
		-- rule qorpera_remove_profile_member applies from the other side.
		raise exception 'the owner cannot leave; delete the profile instead' using errcode = '42501';
	end if;
	delete from public.qorpera_profile_members
	where profile_id = p_profile_id and user_id = v_actor_id;
	return 'true'::jsonb;
end
$$;

create function public.qorpera_delete_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
begin
	if v_actor_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	select member.role into v_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id;
	if v_role is distinct from 'owner' then
		raise exception 'deleting a profile requires the owner' using errcode = '42501';
	end if;
	-- Everything profile-scoped cascades from this row: members, invitations,
	-- environments, sessions, workspaces, snapshots, artifacts, reachability,
	-- runner state. Storage objects are content-addressed under the profile
	-- prefix and are not reachable from SQL; they become unreferenced bytes
	-- for storage-side cleanup, exactly as the artifact GC treats them.
	delete from public.qorpera_profiles where id = p_profile_id;
	if not found then
		raise exception 'profile was not found' using errcode = 'P0002';
	end if;
	return 'true'::jsonb;
end
$$;

revoke all on function public.qorpera_leave_hosted_profile(uuid) from public, anon;
revoke all on function public.qorpera_delete_hosted_profile(uuid) from public, anon;
grant execute on function public.qorpera_leave_hosted_profile(uuid) to authenticated;
grant execute on function public.qorpera_delete_hosted_profile(uuid) to authenticated;
