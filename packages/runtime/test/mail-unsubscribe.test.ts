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

	function gmailDescriptor(toolName: string, operationId: string): CloudNativeConnectorToolDescriptor {
		return {
			schema: "qorpera.native-connector-tool/v1",
			grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			toolName,
			description: toolName,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			connectorId: "gmail",
			operationId,
			operationVersion: 1,
			adapterSha256: "c".repeat(64),
			destinationOrigin: "https://gmail.googleapis.com",
		};
	}

	it("exposes reversible mail and Gmail cleanup tools on Inbox surface_ops while withholding unreviewed sends", async () => {
		const descriptors = [
			gmailDescriptor("gmail_list_messages", "list_messages"),
			gmailDescriptor("gmail_update_messages", "update_messages"),
			gmailDescriptor("gmail_block_sender", "block_sender"),
			gmailDescriptor("gmail_send_message", "send_message"),
			gmailDescriptor("gmail_send_draft", "send_draft"),
		];
		const built = buildInboxOpsMailTools({
			inboxMail: { binding, control, secretBroker, gmailDescriptors: descriptors },
			identity,
			operations,
		});
		const names = built.map((tool) => tool.name);
		expect(names).toContain("list_hooks");
		expect(names).toContain("find_mail");
		expect(names).toContain("read_event");
		expect(names).toContain("manage_mail");
		expect(names).toContain("gmail_list_messages");
		expect(names).toContain("gmail_update_messages");
		expect(names).toContain("gmail_block_sender");
		expect(names).not.toContain("send_mail");
		expect(names).not.toContain("manage_hook");
		expect(names).not.toContain("gmail_send_message");
		expect(names).not.toContain("gmail_send_draft");

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
		expect(prepared.instructions).toContain("Playwright");
		const surfaceToolNames = prepared.buildTools(identity, operations).map((tool) => tool.name);
		expect(surfaceToolNames).toContain("stage_surface_ops_action");
		expect(surfaceToolNames).toContain("manage_mail");
		expect(surfaceToolNames).toContain("gmail_update_messages");
		expect(surfaceToolNames).not.toContain("gmail_send_message");
	});
});
