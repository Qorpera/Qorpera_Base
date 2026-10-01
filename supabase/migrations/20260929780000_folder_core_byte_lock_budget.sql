-- Core C1d: a lock budget for the folder byte functions (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §8; #560
-- review L2).
--
-- The object gateway gives a database call 5 s (boundedObjectOperation) and then opens its dependency circuit for
-- every company. The PostgREST role waits for a lock for up to 8 s (20260913000100), so a long lock wait in a folder
-- byte function outlived the gateway, and the gateway's 55P03 → 409 (one company's contention, not the database's
-- health) was never reached. A function-level lock_timeout is armed for each lock wait (20260913000100, test 360), so
-- 2 s ends a wait as 55P03 well inside the deadline: the gateway answers 409 and the runtime `contended`. It bounds
-- each wait, not their sum; today a byte function's locks are short (KEY SHARE on catalog rows, the intent's own rows),
-- and C1d-2's GC, which will hold catalog rows FOR UPDATE, is what this budget is for.
--
-- The runtime calls open, seal and renew through the Company File control, and the gateway authorize, confirm and the
-- download check: the same budget for all six. Only proconfig changes: the definitions, grants and the guards of
-- 20260929710000 (which read the definitions before this runs) are untouched. No lock is taken here beyond the
-- catalog's own for the ALTER.

set local lock_timeout = '3s';

alter function public.qorpera_folder_open_upload(uuid, jsonb, text) set lock_timeout = '2s';
alter function public.qorpera_folder_seal_upload(uuid, jsonb, uuid) set lock_timeout = '2s';
alter function public.qorpera_folder_renew_upload(uuid, jsonb, uuid) set lock_timeout = '2s';
alter function public.qorpera_folder_authorize_object_upload(uuid, jsonb, uuid, text, bigint) set lock_timeout = '2s';
alter function public.qorpera_folder_confirm_object(uuid, jsonb, uuid, text, bigint) set lock_timeout = '2s';
alter function public.qorpera_folder_authorize_object_download(uuid, jsonb, text) set lock_timeout = '2s';
