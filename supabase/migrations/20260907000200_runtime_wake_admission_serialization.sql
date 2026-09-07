-- Operational serialization state, not a second wake queue or budget ledger.
-- Updating the row also rejects a stale repeatable-read admission snapshot.
create table public.qorpera_company_wake_admission_fences (
 profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
 revision bigint not null check(revision>0)
);
alter table public.qorpera_company_wake_admission_fences enable row level security;
revoke all on public.qorpera_company_wake_admission_fences from public,anon,authenticated,service_role,qorpera_secret_broker;

create function public.qorpera_serialize_wake_admission(p_profile_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
 -- Use the existing profile/File lock order. Producers that already hold
 -- other locks must retry rather than deadlock with a profile owner.
 perform 1 from public.qorpera_profiles where id=p_profile_id for update nowait;
 if not found then raise exception 'Wake company is unavailable' using errcode='42501'; end if;
 insert into public.qorpera_company_wake_admission_fences(profile_id,revision) values(p_profile_id,1)
 on conflict(profile_id) do update set revision=qorpera_company_wake_admission_fences.revision+1;
end $$;
revoke all on function public.qorpera_serialize_wake_admission(uuid) from public,anon,authenticated,service_role,qorpera_secret_broker;

do $$
declare v_definition text; v_old text; v_new text;
begin
 v_definition:=pg_get_functiondef('public.qorpera_pin_wake_occurrence()'::regprocedure);
 v_old:=E'begin\n';
 v_new:=v_old || E' perform public.qorpera_serialize_wake_admission(new.profile_id);\n';
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then raise exception 'Wake pin entry differs'; end if;
 execute replace(v_definition,v_old,v_new);
 -- Scheduled admissions acquire the profile before routine/cursor locks,
 -- so the second producer can wait, then observe the committed wake count.
 v_definition:=pg_get_functiondef('public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure);
 v_old:=E'\tselect routine.* into v_routine';
 v_new:=E'\tperform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_cloud_routines where id=p_routine_id));\n' || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then raise exception 'Schedule admission entry differs'; end if;
 execute replace(v_definition,v_old,v_new);
 -- Room posts acquire the same profile fence before room/session locks.
 v_definition:=pg_get_functiondef('public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure);
 v_old:=E'\tselect * into v_room from public.qorpera_company_rooms where id = p_room_id for share;';
 v_new:=E'\tperform public.qorpera_lock_profile_gc_fence((select profile_id from public.qorpera_company_rooms where id=p_room_id));\n' || v_old;
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then raise exception 'Room admission entry differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;
do $$ declare v_owner name; begin
 for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid=any(array[
  'public.qorpera_pin_wake_occurrence()'::regprocedure
 ]) loop
  if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then raise exception 'Wake pin has an API owner'; end if;
  execute format('grant execute on function public.qorpera_serialize_wake_admission(uuid) to %I',v_owner);
 end loop;
end $$;
