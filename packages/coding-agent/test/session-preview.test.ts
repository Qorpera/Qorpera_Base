import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CompanyRoomSidebarView, createCompanyAppServer } from "../src/core/app-server.ts";
import { scaffoldCompany } from "../src/core/company.ts";
import { type SessionSidebarPreview, sessionSidebarPreview } from "../src/core/session-preview.ts";
import { LITELLM_RATES_URL, parseUsageRateTable } from "../src/core/usage-pricing.ts";

function message(id: string, role: string, content: unknown, timestamp: number, stopReason?: string): string {
	return JSON.stringify({ type: "message", id, message: { role, content, timestamp, stopReason } });
}

describe("sidebar message previews", () => {
	it("exposes only public messages and preserves the completed reply independently of the newest user message", () => {
		const result = sessionSidebarPreview(
			Buffer.from(
				[
					message(
						"user",
						"user",
						[{ type: "text", text: "[Sidechat context: hidden host material]  Hello\nthere" }],
						1,
					),
					message(
						"reply",
						"assistant",
						[
							{ type: "thinking", thinking: "private reasoning" },
							{ type: "text", text: "The answer" },
							{ type: "toolCall", arguments: { secret: "password" } },
						],
						2,
						"stop",
					),
					message("tool", "toolResult", [{ type: "text", text: "private tool output" }], 3),
					message("error", "assistant", [{ type: "text", text: "failed private details" }], 4, "error"),
					message("next", "user", "Next question", 5),
				].join("\n"),
			),
		);
		expect(result.lastMessage).toEqual({ id: "next", role: "user", text: "Next question", timestamp: 5 });
		expect(result.lastAssistantMessage).toEqual({ id: "reply", role: "assistant", text: "The answer", timestamp: 2 });
		expect(JSON.stringify(result)).not.toMatch(/private|password|thinking/);
	});

	it("handles bounded partial tails, incomplete appends, images, and old timestamped records", () => {
		const result = sessionSidebarPreview(
			Buffer.from(
				[
					'partial {"private":true}',
					message("aborted", "assistant", "Not finished", 1, "aborted"),
					JSON.stringify({
						type: "message",
						timestamp: "2026-08-28T00:00:00.000Z",
						message: { role: "assistant", content: "  A   stable reply  ", stopReason: "stop" },
					}),
					message("image", "user", [{ type: "image", data: "secret-base64" }], 2),
					'{"type":"message","message":',
				].join("\n"),
			),
			true,
		);
		expect(result.lastAssistantMessage?.id).toHaveLength(24);
		expect(result.lastAssistantMessage?.text).toBe("A stable reply");
		expect(result.lastAssistantMessage?.timestamp).toBe(Date.parse("2026-08-28T00:00:00.000Z"));
		expect(result.lastMessage?.text).toBe("Image");
		expect(JSON.stringify(result)).not.toContain("secret-base64");
	});

	it("caps one-line snippets and does not mark tool-use or invalid records as new replies", () => {
		const result = sessionSidebarPreview(
			Buffer.from(
				[
					message("reply", "assistant", "hello ".repeat(100), 1, "stop"),
					message("tool-use", "assistant", "Checking a tool", 2, "toolUse"),
					message("negative", "assistant", "Invalid", -1),
					message("bad-date", "assistant", "Invalid", Number.NaN),
				].join("\n"),
			),
		);
		expect(result.lastAssistantMessage?.id).toBe("reply");
		expect(result.lastAssistantMessage?.text).toHaveLength(240);
		expect(result.lastMessage?.id).toBe("tool-use");
	});
});

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

async function startServer(rooms: CompanyRoomSidebarView[] = []): Promise<string> {
	root = mkdtempSync(join(realpathSync(tmpdir()), "qorpera-preview-test-"));
	scaffoldCompany(root);
	server = createCompanyAppServer({
		root,
		authToken: "test-only",
		roomReadModel: () => rooms,
		usageRateCatalog: async () => ({
			rates: parseUsageRateTable({}),
			pricing: {
				status: "cached",
				source: LITELLM_RATES_URL,
				fetchedAt: "2026-08-28T00:00:00.000Z",
				knownModels: 0,
			},
		}),
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	return `http://127.0.0.1:${address.port}/api/state`;
}

describe("production sidebar read model", () => {
	it("refreshes appended replies, survives large tool records, and clears stale previews after truncation", async () => {
		const url = await startServer();
		const trail = join(root!, "trail", "2026-08-28T00-00-00-000Z_preview.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "preview",
			timestamp: "2026-08-28T00:00:00Z",
			cwd: root,
		});
		const first = message("user-1", "user", "Can you check?", 1);
		writeFileSync(trail, [header, first, message("reply-1", "assistant", "First result", 2, "stop"), ""].join("\n"));
		const read = async () =>
			(await (await fetch(url)).json()) as { sessions: Array<SessionSidebarPreview & { title: string }> };
		expect((await read()).sessions[0].lastAssistantMessage?.id).toBe("reply-1");
		appendFileSync(
			trail,
			[
				message("reply-2", "assistant", "Updated result", 3, "stop"),
				message("large-tool", "toolResult", "private".repeat(100000), 4),
				"",
			].join("\n"),
		);
		const changed = (await read()).sessions[0];
		expect(changed.lastAssistantMessage?.id).toBe("reply-2");
		expect(changed.lastMessage?.text).toBe("Updated result");
		expect(changed.title).toBe("Can you check?");
		appendFileSync(trail, `${JSON.stringify({ type: "metadata", text: "Not a message" })}\n`);
		expect((await read()).sessions[0].lastAssistantMessage?.id).toBe("reply-2");
		writeFileSync(trail, [header, first, ""].join("\n"));
		expect((await read()).sessions[0].lastAssistantMessage).toBeUndefined();
	});

	it("passes only the safe room preview fields through the server allowlist", async () => {
		const preview = {
			id: "reply",
			text: "  Ready\nfor you  ",
			speaker: { kind: "staff" as const, staffAgentId: "staff-a", secret: "hidden" },
			createdAt: "2026-08-28T00:00:00Z",
			sourceTrailFile: "private-trail",
			images: [{ data: "private-image" }],
		};
		const url = await startServer([
			{
				id: "room-a",
				participantIds: ["staff-a"],
				historicalParticipantIds: ["staff-a"],
				status: "active",
				createdAt: "2026-08-28T00:00:00Z",
				updatedAt: "2026-08-28T00:00:01Z",
				lastMessage: preview,
				lastStaffMessage: preview,
			},
		]);
		const state = (await (await fetch(url)).json()) as { rooms: CompanyRoomSidebarView[] };
		expect(state.rooms[0].lastStaffMessage).toEqual({
			id: "reply",
			text: "Ready for you",
			speaker: { kind: "staff", staffAgentId: "staff-a" },
			createdAt: "2026-08-28T00:00:00Z",
		});
		expect(JSON.stringify(state.rooms)).not.toMatch(/private|hidden|secret|sourceTrailFile|images/);
	});
});
