import { createHash } from "node:crypto";
import type { CloudConnectorInputSchema } from "./cloud-secret-tools.ts";

/**
 * Runtime Step 7: the production connector catalog.
 *
 * One definition per connector and per model-facing operation. The same
 * definitions supply the compiled broker adapters (destination, credential
 * placement, request recipe), the governed SQL catalog rows the runtime turns
 * into agent tools (`qorpera_cloud_connector_operations`), and the member web
 * client's display. A changed operation gets a new version; a shipped row is
 * never edited in place. `scripts/generate-cloud-connector-catalog.mjs`
 * renders the SQL rows from this file and `--check` refuses drift.
 */

export const CLOUD_CONNECTOR_CATALOG_VERSION = 1;

export type CloudConnectorId = "github" | "gmail" | "google_drive";
export type CloudConnectorOAuthProvider = "github" | "google";
export type CloudConnectorEffect = "read" | "write";

export interface CloudConnectorOperationDefinition {
	readonly id: string;
	readonly version: number;
	readonly toolName: string;
	readonly description: string;
	readonly effect: CloudConnectorEffect;
	readonly inputSchema: CloudConnectorInputSchema;
	/** Closed summary of the provider request(s) this operation performs. Its
	 * text is part of the adapter hash, so a changed declared request is a
	 * changed adapter; the hash does not cover the handler code itself. */
	readonly recipe: string;
}

export interface CloudConnectorDefinition {
	readonly id: CloudConnectorId;
	readonly displayName: string;
	readonly destinationOrigin: string;
	/** The sealed field the broker hands the adapter. OAuth connectors keep a
	 * refresh token (Google) or the user access token (GitHub); a GitHub
	 * fine-grained personal access token is captured into the same field. */
	readonly credentialName: string;
	readonly oauth: {
		readonly provider: CloudConnectorOAuthProvider;
		readonly scopes: readonly string[];
	};
	readonly operations: readonly CloudConnectorOperationDefinition[];
}

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const GOOGLE_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

const owner = {
	type: "string",
	description: "Repository owner (user or organization login).",
	minLength: 1,
	maxLength: 39,
	pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$",
} as const;
const repository = {
	type: "string",
	description: "Repository name without the owner.",
	minLength: 1,
	maxLength: 100,
	pattern: "^[A-Za-z0-9_.-]{1,100}$",
} as const;
const issueNumber = {
	type: "integer",
	description: "Issue or pull request number.",
	minimum: 1,
	maximum: 999_999_999,
} as const;

