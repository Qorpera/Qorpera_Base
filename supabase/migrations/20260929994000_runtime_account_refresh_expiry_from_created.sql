-- An account refresh expires five minutes after its own created_at.
--
-- qorpera_native_account_refresh_requests (20260919007000) defaulted created_at and expires_at to two separate
-- clock_timestamp() calls, while its check allows at most five minutes between them. A row inserted with both
-- defaults could get an expires_at a few microseconds past created_at + 5 minutes and be refused (23514, violates
-- check constraint "qorpera_native_account_refresh_requests_check"), as node 2's hosted-db run of SQL test 764 was on
-- 2026-10-01. Production's only inserter, qorpera_begin_native_account_refresh, passes one clock reading for both
-- columns, so no member's refresh was refused.
--
-- Now expires_at has no default of its own: a row inserted without one, or with a null one, expires five minutes after
-- its created_at (given, or its default). An expires_at given explicitly is kept and checked as before.
--
-- Locks: the trigger takes the table's SHARE ROW EXCLUSIVE lock and dropping the default its ACCESS EXCLUSIVE lock,
-- each briefly. The trigger comes first, so no moment has neither.

set local lock_timeout = '3s';

create function public.qorpera_account_refresh_expiry_from_created()
returns trigger language plpgsql set search_path = '' as $$
begin
	-- 20260929994000: one created_at for both columns, at the five minutes the table's check allows.
	if new.expires_at is null then new.expires_at := new.created_at + interval '5 minutes'; end if;
	return new;
end
$$;
revoke all on function public.qorpera_account_refresh_expiry_from_created() from public, anon, authenticated, service_role;
create trigger qorpera_account_refresh_expiry_from_created before insert
	on public.qorpera_native_account_refresh_requests
	for each row execute function public.qorpera_account_refresh_expiry_from_created();

alter table public.qorpera_native_account_refresh_requests alter column expires_at drop default;
