-- A run's context shows its continuation's first 4 KiB again, as before 20260930617000 (perf sprint T7, 8 Nov 2026).
-- The tool boundary cuts webhook signing secrets (whsec_) out of every text tool result (E3c-2), and a continuation past
-- its first 4 KiB reached the model only as read_context pages, so cut. 617000 showed 16 KiB in the context itself, and
-- the context skips that cut: bytes 4 KiB to 16 KiB of a continuation, such as a command's output tail, went to the
-- provider in clear. Back at 4 KiB, the run reads the rest through read_context, cut, as it did before 617000. The
-- extra rounds that costs are accepted until the composer cuts the context itself (#1528); 16 KiB can come back then.
-- Only the continuation's excerpt changes: read_context, its pages and the other sources stay as they are, and every
-- runtime admits a 4 KiB excerpt, so no bundle has to go first.
set local lock_timeout = '3s';

do $body$
declare
	v_definition text := pg_get_functiondef('public.qorpera_describe_company_run_context(jsonb)'::regprocedure);
	v_old constant text := E'v_continuation := (v_source-''text'') || jsonb_build_object(''content'',\n'
		|| E'\t\t\t-- 20260930617000: 16 KiB, as a current input: the protocol has the run read all of it first.\n'
		|| E'\t\t\tpublic.qorpera_company_context_excerpt(v_source ->> ''text'',0,16384));';
	v_new constant text := E'v_continuation := (v_source-''text'') || jsonb_build_object(''content'',\n'
		|| E'\t\t\t-- 20260930657100: 4 KiB again: the rest comes through read_context, whose pages the tool boundary cuts\n'
		|| E'\t\t\t-- webhook signing secrets out of, and this context does not.\n'
		|| E'\t\t\tpublic.qorpera_company_context_excerpt(v_source ->> ''text'',0,4096));';
begin
	if strpos(v_definition, '20260930657100') > 0 then
		raise exception '20260930657100 is already applied'; end if;
	if (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 then
		raise exception '20260930657100 anchor differs in qorpera_describe_company_run_context'; end if;
	execute replace(v_definition, v_old, v_new);
end
$body$;
