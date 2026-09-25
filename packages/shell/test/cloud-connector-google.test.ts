import { randomBytes } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	createGmailConnectorAdapters,
	createGoogleDriveConnectorAdapters,
	GOOGLE_TOKEN_ORIGIN,
} from "@qorpera/runtime/cloud-connector-google";
import { clipText, connectorOutcome } from "@qorpera/runtime/cloud-connector-http";
import type { CloudSecretConnectorAdapter } from "@qorpera/runtime/cloud-secret-broker";
import { expect, it, vi } from "vitest";

const refreshToken = `1//${randomBytes(24).toString("base64url")}`;
const accessToken = `ya29.${randomBytes(24).toString("base64url")}`;
const client = {
	clientId: "client.apps.googleusercontent.com",
	clientSecret: `GOCSPX-${randomBytes(12).toString("hex")}`,
};

function input(args: JsonValue, destinationOrigin: string, overrides: Record<string, unknown> = {}) {
	return {
		arguments: args,
		credentials: { refresh_token: refreshToken },
		credentialName: "refresh_token",
		destinationOrigin,
		idempotencyKey: "op-1",
		signal: new AbortController().signal,
		...overrides,
	} as Parameters<CloudSecretConnectorAdapter["execute"]>[0];
}

/** A fake Google: the token endpoint exchanges the refresh token, every API
 * request must carry the access token it issued. */
function google(routes: Record<string, (url: URL, init?: RequestInit) => Response>) {
	const tokenCalls: string[] = [];
	const fetchImplementation = vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		expect(init?.redirect).toBe("error");
		if (url.origin === GOOGLE_TOKEN_ORIGIN) {
			expect(url.pathname).toBe("/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("client_id")).toBe(client.clientId);
			expect(body.get("client_secret")).toBe(client.clientSecret);
			tokenCalls.push(body.get("refresh_token") ?? "");
			return Response.json({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
		}
		expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${accessToken}`);
		const route = routes[`${init?.method ?? "GET"} ${url.origin}${url.pathname}`];
		if (!route) return Response.json({ error: { code: 404, message: "Not found" } }, { status: 404 });
		return route(url, init);
	});
	return { fetchImplementation, tokenCalls };
}

function gmail(operationId: string, fetchImplementation: typeof fetch): CloudSecretConnectorAdapter {
	const found = createGmailConnectorAdapters({ fetch: fetchImplementation, client }).find(
		(item) => item.operationId === operationId,
	);
	if (!found) throw new Error(operationId);
	return found;
}

function drive(operationId: string, fetchImplementation: typeof fetch): CloudSecretConnectorAdapter {
	const found = createGoogleDriveConnectorAdapters({ fetch: fetchImplementation, client }).find(
		(item) => item.operationId === operationId,
	);
	if (!found) throw new Error(operationId);
	return found;
}

const GMAIL = "https://gmail.googleapis.com";
const DRIVE = "https://www.googleapis.com";

function message(id: string, subject: string, bodyText: string, html?: string) {
	return {
		id,
		threadId: `t-${id}`,
		snippet: bodyText.slice(0, 20),
		labelIds: ["INBOX"],
		payload: {
			mimeType: "multipart/alternative",
			headers: [
				{ name: "From", value: "Anna <anna@example.com>" },
				{ name: "To", value: "team@example.com" },
				{ name: "Subject", value: subject },
				{ name: "Date", value: "Mon, 22 Sep 2026 09:00:00 +0200" },
				{ name: "Message-ID", value: `<${id}@mail.example.com>` },
			],
			parts: [
				...(html ? [] : [{ mimeType: "text/plain", body: { data: Buffer.from(bodyText).toString("base64url") } }]),
				...(html ? [{ mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } }] : []),
				{ mimeType: "application/pdf", filename: "offer.pdf", body: { size: 12345, attachmentId: "att" } },
			],
		},
	};
}

it("exchanges the refresh token per call and searches then summarises messages", async () => {
	const { fetchImplementation, tokenCalls } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/messages`]: (url) => {
			expect(url.searchParams.get("q")).toBe("from:anna");
			expect(url.searchParams.get("maxResults")).toBe("2");
			return Response.json({ messages: [{ id: "m1" }, { id: "m2" }], resultSizeEstimate: 2 });
		},
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m1`]: (url) => {
			expect(url.searchParams.get("format")).toBe("metadata");
			return Response.json(message("m1", "Offer", "Hello"));
		},
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m2`]: () => Response.json(message("m2", "Re: Offer", "Hi")),
	});
	const result = await gmail("search_messages", fetchImplementation).execute(
		input({ query: "from:anna", limit: 2 }, GMAIL),
	);
	expect(result).toMatchObject({
		status: "completed",
		result: {
			messages: [
				{ message_id: "m1", thread_id: "t-m1", from: "Anna <anna@example.com>", subject: "Offer" },
				{ message_id: "m2", subject: "Re: Offer" },
			],
			more: false,
		},
	});
	expect(tokenCalls).toEqual([refreshToken]);
	expect(JSON.stringify(result)).not.toContain(refreshToken);
	expect(JSON.stringify(result)).not.toContain(accessToken);
});

