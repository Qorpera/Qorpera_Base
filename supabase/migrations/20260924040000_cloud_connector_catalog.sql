-- Runtime Step 7: production connector catalog, OAuth account labels and
-- company-wide connector grants.
--
-- Builds on the Step 2 custody kernel (20260828018000). Nothing here stores or
-- reads a secret value: the broker still seals envelopes, and the runtime still
-- turns per-agent operation grants into tools. This migration adds
--   1. the governed catalog rows for GitHub, Gmail and Google Drive, rendered
--      from packages/runtime/src/cloud-connector-catalog.ts (an adapter hash
--      pins each operation's declared destination, credential placement,
--      input schema and recipe text, not the handler code, which only the
--      broker artifact's SHA-256 pins);
--   2. a non-secret account label on a connection (mailbox address, GitHub
--      login) recorded by the broker at capture time;
--   3. one member call that grants every operation of a connection to the
--      company's agents, plus the rule that keeps new hires included.
--
-- Company first (founder, 2026-09-24): a connector connection belongs to the
-- company. Connecting one is an owner/admin act (the Step 2 kernel's rule for
-- company-owned secrets), the member who connected it is attribution only
-- (created_by_user_id, listed as connectedByUserId), and only a company-owned
-- connection can be shared with the company's agents. The kernel's
-- member-owned mode is left as it was (a member's own secret is usable only in
-- runs that member sponsors); Step 7 adds nothing to it.

-- 1. Connection descriptor columns -------------------------------------------

alter table public.qorpera_cloud_secrets
	add column account_label text check (
		account_label is null
		or (char_length(btrim(account_label)) between 1 and 254 and account_label = btrim(account_label))
	),
	add column available_to_all_agents boolean not null default false,
	add constraint qorpera_cloud_secrets_shared_company_only
		check (not available_to_all_agents or owner_kind = 'company');

comment on column public.qorpera_cloud_secrets.account_label is
	'Non-secret provider account identity shown to members; never a token or handle.';
comment on column public.qorpera_cloud_secrets.available_to_all_agents is
	'When true, every active agent of the company holds an operation grant for this connection and new hires receive one. Company-owned connections only.';

-- 2. Capture completion records the account label ---------------------------
--
-- The seven-argument function is the full custody body of 20260828018000 with
-- the label added. The six-argument signature the Step 2 broker calls keeps
-- its guard and delegates, so an older broker build still completes captures.

create function public.qorpera_complete_cloud_secret_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text,
	p_account_label text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_ticket public.qorpera_cloud_secret_capture_tickets%rowtype;
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_envelope bytea;
	v_event text;
	v_creator_role text;
	v_label text := nullif(btrim(coalesce(p_account_label, '')), '');
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if v_label is not null and (char_length(v_label) > 254 or v_label ~ '[[:space:][:cntrl:]]') then
		raise exception 'cloud secret account label is invalid' using errcode = '22023';
	end if;
	select authority.* into strict v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.status <> 'active' or v_authority.capability_sha256 <> p_broker_capability_sha256
		or p_envelope_sha256 !~ '^[0-9a-f]{64}$'
		or char_length(p_encrypted_envelope_base64) not between 1 and 180000 then
		raise exception 'cloud secret broker completion is invalid' using errcode = '42501';
	end if;
	begin
		v_envelope := decode(p_encrypted_envelope_base64,'base64');
	exception when others then
		raise exception 'encrypted secret envelope is invalid' using errcode = '22023';
	end;
	if octet_length(v_envelope) not between 1 and 131072
		or encode(extensions.digest(v_envelope,'sha256'),'hex') <> p_envelope_sha256 then
		raise exception 'encrypted secret envelope is invalid' using errcode = '22023';
	end if;
	select ticket.* into strict v_ticket
	from public.qorpera_cloud_secret_capture_tickets as ticket
	where ticket.id = p_ticket_id for update;
	if v_ticket.broker_authority_id <> v_authority.id
		or v_ticket.capture_capability_sha256 <> p_capture_capability_sha256 then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	select member.role::text into v_creator_role
	from public.qorpera_profile_members as member
	where member.profile_id = v_ticket.profile_id and member.user_id = v_ticket.created_by_user_id
	for share;
	if v_ticket.key_id <> v_authority.key_id or v_creator_role is null
		or (v_ticket.owner_kind = 'company' and v_creator_role not in ('owner','admin'))
		or (v_ticket.owner_kind = 'member' and (
			v_ticket.owner_user_id <> v_ticket.created_by_user_id or v_creator_role = 'viewer'
		)) then
		raise exception 'cloud secret capture authority changed' using errcode = '42501';
	end if;
	if v_ticket.status = 'committed' then
		return (
			select jsonb_build_object(
				'schema','qorpera.cloud-secret-descriptor/v1','secretId',v_ticket.secret_id,
				'version',v_ticket.target_version,'connectorId',v_ticket.connector_id,
				'secretName',v_ticket.secret_name,'purpose',v_ticket.purpose,
				'ownerKind',v_ticket.owner_kind,'ownerUserId',v_ticket.owner_user_id,'status','active',
				'accountLabel',secret.account_label
			) from public.qorpera_cloud_secrets as secret where secret.id = v_ticket.secret_id
		);
	end if;
	if v_ticket.status <> 'pending' or v_ticket.expires_at <= clock_timestamp() then
		raise exception 'cloud secret capture is unavailable' using errcode = '42501';
	end if;
	if v_ticket.target_version = 1 then
		insert into public.qorpera_cloud_secrets (
			id,profile_id,environment_id,broker_authority_id,owner_kind,owner_user_id,
			connector_id,secret_name,purpose,current_version,created_by_user_id,account_label
		) values (
			v_ticket.secret_id,v_ticket.profile_id,v_ticket.environment_id,v_ticket.broker_authority_id,
			v_ticket.owner_kind,v_ticket.owner_user_id,v_ticket.connector_id,v_ticket.secret_name,
			v_ticket.purpose,1,v_ticket.created_by_user_id,v_label
		);
		v_event := 'captured';
	else
		update public.qorpera_cloud_secrets
		set current_version = v_ticket.target_version, purpose = v_ticket.purpose,
			account_label = coalesce(v_label, account_label),
			updated_at = statement_timestamp()
		where id = v_ticket.secret_id and status = 'active'
			and broker_authority_id = v_ticket.broker_authority_id
			and current_version = v_ticket.target_version - 1;
		if not found then
			raise exception 'secret rotation version changed' using errcode = 'PT412';
		end if;
		v_event := 'rotated';
	end if;
	insert into public.qorpera_cloud_secret_versions (
		secret_id,version,broker_authority_id,key_id,encrypted_envelope,envelope_sha256,created_by_user_id
	) values (
		v_ticket.secret_id,v_ticket.target_version,v_ticket.broker_authority_id,v_ticket.key_id,
		v_envelope,p_envelope_sha256,v_ticket.created_by_user_id
	);
	update public.qorpera_cloud_secret_capture_tickets
	set status = 'committed', committed_at = statement_timestamp(), envelope_sha256 = p_envelope_sha256
	where id = v_ticket.id;
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id,environment_id,secret_id,secret_version,event_type,actor_user_id,connector_id
	) values (
		v_ticket.profile_id,v_ticket.environment_id,v_ticket.secret_id,v_ticket.target_version,v_event,
		v_ticket.created_by_user_id,v_ticket.connector_id
	);
	return (
		select jsonb_build_object(
			'schema','qorpera.cloud-secret-descriptor/v1','secretId',v_ticket.secret_id,
			'version',v_ticket.target_version,'connectorId',v_ticket.connector_id,
			'secretName',v_ticket.secret_name,'purpose',v_ticket.purpose,
			'ownerKind',v_ticket.owner_kind,'ownerUserId',v_ticket.owner_user_id,'status','active',
			'accountLabel',secret.account_label
		) from public.qorpera_cloud_secrets as secret where secret.id = v_ticket.secret_id
	);
