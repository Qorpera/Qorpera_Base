-- Membership before the company fence. Thirteen functions a signed-in member calls looked up a company from their
-- argument (an environment, a computer's scope or id, a compute identity, a recovery, a room, or the company) and took
-- its gc fence (qorpera_lock_profile_gc_fence: the company's profile row FOR UPDATE, then its wake admission fence row)
-- before they checked that the caller belongs to that company. Anyone signed in who knew or guessed such an id could
-- hold another company's fence for the length of the call, and by repeating the call make that company's writers,
-- wakes, runs and cleanup wait.
--
-- Each now reads the caller's membership first, without a lock, and refuses before the fence a caller the function
-- would refuse for membership (outside the company, or without the role or room membership it asks), with the error
-- such a caller gets today, so a refusal tells no more than before. Where a computer's scope was checked before
-- membership, such a caller gets that check first here too. A member passes as before: everything after the fence is
-- unchanged, and the locked membership checks still refuse a member removed while the call waited for the fence.
-- Two refusals change, both to the one a caller outside the company already gets: posting to a room that does not
-- exist (was the fence's 'profile is unavailable') and reading recovery for a company that does not exist (same).
--
-- Exact-text patches: each fails unless its function takes the fence once, on the line given.

create function pg_temp.member_auth_first_patch(p_function regprocedure, p_fence text, p_check text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_fence, ''))) / length(p_fence) <> 1 then
		raise exception '% does not take the company fence where this migration expects', p_function; end if;
	execute replace(v_definition, p_fence, p_check || p_fence);
end
$patch$;

-- The member office catalog.
select pg_temp.member_auth_first_patch('public.qorpera_member_office_catalog(uuid,uuid)',
	$fence$ perform public.qorpera_lock_profile_gc_fence(v_company);$fence$,
	$check$ if not exists(select 1 from public.qorpera_profile_members where profile_id=v_company and user_id=auth.uid()) then
  raise exception 'Company unavailable' using errcode='42501'; end if;
$check$);

-- Registering the company's first computer: owners and admins.
select pg_temp.member_auth_first_patch('public.qorpera_register_runtime_office(uuid,uuid,text,text,integer)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_profile);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=v_profile
		and user_id=auth.uid() and role in ('owner','admin')) then
		raise exception 'Shared office registration is unavailable' using errcode='42501';
	end if;
$check$);

-- An agent's access to a computer: owners and admins (qorpera_configure_runtime_office_access calls both).
select pg_temp.member_auth_first_patch('public.qorpera_runtime_office_access_status(jsonb,uuid)',
	$fence$ perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);$fence$,
	$check$ if not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
   and user_id=auth.uid() and role in ('owner','admin')) then
  raise exception 'Office grant administration unavailable' using errcode='42501'; end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_set_runtime_office_access(uuid,uuid,bigint,boolean)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id
		and user_id=auth.uid() and role in ('owner','admin')) then
		raise exception 'Shared office grant is unavailable' using errcode='42501';
	end if;
$check$);