it("reads a message preferring plain text, reducing HTML otherwise, and lists attachments", async () => {
	const { fetchImplementation } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m1`]: () =>
			Response.json(
				message("m1", "Offer", "", "<html><body><p>Hello &amp; welcome</p><br><b>Team</b></body></html>"),
			),
	});
	await expect(
		gmail("read_message", fetchImplementation).execute(input({ message_id: "m1" }, GMAIL)),
	).resolves.toMatchObject({
		result: {
			subject: "Offer",
			body: "Hello & welcome\n\nTeam",
			attachments: [{ filename: "offer.pdf", mime_type: "application/pdf", size: 12345 }],
		},
	});
});

it("sends a reply inside the original thread as an RFC 822 message", async () => {
	let sent: Record<string, unknown> | undefined;
	const { fetchImplementation } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m1`]: () => Response.json(message("m1", "Offer", "Hello")),
		[`POST ${GMAIL}/gmail/v1/users/me/messages/send`]: (_url, init) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ id: "m9", threadId: "t-m1" });
		},
	});
	await expect(
		gmail("send_message", fetchImplementation).execute(
			input(
				{
					to: ["anna@example.com"],
					cc: ["bo@example.com"],
					subject: "Re: Offer ✓",
					body: "Tak!",
					reply_to_message_id: "m1",
				},
				GMAIL,
			),
		),
	).resolves.toMatchObject({ status: "completed", result: { message_id: "m9", thread_id: "t-m1", recipients: 2 } });
	expect(sent?.threadId).toBe("t-m1");
	const raw = Buffer.from(String(sent?.raw), "base64url").toString("utf8");
	expect(raw).toContain("To: anna@example.com\r\n");
	expect(raw).toContain("Cc: bo@example.com\r\n");
	expect(raw).toContain("In-Reply-To: <m1@mail.example.com>\r\n");
	expect(raw).toContain("Subject: =?UTF-8?B?");
	expect(Buffer.from(raw.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8")).toBe("Tak!");
});

it("refuses header injection in recipients before any Gmail request", async () => {
	const { fetchImplementation } = google({});
	await expect(
		gmail("send_message", fetchImplementation).execute(
			input({ to: ["anna@example.com\r\nBcc: evil@example.com"], subject: "x", body: "y" }, GMAIL),
		),
	).resolves.toMatchObject({ status: "failed", reason: "invalid_request" });
	// Only the token exchange ran; the mailbox was never touched.
	expect(fetchImplementation.mock.calls.map(([target]) => new URL(String(target)).origin)).toEqual([
		GOOGLE_TOKEN_ORIGIN,
	]);
});

it("reports a revoked Google connection as authorization_required", async () => {
	const fetchImplementation = vi.fn<typeof fetch>(async () =>
		Response.json(
			{ error: "invalid_grant", error_description: "Token has been expired or revoked." },
			{ status: 400 },
		),
	);
	await expect(
		gmail("read_message", fetchImplementation).execute(input({ message_id: "m1" }, GMAIL)),
	).resolves.toMatchObject({
		status: "failed",
		reason: "authorization_required",
	});
});

