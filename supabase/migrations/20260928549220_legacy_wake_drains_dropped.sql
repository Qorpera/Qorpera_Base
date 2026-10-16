-- 20260930295000: the legacy sweep, step F3b (the legacy wake drains and materializers). The snapshot-v1 multi-company
-- loops that turned queued work into runs go (folder-v2 only, the founder's decision of 3 October). Each skipped every
-- folder-v2 row in its scan since C1c-2c (656 §7 checked that), and P28a (20260930018000) took the materializers out of
-- the orchestrator's reconcile, so nothing calls them: no other live function, no cron job and no runtime code.
-- Folder-v2's work comes from the folder drains and qorpera_folder_materialize_company, which stay.
-- Dropped, callers before callees:
-- 1. qorpera_materialize_wake_execution_runs, the wake materializer, which ran the five drains below first.
-- 2. The drains: Company File wakes (with its before-lifecycle half), event listener wakes, machine events, office
--    activation waiters and worker revivals.
-- 3. The other materializers: session conversations, session turn requests and Company proposal reviews.
-- 4. Their helpers: qorpera_restore_dynamic_routine_runs (the dynamic routines' legacy tick, read only by the Company
--    File drain; folder-v2's is qorpera_folder_restore_dynamic_routine_run), both qorpera_wake_public_session overloads
--    (folder-v2's is qorpera_folder_wake_public_session) and qorpera_serialize_wake_admission (the old wake admission
--    lock; folder-v2's is qorpera_folder_admit_wakes).
-- The tables they scanned stay: their folder-v2 rows are the folder drains' (the schema is the sweep's step G).
set local lock_timeout = '3s';

-- 1. The wake materializer. --------------------------------------------------------------------------------------------

drop function public.qorpera_materialize_wake_execution_runs(integer);

-- 2. The drains. -------------------------------------------------------------------------------------------------------

drop function public.qorpera_drain_company_file_wakes(integer);
drop function public.qorpera_drain_company_file_wakes_before_lifecycle(integer);
drop function public.qorpera_drain_event_wakes(integer);
drop function public.qorpera_drain_machine_wakes(integer);
drop function public.qorpera_drain_office_activation_wakes(integer);
drop function public.qorpera_drain_worker_wakes(integer);

-- 3. The other materializers. ------------------------------------------------------------------------------------------

drop function public.qorpera_materialize_session_execution_runs(integer);
drop function public.qorpera_materialize_session_turn_requests(integer);
drop function public.qorpera_materialize_company_proposal_review_runs(integer);

-- 4. Their helpers. ----------------------------------------------------------------------------------------------------

drop function public.qorpera_restore_dynamic_routine_runs();
drop function public.qorpera_wake_public_session(uuid, uuid, uuid, uuid);
drop function public.qorpera_wake_public_session(uuid, uuid, uuid);
drop function public.qorpera_serialize_wake_admission(uuid);
