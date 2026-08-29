-- Runtime Step 2: move secret-broker authority out of Supabase service_role.
--
-- This upgrade is intentionally compatible with the isolated preview that
-- applied the first cloud-secret-custody migration before the dedicated login
-- was introduced. Fresh databases already contain the hardened function bodies;
-- older previews are upgraded only when their guard is the exact known prior
-- guard. Any other function body fails closed instead of being rewritten.

do $$
begin
	if not exists (select 1 from pg_roles where rolname = 'qorpera_secret_broker') then
		create role qorpera_secret_broker
			nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
	end if;
end
$$;

do $$
declare
	v_definition text;
	v_old_guard text;
	v_interim_guard text;
	v_new_guard text;
	v_target regprocedure;
begin
	foreach v_target in array array[
		'public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)'::regprocedure,
		'public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)'::regprocedure,
		'public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)'::regprocedure
	] loop
		v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
		v_interim_guard := 'if current_user <> ''qorpera_secret_broker'' then';
		v_new_guard := 'if session_user <> ''qorpera_secret_broker'' then';
		v_definition := pg_get_functiondef(v_target);
		if position(v_new_guard in v_definition) > 0 then
			continue;
		end if;
		if position(v_interim_guard in v_definition) > 0 then
			execute replace(v_definition,v_interim_guard,v_new_guard);
			continue;
		end if;
		if position(v_old_guard in v_definition) = 0 then
			raise exception 'cloud secret broker function differs from its approved upgrade source: %', v_target;
		end if;
		execute replace(v_definition,v_old_guard,v_new_guard);
	end loop;

	v_target := 'public.qorpera_native_connector_locked_grant(jsonb,uuid)'::regprocedure;
	v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
	v_interim_guard := 'if auth.role() is distinct from ''service_role'' and current_user <> ''qorpera_secret_broker'' then';
	v_new_guard := 'if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		if position(v_interim_guard in v_definition) > 0 then
			execute replace(v_definition,v_interim_guard,v_new_guard);
		elsif position(v_old_guard in v_definition) > 0 then
			execute replace(v_definition,v_old_guard,v_new_guard);
		else
			raise exception 'native connector grant differs from its approved upgrade source';
		end if;
	end if;

	v_target := 'public.qorpera_native_tool_locked_run(jsonb)'::regprocedure;
	v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
	v_new_guard := 'if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		if position(v_old_guard in v_definition) = 0 then
			raise exception 'native tool binding validator differs from its approved upgrade source';
		end if;
		execute replace(v_definition,v_old_guard,v_new_guard);
	end if;

	v_target := 'public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure;
	v_old_guard := 'if auth.role() is distinct from ''service_role'' then';
	v_new_guard := 'if auth.role() is distinct from ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		if position(v_old_guard in v_definition) = 0 then
			raise exception 'native provider lease validator differs from its approved upgrade source';
		end if;
		execute replace(v_definition,v_old_guard,v_new_guard);
	end if;

	v_target := 'public.qorpera_validate_native_provider_execution_lease_before_recovery(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure;
	v_old_guard := 'if auth.role() <> ''service_role'' then';
	v_new_guard := 'if auth.role() <> ''service_role'' and session_user <> ''qorpera_secret_broker'' then';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		if position(v_old_guard in v_definition) = 0 then
			raise exception 'native provider lease base validator differs from its approved upgrade source';
		end if;
		execute replace(v_definition,v_old_guard,v_new_guard);
	end if;

	v_target := 'public.qorpera_runner_broker_job(uuid,text,uuid,text)'::regprocedure;
	v_old_guard := 'if auth.role() <> ''service_role''';
	v_new_guard := 'if auth.role() <> ''service_role'' and session_user <> ''qorpera_secret_broker''';
	v_definition := pg_get_functiondef(v_target);
	if position(v_new_guard in v_definition) = 0 then
		if position(v_old_guard in v_definition) = 0 then
			raise exception 'runner broker job validator differs from its approved upgrade source';
		end if;
		execute replace(v_definition,v_old_guard,v_new_guard);
	end if;
end
$$;

do $$
begin
	if exists (
		select 1 from pg_roles
		where rolname = 'qorpera_secret_broker'
			and (rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
	) or not exists (select 1 from pg_roles where rolname = 'qorpera_secret_broker') then
		raise exception 'cloud secret broker role has unsafe attributes';
	end if;
end
$$;

revoke all on table public.qorpera_cloud_secret_broker_authorities from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_connector_operations from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secrets from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_versions from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_capture_tickets from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_operation_grants from qorpera_secret_broker;
revoke all on table public.qorpera_cloud_secret_audit_events from qorpera_secret_broker;
revoke all on sequence public.qorpera_cloud_secret_audit_events_id_seq from qorpera_secret_broker;

revoke all on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_native_connector_locked_grant(jsonb,uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_native_tool_locked_run(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_validate_native_provider_execution_lease(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)
	from public, anon, authenticated, qorpera_secret_broker;
revoke all on function public.qorpera_validate_native_provider_execution_lease_before_recovery(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_runner_broker_job(uuid,text,uuid,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant usage on schema public to qorpera_secret_broker;
grant execute on function public.qorpera_describe_cloud_secret_capture(uuid,text,uuid,text)
	to qorpera_secret_broker;
grant execute on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text)
	to qorpera_secret_broker;
grant execute on function public.qorpera_authorize_cloud_secret_operation(uuid,text,jsonb,uuid,text,text,uuid,text,text,bigint,text,text)
	to qorpera_secret_broker;
