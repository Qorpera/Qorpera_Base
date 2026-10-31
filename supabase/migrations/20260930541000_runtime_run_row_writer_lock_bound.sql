-- A tool call's receipt begin and finish give up a wait for the run's budget row (the run mutex, qorpera_folder_tool_run)
-- after 3 s, as R1 (20260930540000) made the two reads do (item 7, 29 October 2026).
--
-- In production on 28 October (the DB stall lane's windows B and D) a run's calls waited 1 to 7.6 s for its row. The
-- runtime gave a receipt's begin and finish 5 s and never asked them again: one that waited longer failed its tool call
-- as "outcome unconfirmed", and a begin that went through after that left its receipt begun, its outcome unknown.
-- The runtime now asks a receipt's begin and finish again, with the same receipt, input and result, as it asks R1's reads
-- (cloud-native-tool-operations.ts): a late answer once its copy has ended, an answer that says the statement ended
-- (55P03, 57014, PGRST003; CloudControlRpcEnded, cloud-native-provider-service.ts) after a short pause. A repeat is safe:
-- the begin answers its key with the same receipt, the finish answers the same result again; a refusal (55000, 23505,
-- 42501, 22023) is never asked again. This migration makes such a copy end sooner: waiting for the row, it gives up after
-- 3 s and frees its connection, instead of after the native host entry point's 8 s.
--
-- The two, both through the native host (20260928409985):
--   - qorpera_folder_begin_run_receipt, which the legacy qorpera_begin_native_tool_operation hands every begin to
--     (20260928549110);
--   - qorpera_folder_complete_run_receipt, called by name for a folder commit's finish, and which the legacy
--     qorpera_complete_native_tool_operation hands every other finish to.
-- The folder core's own effects (a coworker message, a worker's cancel or archive, a hook; 20260928279580,
-- 20260928469130, 20260928499140, 20260928539100, 20260928539110) call both while they already hold the run's row, so
-- for them only the bound on the receipt's other lock waits changes, 3 s in place of their caller's.
--
-- How: a lock_timeout of their own, as in 20260930540000 (a function's lock_timeout holds for every lock wait inside it
-- from its entry, and wins over the entry point's 8 s there). Test 468 shows it on the run's row. The error stays 55P03;
-- every refusal, code and grant stays as it was. The tool steps themselves keep the entry point's 8 s: a 3 s bound there
-- would end a stall inside each tool's own step, a later change to decide on its own.
--
-- alter function keeps each function's body, grants and other settings (20260930539000's change to the begin stays). A
-- later create or replace of either function sets every setting again and must keep this one; test 468 checks it. No
-- database or role setting changes.
set local lock_timeout = '3s';

alter function public.qorpera_folder_begin_run_receipt(jsonb, uuid, text, text, text, boolean) set lock_timeout = '3s';
alter function public.qorpera_folder_complete_run_receipt(jsonb, uuid, text, jsonb, uuid) set lock_timeout = '3s';
