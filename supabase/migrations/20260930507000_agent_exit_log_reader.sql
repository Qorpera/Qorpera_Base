-- Agent exit E10a: what a viewer may read of their company's agent exit log (contract, 2026-10-17 amendment "each
-- company sees its own agent exit log", item 3; deploy/first-node/RUNTIME-AGENT-EXIT.md §7).
--
-- qorpera_member_agent_exit_log_scope(company) is for authenticated callers only. The object gateway's member route
-- (E10b) calls it with the member's own token before it reads the log and again before it answers. It answers:
-- - for an owner or admin, {"scope":"company"}: every line of the company's machines, and the brake;
-- - for any other member, {"scope":"member","member":<their user id>}: the lines of the coding machines the agent
--   plug ties to them (the plug's `member`, the coding machine's member user id);
-- - for anyone else, 42501, as if the company were not there. For a company being deleted, 55000.
-- Membership is read without a lock, because this is a read. The company is the agent plug's `company`, which is the
-- profile id.

create function public.qorpera_member_agent_exit_log_scope(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user_id uuid := auth.uid();
	v_role public.qorpera_profile_role;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'The agent exit log is unavailable' using errcode = '42501'; end if;
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_company_id and member.user_id = v_user_id;
	if v_role is null then
		raise exception 'The agent exit log is unavailable' using errcode = '42501'; end if;
	if public.qorpera_company_deleting(p_company_id) then
		raise exception 'Company is being deleted' using errcode = '55000'; end if;
	if v_role in ('owner', 'admin') then
		return jsonb_build_object('scope', 'company'); end if;
	return jsonb_build_object('scope', 'member', 'member', v_user_id);
end
$$;

revoke all on function public.qorpera_member_agent_exit_log_scope(uuid) from public, anon, service_role;
grant execute on function public.qorpera_member_agent_exit_log_scope(uuid) to authenticated;
