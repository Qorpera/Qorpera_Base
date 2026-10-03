-- 20260929070100: a busy shell keeps its agent's seat, as it keeps the
-- machine awake (20260929070000); one that only waits does neither (the
-- 2026-10-03 amendment "one idle rule for every machine"). Patched into
-- qorpera_runtime_office_screen_in_use (20260928237200) in place, after it:
-- a fresh shell-activity report for the screen, from the office's current
-- generation, means the screen is in use and cannot change hands.

create function pg_temp.office_shell_seat_patch(p_target regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text:=pg_get_functiondef(p_target);
begin
	if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
		raise exception 'Office shell seat integration differs: %',p_target; end if;
	execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.office_shell_seat_patch('public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure,
	$old$or exists(select 1 from public.qorpera_runtime_office_resources r where r.screen_id = p_screen.id and r.state <> 'drained')$old$,
	$new$or exists(select 1 from public.qorpera_runtime_office_resources r where r.screen_id = p_screen.id and r.state <> 'drained')
		-- A busy shell on the computer (20260929070100).
		or exists(select 1 from public.qorpera_runtime_office_shell_activity a
			join public.qorpera_runtime_offices o on o.id = a.office_id
			where a.screen_id = p_screen.id and a.computer_generation = o.generation and a.busy_until > clock_timestamp())$new$);

-- The seat function may have a private owner in production.
do $$ declare v_owner name; begin
	select pg_get_userbyid(proowner) into v_owner from pg_proc
		where oid='public.qorpera_runtime_office_screen_in_use(public.qorpera_runtime_office_screens)'::regprocedure;
	if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
		raise exception 'Office seat function has an API owner'; end if;
	if v_owner is distinct from current_user then
		execute format('grant select on public.qorpera_runtime_office_shell_activity to %I',v_owner); end if;
end $$;
