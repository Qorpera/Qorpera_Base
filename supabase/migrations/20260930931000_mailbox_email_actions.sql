begin;

do $$ begin
	if to_regclass('public.qorpera_mail_blocked_senders') is not null then
		raise exception '20260930931000 is already applied'; end if;
	if to_regclass('public.qorpera_google_mailboxes') is null
		or to_regprocedure('public.qorpera_backfill_connector_operation_grants(text,text,text,bigint)') is null
		or to_regprocedure('public.qorpera_member_mail_threads(uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_member_mail_thread(uuid,text,jsonb)') is null
		or to_regprocedure('public.qorpera_find_agent_mail(jsonb,jsonb)') is null then
		raise exception '20260930931000 needs 20260930927000, 20260930556000 and mailbox RPCs'; end if;
end $$;

set local lock_timeout = '3s';

create function pg_temp.mail_actions_patch(p_target regprocedure, variadic p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_index integer;
begin
	for v_index in 1 .. array_length(p_edits, 1) by 2 loop
		if p_edits[v_index] = ''
			or (length(v_definition) - length(replace(v_definition, p_edits[v_index], '')))
				/ length(p_edits[v_index]) <> 1 then
			raise exception '20260930931000 anchor % not found once in %: %',
				(v_index + 1) / 2, p_target, left(p_edits[v_index], 80);
		end if;
		v_definition := replace(v_definition, p_edits[v_index], p_edits[v_index + 1]);
	end loop;
	execute v_definition;
end
$$;

-- BEGIN GENERATED CONNECTOR CATALOG (scripts/generate-cloud-connector-catalog.mjs)
-- Catalog version 1: 24 operations.
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
	('gmail','list_messages',1,'gmail_list_messages','List or search Gmail messages with pagination and optional label filters (such as INBOX, STARRED, TRASH, SPAM, or UNREAD). Returns sender, recipients, subject, date, labels, is_starred, parsed unsubscribe options, snippet, and next_page_token.','{"type":"object","properties":{"include_spam_trash":{"type":"boolean","description":"Include messages in Spam and Trash (default false)."},"label_ids":{"type":"array","description":"Optional Gmail label ids to require, such as [''INBOX''], [''STARRED''], or [''TRASH''].","items":{"type":"string","minLength":1,"maxLength":64},"maxItems":10},"limit":{"type":"integer","description":"Maximum messages to return per page (default 25, max 50).","minimum":1,"maximum":50},"page_token":{"type":"string","description":"next_page_token from an earlier gmail_list_messages call.","minLength":1,"maxLength":256},"query":{"type":"string","description":"Optional Gmail search query.","maxLength":512}},"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','a0beac2da123510ec747402e7b8f61c3b67e600e295ad4d1e4bf39e0986ffa2d'),
	('gmail','update_messages',1,'gmail_update_messages','Perform reversible inbox actions on up to 50 Gmail messages at once: trash, untrash, archive (remove from Inbox), move_to_inbox, star, unstar, mark_read, mark_unread, or spam. Messages moved to Trash stay recoverable in Gmail Trash for 30 days (permanent deletion is not offered). Requires reconnecting older Gmail connections to grant modify access.','{"type":"object","properties":{"action":{"type":"string","description":"Reversible action to apply to all listed messages.","enum":["trash","untrash","archive","move_to_inbox","star","unstar","mark_read","mark_unread","spam"]},"message_ids":{"type":"array","description":"Gmail message ids to update (1 to 50).","items":{"type":"string","minLength":1,"maxLength":64},"minItems":1,"maxItems":50}},"required":["message_ids","action"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','77a556e413393f35fb93fc47745b66e80915029bc56ec1447a84b24acced9af8'),
	('gmail','block_sender',1,'gmail_block_sender','Block or unblock an email sender (exact email address or @domain) in Gmail by creating or removing a filter that automatically sends future messages from that sender to Trash and removes them from Inbox. Optionally moves up to 50 existing messages from that sender to Trash (default true). Requires reconnecting older Gmail connections to grant Gmail settings and modify access.','{"type":"object","properties":{"sender":{"type":"string","description":"Email address (news@example.com) or domain (@example.com) to block or unblock.","minLength":3,"maxLength":254},"trash_existing":{"type":"boolean","description":"When blocking, also move up to 50 existing non-trashed messages from this sender to Trash (default true)."},"unblock":{"type":"boolean","description":"When true, removes matching Gmail block filters for this sender instead of blocking (default false)."}},"required":["sender"],"additionalProperties":false}'::jsonb,'https://gmail.googleapis.com','refresh_token','018c311cf7de5b312121cb98cda7236582b21ecaf4da6096e573e3c0647491db'),
	('google_drive','search_files',1,'google_drive_search_files','Find files and folders in the connected Google Drive (including shared drives) by name, optionally inside one folder. Returns id, name, type, last modified and a link.','{"type":"object","properties":{"folder_id":{"type":"string","description":"Only direct children of this folder.","minLength":1,"maxLength":128},"limit":{"type":"integer","description":"Maximum files to return (default 20).","minimum":1,"maximum":50},"query":{"type":"string","description":"Text the file name must contain. Empty lists recent files.","maxLength":256}},"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8c125c1d9cf126acbcc329314e89f30cf0feffd4f0d5fed6b148fac924b996fd'),
	('google_drive','read_file',1,'google_drive_read_file','Read a file''s text. Google Docs, Sheets and Slides are exported as plain text or CSV; text files are read directly; other files return metadata only.','{"type":"object","properties":{"file_id":{"type":"string","description":"Drive file id from a search.","minLength":1,"maxLength":128},"max_chars":{"type":"integer","description":"Maximum characters of text to return (default 5000).","minimum":200,"maximum":20000}},"required":["file_id"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','8b5839d204083b9a70ae89923a1a57f9081ee6db5dfd0813aeff85add5ece590'),
	('google_drive','create_file',1,'google_drive_create_file','Create a new file with text content in the connected Google Drive, optionally inside a folder. Use the Google Docs type to create an editable document from the text.','{"type":"object","properties":{"content":{"type":"string","description":"Text content.","maxLength":60000},"folder_id":{"type":"string","description":"Parent folder id.","minLength":1,"maxLength":128},"mime_type":{"type":"string","description":"File type (default text/plain).","enum":["text/plain","text/markdown","text/csv","application/json","application/vnd.google-apps.document"]},"name":{"type":"string","description":"File name.","minLength":1,"maxLength":256}},"required":["name","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','fc53514b74dc4477de6d140ee6ac6f9ee434f435ae14c3ab8747c819d015fe39'),
	('google_drive','update_file',1,'google_drive_update_file','Replace the content of an existing text file or Google Doc with new text. The previous content is kept in Drive''s version history.','{"type":"object","properties":{"content":{"type":"string","description":"New text content.","maxLength":60000},"file_id":{"type":"string","description":"Drive file id.","minLength":1,"maxLength":128}},"required":["file_id","content"],"additionalProperties":false}'::jsonb,'https://www.googleapis.com','refresh_token','61d52e5b60b2dd11cb09dbef5d2c6a61ee78dcce725a77c97f07dd6c78199b81');
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

select public.qorpera_backfill_connector_operation_grants('gmail', 'search_messages', 'list_messages', 1);
select public.qorpera_backfill_connector_operation_grants('gmail', 'send_message', 'update_messages', 1);
select public.qorpera_backfill_connector_operation_grants('gmail', 'create_draft', 'update_messages', 1);
select public.qorpera_backfill_connector_operation_grants('gmail', 'send_message', 'block_sender', 1);

create index qorpera_google_mail_messages_mailbox_thread
	on public.qorpera_google_mail_messages (mailbox_id, gmail_thread_id)
	where gmail_thread_id is not null;

alter table public.qorpera_mail_threads
	add column starred boolean not null default false,
	add column archived_at timestamptz,
	add column trashed_at timestamptz;

create index qorpera_mail_threads_env_inbox
	on public.qorpera_mail_threads (environment_id, last_at desc, id desc)
	where trashed_at is null and archived_at is null;
create index qorpera_mail_threads_env_starred
	on public.qorpera_mail_threads (environment_id, last_at desc, id desc)
	where starred and trashed_at is null;
create index qorpera_mail_threads_env_trash
	on public.qorpera_mail_threads (environment_id, last_at desc, id desc)
	where trashed_at is not null;

alter table public.qorpera_mail_received
	add column unsubscribe jsonb check (unsubscribe is null or jsonb_typeof(unsubscribe) = 'object');

create function public.qorpera_url_decode_text(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_text text := replace(coalesce(p_value, ''), '+', ' ');
	v_len integer := char_length(v_text);
	v_pos integer := 1;
	v_chunk text;
	v_bytes bytea := ''::bytea;
begin
	if v_text = '' then return ''; end if;
	while v_pos <= v_len loop
		if substr(v_text, v_pos, 1) = '%' and v_pos + 2 <= v_len
			and substr(v_text, v_pos + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
			if substr(v_text, v_pos + 1, 2) <> '00' then
				v_bytes := v_bytes || decode(substr(v_text, v_pos + 1, 2), 'hex');
			end if;
			v_pos := v_pos + 3;
		else
			v_chunk := substr(v_text, v_pos, 1);
			v_bytes := v_bytes || convert_to(v_chunk, 'UTF8');
			v_pos := v_pos + 1;
		end if;
	end loop;
	return convert_from(v_bytes, 'UTF8');
exception when others then
	return p_value;
end
$$;
revoke all on function public.qorpera_url_decode_text(text) from public, anon, authenticated, service_role;

create function public.qorpera_parse_mail_unsubscribe(p_list_unsubscribe text, p_list_unsubscribe_post text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
	c_email constant text := '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	v_match text[];
	v_entry text;
	v_lower text;
	v_count integer := 0;
	v_one_click_candidate text;
	v_one_click text;
	v_mailto jsonb;
	v_web_urls text[] := '{}';
	v_rest text;
	v_qpos integer;
	v_addr text;
	v_query text;
	v_pair text;
	v_key text;
	v_val text;
	v_subject text;
	v_body text;
	v_supports_one_click boolean;
begin
	if p_list_unsubscribe is null or btrim(p_list_unsubscribe) = '' then
		return null;
	end if;
	for v_match in
		select regexp_matches(p_list_unsubscribe, '<([^<>]+)>', 'g')
	loop
		v_count := v_count + 1;
		exit when v_count > 16;
		v_entry := btrim(regexp_replace(coalesce(v_match[1], ''), E'[\r\n\t]+', '', 'g'));
		if v_entry = '' or char_length(v_entry) > 2048 or v_entry ~ '[[:cntrl:]]' then
			continue;
		end if;
		v_lower := lower(v_entry);
		if v_lower like 'mailto:%' then
			if v_mailto is null then
				v_rest := substr(v_entry, 8);
				v_qpos := position('?' in v_rest);
				if v_qpos > 0 then
					v_addr := lower(btrim(public.qorpera_url_decode_text(substr(v_rest, 1, v_qpos - 1))));
					v_query := substr(v_rest, v_qpos + 1);
				else
					v_addr := lower(btrim(public.qorpera_url_decode_text(v_rest)));
					v_query := null;
				end if;
				if char_length(v_addr) between 3 and 254 and v_addr ~ c_email then
					v_subject := null;
					v_body := null;
					if v_query is not null and v_query <> '' then
						for v_pair in select unnest(string_to_array(v_query, '&')) loop
							if position('=' in v_pair) > 0 then
								v_key := lower(btrim(split_part(v_pair, '=', 1)));
								v_val := public.qorpera_url_decode_text(substr(v_pair, position('=' in v_pair) + 1));
								if v_key = 'subject' and v_subject is null then
									v_subject := nullif(left(btrim(regexp_replace(v_val, '[[:cntrl:]]+', ' ', 'g')), 200), '');
								elsif v_key = 'body' and v_body is null then
									v_body := nullif(left(btrim(regexp_replace(v_val, E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]+', '', 'g')), 2000), '');
								end if;
							end if;
						end loop;
					end if;
					v_mailto := jsonb_strip_nulls(jsonb_build_object(
						'to', v_addr,
						'subject', v_subject,
						'body', v_body
					));
				end if;
			end if;
		elsif (v_lower like 'https://%' or v_lower like 'http://%')
			and v_entry ~* '^https?://[^[:space:]/?#]+(/|\?|#|$)' then
			if v_one_click_candidate is null
				and v_entry ~* '^https://[^[:space:]/?#@:]+(:443)?(/|\?|$)' then
				v_one_click_candidate := v_entry;
			end if;
			if not (v_entry = any(v_web_urls)) and cardinality(v_web_urls) < 5 then
				v_web_urls := array_append(v_web_urls, v_entry);
			end if;
		end if;
	end loop;
	v_supports_one_click := coalesce(p_list_unsubscribe_post, '') ~* '(^|[;[:space:],])list-unsubscribe[[:space:]]*=[[:space:]]*one-click($|[;[:space:],])';
	if v_supports_one_click then
		v_one_click := v_one_click_candidate;
	end if;
	if v_one_click is null and v_mailto is null and cardinality(v_web_urls) = 0 then
		return null;
	end if;
	return jsonb_strip_nulls(jsonb_build_object(
		'oneClickUrl', v_one_click,
		'mailto', v_mailto,
		'webUrls', case when cardinality(v_web_urls) > 0 then to_jsonb(v_web_urls) end
	));
end
$$;
revoke all on function public.qorpera_parse_mail_unsubscribe(text, text) from public, anon, authenticated, service_role;

create table public.qorpera_mail_blocked_senders (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	sender text not null check (char_length(sender) between 3 and 254 and sender = lower(sender)),
	match_kind text not null check (match_kind in ('address', 'domain')),
	created_by_user_id uuid,
	created_by_staff_agent_id uuid,
	created_at timestamptz not null default clock_timestamp(),
	unique (profile_id, environment_id, sender)
);
create index qorpera_mail_blocked_senders_env on public.qorpera_mail_blocked_senders (environment_id, created_at desc, id desc);
alter table public.qorpera_mail_blocked_senders enable row level security;
revoke all on table public.qorpera_mail_blocked_senders from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_normalize_mail_block_sender(p_raw text)
returns table (sender text, match_kind text)
language plpgsql
immutable
set search_path = ''
as $$
declare
	c_email constant text := '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	c_domain constant text := '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$';
	v_trimmed text;
	v_candidate text;
	v_domain text;
begin
	if p_raw is null or char_length(btrim(p_raw)) not between 3 and 320 or p_raw ~ '[[:cntrl:]]' then
		raise exception 'Sender must be a valid email address or domain' using errcode = '22023';
	end if;
	v_trimmed := btrim(p_raw);
	v_candidate := lower(btrim(coalesce(substring(v_trimmed from '<([^<>]+)>\s*$'), v_trimmed)));
	if char_length(v_candidate) not between 3 and 254 or v_candidate ~ '[\s,;''"<>\\]' then
		raise exception 'Sender must be a valid email address or domain' using errcode = '22023';
	end if;
	if v_candidate ~ c_email then
		return query select v_candidate, 'address'::text;
		return;
	end if;
	v_domain := case when left(v_candidate, 1) = '@' then substr(v_candidate, 2) else v_candidate end;
	if char_length(v_domain) <= 253 and v_domain ~ c_domain then
		return query select '@' || v_domain, 'domain'::text;
		return;
	end if;
	raise exception 'Sender must be a valid email address or domain' using errcode = '22023';
end
$$;
revoke all on function public.qorpera_normalize_mail_block_sender(text) from public, anon, authenticated, service_role;

create function public.qorpera_mail_sender_is_blocked(p_profile_id uuid, p_environment_id uuid, p_from_address text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select case
		when p_from_address is null or btrim(p_from_address) = '' then false
		else exists (
			select 1 from public.qorpera_mail_blocked_senders as blocked
			where blocked.profile_id = p_profile_id
				and blocked.environment_id = p_environment_id
				and (
					(blocked.match_kind = 'address' and blocked.sender = lower(btrim(p_from_address)))
					or (blocked.match_kind = 'domain'
						and position('@' in p_from_address) > 0
						and blocked.sender = '@' || split_part(lower(btrim(p_from_address)), '@', 2))
				)
		)
	end
$$;
revoke all on function public.qorpera_mail_sender_is_blocked(uuid, uuid, text) from public, anon, authenticated, service_role;

create table public.qorpera_mail_unsubscribes (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	mailbox_id uuid not null references public.qorpera_company_mailboxes(id) on delete cascade,
	thread_id text not null references public.qorpera_mail_threads(id) on delete cascade,
	delivery_id uuid,
	sender_address text check (sender_address is null or char_length(sender_address) <= 320),
	method text not null check (method in ('one_click', 'mailto', 'browser')),
	target_url text check (target_url is null or (char_length(target_url) <= 2048 and target_url ~* '^https?://')),
	mailto_address text check (mailto_address is null or char_length(mailto_address) <= 320),
	outbox_mail_id uuid references public.qorpera_company_mail_outbox(id) on delete set null,
	status text not null default 'pending'
		check (status in ('pending', 'retrying', 'delivering', 'succeeded', 'failed', 'browser_required')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default clock_timestamp(),
	lease_id uuid,
	lease_expires_at timestamptz,
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	requested_by_user_id uuid,
	requested_by_staff_agent_id uuid,
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz
);
create index qorpera_mail_unsubscribes_due
	on public.qorpera_mail_unsubscribes (next_attempt_at)
	where method = 'one_click' and status in ('pending', 'retrying', 'delivering');
create index qorpera_mail_unsubscribes_thread
	on public.qorpera_mail_unsubscribes (thread_id, created_at desc, id desc);
alter table public.qorpera_mail_unsubscribes enable row level security;
revoke all on table public.qorpera_mail_unsubscribes from public, anon, authenticated, service_role, qorpera_secret_broker;

create trigger qorpera_mail_unsubscribes_kick
	after insert on public.qorpera_mail_unsubscribes
	for each row when (new.method = 'one_click' and new.status = 'pending')
	execute function public.qorpera_mail_outbox_kick();

create function public.qorpera_mail_domains_match(p_sender_address text, p_target_address text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_a text;
	v_b text;
	v_a_parts text[];
	v_b_parts text[];
	v_a_len integer;
	v_b_len integer;
	v_sld text;
	v_tld text;
begin
	if p_sender_address is null or p_target_address is null
		or position('@' in p_sender_address) = 0 or position('@' in p_target_address) = 0 then
		return false;
	end if;
	v_a := lower(btrim(split_part(p_sender_address, '@', 2)));
	v_b := lower(btrim(split_part(p_target_address, '@', 2)));
	if v_a = '' or v_b = '' or v_a !~ '^[a-z0-9.-]+$' or v_b !~ '^[a-z0-9.-]+$' then
		return false;
	end if;
	if v_a = v_b or v_a like '%.' || v_b or v_b like '%.' || v_a then
		return true;
	end if;
	v_a_parts := string_to_array(v_a, '.');
	v_b_parts := string_to_array(v_b, '.');
	v_a_len := coalesce(array_length(v_a_parts, 1), 0);
	v_b_len := coalesce(array_length(v_b_parts, 1), 0);
	if v_a_len < 2 or v_b_len < 2 then
		return false;
	end if;
	v_tld := v_a_parts[v_a_len];
	v_sld := v_a_parts[v_a_len - 1];
	if v_tld <> v_b_parts[v_b_len] or v_sld <> v_b_parts[v_b_len - 1] then
		return false;
	end if;
	if v_tld ~ '^[a-z]{2}$' and v_sld in (
		'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'mil',
		'or', 'ne', 'go', 'gr', 'ad', 'ed', 'lg', 'nic', 'nom', 'sch', 'ltd', 'plc'
	) then
		return v_a_len >= 3 and v_b_len >= 3 and v_a_parts[v_a_len - 2] = v_b_parts[v_b_len - 2];
	end if;
	return true;
end
$$;
revoke all on function public.qorpera_mail_domains_match(text, text) from public, anon, authenticated, service_role;

create function public.qorpera_mail_unsubscribe_subject(p_raw text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
	v_clean text;
begin
	v_clean := btrim(regexp_replace(coalesce(p_raw, ''), '[[:cntrl:]]+', ' ', 'g'));
	v_clean := regexp_replace(v_clean, '\s+', ' ', 'g');
	if v_clean <> ''
		and char_length(v_clean) <= 80
		and v_clean !~ '://'
		and position('@' in v_clean) = 0
		and v_clean ~* '^unsubscribe([[:space:]:_-]+[a-z0-9._:/=-]{1,64})?$' then
		return v_clean;
	end if;
	return 'Unsubscribe';
end
$$;
revoke all on function public.qorpera_mail_unsubscribe_subject(text) from public, anon, authenticated, service_role;

create function public.qorpera_claim_mail_unsubscribes(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_now timestamptz := clock_timestamp();
	v_result jsonb;
begin
	if p_limit is null or p_limit not between 1 and 50 or p_lease_id is null then
		raise exception 'Unsubscribe claim is invalid' using errcode = '22023';
	end if;
	update public.qorpera_mail_unsubscribes
	set status = 'failed',
		settled_at = v_now,
		lease_id = null,
		lease_expires_at = null,
		last_error = coalesce(last_error, case
			when created_at <= v_now - interval '1 day' then 'Unsubscribe request expired'
			else 'Unsubscribe request exceeded retry limit'
		end)
	where method = 'one_click'
		and status in ('pending', 'retrying', 'delivering')
		and (lease_expires_at is null or lease_expires_at <= v_now)
		and (attempt_count >= 5 or created_at <= v_now - interval '1 day');
	with candidates as (
		select u.id
		from public.qorpera_mail_unsubscribes as u
		where u.method = 'one_click'
			and u.target_url is not null
			and u.status in ('pending', 'retrying', 'delivering')
			and u.next_attempt_at <= v_now
			and (u.lease_expires_at is null or u.lease_expires_at <= v_now)
			and u.attempt_count < 5
			and u.created_at > v_now - interval '1 day'
		order by u.next_attempt_at, u.created_at, u.id
		for update skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_mail_unsubscribes as u
		set status = 'delivering',
			attempt_count = u.attempt_count + 1,
			lease_id = p_lease_id,
			lease_expires_at = v_now + interval '5 minutes'
		from candidates
		where u.id = candidates.id
		returning u.*
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'unsubscribeId', claimed.id,
		'leaseId', claimed.lease_id,
		'url', claimed.target_url,
		'attemptCount', claimed.attempt_count
	) order by claimed.created_at, claimed.id), '[]'::jsonb)
	into v_result
	from claimed;
	return v_result;
end
$$;
revoke all on function public.qorpera_claim_mail_unsubscribes(integer, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_claim_mail_unsubscribes(integer, uuid) to service_role;

create function public.qorpera_release_mail_unsubscribe(p_unsubscribe_id uuid, p_lease_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
begin
	update public.qorpera_mail_unsubscribes
	set status = case when attempt_count <= 1 then 'pending' else 'retrying' end,
		attempt_count = greatest(attempt_count - 1, 0),
		lease_id = null,
		lease_expires_at = null
	where id = p_unsubscribe_id and lease_id = p_lease_id and status = 'delivering';
	return found;
end
$$;
revoke all on function public.qorpera_release_mail_unsubscribe(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_release_mail_unsubscribe(uuid, uuid) to service_role;

create function public.qorpera_complete_mail_unsubscribe(p_unsubscribe_id uuid, p_lease_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
begin
	update public.qorpera_mail_unsubscribes
	set status = 'succeeded',
		settled_at = clock_timestamp(),
		lease_id = null,
		lease_expires_at = null,
		last_error = null
	where id = p_unsubscribe_id and lease_id = p_lease_id and status = 'delivering';
	return found;
end
$$;
revoke all on function public.qorpera_complete_mail_unsubscribe(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_complete_mail_unsubscribe(uuid, uuid) to service_role;

create function public.qorpera_fail_mail_unsubscribe(
	p_unsubscribe_id uuid,
	p_lease_id uuid,
	p_error text,
	p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
begin
	if p_retryable is null then
		raise exception 'Unsubscribe failure is invalid' using errcode = '22023';
	end if;
	update public.qorpera_mail_unsubscribes
	set status = case when p_retryable and attempt_count < 5 then 'retrying' else 'failed' end,
		settled_at = case when p_retryable and attempt_count < 5 then null else clock_timestamp() end,
		next_attempt_at = clock_timestamp() + least(interval '30 minutes', interval '1 minute' * power(2, greatest(attempt_count - 1, 0))),
		lease_id = null,
		lease_expires_at = null,
		last_error = left(coalesce(nullif(btrim(p_error), ''), 'Unsubscribe request failed'), 1000)
	where id = p_unsubscribe_id and lease_id = p_lease_id and status = 'delivering';
	return found;
end
$$;
revoke all on function public.qorpera_fail_mail_unsubscribe(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_fail_mail_unsubscribe(uuid, uuid, text, boolean) to service_role;

create function public.qorpera_member_mail_thread_unsubscribe(p_profile_id uuid, p_thread_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_rec record;
	v_attempt record;
	v_status text;
	v_mailto_to text;
	v_now timestamptz := clock_timestamp();
begin
	select rec.delivery_id, rec.from_address, rec.unsubscribe
	into v_rec
	from public.qorpera_mail_received as rec
	where rec.thread_id = p_thread_id and rec.profile_id = p_profile_id and rec.unsubscribe is not null
	order by rec.received_at desc, rec.delivery_id desc
	limit 1;
	if not found then
		return null;
	end if;
	v_mailto_to := v_rec.unsubscribe #>> '{mailto,to}';
	if v_mailto_to is not null and not public.qorpera_mail_domains_match(v_rec.from_address, v_mailto_to) then
		v_mailto_to := null;
	end if;
	if not (v_rec.unsubscribe ? 'oneClickUrl') and v_mailto_to is null
		and coalesce(jsonb_array_length(v_rec.unsubscribe -> 'webUrls'), 0) = 0 then
		return null;
	end if;
	select u.id, u.method, u.status, u.last_error, u.created_at, u.attempt_count, u.lease_expires_at,
		mail.status as mail_status
	into v_attempt
	from public.qorpera_mail_unsubscribes as u
	left join public.qorpera_company_mail_outbox as mail on mail.id = u.outbox_mail_id
	where u.thread_id = p_thread_id and u.profile_id = p_profile_id
	order by u.created_at desc, u.id desc
	limit 1;
	if found then
		if v_attempt.method = 'mailto' and v_attempt.mail_status is not null then
			v_status := case
				when v_attempt.mail_status = 'sent' then 'succeeded'
				when v_attempt.mail_status in ('failed', 'cancelled') then 'failed'
				else 'queued'
			end;
		elsif v_attempt.method = 'one_click'
			and v_attempt.status in ('pending', 'retrying', 'delivering')
			and (v_attempt.lease_expires_at is null or v_attempt.lease_expires_at <= v_now)
			and (v_attempt.attempt_count >= 5 or v_attempt.created_at <= v_now - interval '1 day') then
			v_status := 'failed';
		elsif v_attempt.status in ('pending', 'retrying', 'delivering') then
			v_status := 'queued';
		else
			v_status := v_attempt.status;
		end if;
	end if;
	return jsonb_strip_nulls(jsonb_build_object(
		'deliveryId', v_rec.delivery_id,
		'oneClick', v_rec.unsubscribe ? 'oneClickUrl',
		'mailto', v_mailto_to,
		'webUrl', v_rec.unsubscribe #>> '{webUrls,0}',
		'urls', v_rec.unsubscribe -> 'webUrls',
		'status', v_status,
		'method', case when v_status is not null then v_attempt.method end,
		'requestedAt', case when v_status is not null then v_attempt.created_at end,
		'lastError', case when v_status = 'failed' then coalesce(v_attempt.last_error, 'Unsubscribe request failed') end
	));
end
$$;
revoke all on function public.qorpera_member_mail_thread_unsubscribe(uuid, text) from public, anon, authenticated, service_role;

create table public.qorpera_google_mail_actions (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	mailbox_id uuid not null references public.qorpera_google_mailboxes(mailbox_id) on delete cascade,
	action text not null check (action in ('trash', 'untrash', 'archive', 'unarchive', 'star', 'unstar', 'block_sender', 'unblock_sender')),
	thread_id text check (thread_id is null or thread_id ~ '^[A-Za-z0-9_-]{43}$'),
	gmail_thread_ids text[] not null default '{}' check (cardinality(gmail_thread_ids) <= 50),
	sender text check (sender is null or char_length(sender) <= 254),
	status text not null default 'pending' check (status in ('pending', 'retrying', 'delivering', 'done', 'failed')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default clock_timestamp(),
	lease_id uuid,
	lease_until timestamptz,
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	created_at timestamptz not null default clock_timestamp(),
	settled_at timestamptz
);
create index qorpera_google_mail_actions_due
	on public.qorpera_google_mail_actions (profile_id, next_attempt_at)
	where status in ('pending', 'retrying', 'delivering');
alter table public.qorpera_google_mail_actions enable row level security;
revoke all on table public.qorpera_google_mail_actions from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_enqueue_google_mail_thread_action(p_thread_id text, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_thread public.qorpera_mail_threads%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_gmail_threads text[];
	v_axis text[];
begin
	select * into v_thread from public.qorpera_mail_threads where id = p_thread_id;
	if not found then return; end if;
	select * into v_google from public.qorpera_google_mailboxes
	where mailbox_id = v_thread.mailbox_id and removed_at is null;
	if not found then return; end if;
	select coalesce(array_agg(distinct gm.gmail_thread_id order by gm.gmail_thread_id), '{}')
	into v_gmail_threads
	from (
		select known.gmail_thread_id
		from public.qorpera_mail_received as rec
		join public.qorpera_google_mail_messages as known on known.delivery_id = rec.delivery_id
		where rec.thread_id = v_thread.id and rec.profile_id = v_thread.profile_id
			and known.gmail_thread_id is not null
		union
		select known.gmail_thread_id
		from public.qorpera_company_mail_outbox as mail
		join public.qorpera_google_mail_messages as known on known.mail_id = mail.id
		where mail.thread = v_thread.id and mail.profile_id = v_thread.profile_id
			and known.gmail_thread_id is not null
	) as gm;
	if cardinality(v_gmail_threads) = 0 then return; end if;
	v_axis := case when p_action in ('star', 'unstar')
		then array['star', 'unstar']
		else array['trash', 'untrash', 'archive', 'unarchive']
	end;
	update public.qorpera_google_mail_actions
	set status = 'done',
		settled_at = clock_timestamp(),
		last_error = 'Superseded by newer action'
	where mailbox_id = v_google.mailbox_id
		and thread_id = v_thread.id
		and status in ('pending', 'retrying')
		and action = any(v_axis);
	insert into public.qorpera_google_mail_actions (
		profile_id, environment_id, mailbox_id, action, thread_id, gmail_thread_ids
	) values (
		v_thread.profile_id, v_thread.environment_id, v_google.mailbox_id, p_action, v_thread.id, v_gmail_threads[1:50]
	);
end
$$;
revoke all on function public.qorpera_enqueue_google_mail_thread_action(text, text) from public, anon, authenticated, service_role;

create function public.qorpera_enqueue_google_mail_sender_action(
	p_profile_id uuid,
	p_environment_id uuid,
	p_sender text,
	p_action text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.qorpera_google_mail_actions as existing
	set status = 'done',
		settled_at = clock_timestamp(),
		last_error = 'Superseded by newer action'
	from public.qorpera_google_mailboxes as google
	where existing.mailbox_id = google.mailbox_id
		and google.profile_id = p_profile_id
		and google.environment_id = p_environment_id
		and google.removed_at is null
		and existing.sender = p_sender
		and existing.status in ('pending', 'retrying')
		and existing.action in ('block_sender', 'unblock_sender');
	insert into public.qorpera_google_mail_actions (
		profile_id, environment_id, mailbox_id, action, sender
	)
	select google.profile_id, google.environment_id, google.mailbox_id, p_action, p_sender
	from public.qorpera_google_mailboxes as google
	where google.profile_id = p_profile_id and google.environment_id = p_environment_id and google.removed_at is null;
end
$$;
revoke all on function public.qorpera_enqueue_google_mail_sender_action(uuid, uuid, text, text) from public, anon, authenticated, service_role;

create function public.qorpera_apply_google_delivery_labels(
	p_profile_id uuid,
	p_delivery_id uuid,
	p_labels jsonb,
	p_at timestamptz,
	p_imported boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_thread_id text;
	v_has_starred boolean;
	v_has_trash boolean;
	v_has_inbox boolean;
	v_has_sent boolean;
begin
	if p_delivery_id is null or jsonb_typeof(p_labels) <> 'array' then return; end if;
	select rec.thread_id into v_thread_id from public.qorpera_mail_received as rec
	where rec.delivery_id = p_delivery_id and rec.profile_id = p_profile_id;
	if not found then return; end if;
	v_has_starred := p_labels ? 'STARRED';
	v_has_trash := p_labels ? 'TRASH';
	v_has_inbox := p_labels ? 'INBOX';
	v_has_sent := p_labels ? 'SENT';
	update public.qorpera_mail_threads
	set starred = starred or v_has_starred,
		trashed_at = case
			when v_has_trash then coalesce(trashed_at, p_at)
			when v_has_inbox
				and not public.qorpera_mail_sender_is_blocked(profile_id, environment_id, outside_address) then null
			else trashed_at
		end,
		archived_at = case
			when v_has_inbox then null
			when p_imported and not v_has_trash and not v_has_sent and message_count = 1 then coalesce(archived_at, p_at)
			else archived_at
		end
	where id = v_thread_id and profile_id = p_profile_id;
end
$$;
revoke all on function public.qorpera_apply_google_delivery_labels(uuid, uuid, jsonb, timestamptz, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claim_google_mail_actions(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_now timestamptz := clock_timestamp();
	v_lease uuid := extensions.gen_random_uuid();
	v_result jsonb;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_limit is null or p_limit not between 1 and 20 then
		raise exception 'Google mail action claim is invalid' using errcode = '22023';
	end if;
	update public.qorpera_google_mail_actions
	set status = 'failed',
		settled_at = v_now,
		lease_id = null,
		lease_until = null,
		last_error = coalesce(last_error, 'Google mail action exceeded retry limit')
	where profile_id = v_authority.profile_id
		and status in ('pending', 'retrying', 'delivering')
		and (lease_until is null or lease_until <= v_now)
		and attempt_count >= 8;
	with candidates as (
		select action.id
		from public.qorpera_google_mail_actions as action
		join public.qorpera_google_mailboxes as google
			on google.mailbox_id = action.mailbox_id and google.removed_at is null and google.state <> 'sign_in_again'
		join public.qorpera_cloud_secrets as secret on secret.id = google.secret_id and secret.status = 'active'
		join public.qorpera_cloud_secret_versions as version
			on version.secret_id = secret.id and version.version = secret.current_version
				and version.broker_authority_id = v_authority.id
		where action.profile_id = v_authority.profile_id
			and action.status in ('pending', 'retrying', 'delivering')
			and action.next_attempt_at <= v_now
			and (action.lease_until is null or action.lease_until <= v_now)
			and action.attempt_count < 8
			and not exists (
				select 1 from public.qorpera_google_mail_actions as earlier
				where earlier.mailbox_id = action.mailbox_id
					and earlier.status in ('pending', 'retrying', 'delivering')
					and (earlier.created_at, earlier.id) < (action.created_at, action.id)
					and (
						(action.thread_id is not null and earlier.thread_id = action.thread_id)
						or (action.sender is not null and earlier.sender = action.sender)
					)
			)
		order by action.next_attempt_at, action.created_at, action.id
		for update of action skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_google_mail_actions as action
		set status = 'delivering',
			attempt_count = action.attempt_count + 1,
			lease_id = v_lease,
			lease_until = v_now + interval '5 minutes'
		from candidates
		where action.id = candidates.id
		returning action.*
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'actionId', claimed.id,
		'leaseId', claimed.lease_id,
		'mailboxId', claimed.mailbox_id,
		'address', google.address,
		'action', claimed.action,
		'gmailThreadIds', to_jsonb(claimed.gmail_thread_ids),
		'sender', claimed.sender,
		'companyId', secret.profile_id,
		'environmentId', secret.environment_id,
		'secretId', secret.id,
		'secretVersion', secret.current_version,
		'keyId', version.key_id,
		'encryptedEnvelopeBase64', translate(encode(version.encrypted_envelope, 'base64'), E'\n', ''),
		'envelopeSha256', version.envelope_sha256
	) order by claimed.created_at, claimed.id), '[]'::jsonb)
	into v_result
	from claimed
	join public.qorpera_google_mailboxes as google on google.mailbox_id = claimed.mailbox_id
	join public.qorpera_cloud_secrets as secret on secret.id = google.secret_id
	join public.qorpera_cloud_secret_versions as version
		on version.secret_id = secret.id and version.version = secret.current_version;
	return jsonb_build_object('schema', 'qorpera.google-mail-actions/v1', 'actions', v_result);
end
$$;
revoke all on function public.qorpera_claim_google_mail_actions(uuid, text, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_claim_google_mail_actions(uuid, text, integer) to qorpera_secret_broker;

create function public.qorpera_complete_google_mail_action(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_action_id uuid,
	p_lease_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	update public.qorpera_google_mail_actions
	set status = 'done', settled_at = clock_timestamp(), lease_id = null, lease_until = null, last_error = null
	where id = p_action_id and lease_id = p_lease_id and status = 'delivering'
		and profile_id = v_authority.profile_id;
	return jsonb_build_object('schema', 'qorpera.google-mail-action/v1', 'completed', found);
end
$$;
revoke all on function public.qorpera_complete_google_mail_action(uuid, text, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_google_mail_action(uuid, text, uuid, uuid) to qorpera_secret_broker;

create function public.qorpera_fail_google_mail_action(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_action_id uuid,
	p_lease_id uuid,
	p_error text,
	p_retryable boolean,
	p_refused boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_action public.qorpera_google_mail_actions%rowtype;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if p_retryable is null or p_refused is null then
		raise exception 'Google mail action answer is invalid' using errcode = '22023';
	end if;
	update public.qorpera_google_mail_actions
	set status = case when (p_retryable or p_refused) and attempt_count < 8 then 'retrying' else 'failed' end,
		settled_at = case when (p_retryable or p_refused) and attempt_count < 8 then null else clock_timestamp() end,
		next_attempt_at = clock_timestamp()
			+ least(interval '1 hour', interval '1 minute' * power(2, greatest(attempt_count - 1, 0))),
		last_error = case when p_refused then 'Google asked you to sign in again.'
			else left(coalesce(nullif(btrim(p_error), ''), 'Google did not apply the change'), 1000) end,
		lease_id = null,
		lease_until = null
	where id = p_action_id and lease_id = p_lease_id and status = 'delivering'
		and profile_id = v_authority.profile_id
	returning * into v_action;
	if v_action.id is null then
		return jsonb_build_object('schema', 'qorpera.google-mail-action/v1', 'completed', false);
	end if;
	if p_refused then
		update public.qorpera_google_mailboxes
		set state = 'sign_in_again', due_at = null, lease_id = null, lease_until = null,
			last_error = 'Google asked you to sign in again.', updated_at = clock_timestamp()
		where mailbox_id = v_action.mailbox_id and removed_at is null;
	end if;
	return jsonb_build_object('schema', 'qorpera.google-mail-action/v1', 'completed', true, 'status', v_action.status);
end
$$;
revoke all on function public.qorpera_fail_google_mail_action(uuid, text, uuid, uuid, text, boolean, boolean)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_fail_google_mail_action(uuid, text, uuid, uuid, text, boolean, boolean)
	to qorpera_secret_broker;

create function public.qorpera_apply_google_mail_label_changes(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_mailbox_id uuid,
	p_lease_id uuid,
	p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_google public.qorpera_google_mailboxes%rowtype;
	v_item jsonb;
	v_gmail_thread text;
	v_updated integer := 0;
	v_rows integer;
begin
	v_authority := public.qorpera_google_mailbox_authority(p_broker_authority_id, p_broker_capability_sha256);
	if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) > 200 then
		raise exception 'Google label changes are invalid' using errcode = '22023';
	end if;
	v_google := public.qorpera_google_mailbox_leased(v_authority.profile_id, p_mailbox_id, p_lease_id);
	for v_item in select value from jsonb_array_elements(p_changes) loop
		if jsonb_typeof(v_item) <> 'object' then continue; end if;
		v_gmail_thread := v_item ->> 'gmailThreadId';
		if v_gmail_thread is null or v_gmail_thread !~ '^[A-Za-z0-9_-]{1,64}$' then continue; end if;
		update public.qorpera_mail_threads as thread
		set starred = case when jsonb_typeof(v_item -> 'starred') = 'boolean' then (v_item ->> 'starred')::boolean else thread.starred end,
			trashed_at = case
				when jsonb_typeof(v_item -> 'trashed') = 'boolean' and (v_item ->> 'trashed')::boolean then coalesce(thread.trashed_at, clock_timestamp())
				when jsonb_typeof(v_item -> 'trashed') = 'boolean' and not (v_item ->> 'trashed')::boolean then null
				else thread.trashed_at
			end,
			archived_at = case
				when jsonb_typeof(v_item -> 'archived') = 'boolean' and (v_item ->> 'archived')::boolean then coalesce(thread.archived_at, clock_timestamp())
				when jsonb_typeof(v_item -> 'archived') = 'boolean' and not (v_item ->> 'archived')::boolean then null
				else thread.archived_at
			end
		where thread.profile_id = v_google.profile_id
			and thread.mailbox_id = v_google.mailbox_id
			and (
				exists (
					select 1 from public.qorpera_mail_received as rec
					join public.qorpera_google_mail_messages as known on known.delivery_id = rec.delivery_id
					where rec.thread_id = thread.id and known.mailbox_id = v_google.mailbox_id
						and known.gmail_thread_id = v_gmail_thread
				)
				or exists (
					select 1 from public.qorpera_company_mail_outbox as mail
					join public.qorpera_google_mail_messages as known on known.mail_id = mail.id
					where mail.thread = thread.id and known.mailbox_id = v_google.mailbox_id
						and known.gmail_thread_id = v_gmail_thread
				)
			);
		get diagnostics v_rows = row_count;
		v_updated := v_updated + v_rows;
	end loop;
	return jsonb_build_object('schema', 'qorpera.google-mail-labels/v1', 'updated', v_updated);
end
$$;
revoke all on function public.qorpera_apply_google_mail_label_changes(uuid, text, uuid, uuid, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_apply_google_mail_label_changes(uuid, text, uuid, uuid, jsonb)
	to qorpera_secret_broker;

create function public.qorpera_mail_apply_thread_action(
	p_profile_id uuid,
	p_environment_id uuid,
	p_threads text[],
	p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_ids text[];
	v_tid text;
	v_updated text[] := '{}';
	v_google_action text;
begin
	if p_action is null or p_action not in ('trash', 'restore', 'archive', 'unarchive', 'star', 'unstar') then
		raise exception 'Mail thread action is invalid' using errcode = '22023';
	end if;
	if p_threads is null or cardinality(p_threads) not between 1 and 50 then
		raise exception 'Provide between 1 and 50 mail thread ids' using errcode = '22023';
	end if;
	if exists (select 1 from unnest(p_threads) as item where item is null or item !~ '^[A-Za-z0-9_-]{43}$') then
		raise exception 'Mail thread id is invalid' using errcode = '22023';
	end if;
	select array_agg(distinct item order by item) into v_ids from unnest(p_threads) as item;
	v_google_action := case p_action when 'restore' then 'untrash' else p_action end;
	for v_tid in
		update public.qorpera_mail_threads as thread
		set starred = case p_action when 'star' then true when 'unstar' then false else thread.starred end,
			archived_at = case p_action
				when 'archive' then coalesce(thread.archived_at, clock_timestamp())
				when 'unarchive' then null
				when 'restore' then null
				else thread.archived_at
			end,
			trashed_at = case p_action
				when 'trash' then coalesce(thread.trashed_at, clock_timestamp())
				when 'restore' then null
				when 'unarchive' then null
				else thread.trashed_at
			end
		where thread.id = any(v_ids)
			and thread.profile_id = p_profile_id
			and thread.environment_id = p_environment_id
		returning thread.id
	loop
		v_updated := array_append(v_updated, v_tid);
		perform public.qorpera_enqueue_google_mail_thread_action(v_tid, v_google_action);
	end loop;
	return jsonb_build_object(
		'action', p_action,
		'updatedCount', cardinality(v_updated),
		'threads', to_jsonb(v_updated)
	);
end
$$;
revoke all on function public.qorpera_mail_apply_thread_action(uuid, uuid, text[], text)
	from public, anon, authenticated, service_role;

create function public.qorpera_mail_apply_block_sender(
	p_profile_id uuid,
	p_environment_id uuid,
	p_sender text,
	p_trash_existing boolean,
	p_user_id uuid,
	p_staff_agent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_norm record;
	v_row public.qorpera_mail_blocked_senders%rowtype;
	v_trashed_row record;
	v_trashed integer := 0;
	v_trashed_ids text[] := '{}';
	v_trashed_archived_ids text[] := '{}';
begin
	select * into strict v_norm from public.qorpera_normalize_mail_block_sender(p_sender);
	insert into public.qorpera_mail_blocked_senders (
		profile_id, environment_id, sender, match_kind, created_by_user_id, created_by_staff_agent_id
	) values (
		p_profile_id, p_environment_id, v_norm.sender, v_norm.match_kind, p_user_id, p_staff_agent_id
	)
	on conflict (profile_id, environment_id, sender) do update set sender = excluded.sender
	returning * into v_row;
	perform public.qorpera_enqueue_google_mail_sender_action(p_profile_id, p_environment_id, v_row.sender, 'block_sender');
	if coalesce(p_trash_existing, true) then
		for v_trashed_row in
			update public.qorpera_mail_threads as thread
			set trashed_at = clock_timestamp()
			where thread.profile_id = p_profile_id
				and thread.environment_id = p_environment_id
				and thread.trashed_at is null
				and thread.outside_address is not null
				and (
					(v_row.match_kind = 'address' and lower(btrim(thread.outside_address)) = v_row.sender)
					or (v_row.match_kind = 'domain'
						and position('@' in thread.outside_address) > 0
						and '@' || split_part(lower(btrim(thread.outside_address)), '@', 2) = v_row.sender)
				)
			returning thread.id, (thread.archived_at is not null) as was_archived
		loop
			v_trashed := v_trashed + 1;
			if cardinality(v_trashed_ids) < 200 then
				v_trashed_ids := array_append(v_trashed_ids, v_trashed_row.id);
				if v_trashed_row.was_archived then
					v_trashed_archived_ids := array_append(v_trashed_archived_ids, v_trashed_row.id);
				end if;
			end if;
			perform public.qorpera_enqueue_google_mail_thread_action(v_trashed_row.id, 'trash');
		end loop;
	end if;
	return jsonb_build_object(
		'id', v_row.id,
		'sender', v_row.sender,
		'matchKind', v_row.match_kind,
		'blocked', true,
		'trashedCount', v_trashed,
		'trashedThreads', to_jsonb(v_trashed_ids),
		'trashedArchivedThreads', to_jsonb(v_trashed_archived_ids),
		'createdAt', v_row.created_at
	);
end
$$;
revoke all on function public.qorpera_mail_apply_block_sender(uuid, uuid, text, boolean, uuid, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_mail_apply_unblock_sender(
	p_profile_id uuid,
	p_environment_id uuid,
	p_sender text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_norm record;
	v_removed boolean;
begin
	select * into strict v_norm from public.qorpera_normalize_mail_block_sender(p_sender);
	delete from public.qorpera_mail_blocked_senders
	where profile_id = p_profile_id and environment_id = p_environment_id and sender = v_norm.sender;
	v_removed := found;
	perform public.qorpera_enqueue_google_mail_sender_action(p_profile_id, p_environment_id, v_norm.sender, 'unblock_sender');
	return jsonb_build_object(
		'sender', v_norm.sender,
		'matchKind', v_norm.match_kind,
		'blocked', false,
		'removed', v_removed
	);
end
$$;
revoke all on function public.qorpera_mail_apply_unblock_sender(uuid, uuid, text)
	from public, anon, authenticated, service_role;

create function public.qorpera_preview_mail_unsubscribe(
	p_profile_id uuid,
	p_environment_id uuid,
	p_thread_id text,
	p_delivery_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_thread public.qorpera_mail_threads%rowtype;
	v_rec public.qorpera_mail_received%rowtype;
	v_one_click text;
	v_mailto jsonb;
	v_mailto_to text;
	v_web_urls jsonb;
begin
	if p_thread_id is null or p_thread_id !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'Mail thread id is invalid' using errcode = '22023';
	end if;
	select * into v_thread from public.qorpera_mail_threads
	where id = p_thread_id and profile_id = p_profile_id and environment_id = p_environment_id;
	if not found then
		raise exception 'No mail thread of this company has that id' using errcode = '22023';
	end if;
	if public.qorpera_mail_thread_account(v_thread) is not null then
		raise exception 'Account verification mail cannot be unsubscribed' using errcode = '42501';
	end if;
	if p_delivery_id is not null then
		select * into v_rec from public.qorpera_mail_received
		where delivery_id = p_delivery_id and thread_id = v_thread.id and profile_id = p_profile_id;
		if not found or v_rec.unsubscribe is null then
			raise exception 'This message has no unsubscribe information' using errcode = '22023';
		end if;
	else
		select * into v_rec from public.qorpera_mail_received
		where thread_id = v_thread.id and profile_id = p_profile_id and unsubscribe is not null
		order by received_at desc, delivery_id desc
		limit 1;
		if not found then
			raise exception 'This conversation has no unsubscribe information' using errcode = '22023';
		end if;
	end if;

	v_one_click := v_rec.unsubscribe ->> 'oneClickUrl';
	v_mailto := v_rec.unsubscribe -> 'mailto';
	v_web_urls := v_rec.unsubscribe -> 'webUrls';

	if v_one_click is not null then
		return jsonb_strip_nulls(jsonb_build_object(
			'thread', v_thread.id,
			'deliveryId', v_rec.delivery_id,
			'fromAddress', v_rec.from_address,
			'method', 'one_click',
			'url', v_one_click
		));
	end if;

	if v_mailto is not null and jsonb_typeof(v_mailto) = 'object' and v_mailto ->> 'to' is not null then
		v_mailto_to := lower(btrim(v_mailto ->> 'to'));
		if public.qorpera_mail_domains_match(v_rec.from_address, v_mailto_to) then
			return jsonb_strip_nulls(jsonb_build_object(
				'thread', v_thread.id,
				'deliveryId', v_rec.delivery_id,
				'fromAddress', v_rec.from_address,
				'method', 'mailto',
				'to', v_mailto_to,
				'subject', public.qorpera_mail_unsubscribe_subject(v_mailto ->> 'subject'),
				'body', 'Unsubscribe'
			));
		end if;
	end if;

	if v_web_urls is not null and jsonb_typeof(v_web_urls) = 'array' and jsonb_array_length(v_web_urls) > 0 then
		return jsonb_strip_nulls(jsonb_build_object(
			'thread', v_thread.id,
			'deliveryId', v_rec.delivery_id,
			'fromAddress', v_rec.from_address,
			'method', 'browser',
			'url', v_web_urls ->> 0,
			'urls', v_web_urls
		));
	end if;

	if v_mailto is not null and jsonb_typeof(v_mailto) = 'object' and v_mailto ->> 'to' is not null then
		raise exception 'Mailto unsubscribe target does not match the sender domain' using errcode = '42501';
	end if;
	raise exception 'This conversation has no unsubscribe information' using errcode = '22023';
end
$$;
revoke all on function public.qorpera_preview_mail_unsubscribe(uuid, uuid, text, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_execute_mail_unsubscribe(
	p_profile_id uuid,
	p_environment_id uuid,
	p_thread_id text,
	p_delivery_id uuid,
	p_user_id uuid,
	p_run_id uuid,
	p_call_id text,
	p_staff_agent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_thread public.qorpera_mail_threads%rowtype;
	v_rec public.qorpera_mail_received%rowtype;
	v_existing record;
	v_mailbox public.qorpera_company_mailboxes%rowtype;
	v_hook public.qorpera_event_hooks%rowtype;
	v_settings public.qorpera_mail_settings%rowtype;
	v_now timestamptz := clock_timestamp();
	v_unsub_id uuid := extensions.gen_random_uuid();
	v_one_click text;
	v_mailto jsonb;
	v_mailto_to text;
	v_mailto_allowed boolean := false;
	v_web_urls jsonb;
	v_mail_id uuid;
	v_outbox_thread text;
	v_from_name text;
	v_company text;
	v_actor text;
	v_hour bigint;
	v_day bigint;
	v_subject text;
	v_body text;
begin
	if p_thread_id is null or p_thread_id !~ '^[A-Za-z0-9_-]{43}$' then
		raise exception 'Mail thread id is invalid' using errcode = '22023';
	end if;
	select * into v_thread from public.qorpera_mail_threads
	where id = p_thread_id and profile_id = p_profile_id and environment_id = p_environment_id;
	if not found then
		raise exception 'No mail thread of this company has that id' using errcode = '22023';
	end if;
	if public.qorpera_mail_thread_account(v_thread) is not null then
		raise exception 'Account verification mail cannot be unsubscribed' using errcode = '42501';
	end if;
	if p_delivery_id is not null then
		select * into v_rec from public.qorpera_mail_received
		where delivery_id = p_delivery_id and thread_id = v_thread.id and profile_id = p_profile_id;
		if not found or v_rec.unsubscribe is null then
			raise exception 'This message has no unsubscribe information' using errcode = '22023';
		end if;
	else
		select * into v_rec from public.qorpera_mail_received
		where thread_id = v_thread.id and profile_id = p_profile_id and unsubscribe is not null
		order by received_at desc, delivery_id desc
		limit 1;
		if not found then
			raise exception 'This conversation has no unsubscribe information' using errcode = '22023';
		end if;
	end if;

	update public.qorpera_mail_unsubscribes
	set status = 'failed',
		settled_at = v_now,
		lease_id = null,
		lease_expires_at = null,
		last_error = coalesce(last_error, case
			when created_at <= v_now - interval '1 day' then 'Unsubscribe request expired'
			else 'Unsubscribe request exceeded retry limit'
		end)
	where profile_id = p_profile_id
		and thread_id = v_thread.id
		and method = 'one_click'
		and status in ('pending', 'retrying', 'delivering')
		and (lease_expires_at is null or lease_expires_at <= v_now)
		and (attempt_count >= 5 or created_at <= v_now - interval '1 day');

	select u.*, mail.status as mail_status
	into v_existing
	from public.qorpera_mail_unsubscribes as u
	left join public.qorpera_company_mail_outbox as mail on mail.id = u.outbox_mail_id
	where u.profile_id = p_profile_id and u.thread_id = v_thread.id
		and u.status in ('pending', 'retrying', 'delivering', 'succeeded')
		and not (u.method = 'mailto' and mail.status in ('failed', 'cancelled'))
	order by u.created_at desc, u.id desc
	limit 1;
	if found then
		return jsonb_strip_nulls(jsonb_build_object(
			'unsubscribeId', v_existing.id,
			'thread', v_thread.id,
			'method', v_existing.method,
			'status', case
				when v_existing.method = 'mailto' and v_existing.mail_status = 'sent' then 'succeeded'
				when v_existing.status = 'succeeded' then 'succeeded'
				else 'queued'
			end,
			'alreadyRequested', true,
			'url', v_existing.target_url,
			'to', v_existing.mailto_address,
			'mailId', v_existing.outbox_mail_id
		));
	end if;

	v_one_click := v_rec.unsubscribe ->> 'oneClickUrl';
	v_mailto := v_rec.unsubscribe -> 'mailto';
	v_web_urls := v_rec.unsubscribe -> 'webUrls';

	if v_one_click is not null then
		insert into public.qorpera_mail_unsubscribes (
			id, profile_id, environment_id, mailbox_id, thread_id, delivery_id, sender_address,
			method, target_url, status, requested_by_user_id, requested_by_staff_agent_id
		) values (
			v_unsub_id, p_profile_id, p_environment_id, v_thread.mailbox_id, v_thread.id, v_rec.delivery_id,
			v_rec.from_address, 'one_click', v_one_click, 'pending', p_user_id, p_staff_agent_id
		);
		return jsonb_build_object(
			'unsubscribeId', v_unsub_id,
			'thread', v_thread.id,
			'method', 'one_click',
			'status', 'queued',
			'url', v_one_click
		);
	end if;

	if v_mailto is not null and jsonb_typeof(v_mailto) = 'object' and v_mailto ->> 'to' is not null then
		v_mailto_to := lower(btrim(v_mailto ->> 'to'));
		v_mailto_allowed := public.qorpera_mail_domains_match(v_rec.from_address, v_mailto_to);
	end if;

	if v_mailto_allowed then
		perform pg_advisory_xact_lock(hashtextextended('qorpera-company-mail:' || p_profile_id::text, 0));
		select * into v_settings from public.qorpera_mail_settings;
		if not coalesce(v_settings.enabled and v_settings.sending, false) or v_settings.domain is null then
			raise exception 'Sending company mail is switched off' using errcode = '0A000';
		end if;
		select * into v_mailbox from public.qorpera_company_mailboxes
		where id = v_thread.mailbox_id and profile_id = p_profile_id and removed_at is null;
		if not found then
			raise exception 'The mailbox is no longer active' using errcode = '42501';
		end if;
		select * into strict v_hook from public.qorpera_event_hooks where id = v_mailbox.hook_id;
		if v_hook.status <> 'active' then
			raise exception 'The mailbox is paused; resume it to unsubscribe by email' using errcode = '0A000';
		end if;
		if exists (
			select 1 from public.qorpera_company_mailboxes as box
			where box.profile_id = p_profile_id and box.removed_at is null
				and (
					(v_mailto_to = substring(v_mailto_to from '^[^@]+') || '@' || v_settings.domain
						and public.qorpera_mail_box_part(v_mailto_to) = box.local_part)
					or exists (
						select 1 from public.qorpera_google_mailboxes as google
						where google.mailbox_id = box.id and google.removed_at is null
							and public.qorpera_google_address_key(v_mailto_to) = public.qorpera_google_address_key(google.address)
					)
				)
		) then
			raise exception 'Unsubscribe target cannot be a company mailbox' using errcode = '42501';
		end if;
		select coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc))
				filter (where created_at > v_now - interval '1 hour'), 0),
			coalesce(sum(cardinality(recipients_to) + cardinality(recipients_cc)), 0)
		into v_hour, v_day
		from public.qorpera_company_mail_outbox
		where profile_id = p_profile_id and created_at > v_now - interval '1 day'
			and (status <> 'cancelled' or attempt_count > 0);
		if v_hour + 1 > v_settings.company_hourly_recipients or v_day + 1 > v_settings.company_daily_recipients then
			if p_user_id is not null then
				raise exception 'The company has reached its email sending limit' using errcode = '54000';
			end if;
			raise exception 'The company has reached its email sending limit' using errcode = 'P0001';
		end if;
		v_company := public.qorpera_mail_display_name(
			(select profile.name from public.qorpera_profiles as profile where profile.id = p_profile_id),
			'the company'
		);
		if p_user_id is not null then
			v_actor := public.qorpera_mail_display_name(
				(select member.display_name from public.qorpera_profile_members as member
					where member.profile_id = p_profile_id and member.user_id = p_user_id),
				'A member'
			);
			if v_actor like '%@%' then v_actor := 'A member'; end if;
		else
			v_actor := public.qorpera_mail_display_name(
				(select staff.display_name from public.qorpera_profile_staff as staff
					where staff.profile_id = p_profile_id and staff.staff_agent_id = p_staff_agent_id),
				'An assistant'
			);
		end if;
		v_from_name := left(v_actor || ' at ' || v_company, 160);
		if public.qorpera_mail_name_reads_as_qorpera(v_actor)
			or public.qorpera_mail_name_reads_as_qorpera(v_company) then
			v_from_name := 'Mailbox';
		end if;
		v_subject := public.qorpera_mail_unsubscribe_subject(v_mailto ->> 'subject');
		v_body := 'Unsubscribe';
		v_mail_id := extensions.gen_random_uuid();
		v_outbox_thread := public.qorpera_mail_thread_id(v_mailbox.id, 'mail:' || v_mail_id);
		if p_user_id is not null then
			insert into public.qorpera_company_mail_outbox (
				id, thread, profile_id, environment_id, mailbox_id,
				member_user_id, member_send_id, from_name, recipients_to, recipients_cc, subject, body
			) values (
				v_mail_id, v_outbox_thread, p_profile_id, p_environment_id, v_mailbox.id,
				p_user_id, v_unsub_id, v_from_name, array[v_mailto_to], '{}', v_subject, v_body
			);
		else
			insert into public.qorpera_company_mail_outbox (
				id, thread, profile_id, environment_id, mailbox_id,
				run_id, call_id, staff_agent_id, from_name, recipients_to, recipients_cc, subject, body
			) values (
				v_mail_id, v_outbox_thread, p_profile_id, p_environment_id, v_mailbox.id,
				p_run_id, p_call_id, p_staff_agent_id, v_from_name, array[v_mailto_to], '{}', v_subject, v_body
			)
			on conflict (run_id, call_id) do update set id = public.qorpera_company_mail_outbox.id
			returning id into v_mail_id;
		end if;
		insert into public.qorpera_mail_unsubscribes (
			id, profile_id, environment_id, mailbox_id, thread_id, delivery_id, sender_address,
			method, mailto_address, outbox_mail_id, status, requested_by_user_id, requested_by_staff_agent_id
		) values (
			v_unsub_id, p_profile_id, p_environment_id, v_thread.mailbox_id, v_thread.id, v_rec.delivery_id,
			v_rec.from_address, 'mailto', v_mailto_to, v_mail_id, 'pending', p_user_id, p_staff_agent_id
		);
		return jsonb_build_object(
			'unsubscribeId', v_unsub_id,
			'thread', v_thread.id,
			'method', 'mailto',
			'status', 'queued',
			'to', v_mailto_to,
			'mailId', v_mail_id
		);
	end if;

	if v_web_urls is not null and jsonb_typeof(v_web_urls) = 'array' and jsonb_array_length(v_web_urls) > 0 then
		insert into public.qorpera_mail_unsubscribes (
			id, profile_id, environment_id, mailbox_id, thread_id, delivery_id, sender_address,
			method, target_url, status, requested_by_user_id, requested_by_staff_agent_id, settled_at
		) values (
			v_unsub_id, p_profile_id, p_environment_id, v_thread.mailbox_id, v_thread.id, v_rec.delivery_id,
			v_rec.from_address, 'browser', v_web_urls ->> 0, 'browser_required', p_user_id, p_staff_agent_id, v_now
		);
		return jsonb_build_object(
			'unsubscribeId', v_unsub_id,
			'thread', v_thread.id,
			'method', 'browser',
			'status', 'browser_required',
			'urls', v_web_urls
		);
	end if;

	if v_mailto_to is not null then
		raise exception 'Mailto unsubscribe target does not match the sender domain' using errcode = '42501';
	end if;
	raise exception 'This conversation has no unsubscribe information' using errcode = '22023';
end
$$;
revoke all on function public.qorpera_execute_mail_unsubscribe(uuid, uuid, text, uuid, uuid, uuid, text, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_member_mail_update_threads(
	p_environment_id uuid,
	p_threads text[],
	p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
begin
	if not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'Only a member who can write in the company can update mail' using errcode = '42501';
	end if;
	return public.qorpera_mail_apply_thread_action(v_profile_id, p_environment_id, p_threads, p_action);
end
$$;
revoke all on function public.qorpera_member_mail_update_threads(uuid, text[], text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_update_threads(uuid, text[], text) to authenticated;

create function public.qorpera_member_mail_unsubscribe(
	p_environment_id uuid,
	p_thread text,
	p_delivery_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
begin
	if not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'Only a member who can write in the company can unsubscribe mail' using errcode = '42501';
	end if;
	return public.qorpera_execute_mail_unsubscribe(
		v_profile_id, p_environment_id, p_thread, p_delivery_id, auth.uid(), null, null, null
	);
end
$$;
revoke all on function public.qorpera_member_mail_unsubscribe(uuid, text, uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_unsubscribe(uuid, text, uuid) to authenticated;

create function public.qorpera_member_mail_blocked_senders(p_environment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
	v_senders jsonb;
begin
	select coalesce(jsonb_agg(jsonb_build_object(
		'id', blocked.id,
		'sender', blocked.sender,
		'matchKind', blocked.match_kind,
		'createdAt', blocked.created_at
	) order by blocked.created_at desc, blocked.id desc), '[]'::jsonb)
	into v_senders
	from public.qorpera_mail_blocked_senders as blocked
	where blocked.profile_id = v_profile_id and blocked.environment_id = p_environment_id;
	return jsonb_build_object('senders', v_senders);
end
$$;
revoke all on function public.qorpera_member_mail_blocked_senders(uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_blocked_senders(uuid) to authenticated;

create function public.qorpera_member_mail_block_sender(
	p_environment_id uuid,
	p_sender text,
	p_trash_existing boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
begin
	if not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'Only a member who can write in the company can block senders' using errcode = '42501';
	end if;
	return public.qorpera_mail_apply_block_sender(
		v_profile_id, p_environment_id, p_sender, coalesce(p_trash_existing, true), auth.uid(), null
	);
end
$$;
revoke all on function public.qorpera_member_mail_block_sender(uuid, text, boolean)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_block_sender(uuid, text, boolean) to authenticated;

create function public.qorpera_member_mail_unblock_sender(p_environment_id uuid, p_sender text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_profile_id uuid := public.qorpera_member_mail_company(p_environment_id);
begin
	if not public.qorpera_can_write_profile(v_profile_id) then
		raise exception 'Only a member who can write in the company can unblock senders' using errcode = '42501';
	end if;
	return public.qorpera_mail_apply_unblock_sender(v_profile_id, p_environment_id, p_sender);
end
$$;
revoke all on function public.qorpera_member_mail_unblock_sender(uuid, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_member_mail_unblock_sender(uuid, text) to authenticated;

create or replace function public.qorpera_find_agent_mail(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_settings public.qorpera_mail_settings%rowtype;
	v_now timestamptz := clock_timestamp();
	v_since timestamptz;
	v_before timestamptz;
	v_mailbox text;
	v_to text;
	v_from text;
	v_subject text;
	v_view text;
	v_limit integer;
	v_hooks uuid[];
	v_hook uuid;
	v_ids uuid[] := '{}';
	v_times timestamptz[] := '{}';
	v_box_ids uuid[];
	v_box_times timestamptz[];
	v_found jsonb;
	v_more boolean;
	v_next_before timestamptz;
	v_searched bigint;
	v_oldest_searched timestamptz;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object'
		or p_request - array['mailbox', 'to', 'from', 'subject', 'since', 'before', 'view', 'limit'] <> '{}'::jsonb
		or exists (select 1 from jsonb_each(p_request) as field
			where field.key <> 'limit' and jsonb_typeof(field.value) <> 'string')
		or (p_request ? 'limit' and (jsonb_typeof(p_request -> 'limit') <> 'number'
			or p_request ->> 'limit' !~ '^[1-9][0-9]?$'
			or (p_request ->> 'limit')::integer > 50))
		or coalesce(p_request ->> 'view', 'inbox') not in ('inbox', 'starred', 'trash', 'archived', 'all')
		or char_length(p_request ->> 'mailbox') not between 3 and 320
		or char_length(p_request ->> 'to') not between 3 and 320
		or char_length(p_request ->> 'from') not between 1 and 320
		or char_length(p_request ->> 'subject') not between 1 and 200
		or exists (select 1 from jsonb_each_text(p_request) as field where field.key in ('since', 'before')
			and field.value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$')
		or exists (select 1 from jsonb_each_text(p_request) as field where field.key <> 'limit' and field.value ~ '[[:cntrl:]]') then
		raise exception 'Mail search is invalid' using errcode = '22023';
	end if;
	begin
		v_since := (p_request ->> 'since')::timestamptz;
		v_before := (p_request ->> 'before')::timestamptz;
	exception when others then
		raise exception 'Mail search is invalid: since and before are instants with their offsets' using errcode = '22023';
	end;
	v_view := p_request ->> 'view';
	v_limit := coalesce((p_request ->> 'limit')::integer, case when v_view is not null then 25 else 10 end);
	v_since := greatest(
		coalesce(v_since, case when v_view is not null then v_now - interval '365 days' else v_now - interval '24 hours' end),
		v_now - interval '10 years'
	);
	v_mailbox := lower(btrim(p_request ->> 'mailbox'));
	v_to := lower(btrim(p_request ->> 'to'));
	v_from := lower(p_request ->> 'from');
	v_subject := lower(p_request ->> 'subject');
	select settings.* into v_settings from public.qorpera_mail_settings as settings;
	select coalesce(array_agg(mailbox.hook_id), '{}') into v_hooks
	from public.qorpera_company_mailboxes as mailbox
	where mailbox.profile_id = v_run.profile_id and mailbox.environment_id = v_run.environment_id
		and mailbox.removed_at is null
		and (v_mailbox is null
			or public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_settings.domain) = v_mailbox);
	if v_mailbox is not null and cardinality(v_hooks) = 0 then
		raise exception 'No mailbox of this company has that address; list_hooks shows them' using errcode = '22023';
	end if;
	foreach v_hook in array v_hooks loop
		execute 'select coalesce(array_agg(picked.id), ''{}''), coalesce(array_agg(picked.received_at), ''{}'')
			from (select delivery.id, delivery.received_at from public.qorpera_event_deliveries as delivery
				where delivery.hook_id = $1 and delivery.status = ''verified''
					and delivery.event_type = ''mail.received'' and delivery.received_at >= $2
					and delivery.received_at < $3
				order by delivery.received_at desc, delivery.id desc
				limit 2000) as picked'
		into v_box_ids, v_box_times using v_hook, v_since, coalesce(v_before, 'infinity'::timestamptz);
		v_ids := v_ids || v_box_ids;
		v_times := v_times || v_box_times;
	end loop;
	with picked as (
		select picked.id, picked.received_at from unnest(v_ids, v_times) as picked(id, received_at)
		order by picked.received_at desc, picked.id desc
		limit 2000
	), candidate as (
		select delivery.* from picked
		cross join lateral (
			select one.id, one.hook_id, one.received_at, one.headers
			from public.qorpera_event_deliveries as one
			where one.id = picked.id
			limit 1
		) as delivery
	), matched as (
		select candidate.id, candidate.received_at, jsonb_strip_nulls(jsonb_build_object(
			'deliveryId', candidate.id,
			'threadId', rec.thread_id,
			'mailbox', public.qorpera_mailbox_address(mailbox.id, mailbox.local_part, v_settings.domain),
			'deliveredTo', coalesce(to_jsonb((string_to_array(candidate.headers ->> 'delivered-to', ', '))[1:5]), '[]'::jsonb),
			'from', left(candidate.headers ->> 'from', 200),
			'subject', left(candidate.headers ->> 'subject', 200),
			'authentication', candidate.headers ->> 'authentication-results',
			'receivedAt', candidate.received_at,
			'starred', case when thread.starred then true end,
			'archived', case when thread.archived_at is not null then true end,
			'trashed', case when thread.trashed_at is not null then true end,
			'unsubscribe', case when rec.account is null then rec.unsubscribe end)) as item
		from candidate
		join public.qorpera_company_mailboxes as mailbox on mailbox.hook_id = candidate.hook_id
		left join public.qorpera_mail_received as rec on rec.delivery_id = candidate.id
		left join public.qorpera_mail_threads as thread on thread.id = rec.thread_id
		where (v_to is null or v_to = any (string_to_array(candidate.headers ->> 'delivered-to', ', ')))
			and (v_from is null or strpos(lower(candidate.headers ->> 'from'), v_from) > 0)
			and (v_subject is null or strpos(lower(candidate.headers ->> 'subject'), v_subject) > 0)
			and (case coalesce(v_view, 'default')
				when 'trash' then thread.trashed_at is not null
				when 'starred' then coalesce(thread.starred, false) and thread.trashed_at is null
				when 'archived' then thread.archived_at is not null and thread.trashed_at is null
				when 'inbox' then thread.trashed_at is null and thread.archived_at is null
				when 'all' then true
				else thread.trashed_at is null
			end)
		order by candidate.received_at desc, candidate.id desc
		limit v_limit + 1
	), sized as (
		select matched.item, matched.received_at,
			row_number() over (order by matched.received_at desc, matched.id desc) as place,
			sum(octet_length(matched.item::text) + 1
				+ (length(matched.item::text) - length(translate(matched.item::text, '"\', '')))
				+ 5 * (length(matched.item::text) - length(translate(matched.item::text, '<>&', '')))
				+ 3 * (length(matched.item::text) - length(translate(matched.item::text, E'\u2028\u2029', ''))))
				over (order by matched.received_at desc, matched.id desc) as running
		from matched
	), kept as (
		select sized.*, sized.place <= v_limit and (sized.place = 1 or sized.running <= 24000) as shown from sized
	)
	select coalesce(jsonb_agg(kept.item order by kept.place) filter (where kept.shown), '[]'::jsonb),
		coalesce(bool_or(not kept.shown), false),
		min(kept.received_at) filter (where kept.shown),
		(select count(*) from candidate), (select min(candidate.received_at) from candidate)
	into v_found, v_more, v_next_before, v_searched, v_oldest_searched
	from kept;
	if not v_more then
		v_next_before := null;
	end if;
	if v_searched = 2000 then
		v_more := true;
		v_next_before := coalesce(v_next_before, v_oldest_searched);
	end if;
	return jsonb_strip_nulls(jsonb_build_object('schema', 'qorpera.agent-mail-search/v1', 'runId', v_run.id,
		'since', v_since, 'mails', v_found, 'more', v_more, 'nextBefore', v_next_before));
end
$$;

create function public.qorpera_manage_agent_mail(p_binding jsonb, p_call_id text, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_action text;
	v_threads text[] := '{}';
	v_delivery_ids uuid[] := '{}';
	v_resolved text[];
	v_thread text;
	v_delivery uuid;
	v_senders jsonb;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	if p_call_id is null or char_length(p_call_id) not between 1 and 200 then
		raise exception 'Mail action call id is invalid' using errcode = '22023';
	end if;
	if jsonb_typeof(p_request) is distinct from 'object'
		or jsonb_typeof(p_request -> 'action') <> 'string' then
		raise exception 'Mail action request is invalid' using errcode = '22023';
	end if;
	v_action := p_request ->> 'action';

	if v_action in ('trash', 'restore', 'archive', 'unarchive', 'star', 'unstar') then
		if p_request - array['action', 'threadIds', 'deliveryIds'] <> '{}'::jsonb then
			raise exception 'Mail action request is invalid' using errcode = '22023';
		end if;
		if p_request ? 'threadIds' then
			if jsonb_typeof(p_request -> 'threadIds') <> 'array'
				or jsonb_array_length(p_request -> 'threadIds') > 50
				or exists (select 1 from jsonb_array_elements(p_request -> 'threadIds') as item(value)
					where jsonb_typeof(item.value) <> 'string' or item.value #>> '{}' !~ '^[A-Za-z0-9_-]{43}$') then
				raise exception 'Mail thread ids are invalid' using errcode = '22023';
			end if;
			select coalesce(array_agg(item.value #>> '{}'), '{}') into v_threads
			from jsonb_array_elements(p_request -> 'threadIds') as item(value);
		end if;
		if p_request ? 'deliveryIds' then
			if jsonb_typeof(p_request -> 'deliveryIds') <> 'array'
				or jsonb_array_length(p_request -> 'deliveryIds') > 50
				or exists (select 1 from jsonb_array_elements(p_request -> 'deliveryIds') as item(value)
					where jsonb_typeof(item.value) <> 'string'
						or item.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
				raise exception 'Mail delivery ids are invalid' using errcode = '22023';
			end if;
			select coalesce(array_agg((item.value #>> '{}')::uuid), '{}') into v_delivery_ids
			from jsonb_array_elements(p_request -> 'deliveryIds') as item(value);
			select coalesce(array_agg(distinct rec.thread_id), '{}') into v_resolved
			from public.qorpera_mail_received as rec
			where rec.delivery_id = any(v_delivery_ids)
				and rec.profile_id = v_run.profile_id and rec.environment_id = v_run.environment_id;
			v_threads := v_threads || v_resolved;
		end if;
		select coalesce(array_agg(distinct item order by item), '{}') into v_threads from unnest(v_threads) as item;
		if cardinality(v_threads) not between 1 and 50 then
			raise exception 'Provide between 1 and 50 mail threads or deliveries' using errcode = '22023';
		end if;
		return jsonb_build_object('schema', 'qorpera.agent-mail-action/v1', 'runId', v_run.id)
			|| public.qorpera_mail_apply_thread_action(v_run.profile_id, v_run.environment_id, v_threads, v_action);
	end if;

	if v_action = 'unsubscribe' then
		if p_request - array['action', 'threadId', 'deliveryId', 'preview'] <> '{}'::jsonb
			or (p_request ? 'preview' and jsonb_typeof(p_request -> 'preview') <> 'boolean') then
			raise exception 'Unsubscribe request is invalid' using errcode = '22023';
		end if;
		if p_request ? 'deliveryId' then
			if jsonb_typeof(p_request -> 'deliveryId') <> 'string'
				or p_request ->> 'deliveryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
				raise exception 'Delivery id is invalid' using errcode = '22023';
			end if;
			v_delivery := (p_request ->> 'deliveryId')::uuid;
			select rec.thread_id into v_thread from public.qorpera_mail_received as rec
			where rec.delivery_id = v_delivery and rec.profile_id = v_run.profile_id
				and rec.environment_id = v_run.environment_id;
			if not found then
				raise exception 'No received email of this company has that delivery id' using errcode = '22023';
			end if;
		end if;
		if p_request ? 'threadId' then
			if jsonb_typeof(p_request -> 'threadId') <> 'string'
				or p_request ->> 'threadId' !~ '^[A-Za-z0-9_-]{43}$' then
				raise exception 'Thread id is invalid' using errcode = '22023';
			end if;
			v_thread := coalesce(v_thread, p_request ->> 'threadId');
		end if;
		if v_thread is null then
			raise exception 'Provide threadId or deliveryId to unsubscribe' using errcode = '22023';
		end if;
		if coalesce((p_request ->> 'preview')::boolean, false) then
			return jsonb_build_object(
				'schema', 'qorpera.agent-mail-action/v1',
				'runId', v_run.id,
				'action', 'unsubscribe',
				'preview', true
			) || public.qorpera_preview_mail_unsubscribe(
				v_run.profile_id, v_run.environment_id, v_thread, v_delivery
			);
		end if;
		return jsonb_build_object('schema', 'qorpera.agent-mail-action/v1', 'runId', v_run.id, 'action', 'unsubscribe')
			|| public.qorpera_execute_mail_unsubscribe(
				v_run.profile_id, v_run.environment_id, v_thread, v_delivery,
				null, v_run.id, p_call_id, v_run.staff_agent_id
			);
	end if;

	if v_action = 'block_sender' then
		if p_request - array['action', 'sender', 'trashExisting'] <> '{}'::jsonb
			or jsonb_typeof(p_request -> 'sender') <> 'string'
			or (p_request ? 'trashExisting' and jsonb_typeof(p_request -> 'trashExisting') <> 'boolean') then
			raise exception 'Block sender request is invalid' using errcode = '22023';
		end if;
		return jsonb_build_object('schema', 'qorpera.agent-mail-action/v1', 'runId', v_run.id, 'action', 'block_sender')
			|| public.qorpera_mail_apply_block_sender(
				v_run.profile_id, v_run.environment_id, p_request ->> 'sender',
				coalesce((p_request ->> 'trashExisting')::boolean, true), null, v_run.staff_agent_id
			);
	end if;

	if v_action = 'unblock_sender' then
		if p_request - array['action', 'sender'] <> '{}'::jsonb
			or jsonb_typeof(p_request -> 'sender') <> 'string' then
			raise exception 'Unblock sender request is invalid' using errcode = '22023';
		end if;
		return jsonb_build_object('schema', 'qorpera.agent-mail-action/v1', 'runId', v_run.id, 'action', 'unblock_sender')
			|| public.qorpera_mail_apply_unblock_sender(v_run.profile_id, v_run.environment_id, p_request ->> 'sender');
	end if;

	if v_action = 'list_blocked' then
		if p_request - array['action'] <> '{}'::jsonb then
			raise exception 'List blocked request is invalid' using errcode = '22023';
		end if;
		select coalesce(jsonb_agg(jsonb_build_object(
			'id', blocked.id,
			'sender', blocked.sender,
			'matchKind', blocked.match_kind,
			'createdAt', blocked.created_at
		) order by blocked.created_at desc, blocked.id desc), '[]'::jsonb)
		into v_senders
		from public.qorpera_mail_blocked_senders as blocked
		where blocked.profile_id = v_run.profile_id and blocked.environment_id = v_run.environment_id;
		return jsonb_build_object(
			'schema', 'qorpera.agent-mail-action/v1',
			'runId', v_run.id,
			'action', 'list_blocked',
			'senders', v_senders
		);
	end if;

	raise exception 'Mail action is invalid' using errcode = '22023';
end
$$;
revoke all on function public.qorpera_manage_agent_mail(jsonb, text, jsonb)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_manage_agent_mail(jsonb, text, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_manage_agent_mail', 'binding')
on conflict (name) do nothing;

select pg_temp.mail_actions_patch(
	'public.qorpera_mail_thread_note(text,uuid,uuid,uuid,text,timestamptz,text,text,text,uuid,uuid,jsonb)'::regprocedure,
	$old$		message_count = thread.message_count + 1,
		account = coalesce(excluded.account, thread.account)$old$,
	$new$		message_count = thread.message_count + 1,
		account = coalesce(excluded.account, thread.account),
		archived_at = case when excluded.last_at >= thread.last_at then null else thread.archived_at end,
		trashed_at = case
			when excluded.last_direction = 'received' and excluded.last_at >= thread.last_at then null
			else thread.trashed_at
		end$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_mail_received_note(uuid,public.qorpera_company_mailboxes,timestamptz,jsonb,text,text,text)'::regprocedure,
	$old$		automated, attachments, account)$old$,
	$new$		automated, attachments, account, unsubscribe)$new$,
	$old$		v_account)
	on conflict (delivery_id) do nothing;$old$,
	$new$		v_account,
		case when v_account is null then public.qorpera_parse_mail_unsubscribe(
			p_message ->> 'listUnsubscribe', p_message ->> 'listUnsubscribePost') end)
	on conflict (delivery_id) do nothing;$new$,
	$old$	perform public.qorpera_mail_thread_note(v_thread, p_mailbox.profile_id, p_mailbox.environment_id, p_mailbox.id,
		'received', p_received_at, case when v_account is null then p_subject end, v_party.name, v_party.address,
		p_delivery_id, null, v_account);$old$,
	$new$	perform public.qorpera_mail_thread_note(v_thread, p_mailbox.profile_id, p_mailbox.environment_id, p_mailbox.id,
		'received', p_received_at, case when v_account is null then p_subject end, v_party.name, v_party.address,
		p_delivery_id, null, v_account);
	if v_party.address is not null and public.qorpera_mail_sender_is_blocked(
		p_mailbox.profile_id, p_mailbox.environment_id, v_party.address) then
		update public.qorpera_mail_threads
		set trashed_at = coalesce(trashed_at, clock_timestamp())
		where id = v_thread and profile_id = p_mailbox.profile_id;
	end if;$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_event_listener_waiting(public.qorpera_event_listener_cursors,jsonb,integer)'::regprocedure,
	$old$			and not exists (select 1 from public.qorpera_google_mail_messages as google
				where google.delivery_id = delivery.id and google.imported)$old$,
	$new$			and not exists (select 1 from public.qorpera_google_mail_messages as google
				where google.delivery_id = delivery.id and google.imported)
			and not exists (select 1 from public.qorpera_mail_received as received
				join public.qorpera_mail_threads as thread on thread.id = received.thread_id
				where received.delivery_id = delivery.id
					and (thread.trashed_at is not null
						or public.qorpera_mail_sender_is_blocked(
							received.profile_id, received.environment_id, received.from_address)))$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_bring_in_google_mail(uuid,text,uuid,uuid,text,text,boolean,timestamptz,text)'::regprocedure,
	$old$	insert into public.qorpera_google_mail_messages (profile_id, address, gmail_id, mailbox_id, gmail_thread_id, delivery_id,
		imported, gap)
	values (v_google.profile_id, v_google.address, p_gmail_id, v_google.mailbox_id, p_gmail_thread_id, v_delivery_id,
		p_imported, p_imported and v_google.gap and v_google.state = 'bringing_in')
	on conflict do nothing;$old$,
	$new$	insert into public.qorpera_google_mail_messages (profile_id, address, gmail_id, mailbox_id, gmail_thread_id, delivery_id,
		imported, gap)
	values (v_google.profile_id, v_google.address, p_gmail_id, v_google.mailbox_id, p_gmail_thread_id, v_delivery_id,
		p_imported, p_imported and v_google.gap and v_google.state = 'bringing_in')
	on conflict do nothing;
	if jsonb_typeof(p_message::jsonb -> 'gmailLabels') = 'array' then
		perform public.qorpera_apply_google_delivery_labels(
			v_google.profile_id, v_delivery_id, p_message::jsonb -> 'gmailLabels', p_received_at, p_imported);
	end if;$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_broker_principal_google_mailboxes_due(uuid,text)'::regprocedure,
	$old$				and (mail.lease_expires_at is null or mail.lease_expires_at <= clock_timestamp())
		) as waiting$old$,
	$new$				and (mail.lease_expires_at is null or mail.lease_expires_at <= clock_timestamp())
			union all
			select action.profile_id from public.qorpera_google_mail_actions as action
			join public.qorpera_google_mailboxes as google
				on google.mailbox_id = action.mailbox_id and google.removed_at is null
					and google.state <> 'sign_in_again'
			where action.status in ('pending', 'retrying', 'delivering')
				and action.next_attempt_at <= clock_timestamp()
				and (action.lease_until is null or action.lease_until <= clock_timestamp())
		) as waiting$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_member_mail_threads(uuid,jsonb)'::regprocedure,
	$old$array['address', 'state', 'direction', 'before', 'limit']$old$,
	$new$array['address', 'state', 'direction', 'view', 'before', 'limit']$new$,
	$old$		or coalesce(jsonb_typeof(p_request -> 'direction'), 'string') <> 'string'$old$,
	$new$		or coalesce(jsonb_typeof(p_request -> 'direction'), 'string') <> 'string'
		or coalesce(p_request ->> 'view', 'inbox') not in ('inbox', 'starred', 'trash', 'archived', 'sent', 'all')
		or coalesce(jsonb_typeof(p_request -> 'view'), 'string') <> 'string'$new$,
	$old$			and (not p_request ? 'direction' or thread.last_direction = p_request ->> 'direction')$old$,
	$new$			and (not p_request ? 'direction' or thread.last_direction = p_request ->> 'direction')
			and (case coalesce(p_request ->> 'view', case when p_request ? 'direction' then 'all' else 'inbox' end)
				when 'trash' then thread.trashed_at is not null
				when 'starred' then thread.starred and thread.trashed_at is null
				when 'archived' then thread.archived_at is not null and thread.trashed_at is null
				when 'sent' then thread.trashed_at is null and thread.last_direction = 'sent'
				when 'all' then thread.trashed_at is null
				else thread.trashed_at is null and thread.archived_at is null
			end)$new$,
	$old$			'messages', shown.message_count,$old$,
	$new$			'messages', shown.message_count,
			'starred', case when shown.starred then true end,
			'archivedAt', shown.archived_at,
			'trashedAt', shown.trashed_at,
			'canUnsubscribe', case when shown.account_mark is null and exists (
				select 1 from public.qorpera_mail_received as rec
				where rec.thread_id = shown.id and rec.profile_id = shown.profile_id and rec.unsubscribe is not null
					and (
						rec.unsubscribe ? 'oneClickUrl'
						or coalesce(jsonb_array_length(rec.unsubscribe -> 'webUrls'), 0) > 0
						or (rec.unsubscribe #>> '{mailto,to}' is not null
							and public.qorpera_mail_domains_match(rec.from_address, rec.unsubscribe #>> '{mailto,to}'))
					)
			) then true end,$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_member_mail_thread(uuid,text,jsonb)'::regprocedure,
	$old$				'automated', received.automated,$old$,
	$new$				'automated', received.automated,
				'unsubscribe', case when mark.value is null then received.unsubscribe end,$new$,
	$old$		'messages', v_messages, 'more',$old$,
	$new$		'starred', case when v_thread.starred then true end,
		'archivedAt', v_thread.archived_at,
		'trashedAt', v_thread.trashed_at,
		'senderBlocked', case when v_thread.outside_address is not null
			and public.qorpera_mail_sender_is_blocked(v_profile_id, p_environment_id, v_thread.outside_address)
			then true end,
		'unsubscribe', case when public.qorpera_mail_thread_account(v_thread) is null
			then public.qorpera_member_mail_thread_unsubscribe(v_profile_id, v_thread.id) end,
		'messages', v_messages, 'more',$new$
);

select pg_temp.mail_actions_patch(
	'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'list_hooks','read_event','send_mail','find_mail',$old$,
	$new$'list_hooks','read_event','send_mail','find_mail','manage_mail',$new$
);

commit;
