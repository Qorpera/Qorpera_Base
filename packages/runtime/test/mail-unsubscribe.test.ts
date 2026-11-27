import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import type { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import type { CloudNativeConnectorToolDescriptor } from "@qorpera/runtime/cloud-secret-tools";
import { buildInboxOpsMailTools, prepareSurfaceCodingWorkspace } from "@qorpera/runtime/cloud-surface-coding-tools";
import { normalizeBlockedSender, parseListUnsubscribeHeaders } from "@qorpera/runtime/mail-unsubscribe";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

describe("parseListUnsubscribeHeaders", () => {
	it("parses RFC 8058 one-click HTTPS, mailto with query params, and web URLs", () => {
		const parsed = parseListUnsubscribeHeaders(
			"<mailto:unsub@news.example.com?subject=Remove%20me&body=Stop+now>, <https://news.example.com/unsub?t=abc>",
			"List-Unsubscribe=One-Click",
		);
		expect(parsed).toEqual({
			oneClickUrl: "https://news.example.com/unsub?t=abc",
			mailto: {
				to: "unsub@news.example.com",
				subject: "Remove me",
				body: "Stop now",
			},
			webUrls: ["https://news.example.com/unsub?t=abc"],
		});
	});

	it("omits oneClickUrl when List-Unsubscribe-Post is missing or URL is HTTP or has non-443 port", () => {
		expect(parseListUnsubscribeHeaders("<https://news.example.com/unsub>", null)).toEqual({
			webUrls: ["https://news.example.com/unsub"],
		});
		expect(parseListUnsubscribeHeaders("<http://news.example.com/unsub>", "List-Unsubscribe=One-Click")).toEqual({
			webUrls: ["http://news.example.com/unsub"],
		});
		expect(
			parseListUnsubscribeHeaders("<https://news.example.com:8443/unsub>", "List-Unsubscribe=One-Click"),
		).toEqual({
			webUrls: ["https://news.example.com:8443/unsub"],
		});
	});

	it("ignores unsafe schemes and malformed entries", () => {
		expect(
			parseListUnsubscribeHeaders(
				"<javascript:alert(1)>, <file:///etc/passwd>, <mailto:bad>",
				"List-Unsubscribe=One-Click",
			),
		).toBeNull();
	});
});

describe("normalizeBlockedSender", () => {
	it("normalizes display-name addresses, bare addresses, and domains", () => {
		expect(normalizeBlockedSender("Promo Team <Promo@Example.COM>")).toEqual({
			sender: "promo@example.com",
			matchKind: "address",
		});
		expect(normalizeBlockedSender("news@sub.example.org")).toEqual({
			sender: "news@sub.example.org",
			matchKind: "address",
		});
		expect(normalizeBlockedSender("example.com")).toEqual({
			sender: "@example.com",
			matchKind: "domain",
		});
		expect(normalizeBlockedSender("@News.Example.Co.Uk")).toEqual({
			sender: "@news.example.co.uk",
			matchKind: "domain",
		});
	});

	it("rejects invalid senders and operator injection strings", () => {
		expect(normalizeBlockedSender("")).toBeNull();
		expect(normalizeBlockedSender("a OR b@example.com")).toBeNull();
		expect(normalizeBlockedSender("localhost")).toBeNull();
		expect(normalizeBlockedSender("user@example.com\ncc:evil@x.com")).toBeNull();
	});
});

describe("Inbox surface_ops tools", () => {
	const { binding, authority } = nativeToolAuthorityFixture();
	const { identity } = authority;
	const control = { call: vi.fn() } as unknown as CloudCompanyPathControl;
	const operations = {} as CloudNativeToolOperations;
	const secretBroker = { execute: vi.fn() };

	function gmailDescriptor(
		toolName: string,
		operationId: string,
		inputSchema: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false },
	): CloudNativeConnectorToolDescriptor {
		return {
			schema: "qorpera.native-connector-tool/v1",
			grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			toolName,
			description: toolName,
			inputSchema: inputSchema as CloudNativeConnectorToolDescriptor["inputSchema"],
			connectorId: "gmail",
			operationId,
			operationVersion: 1,
			adapterSha256: "c".repeat(64),
			destinationOrigin: "https://gmail.googleapis.com",
		};
	}

	it("exposes exact reversible mail and Gmail triage tools on Inbox surface_ops while withholding unreviewed sends, deletes, spam, and filter/unsubscribe actions", async () => {
		const updateSchema = {
			type: "object",
			additionalProperties: false,
			required: ["message_ids", "action"],
			properties: {
				action: {
					type: "string",
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
				message_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
			},
		};
		const descriptors = [
			gmailDescriptor("gmail_get_profile", "get_profile"),
			gmailDescriptor("gmail_search_messages", "search_messages"),
			gmailDescriptor("gmail_list_messages", "list_messages"),
			gmailDescriptor("gmail_read_message", "read_message"),
			gmailDescriptor("gmail_read_thread", "read_thread"),
			gmailDescriptor("gmail_update_messages", "update_messages", updateSchema),
			gmailDescriptor("gmail_create_draft", "create_draft"),
			gmailDescriptor("gmail_update_draft", "update_draft"),
			gmailDescriptor("gmail_delete_draft", "delete_draft"),
			gmailDescriptor("gmail_block_sender", "block_sender"),
			gmailDescriptor("gmail_send_message", "send_message"),
			gmailDescriptor("gmail_send_draft", "send_draft"),
		];
		const built = buildInboxOpsMailTools({
			inboxMail: { binding, control, secretBroker, gmailDescriptors: descriptors },
			identity,
			operations,
		});
		expect(built.map((tool) => tool.name)).toEqual([
			"list_hooks",
			"read_event",
			"find_mail",
			"manage_mail",
			"gmail_get_profile",
			"gmail_search_messages",
			"gmail_list_messages",
			"gmail_read_message",
			"gmail_read_thread",
			"gmail_update_messages",
			"gmail_create_draft",
			"gmail_update_draft",
		]);

		const manageMail = built.find((tool) => tool.name === "manage_mail")!;
		expect(() => manageMail.parseArguments({ action: "trash", threadIds: ["a".repeat(43)] })).not.toThrow();
		expect(() => manageMail.parseArguments({ action: "unsubscribe", threadId: "a".repeat(43) })).toThrow(
			/stage_surface_ops_action/,
		);
		expect(() => manageMail.parseArguments({ action: "block_sender", sender: "spam@example.org" })).toThrow(
			/stage_surface_ops_action/,
		);
		expect(() => manageMail.parseArguments({ action: "unblock_sender", sender: "spam@example.org" })).toThrow(
			/stage_surface_ops_action/,
		);

		const gmailUpdate = built.find((tool) => tool.name === "gmail_update_messages")!;
		expect(() =>
			gmailUpdate.parseArguments({
				idempotencyKey: "k1",
				input: { action: "trash", message_ids: ["m1"] },
			}),
		).not.toThrow();
		expect(() =>
			gmailUpdate.parseArguments({
				idempotencyKey: "k2",
				input: { action: "spam", message_ids: ["m1"] },
			}),
		).toThrow(/reversible actions/);

		const prepared = await prepareSurfaceCodingWorkspace({
			workspaceKind: "surface_ops",
			surfaceSession: {
				sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				surfaceSlug: "inbox",
				surfaceTitle: "Inbox",
				sourceKind: "native_ops",
				briefMarkdown: "",
				stageSurfaceOpsAction: vi.fn(),
			},
			inboxMail: { binding, control, secretBroker, gmailDescriptors: descriptors },
			isClaudeTurn: false,
			newDisk: false,
			signal: new AbortController().signal,
		});
		expect(prepared.instructions).toContain("manage_mail");
		expect(prepared.instructions).toContain("gmail_update_messages");
		expect(prepared.instructions).toContain("stage_surface_ops_action");
		expect(prepared.instructions).not.toContain("Playwright");
		expect(prepared.instructions).not.toContain("gmail_block_sender");
		const surfaceToolNames = prepared.buildTools(identity, operations).map((tool) => tool.name);
		expect(surfaceToolNames).toEqual([
			"stage_surface_ops_action",
			"list_hooks",
			"read_event",
			"find_mail",
			"manage_mail",
			"gmail_get_profile",
			"gmail_search_messages",
			"gmail_list_messages",
			"gmail_read_message",
			"gmail_read_thread",
			"gmail_update_messages",
			"gmail_create_draft",
			"gmail_update_draft",
		]);
	});
});
