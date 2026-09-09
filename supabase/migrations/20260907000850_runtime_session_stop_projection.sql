-- Match the existing exact-run cancellation authority without broadening the
-- conversation audience. CREATE OR REPLACE preserves the deployed RPC ACL.
do $$
declare
 v_definition text:=pg_get_functiondef('public.qorpera_get_session_run_control(uuid)'::regprocedure);
 v_old text:='public.qorpera_can_write_session(v_session.id) and job.created_by_user_id = auth.uid()';
 v_new text:='public.qorpera_can_write_session(v_session.id) and (
   job.created_by_user_id = auth.uid() or exists (
    select 1 from public.qorpera_profile_members member
    where member.profile_id = v_session.profile_id and member.user_id = auth.uid()
     and member.role in (''owner'',''admin'')))';
begin
 if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
  raise exception 'Session cancellation projection differs'; end if;
 execute replace(v_definition,v_old,v_new);
end $$;
