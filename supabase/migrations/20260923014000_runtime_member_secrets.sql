-- Thread interactions, secrets step (bundle v77, on top of the v75 kernel and
-- the v76 runtime): a secret card is answered through the company's cloud
-- secret custody, never through the transcript.
--   * A secret card names the connector its secret belongs to (`connectorId`,
--     default `vault`) beside the secret name, so the member's browser can open
--     a capture ticket (`qorpera_begin_cloud_secret_capture`) and post the value
--     to the secret broker, where it is sealed. Postgres, the run and the model
--     only ever see the secret's id and version.
--   * `provided` is accepted only when an active secret with that connector and
--     name exists for the company (owned by the company, or by the answering
--     member), and the kernel writes the secret's id and version into the
--     answer, so the agent learns a reference and nothing else.
-- Filling a page from the vault and generating a secret for a sign-up are not
-- in this bundle: plaintext never reaches a runner, so the fill has to be driven
-- from the broker through the viewer input path (design doc §5.3, revised).
begin;

-- 1. The secret card carries its connector; names follow the custody pattern.
do $$
declare
	v_definition text;
	v_needle text;
begin
	v_definition := pg_get_functiondef('public.qorpera_interaction_request_valid(jsonb)'::regprocedure);
	v_needle := E'\t\treturn v_payload - \'name\' - \'label\' - \'purpose\' - \'kind\' = \'{}\'::jsonb\n'
		|| E'\t\t\tand coalesce(v_payload ->> \'name\', \'\') ~ \'^[a-z0-9][a-z0-9_-]{0,63}$\'';
	if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 1 then
		raise exception 'Interaction secret validator differs';
	end if;
	execute replace(v_definition, v_needle,
		E'\t\treturn v_payload - \'name\' - \'label\' - \'purpose\' - \'kind\' - \'connectorId\' = \'{}\'::jsonb\n'
		|| E'\t\t\tand coalesce(v_payload ->> \'name\', \'\') ~ \'^[a-z][a-z0-9_-]{0,63}$\'\n'
		|| E'\t\t\tand (not v_payload ? \'connectorId\' or coalesce(v_payload ->> \'connectorId\', \'\') ~ \'^[a-z][a-z0-9_-]{0,63}$\')');
end
$$;

-- 2. "Provided" means the vault has it. The answer carries the reference the
-- kernel found, never anything the client sent.
do $$
declare
	v_definition text;
	v_needle text;
begin
	v_definition := pg_get_functiondef(
		'public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb)'::regprocedure);
	v_needle := E'\t\tif v_answer <> \'{}\'::jsonb then\n'
		|| E'\t\t\traise exception \'a secret answer carries no value\' using errcode = \'22023\';\n'
		|| E'\t\tend if;\n';
	if (length(v_definition) - length(replace(v_definition, v_needle, ''))) / length(v_needle) <> 1 then
		raise exception 'Interaction secret answer branch differs';
	end if;
	execute replace(v_definition, v_needle,
		E'\t\tif v_answer <> \'{}\'::jsonb then\n'
		|| E'\t\t\traise exception \'a secret answer carries no value\' using errcode = \'22023\';\n'
		|| E'\t\tend if;\n'
		|| E'\t\tif p_outcome = \'provided\' then\n'
		|| E'\t\t\tselect jsonb_build_object(\'secretId\', secret.id, \'version\', secret.current_version)\n'
		|| E'\t\t\tinto v_answer\n'
		|| E'\t\t\tfrom public.qorpera_cloud_secrets as secret\n'
		|| E'\t\t\twhere secret.profile_id = v_profile_id and secret.environment_id = v_session.environment_id\n'
		|| E'\t\t\t\tand secret.status = \'active\' and secret.current_version >= 1\n'
		|| E'\t\t\t\tand secret.connector_id = coalesce(v_payload ->> \'connectorId\', \'vault\')\n'
		|| E'\t\t\t\tand secret.secret_name = v_payload ->> \'name\'\n'
		|| E'\t\t\t\tand (secret.owner_kind = \'company\' or secret.owner_user_id = v_user_id)\n'
		|| E'\t\t\torder by secret.owner_kind = \'company\' desc, secret.updated_at desc\n'
		|| E'\t\t\tlimit 1;\n'
		|| E'\t\t\tif v_answer is null then\n'
		|| E'\t\t\t\traise exception \'the company vault has no secret with this name yet\' using errcode = \'55000\';\n'
		|| E'\t\t\tend if;\n'
		|| E'\t\tend if;\n');
end
$$;

commit;
