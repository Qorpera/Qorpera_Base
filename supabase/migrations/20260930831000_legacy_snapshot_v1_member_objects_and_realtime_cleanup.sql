begin;

set local lock_timeout = '3s';

do $$
declare
	v_target constant regprocedure := 'public.qorpera_object_rpc_lock_budget()'::regprocedure;
	v_old constant text :=
		E'\t\t''qorpera_authorize_member_company_path_object'',\n'
		|| E'\t\t''qorpera_authorize_member_company_snapshot_object'',\n';
	v_definition text := pg_get_functiondef(v_target);
begin
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'Legacy sweep anchor not found once in %', v_target;
	end if;
	execute replace(v_definition, v_old, '');
end $$;

do $$
begin
	if exists (
		select 1
		from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_company_workspaces'
	) then
		alter publication supabase_realtime drop table public.qorpera_company_workspaces;
	end if;
end $$;

drop function public.qorpera_authorize_member_company_path_object(uuid,text,uuid,text);
drop function public.qorpera_authorize_member_company_snapshot_object(uuid,text,uuid,text);
drop function public.qorpera_authorize_member_company_command_object(uuid,text,text);
drop function public.qorpera_authorize_member_company_proposal_object(uuid,text,text);
drop function public.qorpera_begin_member_company_file_upload(uuid,jsonb,text,jsonb);
drop function public.qorpera_begin_member_company_path_command(uuid,jsonb);
drop function public.qorpera_describe_member_company_path_proposal(uuid,uuid);

do $$
declare v_name text;
begin
	for v_name in
		select procedure.oid::regprocedure::text
		from pg_proc procedure
		where procedure.pronamespace = 'public'::regnamespace
			and (
				procedure.proname in (
					'qorpera_authorize_member_company_path_object',
					'qorpera_authorize_member_company_snapshot_object',
					'qorpera_authorize_member_company_command_object',
					'qorpera_authorize_member_company_proposal_object',
					'qorpera_begin_member_company_file_upload',
					'qorpera_begin_member_company_path_command',
					'qorpera_describe_member_company_path_proposal'
				)
				or procedure.prosrc ~ (
					'qorpera_authorize_member_company_(path|snapshot|command|proposal)_object\M'
					|| '|qorpera_begin_member_company_(file_upload|path_command)\M'
					|| '|qorpera_describe_member_company_path_proposal\M'
				)
			)
	loop
		raise exception 'Function % is or names a dropped legacy snapshot-v1 RPC', v_name;
	end loop;
	if exists (
		select 1
		from pg_catalog.pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'qorpera_company_workspaces'
	) then
		raise exception 'qorpera_company_workspaces is still in supabase_realtime';
	end if;
end $$;

commit;