const GITHUB: CloudConnectorDefinition = {
	id: "github",
	displayName: "GitHub",
	destinationOrigin: "https://api.github.com",
	credentialName: "access_token",
	oauth: { provider: "github", scopes: ["repo", "read:user", "user:email"] },
	operations: [
		{
			id: "list_repositories",
			version: 1,
			toolName: "github_list_repositories",
			effect: "read",
			description:
				"List repositories the connected GitHub account can reach (own, collaborator and organization repositories), newest activity first. Optional query filters by name or description.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Case-insensitive text to match in the full name or description.",
						maxLength: 200,
					},
					limit: {
						type: "integer",
						description: "Maximum repositories to return (default 20).",
						minimum: 1,
						maximum: 50,
					},
				},
				additionalProperties: false,
			},
			recipe: "GET /user/repos?sort=updated&affiliation=owner,collaborator,organization_member",
		},
		{
			id: "search_issues",
			version: 1,
			toolName: "github_search_issues",
			effect: "read",
			description:
				"Search issues and pull requests with GitHub search syntax, for example 'repo:acme/roadmap is:issue is:open label:bug'. Returns number, title, state, repository and author.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "GitHub issue search query.", minLength: 1, maxLength: 256 },
					limit: { type: "integer", description: "Maximum results (default 20).", minimum: 1, maximum: 50 },
				},
				required: ["query"],
				additionalProperties: false,
			},
			recipe: "GET /search/issues?q=<query>&per_page=<limit>",
		},
		{
			id: "get_issue",
			version: 1,
			toolName: "github_get_issue",
			effect: "read",
			description:
				"Read one issue or pull request conversation: title, body, state, labels, author, and the first comments.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					number: issueNumber,
					comment_limit: {
						type: "integer",
						description: "Comments to include (default 10).",
						minimum: 0,
						maximum: 50,
					},
				},
				required: ["owner", "repository", "number"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/issues/{number}; GET /repos/{owner}/{repo}/issues/{number}/comments",
		},
		{
			id: "create_issue",
			version: 1,
			toolName: "github_create_issue",
			effect: "write",
			description: "Create a new issue in a repository. This is visible to everyone with access to the repository.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					title: { type: "string", description: "Issue title.", minLength: 1, maxLength: 256 },
					body: { type: "string", description: "Issue body in Markdown.", maxLength: 20_000 },
					labels: {
						type: "array",
						description: "Existing label names to apply.",
						items: { type: "string", minLength: 1, maxLength: 50 },
						maxItems: 10,
					},
				},
				required: ["owner", "repository", "title"],
				additionalProperties: false,
			},
			recipe: "POST /repos/{owner}/{repo}/issues",
		},
		{
			id: "create_issue_comment",
			version: 1,
			toolName: "github_comment_on_issue",
			effect: "write",
			description: "Add a comment to an issue or pull request conversation. Notifies its participants.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					number: issueNumber,
					body: { type: "string", description: "Comment body in Markdown.", minLength: 1, maxLength: 20_000 },
				},
				required: ["owner", "repository", "number", "body"],
				additionalProperties: false,
			},
			recipe: "POST /repos/{owner}/{repo}/issues/{number}/comments",
		},
		{
			id: "read_file",
			version: 1,
			toolName: "github_read_file",
			effect: "read",
			description:
				"Read a text file from a repository at a branch, tag or commit (default branch when omitted). Large or binary files return metadata only.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					path: { type: "string", description: "File path inside the repository.", minLength: 1, maxLength: 1024 },
					ref: { type: "string", description: "Branch, tag or commit SHA.", minLength: 1, maxLength: 256 },
				},
				required: ["owner", "repository", "path"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/contents/{path}?ref=<ref>",
		},
		{
			id: "get_pull_request",
			version: 1,
			toolName: "github_get_pull_request",
			effect: "read",
			description:
				"Read one pull request: title, body, state, branches, mergeability, review decision counts and the changed files.",
			inputSchema: {
				type: "object",
				properties: { owner, repository, number: issueNumber },
				required: ["owner", "repository", "number"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/pulls/{number}; GET /repos/{owner}/{repo}/pulls/{number}/files?per_page=50",
		},
		{
			// 3 November 2026: the Co-Founder had to ask the founder to create a repository by hand. Private unless the
			// call says otherwise; a public one is a built-in access check in the automatic review.
			id: "create_repository",
			version: 1,
			toolName: "github_create_repository",
			effect: "write",
			description:
				"Create a new repository in the connected GitHub account, or in an organization that account belongs to (owner). It is private unless private is false; a public repository is visible to everyone on the internet. By default it starts with a README, so it has a default branch. A refusal says when the name is taken or when the GitHub connection must be connected again with permission to create repositories.",
			inputSchema: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Name of the new repository, without the owner: letters, digits, - _ and .",
						minLength: 1,
						maxLength: 100,
						pattern: "^[A-Za-z0-9_.-]{1,100}$",
					},
					owner: {
						...owner,
						description:
							"Organization to create it in. Omit it, or give the connected account's own login, for the connected account itself.",
					},
					description: { type: "string", description: "Short description shown on GitHub.", maxLength: 350 },
					private: {
						type: "boolean",
						description: "Default true. false makes the repository public: anyone on the internet can see it.",
					},
					auto_init: {
						type: "boolean",
						description: "Default true: start with a README. false creates an empty repository.",
					},
				},
				required: ["name"],
				additionalProperties: false,
			},
			recipe: "GET /user (when owner is given); POST /user/repos or POST /orgs/{owner}/repos",
		},
		{
			id: "list_pull_requests",
			version: 1,
			toolName: "github_list_pull_requests",
			effect: "read",
			description:
				"List pull requests in a repository, optionally filtered by state (open, closed, all), head branch, or base branch.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					state: {
						type: "string",
						description: "Filter by pull request state (default open).",
						enum: ["open", "closed", "all"],
					},
					head: {
						type: "string",
						description: "Optional head branch filter in 'owner:branch' or branch form.",
						minLength: 1,
						maxLength: 256,
					},
					base: {
						type: "string",
						description: "Optional base branch name filter.",
						minLength: 1,
						maxLength: 200,
					},
					limit: {
						type: "integer",
						description: "Maximum pull requests to return (default 20).",
						minimum: 1,
						maximum: 50,
					},
				},
				required: ["owner", "repository"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/pulls?state=<state>&head=<head>&base=<base>&per_page=<limit>",
		},
		{
			id: "create_pull_request",
			version: 1,
			toolName: "github_create_pull_request",
			effect: "write",
			description:
				"Open a new pull request in a repository from head branch into base branch. Visible to everyone with access to the repository.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					title: { type: "string", description: "Pull request title.", minLength: 1, maxLength: 256 },
					head: { type: "string", description: "Branch containing the changes.", minLength: 1, maxLength: 256 },
					base: { type: "string", description: "Target branch to merge into.", minLength: 1, maxLength: 200 },
					body: { type: "string", description: "Pull request description in Markdown.", maxLength: 20_000 },
					draft: { type: "boolean", description: "Open as a draft pull request when true." },
				},
				required: ["owner", "repository", "title", "head", "base"],
				additionalProperties: false,
			},
			recipe: "POST /repos/{owner}/{repo}/pulls",
		},
		{
			id: "update_pull_request",
			version: 1,
			toolName: "github_update_pull_request",
			effect: "write",
			description:
				"Update an existing pull request's title, body, base branch, or state (open or closed). Does not merge pull requests.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					number: issueNumber,
					title: { type: "string", description: "Updated pull request title.", minLength: 1, maxLength: 256 },
					body: {
						type: "string",
						description: "Updated pull request description in Markdown.",
						maxLength: 20_000,
					},
					state: {
						type: "string",
						description: "Set pull request state to open or closed.",
						enum: ["open", "closed"],
					},
					base: { type: "string", description: "Updated target base branch.", minLength: 1, maxLength: 200 },
				},
				required: ["owner", "repository", "number"],
				additionalProperties: false,
			},
			recipe: "PATCH /repos/{owner}/{repo}/pulls/{number}",
		},
		{
			id: "list_pull_request_reviews",
			version: 1,
			toolName: "github_list_pull_request_reviews",
			effect: "read",
			description: "List reviews submitted on a pull request: reviewer, state, commit SHA, timestamp, and summary.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					number: issueNumber,
					limit: {
						type: "integer",
						description: "Maximum reviews to return (default 20).",
						minimum: 1,
						maximum: 50,
					},
				},
				required: ["owner", "repository", "number"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=<limit>",
		},
		{
			id: "list_check_runs",
			version: 1,
			toolName: "github_list_check_runs",
			effect: "read",
			description:
				"List CI check runs for a branch, tag, or commit SHA in a repository: name, status, conclusion, and details link.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					ref: { type: "string", description: "Commit SHA, branch name, or tag.", minLength: 1, maxLength: 256 },
					limit: {
						type: "integer",
						description: "Maximum check runs to return (default 30).",
						minimum: 1,
						maximum: 100,
					},
				},
				required: ["owner", "repository", "ref"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs?per_page=<limit>",
		},
		{
			id: "list_branches",
			version: 1,
			toolName: "github_list_branches",
			effect: "read",
			description: "List branches in a repository with each branch's head commit SHA and protection status.",
			inputSchema: {
				type: "object",
				properties: {
					owner,
					repository,
					limit: {
						type: "integer",
						description: "Maximum branches to return (default 30).",
						minimum: 1,
						maximum: 100,
					},
				},
				required: ["owner", "repository"],
				additionalProperties: false,
			},
			recipe: "GET /repos/{owner}/{repo}/branches?per_page=<limit>",
		},
	],
};

