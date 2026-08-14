import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";

/** Shorthand entries mirroring the real damaged trail of 2026-08-13: a
 * founder chat whose only message got orphaned after rootless kernel
 * observations landed last and later spawns rerooted the tree under them. */
const entry = (partial: Record<string, unknown>): SessionEntry =>
	({ timestamp: "2026-08-13T04:07:00.000Z", ...partial }) as unknown as SessionEntry;

const contextTexts = (messages: unknown[]): string =>
	messages
		.flatMap((m) => {
			const content = (m as { content?: unknown }).content;
			return Array.isArray(content)
				? content.filter((c) => (c as { type?: string }).type === "text").map((c) => (c as { text: string }).text)
				: [];
		})
		.join(" ");

describe("session leaf selection with kernel observations", () => {
	it("never adopts a rootless kernel observation as the resume leaf", () => {
		const entries: SessionEntry[] = [
			entry({ type: "model_change", id: "m1", parentId: null, provider: "anthropic", modelId: "claude-fable-5" }),
			entry({
				type: "message",
				id: "u1",
				parentId: "m1",
				message: { role: "user", content: [{ type: "text", text: "help me set up the company controller" }] },
			}),
			// Kernel model-request observations: rootless trail metadata.
			entry({ type: "custom", id: "k1", parentId: null, customType: "qorpera_kernel_model_request", data: {} }),
			entry({ type: "custom", id: "k2", parentId: null, customType: "qorpera_kernel_model_request", data: {} }),
		];
		expect(contextTexts(buildSessionContext(entries).messages)).toContain("help me set up the company controller");
	});

	it("recovers a conversation that later spawns rerooted under a kernel observation", () => {
		// The real shape: message chain abandoned, meta chains growing under a
		// rootless kernel custom — the blank-pane session, replayed.
		const entries: SessionEntry[] = [
			entry({ type: "model_change", id: "m1", parentId: null, provider: "anthropic", modelId: "claude-opus-4-8" }),
			entry({
				type: "message",
				id: "u1",
				parentId: "m1",
				message: { role: "user", content: [{ type: "text", text: "the founder's only message" }] },
			}),
			entry({ type: "custom", id: "k1", parentId: null, customType: "qorpera_kernel_model_request", data: {} }),
			// Second spawn rerooted its meta chain under the kernel entry.
			entry({ type: "model_change", id: "m2", parentId: "k1", provider: "anthropic", modelId: "claude-fable-5" }),
			entry({ type: "thinking_level_change", id: "t1", parentId: "m2", thinkingLevel: "medium" }),
		];
		expect(contextTexts(buildSessionContext(entries).messages)).toContain("the founder's only message");
	});

	it("restores the message-bearing leaf when opening a persisted session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "qorpera-session-resume-"));
		const sessionFile = join(tempDir, "session.jsonl");
		try {
			const entries: SessionEntry[] = [
				entry({
					type: "model_change",
					id: "m1",
					parentId: null,
					provider: "anthropic",
					modelId: "claude-opus-4-8",
				}),
				entry({
					type: "message",
					id: "u1",
					parentId: "m1",
					message: { role: "user", content: [{ type: "text", text: "persist this conversation" }] },
				}),
				entry({ type: "custom", id: "k1", parentId: null, customType: "qorpera_kernel_model_request", data: {} }),
				entry({ type: "model_change", id: "m2", parentId: "k1", provider: "anthropic", modelId: "claude-fable-5" }),
				entry({ type: "thinking_level_change", id: "t1", parentId: "m2", thinkingLevel: "medium" }),
			];
			const header = {
				type: "session",
				version: 3,
				id: "persisted-session",
				timestamp: "2026-08-13T04:06:44.103Z",
				cwd: tempDir,
			};
			writeFileSync(sessionFile, `${[header, ...entries].map((row) => JSON.stringify(row)).join("\n")}\n`);

			const session = SessionManager.open(sessionFile, tempDir);

			expect(session.getLeafId()).toBe("u1");
			expect(contextTexts(session.buildSessionContext().messages)).toContain("persist this conversation");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps last-entry semantics for message-less sessions", () => {
		const entries: SessionEntry[] = [
			entry({ type: "model_change", id: "m1", parentId: null, provider: "anthropic", modelId: "claude-fable-5" }),
			entry({ type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "high" }),
		];
		const context = buildSessionContext(entries);
		expect(context.thinkingLevel).toBe("high");
		expect(context.messages).toHaveLength(0);
	});

	it("keeps an explicit leafId authoritative", () => {
		const entries: SessionEntry[] = [
			entry({ type: "model_change", id: "m1", parentId: null, provider: "anthropic", modelId: "claude-fable-5" }),
			entry({
				type: "message",
				id: "u1",
				parentId: "m1",
				message: { role: "user", content: [{ type: "text", text: "branch A" }] },
			}),
			entry({
				type: "message",
				id: "u2",
				parentId: "m1",
				message: { role: "user", content: [{ type: "text", text: "branch B" }] },
			}),
		];
		const texts = contextTexts(buildSessionContext(entries, "u1").messages);
		expect(texts).toContain("branch A");
		expect(texts).not.toContain("branch B");
	});
});
