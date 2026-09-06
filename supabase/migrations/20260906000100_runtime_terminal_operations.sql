-- A missing, accepted, or no-longer-offered dispatch claim cannot be released
-- by retrying the same transaction. PostgREST retries serialization failures,
-- so preserve the release guards and report terminal application state.
do $$
declare
	v_target regprocedure := 'public.qorpera_release_runner_job_claim(uuid,uuid,uuid,text)'::regprocedure;
	v_definition text := pg_get_functiondef(v_target);
	v_old text;
begin
	foreach v_old in array array[
		'raise exception ''runner claim is unavailable'' using errcode = ''40001'';',
		'raise exception ''runner claim is already owned by a runner'' using errcode = ''40001'';',
		'raise exception ''runner assignment is unavailable'' using errcode = ''40001'';'
	] loop
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
			raise exception 'Terminal release function differs from its approved upgrade source';
		end if;
		v_definition := replace(v_definition, v_old, replace(v_old, '''40001''', '''55000'''));
	end loop;
	execute v_definition;
end
$$;

-- Contributions are append-only. A stale count cannot become current again
-- by retrying the same page/resolution request; the recipient must reread.
do $$
declare
	v_target regprocedure;
	v_definition text;
	v_old text;
begin
	for v_target, v_old in select * from (values
		('public.qorpera_list_responsibility_escalations(uuid,jsonb,uuid,uuid,integer,bigint)'::regprocedure,
			'raise exception ''Escalation contributions changed; reread from the beginning'' using errcode=''40001'';'),
		('public.qorpera_resolve_responsibility_escalation(uuid,jsonb,uuid,text,bigint)'::regprocedure,
			'raise exception ''Escalation contributions changed before resolution'' using errcode=''40001'';')
	) expected(target, old_statement) loop
		v_definition := pg_get_functiondef(v_target);
		if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
			raise exception 'Terminal escalation function differs from its approved upgrade source';
		end if;
		execute replace(v_definition, v_old, replace(v_old, '''40001''', '''55000'''));
	end loop;
end
$$;
