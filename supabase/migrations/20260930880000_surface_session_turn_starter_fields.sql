-- WHY: the agent is shown the page its interface draws, and the page picks its starter layout from the row's icon,
-- is_global and archetype too; staging checks a layout on top of the session's own waiting changes to it.
set local lock_timeout = '3s';

do $$
declare
	v_def text;
begin
	if to_regprocedure('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)') is null then
		raise exception '20260930880000 requires 20260930844000, 20260930861000 and 20260930872000';
	end if;
	v_def := pg_get_functiondef('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure);
	if position('''surfaceKind'', v_surface.surface_kind' in v_def) = 0
		or position('## The conversation since this request' in v_def) = 0 then
		raise exception '20260930880000 requires 20260930861000 and 20260930872000';
	end if;
	if position('''surfaceIcon''' in v_def) > 0 then
		raise exception '20260930880000 is already applied';
	end if;
end $$;

create function pg_temp.sstsf_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_i integer := 1;
	v_hits integer;
begin
	if coalesce(array_length(p_pairs, 1), 0) = 0 or array_length(p_pairs, 1) % 2 <> 0 then
		raise exception '20260930880000: invalid replacement pairs for %', p_target;
	end if;
	while v_i <= array_length(p_pairs, 1) loop
		v_hits := (length(v_def) - length(replace(v_def, p_pairs[v_i], ''))) / length(p_pairs[v_i]);
		if v_hits <> 1 then
			raise exception '20260930880000: anchor matched % time(s) in %: %', v_hits, p_target, left(p_pairs[v_i], 120);
		end if;
		v_def := replace(v_def, p_pairs[v_i], p_pairs[v_i + 1]);
		v_i := v_i + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.sstsf_patch('public.qorpera_native_surface_read_session_turn(uuid,uuid,uuid)'::regprocedure, array[
$old$		'surfaceKind', v_surface.surface_kind,$old$,
$new$		'surfaceKind', v_surface.surface_kind,
		'surfaceIcon', v_surface.icon,
		'surfaceIsGlobal', v_surface.is_global,
		'surfaceArchetype', v_surface.archetype,
		'openLayoutOps', coalesce((
			select jsonb_agg(o.op order by c.seq, o.n)
			from public.qorpera_surface_changes c
			cross join lateral jsonb_array_elements(
				case when jsonb_typeof(c.patch_manifest) = 'array' then c.patch_manifest else '[]'::jsonb end
			) with ordinality as o(op, n)
			where c.session_id = v_session.id
				and c.kind = 'folder_patch'
				and c.status in ('staged', 'merging', 'conflicted')
				and right(coalesce(o.op ->> 'path', ''), 11) = 'layout.json'
		), '[]'::jsonb),$new$
]);

drop function pg_temp.sstsf_patch(regprocedure, text[]);
