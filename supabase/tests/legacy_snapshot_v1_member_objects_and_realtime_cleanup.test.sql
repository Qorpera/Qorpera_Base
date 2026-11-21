begin;

do $$
declare
	v_table text;
begin
	if exists (
		select 1
		from pg_catalog.pg_proc p
		where p.pronamespace = 'public'::regnamespace
			and p.proname in (
				'qorpera_authorize_member_company_path_object',
				'qorpera_authorize_member_company_snapshot_object',
				'qorpera_authorize_member_company_command_object',
				'qorpera_authorize_member_company_proposal_object',
				'qorpera_begin_member_company_file_upload',
				'qorpera_begin_member_company_path_command',
				'qorpera_describe_member_company_path_proposal'
			)
	) then
		raise exception 'legacy snapshot-v1 member RPC still exists';
	end if;

	if exists (
		select 1
		from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_company_workspaces'
	) then
		raise exception 'qorpera_company_workspaces must not remain in supabase_realtime';
	end if;

	foreach v_table in array array[
		'qorpera_shared_sessions',
		'qorpera_profile_staff',
		'qorpera_profile_access_state',
		'qorpera_company_files',
		'qorpera_company_sidebar_revisions'
	] loop
		if not exists (
			select 1
			from pg_catalog.pg_publication_tables
			where pubname = 'supabase_realtime'
				and schemaname = 'public'
				and tablename = v_table
		) then
			raise exception 'active realtime table % missing from supabase_realtime', v_table;
		end if;
	end loop;
end $$;

rollback;
