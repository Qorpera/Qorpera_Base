-- Company folder core, SECURITY: the bytes check decides possession before it calls a reference malformed (C1D §3:
-- "an actor cannot learn that the company stores a hash it may not read"; found in P17's review, 4 October 2026).
--
-- qorpera_folder_file_bytes_problem raised 22023 "File reference does not match its manifest" as soon as it found a
-- version-2 proof whose media type or executable bit differed from the reference, before it checked that the actor
-- holds the bytes. So anyone who knew a file's manifest hash, file hash and size could learn whether the company stores
-- it: the right hashes under a wrong media type raised 22023, any other reference came back bytes_unverified. Now the
-- check comes after the possession check: an actor who does not hold the bytes gets bytes_unverified whatever the media
-- type, and a holder (the platform included) still gets 22023 for a reference that disagrees with its manifest.
--
-- Two anchored replacements; the catalog check between them is untouched (S3's P24d patches it, in either order).
-- No new lock. The patched body carries the marker 20260930043000.

set local lock_timeout = '3s';

create function pg_temp.oracle_replace(p_target regprocedure, p_old text, p_new text) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Bytes-check anchor found % time(s) in %, expected 1: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The disagreement check leaves its place after the proof lookup ...
select pg_temp.oracle_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure,
	$old$	if v_proof.verifier_version = 2 and (v_proof.media_type is distinct from p_file ->> 'mediaType'
		or v_proof.executable is distinct from (p_file ->> 'executable')::boolean) then
		raise exception 'File reference does not match its manifest' using errcode = '22023'; end if;
$old$,
	'');

-- ... and comes last, once the actor is known to hold the bytes.
select pg_temp.oracle_replace('public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure,
	$old$	return null;
end$old$,
	$new$	-- 20260930043000: only a holder learns that a reference disagrees with its manifest.
	if v_proof.verifier_version = 2 and (v_proof.media_type is distinct from p_file ->> 'mediaType'
		or v_proof.executable is distinct from (p_file ->> 'executable')::boolean) then
		raise exception 'File reference does not match its manifest' using errcode = '22023'; end if;
	return null;
end$new$);

-- The deploy guard: the patched body carries the marker, and the check comes after the possession check.
do $guard$
declare v_body text := (select prosrc from pg_proc
	where oid = 'public.qorpera_folder_file_bytes_problem(uuid,uuid,jsonb,jsonb,jsonb,text[])'::regprocedure);
begin
	if strpos(v_body, '20260930043000') = 0
		or strpos(v_body, 'File reference does not match its manifest') < strpos(v_body, 'qorpera_folder_object_readable(') then
		raise exception 'The bytes check does not decide possession first'; end if;
end $guard$;
