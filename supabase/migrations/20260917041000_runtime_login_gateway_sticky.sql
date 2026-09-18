-- 2026-09-17 amendment: a login stays on the node that holds its machine.
--
-- A node answers `preparing` while it boots or recovers a login machine, and
-- the member's client posts the same login again. The chooser ranked nodes
-- afresh on every post, and the machine the first post reserved changes that
-- ranking, so the second post could reach another node, which refuses it.
-- Once a login has an unreleased machine request, its gateway is that node's.

do $patch$
declare v_def text; v_old text; v_new text;
begin
	v_def := pg_get_functiondef('public.qorpera_runtime_login_gateway_choose(text)'::regprocedure);
	v_old := E'\tv_candidates := public.qorpera_runtime_node_placement_candidates(''login'');';
	v_new := E'\tif v_session.id is not null then\n'
		|| E'\t\tselect g.* into v_gateway from public.qorpera_runtime_login_machine_requests r\n'
		|| E'\t\t\tjoin public.qorpera_runtime_login_gateways g on g.provider_id = r.provider_adapter\n'
		|| E'\t\t\twhere r.login_session_id = v_session.id and r.released_at is null\n'
		|| E'\t\t\torder by r.requested_at desc limit 1;\n'
		|| E'\t\tif found then\n'
		|| E'\t\t\treturn jsonb_build_object(''url'', v_gateway.url, ''providerId'', v_gateway.provider_id, ''nodeId'', v_gateway.node_id,\n'
		|| E'\t\t\t\t''reason'', ''LOGIN_MACHINE'', ''identityHomes'', to_jsonb(v_homes));\n'
		|| E'\t\tend if;\n'
		|| E'\tend if;\n'
		|| v_old;
	if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
		raise exception 'login gateway chooser body differs'; end if;
	execute replace(v_def, v_old, v_new);
end
$patch$;
