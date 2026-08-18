-- A workspace is a single-writer fork. Profile contributors can create and
-- advance their own workspaces, but cannot mutate another user or computer's
-- head. Cross-workspace integration remains an explicit future merge action.

create function public.qorpera_enforce_company_workspace_writer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_workspace public.qorpera_company_workspaces%rowtype;
begin
	select workspace.* into v_workspace
	from public.qorpera_company_workspaces as workspace
	where workspace.id = new.workspace_id;
	if not found
		or v_workspace.profile_id <> new.profile_id
		or v_workspace.environment_id <> new.environment_id then
		raise exception 'company snapshot workspace is invalid' using errcode = '22023';
	end if;
	if auth.uid() is null or v_workspace.created_by_user_id <> auth.uid() then
		raise exception 'company workspace head belongs to another writer' using errcode = '42501';
	end if;
	if new.created_by_user_id <> auth.uid() then
		raise exception 'company snapshot actor is invalid' using errcode = '42501';
	end if;
	return new;
end
$$;

revoke all on function public.qorpera_enforce_company_workspace_writer() from public;

create trigger qorpera_company_snapshots_enforce_workspace_writer
	before insert
	on public.qorpera_company_snapshots
	for each row
	execute function public.qorpera_enforce_company_workspace_writer();