const gmailDraftProperties: CloudConnectorInputSchema["properties"] = {
	draft_id: {
		type: "string",
		description: "Stable Gmail draft id returned by create_draft.",
		minLength: 1,
		maxLength: 128,
	},
	to: {
		type: "array",
		description: "Recipient email addresses.",
		items: { type: "string", minLength: 3, maxLength: 254 },
		minItems: 1,
		maxItems: 20,
	},
	cc: {
		type: "array",
		description: "Cc email addresses.",
		items: { type: "string", minLength: 3, maxLength: 254 },
		maxItems: 20,
	},
	subject: { type: "string", description: "Subject line.", minLength: 1, maxLength: 512 },
	body: { type: "string", description: "Complete plain-text body.", minLength: 1, maxLength: 50_000 },
	reply_to_message_id: {
		type: "string",
		description: "Gmail message id being answered, not a draft id.",
		minLength: 1,
		maxLength: 64,
	},
};
const { draft_id: gmailDraftId, ...gmailDraftContentProperties } = gmailDraftProperties;

const GMAIL: CloudConnectorDefinition = {
	id: "gmail",
	displayName: "Gmail",
	destinationOrigin: "https://gmail.googleapis.com",
	credentialName: "refresh_token",
	oauth: {
		provider: "google",
		scopes: [
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.modify",
			"https://www.googleapis.com/auth/gmail.settings.basic",
			"https://www.googleapis.com/auth/gmail.send",
			"https://www.googleapis.com/auth/gmail.compose",
			GOOGLE_EMAIL_SCOPE,
		],
	},
	operations: [
		{
			id: "get_profile",
			version: 1,
			toolName: "gmail_get_profile",
			effect: "read",
			description:
				"Get the connected mailbox email_address. Use this trusted address as from when showing an email draft with ask_member surface draft; never invent the sender.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			recipe: "GET /gmail/v1/users/me/profile",
		},
		{
			id: "create_draft",
			version: 1,
			toolName: "gmail_create_draft",
			effect: "write",
			description:
				"Save an unsent draft in the connected Gmail mailbox. For an email to review in this conversation, use ask_member surface draft instead; its Save to Gmail button persists the draft. Use this operation when the member explicitly requests a Gmail-saved draft. Requires reconnecting older connections to grant draft access. Reuse the same idempotencyKey on retry; never blindly repeat a creation with an uncertain result.",
			inputSchema: {
				type: "object",
				properties: gmailDraftContentProperties,
				required: ["to", "subject", "body"],
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/profile; GET /gmail/v1/users/me/messages/{reply_to_message_id}?format=metadata (when replying); POST /gmail/v1/users/me/drafts with message.raw",
		},
		{
			id: "update_draft",
			version: 1,
			toolName: "gmail_update_draft",
			effect: "write",
			description:
				"Replace the complete content of an existing Gmail draft without sending it. Supply every recipient, subject and body to retain. The stable draft_id is unchanged but message_id changes.",
			inputSchema: {
				type: "object",
				properties: gmailDraftProperties,
				required: ["draft_id", "to", "subject", "body"],
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/profile; GET /gmail/v1/users/me/messages/{reply_to_message_id}?format=metadata (when replying); PUT /gmail/v1/users/me/drafts/{draft_id} with message.raw",
		},
		{
			id: "delete_draft",
			version: 1,
			toolName: "gmail_delete_draft",
			effect: "write",
			description: "Permanently discard an unsent Gmail draft identified by draft_id. Does not send an email.",
			inputSchema: {
				type: "object",
				properties: { draft_id: gmailDraftId },
				required: ["draft_id"],
				additionalProperties: false,
			},
			recipe: "DELETE /gmail/v1/users/me/drafts/{draft_id}",
		},
		{
			id: "send_draft",
			version: 1,
			toolName: "gmail_send_draft",
			effect: "write",
			description:
				"Send an existing Gmail draft with the exact complete content supplied here, atomically replacing its content on send. The email leaves immediately and Gmail removes the draft. A request to draft is not permission to send: present ask_member surface draft for review. Reuse the same idempotencyKey on retry and do not resend an uncertain outcome under another key.",
			inputSchema: {
				type: "object",
				properties: gmailDraftProperties,
				required: ["draft_id", "to", "subject", "body"],
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/profile; GET /gmail/v1/users/me/messages/{reply_to_message_id}?format=metadata (when replying); POST /gmail/v1/users/me/drafts/send with id and message.raw",
		},
		{
			id: "search_messages",
			version: 1,
			toolName: "gmail_search_messages",
			effect: "read",
			description:
				"Search the connected mailbox with Gmail search syntax, for example 'from:anna@example.com newer_than:7d is:unread'. Returns sender, recipients, subject, date and a snippet per message.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Gmail search query. Empty lists the newest messages.",
						maxLength: 512,
					},
					limit: {
						type: "integer",
						description: "Maximum messages to return (default 10).",
						minimum: 1,
						maximum: 25,
					},
				},
				additionalProperties: false,
			},
			recipe: "GET /gmail/v1/users/me/messages?q=<query>; GET /gmail/v1/users/me/messages/{id}?format=metadata",
		},
		{
			id: "read_message",
			version: 1,
			toolName: "gmail_read_message",
			effect: "read",
			description:
				"Read one email: headers, the plain-text body (HTML is reduced to text) and the list of attachments. Attachments are not downloaded.",
			inputSchema: {
				type: "object",
				properties: {
					message_id: {
						type: "string",
						description: "Gmail message id from a search.",
						minLength: 1,
						maxLength: 64,
					},
				},
				required: ["message_id"],
				additionalProperties: false,
			},
			recipe: "GET /gmail/v1/users/me/messages/{id}?format=full",
		},
		{
			id: "read_thread",
			version: 1,
			toolName: "gmail_read_thread",
			effect: "read",
			description:
				"Read a conversation thread: each message's sender, date, subject and a shortened plain-text body.",
			inputSchema: {
				type: "object",
				properties: {
					thread_id: {
						type: "string",
						description: "Gmail thread id from a search.",
						minLength: 1,
						maxLength: 64,
					},
					limit: {
						type: "integer",
						description: "Maximum messages to include (default 10).",
						minimum: 1,
						maximum: 20,
					},
				},
				required: ["thread_id"],
				additionalProperties: false,
			},
			recipe: "GET /gmail/v1/users/me/threads/{id}?format=full",
		},
		{
			id: "send_message",
			version: 1,
			toolName: "gmail_send_message",
			effect: "write",
			description:
				"Send an email from the connected mailbox. Provide reply_to_message_id to answer inside an existing conversation. The email leaves the company immediately.",
			inputSchema: {
				type: "object",
				properties: {
					to: {
						type: "array",
						description: "Recipient email addresses.",
						items: { type: "string", minLength: 3, maxLength: 254 },
						minItems: 1,
						maxItems: 20,
					},
					cc: {
						type: "array",
						description: "Cc email addresses.",
						items: { type: "string", minLength: 3, maxLength: 254 },
						maxItems: 20,
					},
					subject: { type: "string", description: "Subject line.", minLength: 1, maxLength: 512 },
					body: { type: "string", description: "Plain-text body.", minLength: 1, maxLength: 50_000 },
					reply_to_message_id: {
						type: "string",
						description: "Gmail message id being answered; the reply joins that thread.",
						minLength: 1,
						maxLength: 64,
					},
				},
				required: ["to", "subject", "body"],
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/messages/{reply_to_message_id}?format=metadata (when replying); POST /gmail/v1/users/me/messages/send",
		},
		{
			id: "list_messages",
			version: 1,
			toolName: "gmail_list_messages",
			effect: "read",
			description:
				"List or search Gmail messages with pagination and optional label filters (such as INBOX, STARRED, TRASH, SPAM, or UNREAD). Returns sender, recipients, subject, date, labels, is_starred, parsed unsubscribe options, snippet, and next_page_token.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Optional Gmail search query.",
						maxLength: 512,
					},
					label_ids: {
						type: "array",
						description: "Optional Gmail label ids to require, such as ['INBOX'], ['STARRED'], or ['TRASH'].",
						items: { type: "string", minLength: 1, maxLength: 64 },
						maxItems: 10,
					},
					include_spam_trash: {
						type: "boolean",
						description: "Include messages in Spam and Trash (default false).",
					},
					page_token: {
						type: "string",
						description: "next_page_token from an earlier gmail_list_messages call.",
						minLength: 1,
						maxLength: 256,
					},
					limit: {
						type: "integer",
						description: "Maximum messages to return per page (default 25, max 50).",
						minimum: 1,
						maximum: 50,
					},
				},
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/messages?q=<query>&labelIds=<label_ids>&includeSpamTrash=<bool>&pageToken=<page_token>&maxResults=<limit>; GET /gmail/v1/users/me/messages/{id}?format=metadata",
		},
		{
			id: "update_messages",
			version: 1,
			toolName: "gmail_update_messages",
			effect: "write",
			description:
				"Perform reversible inbox actions on up to 50 Gmail messages at once: trash, untrash, archive (remove from Inbox), move_to_inbox, star, unstar, mark_read, mark_unread, or spam. Messages moved to Trash stay recoverable in Gmail Trash for 30 days (permanent deletion is not offered). Requires reconnecting older Gmail connections to grant modify access.",
			inputSchema: {
				type: "object",
				properties: {
					message_ids: {
						type: "array",
						description: "Gmail message ids to update (1 to 50).",
						items: { type: "string", minLength: 1, maxLength: 64 },
						minItems: 1,
						maxItems: 50,
					},
					action: {
						type: "string",
						description: "Reversible action to apply to all listed messages.",
						enum: [
							"trash",
							"untrash",
							"archive",
							"move_to_inbox",
							"star",
							"unstar",
							"mark_read",
							"mark_unread",
							"spam",
						],
					},
				},
				required: ["message_ids", "action"],
				additionalProperties: false,
			},
			recipe:
				"POST /gmail/v1/users/me/messages/{id}/trash or /untrash (for trash/untrash); POST /gmail/v1/users/me/messages/batchModify (for archive/move_to_inbox/star/unstar/mark_read/mark_unread/spam)",
		},
		{
			id: "block_sender",
			version: 1,
			toolName: "gmail_block_sender",
			effect: "write",
			description:
				"Block or unblock an email sender (exact email address or @domain) in Gmail by creating or removing a filter that automatically sends future messages from that sender to Trash and removes them from Inbox. Optionally moves up to 50 existing messages from that sender to Trash (default true). Requires reconnecting older Gmail connections to grant Gmail settings and modify access.",
			inputSchema: {
				type: "object",
				properties: {
					sender: {
						type: "string",
						description: "Email address (news@example.com) or domain (@example.com) to block or unblock.",
						minLength: 3,
						maxLength: 254,
					},
					unblock: {
						type: "boolean",
						description:
							"When true, removes matching Gmail block filters for this sender instead of blocking (default false).",
					},
					trash_existing: {
						type: "boolean",
						description:
							"When blocking, also move up to 50 existing non-trashed messages from this sender to Trash (default true).",
					},
				},
				required: ["sender"],
				additionalProperties: false,
			},
			recipe:
				"GET /gmail/v1/users/me/settings/filters; POST or DELETE /gmail/v1/users/me/settings/filters; GET /gmail/v1/users/me/messages?q=from:<sender> and POST /gmail/v1/users/me/messages/{id}/trash (when trash_existing is not false)",
		},
	],
};

