import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGate } from "@qorpera/pi-coding-agent/app-server";
import { requestHash } from "@qorpera/pi-coding-agent/authority";
import { generateFounderIdentity } from "@qorpera/pi-coding-agent/founder-identity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendKernelObservation,
	appendKernelSessionInfo,
	applyKernelWriteFrame,
	bindTrailSession,
	commitTrailAppend,
	kernelGateReviewDocument,
	migrateLegacyCompanyAgentTrails,
	migrateLegacyTrailSession,
	parseTrailAppendFrame,
	pruneEmptyTrailSessions,
	reconcileKernelGateCreations,
	trailSessionMessages,
} from "../src/agent-runtime.ts";
import {
	captureCompanyGitBaseline,
	checkpointCompanyGit,
	checkpointProductWorktreeGit,
	commitCompanyMaterialization,
	reconcilePendingCompanyCheckpoints,
	reconcilePendingProductCheckpoints,
	savePendingCompanyCheckpoint,
	savePendingProductCheckpoint,
	snapshotFounderGitState,
} from "../src/company-checkpoint.ts";
import {
	advanceCompanyGateCreation,
	beginCompanyGateCreation,
	completeCompanyGateCreation,
	listPendingCompanyGateCreations,
} from "../src/company-host-state.ts";

let root: string;

