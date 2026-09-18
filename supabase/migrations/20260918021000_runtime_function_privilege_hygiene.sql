-- Eight functions added on 16-17 September were granted to their intended role
-- but kept PostgreSQL's default PUBLIC execute right, so anon, authenticated and
-- the secret broker role could call them. Six are service-role operations (each
-- also checks its caller); two are trigger functions nobody calls directly.
revoke all on function public.qorpera_register_runtime_login_gateway(text,uuid,text),
	public.qorpera_replace_runtime_node_inventory(jsonb,text),
	public.qorpera_runtime_login_gateway_choose(),
	public.qorpera_runtime_node_placement_candidates(text),
	public.qorpera_runtime_node_placement_decide(uuid,text,text),
	public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)
	from public, anon, authenticated;
grant execute on function public.qorpera_register_runtime_login_gateway(text,uuid,text),
	public.qorpera_replace_runtime_node_inventory(jsonb,text),
	public.qorpera_runtime_login_gateway_choose(),
	public.qorpera_runtime_node_placement_candidates(text),
	public.qorpera_runtime_node_placement_decide(uuid,text,text),
	public.qorpera_runtime_node_placement_decide(uuid,text,text,uuid)
	to service_role;
revoke all on function public.qorpera_agent_thread_on_staff(), public.qorpera_agent_threads_on_member()
	from public, anon, authenticated, service_role;
