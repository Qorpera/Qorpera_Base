-- Computer hours: no credits for a company that is gone or being deleted.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 8 (payments) and 9 (records).
--
-- A founder can pay for a pack of hours on Stripe's page after the company was deleted (the page
-- was opened before). The payment's credit would then belong to no company. Instead the insert is
-- refused (22023, a permanent refusal), so the computer-billing function records the Stripe event
-- for review and an operator refunds the payment. A company is being deleted from the moment its
-- deletion is requested (public.qorpera_company_deleting, company delete D1), which is used when
-- that function exists; before it, a company without a row is gone. A credit already added (a
-- repeated delivery of the same payment) is left to the insert's own "on conflict do nothing".
-- Known limit: the guard does not lock the company, so a deletion requested in the same instant
-- as the payment can let one credit through; the company's purge then leaves it unused.

set local lock_timeout = '10s';

create function public.qorpera_computer_hour_credit_company_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_deleting boolean := false;
begin
	if exists (
		select 1 from public.qorpera_computer_hour_sources credit
		where credit.kind = 'credit' and credit.reference = new.reference and credit.dry_run = new.dry_run
	) then
		return new;
	end if;
	if not exists (select 1 from public.qorpera_profiles profile where profile.id = new.profile_id) then
		raise exception 'Billing: credits for a company that no longer exists' using errcode = '22023';
	end if;
	if to_regprocedure('public.qorpera_company_deleting(uuid)') is not null then
		execute 'select public.qorpera_company_deleting($1)' into v_deleting using new.profile_id;
	end if;
	if coalesce(v_deleting, false) then
		raise exception 'Billing: credits for a company that is being deleted' using errcode = '22023';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_computer_hour_credit_company_guard() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_credit_company_guard
	before insert on public.qorpera_computer_hour_sources
	for each row when (new.kind = 'credit')
	execute function public.qorpera_computer_hour_credit_company_guard();
