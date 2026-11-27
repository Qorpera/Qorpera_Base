begin;

set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_surface_github_webhook_receipts') is not null then
		raise exception 'GitHub track PR sync and webhooks (20260930938000) is already applied';
	end if;
	if to_regclass('public.qorpera_surface_sessions') is null
		or to_regclass('public.qorpera_event_deliveries') is null
		or to_regclass('public.qorpera_code_requests') is null
		or to_regprocedure('public.qorpera_backfill_connector_operation_grants(text,text,text,bigint)') is null
		or to_regprocedure('public.qorpera_surface_session_json(public.qorpera_surface_sessions)') is null
		or to_regprocedure('public.qorpera_code_request_lease(text)') is null
		or to_regprocedure('public.qorpera_code_request_outcome_valid(text,jsonb)') is null
		or to_regprocedure('public.qorpera_code_requests_claim(text,text,integer,text[])') is null
		or to_regprocedure('public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)') is null
		or to_regprocedure('public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)') is null then
		raise exception 'GitHub track PR sync and webhooks (20260930938000) requires prior surface, connector, and code migrations';
	end if;
end $$;

create temporary table gh_sync_before on commit drop as
select p.oid, to_jsonb(p) - 'prosrc' as fields
from pg_proc as p
where p.pronamespace = 'public'::regnamespace
	and p.oid in (
		'public.qorpera_code_request_lease(text)'::regprocedure,
		'public.qorpera_code_request_outcome_valid(text,jsonb)'::regprocedure,
		'public.qorpera_code_requests_claim(text,text,integer,text[])'::regprocedure,
		'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure,
		'public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)'::regprocedure
	);

create function pg_temp.gh_sync_patch(p_target regprocedure, p_edits text[])
returns void language plpgsql as $$
declare
	v_definition text := pg_get_functiondef(p_target);
	v_found integer;
begin
	if coalesce(cardinality(p_edits), 0) = 0 or cardinality(p_edits) % 2 <> 0 then
		raise exception '20260930938000 invalid edits for %', p_target;
	end if;
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930938000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 120);
		end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- BEGIN GENERATED CONNECTOR CATALOG (scripts/generate-cloud-connector-catalog.mjs)
-- Catalog version 1: 30 operations.
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
	('github','list_pull_requests',1,'github_list_pull_requests','List pull requests in a repository, optionally filtered by state (open, closed, all), head branch, or base branch.','{"type":"object","properties":{"base":{"type":"string","description":"Optional base branch name filter.","minLength":1,"maxLength":200},"head":{"type":"string","description":"Optional head branch filter in ''owner:branch'' or branch form.","minLength":1,"maxLength":256},"limit":{"type":"integer","description":"Maximum pull requests to return (default 20).","minimum":1,"maximum":50},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"state":{"type":"string","description":"Filter by pull request state (default open).","enum":["open","closed","all"]}},"required":["owner","repository"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','2fec2cd46850c1aadc118f3a3ff7d6685231d98943e8f1462aae42a2b21fde28'),
	('github','create_pull_request',1,'github_create_pull_request','Open a new pull request in a repository from head branch into base branch. Visible to everyone with access to the repository.','{"type":"object","properties":{"base":{"type":"string","description":"Target branch to merge into.","minLength":1,"maxLength":200},"body":{"type":"string","description":"Pull request description in Markdown.","maxLength":20000},"draft":{"type":"boolean","description":"Open as a draft pull request when true."},"head":{"type":"string","description":"Branch containing the changes.","minLength":1,"maxLength":256},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"title":{"type":"string","description":"Pull request title.","minLength":1,"maxLength":256}},"required":["owner","repository","title","head","base"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','69804f5309cc3597774f976a67cd0fd74329acc9a1c42bda6b324df6393cbfc5'),
	('github','update_pull_request',1,'github_update_pull_request','Update an existing pull request''s title, body, base branch, or state (open or closed). Does not merge pull requests.','{"type":"object","properties":{"base":{"type":"string","description":"Updated target base branch.","minLength":1,"maxLength":200},"body":{"type":"string","description":"Updated pull request description in Markdown.","maxLength":20000},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"},"state":{"type":"string","description":"Set pull request state to open or closed.","enum":["open","closed"]},"title":{"type":"string","description":"Updated pull request title.","minLength":1,"maxLength":256}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','159d6065ed973c40df8bbb14dbf15ac3272e2c0652c2b2b0812fd822a4ea3879'),
	('github','list_pull_request_reviews',1,'github_list_pull_request_reviews','List reviews submitted on a pull request: reviewer, state, commit SHA, timestamp, and summary.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum reviews to return (default 20).","minimum":1,"maximum":50},"number":{"type":"integer","description":"Issue or pull request number.","minimum":1,"maximum":999999999},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","number"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','256db23d23ea62635bd9e6461ea79dad112a3bde1b90df2f827c56ccd550c87c'),
	('github','list_check_runs',1,'github_list_check_runs','List CI check runs for a branch, tag, or commit SHA in a repository: name, status, conclusion, and details link.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum check runs to return (default 30).","minimum":1,"maximum":100},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"ref":{"type":"string","description":"Commit SHA, branch name, or tag.","minLength":1,"maxLength":256},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository","ref"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','cde55c38874cbd93c59c25ca26b82fe2b998d631901b3d2ab0551bd4300adfda'),
	('github','list_branches',1,'github_list_branches','List branches in a repository with each branch''s head commit SHA and protection status.','{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum branches to return (default 30).","minimum":1,"maximum":100},"owner":{"type":"string","description":"Repository owner (user or organization login).","minLength":1,"maxLength":39,"pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$"},"repository":{"type":"string","description":"Repository name without the owner.","minLength":1,"maxLength":100,"pattern":"^[A-Za-z0-9_.-]{1,100}$"}},"required":["owner","repository"],"additionalProperties":false}'::jsonb,'https://api.github.com','access_token','1ad595f309e332f8850d4f2fa21a3fa4e24687b740c637adde0429d451a819a5'),
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

do $$ begin
	perform public.qorpera_backfill_connector_operation_grants('github', 'get_pull_request', 'list_pull_requests', 1);
	perform public.qorpera_backfill_connector_operation_grants('github', 'get_pull_request', 'list_pull_request_reviews', 1);
	perform public.qorpera_backfill_connector_operation_grants('github', 'get_pull_request', 'list_check_runs', 1);
	perform public.qorpera_backfill_connector_operation_grants('github', 'get_pull_request', 'list_branches', 1);
	perform public.qorpera_backfill_connector_operation_grants('github', 'create_issue', 'create_pull_request', 1);
	perform public.qorpera_backfill_connector_operation_grants('github', 'create_issue', 'update_pull_request', 1);
end $$;

create index qorpera_surface_sessions_external_pr_idx
	on public.qorpera_surface_sessions (profile_id, lower(external_pr ->> 'repository'), (external_pr ->> 'number'))
	where external_pr is not null;

create index qorpera_surface_sessions_track_branch_idx
	on public.qorpera_surface_sessions (profile_id, surface_id, lower(track_branch))
	where track_branch is not null;