beforeEach(() => {
	root = join(realpathSync(tmpdir()), `qorpera-agent-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "company", "trail"), { recursive: true });
	mkdirSync(join(root, "company", "inbox", "messages"), { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function writeCompanyManifest(company: string): void {
	mkdirSync(join(company, ".qorpera"), { recursive: true });
	writeFileSync(
		join(company, ".qorpera", "company.json"),
		`${JSON.stringify({ schema: "qorpera.company/v1", id: "11111111-1111-4111-8111-111111111111" })}\n`,
		"utf-8",
	);
}

function createProductCheckpointFixture(company: string): {
	worktree: string;
	trailPath: string;
	assignmentPath: string;
} {
	const departmentId = "widget-development";
	const taskId = "20260810000000-aaaaaaaa";
	const relativeWorktree = `departments/${departmentId}/worktrees/${taskId}`;
	const worktree = join(company, relativeWorktree);
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(worktree, "product.ts"), "export const value = 1;\n", "utf-8");
	for (const args of [
		["init"],
		["add", "product.ts"],
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
	]) {
		expect(spawnSync("git", args, { cwd: worktree, stdio: "ignore" }).status).toBe(0);
	}
	expect(
		spawnSync("git", ["remote", "add", "origin", "https://example.invalid/widget.git"], {
			cwd: worktree,
			stdio: "ignore",
		}).status,
	).toBe(0);
	const branch = spawnSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf-8" }).stdout.trim();
	const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf-8" }).stdout.trim();
	const assignmentPath = join(company, ".qorpera", "product-worktrees", departmentId, `${taskId}.json`);
	mkdirSync(join(assignmentPath, ".."), { recursive: true });
	writeFileSync(
		assignmentPath,
		`${JSON.stringify(
			{
				version: 3,
				path: relativeWorktree,
				branch,
				departmentId,
				repositoryPath: `departments/${departmentId}/repository`,
				sourceRemote: "https://example.invalid/widget.git",
				sourceHead,
				recoveryHead: sourceHead,
				recoveryBundles: [],
				sourceHistory: [],
				createdAt: new Date().toISOString(),
			},
			null,
			"\t",
		)}\n`,
		"utf-8",
	);
	const trailPath = join(company, "trail", "product.jsonl");
	writeFileSync(trailPath, "{}\n", "utf-8");
	writeFileSync(join(company, ".gitignore"), "departments/*-development/worktrees/\n", "utf-8");
	for (const args of [
		["init"],
		["add", ".gitignore", ".qorpera", "trail/product.jsonl"],
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "company seed"],
	]) {
		expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
	}
	return { worktree, trailPath, assignmentPath };
}

it("kernel-stamps a fresh agent session name before an executor is attached", () => {
	const company = join(root, "company");
	const binding = bindTrailSession(company, company, {
		actor: "company-agent",
		attended: false,
	});
	appendKernelSessionInfo(binding, "page — page:strategy");

	const entries = readFileSync(binding.path, "utf-8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(entries[1]).toMatchObject({
		type: "session_info",
		name: "page — page:strategy",
		provenance: { source: "kernel", trust: "observed" },
		kernel: { sequence: 1, previousHash: null },
	});
});

describe("kernel-bound agent runtime", () => {
	it("serves the active conversation from the trail file without a child", () => {
		const company = join(root, "company");
		mkdirSync(join(company, "trail"), { recursive: true });
		const file = "2099-02-01T00-00-00-000Z_chainless.jsonl";
		const stamp = "2099-02-01T00:00:00.000Z";
		const rows = [
			{
				type: "session",
				version: 5,
				id: "chainless",
				timestamp: stamp,
				cwd: company,
				qorpera: { actor: "company-agent", attended: true },
			},
			{ type: "session_info", id: "s", parentId: null, timestamp: stamp, name: "Agent" },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: stamp,
				message: { role: "user", content: [{ type: "text", text: "first" }] },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: stamp,
				message: { role: "assistant", content: [{ type: "text", text: "reply" }], qorperaRunId: "run-1" },
			},
			{ type: "thinking_level_change", id: "t1", parentId: "m2", timestamp: stamp, thinkingLevel: "low" },
			// Runtime noise minted as a parentless root after the conversation
			// must not blank the thread: the newest message-bearing chain wins.
			{
				type: "custom",
				id: "c1",
				parentId: null,
				timestamp: stamp,
				customType: "qorpera_kernel_session_runtime",
				data: {},
			},
		];
		writeFileSync(join(company, "trail", file), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
		const messages = trailSessionMessages(company, file);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({ content: [{ type: "text", text: "first" }], timestamp: stamp });
		expect(messages[1]).toMatchObject({ qorperaRunId: "run-1" });
		expect(() => trailSessionMessages(company, "missing.jsonl")).toThrow("does not exist");
	});

	it("prunes contentless unnamed sessions at company open", () => {
		const company = join(root, "company");
		// A real conversation the founder should return to — appended through
		// the kernel lane so the audit chain stays valid for resume.
		const spoken = bindTrailSession(company, company, { actor: "company-agent", attended: true });
		const spokenEntry = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		};
		const spokenAppend = parseTrailAppendFrame(
			{ type: "qorpera_trail_append", token: spoken.token, entry: spokenEntry },
			spoken,
		);
		commitTrailAppend(spoken, spokenAppend!);
		appendFileSync(spoken.path, `${JSON.stringify(spokenAppend!.entry)}\n`);
		// Husks later opens minted: header-only and model-selection-only.
		const husk = join(company, "trail", "2099-01-01T00-00-00-000Z_husk.jsonl");
		writeFileSync(
			husk,
			`${JSON.stringify({ type: "session", version: 5, id: "husk", timestamp: "t", cwd: company, qorpera: { actor: "company-agent", attended: true } })}\n${JSON.stringify({ type: "model_change", id: "mc", parentId: "husk", provider: "p", modelId: "m" })}\n`,
			"utf-8",
		);
		// Product-scoped husk: never resumable as the company chat, still swept.
		const productHusk = join(company, "trail", "2099-01-02T00-00-00-000Z_product.jsonl");
		writeFileSync(
			productHusk,
			`${JSON.stringify({ type: "session", version: 5, id: "ph", timestamp: "t", cwd: company, qorpera: { actor: "product-worker", attended: true, department: "d", worktree: "w" } })}\n`,
			"utf-8",
		);
		// Autonomous work history stays even when empty, and never resumes as chat.
		const autonomous = join(company, "trail", "2099-01-03T00-00-00-000Z_auto.jsonl");
		writeFileSync(
			autonomous,
			`${JSON.stringify({ type: "session", version: 5, id: "auto", timestamp: "t", cwd: company, qorpera: { actor: "company-agent", attended: false, autonomous: true, label: "autonomous — wake" } })}\n`,
			"utf-8",
		);
		// Old-schema sessions need an explicit migration; never auto-resumed.
		const legacy = join(company, "trail", "2099-01-04T00-00-00-000Z_legacy.jsonl");
		writeFileSync(
			legacy,
			`${JSON.stringify({ type: "session", version: 3, id: "old", timestamp: "t", cwd: company, qorpera: { actor: "company-agent", attended: true } })}\n${JSON.stringify({ type: "message", id: "m2", parentId: null, message: { role: "user", content: [] } })}\n`,
			"utf-8",
		);

		expect(pruneEmptyTrailSessions(company)).toBe(2); // company-agent husk + product husk
		expect(existsSync(husk)).toBe(false);
		expect(existsSync(productHusk)).toBe(false);
		expect(existsSync(autonomous)).toBe(true);
		expect(existsSync(legacy)).toBe(true);
		expect(existsSync(spoken.path)).toBe(true);
		// The real conversation remains bindable by its named owner.
		expect(bindTrailSession(company, company, { actor: "company-agent", attended: true }, spoken.file).file).toBe(
			spoken.file,
		);
		// Idempotent: nothing left to sweep.
		expect(pruneEmptyTrailSessions(company)).toBe(0);
	});

	it("migrates a legacy founder chat whole and binds it for live appends", () => {
		const company = join(root, "company");
		const scope = { actor: "company-agent", attended: false } as const;
		// A pre-v5 chat exactly as the pivot-era kernel wrote them: no
		// authority header, no provenance, no kernel hash chain.
		const file = "2026-08-04T05-49-07-753Z_legacy.jsonl";
		const entries = [
			{ type: "session", version: 3, id: "s1", timestamp: "2026-08-04T05:49:07.753Z", cwd: company },
			{
				type: "model_change",
				id: "e1",
				parentId: null,
				timestamp: "2026-08-04T05:49:08.000Z",
				provider: "anthropic",
				modelId: "claude-opus-4-8",
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: "2026-08-04T05:49:09.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			},
		];
		writeFileSync(join(company, "trail", file), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
		// Refused before migration — the schema check bug that made every
		// pre-pivot history row a dead click (v0.18.7).
		expect(() => bindTrailSession(company, company, scope, file)).toThrow(/explicit append-only migration/);

		expect(migrateLegacyTrailSession(company, file, scope)).toBe(true);
		// Idempotent: a current file is left alone.
		expect(migrateLegacyTrailSession(company, file, scope)).toBe(false);
		// The original bytes survive beside the file, invisible to .jsonl lists.
		expect(existsSync(join(company, "trail", `${file}.v3.bak`))).toBe(true);

		// The migrated file binds, replays its audit chain, and accepts a live
		// append on top of the adopted history.
		const binding = bindTrailSession(company, company, scope, file);
		expect(binding.audit.sequence).toBe(2);
		const append = parseTrailAppendFrame(
			{
				type: "qorpera_trail_append",
				token: binding.token,
				entry: {
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "welcome back" }] },
				},
			},
			binding,
		);
		expect(append).toBeDefined();
		commitTrailAppend(binding, append!);
		appendFileSync(binding.path, `${JSON.stringify(append!.entry)}\n`);
		// The extended chain still verifies end to end.
		expect(bindTrailSession(company, company, scope, file).audit.sequence).toBe(3);

		// A legacy file holding an entry v5 cannot adopt migrates nothing.
		const poisoned = "2026-08-04T06-00-00-000Z_poisoned.jsonl";
		writeFileSync(
			join(company, "trail", poisoned),
			`${JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "t", cwd: company })}\n${JSON.stringify({ type: "mystery_event", id: "x1", parentId: null, timestamp: "t" })}\n`,
			"utf-8",
		);
		const before = readFileSync(join(company, "trail", poisoned), "utf-8");
		expect(() => migrateLegacyTrailSession(company, poisoned, scope)).toThrow(/cannot adopt/);
		expect(readFileSync(join(company, "trail", poisoned), "utf-8")).toBe(before);
	});

	it("migrates current trails from the retired controller actor label once", () => {
		const company = join(root, "company");
		const current = bindTrailSession(company, company, { actor: "company-agent", attended: true });
		const original = readFileSync(current.path, "utf-8").replace('"actor":"company-agent"', '"actor":"controller"');
		writeFileSync(current.path, original, "utf-8");

		expect(migrateLegacyCompanyAgentTrails(company)).toBe(1);
		expect(migrateLegacyCompanyAgentTrails(company)).toBe(0);
		expect(JSON.parse(readFileSync(current.path, "utf-8").split("\n")[0]).qorpera.actor).toBe("company-agent");
		expect(readFileSync(`${current.path}.controller.bak`, "utf-8")).toBe(original);
		expect(bindTrailSession(company, company, { actor: "company-agent", attended: true }, current.file).file).toBe(
			current.file,
		);
	});

	it("binds role and worktree scope into an immutable trail header", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "company-agent", attended: true });
		const header = JSON.parse(readFileSync(binding.path, "utf-8").split("\n")[0]);
		expect(header.qorpera).toEqual({ actor: "company-agent", attended: true });
		expect(() =>
			bindTrailSession(
				company,
				company,
				{
					actor: "product-worker",
					attended: true,
					department: "departments/widget-development",
					worktree: "departments/widget-development/worktrees/task-a",
				},
				binding.file,
			),
		).toThrow("authority does not match");
	});

	it("binds staff identity immutably without adopting legacy system trails", () => {
		const company = join(root, "company");
		const legacy = bindTrailSession(company, company, { actor: "company-agent", attended: true });
		const legacyBytes = readFileSync(legacy.path, "utf-8");
		const staff = bindTrailSession(company, company, {
			actor: "company-agent",
			attended: true,
			staffAgentId: "staff-night-shift",
		});

		expect(JSON.parse(readFileSync(staff.path, "utf-8").split("\n")[0]).qorpera).toMatchObject({
			actor: "company-agent",
			attended: true,
			staffAgentId: "staff-night-shift",
		});
		appendKernelObservation(staff, {
			frameType: "staff_intro",
			message: "Introduce yourself and ask what to work on first.",
			attended: false,
			origin: "kernel-staff-introduction",
			intent: {
				nonce: "11111111-1111-4111-8111-111111111111",
				sessionId: staff.sessionId,
				requestHash: "b".repeat(64),
				attended: false,
				issuedAt: "2026-08-15T00:00:00.000Z",
				expiresAt: "2026-08-15T01:00:00.000Z",
				budget: { maxCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
				signature: "kernel-signature",
			},
			images: [],
		});
		expect(JSON.parse(readFileSync(staff.path, "utf-8").split("\n")[1])).toMatchObject({
			type: "custom",
			customType: "qorpera_kernel_input",
			data: {
				frameType: "staff_intro",
				origin: "kernel-staff-introduction",
			},
			provenance: { source: "kernel", trust: "observed" },
		});
		expect(
			bindTrailSession(
				company,
				company,
				{ actor: "company-agent", attended: true, staffAgentId: "staff-night-shift" },
				staff.file,
			).file,
		).toBe(staff.file);
		expect(() =>
			bindTrailSession(
				company,
				company,
				{ actor: "company-agent", attended: true, staffAgentId: "staff-chief-of-staff" },
				staff.file,
			),
		).toThrow("requested staffAgentId");
		expect(() => bindTrailSession(company, company, { actor: "company-agent", attended: true }, staff.file)).toThrow(
			"requested staffAgentId",
		);
		expect(() =>
			bindTrailSession(
				company,
				company,
				{ actor: "company-agent", attended: true, staffAgentId: "staff-night-shift" },
				legacy.file,
			),
		).toThrow("requested staffAgentId");
		expect(readFileSync(legacy.path, "utf-8")).toBe(legacyBytes);
		// The named employee remains isolated from the pre-staff trail.
	});

	it("refuses to migrate a legacy trail into a staff identity", () => {
		const company = join(root, "company");
		const file = "2026-08-04T07-00-00-000Z_legacy-staff.jsonl";
		const path = join(company, "trail", file);
		const original = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "legacy-staff",
			timestamp: "2026-08-04T07:00:00.000Z",
			cwd: company,
		})}\n`;
		writeFileSync(path, original, "utf-8");

		expect(() =>
			migrateLegacyTrailSession(company, file, {
				actor: "company-agent",
				attended: true,
				staffAgentId: "staff-night-shift",
			}),
		).toThrow("remain system-owned");
		expect(readFileSync(path, "utf-8")).toBe(original);
		expect(existsSync(`${path}.v3.bak`)).toBe(false);
	});

	it("accepts only token-bound append frames and host-owned gate transitions", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "company-agent", attended: true });
		const entry = { type: "custom", id: "one", parentId: null, timestamp: new Date().toISOString(), customType: "x" };
		expect(parseTrailAppendFrame({ type: "qorpera_trail_append", token: "wrong", entry }, binding)).toBeUndefined();
		const append = parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding);
		expect(append?.entry).toMatchObject({ type: "custom", id: "one", parentId: null, customType: "x" });
		expect(append?.entry.kernel).toMatchObject({ sequence: 1, previousHash: null });
		expect(append?.entry.provenance).toEqual({ source: "child", trust: "assertion" });
		commitTrailAppend(binding, append!);
		expect(
			parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding),
		).toBeUndefined();
		appendFileSync(binding.path, `${JSON.stringify(append!.entry)}\n`);
		appendKernelObservation(binding, {
			frameType: "prompt",
			message: "founder instruction",
			attended: true,
			origin: "native-founder-confirmation",
			intent: {
				nonce: "11111111-1111-4111-8111-111111111111",
				sessionId: binding.sessionId,
				requestHash: "b".repeat(64),
				attended: true,
				issuedAt: "2026-08-10T00:00:00.000Z",
				expiresAt: "2026-08-10T01:00:00.000Z",
				budget: { maxCalls: 4, maxInputTokens: 1000, maxOutputTokens: 1000, maxCostUsd: 1 },
				signature: "kernel-signature",
			},
			images: [],
		});
		expect(
			bindTrailSession(company, company, { actor: "company-agent", attended: true }, binding.file).audit.sequence,
		).toBe(2);
		const unknown = { ...entry, id: "two", type: "fabricated_root_event" };
		expect(
			parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry: unknown }, binding),
		).toBeUndefined();

		const args = { path: "extensions/danger.ts", contentHash: "c".repeat(64) };
		const hash = requestHash("behavior_signature", args);
		const gateId = `gate-${hash.slice(0, 8)}`;
		const gateFile = `${gateId}.md`;
		expect(
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "create_gate",
					gate: {
						id: gateId,
						file: gateFile,
						effectClass: "authority",
						toolName: "behavior_signature",
						hash,
						args,
					},
				},
				binding,
				company,
			),
		).toBe(true);
		const gatePath = join(company, "inbox", gateFile);
		expect(readFileSync(gatePath, "utf-8")).toContain("status: pending");
		expect(kernelGateReviewDocument(company, gateFile)).toContain(`hash: ${hash}`);
		writeFileSync(gatePath, readFileSync(gatePath, "utf-8").replace("pending", "approved"), "utf-8");
		expect(kernelGateReviewDocument(company, gateFile)).toBeUndefined();
		let response: { granted: boolean } | undefined;
		let trusted = false;
		const durableTrust = {
			has: () => trusted,
			remember: () => {
				trusted = true;
			},
		};
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "trust_gate",
				file: gateFile,
				requestId: "request-1",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
			() => true,
			durableTrust,
		);
		expect(response).toMatchObject({ granted: true });
		expect(trusted).toBe(true);
		expect(readFileSync(gatePath, "utf-8")).toContain("status: consumed");
		expect(kernelGateReviewDocument(company, gateFile, "denied")).toContain(`hash: ${hash}`);
		expect(readFileSync(binding.path, "utf-8")).toContain('"transition":"consumed"');
		expect(readFileSync(binding.path, "utf-8")).toContain('"phase":"started"');
		expect(readFileSync(binding.path, "utf-8")).toContain('"phase":"completed"');
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "trust_gate",
				file: gateFile,
				requestId: "request-2",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
			undefined,
			durableTrust,
		);
		expect(response).toMatchObject({ granted: true });
		expect(readFileSync(binding.path, "utf-8")).toContain('"transition":"trusted-use"');
		trusted = false;
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "trust_gate",
				file: gateFile,
				requestId: "request-orphaned-approval",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
			undefined,
			durableTrust,
		);
		expect(response).toMatchObject({ granted: false });
		expect(readFileSync(gatePath, "utf-8")).toContain("status: pending");
		expect(readFileSync(binding.path, "utf-8")).toContain('"transition":"orphan-reset"');

		const messageContent = "# Product question\n\nShould we ship this?\n";
		const messageHash = createHash("sha256").update(messageContent).digest("hex");
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "create_message",
				file: "msg-product-question.md",
				requestId: "request-message",
				hash: messageHash,
				content: messageContent,
			},
			binding,
			company,
			(value) => {
				response = value;
			},
		);
		expect(response).toMatchObject({ granted: true });
		expect(readFileSync(join(company, "inbox", "messages", "msg-product-question.md"), "utf-8")).toBe(messageContent);
		expect(readFileSync(binding.path, "utf-8")).toContain("qorpera_kernel_inbox_message");

		const forged = readFileSync(gatePath, "utf-8").replace("status: pending", "status: pending\nstatus: approved");
		writeFileSync(gatePath, forged, "utf-8");
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "consume_gate",
				file: gateFile,
				requestId: "request-3",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
		);
		expect(response).toMatchObject({ granted: false });
	});

	it("consumes and durably trusts gates approved with a founder signature", () => {
		// Regression (persistence audit 2026-08-12, P0-2): with a founder
		// identity, resolveGate appends an `approval:` signature line. The
		// kernel parser rejected that field, so every signed approval read as
		// record-not-found and no gate could ever be consumed or trusted.
		const previousAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
		process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-dir");
		try {
			generateFounderIdentity("Test Founder");
			const company = join(root, "company");
			const binding = bindTrailSession(company, company, { actor: "company-agent", attended: true });
			const createGate = (contentHash: string): { file: string; hash: string; path: string } => {
				const args = { path: "extensions/signed.ts", contentHash };
				const hash = requestHash("behavior_signature", args);
				const gateId = `gate-${hash.slice(0, 8)}`;
				const gateFile = `${gateId}.md`;
				applyKernelWriteFrame(
					{
						type: "qorpera_kernel_write",
						token: binding.token,
						operation: "create_gate",
						gate: {
							id: gateId,
							file: gateFile,
							effectClass: "authority",
							toolName: "behavior_signature",
							hash,
							args,
						},
					},
					binding,
					company,
				);
				expect(resolveGate(company, gateFile, "approved")).toBe(true);
				const approved = readFileSync(join(company, "inbox", gateFile), "utf-8");
				expect(approved).toContain("status: approved");
				expect(approved).toMatch(/^approval: \S+$/m);
				return { file: gateFile, hash, path: join(company, "inbox", gateFile) };
			};

			const consumable = createGate("a".repeat(64));
			let response: { granted: boolean } | undefined;
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "consume_gate",
					file: consumable.file,
					requestId: "signed-consume",
					hash: consumable.hash,
					status: "consumed",
				},
				binding,
				company,
				(value) => {
					response = value;
				},
				() => true,
			);
			expect(response).toMatchObject({ granted: true });
			const consumed = readFileSync(consumable.path, "utf-8");
			expect(consumed).toContain("status: consumed");
			// The signature attests the approval, not the lifecycle — it survives.
			expect(consumed).toMatch(/^approval: \S+$/m);

			const durable = createGate("b".repeat(64));
			let trusted = false;
			const durableTrust = {
				has: () => trusted,
				remember: () => {
					trusted = true;
				},
			};
			response = undefined;
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "trust_gate",
					file: durable.file,
					requestId: "signed-trust",
					hash: durable.hash,
					status: "consumed",
				},
				binding,
				company,
				(value) => {
					response = value;
				},
				() => true,
				durableTrust,
			);
			expect(response).toMatchObject({ granted: true });
			expect(trusted).toBe(true);
			response = undefined;
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "trust_gate",
					file: durable.file,
					requestId: "signed-trusted-use",
					hash: durable.hash,
					status: "consumed",
				},
				binding,
				company,
				(value) => {
					response = value;
				},
				undefined,
				durableTrust,
			);
			expect(response).toMatchObject({ granted: true });
			expect(readFileSync(binding.path, "utf-8")).toContain('"transition":"trusted-use"');
		} finally {
			if (previousAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
			else process.env.QORPERA_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("rejects child gate descriptions whose displayed semantics do not match the canonical hash", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		const dangerousArgs = { path: "extensions/danger.ts", contentHash: "d".repeat(64) };
		const dangerousHash = requestHash("behavior_signature", dangerousArgs);
		const gateId = `gate-${dangerousHash.slice(0, 8)}`;
		const gateFile = `${gateId}.md`;
		expect(
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "create_gate",
					gate: {
						id: gateId,
						file: gateFile,
						effectClass: "authority",
						toolName: "behavior_signature",
						hash: dangerousHash,
						args: { path: "notes/innocent.md", contentHash: "e".repeat(64) },
					},
				},
				binding,
				company,
			),
		).toBe(true);
		expect(existsSync(join(company, "inbox", gateFile))).toBe(false);
	});

	it("reconciles a gate file created before its completed trail event", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		const args = { path: "extensions/recover.ts", contentHash: "f".repeat(64) };
		const hash = requestHash("behavior_signature", args);
		const gateId = `gate-${hash.slice(0, 8)}`;
		const gateFile = `${gateId}.md`;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "create_gate",
				gate: {
					id: gateId,
					file: gateFile,
					effectClass: "authority",
					toolName: "behavior_signature",
					hash,
					args,
				},
			},
			binding,
			company,
		);
		const interrupted = readFileSync(binding.path, "utf-8").split(/\r?\n/).filter(Boolean).slice(0, 2);
		writeFileSync(binding.path, `${interrupted.join("\n")}\n`, "utf-8");
		const recoveryBinding = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		const pending: {
			file: string;
			hash: string;
			trailFile: string;
			phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted";
		} = { file: gateFile, hash, trailFile: binding.file, phase: "started" };
		let completed = 0;
		reconcileKernelGateCreations(
			recoveryBinding,
			company,
			[pending],
			(_file, _hash, trailFile, phase) => {
				pending.trailFile = trailFile;
				pending.phase = phase;
			},
			() => {
				completed++;
			},
		);
		expect(completed).toBe(1);
		expect(readFileSync(recoveryBinding.path, "utf-8")).toContain('"transition":"created","phase":"completed"');

		const secondRecovery = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		reconcileKernelGateCreations(
			secondRecovery,
			company,
			[pending],
			(_file, _hash, trailFile, phase) => {
				pending.trailFile = trailFile;
				pending.phase = phase;
			},
			() => {
				completed++;
			},
		);
		expect(completed).toBe(2);
		expect(readFileSync(secondRecovery.path, "utf-8")).not.toContain("qorpera_kernel_gate_transition");
	});

	it("reconciles a gate journal persisted before its started trail event", () => {
		const company = join(root, "company");
		writeCompanyManifest(company);
		const userData = join(root, "user-data");
		const interrupted = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		const recovery = bindTrailSession(company, company, { actor: "company-agent", attended: false });
		const file = "gate-aaaaaaaa.md";
		const hash = "a".repeat(64);
		beginCompanyGateCreation(userData, company, file, hash, interrupted.file);
		reconcileKernelGateCreations(
			recovery,
			company,
			listPendingCompanyGateCreations(userData, company),
			(gateFile, gateHash, trailFile, phase) =>
				advanceCompanyGateCreation(userData, company, gateFile, gateHash, trailFile, phase),
			(gateFile, gateHash) => completeCompanyGateCreation(userData, company, gateFile, gateHash),
		);
		const trail = readFileSync(recovery.path, "utf-8");
		expect(trail).toContain('"transition":"created","phase":"started"');
		expect(trail).toContain('"transition":"creation-aborted","phase":"completed"');
		expect(listPendingCompanyGateCreations(userData, company)).toEqual([]);
	});

	it("checkpoints content changed by the session while preserving untouched baseline dirt", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		writeFileSync(join(company, "founder.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		writeFileSync(join(company, "preexisting.md"), "founder work\n", "utf-8");
		writeFileSync(join(company, "shared.md"), "founder baseline\n", "utf-8");
		writeFileSync(join(company, "founder.md"), "founder staged\n", "utf-8");
		expect(spawnSync("git", ["add", "founder.md"], { cwd: company, stdio: "ignore" }).status).toBe(0);
		const baseline = captureCompanyGitBaseline(company);
		writeFileSync(join(company, "shared.md"), "founder baseline\nagent continuation\n", "utf-8");
		writeFileSync(join(company, "agent.md"), "agent work\n", "utf-8");
		writeFileSync(join(company, "trail", "session.jsonl"), "trail\n", "utf-8");
		expect(checkpointCompanyGit(company, baseline, "session.jsonl").success).toBe(true);
		const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: company, encoding: "utf-8" }).stdout;
		expect(log).toContain("Qorpera-Trigger: trail/session.jsonl");
		expect(log).toContain("Qorpera-Rationale:");
		expect(spawnSync("git", ["ls-files", "agent.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"agent.md",
		);
		expect(statSync(join(company, "preexisting.md")).isFile()).toBe(true);
		expect(spawnSync("git", ["ls-files", "preexisting.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"",
		);
		expect(spawnSync("git", ["ls-files", "shared.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"shared.md",
		);
		expect(
			spawnSync("git", ["ls-files", "trail/session.jsonl"], { cwd: company, encoding: "utf-8" }).stdout.trim(),
		).toBe("trail/session.jsonl");
		expect(
			spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: company, encoding: "utf-8" }).stdout,
		).toContain("founder.md");
	}, 30_000);

	it("snapshots every founder Git version before agent access and makes later deletion recoverable", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		writeFileSync(join(company, "founder.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md", "founder.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		writeFileSync(join(company, "founder.md"), "founder staged version\n", "utf-8");
		expect(spawnSync("git", ["add", "founder.md"], { cwd: company, stdio: "ignore" }).status).toBe(0);
		writeFileSync(join(company, "founder.md"), "founder working version\n", "utf-8");
		writeFileSync(join(company, "untracked.md"), "founder untracked version\n", "utf-8");

		snapshotFounderGitState(company);
		expect(spawnSync("git", ["status", "--porcelain=v1"], { cwd: company, encoding: "utf-8" }).stdout).toBe("");
		expect(spawnSync("git", ["show", "HEAD~1:founder.md"], { cwd: company, encoding: "utf-8" }).stdout).toBe(
			"founder staged version\n",
		);
		expect(spawnSync("git", ["show", "HEAD:founder.md"], { cwd: company, encoding: "utf-8" }).stdout).toBe(
			"founder working version\n",
		);
		expect(spawnSync("git", ["show", "HEAD:untracked.md"], { cwd: company, encoding: "utf-8" }).stdout).toBe(
			"founder untracked version\n",
		);

		const baseline = captureCompanyGitBaseline(company);
		rmSync(join(company, "untracked.md"));
		expect(checkpointCompanyGit(company, baseline, "session.jsonl").success).toBe(true);
		expect(spawnSync("git", ["show", "HEAD~1:untracked.md"], { cwd: company, encoding: "utf-8" }).stdout).toBe(
			"founder untracked version\n",
		);
		expect(existsSync(join(company, "untracked.md"))).toBe(false);
	}, 30_000);

	it("snapshots founder product state before a worker and checkpoints its uncommitted result", () => {
		const company = join(root, "company");
		const { worktree, trailPath, assignmentPath } = createProductCheckpointFixture(company);
		writeFileSync(join(worktree, "founder-notes.md"), "retain this\n", "utf-8");
		snapshotFounderGitState(worktree, "product-worker");
		const baseline = captureCompanyGitBaseline(worktree);
		writeFileSync(join(worktree, "product.ts"), "export const value = 2;\n", "utf-8");
		const escaped = join(root, "escaped-from-hook.txt");
		writeFileSync(
			join(worktree, ".git", "hooks", "pre-commit"),
			`#!/bin/sh\nprintf escaped > "${escaped}"\n`,
			"utf-8",
		);

		expect(checkpointProductWorktreeGit(company, worktree, baseline, trailPath).success).toBe(true);
		expect(existsSync(escaped)).toBe(false);
		expect(spawnSync("git", ["show", "HEAD~1:founder-notes.md"], { cwd: worktree, encoding: "utf-8" }).stdout).toBe(
			"retain this\n",
		);
		expect(spawnSync("git", ["show", "HEAD:product.ts"], { cwd: worktree, encoding: "utf-8" }).stdout).toBe(
			"export const value = 2;\n",
		);
		expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: worktree, encoding: "utf-8" }).stdout).toContain(
			`Qorpera-Trigger: ${trailPath}`,
		);
		const assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as {
			recoveryHead: string;
			recoveryBundles: Array<{ path: string; head: string; baseHead?: string }>;
		};
		expect(assignment.recoveryHead).toBe(
			spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf-8" }).stdout.trim(),
		);
		expect(assignment.recoveryBundles).toHaveLength(1);
		const recoveryBundle = assignment.recoveryBundles[0].path;
		expect(assignment.recoveryBundles[0]).toMatchObject({ head: assignment.recoveryHead });
		expect(existsSync(join(company, recoveryBundle))).toBe(true);
		expect(spawnSync("git", ["ls-files", recoveryBundle], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			recoveryBundle,
		);
	}, 30_000);

	it("stores one full recovery bundle followed by content-addressed incremental bundles", () => {
		const company = join(root, "company");
		const { worktree, trailPath, assignmentPath } = createProductCheckpointFixture(company);
		let baseline = captureCompanyGitBaseline(worktree);
		writeFileSync(join(worktree, "product.ts"), "export const value = 2;\n", "utf-8");
		expect(checkpointProductWorktreeGit(company, worktree, baseline, trailPath).success).toBe(true);
		const first = JSON.parse(readFileSync(assignmentPath, "utf-8")) as {
			recoveryHead: string;
			recoveryBundles: Array<{ path: string; head: string; baseHead?: string }>;
			recoveryUpdatedAt: string;
		};
		expect(first.recoveryBundles).toHaveLength(1);

		baseline = captureCompanyGitBaseline(worktree);
		writeFileSync(join(worktree, "product.ts"), "export const value = 3;\n", "utf-8");
		expect(checkpointProductWorktreeGit(company, worktree, baseline, trailPath).success).toBe(true);
		const second = JSON.parse(readFileSync(assignmentPath, "utf-8")) as typeof first;
		expect(second.recoveryBundles).toHaveLength(2);
		expect(second.recoveryBundles[1]).toMatchObject({ baseHead: first.recoveryHead, head: second.recoveryHead });
		const incrementalHeader = readFileSync(join(company, second.recoveryBundles[1].path))
			.subarray(0, 4096)
			.toString("utf-8");
		expect(incrementalHeader).toContain(`-${first.recoveryHead} `);
		expect(
			second.recoveryBundles.every((bundle) => /^[a-f0-9]{32}\.bundle$/.test(bundle.path.split("/").at(-1)!)),
		).toBe(true);

		const companyHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: company, encoding: "utf-8" }).stdout.trim();
		second.recoveryUpdatedAt = new Date(Date.now() + 1_000).toISOString();
		writeFileSync(assignmentPath, `${JSON.stringify(second, null, "\t")}\n`, "utf-8");
		expect(spawnSync("git", ["add", assignmentPath], { cwd: company, stdio: "ignore" }).status).toBe(0);
		expect(
			checkpointProductWorktreeGit(company, worktree, captureCompanyGitBaseline(worktree), trailPath).success,
		).toBe(true);
		expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: company, encoding: "utf-8" }).stdout.trim()).not.toBe(
			companyHead,
		);
		expect(
			spawnSync("git", ["show", "HEAD:.qorpera/product-worktrees/widget-development/20260810000000-aaaaaaaa.json"], {
				cwd: company,
				encoding: "utf-8",
			}).stdout,
		).toContain(second.recoveryUpdatedAt);
	}, 30_000);

	it("rejects recovery success after a worker leaves its assigned branch", () => {
		const company = join(root, "company");
		const { worktree, trailPath, assignmentPath } = createProductCheckpointFixture(company);
		expect(spawnSync("git", ["switch", "-c", "unassigned"], { cwd: worktree, stdio: "ignore" }).status).toBe(0);
		const baseline = captureCompanyGitBaseline(worktree);
		writeFileSync(join(worktree, "product.ts"), "export const value = 4;\n", "utf-8");
		expect(checkpointProductWorktreeGit(company, worktree, baseline, trailPath).success).toBe(false);
		const assignment = JSON.parse(readFileSync(assignmentPath, "utf-8")) as { recoveryBundles: unknown[] };
		expect(assignment.recoveryBundles).toEqual([]);
	}, 30_000);

	it("fails closed before repository-local filters can execute in a kernel Git process", () => {
		const worktree = join(root, "filter-worktree");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, "product.ts"), "export const value = 1;\n", "utf-8");
		for (const args of [
			["init"],
			["add", "product.ts"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: worktree, stdio: "ignore" }).status).toBe(0);
		}
		const escaped = join(root, "escaped-from-filter.txt");
		expect(
			spawnSync(
				"git",
				[
					"config",
					"--local",
					"filter.hostile.clean",
					`node -e require('fs').writeFileSync('${escaped}','escaped')`,
				],
				{
					cwd: worktree,
					stdio: "ignore",
				},
			).status,
		).toBe(0);
		writeFileSync(join(worktree, ".gitattributes"), "*.ts filter=hostile\n", "utf-8");
		expect(() => captureCompanyGitBaseline(worktree)).toThrow("repository-local Git execution config");
		expect(existsSync(escaped)).toBe(false);
	});

	it("reconciles a durable checkpoint left by an interrupted agent", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		const baseline = captureCompanyGitBaseline(company);
		const checkpointDir = join(root, "checkpoint-state");
		const statePath = join(checkpointDir, "interrupted.json");
		savePendingCompanyCheckpoint(statePath, company, baseline, "interrupted.jsonl");
		writeFileSync(join(company, "recovered.md"), "preserve me\n", "utf-8");
		reconcilePendingCompanyCheckpoints(checkpointDir, company);
		expect(existsSync(statePath)).toBe(false);
		expect(spawnSync("git", ["ls-files", "recovered.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"recovered.md",
		);
	}, 30_000);

	it("reconciles interrupted product work against its exact company trail provenance", () => {
		const company = join(root, "company");
		const { worktree, trailPath } = createProductCheckpointFixture(company);
		const baseline = captureCompanyGitBaseline(worktree);
		const checkpointDir = join(root, "checkpoint-state");
		const statePath = join(checkpointDir, "interrupted.product.json");
		savePendingProductCheckpoint(statePath, company, worktree, baseline, trailPath);
		writeFileSync(join(worktree, "product.ts"), "export const value = 2;\n", "utf-8");

		reconcilePendingProductCheckpoints(checkpointDir, company);
		expect(existsSync(statePath)).toBe(false);
		expect(spawnSync("git", ["show", "HEAD:product.ts"], { cwd: worktree, encoding: "utf-8" }).stdout).toBe(
			"export const value = 2;\n",
		);
		expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: worktree, encoding: "utf-8" }).stdout).toContain(
			`Qorpera-Trigger: ${trailPath}`,
		);
	}, 30_000);

	it("commits removal of a legacy company shell before staff execution", () => {
		const company = join(root, "company");
		mkdirSync(join(company, "userland"), { recursive: true });
		writeFileSync(join(company, "seed.md"), "existing repository\n", "utf-8");
		writeFileSync(join(company, "userland", "index.html"), "legacy shell\n", "utf-8");
		for (const args of [
			["init"],
			["add", "seed.md", "userland/index.html"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		rmSync(join(company, "userland"), { recursive: true, force: true });
		commitCompanyMaterialization(company, ["userland"]);
		expect(
			spawnSync("git", ["ls-files", "userland/index.html"], { cwd: company, encoding: "utf-8" }).stdout.trim(),
		).toBe("");
		expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: company, encoding: "utf-8" }).stdout).toContain(
			"Qorpera-Trigger: desktop host open",
		);
	});
});
