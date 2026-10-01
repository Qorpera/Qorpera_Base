-- Core C1d: a lock budget for the folder byte functions (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §8; #560
-- review L2).
--
-- The object gateway gives a database call 5 s (boundedObjectOperation) and then opens its dependency circuit for
-- every company; the runtime gives its Company File control calls 3 s. The PostgREST role waits for a lock for up to
-- 8 s (20260913000100), so a long lock wait in a folder byte function outlived both, and the gateway's 55P03 → 409
-- (one company's contention, not the database's health) was never reached. A function-level lock_timeout is armed for
-- each lock wait, nested calls and triggers included (20260913000100, test 360), so 2 s ends a wait as 55P03 inside
-- both deadlines: the gateway answers 409 and the runtime reads `contended`. It bounds each wait, not their sum; today
-- a byte function's locks are short (KEY SHARE on catalog rows, the intent's own rows), and C1d-2's GC, which will
-- hold catalog rows FOR UPDATE, is what this budget is for.
--
-- The runtime calls open, seal and renew through the Company File control; the gateway calls authorize, confirm, the
-- download check and, for a folder-v2 company's replication, qorpera_folder_authorize_replication (through
-- qorpera_authorize_profile_object_replication and the replica confirm). The same budget for all seven. Replication
-- needs #573: with it, the gateway reads a lock timeout there as a lock conflict (503, the object kept pending, its
-- circuit closed); without it the 55P03 is a 500 that opens the circuit, so a 2–5 s wait that used to succeed would
-- now fail. This migration is meant to ship with or after #573.
--
-- Only proconfig changes: the definitions and grants stay, and the guards of 20260928309710 (which read the
-- definitions before this runs) are untouched. A later `create or replace` of any of these must repeat
-- `set lock_timeout = '2s'` (761 §8b checks it). No lock is taken here beyond the catalog's own for the ALTERs.

set local lock_timeout = '3s';

alter function public.qorpera_folder_open_upload(uuid, jsonb, text) set lock_timeout = '2s';
alter function public.qorpera_folder_seal_upload(uuid, jsonb, uuid) set lock_timeout = '2s';
alter function public.qorpera_folder_renew_upload(uuid, jsonb, uuid) set lock_timeout = '2s';
alter function public.qorpera_folder_authorize_object_upload(uuid, jsonb, uuid, text, bigint) set lock_timeout = '2s';
alter function public.qorpera_folder_confirm_object(uuid, jsonb, uuid, text, bigint) set lock_timeout = '2s';
alter function public.qorpera_folder_authorize_object_download(uuid, jsonb, text) set lock_timeout = '2s';
alter function public.qorpera_folder_authorize_replication(uuid, text, bigint) set lock_timeout = '2s';
