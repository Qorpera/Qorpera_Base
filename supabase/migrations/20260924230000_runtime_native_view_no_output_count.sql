-- No count of tool outputs per model request (Jonas, 2026-09-24: no cap on a
-- run's work anywhere). The pinned Codex patch refused a request with 128 or
-- more tool outputs, or over 1 MiB of result text; this bundle's Codex build
-- lifts both and sends frames up to 64 MiB. The context view that records what
-- each request saw mirrored the 128 and bounded a view at 128 KiB. A view now
-- holds any number of outputs, and its row is bounded at 16 MiB (the size of
-- one Company File control request) as storage. Each output is still checked:
-- its call, kind, digest, size, read provenance and capture.

create function pg_temp.view_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'View bound change differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.view_patch('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)'::regprocedure,
	$old$	if jsonb_typeof(p_view) is distinct from 'object' or pg_column_size(p_view) > 131072$old$,
	$new$	if jsonb_typeof(p_view) is distinct from 'object' or pg_column_size(p_view) > 16777216$new$);
select pg_temp.view_patch('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)'::regprocedure,
	$old$	if jsonb_array_length(p_view -> 'outputs') > 128
		or (p_view ->> 'purpose' = 'prewarm'$old$,
	$new$	if (p_view ->> 'purpose' = 'prewarm'$new$);

do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_native_context_views_view_check'))
		is distinct from 'CHECK (((jsonb_typeof(view) = ''object''::text) AND (pg_column_size(view) <= 131072)))' then
		raise exception 'View bound change differs: qorpera_native_context_views_view_check'; end if;
end
$$;
alter table public.qorpera_native_context_views drop constraint qorpera_native_context_views_view_check,
	add constraint qorpera_native_context_views_view_check check (jsonb_typeof(view) = 'object' and pg_column_size(view) <= 16777216);