create function public.qorpera_surface_external_pr_valid(p_pr jsonb)
returns boolean
language sql immutable set search_path = '' as $$
	select case
		when p_pr is null then true
		when jsonb_typeof(p_pr) <> 'object' or pg_column_size(p_pr) > 4096 then false
		when p_pr - array[
			'provider', 'repository', 'number', 'url', 'state',
			'headBranch', 'baseBranch', 'title', 'headSha', 'draft',
			'checksStatus', 'updatedAt'
		] <> '{}'::jsonb then false
		when p_pr ? 'provider' and p_pr -> 'provider' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'provider') <> 'string' or char_length(p_pr ->> 'provider') not between 1 and 40) then false
		when p_pr ? 'repository' and p_pr -> 'repository' <> 'null'::jsonb
			and (
				jsonb_typeof(p_pr -> 'repository') <> 'string'
				or (p_pr ->> 'repository') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$'
			) then false
		when p_pr ? 'number' and p_pr -> 'number' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'number') <> 'number' or (p_pr ->> 'number') !~ '^[1-9][0-9]{0,8}$') then false
		when p_pr ? 'url' and p_pr -> 'url' <> 'null'::jsonb
			and (
				jsonb_typeof(p_pr -> 'url') <> 'string'
				or char_length(p_pr ->> 'url') > 512
				or (p_pr ->> 'url') !~ '^https://[A-Za-z0-9._:/?&#%+-]+$'
			) then false
		when p_pr ? 'state' and p_pr -> 'state' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'state') <> 'string' or char_length(p_pr ->> 'state') not between 1 and 40) then false
		when p_pr ? 'headBranch' and p_pr -> 'headBranch' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'headBranch') <> 'string' or octet_length(p_pr ->> 'headBranch') not between 1 and 200) then false
		when p_pr ? 'baseBranch' and p_pr -> 'baseBranch' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'baseBranch') <> 'string' or octet_length(p_pr ->> 'baseBranch') not between 1 and 200) then false
		when p_pr ? 'title' and p_pr -> 'title' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'title') <> 'string' or char_length(p_pr ->> 'title') > 240) then false
		when p_pr ? 'headSha' and p_pr -> 'headSha' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'headSha') <> 'string' or (p_pr ->> 'headSha') !~ '^[0-9a-f]{40}$') then false
		when p_pr ? 'draft' and p_pr -> 'draft' <> 'null'::jsonb
			and jsonb_typeof(p_pr -> 'draft') <> 'boolean' then false
		when p_pr ? 'checksStatus' and p_pr -> 'checksStatus' <> 'null'::jsonb
			and (
				jsonb_typeof(p_pr -> 'checksStatus') <> 'string'
				or (p_pr ->> 'checksStatus') not in ('pending', 'running', 'passed', 'failed', 'skipped')
			) then false
		when p_pr ? 'updatedAt' and p_pr -> 'updatedAt' <> 'null'::jsonb
			and (jsonb_typeof(p_pr -> 'updatedAt') <> 'string' or char_length(p_pr ->> 'updatedAt') > 64) then false
		else true
	end
$$;

create function public.qorpera_surface_link_track_pr_internal(
	p_profile_id uuid,
	p_session_id uuid,
	p_external_pr jsonb,
	p_track_branch text default null
)
returns public.qorpera_surface_sessions
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_branch text := nullif(btrim(coalesce(p_track_branch, '')), '');
	v_now timestamptz := clock_timestamp();
begin
	if not public.qorpera_surface_external_pr_valid(p_external_pr) then
		raise exception 'Surface external pull request payload is invalid' using errcode = '22023';
	end if;
	if v_branch is not null and (
		octet_length(v_branch) > 200
		or v_branch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
		or position('..' in v_branch) > 0
	) then
		raise exception 'Surface track branch is invalid' using errcode = '22023';
	end if;

	select * into v_session
	from public.qorpera_surface_sessions
	where id = p_session_id and profile_id = p_profile_id
	for update;
	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;

	if v_branch is null and p_external_pr is not null then
		v_branch := nullif(btrim(coalesce(p_external_pr ->> 'headBranch', '')), '');
		if v_branch is not null and (
			octet_length(v_branch) > 200
			or v_branch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
			or position('..' in v_branch) > 0
		) then
			v_branch := null;
		end if;
	end if;

	update public.qorpera_surface_sessions
	set
		external_pr = p_external_pr,
		track_branch = coalesce(v_branch, track_branch),
		updated_at = v_now
	where id = v_session.id
	returning * into v_session;

	return v_session;
end $$;

