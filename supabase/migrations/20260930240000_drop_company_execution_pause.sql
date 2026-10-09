-- 20260930240000: the legacy sweep drops the snapshot-v1 founder pause. Members lost it on 24 September
-- (20260924080000 revoked it from every API role), and folder-v2 companies already refuse it (20260928259430, 0A000).
-- The operator stops a company through the folder core (qorpera_folder_pause, qorpera_folder_pause_drain and
-- qorpera_folder_resume), and so do the roll tool's emergency packets (scripts/runtime-roll.mjs, 90 and 93).
-- The pause rows stay: qorpera_folder_pause writes them, and every effect reads them through
-- qorpera_company_execution_paused.
drop function public.qorpera_set_company_execution_pause(uuid,boolean,text);
