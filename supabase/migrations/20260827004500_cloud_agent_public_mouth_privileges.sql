-- Supabase may grant EXECUTE directly to API roles through default privileges.
-- Revoking PUBLIC alone does not remove those grants. The native host and
-- runner broker are the only callers of the public mouth; clients only read
-- its canonical events. Keep the effect-time authority checks as a second gate.
revoke all on function public.qorpera_send_runner_agent_message(uuid, text, uuid, text, uuid, text, text, text)
	from public, anon, authenticated;
revoke all on function public.qorpera_send_native_agent_message(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text)
	from public, anon, authenticated;
revoke all on function public.qorpera_enforce_agent_send_event()
	from public, anon, authenticated, service_role;
revoke all on function public.qorpera_require_final_agent_send()
	from public, anon, authenticated, service_role;

grant execute on function public.qorpera_send_runner_agent_message(uuid, text, uuid, text, uuid, text, text, text)
	to service_role;
grant execute on function public.qorpera_send_native_agent_message(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text)
	to service_role;
