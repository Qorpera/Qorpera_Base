-- WHY: The Members page is gone (multiplayer in place, 23 Nov 2026): teammates stand in the rail's People and seats live
-- in Settings → Team, so no company gets the Members surface and the ones that have it keep it archived.
set local lock_timeout = '3s';

do $$ begin
	if to_regprocedure('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)') is null
		or to_regprocedure('public.qorpera_company_has_database(uuid)') is null then
		raise exception '20260930869000 requires 20260930859000';
	end if;
	if position('''members''' in pg_get_functiondef(
		'public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure
	)) = 0 then
		raise exception '20260930869000 is already applied';
	end if;
end $$;

create function pg_temp.rms_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930869000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930869000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.rms_patch('public.qorpera_service_bootstrap_company_surfaces(uuid,uuid)'::regprocedure, array[
$old$		(p_company_id, 'members', 'Members', 'operations', 'ops', 'members', 'active', 'members', 'native_ops', 'none', 120, p_creator_user_id),
$old$,
''
]);

update public.qorpera_surfaces
set status = 'archived', updated_at = clock_timestamp()
where surface_kind = 'members' and status <> 'archived';
