-- Company folder core, for F3 step 3 (writes through the mount; deploy/first-node/RUNTIME-FOLDER-WRITES.md, slice 3a):
-- an upload holds the bytes its actor put under its own earlier intents.
--
-- A machine sends a big file's chunks while the file is still being written, long before its manifest is known, each
-- under an intent of its own. When the file is closed, the folder service opens the file's intent with the whole
-- manifest. qorpera_folder_open_upload lists as present (held) only the objects the actor may already read, and no path
-- names those chunks yet, so every one would have to be put again.
--
-- Now open also holds an object the catalog has with the same size and that an unexpired intent of the same actor
-- (kind and scope) in the same environment has `put`: bytes the actor put itself, whose hash the gateway checked. That
-- is C1D §3's possession rule ("bytes it put under its own intent"), across the actor's intents. It tells the actor
-- nothing it did not know. The lock (FOR KEY SHARE in hash order, G1) and the GC mark check that follow are unchanged,
-- and an expired intent no longer counts, as it no longer roots the object (G4). No new lock: plain reads of the
-- actor's own intent rows. The patched body carries the marker 20260930083000.

set local lock_timeout = '3s';

create function pg_temp.own_puts_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Own puts anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.own_puts_replace('public.qorpera_folder_open_upload(uuid,jsonb,text)'::regprocedure,
	$old$				where v_actor ->> 'kind' = 'platform'
					or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', candidate.sha256)))$old$,
	$new$				where v_actor ->> 'kind' = 'platform'
					-- 20260930083000 (F3 3a): bytes this actor put under another of its own unexpired intents here.
					or exists (select 1 from public.qorpera_folder_upload_intent_objects own
						join public.qorpera_folder_upload_intents earlier on earlier.id = own.intent_id
						where own.profile_id = v_profile and own.sha256 = candidate.sha256 and own.put
							and earlier.id <> v_intent.id and earlier.environment_id = p_environment_id
							and earlier.actor_kind = v_intent.actor_kind and earlier.scope_id = v_intent.scope_id
							and earlier.expires_at > clock_timestamp())
					or public.qorpera_folder_object_readable(p_environment_id, v_profile, v_actor -> 'auth', candidate.sha256)))$new$);

-- The deploy guard: the patched body carries the marker.
do $guard$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_folder_open_upload(uuid,jsonb,text)'::regprocedure),
			'20260930083000') = 0 then
		raise exception 'An upload does not hold its actor''s own puts'; end if;
end $guard$;
