-- Company folder core, C1c-1: legacy paths refuse folder-v2 companies (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1C.md).
--
-- Changes only folder-v2 behaviour: every guard below is false for snapshot-v1 companies, so today's companies run
-- exactly as before. Until now the legacy actor's 55000 was the only thing between a folder-v2 company and most of the
-- snapshot-v1 Company File code, and some paths had no refusal at all:
-- * raw object reads by hash (/v1/profile-objects, its read lease, and the Storage read policy) and raw uploads, which
--   would bypass private folders, narrower resources and revocation;
-- * the member whole-tree lane, the approval and member-command actors, the office Company File transfers, the native
--   object staging, the runner broker's whole-tree lane, completion's legacy lane and the snapshot bootstrap;
-- * old writers that still wrote folder-v2 rows directly: staff, provider models, the Co-Founder seed and todo
--   publication confirmations (F2-6 decides the routine writer's folder-v2 rule).
-- The legacy actor itself keeps refusing folder-v2 for good; C1c-2 gives the callers that need a folder-v2 actor their
-- own entry point, so no caller can fall through to snapshot-v1 code (C1C §2).

-- 1. Helpers --------------------------------------------------------------------------------------------------------

-- Whether a company, an environment, or the run a runtime binding names is on the folder core. Plain reads, no locks.
create function public.qorpera_company_is_folder_v2(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_files where profile_id = p_profile_id and core = 'folder-v2')
$$;
create function public.qorpera_environment_is_folder_v2(p_environment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_company_files where environment_id = p_environment_id and core = 'folder-v2')
$$;
create function public.qorpera_job_is_folder_v2(p_job_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_runner_jobs job
		join public.qorpera_company_files file on file.environment_id = job.environment_id
		where job.id = p_job_id and file.core = 'folder-v2')
$$;
create function public.qorpera_binding_is_folder_v2(p_binding jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
	select case when coalesce(p_binding ->> 'jobId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		then public.qorpera_job_is_folder_v2((p_binding ->> 'jobId')::uuid) else false end
$$;
revoke all on function public.qorpera_company_is_folder_v2(uuid), public.qorpera_environment_is_folder_v2(uuid),
	public.qorpera_job_is_folder_v2(uuid), public.qorpera_binding_is_folder_v2(jsonb)
	from public, anon, authenticated, service_role;
-- The Storage read policy (§3 below) runs as the member, like qorpera_company_uses_path_gateway beside it.
grant execute on function public.qorpera_company_is_folder_v2(uuid) to authenticated;

-- 2. Patches --------------------------------------------------------------------------------------------------------

-- Inserts one statement at the start of a PL/pgSQL body, after its first line that is only "begin": before any lock the
-- function takes. The function must be PL/pgSQL, and the statement must not be there yet.
create function pg_temp.c1c_guard(p_target regprocedure, p_statement text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_body integer; v_at integer;
begin
	if (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = p_target) <> 'plpgsql' then
		raise exception 'C1c-1 guard target is not PL/pgSQL: %', p_target; end if;
	if position(p_statement in v_definition) > 0 then raise exception 'C1c-1 guard is already in %', p_target; end if;
	v_body := position('$function$' in v_definition);
	v_at := position(E'\nbegin\n' in substr(v_definition, v_body));
	if v_body = 0 or v_at = 0 then raise exception 'C1c-1 guard anchor not found in %', p_target; end if;
	v_at := v_body + v_at - 1 + length(E'\nbegin\n');
	execute substr(v_definition, 1, v_at - 1) || E'\t' || p_statement || E'\n' || substr(v_definition, v_at);
end $$;
-- Replaces exact text of a definition, exactly p_count times.
create function pg_temp.c1c_replace(p_target regprocedure, p_old text, p_new text, p_count integer) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'C1c-1 patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

do $$
declare
	c_refuse constant text := 'then raise exception ''This Company File path does not serve folder-v2 companies'' using errcode = ''0A000''; end if;';
begin
	-- Raw object reads and uploads (C1C §3). A member reads folder-v2 bytes only through the folder core (C1d's byte
	-- check); trusted services keep their download until C1d. The read lease calls the download check, so it refuses too.
	perform pg_temp.c1c_guard('public.qorpera_authorize_profile_object_download(uuid,text)',
		'if coalesce(auth.role(), '''') <> ''service_role'' and public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_authorize_profile_object_upload(uuid,text,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_authorize_native_company_object_download(jsonb,uuid,text)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_authorize_native_company_object_upload(jsonb,uuid,text,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);

	-- The member whole-tree lane (snapshots in the canonical workspace).
	perform pg_temp.c1c_guard('public.qorpera_prepare_company_file_revision(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_publish_company_file_revision(uuid,uuid,uuid)',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_prepare_company_file_proposal(uuid,uuid,uuid,text,integer,integer,integer,bigint)',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_submit_company_proposal(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,text,text,uuid[])',
		'if public.qorpera_environment_is_folder_v2(p_environment_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)',
		'if public.qorpera_company_is_folder_v2((select profile_id from public.qorpera_company_proposals where id = p_proposal_id)) '
		|| c_refuse);

	-- The approval and member-command actors: refused before their company fence.
	perform pg_temp.c1c_replace('public.qorpera_company_path_approved_actor(uuid,text)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_file.profile_id);',
		E'\tif v_file.core = ''folder-v2'' ' || c_refuse || E'\n\tperform public.qorpera_lock_profile_gc_fence(v_file.profile_id);', 1);
	perform pg_temp.c1c_replace('public.qorpera_member_company_path_command_actor(uuid,text,boolean)',
		E'\tperform public.qorpera_lock_profile_gc_fence(v_file.profile_id);',
		E'\tif v_file.core = ''folder-v2'' ' || c_refuse || E'\n\tperform public.qorpera_lock_profile_gc_fence(v_file.profile_id);', 1);

	-- The office's Company File transfers: the folder views replace them (C1b-3).
	perform pg_temp.c1c_guard('public.qorpera_native_office_company_file_source(jsonb,jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_confirm_office_company_file_import(jsonb,jsonb,jsonb,text,uuid,jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) ' || c_refuse);

	-- The runner broker's whole-tree lane and completion's legacy lane. Folder-v2 runs complete through C1c-2's lane.
	perform pg_temp.c1c_guard('public.qorpera_runner_broker_describe(uuid,text,uuid,text)',
		'if public.qorpera_job_is_folder_v2(p_job_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_runner_broker_authorize_input_object(uuid,text,uuid,text,text)',
		'if public.qorpera_job_is_folder_v2(p_job_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_complete_runner_job_v6(uuid,text,uuid,text,uuid,uuid,uuid,jsonb)',
		'if public.qorpera_job_is_folder_v2(p_job_id) ' || c_refuse);
	-- The runner's revision lane (a run's Company File snapshot, its object graph and its verification).
	perform pg_temp.c1c_guard(target::regprocedure, 'if public.qorpera_job_is_folder_v2(p_job_id) ' || c_refuse)
	from unnest(array[
		'public.qorpera_runner_prepare_company_revision(uuid,text,uuid,text,uuid,uuid,text,integer,integer,integer,bigint)',
		'public.qorpera_runner_begin_company_revision_graph(uuid,text,uuid,text,uuid,uuid,uuid,text,text,integer,bigint)',
		'public.qorpera_runner_append_company_revision_graph(uuid,text,uuid,text,uuid,uuid,jsonb)',
		'public.qorpera_runner_complete_company_revision_graph(uuid,text,uuid,text,uuid,uuid)',
		'public.qorpera_runner_company_revision_snapshot(uuid,text,uuid,text,uuid,uuid)',
		'public.qorpera_runner_authorize_company_revision_verification(uuid,text,uuid,text,uuid,uuid,uuid)',
		'public.qorpera_runner_finalize_company_revision_verification(uuid,text,uuid,text,uuid,uuid,uuid)',
		'public.qorpera_runner_broker_authorize_company_file_object(uuid,text,uuid,text,text,bigint,text)']) target;

	-- The snapshot bootstrap: folder-v2 companies are created by one commit (C2). The worker never claims their jobs,
	-- so one job left from before a company became folder-v2 cannot hold the queue.
	perform pg_temp.c1c_replace('public.qorpera_claim_company_bootstrap(uuid,integer)',
		E'\twhere job.state = ''queued'' or (job.state = ''leased'' and job.lease_expires_at <= clock_timestamp())\n',
		E'\twhere (job.state = ''queued'' or (job.state = ''leased'' and job.lease_expires_at <= clock_timestamp()))\n'
		|| E'\t\tand not public.qorpera_environment_is_folder_v2(job.environment_id)\n', 1);
	perform pg_temp.c1c_guard('public.qorpera_finalize_company_bootstrap(uuid,uuid,text,text,text,text,jsonb)',
		'if public.qorpera_environment_is_folder_v2((select environment_id from public.qorpera_company_bootstrap_jobs where id = p_job_id)) '
		|| c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_seed_company_cofounder(uuid,uuid)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);

	-- The pause: folder-v2 companies stop through qorpera_folder_pause (C1b-1), which drains effects.
	perform pg_temp.c1c_guard('public.qorpera_set_company_execution_pause(uuid,boolean,text)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);

	-- Old writers of company state as rows (contract 5.6): a folder-v2 index row changes only through its file.
	perform pg_temp.c1c_guard('public.qorpera_put_profile_staff(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_delete_profile_staff(uuid,uuid,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_put_staff_provider_model(uuid,uuid,text,text,bigint)',
		'if public.qorpera_company_is_folder_v2(p_profile_id) ' || c_refuse);
	perform pg_temp.c1c_guard('public.qorpera_confirm_agent_todo_publication(jsonb,jsonb)',
		'if public.qorpera_binding_is_folder_v2(p_binding) ' || c_refuse);
end $$;

-- 3. The Storage policies: a member never reads or writes a folder-v2 object in Storage directly. (An insert there is
-- recorded as a company object under the hash in its name, unchecked; C1d's upload intents replace it for folder-v2.)
alter policy qorpera_profile_objects_member_insert on storage.objects with check (
	bucket_id = 'qorpera-profile-objects'
	and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$'
	and public.qorpera_profile_object_writes_allowed((storage.foldername(name))[1]::uuid)
	and not public.qorpera_company_is_folder_v2((storage.foldername(name))[1]::uuid));
alter policy qorpera_profile_objects_member_read on storage.objects using (
	bucket_id = 'qorpera-profile-objects'
	and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}$'
	and public.qorpera_can_read_profile((storage.foldername(name))[1]::uuid)
	and not public.qorpera_company_uses_path_gateway((storage.foldername(name))[1]::uuid)
	and not public.qorpera_company_is_folder_v2((storage.foldername(name))[1]::uuid));
