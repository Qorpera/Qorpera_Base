-- Extend the existing company admission revision to effect transactions.
-- A lock alone cannot invalidate a repeatable-read snapshot; stop and resume
-- must update the same persistent row that admission and effects lock.
create or replace function public.qorpera_lock_profile_gc_fence(p_profile_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.qorpera_profiles where id=p_profile_id for update;
 if not found then raise exception 'profile is unavailable' using errcode='42501'; end if;
 -- Lazy initialization also covers companies created after this migration.
 -- INSERT ON CONFLICT and the row lock both reject a concurrently newer row
 -- under repeatable read. Read committed waits for its current revision.
 insert into public.qorpera_company_wake_admission_fences(profile_id,revision) values(p_profile_id,1)
 on conflict(profile_id) do nothing;
 perform 1 from public.qorpera_company_wake_admission_fences where profile_id=p_profile_id for update;
end $$;

-- Locking a fresh revision is not itself the stop decision. Native effects
-- and the direct public-send RPC must check the pause after acquiring it.
do $$
declare v_definition text; v_old text; v_new text;
begin
 v_definition:=pg_get_functiondef('public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure);
 v_old:=E'\tperform public.qorpera_lock_profile_gc_fence(v_profile);';
 v_new:=v_old || E'\n\tif public.qorpera_company_execution_paused(v_profile) then\n\t\traise exception ''Company execution is paused'' using errcode=''55000''; end if;';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Native company fence differs'; end if;
 execute replace(v_definition,v_old,v_new);
 v_definition:=pg_get_functiondef('public.qorpera_send_runner_agent_message(uuid,text,uuid,text,uuid,text,text,text)'::regprocedure);
 v_old:=E'\tselect run.* into strict v_run from public.qorpera_execution_runs as run where run.id = v_job.run_id;';
 v_new:=v_old || E'\n\tperform public.qorpera_lock_profile_gc_fence(v_run.profile_id);\n\tif public.qorpera_company_execution_paused(v_run.profile_id) then\n\t\traise exception ''Company execution is paused'' using errcode=''55000''; end if;';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Public send company fence differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;

do $$
declare v_definition text:=pg_get_functiondef('public.qorpera_set_company_execution_pause(uuid,boolean,text)'::regprocedure);
 v_old text:=E'\tif v_was is distinct from p_paused then\n'; v_new text;
begin
 v_new:=v_old || E'\t\tupdate public.qorpera_company_wake_admission_fences set revision=revision+1 where profile_id=p_profile_id;\n';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Founder stop transition differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;
