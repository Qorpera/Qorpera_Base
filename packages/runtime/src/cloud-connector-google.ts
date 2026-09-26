import { createHash } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { type ConnectorOperationContext, defineConnectorAdapters } from "./cloud-connector-adapter.ts";
import { cloudConnector } from "./cloud-connector-catalog.ts";
import {
	ConnectorRequestError,
	clipText,
	connectorRequest,
	decodeBase64Url,
	decodeUtf8,
	encodeBase64Url,
	fitItems,
	htmlToText,
	jsonArray,
	jsonInteger,
	jsonRecord,
	jsonString,
	jsonTextBytes,
	parseJsonResponse,
	providerRefusal,
} from "./cloud-connector-http.ts";
import type { CloudSecretConnectorAdapter } from "./cloud-secret-broker.ts";

/**
 * Compiled Google adapters for Gmail and Google Drive. The sealed credential is
 * an OAuth refresh token; every operation exchanges it for a short-lived access
 * token at Google's token endpoint and never keeps either beyond the call.
 */

export const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";
export const GOOGLE_TOKEN_PATH = "/token";

export interface GoogleOAuthClient {
	readonly clientId: string;
	readonly clientSecret: string;
}

const BODY_CHARS = 4000;
const THREAD_MESSAGE_CHARS = 1200;
const THREAD_BUDGET_CHARS = 5000;
// Byte budgets keep every result under the broker's 32 KiB limit whatever the
// text is made of (multi-byte characters, JSON escapes); see
// CONNECTOR_RESULT_MAX_BYTES.
const BODY_BYTES = 16 * 1024;
const THREAD_MESSAGE_BYTES = 5 * 1024;
const THREAD_BUDGET_BYTES = 18 * 1024;
const LIST_BYTES = 24 * 1024;
const FILE_CONTENT_BYTES = 24 * 1024;
const MAX_MEDIA_BYTES = 1024 * 1024;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const GOOGLE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createGoogleAccessTokenExchange(client: GoogleOAuthClient) {
	if (!client.clientId || !client.clientSecret || /[\s\0]/.test(client.clientId + client.clientSecret))
		throw new Error("Google OAuth client is invalid");
	return async (refreshToken: string, fetchImplementation: typeof fetch, signal: AbortSignal): Promise<string> => {
		if (!/^[A-Za-z0-9_./-]{20,512}$/.test(refreshToken)) throw new Error("Google credential shape is invalid");
		const body = new URLSearchParams({
			client_id: client.clientId,
			client_secret: client.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}).toString();
		const response = await connectorRequest({
			fetch: fetchImplementation,
			origin: GOOGLE_TOKEN_ORIGIN,
			path: GOOGLE_TOKEN_PATH,
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
			maximumBytes: 64 * 1024,
		});
		if (response.status !== 200) {
			const refusal = providerRefusal(response, "Google sign-in");
			throw new ConnectorRequestError(
				response.status === 400 || response.status === 401 ? "authorization_required" : refusal.reason,
				response.status === 400 || response.status === 401
					? "Google no longer accepts this connection. Ask the member to connect the account again."
					: refusal.message,
			);
		}
		const token = jsonString(jsonRecord(parseJsonResponse(response)).access_token, 4096);
		if (!token || !/^[A-Za-z0-9_./-]{20,4096}$/.test(token)) throw new Error("Google access token is invalid");
		return token;
	};
}

