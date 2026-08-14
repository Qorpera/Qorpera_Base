/**
 * Codex engine adapter (Qorpera Base slice 4, spec §6.0).
 *
 * Hermetic: a fake `codex app-server` (node script) speaks the v2 subset the
 * adapter targets. Covers lifecycle + trail normalization, the authority
 * bridge (approvals evaluate as bash), and approval consumption.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { scaffoldCompany } from "../src/core/company.ts";
import { CodexEngineSession } from "../src/core/engine/codex-engine.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const FAKE = resolve(__dirname, "fakes", "fake-codex-app-server.mjs");

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-codex-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) {
		rmSync(root, { recursive: true, force: true });
	}
});

interface Scenario {
	commands?: string[];
	reasoning?: string;
	final?: string;
}

function writeScenario(scenario: Scenario): { scenarioPath: string; outPath: string } {
	const scenarioPath = join(root, "scenario.json");
	const outPath = join(root, "fake-out.jsonl");
	writeFileSync(scenarioPath, JSON.stringify(scenario), "utf-8");
	return { scenarioPath, outPath };
}

function readOut(outPath: string): Array<Record<string, unknown>> {
	if (!existsSync(outPath)) return [];
	return readFileSync(outPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runEngineTurn(
	cwd: string,
	scenario: Scenario,
	prompt: string,
): Promise<{ finalText: string; sessionManager: SessionManager; out: Array<Record<string, unknown>> }> {
	const { scenarioPath, outPath } = writeScenario(scenario);
	process.env.QORPERA_FAKE_SCENARIO = scenarioPath;
	process.env.QORPERA_FAKE_OUT = outPath;
	const trailDir = join(cwd, "trail");
	const sessionManager = SessionManager.create(cwd, existsSync(trailDir) ? trailDir : join(root, "sessions"));
	const session = await CodexEngineSession.start({
		cwd,
		sessionManager,
		authority: discoverAuthority(cwd),
		binary: { command: process.execPath, args: [FAKE] },
		requestTimeoutMs: 30_000,
	});
	try {
		const result = await session.runTurn(prompt);
		return { finalText: result.finalText, sessionManager, out: readOut(outPath) };
	} finally {
		await session.dispose();
	}
}

describe("codex engine adapter", () => {
	it("runs a turn, normalizes items into the trail, and accepts approvals without an authority", async () => {
		const cwd = join(root, "plain");
		mkdirSync(cwd, { recursive: true });
		const { finalText, sessionManager, out } = await runEngineTurn(
			cwd,
			{ commands: ["echo hello"], reasoning: "thinking it through", final: "all done" },
			"do the thing",
		);

		expect(finalText).toContain("all done");
		expect(finalText).toContain("decisions: accept");

		const approvals = out.filter((entry) => entry.kind === "commandApproval");
		expect(approvals).toEqual([{ kind: "commandApproval", command: "echo hello", decision: "accept" }]);
		const init = out.find((entry) => entry.kind === "initialize") as { clientInfo?: { name?: string } };
		expect(init?.clientInfo?.name).toBe("qorpera-base");
		const threadStart = out.find((entry) => entry.kind === "threadStart") as { params?: { cwd?: string } };
		expect(threadStart?.params?.cwd).toBe(cwd);

		// Trail: user message, custom entries for reasoning/command/agentMessage,
		// final assistant message with codex attribution + usage.
		const entries = sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
		const customTypes = entries.filter((entry) => entry.type === "custom").map((entry) => entry.customType);
		expect(customTypes).toContain("codex_thread");
		expect(customTypes).toContain("codex_reasoning");
		expect(customTypes).toContain("codex_command");
		expect(customTypes).toContain("codex_agent_message");
		const assistant = entries.find(
			(entry) => entry.type === "message" && (entry.message as { role?: string })?.role === "assistant",
		) as { message?: { model?: string; provider?: string; api?: string; usage?: { input?: number } } };
		expect(assistant?.message?.model).toBe("gpt-5.3-codex");
		expect(assistant?.message?.provider).toBe("openai");
		expect(assistant?.message?.api).toBe("codex-app-server");
		expect(assistant?.message?.usage?.input).toBe(11);
	});

	it("routes all host-shell approvals through authority gates", async () => {
		const company = join(root, "acme");
		scaffoldCompany(company);
		const { finalText, sessionManager, out } = await runEngineTurn(
			company,
			{ commands: ["git status", "rm -rf work"], final: "attempted" },
			"clean up",
		);

		const approvals = out.filter((entry) => entry.kind === "commandApproval");
		expect(approvals).toEqual([
			{ kind: "commandApproval", command: "git status", decision: "decline" },
			{ kind: "commandApproval", command: "rm -rf work", decision: "decline" },
		]);
		expect(finalText).toContain("decisions: decline,decline");
		const threadStart = out.find((entry) => entry.kind === "threadStart") as {
			params?: { approvalPolicy?: string; sandbox?: string };
		};
		expect(threadStart.params?.approvalPolicy).toBe("untrusted");
		expect(threadStart.params?.sandbox).toBe("read-only");

		// Both the default host-shell gate and the destructive gate landed in
		// the company inbox, and the trail recorded the declined effects.
		const gateFiles = readdirSync(join(company, "inbox")).filter((name) => name.startsWith("gate-"));
		expect(gateFiles.length).toBe(2);
		const entries = sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "qorpera_gate")).toBe(true);

		// Engine trail lives inside the company folder (sessions are the trail).
		const trailFiles = readdirSync(join(company, "trail")).filter((name) => name.endsWith(".jsonl"));
		expect(trailFiles.length).toBe(1);
	});

	it("honors a pre-approved gate: single-use approval is consumed by the engine turn", async () => {
		const company = join(root, "acme2");
		scaffoldCompany(company);
		const authority = discoverAuthority(company)!;
		const command = "rm -rf scratch";

		// File the gate, then approve it the way a human would.
		const first = evaluateToolCall(authority, "bash", { command }, company);
		expect(first.kind).toBe("block");
		const gateId = (first as { gateId: string }).gateId;
		const inbox = join(company, "inbox");
		const gateFile = readdirSync(inbox).find((name) => name.startsWith(gateId))!;
		writeFileSync(
			join(inbox, gateFile),
			readFileSync(join(inbox, gateFile), "utf-8").replace(/^status:.*$/m, "status: approved"),
			"utf-8",
		);

		const { out } = await runEngineTurn(company, { commands: [command], final: "cleaned" }, "clean scratch");
		const approvals = out.filter((entry) => entry.kind === "commandApproval");
		expect(approvals).toEqual([{ kind: "commandApproval", command, decision: "accept" }]);

		// Consumed: the same command gates again on the next evaluation.
		const after = evaluateToolCall(authority, "bash", { command }, company);
		expect(after.kind).toBe("block");
	});
});
