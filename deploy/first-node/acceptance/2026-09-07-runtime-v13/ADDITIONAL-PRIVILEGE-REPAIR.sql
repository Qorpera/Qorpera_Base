-- Restore the existing source permission on the room-posting entrypoint.
-- Exact body, owner and ACL guards reject drift and replay; no ledger or body changes.
do $acl_reconcile$
declare target regprocedure := 'public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint)'::regprocedure;
begin
 if encode(extensions.digest(pg_get_functiondef(target),'sha256'),'hex') <> '547fe87d2e5a53074d4432896d91825d846f197bb34038d91e7956a62b1be500'
  or (select pg_get_userbyid(proowner) from pg_proc where oid=target) <> 'postgres'
  or (select proacl::text from pg_proc where oid=target) <> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
  raise exception 'Runtime privilege prestate differs'; end if;
 revoke execute on function public.qorpera_post_company_room_message(uuid,uuid,jsonb,uuid,bigint) from service_role;
 if (select proacl::text from pg_proc where oid=target) <> '{postgres=X/postgres,authenticated=X/postgres}'
  or encode(extensions.digest(pg_get_functiondef(target),'sha256'),'hex') <> '547fe87d2e5a53074d4432896d91825d846f197bb34038d91e7956a62b1be500' then
  raise exception 'Runtime privilege poststate differs'; end if;
end $acl_reconcile$;
