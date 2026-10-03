-- Company folder core, C1d-2b: the switch of the artifact GC worker's folder phase (deploy/first-node/
-- RUNTIME-COMPANY-FOLDER-C1D.md §9.10, §9.11). The worker asks qorpera_folder_gc_enabled() before it sweeps upload
-- intents, claims objects or calls the object gateway's /v1/folder-gc lane, and does none of it while the answer is no.
--
-- Off. It can be switched on only once qorpera_verify_company_path_file refuses folder-v2 (C1D §9.3, "C5 early"; slice
-- P10): until then a folder-v2 company may hold version-1 proofs, whose chunks the chunk index does not list, so the
-- root check would miss them. P10's refusal carries the marker text 'folder-v2 refuses version 1' in that function's
-- body, which nothing before it does (last defined in 20260913000200). The read checks it again, so a later definition
-- of that function without the marker turns the phase off by itself; a refusal written without it keeps the phase off
-- (fail-safe).
--
-- The coordinator switches it on with:
--   update public.qorpera_folder_gc_settings set enabled = true;
-- The worker is not deployed, and its key is the founder's (RUNTIME-COMPANY-DELETE.md, "Switching the worker on").

set local lock_timeout = '3s';

create table public.qorpera_folder_gc_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false,
	updated_at timestamptz not null default statement_timestamp()
);
insert into public.qorpera_folder_gc_settings default values;
alter table public.qorpera_folder_gc_settings enable row level security;
revoke all on table public.qorpera_folder_gc_settings from public, anon, authenticated, service_role;
comment on table public.qorpera_folder_gc_settings is
	'The artifact GC worker''s folder phase (C1D §9.10). Refused on while qorpera_verify_company_path_file accepts folder-v2. '
	'The coordinator turns it on with: update public.qorpera_folder_gc_settings set enabled = true;';

-- Whether version-1 proofs are refused for folder-v2: qorpera_verify_company_path_file carries P10's marker, or no
-- longer exists (C6). Plain catalog reads.
create function public.qorpera_folder_gc_version1_refused()
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select strpos(pg_get_functiondef(p.oid), 'folder-v2 refuses version 1') > 0 from pg_catalog.pg_proc p
		where p.oid = to_regprocedure('public.qorpera_verify_company_path_file(uuid,text)')), true)
$$;

create function public.qorpera_folder_gc_settings_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if new.enabled and not public.qorpera_folder_gc_version1_refused() then
		raise exception 'Folder GC stays off until qorpera_verify_company_path_file refuses folder-v2 (its marker '
			'''folder-v2 refuses version 1'', C1D §9.3)' using errcode = '55000';
	end if;
	new.updated_at := statement_timestamp();
	return new;
end $$;
create trigger qorpera_folder_gc_settings_guard before insert or update on public.qorpera_folder_gc_settings
	for each row execute function public.qorpera_folder_gc_settings_guard();

-- The worker's question. Service role only; no locks.
create function public.qorpera_folder_gc_enabled()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Folder core authority is required' using errcode = '42501'; end if;
	return coalesce((select enabled from public.qorpera_folder_gc_settings), false)
		and public.qorpera_folder_gc_version1_refused();
end $$;

revoke all on function public.qorpera_folder_gc_version1_refused(), public.qorpera_folder_gc_settings_guard()
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_folder_gc_enabled() from public, anon, authenticated;
grant execute on function public.qorpera_folder_gc_enabled() to service_role;
