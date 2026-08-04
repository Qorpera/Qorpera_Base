/**
 * Headless embed-surface smoke test (Qorpera Base slice 1C).
 *
 * Proves the agent core runs fully headless — no network, no API keys, no TUI
 * import — and that the persisted session is a real tree: user message,
 * assistant turn with a tool call, tool result, model/usage attribution, and
 * working branch navigation. This is the surface the Qorpera shell embeds.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@qorpera/pi-ai";
import { type Static, Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepository } from "../../src/harness/session/jsonl-repo.ts";
import type { AgentTool, AgentToolResult } from "../../src/types.ts";

const echoSchema = Type.Object({ text: Type.String({ description: "Text to echo back" }) });
type EchoParams = Static<typeof echoSchema>;

const echoTool: AgentTool<typeof echoSchema, undefined> = {
	label: "Echo",
	name: "echo",
	description: "Echo the provided text back",
	parameters: echoSchema,
	execute: async (_toolCallId: string, args: EchoParams): Promise<AgentToolResult<undefined>> => ({
		content: [{ type: "text", text: `echo: ${args.text}` }],
		details: undefined,
	}),
};

const tempRoots: string[] = [];

afterAll(() => {
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows can hold file handles briefly; leftover temp dirs are harmless.
		}
	}
});

describe("headless smoke", () => {
	it("runs a scripted tool-calling session headless and persists a session tree", async () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-headless-smoke-"));
		tempRoots.push(root);

		const models = createModels();
		const faux = fauxProvider({ provider: "smoke-faux" });
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "ping" }, { id: "smoke-call-1" })),
			fauxAssistantMessage("done"),
		]);

		const repository = new JsonlSessionRepository({
			fs: new NodeExecutionEnv({ cwd: root }),
			sessionsRoot: root,
		});
		const session = await repository.create({ cwd: root });

		const harness = new AgentHarness({
			models,
			session,
			model: faux.getModel(),
			tools: [echoTool],
			systemPrompt: "You are the Qorpera Base smoke-test agent.",
		});

		const final = await harness.prompt("please echo ping");
		expect(JSON.stringify(final.content)).toContain("done");

		// --- The in-memory session is a tree with the full turn recorded.
		const entries = await session.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(4);

		const ids = new Set(entries.map((entry) => entry.id));
		for (const entry of entries) {
			expect(entry.id).toBeTruthy();
			if (entry.parentId !== null) {
				expect(ids.has(entry.parentId)).toBe(true);
			}
		}
		expect(entries.some((entry) => entry.parentId === null)).toBe(true);

		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userMessage = messages.find((message) => message.role === "user");
		expect(JSON.stringify(userMessage?.content)).toContain("please echo ping");

		const assistantWithToolCall = messages.find(
			(message) => message.role === "assistant" && JSON.stringify(message.content).includes('"toolCall"'),
		);
		expect(JSON.stringify(assistantWithToolCall)).toContain('"echo"');

		const toolResult = messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("echo: ping");

		// Model/usage attribution rides on every assistant message.
		const attributed = messages.filter((message) => message.role === "assistant");
		expect(attributed.length).toBeGreaterThanOrEqual(2);
		for (const message of attributed) {
			const record = message as unknown as Record<string, unknown>;
			expect(record.model).toBeTruthy();
			expect(record.provider).toBeTruthy();
			expect(record.usage).toBeTruthy();
		}

		// --- The persisted JSONL document is the same tree.
		const cwdDirs = readdirSync(root).filter((name) => name.startsWith("--"));
		expect(cwdDirs.length).toBe(1);
		const sessionFiles = readdirSync(join(root, cwdDirs[0])).filter((name) => name.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);
		const lines = readFileSync(join(root, cwdDirs[0], sessionFiles[0]), "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines[0].type).toBe("session");
		for (const line of lines.slice(1)) {
			expect("parentId" in line).toBe(true);
		}

		// --- Branch navigation works headless (no summarize → no LLM call).
		// Navigate back to the first assistant entry; prompting from there gives
		// that entry a second child alongside the original toolResult — a branch.
		const branchTarget = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(branchTarget).toBeTruthy();
		const navigation = await harness.navigateTree(branchTarget!.id);
		expect(navigation.cancelled).toBe(false);

		faux.appendResponses([fauxAssistantMessage("branch two")]);
		await harness.prompt("take the other path");

		const branched = await session.getEntries();
		const childrenOfTarget = branched.filter((entry) => entry.parentId === branchTarget!.id);
		expect(childrenOfTarget.length).toBeGreaterThanOrEqual(2);

		await harness.requestShutdown();
	});
});