end
$$;

create or replace function public.qorpera_complete_cloud_secret_capture(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_ticket_id uuid,
	p_capture_capability_sha256 text,
	p_encrypted_envelope_base64 text,
	p_envelope_sha256 text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	-- A Step 2 broker build parses the descriptor with an exact key set.
	return public.qorpera_complete_cloud_secret_capture(
		p_broker_authority_id,p_broker_capability_sha256,p_ticket_id,p_capture_capability_sha256,
		p_encrypted_envelope_base64,p_envelope_sha256,null
	) - 'accountLabel';
end
$$;

revoke all on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_cloud_secret_capture(uuid,text,uuid,text,text,text,text)
	to qorpera_secret_broker;

-- 3. Governed catalog rows -----------------------------------------------------

-- BEGIN GENERATED CONNECTOR CATALOG (scripts/generate-cloud-connector-catalog.mjs)
-- Catalog version 1: 15 operations.
insert into public.qorpera_cloud_connector_operations
	(connector_id,operation_id,version,tool_name,description,input_schema,destination_origin,credential_name,adapter_sha256)
values
	('github','list_repositories',1,'github_list_repositories','List repositories the connected GitHub account can reach (own, collaborator and organization repositories), newest activity first. Optional query filters by name or description.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum repositories to return (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"Case-insensitive text to match in the full name or description.","maxLength":200}},"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','e22064f153d4b6262ace9589b0c6e12789a7b047a9b30b4e9ceb93c37c8d0e8e'),
	('github','search_issues',1,'github_search_issues','Search issues and pull requests with GitHub search syntax, for example ''repo:acme/roadmap is:issue is:open label:bug''. Returns number, title, state, repository and author.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum results (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"GitHub issue search query.","minLength":1,"maxLength":256}},"required":["query"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','f4698f8fcd785a21b06a0f6bd323dc38c03ccc0659abfda0ad8c54506dfa692c'),
	('github','get_issue',1,'github_get_issue','Read one issue or pull request conversation: title, body, state, labels, author, and the first comments.','{"type":"object","properties":{"comment_limit":{"type":"integer","description":"Comments to include (default 10).","minimum":0,"maximum":50},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','4dcf1a3c0b9d26c2a9d69419de816868d9747364131c27f17270d7704240bd24'),
	('github','create_issue',1,'github_create_issue','Create a new issue in a repository. This is visible to everyone with access to the repository.','{"type":"object","properties":{"body":{"type":"string","description":"Issue body in Markdown.","maxLength":20000},"labels":{"type":"array","description":"Existing label names to apply.","items":{"type":"string","minLength":1,"maxLength":50},"maxItems":10},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"title":{"type":"string","description":"Issue title.","minLength":1,"maxLength":256}},"required":["owner","repository","title"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','f8757ca2e1d89e853b3bd5ad456f96a66a52748e4550dbbc8ca10b081c904e65'),
	('github','create_issue_comment',1,'github_comment_on_issue','Add a comment to an issue or pull request conversation. Notifies its participants.','{"type":"object","properties":{"body":{"type":"string","description":"Comment body in Markdown.","minLength":1,"maxLength":20000},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number","body"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','b502a15f55cdf26998926d7c818c371a3e25c92ea8fa10db710e8e6cfb299ca7'),
	('github','read_file',1,'github_read_file','Read a text file from a repository at a branch, tag or commit (default branch when omitted). Large or binary files return metadata only.','{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"path":{"type":"string","description":"File path inside the repository.","minLength":1,"maxLength":1024},"ref":{"type":"string","description":"Branch, tag or commit SHA.","minLength":1,"maxLength":256},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","path"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','68f503b5997ffcbe3e581e614921fccb3451726274ce1b4462eeb14cbef35562'),
	('github','get_pull_request',1,'github_get_pull_request','Read one pull request: title, body, state, branches, mergeability, review decision counts and the changed files.','{"type":"object","properties":{"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','bdb1d2b4d6bb40a48632cb9ac19b6deb6f6d5bbcbe8d5e8da23c56e6dda0a78b'),
	('gmail','search_messages',1,'gmail_search_messages','Search the connected mailbox with Gmail search syntax, for example ''from:anna@example.com newer_than:7d is:unread''. Returns sender, recipients, subject, date and a snippet per message.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum messages to return (default 10).","minimum":1,"maximum":25},"query":{"type":"string","description":"Gmail search query. Empty lists the newest messages.","maxLength":512}},"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','249cadae2ffed50551d1bf67418e70115f5f2bc4cce695a4415c450ff5dd2209'),
	('gmail','read_message',1,'gmail_read_message','Read one email: headers, the plain-text body (HTML is reduced to text) and the list of attachments. Attachments are not downloaded.','{"type":"object","properties":{"message_id":{"type":"string","description":"Gmail message id from a search.","minLength":1,"maxLength":64}},"required":["message_id"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','25447eea32d68dc4db19aeb2bb6e6bff9acc0b8c2b686180dd7d118f0efe1e10'),
	('gmail','read_thread',1,'gmail_read_thread','Read a conversation thread: each message''s sender, date, subject and a shortened plain-text body.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum messages to include (default 10).","minimum":1,"maximum":20},"thread_id":{"type":"string","description":"Gmail thread id from a search.","minLength":1,"maxLength":64}},"required":["thread_id"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','8cc0ea6f8314c937ef5842d366489d34674f4a0a1acb752560665ab81729476e'),
	('gmail','send_message',1,'gmail_send_message','Send an email from the connected mailbox. Provide reply_to_message_id to answer inside an existing conversation. The email leaves the company immediately.','{"type":"object","properties":{"body":{"type":"string","description":"Plain-text body.","minLength":1,"maxLength":50000},"cc":{"type":"array","description":"Cc email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"maxItems":20},"reply_to_message_id":{"type":"string","description":"Gmail message id being answered; the reply joins that thread.","minLength":1,"maxLength":64},"subject":{"type":"string","description":"Subject line.","minLength":1,"maxLength":512},"to":{"type":"array","description":"Recipient email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"minItems":1,"maxItems":20}},"required":["to","subject","body"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','1a31412ee908d124a0b87e06a91535ad45227299f8bd57fd6eb696d3ec7a7904'),
	('google_drive','search_files',1,'google_drive_search_files','Find files and folders in the connected Google Drive (including shared drives) by name, optionally inside one folder. Returns id, name, type, last modified and a link.','{"type":"object","properties":{"folder_id":{"type":"string","description":"Only direct children of this folder.","minLength":1,"maxLength":128},"limit":{"type":"integer","description":"Maximum files to return (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"Text the file name must contain. Empty lists recent files.","maxLength":256}},"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8c125c1d9cf126acbcc329314e89f30cf0feffd4f0d5fed6b148fac924b996fd'),
	('google_drive','read_file',1,'google_drive_read_file','Read a file''s text. Google Docs, Sheets and Slides are exported as plain text or CSV; text files are read directly; other files return metadata only.','{"type":"object","properties":{"file_id":{"type":"string","description":"Drive file id from a search.","minLength":1,"maxLength":128},"max_chars":{"type":"integer","description":"Maximum characters of text to return (default 5000).","minimum":200,"maximum":20000}},"required":["file_id"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8b5839d204083b9a70ae89923a1a57f9081ee6db5dfd0813aeff85add5ece590'),
	('google_drive','create_file',1,'google_drive_create_file','Create a new file with text content in the connected Google Drive, optionally inside a folder. Use the Google Docs type to create an editable document from the text.','{"type":"object","properties":{"content":{"type":"string","description":"Text content.","maxLength":60000},"folder_id":{"type":"string","description":"Parent folder id.","minLength":1,"maxLength":128},"mime_type":{"type":"string","description":"File type (default text/plain).","enum":["text/plain","text/markdown","text/csv","application/json","application/vnd.google-apps.document"]},"name":{"type":"string","description":"File name.","minLength":1,"maxLength":256}},"required":["name","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','fc53514b74dc4477de6d140ee6ac6f9ee434f435ae14c3ab8747c819d015fe39'),
	('google_drive','update_file',1,'google_drive_update_file','Replace the content of an existing text file or Google Doc with new text. The previous content is kept in Drive''s version history.','{"type":"object","properties":{"content":{"type":"string","description":"New text content.","maxLength":60000},"file_id":{"type":"string","description":"Drive file id.","minLength":1,"maxLength":128}},"required":["file_id","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','61d52e5b60b2dd11cb09dbef5d2c6a61ee78dcce725a77c97f07dd6c78199b81');
-- END GENERATED CONNECTOR CATALOG

-- 4. Company-wide connector grants --------------------------------------------
--
-- Founder decision 2026-09-19/20: an agent may do what a signed-in member may;
-- the gate is authority, never the client. Connecting an account therefore
-- grants its operations to the company's active agents in one call, and a new
-- hire receives the same grants. Each grant is still the Step 2 per-agent,
-- per-operation grant that the runtime lists and the broker rechecks; the
-- member can revoke any of them.

create function public.qorpera_grant_cloud_connector_operations(
	p_profile_id uuid,
	p_environment_id uuid,
	p_secret_id uuid,
	p_issued_by_user_id uuid,
	p_staff_agent_ids uuid[]
)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_agent uuid;
	v_operation public.qorpera_cloud_connector_operations%rowtype;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_existing public.qorpera_cloud_secret_operation_grants%rowtype;
	v_issued integer := 0;
begin
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id and secret.status = 'active';
	foreach v_agent in array p_staff_agent_ids loop
		if not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = p_profile_id and staff.staff_agent_id = v_agent
				and staff.employment_status = 'active'
		) then
			continue;
		end if;
		for v_operation in
			select operation.* from public.qorpera_cloud_connector_operations as operation
			where operation.connector_id = v_secret.connector_id and operation.status = 'active'
				and operation.version = (
					select max(latest.version) from public.qorpera_cloud_connector_operations as latest
					where latest.connector_id = operation.connector_id
						and latest.operation_id = operation.operation_id and latest.status = 'active'
				)
			order by operation.operation_id
		loop
			select existing.* into v_existing from public.qorpera_cloud_secret_operation_grants as existing
			where existing.profile_id = p_profile_id and existing.environment_id = p_environment_id
				and existing.staff_agent_id = v_agent and existing.tool_name = v_operation.tool_name
				and existing.status = 'active'
			for update;
			if found then
				-- A company grant holds only while its issuer is an owner or admin
				-- (the kernel rechecks at every call). A live grant, or one on
				-- another connection, stays; a grant of this connection whose
				-- issuer left or was demoted is re-issued under the caller.
				if v_existing.secret_id <> v_secret.id or v_secret.owner_kind <> 'company' or exists (
					select 1 from public.qorpera_profile_members as issuer
					where issuer.profile_id = p_profile_id and issuer.user_id = v_existing.issued_by_user_id
						and issuer.role in ('owner','admin')
				) then
					continue;
				end if;
				update public.qorpera_cloud_secret_operation_grants
				set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = p_issued_by_user_id
				where id = v_existing.id;
				insert into public.qorpera_cloud_secret_audit_events (
					profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id
				) values (
					p_profile_id,p_environment_id,v_secret.id,v_secret.current_version,v_existing.id,'grant_revoked',
					p_issued_by_user_id,v_existing.connector_id,v_existing.operation_id
				);
			end if;
			insert into public.qorpera_cloud_secret_operation_grants (
				profile_id,environment_id,secret_id,staff_agent_id,connector_id,operation_id,
				operation_version,tool_name,issued_by_user_id
			) values (
				p_profile_id,p_environment_id,v_secret.id,v_agent,v_operation.connector_id,v_operation.operation_id,
				v_operation.version,v_operation.tool_name,p_issued_by_user_id
			) returning * into v_grant;
			insert into public.qorpera_cloud_secret_audit_events (
				profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id
			) values (
				p_profile_id,p_environment_id,v_secret.id,v_secret.current_version,v_grant.id,'grant_issued',
				p_issued_by_user_id,v_operation.connector_id,v_operation.operation_id
			);
			v_issued := v_issued + 1;
		end loop;
	end loop;
	return v_issued;
