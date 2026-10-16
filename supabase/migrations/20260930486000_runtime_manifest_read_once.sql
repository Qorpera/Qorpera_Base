-- The runtime manifest check reads the bundle's manifest out of TOAST once, not once per check (production DB slowness,
-- 16 October 2026).
--
-- qorpera_execution_runtime_manifest (20260924120000, with the fast-mode check of 20260927161500) runs under the run
-- mutex for every agent tool call (describe), every model request (the context fence) and every native launch, and in
-- both run-insert triggers. In the folder-core load run of 16 October (15:15Z, node 2) it was the costliest PL/pgSQL
-- function by its own time: 723 calls, 14.7 s, about 20 ms a call. On the production database a call took 22 to 41 ms.
--
-- The cost is the manifest's size: about 200 KB of jsonb (every bundled file's sha256), stored out of line in TOAST.
-- The function selects it into v_manifest and then reads v_manifest in 18 checks. In a function (an atomic context)
-- PL/pgSQL keeps only the TOAST pointer in the variable, so each check fetched the whole value from the TOAST table
-- again and decompressed it: 18 reads of 200 KB a call. The pointer is also what it returned, so describe, the launch
-- and the triggers fetched it again for their own checks.
--
-- The select now takes `manifest #> '{}'::text[]`: the empty path hands back the same value (jsonb_get_element returns
-- its input unchanged for an empty path), read out of TOAST once. v_manifest then holds the value in memory, every
-- check reads that, and the caller gets that copy. The bytes, the checks, their order, the errors, STABLE, SECURITY
-- DEFINER, search_path and the grants are as before (create or replace keeps the grants). The function is patched in
-- place from pg_get_functiondef, so the fast-mode check stays. DB only: no caller changes.
--
-- The implementation check (each bundled file's sha256 is 64 lowercase hex characters) is the same test written
-- without the bounded regex: `length(source.value) <> 64 or source.value ~ '[^0-9a-f]'` in place of
-- `source.value !~ '^[0-9a-f]{64}$'`. PostgreSQL builds the `{64}` regex's DFA states afresh for each value, about 4
-- microseconds each, so on about 1,500 entries it took about 6 ms a call, most of what was left after the single read;
-- the same test without the count took about 1 ms. NULL stays NULL, and nothing else changes: the components and
-- nativeBinarySha256 checks keep their regex.
set local lock_timeout = '3s';

create function pg_temp.h_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930486000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.h_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	'select manifest into v_manifest from public.qorpera_runtime_bundles',
	'-- 20260930486000: the empty path hands back the same manifest, read out of TOAST once; every check below and the '
	|| E'caller read this copy.\n'
	|| E'\tselect manifest #> \'{}\'::text[] into v_manifest from public.qorpera_runtime_bundles'
);

select pg_temp.h_replace(
	'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)',
	'or exists(select 1 from jsonb_each_text(v_manifest -> ''implementation'') source where source.value !~ ''^[0-9a-f]{64}$'') then',
	'-- 20260930486000: the same test as before without the bounded regex, whose states were built afresh for each value.'
	|| E'\n\t\t'
	|| 'or exists(select 1 from jsonb_each_text(v_manifest -> ''implementation'') source '
	|| 'where length(source.value) <> 64 or source.value ~ ''[^0-9a-f]'') then'
);

do $$
declare v_proc pg_proc;
begin
	select * into strict v_proc from pg_proc
	where oid = 'public.qorpera_execution_runtime_manifest(public.qorpera_execution_runs)'::regprocedure;
	if position('20260930486000' in v_proc.prosrc) = 0
		or position('select manifest #> ''{}''::text[] into v_manifest from public.qorpera_runtime_bundles' in v_proc.prosrc) = 0
		or position('select manifest into v_manifest' in v_proc.prosrc) > 0
		or position('where length(source.value) <> 64 or source.value ~ ''[^0-9a-f]'') then' in v_proc.prosrc) = 0
		or position('source.value !~ ''^[0-9a-f]{64}$''' in v_proc.prosrc) > 0
		or v_proc.provolatile <> 's' or not v_proc.prosecdef
		or v_proc.proconfig is distinct from array['search_path=""'] then
		raise exception '20260930486000: the manifest did not change as expected'; end if;
end $$;
