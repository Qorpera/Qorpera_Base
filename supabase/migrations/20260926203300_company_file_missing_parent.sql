-- A Company File write or mkdir into a folder that does not exist is a definite,
-- typed refusal that changes nothing (live 2026-09-26, run 71b86758: two
-- company_write calls into acceptance/auto-review/ uploaded their bytes and then
-- came back "unconfirmed/unknown" to the model).
--
-- The gateway never invents parent folders. Until now only the runner found a
-- missing folder, when it built the candidate tree: after the check, presence,
-- the object uploads and prepare, and as a plain error the tool boundary had to
-- report as an unknown outcome. The check now refuses it with its own SQLSTATE
-- PT424 (PostgREST answers HTTP 424), after authority, the operation-key replay
-- and the expected-version test, and before anything is staged. Prepare and
-- commit run the same check again, so a folder deleted in between is refused
-- the same way. The runner maps PT424 to COMPANY_FILE_PARENT_MISSING and tells
-- the model to create the folder with company_mkdir first.
--
-- The folder must be a directory at exactly that path, as the tree requires; a
-- tombstone or a file is no folder. (Another spelling of an existing folder is
-- already refused by path authority, 42501.) A deletion (no entry) is not
-- checked here: its target is already gone with its folder.

create function pg_temp.parent_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company File parent check integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

select pg_temp.parent_patch('public.qorpera_check_company_path_mutation(uuid,jsonb,jsonb)'::regprocedure,
	$old$	return jsonb_build_object('state',case when public.qorpera_company_path_needs_approval(v_actor,v_resource,p_plan)$old$,
	$new$	-- A new entry goes into an existing folder. The check refuses it before any bytes are staged.
	if p_plan -> 'entry' <> 'null'::jsonb and strpos(p_plan ->> 'path','/') > 0 and not exists (
		select 1 from public.qorpera_company_path_entries parent
		where parent.environment_id = (v_actor ->> 'environmentId')::uuid
			and parent.path_key_sha256 = extensions.digest(public.qorpera_company_path_key(
				regexp_replace(p_plan ->> 'path','/[^/]*$','')),'sha256')
			and parent.path = regexp_replace(p_plan ->> 'path','/[^/]*$','')
			and parent.entry ->> 'kind' = 'directory') then
		raise exception 'Company File parent folder is missing' using errcode = 'PT424'; end if;
	return jsonb_build_object('state',case when public.qorpera_company_path_needs_approval(v_actor,v_resource,p_plan)$new$);

-- Runtime observation vocabulary: a write refused this way is observed as
-- denied with errorCategory parent_missing. Patched into the live definition,
-- not re-stated, so names other migrations added stay. CREATE OR REPLACE keeps
-- the ACL. Record this migration BEFORE activating a bundle that observes it, or
-- those observations are rejected (22023) and dropped.
select pg_temp.parent_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'approval_pending','approval_declined','review_denied','review_unavailable')$old$,
	$new$'approval_pending','approval_declined','review_denied','review_unavailable','parent_missing')$new$);