async function google(
	context: ConnectorOperationContext,
	path: string,
	options: {
		query?: Record<string, string | readonly string[] | undefined>;
		method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
		body?: Uint8Array | string;
		contentType?: string;
		raw?: boolean;
		maximumBytes?: number;
	} = {},
): Promise<{ json: unknown; bytes: Uint8Array; contentType: string | undefined }> {
	const response = await connectorRequest({
		fetch: context.fetch,
		origin: context.origin,
		path,
		query: options.query,
		method: options.method ?? "GET",
		headers: {
			authorization: `Bearer ${context.bearer}`,
			...(options.contentType ? { "content-type": options.contentType } : {}),
		},
		...(options.body === undefined ? {} : { body: options.body }),
		signal: context.signal,
		maximumBytes: options.maximumBytes,
		keepHeaders: ["content-type"],
	});
	if (response.status < 200 || response.status >= 300) {
		if (response.status === 403) {
			const error = jsonRecord(jsonRecord(parseJsonResponse(response)).error);
			const missingScope =
				jsonArray(error.errors).some((item) => jsonRecord(item).reason === "insufficientPermissions") ||
				jsonArray(error.details).some((item) => jsonRecord(item).reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT");
			if (missingScope)
				throw new ConnectorRequestError(
					"authorization_required",
					"Reconnect this Google account to grant the permissions needed for this operation, including Gmail draft access.",
				);
		}
		throw providerRefusal(response, "Google");
	}
	return {
		json: options.raw ? null : parseJsonResponse(response),
		bytes: response.bytes,
		contentType: response.headers["content-type"],
	};
}

function googleId(value: JsonValue | undefined, label: string): string {
	const id = typeof value === "string" ? value : "";
	if (!GOOGLE_ID.test(id)) throw new ConnectorRequestError("invalid_request", `The ${label} is not valid.`);
	return id;
}

function header(payload: Record<string, unknown>, name: string): string | null {
	for (const item of jsonArray(payload.headers)) {
		const entry = jsonRecord(item);
		if (typeof entry.name === "string" && entry.name.toLowerCase() === name.toLowerCase()) {
			return jsonString(entry.value, 2048);
		}
	}
	return null;
}

interface MailBody {
	text: string;
	attachments: { filename: string | null; mime_type: string | null; size: number | null }[];
}

/** Walks a MIME tree preferring text/plain, reducing HTML when it is the only
 * text, and listing attachments without downloading them. */
function mailBody(payload: Record<string, unknown>): MailBody {
	const plain: string[] = [];
	const html: string[] = [];
	const attachments: MailBody["attachments"] = [];
	const visit = (part: Record<string, unknown>, depth: number): void => {
		if (depth > 8) return;
		const mimeType = jsonString(part.mimeType, 128) ?? "";
		const body = jsonRecord(part.body);
		const filename = jsonString(part.filename, 256);
		if (filename) {
			attachments.push({ filename, mime_type: mimeType || null, size: jsonInteger(body.size) });
		} else if (typeof body.data === "string") {
			let text: string;
			try {
				text = decodeUtf8(decodeBase64Url(body.data));
			} catch {
				text = "";
			}
			if (mimeType === "text/plain") plain.push(text);
			else if (mimeType === "text/html") html.push(text);
		}
		for (const child of jsonArray(part.parts)) visit(jsonRecord(child), depth + 1);
	};
	visit(payload, 0);
	const text = plain.length > 0 ? plain.join("\n") : html.map(htmlToText).join("\n");
	return { text: text.trim(), attachments: attachments.slice(0, 50) };
}

function messageSummary(message: Record<string, unknown>): Record<string, JsonValue> {
	const payload = jsonRecord(message.payload);
	return {
		message_id: jsonString(message.id, 64),
		thread_id: jsonString(message.threadId, 64),
		from: header(payload, "From"),
		to: header(payload, "To"),
		cc: header(payload, "Cc"),
		subject: header(payload, "Subject"),
		date: header(payload, "Date"),
		labels: jsonArray(message.labelIds)
			.map((label) => jsonString(label, 64))
			.filter((label): label is string => label !== null)
			.slice(0, 20),
		snippet: jsonString(message.snippet, 300),
	};
}

function addressList(value: JsonValue | undefined, label: string): string[] {
	const list = jsonArray(value).map((item) => (typeof item === "string" ? item.trim() : ""));
	if (list.some((address) => !EMAIL.test(address) || /[\r\n,;]/.test(address))) {
		throw new ConnectorRequestError("invalid_request", `One of the ${label} addresses is not a valid email address.`);
	}
	return list;
}

function headerValue(value: string): string {
	if (/[\x00-\x1f\x7f]/.test(value))
		throw new ConnectorRequestError("invalid_request", "Header lines cannot contain control characters.");
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	// RFC 2047 encoded words may contain at most 75 characters. Split at a
	// Unicode code point boundary and fold with whitespace between words.
	const words: string[] = [];
	let chunk = "";
	for (const character of value) {
		if (Buffer.byteLength(chunk + character, "utf8") > 45) {
			words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
			chunk = "";
		}
		chunk += character;
	}
	if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
	return words.join("\r\n ");
}

async function gmailProfile(context: ConnectorOperationContext): Promise<string> {
	const profile = jsonRecord((await google(context, "/gmail/v1/users/me/profile")).json);
	const address = profile.emailAddress;
	if (typeof address !== "string" || address.length > 254 || !EMAIL.test(address) || /[\r\n,;]/.test(address))
		throw new ConnectorRequestError("provider_error", "Gmail did not return a valid mailbox address.");
	return address;
}

/** Draft MIME always derives From from the authenticated mailbox. Never accept
 * model-authored From headers or raw MIME. Gmail send supports this exact same
 * replacement message in a single request, so edits cannot race a second call. */
async function gmailDraftMessage(
	args: Record<string, JsonValue>,
	context: ConnectorOperationContext,
): Promise<Record<string, JsonValue>> {
	const to = addressList(args.to, "recipient");
	const cc = args.cc === undefined ? [] : addressList(args.cc, "cc");
	const subject = headerValue(String(args.subject));
	const from = await gmailProfile(context);
	const lines = [
		`From: ${from}`,
		`To: ${to.join(", ")}`,
		...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
	];
	let threadId: string | undefined;
	if (typeof args.reply_to_message_id === "string") {
		const id = googleId(args.reply_to_message_id, "message id");
		const original = jsonRecord(
			(
				await google(context, `/gmail/v1/users/me/messages/${id}`, {
					query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] },
				})
			).json,
		);
		const payload = jsonRecord(original.payload);
		const messageId = header(payload, "Message-ID");
		threadId = jsonString(original.threadId, 64) ?? undefined;
		if (messageId) {
			lines.push(`In-Reply-To: ${headerValue(messageId)}`);
			const references = header(payload, "References");
			lines.push(`References: ${headerValue(references ? `${references} ${messageId}` : messageId)}`);
		}
	}
	const encodedBody =
		Buffer.from(String(args.body), "utf8")
			.toString("base64")
			.match(/.{1,76}/g)
			?.join("\r\n") ?? "";
	return { raw: encodeBase64Url(`${lines.join("\r\n")}\r\n\r\n${encodedBody}`), ...(threadId ? { threadId } : {}) };
}

