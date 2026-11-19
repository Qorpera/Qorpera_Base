do $$ begin
	if exists (select 1 from pg_catalog.pg_attribute where attrelid = 'public.qorpera_home_settings'::regclass
		and attname = 'every_company' and not attisdropped) then
		raise exception '20260930789000 is already applied'; end if;
	if to_regprocedure('public.qorpera_company_home_allowed(uuid)') is null
		or to_regclass('public.qorpera_home_companies') is null then
		raise exception '20260930789000 needs the home switch (20260930752000)'; end if;
end $$;

set local lock_timeout = '3s';

alter table public.qorpera_home_settings add column every_company boolean not null default false;
comment on column public.qorpera_home_settings.every_company is
	'With the platform switch on: every company has the home, listed in qorpera_home_companies or not. Off: only the listed companies.';

create or replace function public.qorpera_company_home_allowed(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select s.enabled from public.qorpera_home_settings s where s.singleton), false)
		and (coalesce((select s.every_company from public.qorpera_home_settings s where s.singleton), false)
			or exists (select 1 from public.qorpera_home_companies c where c.profile_id = p_profile_id))
		and pg_catalog.to_regprocedure(
			'public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)') is not null;
$$;
revoke all on function public.qorpera_company_home_allowed(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

update public.qorpera_home_settings set every_company = true where singleton and enabled;
