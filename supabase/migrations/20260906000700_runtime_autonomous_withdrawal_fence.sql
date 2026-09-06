-- A withdrawal invalidates every older autonomous sponsor pin, even after
-- later consent. The immutable version ledger is the revocation watermark.
alter table public.qorpera_provider_connections add column autonomous_consent_revision bigint not null default 0
	check (autonomous_consent_revision >= 0);

create function public.qorpera_provider_autonomous_authority(p_connection_id uuid,p_version bigint)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
	-- Serialize with consent and retain the lock until admission/effect commits.
	perform 1 from public.qorpera_provider_connections
	where id = p_connection_id and status = 'active' for share;
	if not found then return false; end if;
	return exists (select 1 from public.qorpera_provider_connection_versions
		where connection_id = p_connection_id and version = p_version
			and authorization_state = 'active' and allow_autonomous)
		and not exists (select 1 from public.qorpera_provider_connection_versions
			where connection_id = p_connection_id and version > p_version and not allow_autonomous);
end
$$;

create function public.qorpera_run_autonomous_authority(p_run public.qorpera_execution_runs)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_sponsor public.qorpera_execution_sponsor_versions%rowtype;
begin
	if p_run.source_kind in ('session_turn','room_delivery') then return true; end if;
	select * into v_sponsor from public.qorpera_execution_sponsor_versions
	where binding_id = p_run.sponsor_binding_id and version = p_run.sponsor_version;
	return coalesce(v_sponsor.allow_autonomous and public.qorpera_provider_autonomous_authority(
		v_sponsor.provider_connection_id,v_sponsor.provider_connection_version),false);
end
$$;

revoke all on function public.qorpera_provider_autonomous_authority(uuid,bigint),
	public.qorpera_run_autonomous_authority(public.qorpera_execution_runs)
	from public,anon,authenticated,service_role,qorpera_secret_broker;

create or replace function public.qorpera_consent_provider_connection_autonomous(
	p_profile_id uuid,p_connection_id uuid,p_allow_autonomous boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_connection public.qorpera_provider_connections%rowtype;
	v_version public.qorpera_provider_connection_versions%rowtype; v_next bigint;
begin
	if v_user is null or p_allow_autonomous is null then
		raise exception 'autonomous consent requires the connection owner' using errcode = '42501'; end if;
	perform 1 from public.qorpera_profile_members where profile_id = p_profile_id and user_id = v_user for share;
	if not found then raise exception 'autonomous consent requires current membership' using errcode = '42501'; end if;
	select * into v_connection from public.qorpera_provider_connections
	where id = p_connection_id and profile_id = p_profile_id and owner_user_id = v_user and status = 'active' for update;
	if not found then raise exception 'autonomous consent requires the connection owner' using errcode = '42501'; end if;
	select * into v_version from public.qorpera_provider_connection_versions
	where connection_id = v_connection.id order by version desc limit 1;
	if not found or v_version.authorization_state <> 'active' then
		raise exception 'provider connection has no active current version' using errcode = '55000'; end if;
	if v_version.allow_autonomous = p_allow_autonomous then
		return jsonb_build_object('schema','qorpera.provider-connection-consent/v1','connection_id',v_connection.id,
			'version',v_version.version,'allow_autonomous',v_version.allow_autonomous,'changed',false);
	end if;
	v_next := v_version.version + 1;
	insert into public.qorpera_provider_connection_versions
	select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
		to_jsonb(v_version) || jsonb_build_object('version',v_next,'allow_autonomous',p_allow_autonomous,
			'consented_by_user_id',v_user,'consent_version','qorpera-native-provider-autonomous-consent/v1',
			'created_at',clock_timestamp()))).*;
	-- A locking reader using an older repeatable-read snapshot must serialize
	-- or fail, rather than accept an old consent snapshot after this commits.
	update public.qorpera_provider_connections set autonomous_consent_revision = autonomous_consent_revision + 1
	where id = v_connection.id;
	return jsonb_build_object('schema','qorpera.provider-connection-consent/v1','connection_id',v_connection.id,
		'version',v_next,'allow_autonomous',p_allow_autonomous,'changed',true);
end
$$;

do $$
declare v_definition text; v_old text; v_new text; v_target regprocedure; v_owner name;
begin
	v_target := 'public.qorpera_execution_sponsor_available(public.qorpera_execution_runs)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	v_old := E'\t\t\tand connection.status = ''active''';
	v_new := v_old || E'\n\t\t\tand public.qorpera_run_autonomous_authority(p_run)';
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Sponsor availability upgrade source differs'; end if;
	execute replace(replace(v_definition,v_old,v_new),'STABLE SECURITY DEFINER','VOLATILE SECURITY DEFINER');
	v_target := 'public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	v_old := E'\tselect reservation.* into v_existing';
	v_new := E'\tif not public.qorpera_run_autonomous_authority(v_run) then return false; end if;\n' || v_old;
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Sponsor reservation upgrade source differs'; end if;
	execute replace(v_definition,v_old,v_new);
	v_target := 'public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	v_old := '(s.allow_autonomous or v_wake.wake_kind = ''room'')';
	v_new := '(v_wake.wake_kind = ''room'' or (s.allow_autonomous and public.qorpera_provider_autonomous_authority(s.provider_connection_id,s.provider_connection_version)))';
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Wake admission upgrade source differs'; end if;
	execute replace(v_definition,v_old,v_new);
	v_target := 'public.qorpera_create_member_execution_sponsor(uuid,uuid,uuid,bigint,boolean)'::regprocedure;
	v_definition := pg_get_functiondef(v_target);
	v_old := 'and not v_version.allow_autonomous';
	v_new := 'and not public.qorpera_provider_autonomous_authority(p_provider_connection_id,p_provider_connection_version)';
	if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
		raise exception 'Member sponsor upgrade source differs'; end if;
	execute replace(v_definition,v_old,v_new);
	for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
		'public.qorpera_execution_sponsor_available(public.qorpera_execution_runs)'::regprocedure,
		'public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
		'public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
		'public.qorpera_create_member_execution_sponsor(uuid,uuid,uuid,bigint,boolean)'::regprocedure
	]) loop
		if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
			raise exception 'Consent authority is owned by an API role'; end if;
		execute format('grant execute on function public.qorpera_provider_autonomous_authority(uuid,bigint),public.qorpera_run_autonomous_authority(public.qorpera_execution_runs) to %I',v_owner);
	end loop;
end
$$;