const GOOGLE_DRIVE: CloudConnectorDefinition = {
	id: "google_drive",
	displayName: "Google Drive",
	destinationOrigin: "https://www.googleapis.com",
	credentialName: "refresh_token",
	oauth: {
		provider: "google",
		scopes: ["https://www.googleapis.com/auth/drive", GOOGLE_EMAIL_SCOPE],
	},
	operations: [
		{
			id: "search_files",
			version: 1,
			toolName: "google_drive_search_files",
			effect: "read",
			description:
				"Find files and folders in the connected Google Drive (including shared drives) by name, optionally inside one folder. Returns id, name, type, last modified and a link.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Text the file name must contain. Empty lists recent files.",
						maxLength: 256,
					},
					folder_id: {
						type: "string",
						description: "Only direct children of this folder.",
						minLength: 1,
						maxLength: 128,
					},
					limit: {
						type: "integer",
						description: "Maximum files to return (default 20).",
						minimum: 1,
						maximum: 50,
					},
				},
				additionalProperties: false,
			},
			recipe:
				"GET /drive/v3/files?q=<built query>&fields=files(id,name,mimeType,modifiedTime,size,webViewLink,parents)",
		},
		{
			id: "read_file",
			version: 1,
			toolName: "google_drive_read_file",
			effect: "read",
			description:
				"Read a file's text. Google Docs, Sheets and Slides are exported as plain text or CSV; text files are read directly; other files return metadata only.",
			inputSchema: {
				type: "object",
				properties: {
					file_id: { type: "string", description: "Drive file id from a search.", minLength: 1, maxLength: 128 },
					max_chars: {
						type: "integer",
						description: "Maximum characters of text to return (default 5000).",
						minimum: 200,
						maximum: 20_000,
					},
				},
				required: ["file_id"],
				additionalProperties: false,
			},
			recipe: "GET /drive/v3/files/{id}?fields=...; GET /drive/v3/files/{id}/export?mimeType=... or ?alt=media",
		},
		{
			id: "create_file",
			version: 1,
			toolName: "google_drive_create_file",
			effect: "write",
			description:
				"Create a new file with text content in the connected Google Drive, optionally inside a folder. Use the Google Docs type to create an editable document from the text.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "File name.", minLength: 1, maxLength: 256 },
					content: { type: "string", description: "Text content.", maxLength: 60_000 },
					mime_type: {
						type: "string",
						description: "File type (default text/plain).",
						enum: [
							"text/plain",
							"text/markdown",
							"text/csv",
							"application/json",
							"application/vnd.google-apps.document",
						],
					},
					folder_id: { type: "string", description: "Parent folder id.", minLength: 1, maxLength: 128 },
				},
				required: ["name", "content"],
				additionalProperties: false,
			},
			recipe: "POST /upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
		},
		{
			id: "update_file",
			version: 1,
			toolName: "google_drive_update_file",
			effect: "write",
			description:
				"Replace the content of an existing text file or Google Doc with new text. The previous content is kept in Drive's version history.",
			inputSchema: {
				type: "object",
				properties: {
					file_id: { type: "string", description: "Drive file id.", minLength: 1, maxLength: 128 },
					content: { type: "string", description: "New text content.", maxLength: 60_000 },
				},
				required: ["file_id", "content"],
				additionalProperties: false,
			},
			recipe: "PATCH /upload/drive/v3/files/{id}?uploadType=media&supportsAllDrives=true",
		},
	],
};