end
$$;

create function public.qorpera_grant_cloud_connector(
	p_profile_id uuid,
	p_environment_id uuid,
	p_secret_id uuid,
	p_staff_agent_ids uuid[] default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_agents uuid[];
	v_issued integer;
begin
	select member.role::text into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;
	-- Company first: only a company-owned connection is shared with the
	-- company's agents, and only by an owner or admin. (A member's own secret
	-- could serve only runs that member sponsors; the kernel keeps that mode for
	-- per-operation grants, Step 7 does not extend it.)
	if v_secret.status <> 'active' or v_secret.owner_kind <> 'company'
		or v_role is null or v_role not in ('owner','admin') then
		raise exception 'secret grant authority is unavailable' using errcode = '42501';
	end if;
	if p_staff_agent_ids is null then
		select coalesce(array_agg(staff.staff_agent_id order by staff.staff_agent_id), '{}'::uuid[]) into v_agents
		from public.qorpera_profile_staff as staff
		where staff.profile_id = p_profile_id and staff.employment_status = 'active';
		update public.qorpera_cloud_secrets set available_to_all_agents = true, updated_at = statement_timestamp()
		where id = v_secret.id;
	else
		if array_length(p_staff_agent_ids, 1) is null or array_length(p_staff_agent_ids, 1) > 256 then
			raise exception 'secret grant agents are invalid' using errcode = '22023';
		end if;
		v_agents := p_staff_agent_ids;
	end if;
	v_issued := public.qorpera_grant_cloud_connector_operations(
		p_profile_id, p_environment_id, v_secret.id, v_user_id, v_agents
	);
	return jsonb_build_object(
		'schema','qorpera.cloud-connector-grants/v1','secretId',v_secret.id,'connectorId',v_secret.connector_id,
		'agentCount',coalesce(array_length(v_agents, 1), 0),'grantsIssued',v_issued,
		'availableToAllAgents',p_staff_agent_ids is null
	);
