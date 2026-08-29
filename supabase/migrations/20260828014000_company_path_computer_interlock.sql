-- A legacy Company Computer exposes the whole NAS tree to its desktop and
-- shell. Registering one is not evidence of path mediation. Do not permit
-- that access path and the governed Company File to coexist. A disabled or
-- retired label is not proof of unmounting; only the exact immutable physical
-- teardown attestation installed by the preceding migration closes the lane.
-- This is a cutover interlock, not an implementation to mediate a desktop.
-- It leaves all unenrolled companies and their existing computers unchanged.

create function public.qorpera_enforce_company_path_computer_interlock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if tg_table_name = 'qorpera_logical_computers' then
		if tg_op = 'UPDATE' and old.computer_class = 'company_computer'
			and (new.computer_class is distinct from old.computer_class
				or new.profile_id is distinct from old.profile_id) then
			raise exception 'Legacy company computer access cannot be cleared by relabelling its binding'
				using errcode = '55000';
		end if;
		if new.computer_class <> 'company_computer' then return new; end if;
		-- Enrollment already takes this same profile fence before the File
		-- row. Serialize registration with it, including an empty registry.
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if public.qorpera_legacy_company_computer_teardown_matches(new) then return new; end if;
		if exists (select 1 from public.qorpera_company_files
			where profile_id = new.profile_id and path_gateway_version = 1) then
			raise exception 'Governed Company Files require a path-mediated company computer'
				using errcode = '55000';
		end if;
	elsif tg_table_name = 'qorpera_company_files' then
		if new.path_gateway_version is distinct from 1 then return new; end if;
		perform public.qorpera_lock_profile_gc_fence(new.profile_id);
		if exists (
			select 1 from public.qorpera_logical_computers as computer
			where computer.profile_id = new.profile_id
				and computer.computer_class = 'company_computer'
				and not public.qorpera_legacy_company_computer_teardown_matches(computer)
		) then
			raise exception 'Company File cutover requires verified removal of legacy computer access'
				using errcode = '55000';
		end if;
	else
		raise exception 'Invalid Company File interlock target' using errcode = '55000';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_company_path_computer_interlock()
	from public,anon,authenticated,service_role;

-- The core logical-computer table exists with or without the older managed
-- deployment's Company Computer registry. Guard it rather than importing a
-- second registry or trusting caller-supplied capability/policy labels.
create trigger qorpera_company_path_computer_insert
before insert on public.qorpera_logical_computers
for each row execute function public.qorpera_enforce_company_path_computer_interlock();

create trigger qorpera_company_path_computer_update
before update of profile_id,computer_class on public.qorpera_logical_computers
for each row execute function public.qorpera_enforce_company_path_computer_interlock();

create trigger qorpera_company_path_computer_enrollment_insert
before insert on public.qorpera_company_files
for each row execute function public.qorpera_enforce_company_path_computer_interlock();

create trigger qorpera_company_path_computer_enrollment_update
before update of profile_id,path_gateway_version on public.qorpera_company_files
for each row execute function public.qorpera_enforce_company_path_computer_interlock();

-- Do not silently install a safety claim over an unresolved enrollment. The
-- pre-interlock teardown migration permits an operator to register the exact
-- physical proof first; this migration still never stops or deletes work.
do $$
begin
	if exists (
		select 1 from public.qorpera_company_files as file
		join public.qorpera_logical_computers as computer on computer.profile_id = file.profile_id
		where file.path_gateway_version = 1
			and computer.computer_class = 'company_computer'
			and not public.qorpera_legacy_company_computer_teardown_matches(computer)
	) then
		raise exception 'Existing governed Company File has unresolved legacy computer access'
			using errcode = '55000';
	end if;
end
$$;