create function public.qorpera_link_surface_track_pr(
	p_session_id uuid,
	p_external_pr jsonb,
	p_track_branch text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_session public.qorpera_surface_sessions%rowtype;
	v_note text;
begin
	select * into v_session from public.qorpera_surface_sessions where id = p_session_id;
	if v_session.id is null then
		raise exception 'Surface session not found' using errcode = 'P0002';
	end if;
	perform public.qorpera_assert_surface_member(v_session.profile_id, true);
	perform public.qorpera_assert_surfaces_enabled();

	v_session := public.qorpera_surface_link_track_pr_internal(
		v_session.profile_id,
		p_session_id,
		p_external_pr,
		p_track_branch
	);

	if p_external_pr is null then
		v_note := 'Unlinked GitHub pull request from this track.';
	else
		v_note := format(
			'Linked GitHub pull request %s#%s (%s).',
			coalesce(p_external_pr ->> 'repository', 'repository'),
			coalesce(p_external_pr ->> 'number', '?'),
			coalesce(p_external_pr ->> 'state', 'open')
		);
	end if;

	insert into public.qorpera_surface_session_messages (
		profile_id, session_id, author_kind, body
	) values (
		v_session.profile_id, v_session.id, 'system', v_note
	);

	return public.qorpera_surface_session_json(v_session);
end $$;

create table public.qorpera_surface_github_webhook_receipts (
	delivery_id uuid primary key references public.qorpera_event_deliveries(id) on delete cascade,
	profile_id uuid not null,
	event_type text,
	matched_sessions integer not null default 0 check (matched_sessions >= 0),
	applied_at timestamptz not null default clock_timestamp()
);

create index qorpera_surface_github_webhook_receipts_profile_idx
	on public.qorpera_surface_github_webhook_receipts (profile_id, applied_at desc);

alter table public.qorpera_surface_github_webhook_receipts enable row level security;
revoke all on public.qorpera_surface_github_webhook_receipts
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_surface_apply_github_webhook_delivery(
	p_delivery public.qorpera_event_deliveries
)
returns text
language plpgsql security definer set search_path = '' as $$
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_inserted uuid;
	v_payload jsonb;
	v_repo text;
	v_event text;
	v_now timestamptz := clock_timestamp();
	v_matched integer := 0;
	v_session public.qorpera_surface_sessions%rowtype;
	v_pr jsonb;
	v_pr_number integer;
	v_pr_state text;
	v_head_branch text;
	v_head_repo text;
	v_base_branch text;
	v_head_sha text;
	v_pr_title text;
	v_pr_url text;
	v_pr_draft boolean;
	v_pr_updated text;
	v_next_pr jsonb;
	v_review jsonb;
	v_review_state text;
	v_reviewer text;
	v_review_body text;
	v_check jsonb;
	v_check_name text;
	v_conclusion text;
	v_check_status text;
	v_effective_status text;
	v_effective_sha text;
	v_gh_state jsonb;
	v_gh_runs jsonb;
	v_check_time text;
	v_pr_numbers text[];
	v_push_ref text;
	v_push_branch text;
	v_push_after text;
	v_push_msg text;
	v_note text;
begin
	if p_delivery.id is null or p_delivery.status <> 'verified' or p_delivery.body is null then
		return 'ignored';
	end if;

	select * into v_hook
	from public.qorpera_event_hooks
	where id = p_delivery.hook_id
		and profile_id = p_delivery.profile_id
		and proof = 'github'
		and status <> 'removed';
	if v_hook.id is null then
		return 'ignored';
	end if;

	insert into public.qorpera_surface_github_webhook_receipts (delivery_id, profile_id, event_type, applied_at)
	values (p_delivery.id, p_delivery.profile_id, p_delivery.event_type, v_now)
	on conflict (delivery_id) do nothing
	returning delivery_id into v_inserted;
	if v_inserted is null then
		return 'duplicate';
	end if;

	begin
		v_payload := convert_from(p_delivery.body, 'utf8')::jsonb;
	exception when others then
		return 'ignored';
	end;
	if jsonb_typeof(v_payload) <> 'object' then
		return 'ignored';
	end if;

	v_repo := lower(btrim(coalesce(v_payload #>> '{repository,full_name}', '')));
	if v_repo !~ '^[a-z0-9][a-z0-9_-]{0,38}/[a-z0-9_.-]{1,100}$' then
		return 'ignored';
	end if;

	v_event := lower(btrim(coalesce(p_delivery.event_type, '')));

	if v_event in (
		'pull_request.opened', 'pull_request.reopened', 'pull_request.synchronize',
		'pull_request.edited', 'pull_request.ready_for_review',
		'pull_request.converted_to_draft', 'pull_request.closed'
	) then
		v_pr := v_payload -> 'pull_request';
		if jsonb_typeof(v_pr) <> 'object' or coalesce(v_pr ->> 'number', '') !~ '^[1-9][0-9]{0,8}$' then
			return 'ignored';
		end if;
		v_pr_number := (v_pr ->> 'number')::integer;
		v_pr_state := case
			when coalesce((v_pr ->> 'merged')::boolean, false) then 'merged'
			else left(coalesce(nullif(btrim(v_pr ->> 'state'), ''), 'open'), 40)
		end;
		v_head_branch := nullif(left(btrim(coalesce(v_pr #>> '{head,ref}', '')), 200), '');
		v_head_repo := lower(btrim(coalesce(v_pr #>> '{head,repo,full_name}', '')));
		v_base_branch := nullif(left(btrim(coalesce(v_pr #>> '{base,ref}', '')), 200), '');
		v_head_sha := case
			when coalesce(v_pr #>> '{head,sha}', '') ~ '^[0-9a-f]{40}$' then v_pr #>> '{head,sha}'
			else null
		end;
		v_pr_title := nullif(left(btrim(coalesce(v_pr ->> 'title', '')), 240), '');
		v_pr_url := case
			when coalesce(v_pr ->> 'html_url', '') ~ '^https://[A-Za-z0-9._:/?&#%+-]+$'
				and char_length(v_pr ->> 'html_url') <= 512 then v_pr ->> 'html_url'
			else null
		end;
		v_pr_draft := case when jsonb_typeof(v_pr -> 'draft') = 'boolean' then (v_pr ->> 'draft')::boolean else null end;
		v_pr_updated := coalesce(nullif(left(btrim(coalesce(v_pr ->> 'updated_at', '')), 64), ''), to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

		for v_session in
			select s.*
			from public.qorpera_surface_sessions s
			join public.qorpera_surfaces sf on sf.id = s.surface_id
			where s.profile_id = v_hook.profile_id
				and (
					(
						s.external_pr is not null
						and lower(coalesce(s.external_pr ->> 'repository', '')) = v_repo
						and (s.external_pr ->> 'number') = v_pr_number::text
					)
					or (
						v_head_branch is not null
						and v_head_repo = v_repo
						and (
							s.external_pr is null
							or (
								lower(coalesce(s.external_pr ->> 'repository', '')) = v_repo
								and (s.external_pr ->> 'number') = v_pr_number::text
							)
						)
						and s.track_branch is not null
						and lower(s.track_branch) = lower(v_head_branch)
						and sf.source_kind = 'code_repo'
						and lower(coalesce(sf.repository_key, '')) = v_repo
						and s.state not in ('discarded', 'failed')
					)
				)
			order by s.id asc
			for update of s
		loop
			v_next_pr := jsonb_strip_nulls(jsonb_build_object(
				'provider', 'github',
				'repository', v_repo,
				'number', v_pr_number,
				'url', v_pr_url,
				'state', v_pr_state,
				'headBranch', v_head_branch,
				'baseBranch', v_base_branch,
				'title', v_pr_title,
				'headSha', v_head_sha,
				'draft', v_pr_draft,
				'checksStatus', case
					when v_head_sha is not null and v_session.external_pr ->> 'headSha' is distinct from v_head_sha then 'pending'
					else v_session.external_pr ->> 'checksStatus'
				end,
				'updatedAt', v_pr_updated
			));

			update public.qorpera_surface_sessions
			set
				external_pr = v_next_pr,
				track_branch = case
					when track_branch is not null then track_branch
					when v_head_branch is not null
						and v_head_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
						and position('..' in v_head_branch) = 0 then v_head_branch
					else track_branch
				end,
				updated_at = v_now
			where id = v_session.id;

			v_note := format(
				'GitHub PR #%s %s (%s%s).',
				v_pr_number,
				case
					when v_pr_state = 'merged' then 'merged'
					when v_event = 'pull_request.opened' then 'opened'
					when v_event = 'pull_request.reopened' then 'reopened'
					when v_event = 'pull_request.synchronize' then 'updated with new commits'
					when v_event = 'pull_request.ready_for_review' then 'marked ready for review'
					when v_event = 'pull_request.converted_to_draft' then 'converted to draft'
					when v_event = 'pull_request.closed' then 'closed'
					else 'edited'
				end,
				v_repo,
				case when v_pr_title is not null then ': ' || left(v_pr_title, 120) else '' end
			);
			insert into public.qorpera_surface_session_messages (profile_id, session_id, author_kind, body)
			values (v_session.profile_id, v_session.id, 'system', v_note);

			v_matched := v_matched + 1;
		end loop;

	elsif v_event = 'pull_request_review.submitted' then
		v_pr := v_payload -> 'pull_request';
		v_review := v_payload -> 'review';
		if jsonb_typeof(v_pr) <> 'object' or jsonb_typeof(v_review) <> 'object'
			or coalesce(v_pr ->> 'number', '') !~ '^[1-9][0-9]{0,8}$' then
			return 'ignored';
		end if;
		v_pr_number := (v_pr ->> 'number')::integer;
		v_review_state := lower(btrim(coalesce(v_review ->> 'state', 'commented')));
		v_reviewer := coalesce(nullif(left(btrim(coalesce(v_review #>> '{user,login}', '')), 64), ''), 'reviewer');
		v_review_body := nullif(left(btrim(coalesce(v_review ->> 'body', '')), 400), '');

		for v_session in
			select s.*
			from public.qorpera_surface_sessions s
			where s.profile_id = v_hook.profile_id
				and s.external_pr is not null
				and lower(coalesce(s.external_pr ->> 'repository', '')) = v_repo
				and (s.external_pr ->> 'number') = v_pr_number::text
			order by s.id asc
			for update of s
		loop
			v_note := format(
				'GitHub PR #%s review by %s (%s)%s',
				v_pr_number,
				v_reviewer,
				v_review_state,
				case when v_review_body is not null then ': ' || v_review_body else '.' end
			);
			insert into public.qorpera_surface_session_messages (profile_id, session_id, author_kind, body)
			values (v_session.profile_id, v_session.id, 'system', v_note);

			update public.qorpera_surface_sessions
			set updated_at = v_now
			where id = v_session.id;

			v_matched := v_matched + 1;
		end loop;

	elsif v_event in ('check_run.completed', 'check_suite.completed') then
		v_check := case
			when v_event = 'check_run.completed' then v_payload -> 'check_run'
			else v_payload -> 'check_suite'
		end;
		if jsonb_typeof(v_check) <> 'object' then
			return 'ignored';
		end if;
		v_head_sha := case
			when coalesce(v_check ->> 'head_sha', '') ~ '^[0-9a-f]{40}$' then v_check ->> 'head_sha'
			else null
		end;
		v_conclusion := lower(btrim(coalesce(v_check ->> 'conclusion', '')));
		v_check_status := case
			when v_conclusion in ('success', 'neutral', 'skipped') then 'passed'
			when v_conclusion in ('failure', 'timed_out', 'action_required', 'cancelled', 'stale') then 'failed'
			else 'running'
		end;
		v_check_name := coalesce(
			nullif(left(btrim(coalesce(v_check ->> 'name', '')), 120), ''),
			case when v_event = 'check_suite.completed' then 'GitHub check suite' else 'GitHub check' end
		);
		if jsonb_typeof(v_check -> 'pull_requests') = 'array' then
			select array_agg(distinct (pr_item ->> 'number'))
			into v_pr_numbers
			from jsonb_array_elements(v_check -> 'pull_requests') as pr_item
			where coalesce(pr_item ->> 'number', '') ~ '^[1-9][0-9]{0,8}$';
		end if;
		if v_head_sha is null and (v_pr_numbers is null or cardinality(v_pr_numbers) = 0) then
			return 'ignored';
		end if;

		v_check_time := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

		for v_session in
			select s.*
			from public.qorpera_surface_sessions s
			join public.qorpera_surfaces sf on sf.id = s.surface_id
			where s.profile_id = v_hook.profile_id
				and (
					(
						s.external_pr is not null
						and lower(coalesce(s.external_pr ->> 'repository', '')) = v_repo
						and (
							(v_head_sha is not null and s.external_pr ->> 'headSha' = v_head_sha)
							or (v_pr_numbers is not null and (s.external_pr ->> 'number') = any(v_pr_numbers))
						)
					)
					or (
						v_head_sha is not null
						and s.branch_head_sha = v_head_sha
						and sf.source_kind = 'code_repo'
						and lower(coalesce(sf.repository_key, '')) = v_repo
					)
				)
			order by s.id asc
			for update of s
		loop
			v_effective_sha := coalesce(v_head_sha, v_session.external_pr ->> 'headSha', v_session.branch_head_sha);
			v_gh_state := v_session.checks_summary -> 'github';
			if jsonb_typeof(v_gh_state) = 'object'
				and v_effective_sha is not null
				and v_gh_state ->> 'sha' = v_effective_sha
				and jsonb_typeof(v_gh_state -> 'runs') = 'object' then
				v_gh_runs := v_gh_state -> 'runs';
			else
				v_gh_runs := '{}'::jsonb;
			end if;
			if (v_gh_runs ? v_check_name) or (select count(*) from jsonb_object_keys(v_gh_runs)) < 40 then
				v_gh_runs := v_gh_runs || jsonb_build_object(v_check_name, v_check_status);
			end if;
			v_effective_status := case
				when v_check_status = 'failed'
					or exists (select 1 from jsonb_each_text(v_gh_runs) as r(k, v) where r.v = 'failed') then 'failed'
				when v_check_status = 'running'
					or exists (select 1 from jsonb_each_text(v_gh_runs) as r(k, v) where r.v = 'running') then 'running'
				else 'passed'
			end;

			update public.qorpera_surface_sessions
			set
				checks_summary = coalesce(v_session.checks_summary, '{}'::jsonb) || jsonb_build_object(
					'status', v_effective_status,
					'summary', format('%s: %s', v_check_name, coalesce(nullif(v_conclusion, ''), v_check_status)),
					'updatedAt', v_check_time,
					'github', jsonb_strip_nulls(jsonb_build_object(
						'sha', v_effective_sha,
						'runs', v_gh_runs
					))
				),
				external_pr = case
					when external_pr is not null then external_pr || jsonb_build_object(
						'checksStatus', v_effective_status,
						'updatedAt', v_check_time
					)
					else external_pr
				end,
				updated_at = v_now
			where id = v_session.id;

			v_note := format(
				'GitHub check %s %s (%s).',
				v_check_name,
				coalesce(nullif(v_conclusion, ''), v_check_status),
				v_repo
			);
			insert into public.qorpera_surface_session_messages (profile_id, session_id, author_kind, body)
			values (v_session.profile_id, v_session.id, 'system', v_note);

			v_matched := v_matched + 1;
		end loop;

	elsif v_event = 'push' then
		v_push_ref := coalesce(v_payload ->> 'ref', '');
		if left(v_push_ref, 11) <> 'refs/heads/' then
			return 'ignored';
		end if;
		v_push_branch := nullif(left(btrim(substring(v_push_ref from 12)), 200), '');
		if v_push_branch is null then
			return 'ignored';
		end if;
		v_push_after := case
			when coalesce(v_payload ->> 'after', '') ~ '^[0-9a-f]{40}$'
				and (v_payload ->> 'after') <> repeat('0', 40) then v_payload ->> 'after'
			else null
		end;
		v_push_msg := nullif(left(btrim(split_part(coalesce(v_payload #>> '{head_commit,message}', ''), E'\n', 1)), 160), '');

		for v_session in
			select s.*
			from public.qorpera_surface_sessions s
			join public.qorpera_surfaces sf on sf.id = s.surface_id
			where s.profile_id = v_hook.profile_id
				and s.state not in ('discarded', 'failed')
				and (
					(
						s.external_pr is not null
						and lower(coalesce(s.external_pr ->> 'repository', '')) = v_repo
						and lower(coalesce(s.external_pr ->> 'headBranch', '')) = lower(v_push_branch)
					)
					or (
						s.track_branch is not null
						and lower(s.track_branch) = lower(v_push_branch)
						and sf.source_kind = 'code_repo'
						and lower(coalesce(sf.repository_key, '')) = v_repo
					)
				)
			order by s.id asc
			for update of s
		loop
			update public.qorpera_surface_sessions
			set
				external_pr = case
					when external_pr is not null and v_push_after is not null then external_pr || jsonb_build_object(
						'headSha', v_push_after,
						'checksStatus', case
							when external_pr ->> 'headSha' is distinct from v_push_after then 'pending'
							else coalesce(external_pr ->> 'checksStatus', 'pending')
						end,
						'updatedAt', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
					)
					else external_pr
				end,
				updated_at = v_now
			where id = v_session.id;

			v_note := format(
				'GitHub push to %s on %s%s.',
				v_push_branch,
				v_repo,
				case
					when v_push_after is not null and v_push_msg is not null then ' (' || left(v_push_after, 7) || ': ' || v_push_msg || ')'
					when v_push_after is not null then ' (' || left(v_push_after, 7) || ')'
					else ''
				end
			);
			insert into public.qorpera_surface_session_messages (profile_id, session_id, author_kind, body)
			values (v_session.profile_id, v_session.id, 'system', v_note);

			v_matched := v_matched + 1;
		end loop;
	else
		return 'ignored';
	end if;

	update public.qorpera_surface_github_webhook_receipts
	set matched_sessions = v_matched
	where delivery_id = p_delivery.id;

	return case when v_matched > 0 then 'applied' else 'ignored' end;
end $$;

create function public.qorpera_surface_tracks_from_github_delivery()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
	perform public.qorpera_surface_apply_github_webhook_delivery(new);
	return null;
exception when others then
	return null;
end $$;

create trigger qorpera_surface_tracks_from_github
	after update of status on public.qorpera_event_deliveries
	for each row when (new.status = 'verified' and old.status is distinct from 'verified')
	execute function public.qorpera_surface_tracks_from_github_delivery();

alter table public.qorpera_code_changes
	drop constraint qorpera_code_changes_kind_check,
	add constraint qorpera_code_changes_kind_check
		check (kind in ('landing', 'undo', 'restore', 'found', 'import', 'pull'));

alter table public.qorpera_code_requests
	drop constraint qorpera_code_requests_kind_check,
	add constraint qorpera_code_requests_kind_check
		check (kind in ('undo', 'download', 'restore', 'import', 'query', 'lifecycle', 'github_sync'));

select pg_temp.gh_sync_patch(
	'public.qorpera_code_request_lease(text)'::regprocedure,
	array[
		$old$when 'lifecycle' then interval '5 minutes'$old$,
		$new$when 'lifecycle' then interval '5 minutes'
		when 'github_sync' then interval '10 minutes'$new$
	]
);

select pg_temp.gh_sync_patch(
	'public.qorpera_code_request_outcome_valid(text,jsonb)'::regprocedure,
	array[
		$old$			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind in ('query','lifecycle') then
				p_outcome - array['schema','state','code','paths','messages'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and (not (p_outcome ? 'paths') or public.qorpera_code_json_strings(p_outcome -> 'paths', 100))
				and (not (p_outcome ? 'messages') or public.qorpera_code_json_strings(p_outcome -> 'messages', 30))$old$,
		$new$			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind in ('query','lifecycle') then
				p_outcome - array['schema','state','code','paths','messages'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^CODE_HOST_[A-Z0-9_]{1,100}$')
				and (not (p_outcome ? 'paths') or public.qorpera_code_json_strings(p_outcome -> 'paths', 100))
				and (not (p_outcome ? 'messages') or public.qorpera_code_json_strings(p_outcome -> 'messages', 30))
			when p_outcome -> 'state' = '"refused"'::jsonb and p_kind = 'github_sync' then
				p_outcome - array['schema','state','code','paths','messages'] = '{}'::jsonb
				and public.qorpera_code_json_text(p_outcome -> 'code', '^(CODE_HOST|GITHUB_SYNC)_[A-Z0-9_]{1,100}$')
				and (not (p_outcome ? 'paths') or public.qorpera_code_json_strings(p_outcome -> 'paths', 100))
				and (not (p_outcome ? 'messages') or public.qorpera_code_json_strings(p_outcome -> 'messages', 30))$new$,
		$old$				when 'lifecycle:pruned' then
					p_outcome - array['schema','state','result','retiredWorktrees','deletedBranches','skippedWorktrees'] = '{}'::jsonb$old$,
		$new$				when 'lifecycle:pruned' then
					p_outcome - array['schema','state','result','retiredWorktrees','deletedBranches','skippedWorktrees'] = '{}'::jsonb
				when 'github_sync:synced' then
					p_outcome ?& array['githubRepo','remoteBranch','mainSha','ahead','behind','diverged']
					and p_outcome - array['schema','state','result','githubRepo','remoteBranch','remoteSha','mainSha','ahead','behind','diverged'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'githubRepo', '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
					and public.qorpera_code_json_text(p_outcome -> 'remoteBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
					and (not (p_outcome ? 'remoteSha') or p_outcome -> 'remoteSha' = 'null'::jsonb or public.qorpera_code_json_text(p_outcome -> 'remoteSha', '^[0-9a-f]{40}$'))
					and public.qorpera_code_json_text(p_outcome -> 'mainSha', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_count(p_outcome -> 'ahead')
					and public.qorpera_code_json_count(p_outcome -> 'behind')
					and jsonb_typeof(p_outcome -> 'diverged') = 'boolean'
				when 'github_sync:pulled' then
					p_outcome ?& array['githubRepo','remoteBranch','mainBefore','mainAfter','remoteSha','mode','commitsPulled']
					and p_outcome - array['schema','state','result','githubRepo','remoteBranch','mainBefore','mainAfter','remoteSha','mode','commitsPulled'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'githubRepo', '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
					and public.qorpera_code_json_text(p_outcome -> 'remoteBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainBefore', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'mainAfter', '^[0-9a-f]{40}$')
					and public.qorpera_code_json_text(p_outcome -> 'remoteSha', '^[0-9a-f]{40}$')
					and coalesce(p_outcome ->> 'mode' in ('unchanged','fast-forward','merged'), false)
					and public.qorpera_code_json_count(p_outcome -> 'commitsPulled')
				when 'github_sync:pushed' then
					p_outcome ?& array['githubRepo','localRef','remoteBranch','headSha','created']
					and p_outcome - array['schema','state','result','githubRepo','localRef','remoteBranch','headSha','previousRemoteSha','created'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'githubRepo', '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
					and jsonb_typeof(p_outcome -> 'localRef') = 'string'
					and public.qorpera_code_json_text(p_outcome -> 'remoteBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
					and public.qorpera_code_json_text(p_outcome -> 'headSha', '^[0-9a-f]{40}$')
					and (not (p_outcome ? 'previousRemoteSha') or p_outcome -> 'previousRemoteSha' = 'null'::jsonb or public.qorpera_code_json_text(p_outcome -> 'previousRemoteSha', '^[0-9a-f]{40}$'))
					and jsonb_typeof(p_outcome -> 'created') = 'boolean'
				when 'github_sync:pr_created' then
					p_outcome ?& array['githubRepo','number','url','prState','headBranch','baseBranch','title','draft','updatedAt']
					and p_outcome - array['schema','state','result','githubRepo','number','url','prState','headBranch','baseBranch','title','headSha','draft','updatedAt','sessionId'] = '{}'::jsonb
					and public.qorpera_code_json_text(p_outcome -> 'githubRepo', '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
					and public.qorpera_code_json_count(p_outcome -> 'number') and p_outcome ->> 'number' ~ '^[1-9][0-9]{0,8}$'
					and public.qorpera_code_json_text(p_outcome -> 'url', '^https://[A-Za-z0-9._:/?&#%+-]+$')
					and char_length(p_outcome ->> 'url') <= 512
					and public.qorpera_code_json_text(p_outcome -> 'prState', '^[a-z]{1,40}$')
					and public.qorpera_code_json_text(p_outcome -> 'headBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
					and public.qorpera_code_json_text(p_outcome -> 'baseBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
					and jsonb_typeof(p_outcome -> 'title') = 'string' and char_length(p_outcome ->> 'title') between 1 and 256
					and (not (p_outcome ? 'headSha') or p_outcome -> 'headSha' = 'null'::jsonb or public.qorpera_code_json_text(p_outcome -> 'headSha', '^[0-9a-f]{40}$'))
					and jsonb_typeof(p_outcome -> 'draft') = 'boolean'
					and jsonb_typeof(p_outcome -> 'updatedAt') = 'string' and char_length(p_outcome ->> 'updatedAt') <= 64
					and (not (p_outcome ? 'sessionId') or p_outcome -> 'sessionId' = 'null'::jsonb or public.qorpera_code_json_text(p_outcome -> 'sessionId', '^[0-9a-fA-F-]{36}$'))$new$
	]
);

select pg_temp.gh_sync_patch(
	'public.qorpera_code_requests_claim(text,text,integer,text[])'::regprocedure,
	array[
		$old$or not p_kinds <@ array['undo','download','restore','import','query','lifecycle'] then$old$,
		$new$or not p_kinds <@ array['undo','download','restore','import','query','lifecycle','github_sync'] then$new$,
		$old$		elsif v_request.kind = 'lifecycle' then
			v_item := v_item || jsonb_build_object('op', v_request.input ->> 'op', 'lifecycle', v_request.input);$old$,
		$new$		elsif v_request.kind = 'lifecycle' then
			v_item := v_item || jsonb_build_object('op', v_request.input ->> 'op', 'lifecycle', v_request.input);
		elsif v_request.kind = 'github_sync' then
			v_item := v_item || jsonb_build_object('op', v_request.input ->> 'op', 'githubSync', v_request.input);$new$
	]
);

select pg_temp.gh_sync_patch(
	'public.qorpera_code_request_finish(text,text,uuid,uuid,jsonb)'::regprocedure,
	array[
		$old$			or public.qorpera_code_request_outcome_valid('lifecycle', p_outcome))) then$old$,
		$new$			or public.qorpera_code_request_outcome_valid('lifecycle', p_outcome)
			or public.qorpera_code_request_outcome_valid('github_sync', p_outcome))) then$new$,
		$old$	elsif v_request.kind = 'lifecycle' and v_result = 'created' then
		update public.qorpera_code_repositories
		set last_main = coalesce(last_main, p_outcome ->> 'mainSha')
		where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		v_stored := p_outcome;$old$,
		$new$	elsif v_request.kind = 'lifecycle' and v_result = 'created' then
		update public.qorpera_code_repositories
		set last_main = coalesce(last_main, p_outcome ->> 'mainSha')
		where environment_id = v_repository.environment_id and owner = v_repository.owner and name = v_repository.name;
		v_stored := p_outcome;
	elsif v_request.kind = 'github_sync' and v_result = 'pulled' then
		if p_outcome ->> 'mode' <> 'unchanged'
			and (p_outcome ->> 'mainBefore') is distinct from (p_outcome ->> 'mainAfter') then
			if v_repository.last_main is not null
				and v_repository.last_main is distinct from (p_outcome ->> 'mainBefore') then
				perform public.qorpera_code_change_found(
					v_repository.environment_id,
					v_repository.owner,
					v_repository.name,
					v_repository.last_main,
					p_outcome ->> 'mainBefore'
				);
			end if;
			v_n := public.qorpera_code_change_append(
				v_repository.environment_id,
				v_repository.owner,
				v_repository.name,
				jsonb_build_object(
					'kind', 'pull',
					'state', 'landed',
					'how', p_outcome ->> 'mode',
					'main_before', p_outcome ->> 'mainBefore',
					'main_after', p_outcome ->> 'mainAfter',
					'head_sha', p_outcome ->> 'remoteSha',
					'request_id', v_request.id,
					'staff_agent_id', v_request.by_agent_id,
					'owner_user_id', v_request.by_user_id,
					'checks_state', 'not_run',
					'title', left(format(
						'Pulled %s from GitHub (%s)',
						p_outcome ->> 'remoteBranch',
						p_outcome ->> 'githubRepo'
					), 380),
					'summary', format(
						'Pulled %s commit(s) from %s (%s) via %s.',
						p_outcome ->> 'commitsPulled',
						p_outcome ->> 'githubRepo',
						p_outcome ->> 'remoteBranch',
						p_outcome ->> 'mode'
					)
				)
			);
			update public.qorpera_code_repositories
			set main_sha = p_outcome ->> 'mainAfter'
			where environment_id = v_repository.environment_id
				and owner = v_repository.owner
				and name = v_repository.name;
		end if;
		v_stored := p_outcome;
	elsif v_request.kind = 'github_sync' and v_result = 'pr_created' then
		if coalesce(v_request.input ->> 'sessionId', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
			begin
				perform public.qorpera_surface_link_track_pr_internal(
					v_request.profile_id,
					(v_request.input ->> 'sessionId')::uuid,
					jsonb_strip_nulls(jsonb_build_object(
						'provider', 'github',
						'repository', lower(p_outcome ->> 'githubRepo'),
						'number', (p_outcome ->> 'number')::integer,
						'url', p_outcome ->> 'url',
						'state', p_outcome ->> 'prState',
						'headBranch', p_outcome ->> 'headBranch',
						'baseBranch', p_outcome ->> 'baseBranch',
						'title', p_outcome ->> 'title',
						'headSha', p_outcome ->> 'headSha',
						'draft', (p_outcome ->> 'draft')::boolean,
						'updatedAt', p_outcome ->> 'updatedAt'
					)),
					p_outcome ->> 'headBranch'
				);
				insert into public.qorpera_surface_session_messages (profile_id, session_id, author_kind, body)
				values (
					v_request.profile_id,
					(v_request.input ->> 'sessionId')::uuid,
					'system',
					format('Opened GitHub PR #%s on %s (%s).', p_outcome ->> 'number', p_outcome ->> 'githubRepo', p_outcome ->> 'title')
				);
			exception when others then
				null;
			end;
		end if;
		v_stored := p_outcome;
	elsif v_request.kind = 'github_sync' and v_result in ('synced', 'pushed') then
		v_stored := p_outcome;$new$
	]
);

create function public.qorpera_folder_code_github_sync(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
	v_run public.qorpera_execution_runs%rowtype;
	v_digest text;
	v_receipt_id uuid := extensions.gen_random_uuid();
	v_begun jsonb;
	v_result jsonb;
	v_repo public.qorpera_code_repositories%rowtype;
	v_op text;
	v_owner text;
	v_name text;
	v_github text;
	v_remote_branch text;
	v_head_branch text;
	v_base_branch text;
	v_local_ref text;
	v_session_id uuid;
	v_id uuid;
	v_input jsonb;
begin
	if jsonb_typeof(p_request) is distinct from 'object'
		or not p_request ?& array['operationKey', 'op', 'owner', 'name', 'github']
		or not public.qorpera_code_json_text(p_request -> 'operationKey', '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$')
		or not public.qorpera_code_json_text(p_request -> 'owner', '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$')
		or not public.qorpera_code_json_text(p_request -> 'name', '^[a-z0-9_]([a-z0-9_.-]{0,98}[a-z0-9_-])?$')
		or not public.qorpera_code_json_text(p_request -> 'github', '^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9_.-]{1,100}$')
		or coalesce(p_request ->> 'op', '') not in ('sync', 'pull', 'push', 'create_pr') then
		raise exception 'Code request is invalid' using errcode = '22023';
	end if;

	v_op := p_request ->> 'op';
	v_owner := p_request ->> 'owner';
	v_name := p_request ->> 'name';
	v_github := p_request ->> 'github';

	if v_op in ('sync', 'pull') then
		if p_request - array['operationKey', 'op', 'owner', 'name', 'github', 'remoteBranch'] <> '{}'::jsonb
			or not public.qorpera_code_json_text(p_request -> 'remoteBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
			or position('..' in (p_request ->> 'remoteBranch')) > 0 then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_remote_branch := p_request ->> 'remoteBranch';
	elsif v_op = 'push' then
		if p_request - array['operationKey', 'op', 'owner', 'name', 'github', 'remoteBranch', 'ref', 'allowDefaultBranch'] <> '{}'::jsonb
			or not public.qorpera_code_json_text(p_request -> 'remoteBranch', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
			or position('..' in (p_request ->> 'remoteBranch')) > 0
			or (p_request ? 'allowDefaultBranch' and jsonb_typeof(p_request -> 'allowDefaultBranch') not in ('boolean', 'null')) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_remote_branch := p_request ->> 'remoteBranch';
	else
		if p_request - array['operationKey', 'op', 'owner', 'name', 'github', 'head', 'base', 'title', 'body', 'draft', 'sessionId'] <> '{}'::jsonb
			or not public.qorpera_code_json_text(p_request -> 'head', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
			or position('..' in (p_request ->> 'head')) > 0
			or not public.qorpera_code_json_text(p_request -> 'base', '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$')
			or position('..' in (p_request ->> 'base')) > 0
			or jsonb_typeof(p_request -> 'title') is distinct from 'string'
			or btrim(p_request ->> 'title') = ''
			or char_length(p_request ->> 'title') > 256
			or (p_request ? 'body' and p_request -> 'body' <> 'null'::jsonb
				and (jsonb_typeof(p_request -> 'body') <> 'string' or char_length(p_request ->> 'body') > 20000))
			or (p_request ? 'draft' and jsonb_typeof(p_request -> 'draft') not in ('boolean', 'null'))
			or (p_request ? 'sessionId' and p_request -> 'sessionId' <> 'null'::jsonb
				and not public.qorpera_code_json_text(p_request -> 'sessionId', '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) then
			raise exception 'Code request is invalid' using errcode = '22023';
		end if;
		v_head_branch := p_request ->> 'head';
		v_base_branch := p_request ->> 'base';
		if p_request ->> 'sessionId' is not null then
			v_session_id := (p_request ->> 'sessionId')::uuid;
		end if;
	end if;

	v_run := public.qorpera_code_agent_run(p_binding);
	v_digest := encode(extensions.digest(convert_to(jsonb_build_object(
		'schema', 'qorpera.folder-code-github-sync/v1',
		'runId', v_run.id,
		'request', p_request
	)::text, 'utf8'), 'sha256'), 'hex');
	v_begun := public.qorpera_folder_begin_run_receipt(
		p_binding, v_receipt_id, 'code:' || (p_request ->> 'operationKey'), v_digest,
		encode(extensions.digest(convert_to(v_run.id::text || ':code:' || (p_request ->> 'operationKey'), 'utf8'), 'sha256'), 'hex'),
		false
	);
	if v_begun ->> 'state' = 'completed' then return v_begun -> 'result'; end if;
	if v_begun ->> 'receipt_id' is distinct from v_receipt_id::text or v_begun ->> 'state' is distinct from 'executing' then
		raise exception 'Code operation needs reconciliation' using errcode = '55000';
	end if;

	select * into v_repo from public.qorpera_code_repositories repo
	where repo.environment_id = v_run.environment_id and repo.owner = v_owner and repo.name = v_name for update;
	if not found then
		raise exception 'No such repository' using errcode = 'P0002';
	end if;

	if v_op = 'pull' and v_repo.archived_at is not null then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'archived');
	elsif v_session_id is not null and not exists (
		select 1 from public.qorpera_surface_sessions s
		where s.id = v_session_id and s.profile_id = v_run.profile_id
	) then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'no_session');
	elsif not (
		(
			v_repo.imported_from ->> 'kind' = 'github'
			and lower(coalesce(v_repo.imported_from ->> 'repository', '')) = lower(v_github)
		)
		or exists (
			select 1 from public.qorpera_coding_repository_grants as repo_grant
			where repo_grant.environment_id = v_run.environment_id
				and repo_grant.staff_agent_id = v_run.staff_agent_id
				and repo_grant.enabled
				and repo_grant.repository ->> 'host' = 'github.com'
				and lower((repo_grant.repository ->> 'owner') || '/' || (repo_grant.repository ->> 'name')) = lower(v_github)
		)
	) then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'repo_not_authorized');
	elsif not exists (
		select 1
		from public.qorpera_cloud_secrets as secret
		where secret.profile_id = v_run.profile_id
			and secret.environment_id = v_run.environment_id
			and secret.owner_kind = 'company'
			and secret.connector_id = 'github'
			and secret.secret_name = 'primary'
			and secret.status = 'active'
	) then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'no_github_connection');
	elsif not exists (
		select 1
		from public.qorpera_cloud_secrets as secret
		join public.qorpera_cloud_secret_operation_grants as grant_row
			on grant_row.secret_id = secret.id
			and grant_row.profile_id = secret.profile_id
			and grant_row.environment_id = secret.environment_id
		where secret.profile_id = v_run.profile_id
			and secret.environment_id = v_run.environment_id
			and secret.owner_kind = 'company'
			and secret.connector_id = 'github'
			and secret.secret_name = 'primary'
			and secret.status = 'active'
			and grant_row.staff_agent_id = v_run.staff_agent_id
			and grant_row.status = 'active'
			and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
			and (
				(v_op in ('push', 'create_pr') and grant_row.operation_id = 'create_pull_request')
				or (v_op in ('sync', 'pull') and grant_row.operation_id in ('read_file', 'get_pull_request', 'list_pull_requests', 'list_branches', 'create_pull_request'))
			)
			and exists (
				select 1 from public.qorpera_profile_members as issuer
				where issuer.profile_id = grant_row.profile_id
					and issuer.user_id = grant_row.issued_by_user_id
					and issuer.role in ('owner', 'admin')
			)
	) then
		v_result := jsonb_build_object(
			'schema', 'qorpera.code-github-sync/v1',
			'state', 'refused',
			'reason', case when v_op in ('push', 'create_pr') then 'no_github_write_grant' else 'no_github_connection' end
		);
	elsif v_op = 'pull' and exists (
		select 1 from public.qorpera_code_requests req
		where req.environment_id = v_repo.environment_id
			and req.owner = v_repo.owner
			and req.name = v_repo.name
			and req.state in ('queued', 'running')
			and (
				(req.kind = 'undo' and coalesce((req.input ->> 'dryRun')::boolean, false) = false)
				or req.kind = 'restore'
				or (req.kind = 'github_sync' and req.input ->> 'op' = 'pull')
			)
	) then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'busy');
	elsif not exists (
		select 1 from public.qorpera_coding_executors executor
		where executor.environment_id = v_repo.environment_id and executor.enabled
	) then
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'refused', 'reason', 'no_executor');
	else
		if v_op = 'push' then
			if p_request ? 'ref' and p_request -> 'ref' <> 'null'::jsonb then
				v_local_ref := public.qorpera_code_resolve_ref_internal(v_run.environment_id, v_owner, v_name, p_request -> 'ref');
			else
				v_local_ref := 'refs/heads/main';
			end if;
			v_input := jsonb_build_object(
				'op', 'push',
				'githubRepo', v_github,
				'remoteBranch', v_remote_branch,
				'localRef', v_local_ref,
				'allowDefaultBranch', coalesce((p_request ->> 'allowDefaultBranch')::boolean, false)
			);
		elsif v_op in ('sync', 'pull') then
			v_input := jsonb_build_object(
				'op', v_op,
				'githubRepo', v_github,
				'remoteBranch', v_remote_branch
			);
		else
			v_input := jsonb_strip_nulls(jsonb_build_object(
				'op', 'create_pr',
				'githubRepo', v_github,
				'headBranch', v_head_branch,
				'baseBranch', v_base_branch,
				'title', btrim(p_request ->> 'title'),
				'body', p_request ->> 'body',
				'draft', coalesce((p_request ->> 'draft')::boolean, false),
				'sessionId', v_session_id
			));
		end if;

		insert into public.qorpera_code_requests(
			environment_id, owner, name, profile_id, kind, input, by_kind, by_user_id, by_agent_id, run_id
		)
		values (
			v_repo.environment_id, v_repo.owner, v_repo.name, v_repo.profile_id, 'github_sync',
			v_input, 'agent', v_run.requested_by_user_id, v_run.staff_agent_id, v_run.id
		)
		returning id into v_id;

		perform public.qorpera_code_requests_notify_internal(v_repo.environment_id, v_id, 'github_sync');
		v_result := jsonb_build_object('schema', 'qorpera.code-github-sync/v1', 'state', 'queued', 'requestId', v_id);
	end if;

	perform public.qorpera_folder_complete_run_receipt(p_binding, v_receipt_id, v_digest, v_result, null);
	return v_result;
end $$;

create function public.qorpera_authorize_github_sync_credential(
	p_broker_authority_id uuid,
	p_broker_capability_sha256 text,
	p_request_id uuid,
	p_lease_token uuid,
	p_executor_owner text,
	p_repository jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_authority public.qorpera_cloud_secret_broker_authorities%rowtype;
	v_request public.qorpera_code_requests%rowtype;
	v_repo public.qorpera_code_repositories%rowtype;
	v_secret public.qorpera_cloud_secrets%rowtype;
	v_version public.qorpera_cloud_secret_versions%rowtype;
	v_expected_repo text;
	v_op text;
begin
	if session_user <> 'qorpera_secret_broker' then
		raise exception 'cloud secret broker authority is required' using errcode = '42501';
	end if;
	if p_request_id is null or p_lease_token is null
		or coalesce(p_executor_owner, '') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or not public.qorpera_coding_repository_valid(p_repository)
		or p_repository ->> 'host' is distinct from 'github.com' then
		raise exception 'coding repository credential request is invalid' using errcode = '22023';
	end if;

	select authority.* into v_authority
	from public.qorpera_cloud_secret_broker_authorities as authority
	where authority.id = p_broker_authority_id for share;
	if v_authority.id is null or v_authority.status <> 'active'
		or v_authority.capability_sha256 is distinct from p_broker_capability_sha256 then
		raise exception 'cloud secret broker authority is unavailable' using errcode = '42501';
	end if;

	select request.* into v_request
	from public.qorpera_code_requests as request
	where request.id = p_request_id for share;
	if v_request.id is null or v_request.kind <> 'github_sync' or v_request.profile_id <> v_authority.profile_id then
		raise exception 'coding session is unavailable to this broker' using errcode = '42501';
	end if;
	if v_request.state <> 'running'
		or v_request.lease_owner is distinct from p_executor_owner
		or v_request.lease_token is distinct from p_lease_token
		or v_request.lease_until <= clock_timestamp() then
		raise exception 'coding session lease is unavailable' using errcode = '42501';
	end if;

	v_op := coalesce(v_request.input ->> 'op', '');
	if v_op not in ('sync', 'pull', 'push', 'create_pr') then
		raise exception 'coding repository credential operation is unavailable' using errcode = '42501';
	end if;

	v_expected_repo := lower(coalesce(v_request.input ->> 'githubRepo', ''));
	if v_expected_repo = '' or v_expected_repo <> lower((p_repository ->> 'owner') || '/' || (p_repository ->> 'name')) then
		raise exception 'coding repository differs from the session' using errcode = '42501';
	end if;

	if exists (select 1 from public.qorpera_company_deletions as deletion where deletion.profile_id = v_request.profile_id)
		or not exists (
			select 1 from public.qorpera_coding_executors as executor
			where executor.environment_id = v_request.environment_id
				and executor.owner = p_executor_owner
				and executor.enabled
		) then
		raise exception 'coding executor is unavailable' using errcode = '42501';
	end if;

	if v_request.by_kind = 'agent' then
		if v_request.by_agent_id is null or not exists (
			select 1 from public.qorpera_profile_staff as staff
			where staff.profile_id = v_request.profile_id
				and staff.staff_agent_id = v_request.by_agent_id
				and staff.employment_status = 'active'
		) or (
			v_request.by_user_id is not null and not exists (
				select 1 from public.qorpera_profile_members as member
				where member.profile_id = v_request.profile_id
					and member.user_id = v_request.by_user_id
					and member.role in ('owner', 'admin', 'contributor')
			)
		) then
			raise exception 'coding repository grant is unavailable' using errcode = '42501';
		end if;
	elsif v_request.by_user_id is null or not exists (
		select 1 from public.qorpera_profile_members as member
		where member.profile_id = v_request.profile_id
			and member.user_id = v_request.by_user_id
			and member.role in ('owner', 'admin', 'contributor')
	) then
		raise exception 'coding repository grant is unavailable' using errcode = '42501';
	end if;

	select repo.* into v_repo
	from public.qorpera_code_repositories as repo
	where repo.environment_id = v_request.environment_id
		and repo.owner = v_request.owner
		and repo.name = v_request.name;
	if v_repo.environment_id is null or not (
		(
			v_repo.imported_from ->> 'kind' = 'github'
			and lower(coalesce(v_repo.imported_from ->> 'repository', '')) = v_expected_repo
		)
		or (
			v_request.by_kind = 'agent'
			and exists (
				select 1 from public.qorpera_coding_repository_grants as repo_grant
				where repo_grant.environment_id = v_request.environment_id
					and repo_grant.staff_agent_id = v_request.by_agent_id
					and repo_grant.enabled
					and repo_grant.repository ->> 'host' = 'github.com'
					and lower((repo_grant.repository ->> 'owner') || '/' || (repo_grant.repository ->> 'name')) = v_expected_repo
			)
		)
		or (
			v_request.by_kind <> 'agent'
			and exists (
				select 1 from public.qorpera_surfaces as sf
				where sf.profile_id = v_request.profile_id
					and sf.source_kind = 'code_repo'
					and sf.status = 'active'
					and lower(coalesce(sf.repository_key, '')) = v_expected_repo
			)
		)
	) then
		raise exception 'coding repository is not bound to this GitHub target' using errcode = '42501';
	end if;

	select secret.* into v_secret
	from public.qorpera_cloud_secrets as secret
	where secret.profile_id = v_request.profile_id
		and secret.environment_id = v_request.environment_id
		and secret.owner_kind = 'company'
		and secret.connector_id = 'github'
		and secret.secret_name = 'primary'
		and secret.status = 'active'
		and secret.broker_authority_id = v_authority.id
		and (
			v_request.by_kind <> 'agent'
			or exists (
				select 1 from public.qorpera_cloud_secret_operation_grants as grant_row
				where grant_row.secret_id = secret.id
					and grant_row.profile_id = secret.profile_id
					and grant_row.environment_id = secret.environment_id
					and grant_row.staff_agent_id = v_request.by_agent_id
					and grant_row.status = 'active'
					and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
					and (
						(v_op in ('push', 'create_pr') and grant_row.operation_id = 'create_pull_request')
						or (v_op in ('sync', 'pull') and grant_row.operation_id in ('read_file', 'get_pull_request', 'list_pull_requests', 'list_branches', 'create_pull_request'))
					)
					and exists (
						select 1 from public.qorpera_profile_members as issuer
						where issuer.profile_id = grant_row.profile_id
							and issuer.user_id = grant_row.issued_by_user_id
							and issuer.role in ('owner', 'admin')
					)
			)
		)
	order by secret.updated_at desc, secret.id
	limit 1
	for share of secret;

	if v_secret.id is null then
		raise exception 'company GitHub connection is unavailable to this agent' using errcode = '42501';
	end if;

	select version.* into v_version
	from public.qorpera_cloud_secret_versions as version
	where version.secret_id = v_secret.id and version.version = v_secret.current_version for share;
	if v_version.secret_id is null or v_version.broker_authority_id <> v_authority.id
		or v_version.key_id <> v_authority.key_id then
		raise exception 'cloud secret version is unavailable' using errcode = '42501';
	end if;

	insert into public.qorpera_cloud_secret_audit_events (
		profile_id, environment_id, secret_id, secret_version, event_type, connector_id, coding_worker_id
	) values (
		v_secret.profile_id, v_secret.environment_id, v_secret.id, v_secret.current_version,
		'repository_credential_used', v_secret.connector_id, v_request.id
	);

	return jsonb_build_object(
		'schema', 'qorpera.coding-repository-credential-authorization/v1',
		'companyId', v_secret.profile_id,
		'environmentId', v_secret.environment_id,
		'secretId', v_secret.id,
		'secretVersion', v_secret.current_version,
		'keyId', v_version.key_id,
		'connectorId', v_secret.connector_id,
		'credentialName', 'access_token',
		'encryptedEnvelopeBase64', encode(v_version.encrypted_envelope, 'base64'),
		'envelopeSha256', v_version.envelope_sha256,
		'workerId', v_request.id,
		'repository', p_repository
	);
end $$;

select pg_temp.gh_sync_patch(
	'public.qorpera_authorize_coding_repository_credential(uuid,text,uuid,uuid,text,jsonb)'::regprocedure,
	array[
		$old$	if v_session.worker_id is null or v_session.profile_id <> v_authority.profile_id then
		raise exception 'coding session is unavailable to this broker' using errcode = '42501';
	end if;$old$,
		$new$	if v_session.worker_id is null then
		return public.qorpera_authorize_github_sync_credential(
			p_broker_authority_id, p_broker_capability_sha256, p_worker_id, p_lease_token, p_executor_owner, p_repository
		);
	end if;
	if v_session.profile_id <> v_authority.profile_id then
		raise exception 'coding session is unavailable to this broker' using errcode = '42501';
	end if;$new$
	]
);

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_folder_code_github_sync', 'binding');

revoke all on function
	public.qorpera_surface_external_pr_valid(jsonb),
	public.qorpera_surface_link_track_pr_internal(uuid, uuid, jsonb, text),
	public.qorpera_link_surface_track_pr(uuid, jsonb, text),
	public.qorpera_surface_apply_github_webhook_delivery(public.qorpera_event_deliveries),
	public.qorpera_surface_tracks_from_github_delivery(),
	public.qorpera_folder_code_github_sync(jsonb, jsonb),
	public.qorpera_authorize_github_sync_credential(uuid, text, uuid, uuid, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_link_surface_track_pr(uuid, jsonb, text) to authenticated;
grant execute on function public.qorpera_folder_code_github_sync(jsonb, jsonb) to service_role;

do $$
declare v_changed text;
begin
	select string_agg(p.oid::regprocedure::text, ', ') into v_changed
	from gh_sync_before b
	join pg_proc p on p.oid = b.oid
	where (to_jsonb(p) - 'prosrc') is distinct from b.fields;
	if v_changed is not null then
		raise exception '20260930938000 changed function metadata on: %', v_changed;
	end if;
end $$;

commit;
