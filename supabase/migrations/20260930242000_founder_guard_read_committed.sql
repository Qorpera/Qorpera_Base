-- 20260930242000: the legacy sweep, step G. The founder guard runs at read committed only, so it never reads a stale
-- founder and the engine's serialization failure no longer comes out of it. Under repeatable read, when one of the
-- other founders had changed since the snapshot, its KEY SHARE on them did one of two things:
-- - after a delete, or an update of a row first taken FOR UPDATE (as the member functions do), it failed (40001,
--   "could not serialize access due to concurrent update"). It was the last qorpera_ function that still did
--   (registry, 4 October);
-- - after a plain update of the role, which is not a key column, it locked the snapshot's old row and read a founder
--   who had already stepped down, so the company could lose its last founder.
-- At read committed, where every caller runs, the lock waits for a founder's row that is being deleted or held FOR
-- UPDATE and then reads the result: member changes meet at the folder fence (665 B), and an account deletion's cascade
-- and a member change wait for each other at the member rows. Any other level is now refused (25000), as the folder
-- core's functions refuse it; a company being deleted still lets its members go first. Folder-v2 only (3 October): the
-- snapshot-v1 branch (the company row FOR UPDATE) goes, and qorpera_company_deleting (20260928249150) is called
-- directly. The rest is the live text, unchanged.

set local lock_timeout = '3s';

create or replace function public.qorpera_guard_founder_departure()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
	if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then return coalesce(new, old); end if;
	perform 1 from public.qorpera_profiles where id = old.profile_id for key share;
	-- The company itself is being deleted (its row is gone, or its deletion was requested): its
	-- members go with it.
	if not found or public.qorpera_company_deleting(old.profile_id) then return coalesce(new, old); end if;
	-- 20260930242000: the other founders are read at read committed only. Under repeatable read, the lock below fails
	-- after a delete or a FOR UPDATE then update since the snapshot ("could not serialize access"), and after a plain
	-- update of the role it locks the snapshot's old row and reads a founder who has already stepped down.
	if current_setting('transaction_isolation') <> 'read committed' then
		raise exception 'Founder changes run at read committed' using errcode = '25000';
	end if;
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
		else
			raise exception 'The last member cannot leave; delete the company instead' using errcode = '42501';
		end if;
	end if;
	-- Company setup acts for the founder it was queued for.
	if exists (select 1 from public.qorpera_company_bootstrap_jobs as job
		where job.profile_id = old.profile_id and job.created_by_user_id = old.user_id
			and job.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	-- 20260930010000 (P14a): so does a folder-v2 creation, for the member who started it.
	if exists (select 1 from public.qorpera_folder_company_creations as creation
		where creation.profile_id = old.profile_id and creation.kickoff_user_id = old.user_id
			and creation.state in ('queued', 'leased')) then
		raise exception 'Company setup must finish before the founder it runs for leaves or steps down'
			using errcode = '42501';
	end if;
	return coalesce(new, old);
end
$function$;
revoke all on function public.qorpera_guard_founder_departure() from public, anon, authenticated, service_role;
