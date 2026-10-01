-- Several founders per company (28 Sep 2026, "Company Founders", approved as recommended; piece 1
-- of the #326 rebuild). A company member with the role 'owner' is a founder. Until now a unique
-- index allowed exactly one, the creator, who could not leave and could delete the company for
-- everyone.
--
-- The rules (Jonas):
-- * A company has one or more founders; any founder can make another member a founder, and a
--   founder can step down to a lower role on their own.
-- * Only the last member can delete the company. Everyone else leaves.
-- * Founders remove members. A founder cannot remove or demote a fellow founder; founders step
--   down or leave on their own.
-- * The last founder cannot step down, and cannot leave while other members remain.
-- * While company setup runs for a founder (its job is queued or leased), that founder neither
--   leaves nor steps down.
-- * Admins keep what they could do: invite, and remove or change contributors and viewers. Only
--   founders manage admins and founders.
--
-- One guard trigger on qorpera_profile_members holds the founder rule for every path (RPCs,
-- service code, the founding lobby's Start, auth cascades). Only a founder leaving or stepping
-- down takes locks there: the company row, then the other founders' rows. The RPCs below take
-- the company row before any member row, so founder changes serialize on the company row in the
-- same order as qorpera_lock_profile_gc_fence. A company being deleted takes its members with it.
--
-- qorpera_company_founders gives one stable founder list per company (the creator first while a
-- founder, then by joining time) for computer-hours billing and for the places that need "the"
-- founder (default agent access, a new member's agent threads, company setup, the plan).
-- Membership rows are member data and stay in the database (contract 5.6).

-- Membership is read by nearly every permission check: never queue them behind this migration.
set local lock_timeout = '3s';

drop index public.qorpera_profile_one_owner;

create function public.qorpera_company_founders(p_profile_id uuid)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
	select member.user_id
	from public.qorpera_profile_members as member
	join public.qorpera_profiles as profile on profile.id = member.profile_id
	where member.profile_id = p_profile_id and member.role = 'owner'
	order by (member.user_id = profile.created_by_user_id) desc, member.joined_at, member.user_id
$$;
revoke all on function public.qorpera_company_founders(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_company_founders(uuid) to service_role;

-- The first founder in that order stands for the company where one member is needed.
create or replace function public.qorpera_company_owner_user_id(p_profile_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select founder.user_id from public.qorpera_company_founders(p_profile_id) with ordinality as founder(user_id, position)
	order by founder.position limit 1
$$;

-- The company's plan follows its first founder (computer-hours billing replaces this later).
create or replace function public.qorpera_profile_entitlement_json(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select public.qorpera_account_entitlement_json(public.qorpera_company_owner_user_id(p_profile_id))
$$;

-- The founder rule, for every writer of membership. Only a founder leaving or stepping down is
-- checked; promotions and changes to other members pass without locks.
create function public.qorpera_guard_founder_departure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
	perform 1 from public.qorpera_profiles where id = old.profile_id for update;
	-- The company itself is being deleted: its members go with it.
	if not found then return coalesce(new, old); end if;
	-- Locking the other founders' rows makes a concurrent change to them a serialization failure
	-- under repeatable read instead of a stale answer.
	perform 1 from public.qorpera_profile_members as founder
	where founder.profile_id = old.profile_id and founder.user_id <> old.user_id and founder.role = 'owner'
	for key share;
	if not found then
		if tg_op = 'UPDATE' then
			raise exception 'The last founder cannot step down; make someone else a founder first'
				using errcode = '42501';
		elsif exists (select 1 from public.qorpera_profile_members as other
			where other.profile_id = old.profile_id and other.user_id <> old.user_id) then
			raise exception 'The last founder cannot leave while others remain; make someone else a founder first'
				using errcode = '42501';
		end if;
	end if;
	-- Company setup acts for the founder it was queued for.
	if exists (select 1 from public.qorpera_company_bootstrap_jobs as job
		where job.profile_id = old.profile_id and job.created_by_user_id = old.user_id
			and job.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
end
$$;
revoke all on function public.qorpera_guard_founder_departure() from public, anon, authenticated, service_role;
create trigger qorpera_profile_members_guard_founder_departure
	before delete or update of role on public.qorpera_profile_members
	for each row execute function public.qorpera_guard_founder_departure();

-- Anyone leaves, except the last member, who deletes the company instead.
create or replace function public.qorpera_leave_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null then
		raise exception 'authentication required' using errcode = '42501';
	end if;
	if public.qorpera_member_role(p_profile_id) is null then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if not exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then
		raise exception 'You are the last member; delete the company instead' using errcode = '42501';
	end if;
	-- The guard refuses the last founder while others remain.
	delete from public.qorpera_profile_members
	where profile_id = p_profile_id and user_id = v_actor_id;
	return 'true'::jsonb;
end
$$;

-- Only the last member deletes the company; nobody deletes it while others remain.
create or replace function public.qorpera_delete_hosted_profile(p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
begin
	if v_actor_id is null or public.qorpera_member_role(p_profile_id) is null then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	perform 1 from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_actor_id;
	if not found then
		raise exception 'deleting a company requires membership' using errcode = '42501';
	end if;
	if exists (select 1 from public.qorpera_profile_members as other
		where other.profile_id = p_profile_id and other.user_id <> v_actor_id) then
		raise exception 'Only the last member can delete the company; everyone else leaves' using errcode = '42501';
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

-- Founders remove any other member except a fellow founder; admins remove contributors and viewers.
create or replace function public.qorpera_remove_profile_member(
	p_profile_id uuid,
	p_member_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_member_role public.qorpera_profile_role;
begin
	if coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin'), false) is not true then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_member_user_id = v_actor_id then
		raise exception 'use the leave-profile action to remove your own access' using errcode = '22023';
	end if;

	select member.role into v_member_role
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_member_user_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if v_member_role = 'owner' then
		raise exception 'A founder cannot be removed; founders leave on their own' using errcode = '42501';
	end if;
	if v_actor_role = 'admin' and v_member_role = 'admin' then
		raise exception 'only a founder can manage full access' using errcode = '42501';
	end if;

	delete from public.qorpera_profile_members
	where profile_id = p_profile_id and user_id = p_member_user_id;
	return 'true'::jsonb;
end
$$;

-- Founders make founders and manage admins; a founder steps down only on their own; admins change
-- contributors and viewers.
create or replace function public.qorpera_update_profile_member_role(
	p_profile_id uuid,
	p_member_user_id uuid,
	p_role public.qorpera_profile_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor_id uuid := auth.uid();
	v_actor_role public.qorpera_profile_role;
	v_member public.qorpera_profile_members%rowtype;
begin
	if coalesce(public.qorpera_member_role(p_profile_id) in ('owner', 'admin'), false) is not true then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	perform 1 from public.qorpera_profiles where id = p_profile_id for update;
	v_actor_role := public.qorpera_member_role(p_profile_id);
	if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
		raise exception 'member management requires full access' using errcode = '42501';
	end if;
	if p_role is null then
		raise exception 'member role is invalid' using errcode = '22023';
	end if;

	select member.* into v_member
	from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = p_member_user_id
	for update;
	if not found then
		raise exception 'profile member was not found' using errcode = 'P0002';
	end if;
	if p_member_user_id = v_actor_id then
		-- The only change of one's own role: a founder stepping down (the guard keeps a founder).
		if v_member.role <> 'owner' or p_role = 'owner' then
			raise exception 'use the leave-profile action to change your own access' using errcode = '22023';
		end if;
	elsif v_member.role = 'owner' then
		raise exception 'A founder cannot be changed by another member; founders step down on their own'
			using errcode = '42501';
	elsif p_role = 'owner' and v_actor_role <> 'owner' then
		raise exception 'only a founder can make a founder' using errcode = '42501';
	elsif v_actor_role = 'admin' and (v_member.role = 'admin' or p_role = 'admin') then
		raise exception 'only a founder can manage full access' using errcode = '42501';
	end if;

	update public.qorpera_profile_members
	set role = p_role
	where profile_id = p_profile_id and user_id = p_member_user_id
	returning * into v_member;

	return jsonb_build_object(
		'user_id', v_member.user_id,
		'email', v_member.email,
		'display_name', v_member.display_name,
		'avatar_url', v_member.avatar_url,
		'role', v_member.role,
		'joined_at', v_member.joined_at
	);
end
$$;

-- Each patch below replaces exact text of the current definition, once, and fails loudly when
-- that text differs (a later migration changed the function first).
create function pg_temp.company_founders_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'company founders: % differs', p_what; end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $$
declare v_definition text;
begin
	-- A new member's agent threads: the member themself, or the company's first founder.
	v_definition := pg_temp.company_founders_replace(
		pg_get_functiondef('public.qorpera_agent_threads_on_member()'::regprocedure),
$old$coalesce(new.user_id, (select member.user_id from public.qorpera_profile_members member where member.profile_id = v_profile and member.role = 'owner'))$old$,
$new$coalesce(new.user_id, public.qorpera_company_owner_user_id(v_profile))$new$,
		'agent threads owner');
	execute v_definition;

	-- Company setup acts for the company's first founder.
	v_definition := pg_temp.company_founders_replace(
		pg_get_functiondef('public.qorpera_enqueue_company_bootstrap(uuid,boolean)'::regprocedure),
$old$	select user_id into strict v_owner from public.qorpera_profile_members where profile_id = p_profile_id and role = 'owner';$old$,
$new$	select founder.user_id into strict v_owner from public.qorpera_company_founders(p_profile_id)
		with ordinality as founder(user_id, position) order by founder.position limit 1;$new$,
		'company setup owner');
	execute v_definition;

	-- The team page learns what the member may do with their own membership.
	v_definition := pg_temp.company_founders_replace(
		pg_get_functiondef('public.qorpera_profile_team_info(uuid)'::regprocedure),
$old$			'manage_members', v_role in ('owner', 'admin')$old$,
$new$			'manage_members', v_role in ('owner', 'admin'),
			'manage_founders', v_role = 'owner',
			'leave', exists (select 1 from public.qorpera_profile_members as other
					where other.profile_id = p_profile_id and other.user_id <> auth.uid())
				and (v_role <> 'owner' or exists (select 1 from public.qorpera_profile_members as founder
					where founder.profile_id = p_profile_id and founder.user_id <> auth.uid() and founder.role = 'owner'))
				and not exists (select 1 from public.qorpera_company_bootstrap_jobs as job
					where job.profile_id = p_profile_id and job.created_by_user_id = auth.uid()
						and job.state in ('queued', 'leased')),
			'delete_company', not exists (select 1 from public.qorpera_profile_members as other
				where other.profile_id = p_profile_id and other.user_id <> auth.uid())$new$,
		'team capabilities');
	execute v_definition;
end
$$;
