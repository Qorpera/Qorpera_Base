-- 20260930503000: the connect card (contract 16.2, connector authorization; L16.2 step 3). An agent that needs a
-- service the company has not connected (Gmail, Google Drive, GitHub: the connector catalog) asks its member with a
-- `connect` card. The member starts the same Connect sign-in as Settings → Company connections, then answers
-- "connected", or skips it ("declined"). The card carries no secret either way: the sign-in goes through the broker,
-- and the answer is an outcome only.
-- * qorpera_interaction_request_valid: the connect payload, {connectorId, purpose}, closed.
-- * qorpera_folder_append_interaction_request: a connect card names a service of the connector catalog; and a card the
--   payload check cannot call valid (null: a required text missing) is refused, as a false one always was.
-- * qorpera_answer_interaction: "connected" or "declined", with no answer; "connected" only once the company has an
--   active connection of that service in the card's environment (a member's own connection is not the company's).
set local lock_timeout = '3s';

create function pg_temp.connect_card_replace(p_target regprocedure, p_old text, p_new text, p_count integer)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception 'connect card patch anchor not found % time(s) in %', p_count, p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. The payload: the catalog id of the service and why the agent needs it.
select pg_temp.connect_card_replace('public.qorpera_interaction_request_valid(jsonb)',
	E'\telsif v_surface = ''credential'' then\n',
	E'\telsif v_surface = ''connect'' then\n'
	|| E'\t\t-- 20260930503000: the folder append checks the catalog; this function reads no table.\n'
	|| E'\t\t-- A missing key reads as null, never as valid.\n'
	|| E'\t\treturn coalesce(v_payload - ''connectorId'' - ''purpose'' = ''{}''::jsonb\n'
	|| E'\t\t\tand jsonb_typeof(v_payload -> ''connectorId'') = ''string''\n'
	|| E'\t\t\tand (v_payload ->> ''connectorId'') ~ ''^[a-z][a-z0-9_-]{0,63}$''\n'
	|| E'\t\t\tand public.qorpera_interaction_text_valid(v_payload -> ''purpose'', 1, 300), false);\n'
	|| E'\telsif v_surface = ''credential'' then\n', 1);

-- 2. A run raises a connect card only for a service of the catalog. The payload check returns null, not false, for a
-- card of another surface missing a required text (a takeover without its instruction): null now refuses too.
select pg_temp.connect_card_replace('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
	E'\tif p_event_id is null or not public.qorpera_interaction_request_valid(p_data) then\n',
	E'\tif p_event_id is null or public.qorpera_interaction_request_valid(p_data) is not true then\n', 1);
select pg_temp.connect_card_replace('public.qorpera_folder_append_interaction_request(jsonb,uuid,jsonb)',
	E'\t\traise exception ''a secret card cannot name a company connection; the company connects it in Settings'' using errcode = ''22023''; end if;\n',
	E'\t\traise exception ''a secret card cannot name a company connection; the company connects it in Settings'' using errcode = ''22023''; end if;\n'
	|| E'\t-- 20260930503000: a connect card names a service the company can connect.\n'
	|| E'\tif p_data ->> ''surface'' = ''connect'' and not exists (select 1 from public.qorpera_cloud_connector_operations as operation\n'
	|| E'\t\twhere operation.connector_id = p_data #>> ''{payload,connectorId}'' and operation.status = ''active'') then\n'
	|| E'\t\traise exception ''a connect card names a service from the connector catalog'' using errcode = ''22023''; end if;\n', 1);

-- 3. The answer: "connected" is the kernel's finding, never the client's word.
select pg_temp.connect_card_replace('public.qorpera_answer_interaction(uuid,uuid,uuid,text,jsonb,uuid,bigint)',
	E'\telsif v_surface = ''takeover'' then\n'
	|| E'\t\tif p_outcome not in (''handed_back'', ''dismissed'') or v_answer <> ''{}''::jsonb then\n'
	|| E'\t\t\traise exception ''takeover answer is invalid'' using errcode = ''22023'';\n'
	|| E'\t\tend if;\n',
	E'\telsif v_surface = ''takeover'' then\n'
	|| E'\t\tif p_outcome not in (''handed_back'', ''dismissed'') or v_answer <> ''{}''::jsonb then\n'
	|| E'\t\t\traise exception ''takeover answer is invalid'' using errcode = ''22023'';\n'
	|| E'\t\tend if;\n'
	|| E'\telsif v_surface = ''connect'' then\n'
	|| E'\t\t-- 20260930503000: as Settings counts a connection: the company''s, active, in this environment.\n'
	|| E'\t\tif p_outcome not in (''connected'', ''declined'') or v_answer <> ''{}''::jsonb then\n'
	|| E'\t\t\traise exception ''connect answer is invalid'' using errcode = ''22023'';\n'
	|| E'\t\tend if;\n'
	|| E'\t\tif p_outcome = ''connected'' and not exists (select 1 from public.qorpera_cloud_secrets as secret\n'
	|| E'\t\t\twhere secret.profile_id = v_profile_id and secret.environment_id = v_session.environment_id\n'
	|| E'\t\t\t\tand secret.owner_kind = ''company'' and secret.status = ''active''\n'
	|| E'\t\t\t\tand secret.connector_id = v_payload ->> ''connectorId'') then\n'
	|| E'\t\t\traise exception ''the company has not connected this service yet'' using errcode = ''55000'';\n'
	|| E'\t\tend if;\n', 1);

drop function pg_temp.connect_card_replace(regprocedure, text, text, integer);
