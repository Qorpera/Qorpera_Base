-- The one call before each model request (qorpera_fence_native_context, 20260928339400) goes through the native host's
-- long entry point (the coordinator, 6 October 2026, after review r2 of control calls part 2, #839). Part 2 took the
-- host's stopwatch off the fence: a lost or late answer is asked again while the run's authority holds. The database
-- still cut each attempt at qorpera_native_host_call's 8 s statement budget (20260928409985), and an attempt it cancels
-- is asked again at the same length, so a fence that needed more than 8 s in the database never landed and the model
-- request ended at Codex's 10-minute backstop. Through qorpera_native_host_call_long the fence gets 25 s, as the lease
-- validator does. Its lock_timeout stays the entry point's 8 s.
--
-- The fence sets statement_timeout 25s for itself too, as the lease validator does (20260913000100): PostgREST applies a
-- called function's statement_timeout to its request, so a direct call gets the same budget, and every listed call keeps
-- the budget its own setting gives (20260928409985 item 4, test 792). Inside an entry point the entry point's budget
-- times the whole call.
--
-- The runtime calls the fence through the long entry point (NATIVE_HOST_CALLS in cloud-native-host-dispatch.ts) from
-- the same release. Each entry point refuses a call listed with the other budget, so a native host from before this
-- release has its fences refused (its turns end) once this migration is in: ship the migration and the runtime bundle in
-- one cut.
set local lock_timeout = '3s';

alter function public.qorpera_fence_native_context(uuid, jsonb, text[], jsonb) set statement_timeout = '25s';
update public.qorpera_native_host_calls set budget = 'long' where name = 'qorpera_fence_native_context';
