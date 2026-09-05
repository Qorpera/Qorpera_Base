-- Composed with the disposable wake fixture's verified-object storage helpers.
-- No production cache is read or repaired by this regression.
do $$
declare v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_entry jsonb; v_sha text; v_objects jsonb; v_kind text;
begin
	v_entry := pg_temp.path_stage_file('closure-proof.md','Exact closure membership');
	v_sha := v_entry #>> '{file,manifestSha256}';
	select objects into strict v_objects from public.qorpera_verified_company_file_objects
	where profile_id=v_profile and manifest_sha256=v_sha and verifier_version=1;
	if jsonb_array_length(v_objects) <> 2 then raise exception 'Closure fixture must contain two distinct objects'; end if;
	update public.qorpera_verified_company_file_objects set objects=(
		select jsonb_agg(value order by ordinal desc) from jsonb_array_elements(v_objects) with ordinality item(value,ordinal))
	where profile_id=v_profile and manifest_sha256=v_sha and verifier_version=1;
	if pg_temp.path_stage_file('closure-proof.md','Exact closure membership') <> v_entry then
		raise exception 'Reverification changed the immutable file reference'; end if;
	if (select objects from public.qorpera_verified_company_file_objects
		where profile_id=v_profile and manifest_sha256=v_sha and verifier_version=1) <> v_objects then
		raise exception 'Equivalent closure was not normalized'; end if;
	foreach v_kind in array array['missing-object','different-bytes','additional-object','manifest-bytes'] loop
		begin
			update public.qorpera_verified_company_file_objects
			set objects=case v_kind
				when 'missing-object' then objects - 0
				when 'different-bytes' then jsonb_set(objects,'{0,bytes}',to_jsonb((objects #>> '{0,bytes}')::bigint + 1))
				when 'additional-object' then objects || jsonb_build_array(jsonb_build_object('sha256',repeat('e',64),'bytes',1))
				else objects end,
				manifest_bytes=manifest_bytes + case when v_kind='manifest-bytes' then 1 else 0 end
			where profile_id=v_profile and manifest_sha256=v_sha and verifier_version=1;
			begin
				perform pg_temp.path_stage_file('closure-proof.md','Exact closure membership');
				raise exception 'Reverification accepted %',v_kind;
			exception when unique_violation then
				if sqlerrm <> 'Company File verification differs' then raise; end if;
			end;
			raise exception using errcode='QTCLO';
		exception when sqlstate 'QTCLO' then null; end;
	end loop;
	if pg_temp.path_stage_file('closure-proof.md','Exact closure membership') <> v_entry then
		raise exception 'Rejected repair changed the cache'; end if;
end
$$;
