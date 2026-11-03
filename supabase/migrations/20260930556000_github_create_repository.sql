-- 20260930556000: agents create GitHub repositories (v194 item 7, 3 November 2026).
--
-- In the founder's company-building test the Co-Founder had to ask the founder to create the repository
-- wristband-shop by hand: the company's GitHub connection let agents list, read, open issues and comment, but not
-- create a repository. This adds the catalog operation github create_repository v1 (tool github_create_repository)
-- and issues it to the agents that already use the company's shared GitHub connection.
--
-- 1. The catalog rows, rendered from packages/runtime/src/cloud-connector-catalog.ts by
--    scripts/generate-cloud-connector-catalog.mjs, which now points here. As in 20260925125900, every shipped row is
--    stated again and refused if it drifted; only the new row is inserted.
-- 2. qorpera_backfill_connector_operation_grants(connector, source operation, operation, version): issues an
--    operation the catalog gained later to every active agent that holds a live grant of the source operation on a
--    shared company connection, under the same issuer and with the same expiry, with one grant_issued audit row each.
--    The rules of 20260925125900's Gmail backfill, now one function a SQL test can run: only while the issuer is still
--    an owner or admin of the company; never for a member-owned or unshared connection, a revoked or expired source
--    grant, an archived agent, or an agent that ever held a grant of that tool (one revoked stays revoked). Running it
--    again issues nothing. No API role may call it.
-- 3. It runs once here: an agent that may open issues on the company's GitHub connection (create_issue) may also
--    create repositories there. A connection made later, a reconnect, and a new hire need nothing: a share issues
--    every active operation of the connector (qorpera_share_company_connection, the hire trigger of 20260924040000).
--
-- Permission at GitHub. A GitHub sign-in (Qorpera's OAuth App) has asked for the `repo` scope since Step 7, and
-- `repo` lets the token create repositories for the account and in organizations whose policy lets that account: an
-- existing sign-in needs no reconnect. A typed token needs more: a fine-grained one Administration read and write, a
-- classic one `repo` (`public_repo` covers only public repositories). An organization with OAuth App access
-- restrictions must approve Qorpera's app, and one that stops members creating repositories must allow it. Where
-- GitHub refuses, the tool answers that "the GitHub connection needs to be connected again with permission to create
-- repositories" (or, for an organization, that an owner of it must allow it), never a bare error.
--
-- Release: the cloud secret broker (vault) needs the release's build, which carries the new adapter; an older broker
-- has none for this operation and refuses the call. On a folder-v2 company each new grant marks the connection's
-- file due (20260928469150), so its listed actions follow.
begin;
set local lock_timeout = '3s';

-- BEGIN GENERATED CONNECTOR CATALOG (scripts/generate-cloud-connector-catalog.mjs)
-- Catalog version 1: 21 operations.
create temporary table qorpera_connector_catalog_release (like public.qorpera_cloud_connector_operations including defaults) on commit drop;
insert into pg_temp.qorpera_connector_catalog_release
	(connector_id,operation_id,version,tool_name,description,input_schema,destination_origin,credential_name,adapter_sha256)
values
	('github','list_repositories',1,'github_list_repositories','List repositories the connected GitHub account can reach (own, collaborator and organization repositories), newest activity first. Optional query filters by name or description.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum repositories to return (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"Case-insensitive text to match in the full name or description.","maxLength":200}},"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','e22064f153d4b6262ace9589b0c6e12789a7b047a9b30b4e9ceb93c37c8d0e8e'),
	('github','search_issues',1,'github_search_issues','Search issues and pull requests with GitHub search syntax, for example ''repo:acme/roadmap is:issue is:open label:bug''. Returns number, title, state, repository and author.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum results (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"GitHub issue search query.","minLength":1,"maxLength":256}},"required":["query"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','f4698f8fcd785a21b06a0f6bd323dc38c03ccc0659abfda0ad8c54506dfa692c'),
	('github','get_issue',1,'github_get_issue','Read one issue or pull request conversation: title, body, state, labels, author, and the first comments.','{"type":"object","properties":{"comment_limit":{"type":"integer","description":"Comments to include (default 10).","minimum":0,"maximum":50},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','4dcf1a3c0b9d26c2a9d69419de816868d9747364131c27f17270d7704240bd24'),
	('github','create_issue',1,'github_create_issue','Create a new issue in a repository. This is visible to everyone with access to the repository.','{"type":"object","properties":{"body":{"type":"string","description":"Issue body in Markdown.","maxLength":20000},"labels":{"type":"array","description":"Existing label names to apply.","items":{"type":"string","minLength":1,"maxLength":50},"maxItems":10},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"title":{"type":"string","description":"Issue title.","minLength":1,"maxLength":256}},"required":["owner","repository","title"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','f8757ca2e1d89e853b3bd5ad456f96a66a52748e4550dbbc8ca10b081c904e65'),
	('github','create_issue_comment',1,'github_comment_on_issue','Add a comment to an issue or pull request conversation. Notifies its participants.','{"type":"object","properties":{"body":{"type":"string","description":"Comment body in Markdown.","minLength":1,"maxLength":20000},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number","body"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','b502a15f55cdf26998926d7c818c371a3e25c92ea8fa10db710e8e6cfb299ca7'),
	('github','read_file',1,'github_read_file','Read a text file from a repository at a branch, tag or commit (default branch when omitted). Large or binary files return metadata only.','{"type":"object","properties":{"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"path":{"type":"string","description":"File path inside the repository.","minLength":1,"maxLength":1024},"ref":{"type":"string","description":"Branch, tag or commit SHA.","minLength":1,"maxLength":256},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","path"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','68f503b5997ffcbe3e581e614921fccb3451726274ce1b4462eeb14cbef35562'),
	('github','get_pull_request',1,'github_get_pull_request','Read one pull request: title, body, state, branches, mergeability, review decision counts and the changed files.','{"type":"object","properties":{"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','bdb1d2b4d6bb40a48632cb9ac19b6deb6f6d5bbcbe8d5e8da23c56e6dda0a78b'),
	('github','create_repository',1,'github_create_repository','Create a new repository in the connected GitHub account, or in an organization that account belongs to (owner). It is private unless private is false; a public repository is visible to everyone on the internet. By default it starts with a README, so it has a default branch. A refusal says when the name is taken or when the GitHub connection must be connected again with permission to create repositories.','{"type":"object","properties":{"auto_init":{"type":"boolean","description":"Default true: start with a README. false creates an empty repository."},"description":{"type":"string","description":"Short description shown on GitHub.","maxLength":350},"name":{"type":"string","description":"Name of the new repository, without the owner: letters, digits, - _ and .","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"owner":{"type":"string","description":"Organization to create it in. Omit it, or give the connected account''s own login, for the connected account itself.","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"private":{"type":"boolean","description":"Default true. false makes the repository public: anyone on the internet can see it."}},"required":["name"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','8e23a0300b406bb2e8c1b3aac0deb90332601aaa2efbdee882563f77c9abd051'),
	('gmail','get_profile',1,'gmail_get_profile','Get the connected mailbox email_address. Use this trusted address as from when showing an email draft with ask_member surface draft; never invent the sender.','{"type":"object","properties":{},"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','b576d87499f41ef102fe12039fe395a5732d2d939893ef925d57c52637ea55b4'),
	('gmail','create_draft',1,'gmail_create_draft','Save an unsent draft in the connected Gmail mailbox. For an email to review in this conversation, use ask_member surface draft instead; its Save to Gmail button persists the draft. Use this operation when the member explicitly requests a Gmail-saved draft. Requires reconnecting older connections to grant draft access. Reuse the same idempotencyKey on retry; never blindly repeat a creation with an uncertain result.','{"type":"object","properties":{"body":{"type":"string","description":"Complete plain-text body.","minLength":1,"maxLength":50000},"cc":{"type":"array","description":"Cc email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"maxItems":20},"reply_to_message_id":{"type":"string","description":"Gmail message id being answered, not a draft id.","minLength":1,"maxLength":64},"subject":{"type":"string","description":"Subject line.","minLength":1,"maxLength":512},"to":{"type":"array","description":"Recipient email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"minItems":1,"maxItems":20}},"required":["to","subject","body"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','2408d28a058a80f7a7c3a86f2d18f9fb6129a671a4933a5a847491859b1a7a18'),
	('gmail','update_draft',1,'gmail_update_draft','Replace the complete content of an existing Gmail draft without sending it. Supply every recipient, subject and body to retain. The stable draft_id is unchanged but message_id changes.','{"type":"object","properties":{"body":{"type":"string","description":"Complete plain-text body.","minLength":1,"maxLength":50000},"cc":{"type":"array","description":"Cc email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"maxItems":20},"draft_id":{"type":"string","description":"Stable Gmail draft id returned by create_draft.","minLength":1,"maxLength":128},"reply_to_message_id":{"type":"string","description":"Gmail message id being answered, not a draft id.","minLength":1,"maxLength":64},"subject":{"type":"string","description":"Subject line.","minLength":1,"maxLength":512},"to":{"type":"array","description":"Recipient email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"minItems":1,"maxItems":20}},"required":["draft_id","to","subject","body"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','1b7357bea6af450211be5feeed0550fd8df2e22d9510cf91f66029cb30431af7'),
	('gmail','delete_draft',1,'gmail_delete_draft','Permanently discard an unsent Gmail draft identified by draft_id. Does not send an email.','{"type":"object","properties":{"draft_id":{"type":"string","description":"Stable Gmail draft id returned by create_draft.","minLength":1,"maxLength":128}},"required":["draft_id"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','dba1105387234ccc09b554ea033f1a13e3da583821ba92d3b1720e6331724e53'),
	('gmail','send_draft',1,'gmail_send_draft','Send an existing Gmail draft with the exact complete content supplied here, atomically replacing its content on send. The email leaves immediately and Gmail removes the draft. A request to draft is not permission to send: present ask_member surface draft for review. Reuse the same idempotencyKey on retry and do not resend an uncertain outcome under another key.','{"type":"object","properties":{"body":{"type":"string","description":"Complete plain-text body.","minLength":1,"maxLength":50000},"cc":{"type":"array","description":"Cc email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"maxItems":20},"draft_id":{"type":"string","description":"Stable Gmail draft id returned by create_draft.","minLength":1,"maxLength":128},"reply_to_message_id":{"type":"string","description":"Gmail message id being answered, not a draft id.","minLength":1,"maxLength":64},"subject":{"type":"string","description":"Subject line.","minLength":1,"maxLength":512},"to":{"type":"array","description":"Recipient email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"minItems":1,"maxItems":20}},"required":["draft_id","to","subject","body"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','2be1d9f03432a387a2db75bffdd865643876ae324696f3e1586f6c1cd641d8c6'),
	('gmail','search_messages',1,'gmail_search_messages','Search the connected mailbox with Gmail search syntax, for example ''from:anna@example.com newer_than:7d is:unread''. Returns sender, recipients, subject, date and a snippet per message.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum messages to return (default 10).","minimum":1,"maximum":25},"query":{"type":"string","description":"Gmail search query. Empty lists the newest messages.","maxLength":512}},"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','249cadae2ffed50551d1bf67418e70115f5f2bc4cce695a4415c450ff5dd2209'),
	('gmail','read_message',1,'gmail_read_message','Read one email: headers, the plain-text body (HTML is reduced to text) and the list of attachments. Attachments are not downloaded.','{"type":"object","properties":{"message_id":{"type":"string","description":"Gmail message id from a search.","minLength":1,"maxLength":64}},"required":["message_id"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','25447eea32d68dc4db19aeb2bb6e6bff9acc0b8c2b686180dd7d118f0efe1e10'),
	('gmail','read_thread',1,'gmail_read_thread','Read a conversation thread: each message''s sender, date, subject and a shortened plain-text body.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum messages to include (default 10).","minimum":1,"maximum":20},"thread_id":{"type":"string","description":"Gmail thread id from a search.","minLength":1,"maxLength":64}},"required":["thread_id"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','8cc0ea6f8314c937ef5842d366489d34674f4a0a1acb752560665ab81729476e'),
	('gmail','send_message',1,'gmail_send_message','Send an email from the connected mailbox. Provide reply_to_message_id to answer inside an existing conversation. The email leaves the company immediately.','{"type":"object","properties":{"body":{"type":"string","description":"Plain-text body.","minLength":1,"maxLength":50000},"cc":{"type":"array","description":"Cc email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"maxItems":20},"reply_to_message_id":{"type":"string","description":"Gmail message id being answered; the reply joins that thread.","minLength":1,"maxLength":64},"subject":{"type":"string","description":"Subject line.","minLength":1,"maxLength":512},"to":{"type":"array","description":"Recipient email addresses.","items":{"type":"string","minLength":3,"maxLength":254},"minItems":1,"maxItems":20}},"required":["to","subject","body"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','1a31412ee908d124a0b87e06a91535ad45227299f8bd57fd6eb696d3ec7a7904'),
	('google_drive','search_files',1,'google_drive_search_files','Find files and folders in the connected Google Drive (including shared drives) by name, optionally inside one folder. Returns id, name, type, last modified and a link.','{"type":"object","properties":{"folder_id":{"type":"string","description":"Only direct children of this folder.","minLength":1,"maxLength":128},"limit":{"type":"integer","description":"Maximum files to return (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"Text the file name must contain. Empty lists recent files.","maxLength":256}},"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8c125c1d9cf126acbcc329314e89f30cf0feffd4f0d5fed6b148fac924b996fd'),
	('google_drive','read_file',1,'google_drive_read_file','Read a file''s text. Google Docs, Sheets and Slides are exported as plain text or CSV; text files are read directly; other files return metadata only.','{"type":"object","properties":{"file_id":{"type":"string","description":"Drive file id from a search.","minLength":1,"maxLength":128},"max_chars":{"type":"integer","description":"Maximum characters of text to return (default 5000).","minimum":200,"maximum":20000}},"required":["file_id"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8b5839d204083b9a70ae89923a1a57f9081ee6db5dfd0813aeff85add5ece590'),
	('google_drive','create_file',1,'google_drive_create_file','Create a new file with text content in the connected Google Drive, optionally inside a folder. Use the Google Docs type to create an editable document from the text.','{"type":"object","properties":{"content":{"type":"string","description":"Text content.","maxLength":60000},"folder_id":{"type":"string","description":"Parent folder id.","minLength":1,"maxLength":128},"mime_type":{"type":"string","description":"File type (default text/plain).","enum":["text/plain","text/markdown","text/csv","application/json","application/vnd.google-apps.document"]},"name":{"type":"string","description":"File name.","minLength":1,"maxLength":256}},"required":["name","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','fc53514b74dc4477de6d140ee6ac6f9ee434f435ae14c3ab8747c819d015fe39'),
	('google_drive','update_file',1,'google_drive_update_file','Replace the content of an existing text file or Google Doc with new text. The previous content is kept in Drive''s version history.','{"type":"object","properties":{"content":{"type":"string","description":"New text content.","maxLength":60000},"file_id":{"type":"string","description":"Drive file id.","minLength":1,"maxLength":128}},"required":["file_id","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','61d52e5b60b2dd11cb09dbef5d2c6a61ee78dcce725a77c97f07dd6c78199b81');
-- An existing version is immutable: refuse drift rather than updating a shipped row.
do $$ begin
	if exists (select 1 from pg_temp.qorpera_connector_catalog_release as proposed
		join public.qorpera_cloud_connector_operations as existing using (connector_id,operation_id,version)
		where row(proposed.connector_id,proposed.operation_id,proposed.version,proposed.tool_name,proposed.description,proposed.input_schema,proposed.destination_origin,proposed.credential_name,proposed.adapter_sha256)
			is distinct from row(existing.connector_id,existing.operation_id,existing.version,existing.tool_name,existing.description,existing.input_schema,existing.destination_origin,existing.credential_name,existing.adapter_sha256)) then
		raise exception 'Existing connector operation changed without a new version';
	end if;
end $$;
insert into public.qorpera_cloud_connector_operations (connector_id,operation_id,version,tool_name,description,input_schema,destination_origin,credential_name,adapter_sha256)
select connector_id,operation_id,version,tool_name,description,input_schema,destination_origin,credential_name,adapter_sha256 from pg_temp.qorpera_connector_catalog_release
on conflict (connector_id,operation_id,version) do nothing;
-- END GENERATED CONNECTOR CATALOG

create function public.qorpera_backfill_connector_operation_grants(
	p_connector_id text,
	p_source_operation_id text,
	p_operation_id text,
	p_operation_version bigint
)
returns integer
language plpgsql set search_path = '' as $$
declare
	v_issued integer;
begin
	with issued as (
		insert into public.qorpera_cloud_secret_operation_grants (
			profile_id, environment_id, secret_id, staff_agent_id, connector_id, operation_id, operation_version, tool_name,
			issued_by_user_id, expires_at
		)
		select source.profile_id, source.environment_id, source.secret_id, source.staff_agent_id,
			operation.connector_id, operation.operation_id, operation.version, operation.tool_name,
			source.issued_by_user_id, source.expires_at
		from public.qorpera_cloud_secret_operation_grants as source
		join public.qorpera_cloud_connector_operations as issuing on issuing.connector_id = source.connector_id
			and issuing.operation_id = source.operation_id and issuing.version = source.operation_version
			and issuing.status = 'active'
		join public.qorpera_cloud_secrets as secret on secret.id = source.secret_id
			and secret.profile_id = source.profile_id and secret.environment_id = source.environment_id
		join public.qorpera_profile_staff as staff on staff.profile_id = source.profile_id
			and staff.staff_agent_id = source.staff_agent_id and staff.employment_status = 'active'
		join public.qorpera_profile_members as issuer on issuer.profile_id = source.profile_id
			and issuer.user_id = source.issued_by_user_id and issuer.role in ('owner', 'admin')
		join public.qorpera_cloud_connector_operations as operation on operation.connector_id = p_connector_id
			and operation.operation_id = p_operation_id and operation.version = p_operation_version
			and operation.status = 'active'
		where source.connector_id = p_connector_id and source.operation_id = p_source_operation_id
			and source.status = 'active'
			and (source.expires_at is null or source.expires_at > statement_timestamp())
			and secret.connector_id = p_connector_id and secret.status = 'active' and secret.owner_kind = 'company'
			and secret.available_to_all_agents
			and not exists (
				select 1 from public.qorpera_cloud_secret_operation_grants as prior
				where prior.profile_id = source.profile_id and prior.environment_id = source.environment_id
					and prior.staff_agent_id = source.staff_agent_id and prior.tool_name = operation.tool_name
			)
		order by source.id
		returning *
	)
	insert into public.qorpera_cloud_secret_audit_events (
		profile_id, environment_id, secret_id, secret_version, grant_id, event_type, actor_user_id, connector_id,
		operation_id
	)
	select issued.profile_id, issued.environment_id, issued.secret_id, secret.current_version, issued.id,
		'grant_issued', issued.issued_by_user_id, issued.connector_id, issued.operation_id
	from issued join public.qorpera_cloud_secrets as secret on secret.id = issued.secret_id;
	get diagnostics v_issued = row_count;
	return v_issued;
end
$$;

revoke all on function public.qorpera_backfill_connector_operation_grants(text, text, text, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select public.qorpera_backfill_connector_operation_grants('github', 'create_issue', 'create_repository', 1);

commit;