-- A computer's start: its status (members), a start or wake (a caller outside the company got the refusal of the
-- branch the computer's state picks), a cancellation (owners and admins, while it starts), and withdrawing a wake,
-- which asks no membership: someone outside the company with no wake request of their own on this computer's current
-- cycle has nothing to withdraw. Only a caller refused here meets the scope checks before the fence; a member's call
-- runs them under the fence, as before.
select pg_temp.member_auth_first_patch('public.qorpera_runtime_office_start_status(jsonb)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()) then
		if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) then
			raise exception 'Office start scope differs' using errcode='42501'; end if;
		raise exception 'Office start status requires membership' using errcode='42501';
	end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_request_runtime_office_start(jsonb,bigint,uuid)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(o.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=o.profile_id and user_id=auth.uid()) then
		if p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation is distinct from p_computer_generation then
			raise exception 'Office start scope differs' using errcode='42501'; end if;
		if public.qorpera_runtime_office_idle_pending(o) or o.state='active' then
			raise exception 'Office wake unavailable' using errcode='42501'; end if;
		raise exception 'Office start requires founder authority' using errcode='42501';
	end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_cancel_runtime_office_start(jsonb,bigint,uuid)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_office.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=v_office.profile_id and user_id=auth.uid()
		and role in ('owner','admin')) then
		if p_scope is distinct from public.qorpera_runtime_office_scope(v_office) or v_office.generation<>p_computer_generation
			or v_office.state not in ('provisioning','recovering') then
			raise exception 'Office start cancellation differs' using errcode='42501'; end if;
		raise exception 'Office start cancellation requires founder authority' using errcode='42501';
	end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_withdraw_runtime_office_wake(jsonb,bigint,uuid)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(o.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id=o.profile_id and user_id=auth.uid())
		and not exists(select 1 from public.qorpera_runtime_office_wake_requests r
			join public.qorpera_runtime_office_idle_cycles c on c.transition_id=r.transition_id
			where c.office_id=o.id and c.computer_generation=o.generation and c.superseded_at is null
				and r.user_id=auth.uid() and r.request_id=p_request_id) then
		if p_scope is distinct from public.qorpera_runtime_office_scope(o) or o.generation is distinct from p_computer_generation then
			raise exception 'Office start scope differs' using errcode='42501'; end if;
		return '{"state":"unavailable"}'::jsonb;
	end if;
$check$);

-- Recovering a compute identity: requesting it (owners), cancelling it (owners and the identity's member), the member's
-- consent, and the helper behind listing, reviewing and deciding recoveries (members).
select pg_temp.member_auth_first_patch('public.qorpera_request_identity_recovery(uuid,uuid,uuid,bigint,text,text)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_identity.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members where profile_id = v_identity.profile_id
		and user_id = v_user and role = 'owner') then
		raise exception 'recovery requires a current company owner' using errcode = '42501'; end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_cancel_identity_recovery(uuid)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_profile_members member where member.profile_id = v_recovery.profile_id
		and member.user_id = auth.uid() and (member.role = 'owner' or member.user_id = (select identity.owner_user_id
			from public.qorpera_member_compute_identities identity where identity.id = v_recovery.compute_identity_id))) then
		raise exception 'recovery cancellation is unavailable' using errcode = '42501'; end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_consent_identity_recovery(uuid)',
	$fence$	perform public.qorpera_lock_profile_gc_fence(v_recovery.profile_id);$fence$,
	$check$	if not exists(select 1 from public.qorpera_member_compute_identities identity
		join public.qorpera_profile_members member on member.profile_id = identity.profile_id and member.user_id = auth.uid()
		where identity.id = v_recovery.compute_identity_id and identity.ownership_kind = 'member'
			and identity.owner_user_id = auth.uid()) then
		raise exception 'recovery member consent is unavailable' using errcode = '42501'; end if;
$check$);
select pg_temp.member_auth_first_patch('public.qorpera_recovery_member_role(uuid)',
	$fence$  perform public.qorpera_lock_profile_gc_fence(p_company_id);$fence$,
	$check$  if not exists(select 1 from public.qorpera_profile_members where profile_id=p_company_id and user_id=auth.uid()) then
    raise exception 'Recovery membership is unavailable' using errcode='42501'; end if;
$check$);

-- Posting in a room: members of the company who are active members of the room.
select pg_temp.member_auth_first_patch('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)',
	$fence$	perform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_company_rooms where id=p_room_id));$fence$,
	$check$	if not exists (select 1 from public.qorpera_company_rooms room
		join public.qorpera_profile_members member on member.profile_id = room.profile_id and member.user_id = v_user
		join public.qorpera_company_room_members room_member on room_member.room_id = room.id
			and room_member.principal_kind = 'member' and room_member.principal_id = v_user and room_member.status = 'active'
		where room.id = p_room_id) then
		raise exception 'Room is unavailable' using errcode = '42501'; end if;
$check$);

drop function pg_temp.member_auth_first_patch(regprocedure, text, text);
