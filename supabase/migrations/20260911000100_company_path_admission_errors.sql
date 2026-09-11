-- Unknown environments and nonmembers are authorization denials. Reporting
-- them as storage failures opens the shared gateway dependency circuit and
-- briefly blocks unrelated authorized reads. Keep the existing locked member
-- recheck and all availability checks for callers with company membership.
do $$
declare
	v_definition text := pg_get_functiondef('public.qorpera_company_path_actor(uuid,jsonb)'::regprocedure);
	v_old text := E'\tif not found or v_file.path_gateway_version is distinct from 1';
	v_new text := E'\tif not found or not exists (select 1 from public.qorpera_profile_members\n'
		|| E'\t\twhere profile_id = v_file.profile_id and user_id = v_user) then\n'
		|| E'\t\traise exception ''Company File authority is unavailable'' using errcode = ''42501''; end if;\n'
		|| E'\tif v_file.path_gateway_version is distinct from 1';
begin
	if strpos(v_definition,v_new) > 0 and strpos(v_definition,v_old) = 0 then return; end if;
	if (length(v_definition)-length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
		raise exception 'Company File admission precondition differs'; end if;
	execute replace(v_definition,v_old,v_new);
end
$$;
