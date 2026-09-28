-- Deleting an account removes only what is the person's own (28 Sep 2026, "Deleting an Account",
-- approved as recommended; follow-up to Company Founders). Qorpera has no Delete account button;
-- today an account goes only when an operator deletes it in Supabase (a delete on auth.users).
--
-- The rules (Jonas):
-- * An account deletion never deletes company data. The company, its folder, its conversations and
--   the messages in them, runs and everything else made for the company stay with the company.
-- * What goes is the person's own: their memberships (as if they pressed Leave), settings, drafts,
--   notifications, picture, friends, devices, pending invitations and founding-table seats.
-- * The last founder of a company with other members cannot be deleted, the same as Leave.
-- * The only member of a company cannot be deleted until they delete the company themselves.
-- * Plan and usage records are kept for bookkeeping (contract section 19, "computer hours", item 9).
-- * Accounts will be closed (Supabase's soft delete keeps an empty auth.users row), never erased,
--   once a Delete account button exists. Not built here. A soft delete is an update: none of the
--   links or the guard below act on it, so the close must remove and refuse the same things itself.
--
-- Before this, seven links from those rows to auth.users were ON DELETE CASCADE. The company's own
-- link fired first, so the founder guard below saw "the company is being deleted" and let the
-- creator's membership go; only RESTRICT links checked before the company's cascades ran (a
-- workspace, a session event) refused the deletion. Now each of the seven refuses the deletion
-- itself. The other 20 cascading links remove only the person's own rows and stay; the 106 RESTRICT,
-- 2 NO ACTION and 10 SET NULL links are unchanged.
--
-- The founder guard also refuses the last founder's departure when nobody else remains and the
-- company stays. The last member is always a founder (the last founder cannot leave while others
-- remain), so an account deletion can no longer leave a company with nobody in it. A company that is being deleted (its
-- row is gone, or its deletion was requested: public.qorpera_company_deleting, company delete D1)
-- lets its members go in any order. No new lock: the guard still locks only on a founder's
-- departure, as before.

-- Dropping and re-adding a link locks the table and auth.users; membership and sign-in are read on
-- every request, so never queue them behind this migration.
set local lock_timeout = '3s';

do $$
declare
	v_link record;
begin
	for v_link in
		select * from (values
			('public.qorpera_profiles'::regclass, 'created_by_user_id', 'qorpera_profiles_created_by_user_id_fkey'),
			('public.qorpera_company_environments'::regclass, 'created_by_user_id', 'qorpera_company_environments_created_by_user_id_fkey'),
			('public.qorpera_company_foundings'::regclass, 'created_by_user_id', 'qorpera_company_foundings_created_by_user_id_fkey'),
			('public.qorpera_shared_sessions'::regclass, 'created_by_user_id', 'qorpera_shared_sessions_created_by_user_id_fkey'),
			('public.qorpera_session_inputs'::regclass, 'author_user_id', 'qorpera_session_inputs_author_user_id_fkey'),
			('public.qorpera_account_entitlements'::regclass, 'user_id', 'qorpera_account_entitlements_user_id_fkey'),
			('public.qorpera_account_entitlement_changes'::regclass, 'user_id', 'qorpera_account_entitlement_changes_user_id_fkey')
		) as link(table_id, column_name, constraint_name)
	loop
		if not exists (
			select 1 from pg_catalog.pg_constraint as link
			join pg_catalog.pg_attribute as col on col.attrelid = link.conrelid and col.attname = v_link.column_name
			where link.conname = v_link.constraint_name and link.conrelid = v_link.table_id and link.contype = 'f'
				and link.confrelid = 'auth.users'::regclass and link.confdeltype = 'c' and link.conkey = array[col.attnum]
		) then
			raise exception 'account deletion: % is not the cascading account link on %.%',
				v_link.constraint_name, v_link.table_id, v_link.column_name;
		end if;
	end loop;
end
$$;

-- The seven tables first, in one statement, so the migration never holds auth.users (each drop below
-- takes it) while it waits for one of them behind a member's write.
lock table public.qorpera_profiles, public.qorpera_company_environments, public.qorpera_company_foundings,
	public.qorpera_shared_sessions, public.qorpera_session_inputs, public.qorpera_account_entitlements,
	public.qorpera_account_entitlement_changes in access exclusive mode;

alter table public.qorpera_profiles
	drop constraint qorpera_profiles_created_by_user_id_fkey,
	add constraint qorpera_profiles_created_by_user_id_fkey
		foreign key (created_by_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_company_environments
	drop constraint qorpera_company_environments_created_by_user_id_fkey,
	add constraint qorpera_company_environments_created_by_user_id_fkey
		foreign key (created_by_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_company_foundings
	drop constraint qorpera_company_foundings_created_by_user_id_fkey,
	add constraint qorpera_company_foundings_created_by_user_id_fkey
		foreign key (created_by_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_shared_sessions
	drop constraint qorpera_shared_sessions_created_by_user_id_fkey,
	add constraint qorpera_shared_sessions_created_by_user_id_fkey
		foreign key (created_by_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_session_inputs
	drop constraint qorpera_session_inputs_author_user_id_fkey,
	add constraint qorpera_session_inputs_author_user_id_fkey
		foreign key (author_user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_account_entitlements
	drop constraint qorpera_account_entitlements_user_id_fkey,
	add constraint qorpera_account_entitlements_user_id_fkey
		foreign key (user_id) references auth.users(id) on delete restrict;
alter table public.qorpera_account_entitlement_changes
	drop constraint qorpera_account_entitlement_changes_user_id_fkey,
	add constraint qorpera_account_entitlement_changes_user_id_fkey
		foreign key (user_id) references auth.users(id) on delete restrict;

-- Each patch below replaces exact text of the current definition, once, and fails loudly when that
-- text differs (a later migration changed the function first).
create function pg_temp.account_deletion_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'account deletion: % differs', p_what; end if;
	return replace(p_definition, p_old, p_new);
end
$$;

do $$
declare v_definition text := pg_get_functiondef('public.qorpera_guard_founder_departure()'::regprocedure);
begin
	-- A company being deleted lets its members go; before company delete D1 only a gone row counts.
	v_definition := pg_temp.account_deletion_replace(v_definition,
$old$begin
	if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
	perform 1 from public.qorpera_profiles where id = old.profile_id for update;
	-- The company itself is being deleted: its members go with it.
	if not found then return coalesce(new, old); end if;$old$,
$new$declare
	v_deleting boolean := false;
begin
	if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
	perform 1 from public.qorpera_profiles where id = old.profile_id for update;
	-- The company itself is being deleted (its row is gone, or its deletion was requested): its
	-- members go with it.
	if not found then return coalesce(new, old); end if;
	if to_regprocedure('public.qorpera_company_deleting(uuid)') is not null then
		execute 'select public.qorpera_company_deleting($1)' into v_deleting using old.profile_id;
	end if;
	if coalesce(v_deleting, false) then return coalesce(new, old); end if;$new$,
		'company being deleted');
	-- The last member leaves only by deleting the company, so a company never stays with nobody in it
	-- (an account deletion takes its memberships by cascade).
	v_definition := pg_temp.account_deletion_replace(v_definition,
$old$			raise exception 'The last founder cannot leave while others remain; make someone else a founder first'
				using errcode = '42501';
		end if;$old$,
$new$			raise exception 'The last founder cannot leave while others remain; make someone else a founder first'
				using errcode = '42501';
		else
			raise exception 'The last member cannot leave; delete the company instead' using errcode = '42501';
		end if;$new$,
		'last member');
	execute v_definition;
end
$$;
revoke all on function public.qorpera_guard_founder_departure() from public, anon, authenticated, service_role;