export const CLOUD_CONNECTORS: readonly CloudConnectorDefinition[] = Object.freeze([GITHUB, GMAIL, GOOGLE_DRIVE]);

export function cloudConnector(connectorId: string): CloudConnectorDefinition {
	const connector = CLOUD_CONNECTORS.find((item) => item.id === connectorId);
	if (!connector) throw new Error("Cloud connector is unknown");
	return connector;
}

export function cloudConnectorOperation(
	connectorId: string,
	operationId: string,
): { connector: CloudConnectorDefinition; operation: CloudConnectorOperationDefinition } {
	const connector = cloudConnector(connectorId);
	const operation = connector.operations.find((item) => item.id === operationId);
	if (!operation) throw new Error("Cloud connector operation is unknown");
	return { connector, operation };
}

/** Whether a granted operation is one of this build's reads: the catalog's own read at the same version and adapter
 * hash. Anything else, an operation this build does not know included, counts as a write. */
export function cloudConnectorOperationReads(granted: {
	readonly connectorId: string;
	readonly operationId: string;
	readonly operationVersion: number;
	readonly adapterSha256: string;
}): boolean {
	const connector = CLOUD_CONNECTORS.find((item) => item.id === granted.connectorId);
	const operation = connector?.operations.find((item) => item.id === granted.operationId);
	return (
		connector !== undefined &&
		operation !== undefined &&
		operation.effect === "read" &&
		operation.version === granted.operationVersion &&
		cloudConnectorAdapterSha256(connector, operation) === granted.adapterSha256
	);
}

