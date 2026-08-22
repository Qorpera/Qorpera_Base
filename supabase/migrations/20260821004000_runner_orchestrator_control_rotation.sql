-- Replay-safe control-session rotation for continuously deployed orchestrators.
-- The orchestrator persists the next plaintext token locally before presenting
-- only its hash here. Exact replay under the newly installed token recovers a
-- lost HTTP response without requiring a desktop or service-role secret.

create function public.qorpera_rotate_runner_orchestrator_control(
	p_orchestrator_id uuid,
	p_presented_token_sha256 text,
	p_next_token_sha256 text,
	p_control_token_seconds integer default 604800
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_orchestrator public.qorpera_runner_orchestrators%rowtype;
begin
	if auth.role() <> 'service_role' or p_orchestrator_id is null
		or p_presented_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_next_token_sha256 !~ '^[0-9a-f]{64}$'
		or p_control_token_seconds not between 300 and 604800 then
		raise exception 'orchestrator control rotation is invalid' using errcode = '42501';
	end if;
	select orchestrator.* into v_orchestrator
	from public.qorpera_runner_orchestrators as orchestrator
	where orchestrator.id = p_orchestrator_id
	for update;
	if not found or v_orchestrator.status not in ('active', 'draining')
		or v_orchestrator.control_token_expires_at <= statement_timestamp() then
		raise exception 'orchestrator control rotation is unavailable' using errcode = '42501';
	end if;
	if v_orchestrator.control_token_sha256 = p_next_token_sha256 then
		if p_presented_token_sha256 <> p_next_token_sha256 then
			raise exception 'orchestrator control rotation replay is invalid' using errcode = '42501';
		end if;
	elsif v_orchestrator.control_token_sha256 = p_presented_token_sha256 then
		update public.qorpera_runner_orchestrators
		set control_token_sha256 = p_next_token_sha256,
			control_token_expires_at = statement_timestamp()
				+ make_interval(secs => p_control_token_seconds),
			last_heartbeat_at = statement_timestamp()
		where id = v_orchestrator.id
		returning * into v_orchestrator;
	else
		raise exception 'orchestrator control rotation is unavailable' using errcode = '42501';
	end if;
	return jsonb_build_object(
		'orchestrator_id', v_orchestrator.id,
		'status', v_orchestrator.status,
		'control_token_expires_at', v_orchestrator.control_token_expires_at
	);
end
$$;

revoke all on function public.qorpera_rotate_runner_orchestrator_control(uuid, text, text, integer) from public;
grant execute on function public.qorpera_rotate_runner_orchestrator_control(uuid, text, text, integer) to service_role;
