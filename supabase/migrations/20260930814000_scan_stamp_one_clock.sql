do $$ begin
	if to_regprocedure('public.qorpera_folder_materialize_company(uuid,integer)') is null then
		raise exception '20260930814000 needs the folder materializer (20260928469310)'; end if;
	if position('v_scanned_at' in (select prosrc from pg_proc
			where oid = to_regprocedure('public.qorpera_folder_materialize_company(uuid,integer)'))) > 0 then
		raise exception '20260930814000 is already applied'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.scan_stamp_replace(p_function regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930814000 anchor differs in %: %', p_function, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.scan_stamp_replace('public.qorpera_folder_materialize_company(uuid,integer)'::regprocedure,
	$old$	update public.qorpera_session_turn_requests set admission_scan_at = clock_timestamp() where id = any(v_locked_requests);
	update public.qorpera_wake_occurrences set admission_scan_at = clock_timestamp() where id = any(v_locked_wakes);
$old$,
	$new$	declare v_scanned_at timestamptz := clock_timestamp();
	begin
		update public.qorpera_session_turn_requests set admission_scan_at = v_scanned_at where id = any(v_locked_requests);
		update public.qorpera_wake_occurrences set admission_scan_at = v_scanned_at where id = any(v_locked_wakes);
	end;
$new$);

drop function pg_temp.scan_stamp_replace(regprocedure, text, text);