/** The adapter hash the SQL catalog pins and the broker checks before unwrapping
 * a credential. It covers what the catalog declares for the operation:
 * destination, credential placement, closed input schema and the recipe text.
 * It does not hash the handler code; the compiled handlers are pinned only by
 * the broker artifact's own SHA-256. */
export function cloudConnectorAdapterSha256(
	connector: CloudConnectorDefinition,
	operation: CloudConnectorOperationDefinition,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				schema: "qorpera.cloud-connector-adapter/v1",
				catalogVersion: CLOUD_CONNECTOR_CATALOG_VERSION,
				connectorId: connector.id,
				operationId: operation.id,
				operationVersion: operation.version,
				toolName: operation.toolName,
				destinationOrigin: connector.destinationOrigin,
				credentialName: connector.credentialName,
				effect: operation.effect,
				inputSchema: operation.inputSchema,
				recipe: operation.recipe,
			}),
		)
		.digest("hex");
}

export interface CloudConnectorCatalogRow {
	readonly connectorId: string;
	readonly operationId: string;
	readonly version: number;
	readonly toolName: string;
	readonly description: string;
	readonly inputSchema: CloudConnectorInputSchema;
	readonly destinationOrigin: string;
	readonly credentialName: string;
	readonly adapterSha256: string;
}

