-- The two reads the runtime asks again that take the run's budget row (the run mutex, qorpera_folder_tool_run) give up
-- a wait for it after 3 s (R1, 28 October 2026).
--
-- In production on 28 October (the DB stall lane's windows B and D) one run's calls queued 11 to 14 deep on its budget
-- row for 1 to 7.6 s each, and PostgREST's pool ran out (PGRST003, 18:22Z). The runtime sent the run's admission and its
-- context read together, and asked a read again when its answer was late while the first copy still waited for the row.
-- The runtime now sends them one after the other and asks a read of the row again only once the copy it replaces has
-- ended (cloud-native-tool-authority.ts). This migration makes such a copy end sooner: a read waiting for the row gives
-- up after 3 s and frees its connection, instead of after the native host entry point's 8 s.
--
-- The two reads, both through the native host (20260928409985):
--   - qorpera_folder_assert_run_reads, the folder-v2 context read check (qorpera_assert_company_path_reads, before
--     every tool call, and inside the fence). It is a read; the escalation list reads it too, for a binding.
--   - qorpera_fence_native_context, the one call before each model request, on the long entry point. It records the
--     request's view in its own transaction; a refusal or a lock error records nothing.
--
-- How: a lock_timeout of their own. A function's lock_timeout holds for every lock wait inside it from its entry, and
-- wins over the entry point's 8 s there; statement_timeout set inside a function does not cut the statement already
-- running (the bound armed when the statement started holds). Test 467 shows both on the run's row. The error stays
-- 55P03, which the runtime already asks again (F1, cloud-control-errors.ts); every refusal, code and grant stays as it
-- was. The writers (tool steps, begin and finish) keep the entry point's 8 s: shortening their wait changes tool
-- outcomes, a later change to decide on its own.
--
-- alter function keeps each function's body, grants and other settings (the fence's statement_timeout of 25 s,
-- 20260928509130). A later create or replace of either function sets every setting again and must keep this one; test
-- 467 checks it. No database or role setting changes.
set local lock_timeout = '3s';

alter function public.qorpera_folder_assert_run_reads(uuid, jsonb, text[]) set lock_timeout = '3s';
alter function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb) set lock_timeout = '3s';
