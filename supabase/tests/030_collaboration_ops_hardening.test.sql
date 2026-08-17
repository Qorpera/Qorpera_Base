begin;

insert into auth.users (id, email, email_confirmed_at)
values
	('50000000-0000-4000-8000-000000000001', 'owner@example.test', statement_timestamp()),
	('50000000-0000-4000-8000-000000000002', 'invitee@example.test', null),
	('50000000-0000-4000-8000-000000000003', 'cascade@example.test', statement_timestamp());

insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('50000000-0000-4000-8000-000000000010', 'Invitation profile', '50000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	'50000000-0000-4000-8000-000000000010',
	'50000000-0000-4000-8000-000000000001',
	'owner@example.test',
	'Owner',
	'owner'
);

insert into public.qorpera_company_environments (id, profile_id, name, contract_version, created_by_user_id)
values (
	'50000000-0000-4000-8000-000000000011',
	'50000000-0000-4000-8000-000000000010',
	'Primary',
	1,
	'50000000-0000-4000-8000-000000000001'
);

insert into public.qorpera_profile_invitations (id, profile_id, email, role, invited_by_user_id, expires_at)
values (
	'50000000-0000-4000-8000-000000000012',
	'50000000-0000-4000-8000-000000000010',
	'invitee@example.test',
	'contributor',
	'50000000-0000-4000-8000-000000000001',
	statement_timestamp() + interval '1 day'
);

select set_config(
	'request.jwt.claims',
	'{"sub":"50000000-0000-4000-8000-000000000002","email":"invitee@example.test","role":"authenticated","user_metadata":{"full_name":"Invitee"}}',
	true
);

do $$
declare
	v_rejected boolean := false;
begin
	if jsonb_array_length(public.qorpera_list_profile_invitations()) <> 0 then
		raise exception 'unverified account could list invitations';
	end if;
	begin
		perform public.qorpera_decline_profile_invitation('50000000-0000-4000-8000-000000000012');
	exception when sqlstate '42501' then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'unverified account could decline an invitation';
	end if;
	v_rejected := false;
	begin
		perform public.qorpera_accept_profile_invitation('50000000-0000-4000-8000-000000000012');
	exception when sqlstate '42501' then
		v_rejected := true;
	end;
	if not v_rejected then
		raise exception 'unverified account could accept an invitation';
	end if;
end
$$;

update auth.users
set email_confirmed_at = statement_timestamp()
where id = '50000000-0000-4000-8000-000000000002';

do $$
begin
	if jsonb_array_length(public.qorpera_list_profile_invitations()) <> 1 then
		raise exception 'verified account could not list its invitation';
	end if;
	if public.qorpera_accept_profile_invitation('50000000-0000-4000-8000-000000000012') <> 'true'::jsonb then
		raise exception 'verified account could not accept its invitation';
	end if;
	if not exists (
		select 1
		from public.qorpera_profile_members
		where profile_id = '50000000-0000-4000-8000-000000000010'
			and user_id = '50000000-0000-4000-8000-000000000002'
			and role = 'contributor'
	) then
		raise exception 'invitation acceptance did not create the member';
	end if;
end
$$;

delete from public.qorpera_profile_members
where profile_id = '50000000-0000-4000-8000-000000000010'
	and user_id = '50000000-0000-4000-8000-000000000002';

do $$
begin
	if not exists (
		select 1
		from public.qorpera_profile_access_state
		where profile_id = '50000000-0000-4000-8000-000000000010'
			and user_id = '50000000-0000-4000-8000-000000000002'
			and status = 'revoked'
			and role is null
	) then
		raise exception 'direct member removal did not project revocation';
	end if;
end
$$;

insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('50000000-0000-4000-8000-000000000020', 'Profile cascade', '50000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	'50000000-0000-4000-8000-000000000020',
	'50000000-0000-4000-8000-000000000003',
	'cascade@example.test',
	'Cascade member',
	'contributor'
);

delete from public.qorpera_profiles where id = '50000000-0000-4000-8000-000000000020';

do $$
begin
	if exists (
		select 1 from public.qorpera_profile_access_state
		where profile_id = '50000000-0000-4000-8000-000000000020'
	) then
		raise exception 'profile cascade retained access projection';
	end if;
end
$$;

insert into public.qorpera_profiles (id, name, created_by_user_id)
values ('50000000-0000-4000-8000-000000000030', 'User cascade', '50000000-0000-4000-8000-000000000001');

insert into public.qorpera_profile_members (profile_id, user_id, email, display_name, role)
values (
	'50000000-0000-4000-8000-000000000030',
	'50000000-0000-4000-8000-000000000003',
	'cascade@example.test',
	'Cascade member',
	'contributor'
);

delete from auth.users where id = '50000000-0000-4000-8000-000000000003';

do $$
begin
	if exists (
		select 1 from public.qorpera_profile_access_state
		where user_id = '50000000-0000-4000-8000-000000000003'
	) then
		raise exception 'Auth-user cascade retained access projection';
	end if;
end
$$;

rollback;