it("creates and replaces unsent Gmail drafts with the authenticated sender and Unicode MIME", async () => {
	const requests: { method: string; message: { raw: string; threadId?: string } }[] = [];
	const { fetchImplementation } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/profile`]: () => Response.json({ emailAddress: "sender@example.com" }),
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m1`]: () => Response.json(message("m1", "Offer", "Hello")),
		[`POST ${GMAIL}/gmail/v1/users/me/drafts`]: (_url, init) => {
			requests.push({ method: "POST", ...JSON.parse(String(init?.body)) });
			return Response.json({ id: "r-draft1", message: { id: "m-draft1", threadId: "t-m1" } });
		},
		[`PUT ${GMAIL}/gmail/v1/users/me/drafts/r-draft1`]: (_url, init) => {
			requests.push({ method: "PUT", ...JSON.parse(String(init?.body)) });
			return Response.json({ id: "r-draft1", message: { id: "m-draft2", threadId: "t-m1" } });
		},
	});
	const args = {
		to: ["anna@example.com"],
		cc: ["bo@example.com"],
		subject: "Møde fredag æøå ".repeat(10),
		body: "Hej æøå!\n".repeat(30),
		reply_to_message_id: "m1",
	};
	await expect(gmail("get_profile", fetchImplementation).execute(input({}, GMAIL))).resolves.toMatchObject({
		result: { email_address: "sender@example.com" },
	});
	await expect(gmail("create_draft", fetchImplementation).execute(input(args, GMAIL))).resolves.toMatchObject({
		status: "completed",
		result: { draft_id: "r-draft1", message_id: "m-draft1" },
	});
	await expect(
		gmail("update_draft", fetchImplementation).execute(
			input({ ...args, draft_id: "r-draft1", body: "Edited" }, GMAIL),
		),
	).resolves.toMatchObject({ status: "completed", result: { draft_id: "r-draft1", message_id: "m-draft2" } });
	expect(requests.map((request) => request.method)).toEqual(["POST", "PUT"]);
	const raw = Buffer.from(requests[0]!.message.raw, "base64url").toString("utf8");
	expect(raw).toContain("From: sender@example.com\r\n");
	expect(raw).toContain("To: anna@example.com\r\nCc: bo@example.com\r\n");
	expect(raw).toContain("In-Reply-To: <m1@mail.example.com>\r\n");
	expect(raw).toContain("References: <m1@mail.example.com>\r\n");
	const subjectWords = raw.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
	expect(subjectWords.length).toBeGreaterThan(1);
	expect(subjectWords.every((word) => word.length <= 75)).toBe(true);
	expect(subjectWords.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("")).toBe(
		args.subject,
	);
	expect(requests[0]!.message.threadId).toBe("t-m1");
	const encoded = raw.split("\r\n\r\n")[1]!;
	expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true);
	expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(args.body);
	expect(
		Buffer.from(
			Buffer.from(requests[1]!.message.raw, "base64url").toString("utf8").split("\r\n\r\n")[1]!,
			"base64",
		).toString("utf8"),
	).toBe("Edited");
	expect(fetchImplementation.mock.calls.some(([target]) => String(target).includes("/send"))).toBe(false);
});