function gmailDraftReceipt(value: unknown): Record<string, JsonValue> {
	const draft = jsonRecord(value);
	const message = jsonRecord(draft.message);
	if (typeof draft.id !== "string" || !GOOGLE_ID.test(draft.id))
		throw new ConnectorRequestError(
			"provider_error",
			"Gmail did not confirm the saved draft. Check Gmail before creating another draft.",
		);
	return { draft_id: draft.id, message_id: jsonString(message.id, 64), thread_id: jsonString(message.threadId, 64) };
}

export function createGmailConnectorAdapters(options: {
	fetch?: typeof fetch;
	client: GoogleOAuthClient;
}): readonly CloudSecretConnectorAdapter[] {
	const fetchImplementation = options.fetch ?? fetch;
	const messages = "/gmail/v1/users/me/messages";
	const drafts = "/gmail/v1/users/me/drafts";
	return defineConnectorAdapters(cloudConnector("gmail"), {
		fetch: fetchImplementation,
		exchange: createGoogleAccessTokenExchange(options.client),
		handlers: {
			async get_profile(_args, context) {
				return { email_address: await gmailProfile(context) };
			},
			async create_draft(args, context) {
				const message = await gmailDraftMessage(args, context);
				return gmailDraftReceipt(
					(
						await google(context, drafts, {
							method: "POST",
							contentType: "application/json",
							body: JSON.stringify({ message }),
						})
					).json,
				);
			},
			async update_draft(args, context) {
				const id = googleId(args.draft_id, "draft id");
				const message = await gmailDraftMessage(args, context);
				return gmailDraftReceipt(
					(
						await google(context, `${drafts}/${id}`, {
							method: "PUT",
							contentType: "application/json",
							body: JSON.stringify({ id, message }),
						})
					).json,
				);
			},
			async delete_draft(args, context) {
				const id = googleId(args.draft_id, "draft id");
				await google(context, `${drafts}/${id}`, { method: "DELETE" });
				return { draft_id: id, deleted: true };
			},
			async send_draft(args, context) {
				const id = googleId(args.draft_id, "draft id");
				const message = await gmailDraftMessage(args, context);
				const sent = jsonRecord(
					(
						await google(context, `${drafts}/send`, {
							method: "POST",
							contentType: "application/json",
							body: JSON.stringify({ id, message }),
						})
					).json,
				);
				if (typeof sent.id !== "string" || !GOOGLE_ID.test(sent.id))
					throw new ConnectorRequestError(
						"provider_error",
						"Gmail did not confirm the send. Check Sent mail before attempting another send.",
					);
				return {
					message_id: sent.id,
					thread_id: jsonString(sent.threadId, 64),
					recipients: jsonArray(args.to).length + jsonArray(args.cc).length,
				};
			},
			async search_messages(args, context) {
				const limit = jsonInteger(args.limit) ?? 10;
				const listing = jsonRecord(
					(
						await google(context, messages, {
							query: { q: jsonString(args.query, 512) ?? undefined, maxResults: String(limit) },
						})
					).json,
				);
				let results: JsonValue[] = [];
				for (const item of jsonArray(listing.messages).slice(0, limit)) {
					const id = jsonString(jsonRecord(item).id, 64);
					if (!id || !GOOGLE_ID.test(id)) continue;
					const message = jsonRecord(
						(
							await google(context, `${messages}/${id}`, {
								query: { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] },
							})
						).json,
					);
					results.push(messageSummary(message));
				}
				const fitted = fitItems(results, LIST_BYTES);
				results = fitted.items;
				return {
					messages: results,
					estimated_total: jsonInteger(listing.resultSizeEstimate),
					more: typeof listing.nextPageToken === "string" || fitted.omitted > 0,
					...(fitted.omitted > 0 ? { messages_omitted: fitted.omitted } : {}),
				};
			},
			async read_message(args, context) {
				const id = googleId(args.message_id, "message id");
				const message = jsonRecord(
					(await google(context, `${messages}/${id}`, { query: { format: "full" } })).json,
				);
				const body = mailBody(jsonRecord(message.payload));
				const text = clipText(body.text, BODY_CHARS, BODY_BYTES);
				return {
					...messageSummary(message),
					body: text.text,
					body_truncated: text.truncated,
					attachments: body.attachments,
				};
			},
			async read_thread(args, context) {
				const id = googleId(args.thread_id, "thread id");
				const limit = jsonInteger(args.limit) ?? 10;
				const thread = jsonRecord(
					(await google(context, `/gmail/v1/users/me/threads/${id}`, { query: { format: "full" } })).json,
				);
				const all = jsonArray(thread.messages);
				// Newest messages first within one shared text budget; older ones are
				// counted but omitted so the result stays within the tool-result size.
				let budget = THREAD_BUDGET_CHARS;
				let byteBudget = THREAD_BUDGET_BYTES;
				const included: JsonValue[] = [];
				for (const item of all.slice(-limit).reverse()) {
					if (budget <= 0 || byteBudget <= 0) break;
					const message = jsonRecord(item);
					const text = clipText(
						mailBody(jsonRecord(message.payload)).text,
						Math.min(THREAD_MESSAGE_CHARS, budget),
						Math.min(THREAD_MESSAGE_BYTES, byteBudget),
					);
					budget -= [...text.text].length;
					byteBudget -= jsonTextBytes(text.text);
					const summary = messageSummary(message);
					included.push({
						message_id: summary.message_id,
						from: summary.from,
						date: summary.date,
						subject: summary.subject,
						body: text.text,
						body_truncated: text.truncated,
					});
				}
				included.reverse();
				return {
					thread_id: jsonString(thread.id, 64),
					message_count: all.length,
					messages: included,
					messages_omitted: all.length - included.length,
				};
			},
			async send_message(args, context) {
				const to = addressList(args.to, "recipient");
				const cc = args.cc === undefined ? [] : addressList(args.cc, "cc");
				const subject = String(args.subject);
				const body = String(args.body);
				let threadId: string | undefined;
				const lines = [
					`To: ${to.join(", ")}`,
					...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
					`Subject: ${headerValue(subject)}`,
					"MIME-Version: 1.0",
					"Content-Type: text/plain; charset=UTF-8",
					"Content-Transfer-Encoding: base64",
				];
				if (typeof args.reply_to_message_id === "string") {
					const id = googleId(args.reply_to_message_id, "message id");
					const original = jsonRecord(
						(
							await google(context, `${messages}/${id}`, {
								query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] },
							})
						).json,
					);
					const payload = jsonRecord(original.payload);
					const messageId = header(payload, "Message-ID");
					threadId = jsonString(original.threadId, 64) ?? undefined;
					if (messageId) {
						lines.push(`In-Reply-To: ${headerValue(messageId)}`);
						const references = header(payload, "References");
						lines.push(`References: ${headerValue(references ? `${references} ${messageId}` : messageId)}`);
					}
				}
				const raw = `${lines.join("\r\n")}\r\n\r\n${Buffer.from(body, "utf8").toString("base64")}`;
				const sent = jsonRecord(
					(
						await google(context, `${messages}/send`, {
							method: "POST",
							contentType: "application/json",
							body: JSON.stringify({ raw: encodeBase64Url(raw), ...(threadId ? { threadId } : {}) }),
						})
					).json,
				);
				return {
					message_id: jsonString(sent.id, 64),
					thread_id: jsonString(sent.threadId, 64),
					recipients: to.length + cc.length,
				};
			},
		},
	});
}