end
$$;

create function public.qorpera_grant_shared_connectors_to_staff()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_issuer uuid;
begin
	if new.employment_status <> 'active' or (tg_op = 'UPDATE' and old.employment_status = 'active') then
		return new;
	end if;
	for v_secret in
		select secret.* from public.qorpera_cloud_secrets as secret
		where secret.profile_id = new.profile_id and secret.status = 'active' and secret.available_to_all_agents
			and secret.owner_kind = 'company'
		order by secret.id
	loop
		-- A company-owned grant holds while its issuer is an owner or admin (the
		-- kernel rechecks at every call). The hire's author issues it when they
		-- are one; otherwise the member who connected the account, if still an
		-- owner or admin; otherwise a current owner (or admin), since the company
		-- already shared it with every agent.
		select member.user_id into v_issuer
		from public.qorpera_profile_members as member
		where member.profile_id = new.profile_id and member.role in ('owner','admin')
		order by member.user_id = new.updated_by_user_id desc,
			member.user_id = v_secret.created_by_user_id desc,
			member.role = 'owner' desc, member.user_id
		limit 1;
		if v_issuer is null then
			continue;
		end if;
		perform public.qorpera_grant_cloud_connector_operations(
			v_secret.profile_id, v_secret.environment_id, v_secret.id, v_issuer,
			array[new.staff_agent_id]
		);
	end loop;
	return new;