it("sends the exact edited draft in one provider mutation and discards without sending", async () => {
	let sent: { id: string; message: { raw: string } } | undefined;
	const { fetchImplementation } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/profile`]: () => Response.json({ emailAddress: "sender@example.com" }),
		[`POST ${GMAIL}/gmail/v1/users/me/drafts/send`]: (_url, init) => {
			sent = JSON.parse(String(init?.body));
			return Response.json({ id: "sent1", threadId: "t1" });
		},
		[`DELETE ${GMAIL}/gmail/v1/users/me/drafts/discard1`]: () => new Response(null, { status: 204 }),
	});
	await expect(
		gmail("send_draft", fetchImplementation).execute(
			input({ draft_id: "draft1", to: ["new@example.com"], subject: "Changed", body: "Only this version" }, GMAIL),
		),
	).resolves.toMatchObject({ status: "completed", result: { message_id: "sent1", thread_id: "t1", recipients: 1 } });
	expect(sent?.id).toBe("draft1");
	const raw = Buffer.from(sent!.message.raw, "base64url").toString("utf8");
	expect(raw).toContain("To: new@example.com\r\nSubject: Changed\r\n");
	expect(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe("Only this version");
	await expect(
		gmail("delete_draft", fetchImplementation).execute(input({ draft_id: "discard1" }, GMAIL)),
	).resolves.toMatchObject({ status: "completed", result: { draft_id: "discard1", deleted: true } });
	expect(
		fetchImplementation.mock.calls
			.filter(([target, init]) => new URL(String(target)).origin === GMAIL && init?.method !== "GET")
			.map(([, init]) => init?.method),
	).toEqual(["POST", "DELETE"]);
});

it("asks older Gmail connections to reconnect only for an actual missing scope", async () => {
	const { fetchImplementation } = google({
		[`GET ${GMAIL}/gmail/v1/users/me/profile`]: () => Response.json({ emailAddress: "sender@example.com" }),
		[`POST ${GMAIL}/gmail/v1/users/me/drafts`]: () =>
			Response.json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 }),
		[`DELETE ${GMAIL}/gmail/v1/users/me/drafts/forbidden`]: () =>
			Response.json({ error: { errors: [{ reason: "domainPolicy" }] } }, { status: 403 }),
	});
	await expect(
		gmail("create_draft", fetchImplementation).execute(
			input({ to: ["a@example.com"], subject: "x", body: "y" }, GMAIL),
		),
	).resolves.toMatchObject({
		status: "failed",
		reason: "authorization_required",
		detail: expect.stringContaining("Reconnect"),
	});
	await expect(
		gmail("delete_draft", fetchImplementation).execute(input({ draft_id: "forbidden" }, GMAIL)),
	).resolves.toMatchObject({ status: "failed", reason: "forbidden" });
});

it("refuses draft header injection and invalid ids without mutating Gmail", async () => {
	const { fetchImplementation } = google({});
	for (const args of [
		{ to: ["a@example.com\r\nBcc: evil@example.com"], subject: "x", body: "y" },
		{ to: ["a@example.com"], subject: "x\r\nBcc: evil@example.com", body: "y" },
	])
		await expect(gmail("create_draft", fetchImplementation).execute(input(args, GMAIL))).resolves.toMatchObject({
			status: "failed",
			reason: "invalid_request",
		});
	await expect(
		gmail("delete_draft", fetchImplementation).execute(input({ draft_id: "../send" }, GMAIL)),
	).resolves.toMatchObject({ status: "failed", reason: "invalid_request" });
	expect(
		fetchImplementation.mock.calls.every(([target]) => new URL(String(target)).origin === GOOGLE_TOKEN_ORIGIN),
	).toBe(true);
});

it("searches Drive with an escaped query and exports Google Docs as text", async () => {
	const { fetchImplementation } = google({
		[`GET ${DRIVE}/drive/v3/files`]: (url) => {
			expect(url.searchParams.get("q")).toBe(
				"trashed = false and name contains 'Q3 \\'plan\\'' and 'folder1' in parents",
			);
			expect(url.searchParams.get("supportsAllDrives")).toBe("true");
			return Response.json({
				files: [
					{
						id: "doc1",
						name: "Q3 plan",
						mimeType: "application/vnd.google-apps.document",
						modifiedTime: "2026-09-01T00:00:00Z",
						webViewLink: "https://docs.google.com/d/doc1",
					},
				],
			});
		},
		[`GET ${DRIVE}/drive/v3/files/doc1`]: () =>
			Response.json({
				id: "doc1",
				name: "Q3 plan",
				mimeType: "application/vnd.google-apps.document",
				modifiedTime: "2026-09-01T00:00:00Z",
			}),
		[`GET ${DRIVE}/drive/v3/files/doc1/export`]: (url) => {
			expect(url.searchParams.get("mimeType")).toBe("text/plain");
			return new Response("Plan text", { headers: { "content-type": "text/plain" } });
		},
	});
	await expect(
		drive("search_files", fetchImplementation).execute(input({ query: "Q3 'plan'", folder_id: "folder1" }, DRIVE)),
	).resolves.toMatchObject({
		status: "completed",
		result: { files: [{ file_id: "doc1", name: "Q3 plan", is_folder: false }], more: false },
	});
	await expect(
		drive("read_file", fetchImplementation).execute(input({ file_id: "doc1" }, DRIVE)),
	).resolves.toMatchObject({
		result: { file_id: "doc1", content: "Plan text", content_format: "text/plain" },
	});
});

it("keeps Drive files and Gmail bodies under the broker's result limit by bytes, not characters", async () => {
	// 20 000 characters of four-byte emoji and JSON-escaped control characters
	// would be ~100 KiB as JSON; the broker refuses anything over 32 KiB.
	const heavy = "😀\u0001".repeat(10_000);
	const { fetchImplementation } = google({
		[`GET ${DRIVE}/drive/v3/files/doc1`]: () =>
			Response.json({ id: "doc1", name: "Heavy", mimeType: "application/vnd.google-apps.document" }),
		[`GET ${DRIVE}/drive/v3/files/doc1/export`]: () =>
			new Response(heavy, { headers: { "content-type": "text/plain" } }),
		[`GET ${GMAIL}/gmail/v1/users/me/messages/m1`]: () => Response.json(message("m1", "Heavy", heavy)),
		[`GET ${GMAIL}/gmail/v1/users/me/threads/t1`]: () =>
			Response.json({
				id: "t1",
				messages: Array.from({ length: 10 }, (_, index) => message(`m${index}`, "Heavy", heavy)),
			}),
		[`GET ${GMAIL}/gmail/v1/users/me/messages`]: () =>
			Response.json({ messages: Array.from({ length: 25 }, (_, index) => ({ id: `s${index}` })) }),
		...Object.fromEntries(
			Array.from({ length: 25 }, (_, index) => [
				`GET ${GMAIL}/gmail/v1/users/me/messages/s${index}`,
				() => Response.json(message(`s${index}`, "😀".repeat(2000), "x")),
			]),
		),
	});
	const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
	const file = await drive("read_file", fetchImplementation).execute(
		input({ file_id: "doc1", max_chars: 20_000 }, DRIVE),
	);
	expect(file).toMatchObject({ status: "completed", result: { content_truncated: true } });
	expect(bytes(file)).toBeLessThanOrEqual(30 * 1024);
	const mail = await gmail("read_message", fetchImplementation).execute(input({ message_id: "m1" }, GMAIL));
	expect(mail).toMatchObject({ status: "completed", result: { body_truncated: true } });
	expect(bytes(mail)).toBeLessThanOrEqual(30 * 1024);
	const thread = await gmail("read_thread", fetchImplementation).execute(input({ thread_id: "t1" }, GMAIL));
	expect(thread).toMatchObject({ status: "completed" });
	expect(bytes(thread)).toBeLessThanOrEqual(30 * 1024);
	// 25 summaries with 8 KiB subjects cannot all fit: the list keeps what fits and says so.
	const search = await gmail("search_messages", fetchImplementation).execute(input({ query: "x", limit: 25 }, GMAIL));
	expect(search).toMatchObject({ status: "completed", result: { more: true } });
	expect((search as { result: { messages_omitted: number } }).result.messages_omitted).toBeGreaterThan(0);
	expect(bytes(search)).toBeLessThanOrEqual(30 * 1024);
});

it("creates a Google Doc from text through a multipart upload and updates content in place", async () => {
	const { fetchImplementation } = google({
		[`POST ${DRIVE}/upload/drive/v3/files`]: (url, init) => {
			expect(url.searchParams.get("uploadType")).toBe("multipart");
			const body = String(init?.body);
			expect((init?.headers as Record<string, string>)["content-type"]).toMatch(
				/^multipart\/related; boundary=qorpera-/,
			);
			expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
			expect(body).toContain('"parents":["folder1"]');
			expect(body).toContain("Content-Type: text/plain; charset=UTF-8\r\n\r\nHello doc");
			return Response.json({
				id: "new1",
				name: "Notes",
				mimeType: "application/vnd.google-apps.document",
				webViewLink: "https://docs.google.com/d/new1",
			});
		},
		[`PATCH ${DRIVE}/upload/drive/v3/files/new1`]: (url, init) => {
			expect(url.searchParams.get("uploadType")).toBe("media");
			expect(String(init?.body)).toBe("Updated");
			return Response.json({
				id: "new1",
				name: "Notes",
				mimeType: "application/vnd.google-apps.document",
				modifiedTime: "2026-09-22T00:00:00Z",
			});
		},
	});
	await expect(
		drive("create_file", fetchImplementation).execute(
			input(
				{
					name: "Notes",
					content: "Hello doc",
					mime_type: "application/vnd.google-apps.document",
					folder_id: "folder1",
				},
				DRIVE,
			),
		),
	).resolves.toMatchObject({
		status: "completed",
		result: { file_id: "new1", url: "https://docs.google.com/d/new1" },
	});
	await expect(
		drive("update_file", fetchImplementation).execute(input({ file_id: "new1", content: "Updated" }, DRIVE)),
	).resolves.toMatchObject({
		status: "completed",
		result: { file_id: "new1", modified_at: "2026-09-22T00:00:00Z" },
	});
});

it("pins Gmail and Drive to their own origins", async () => {
	const fetchImplementation = vi.fn<typeof fetch>();
	await expect(gmail("read_message", fetchImplementation).execute(input({ message_id: "m1" }, DRIVE))).rejects.toThrow(
		"authority",
	);
	await expect(drive("read_file", fetchImplementation).execute(input({ file_id: "f" }, GMAIL))).rejects.toThrow(
		"authority",
	);
	expect(fetchImplementation).not.toHaveBeenCalled();
});

it("clips by JSON bytes at a code point boundary and turns an oversized result into a closed failure", async () => {
	const clipped = clipText("😀😀😀", 10, 9);
	// Two emoji (8 bytes) would leave no room for the 3-byte ellipsis: one emoji fits.
	expect(clipped).toEqual({ text: "😀…", truncated: true });
	expect(clipText("\n\n", 10, 4)).toEqual({ text: "\n\n", truncated: false });
	await expect(connectorOutcome(async () => ({ text: "x".repeat(40 * 1024) }))).resolves.toEqual({
		schema: "qorpera.connector-result/v1",
		status: "failed",
		reason: "result_too_large",
		detail: "The result is too large to return. Ask for fewer items or a smaller part.",
	});
});
