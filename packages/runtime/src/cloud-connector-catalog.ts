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
	/** Closed summary of the provider request(s) this operation performs. It is
	 * part of the adapter hash, so a changed request shape is a changed adapter. */
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
	],
};

const GMAIL: CloudConnectorDefinition = {
	id: "gmail",
	displayName: "Gmail",
	destinationOrigin: "https://gmail.googleapis.com",
	credentialName: "refresh_token",
	oauth: {
		provider: "google",
		scopes: [
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.send",
			GOOGLE_EMAIL_SCOPE,
		],
	},
	operations: [
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

/** The adapter hash the SQL catalog pins and the broker checks before unwrapping
 * a credential. It covers everything a compiled adapter promises the catalog:
 * destination, credential placement, closed input schema and request recipe. */
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
				toolNames.has(operation.toolName)
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