end
$$;

create trigger qorpera_cloud_connector_staff_grants
	after insert or update of employment_status on public.qorpera_profile_staff
	for each row execute function public.qorpera_grant_shared_connectors_to_staff();

-- Stop sharing: the company's agents lose this connection. An owner or admin
-- clears the all-agents mark (new hires no longer receive it) and every active
-- grant of the connection is revoked, audited per grant. The connection itself
-- stays connected; Share with all agents gives it back.
create function public.qorpera_unshare_cloud_connector(
	p_profile_id uuid,
	p_environment_id uuid,
	p_secret_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_user_id uuid := auth.uid();
	v_role text;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_grant public.qorpera_cloud_secret_operation_grants%rowtype;
	v_revoked integer := 0;
begin
	if auth.role() is distinct from 'authenticated' or v_user_id is null then
		raise exception 'secret grant authority is unavailable' using errcode = '42501';
	end if;
	select member.role::text into v_role from public.qorpera_profile_members as member
	where member.profile_id = p_profile_id and member.user_id = v_user_id;
	select secret.* into strict v_secret from public.qorpera_cloud_secrets as secret
	where secret.id = p_secret_id and secret.profile_id = p_profile_id
		and secret.environment_id = p_environment_id for update;
	if v_secret.owner_kind <> 'company' or v_role is null or v_role not in ('owner','admin') then
		raise exception 'secret grant authority is unavailable' using errcode = '42501';
	end if;
	update public.qorpera_cloud_secrets set available_to_all_agents = false, updated_at = statement_timestamp()
	where id = v_secret.id and available_to_all_agents;
	for v_grant in
		update public.qorpera_cloud_secret_operation_grants
		set status = 'revoked', revoked_at = statement_timestamp(), revoked_by_user_id = v_user_id
		where secret_id = v_secret.id and profile_id = p_profile_id and status = 'active'
		returning *
	loop
		insert into public.qorpera_cloud_secret_audit_events (
			profile_id,environment_id,secret_id,secret_version,grant_id,event_type,actor_user_id,connector_id,operation_id
		) values (
			v_grant.profile_id,v_grant.environment_id,v_grant.secret_id,v_secret.current_version,v_grant.id,
			'grant_revoked',v_user_id,v_grant.connector_id,v_grant.operation_id
		);
		v_revoked := v_revoked + 1;
	end loop;
	return jsonb_build_object(
		'schema','qorpera.cloud-connector-grants/v1','secretId',v_secret.id,'connectorId',v_secret.connector_id,
		'grantsRevoked',v_revoked,'availableToAllAgents',false
	);
end
$$;

-- 5. Member descriptor lists the label and the grant state --------------------

create or replace function public.qorpera_list_cloud_secret_connections(p_profile_id uuid, p_environment_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	select case when not public.qorpera_can_read_profile(p_profile_id) then '[]'::jsonb else coalesce((
		select jsonb_agg(jsonb_build_object(
			'schema','qorpera.cloud-secret-descriptor/v1','secretId',secret.id,
			'version',secret.current_version,'connectorId',secret.connector_id,
			'secretName',secret.secret_name,'purpose',secret.purpose,
			'ownerKind',secret.owner_kind,
			'ownerUserId',case when secret.owner_kind = 'member' and secret.owner_user_id = auth.uid()
				then secret.owner_user_id else null end,
			'status',secret.status,
			'accountLabel',secret.account_label,
			'connectedByUserId',case when secret.owner_kind = 'company' then secret.created_by_user_id else null end,
			'availableToAllAgents',secret.available_to_all_agents,
			'activeGrantCount',(
				select count(*) from public.qorpera_cloud_secret_operation_grants as grant_row
				where grant_row.secret_id = secret.id and grant_row.status = 'active'
			),
			'createdAt',secret.created_at,
			'updatedAt',secret.updated_at
		) order by secret.connector_id,secret.secret_name,secret.id)
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = p_profile_id and secret.environment_id = p_environment_id
			and (secret.owner_kind = 'company' or secret.owner_user_id = auth.uid())
	), '[]'::jsonb) end
$$;

-- 6. Privileges -----------------------------------------------------------------

revoke all on function public.qorpera_grant_cloud_connector_operations(uuid,uuid,uuid,uuid,uuid[])
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[]) from public, anon, service_role;
revoke all on function public.qorpera_unshare_cloud_connector(uuid,uuid,uuid) from public, anon, service_role;
revoke all on function public.qorpera_grant_shared_connectors_to_staff() from public, anon, authenticated, service_role;
revoke all on function public.qorpera_list_cloud_secret_connections(uuid,uuid) from public, anon, service_role;
grant execute on function public.qorpera_grant_cloud_connector(uuid,uuid,uuid,uuid[]) to authenticated;
grant execute on function public.qorpera_unshare_cloud_connector(uuid,uuid,uuid) to authenticated;
grant execute on function public.qorpera_list_cloud_secret_connections(uuid,uuid) to authenticated;