/** Rows for `public.qorpera_cloud_connector_operations`, in catalog order. */
export function cloudConnectorCatalogRows(): readonly CloudConnectorCatalogRow[] {
	const rows: CloudConnectorCatalogRow[] = [];
	const toolNames = new Set<string>();
	for (const connector of CLOUD_CONNECTORS) {
		if (!IDENTIFIER.test(connector.id) || !IDENTIFIER.test(connector.credentialName))
			throw new Error("Cloud connector definition is invalid");
		if (new URL(connector.destinationOrigin).origin !== connector.destinationOrigin)
			throw new Error("Cloud connector destination is invalid");
		for (const operation of connector.operations) {
			if (
				!IDENTIFIER.test(operation.id) ||
				!TOOL_NAME.test(operation.toolName) ||
				!operation.toolName.startsWith(`${connector.id}_`) ||
				!operation.description.trim() ||
				operation.description.length > 2048 ||
				!Number.isSafeInteger(operation.version) ||
				operation.version < 1 ||
				toolNames.has(operation.toolName) ||
				// A call may send the fields on their own or inside `input` (cloud-secret-tools.ts): no field takes that name.
				Object.hasOwn(operation.inputSchema.properties, "input")
			)
				throw new Error("Cloud connector operation definition is invalid");
			toolNames.add(operation.toolName);
			rows.push({
				connectorId: connector.id,
				operationId: operation.id,
				version: operation.version,
				toolName: operation.toolName,
				description: operation.description,
				inputSchema: operation.inputSchema,
				destinationOrigin: connector.destinationOrigin,
				credentialName: connector.credentialName,
				adapterSha256: cloudConnectorAdapterSha256(connector, operation),
			});
		}
	}
	return Object.freeze(rows);
}