const EXPORTS: Readonly<Record<string, { mimeType: string; extension: string }>> = {
	"application/vnd.google-apps.document": { mimeType: "text/plain", extension: "txt" },
	"application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", extension: "csv" },
	"application/vnd.google-apps.presentation": { mimeType: "text/plain", extension: "txt" },
};
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|csv))/;
const CREATE_MIME_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
	"application/vnd.google-apps.document",
]);

/** A multipart boundary of at most 70 characters (RFC 2046), derived from the
 * operation's idempotency key (up to 128 characters), so one operation always
 * builds the same request. If a part happens to contain it, the next derivation
 * is used; each occurrence costs a part 56 characters, so the loop ends. */
function multipartBoundary(idempotencyKey: string, parts: readonly string[]): string {
	for (let attempt = 0; ; attempt += 1) {
		const digest = createHash("sha256").update(`${idempotencyKey}\n${attempt}`).digest("hex");
		const boundary = `qorpera-${digest.slice(0, 48)}`;
		if (!parts.some((part) => part.includes(boundary))) return boundary;
	}
}

function driveQuery(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function fileSummary(file: Record<string, unknown>): Record<string, JsonValue> {
	return {
		file_id: jsonString(file.id, 128),
		name: jsonString(file.name, 256),
		mime_type: jsonString(file.mimeType, 128),
		is_folder: file.mimeType === "application/vnd.google-apps.folder",
		size: jsonInteger(typeof file.size === "string" ? Number(file.size) : file.size),
		modified_at: jsonString(file.modifiedTime, 40),
		url: jsonString(file.webViewLink, 512),
		parents: jsonArray(file.parents)
			.map((parent) => jsonString(parent, 128))
			.filter((parent): parent is string => parent !== null)
			.slice(0, 5),
	};
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,parents";

export function createGoogleDriveConnectorAdapters(options: {
	fetch?: typeof fetch;
	client: GoogleOAuthClient;
}): readonly CloudSecretConnectorAdapter[] {
	const fetchImplementation = options.fetch ?? fetch;
	const shared = { supportsAllDrives: "true" };
	return defineConnectorAdapters(cloudConnector("google_drive"), {
		fetch: fetchImplementation,
		exchange: createGoogleAccessTokenExchange(options.client),
		handlers: {
			async search_files(args, context) {
				const terms = ["trashed = false"];
				const query = jsonString(args.query, 256)?.trim();
				if (query) terms.push(`name contains '${driveQuery(query)}'`);
				if (typeof args.folder_id === "string") terms.push(`'${googleId(args.folder_id, "folder id")}' in parents`);
				const listing = jsonRecord(
					(
						await google(context, "/drive/v3/files", {
							query: {
								q: terms.join(" and "),
								fields: `nextPageToken,files(${FILE_FIELDS})`,
								pageSize: String(jsonInteger(args.limit) ?? 20),
								orderBy: "modifiedTime desc",
								includeItemsFromAllDrives: "true",
								corpora: "allDrives",
								...shared,
							},
						})
					).json,
				);
				const fitted = fitItems(
					jsonArray(listing.files).map((item) => fileSummary(jsonRecord(item))),
					LIST_BYTES,
				);
				return {
					files: fitted.items,
					more: typeof listing.nextPageToken === "string" || fitted.omitted > 0,
					...(fitted.omitted > 0 ? { files_omitted: fitted.omitted } : {}),
				};
			},
			async read_file(args, context) {
				const id = googleId(args.file_id, "file id");
				const maxChars = jsonInteger(args.max_chars) ?? 5000;
				const file = jsonRecord(
					(await google(context, `/drive/v3/files/${id}`, { query: { fields: FILE_FIELDS, ...shared } })).json,
				);
				const summary = fileSummary(file);
				const mimeType = jsonString(file.mimeType, 128) ?? "";
				const exported = EXPORTS[mimeType];
				let bytes: Uint8Array | undefined;
				if (exported) {
					bytes = (
						await google(context, `/drive/v3/files/${id}/export`, {
							query: { mimeType: exported.mimeType },
							raw: true,
							maximumBytes: MAX_MEDIA_BYTES,
						})
					).bytes;
				} else if (TEXT_MIME.test(mimeType)) {
					const size = jsonInteger(summary.size) ?? 0;
					if (size > MAX_MEDIA_BYTES) return { ...summary, content: null, content_omitted: "too_large" };
					bytes = (
						await google(context, `/drive/v3/files/${id}`, {
							query: { alt: "media", ...shared },
							raw: true,
							maximumBytes: MAX_MEDIA_BYTES,
						})
					).bytes;
				} else {
					return { ...summary, content: null, content_omitted: "not_a_text_file" };
				}
				let text: string;
				try {
					text = decodeUtf8(bytes);
				} catch {
					return { ...summary, content: null, content_omitted: "binary" };
				}
				const clipped = clipText(text, maxChars, FILE_CONTENT_BYTES);
				return {
					...summary,
					content: clipped.text,
					content_truncated: clipped.truncated,
					content_format: exported?.mimeType ?? mimeType,
				};
			},
			async create_file(args, context) {
				const mimeType = typeof args.mime_type === "string" ? args.mime_type : "text/plain";
				if (!CREATE_MIME_TYPES.has(mimeType))
					throw new ConnectorRequestError("invalid_request", "Unsupported file type.");
				const metadata: Record<string, JsonValue> = { name: String(args.name), mimeType };
				if (typeof args.folder_id === "string") metadata.parents = [googleId(args.folder_id, "folder id")];
				const contentType = mimeType === "application/vnd.google-apps.document" ? "text/plain" : mimeType;
				const metadataJson = JSON.stringify(metadata);
				const content = String(args.content);
				const boundary = multipartBoundary(context.idempotencyKey, [metadataJson, content]);
				const body = [
					`--${boundary}`,
					"Content-Type: application/json; charset=UTF-8",
					"",
					metadataJson,
					`--${boundary}`,
					`Content-Type: ${contentType}; charset=UTF-8`,
					"",
					content,
					`--${boundary}--`,
					"",
				].join("\r\n");
				const created = jsonRecord(
					(
						await google(context, "/upload/drive/v3/files", {
							method: "POST",
							query: { uploadType: "multipart", fields: FILE_FIELDS, ...shared },
							contentType: `multipart/related; boundary=${boundary}`,
							body,
						})
					).json,
				);
				return fileSummary(created);
			},
			async update_file(args, context) {
				const id = googleId(args.file_id, "file id");
				const updated = jsonRecord(
					(
						await google(context, `/upload/drive/v3/files/${id}`, {
							method: "PATCH",
							query: { uploadType: "media", fields: FILE_FIELDS, ...shared },
							contentType: "text/plain; charset=UTF-8",
							body: String(args.content),
						})
					).json,
				);
				return fileSummary(updated);
			},
		},
	});
}
