-- A run's context shows its continuation up to 16 KiB, as it shows a current input and a job description, not 4 KiB.
-- The protocol tells a run to read the whole continuation before anything else (delivery.beforeWork read_continuation),
-- and runs do: of 126 runs in 27 h to 7 Nov 2026, all 42 whose continuation passed 4 KiB read it with read_context, and
-- no other run called read_context. That is 130 model rounds of 2,710, about 4.3 s each, spent fetching text the run was
-- always going to read. At 16 KiB, 29 of the 42 need no such round, and the rest fewer. Only the first excerpt changes:
-- the run reads the same text, read_context and its pages stay as they are, and the runtime's source check already
-- admits 16 KiB for every source (cloud-native-company-context.ts contextSource), so no bundle has to go first.
set local lock_timeout = '3s';

do $body$
declare
	v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_old constant text := E'v_continuation := (v_source-''text'') || jsonb_build_object(''content'',\n'
		|| E'\t\t\tpublic.qorpera_company_context_excerpt(v_source ->> ''text'',0,4096));';
	v_new constant text := E'v_continuation := (v_source-''text'') || jsonb_build_object(''content'',\n'
		|| E'\t\t\t-- 20260930617000: 16 KiB, as a current input: the protocol has the run read all of it first.\n'
		|| E'\t\t\tpublic.qorpera_company_context_excerpt(v_source ->> ''text'',0,16384));';
begin
	if strpos(v_definition, '20260930617000') > 0 then
		raise exception '20260930617000 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930617000 anchor differs in qorpera_describe_company_run_context'; end if;
	execute replace(v_definition, v_old, v_new);
end
$body$;
