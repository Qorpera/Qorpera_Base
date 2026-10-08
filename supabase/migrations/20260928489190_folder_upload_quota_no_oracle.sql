-- Company folder core, SECURITY: an upload's soft quota no longer tells an actor whether the company stores a hash
-- (C1D §3: "an actor cannot learn that the company stores a hash it may not read"; found in #794's review, placed by
-- the coordinator on 4 October 2026).
--
-- qorpera_folder_authorize_object_upload checked the soft quota (23514) only for an object the catalog lacked
-- (20260928309710). Near the company's limit an actor learnt, from the hash alone, whether the company stored it: a
-- stored object was let through, any other refused. Now the quota is waived only for an object the actor possesses
-- already under this intent: `held` (open found it in the catalog and the actor may read it) or `put` (the actor put
-- it, so it has the bytes; a retried put). Either way it learns nothing new. Any other object is checked as a new
-- one, stored or not. A stored object the actor does not hold may then be refused
-- near the limit although storing it adds nothing: the price of not telling. The patched body carries the marker
-- 20260930062000. No new lock (plain reads, as before).

set local lock_timeout = '3s';

create function pg_temp.quota_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Upload quota anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.quota_replace('public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)'::regprocedure,
	$old$	if not exists (select 1 from public.qorpera_profile_objects where profile_id = v_intent.profile_id and sha256 = p_sha256) then
		perform public.qorpera_folder_storage_quota_check(v_intent.profile_id, p_bytes);
$old$,
	$new$	-- 20260930062000: the quota, unless the actor possesses the object already; never by whether the catalog has it.
	if not exists (select 1 from public.qorpera_folder_upload_intent_objects
		where intent_id = p_intent and sha256 = p_sha256 and bytes = p_bytes and (held or put)) then
		perform public.qorpera_folder_storage_quota_check(v_intent.profile_id, p_bytes);
$new$);

-- The deploy guard: the patched body carries the marker and no longer asks the catalog.
do $guard$
declare v_body text := (select prosrc from pg_proc
	where oid = 'public.qorpera_folder_authorize_object_upload(uuid,jsonb,uuid,text,bigint)'::regprocedure);
begin
	if strpos(v_body, '20260930062000') = 0 or strpos(v_body, 'qorpera_profile_objects') > 0 then
		raise exception 'The upload quota still depends on the catalog'; end if;
end $guard$;
