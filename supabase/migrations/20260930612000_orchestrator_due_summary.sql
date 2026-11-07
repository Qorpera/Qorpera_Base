-- 20260930612000: one call in place of ten on an orchestrator's idle pass (perf sprint D2, 7 Nov 2026).
-- Measured 7 Nov: two orchestrators make 0.64 reconcile passes a second. Each pass asks ten lists one by one: the eight
-- folder drains' due lists, the materializer's and the routine heads. Each ask is an edge function request, a control
-- check and two PostgREST transactions, so the two together spend about 6.4 requests a second on these lists, however
-- many companies there are, and almost every answer is an empty list. This function asks the same ten lists, in one
-- request, and says which have anything.
--
-- It decides nothing itself: every answer comes from the list the orchestrator would have read (limit 1), under the
-- same authority, so a list's own rules (paused, deleting, at zero, retry waits) stay in one place. A false only lets
-- the orchestrator leave that list out of this pass, and only while nothing has run earlier in the pass. A company's
-- step still goes through its own request and transaction. One list's error fails this call: the orchestrator then
-- waits before calling again (1 s, doubling to 5 minutes) and meanwhile asks the ten lists one by one, as before, where
-- each list has its own backoff.
--
-- A new drain does not have to be added here: the orchestrator asks any list this answer does not name.

set local lock_timeout = '3s';

create function public.qorpera_orchestrator_due_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Orchestrator due summary requires control-plane authority' using errcode = '42501'; end if;
	return jsonb_build_object(
		'workers', public.qorpera_folder_workers_due(null, 1) -> 'items' <> '[]'::jsonb,
		'listen', public.qorpera_folder_listen_due(null, 1) -> 'items' <> '[]'::jsonb,
		'human_tasks', public.qorpera_folder_human_tasks_due(null, 1) -> 'items' <> '[]'::jsonb,
		'machine_events', public.qorpera_folder_machine_events_due(null, 1) -> 'items' <> '[]'::jsonb,
		'office_wakes', public.qorpera_folder_office_wakes_due(null, 1) -> 'items' <> '[]'::jsonb,
		'machine_checkins', public.qorpera_folder_machine_checkins_due(null, 1) -> 'items' <> '[]'::jsonb,
		'coding_checkins', public.qorpera_folder_coding_checkins_due(null, 1) -> 'items' <> '[]'::jsonb,
		'events', public.qorpera_folder_event_wakes_due(null, 1) -> 'items' <> '[]'::jsonb,
		'materialize', public.qorpera_folder_materialize_due(null, 1) -> 'items' <> '[]'::jsonb,
		'routine_heads', public.qorpera_list_routine_schedule_heads(null, 1) -> 'items' <> '[]'::jsonb);
end $$;
revoke all on function public.qorpera_orchestrator_due_summary() from public, anon, authenticated;
grant execute on function public.qorpera_orchestrator_due_summary() to service_role;
