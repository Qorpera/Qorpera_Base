import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import {
	buildPreflightCheckCommand,
	codeChecksTail,
	MAX_CODE_CHECKS_FILE_BYTES,
	parseCodeChangesIndex,
	parseCodeChecksText,
} from "@qorpera/runtime/cloud-code-checks";
import { type CloudCodingCommandGateway, cloudCodingCommandTools } from "@qorpera/runtime/cloud-coding-command-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	type CloudNativeToolOperationControlPlane,
	CloudNativeToolOperations,
	cloudNativeToolOperationEnvelope,
} from "@qorpera/runtime/cloud-native-tool-operations";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function receiptOf(
	workerId: string,
	commandId: string,
	inputSha256: string,
	over: Partial<{
		state: "running" | "succeeded" | "failed" | "cancelled" | "machine_stopped";
		exitCode: number | null;
		output: string;
		truncated: boolean;
		offset: number;
		nextOffset: number;
		totalBytes: number;
	}> = {},
) {
	const output = over.output ?? "";
	const bytes = Buffer.byteLength(output, "utf8");
	const offset = over.offset ?? 0;
	const nextOffset = over.nextOffset ?? offset + bytes;
	const totalBytes = over.totalBytes ?? nextOffset;
	return {
		schema: "qorpera.coding-command-result/v2",
		workerId,
		commandId,
		inputSha256,
		state: over.state ?? "succeeded",
		exitCode:
			over.exitCode !== undefined
				? over.exitCode
				: (over.state ?? "succeeded") === "succeeded"
					? 0
					: (over.state ?? "succeeded") === "failed"
						? 1
						: null,
		output,
		truncated: over.truncated ?? nextOffset < totalBytes,
		log: {
			offset,
			nextOffset,
			totalBytes,
			limitBytes: 67_108_864,
			limitReached: false,
		},
	};
}

describe("parseCodeChecksText", () => {
	it("parses JSONC with comments, defaults, needs DAG and valid site", () => {
		const text = `{
			// single-line comment
			"$schema": "https://qorpera.com/schemas/checks.json",
			/* multi-line
			   comment */
			"checks": [
				{ "name": "install", "run": "npm ci", "timeoutSeconds": 180 },
				{ "name": "lint", "run": "npm run lint", "needs": ["install"] },
				{ "name": "test", "run": "npm test", "cwd": "packages/app", "needs": ["install"], "timeoutSeconds": 300 },
				{ "name": "build", "run": "npm run build", "needs": ["lint", "test"] }
			],
			"site": { "folder": "dist", "name": "acme-shop", "title": "Acme Shop" }
		}`;
		expect(parseCodeChecksText(text)).toEqual({
			ok: true,
			mode: "dag",
			totalTimeoutSeconds: 1680,
			checks: [
				{ name: "install", run: "npm ci", timeoutSeconds: 180, cwd: "." },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 600, cwd: ".", needs: ["install"] },
				{ name: "test", run: "npm test", timeoutSeconds: 300, cwd: "packages/app", needs: ["install"] },
				{ name: "build", run: "npm run build", timeoutSeconds: 600, cwd: ".", needs: ["lint", "test"] },
			],
			site: { folder: "dist", name: "acme-shop", title: "Acme Shop" },
		});
	});

	it("returns sequential mode when no check declares needs", () => {
		const parsed = parseCodeChecksText('{"checks":[{"name":"test","run":"npm test"}]}');
		expect(parsed).toEqual({
			ok: true,
			mode: "sequential",
			totalTimeoutSeconds: 600,
			checks: [{ name: "test", run: "npm test", timeoutSeconds: 600, cwd: "." }],
			site: null,
		});
	});

	it("rejects oversized files, syntax errors, trailing commas and duplicate keys", () => {
		expect(parseCodeChecksText(" ".repeat(MAX_CODE_CHECKS_FILE_BYTES + 1))).toMatchObject({
			ok: false,
			problems: [{ code: "TOO_LARGE" }],
		});
		for (const bad of [
			'{"checks":[{"name":"a","run":"true",}]}',
			'{"checks":[{"name":"a","run":"true"},]}',
			'{"checks":[{"name":"a","run":"true"}],"checks":[]}',
			'{"checks":[] /* unclosed',
			'{"checks":[{"name":"a","run":"bad\tcontrol"}]}',
			'{"checks":[{"name":"a","run":"\\uD800"}]}',
			'{"checks":[{"name":"a","run":"true"}]} trailing',
		]) {
			const res = parseCodeChecksText(bad);
			expect(res.ok, bad).toBe(false);
			if (!res.ok) expect(res.problems[0]?.code, bad).toBe("SYNTAX");
		}
	});

	it("validates check schema rules, timeout totals, cwd paths and site rules", () => {
		expect(parseCodeChecksText("[]")).toMatchObject({ ok: false, problems: [{ code: "WRONG_TYPE" }] });
		expect(parseCodeChecksText("{}")).toMatchObject({ ok: false, problems: [{ code: "MISSING_KEY" }] });
		expect(parseCodeChecksText('{"checks":[],"extra":1}')).toMatchObject({
			ok: false,
			problems: expect.arrayContaining([
				expect.objectContaining({ at: "/checks", code: "INVALID_VALUE" }),
				expect.objectContaining({ at: "/extra", code: "UNKNOWN_KEY" }),
			]),
		});
		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "BadName", run: "true" },
						{ name: "dup", run: "true" },
						{ name: "dup", run: "true" },
						{ name: "bad-time", run: "true", timeoutSeconds: 9 },
						{ name: "bad-cwd", run: "true", cwd: "../escape" },
						{ name: "abs-cwd", run: "true", cwd: "/tmp" },
					],
				}),
			),
		).toMatchObject({
			ok: false,
			problems: expect.arrayContaining([
				expect.objectContaining({ at: "/checks/0/name", code: "INVALID_VALUE" }),
				expect.objectContaining({ at: "/checks/2/name", code: "DUPLICATE" }),
				expect.objectContaining({ at: "/checks/3/timeoutSeconds", code: "INVALID_VALUE" }),
				expect.objectContaining({ at: "/checks/4/cwd", code: "INVALID_PATH" }),
				expect.objectContaining({ at: "/checks/5/cwd", code: "INVALID_PATH" }),
			]),
		});
		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "c1", run: "true", timeoutSeconds: 1800 },
						{ name: "c2", run: "true", timeoutSeconds: 1800 },
						{ name: "c3", run: "true", timeoutSeconds: 10 },
					],
				}),
			),
		).toMatchObject({
			ok: false,
			problems: [expect.objectContaining({ at: "/checks", code: "TOO_LONG" })],
		});
		for (const site of [
			{},
			{ folder: "../dist" },
			{ folder: "dist", name: "api" },
			{ folder: "dist", name: "my--site" },
			{ folder: "dist", name: "shop-preview" },
			{ folder: "dist", name: "qorpera-shop" },
			{ folder: "dist", title: " Leading space" },
			{ folder: "dist", title: "a".repeat(121) },
		]) {
			const res = parseCodeChecksText(JSON.stringify({ checks: [{ name: "build", run: "true" }], site }));
			expect(res.ok, JSON.stringify(site)).toBe(false);
		}
	});

	it("detects unknown dependencies, self-dependencies, duplicates and dependency cycles", () => {
		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "a", run: "true", needs: ["a"] },
						{ name: "b", run: "true", needs: ["missing", "a", "a"] },
					],
				}),
			),
		).toMatchObject({
			ok: false,
			problems: expect.arrayContaining([
				expect.objectContaining({ code: "SELF_DEPENDENCY" }),
				expect.objectContaining({ code: "UNKNOWN_DEPENDENCY" }),
				expect.objectContaining({ code: "DUPLICATE" }),
			]),
		});
		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "a", run: "true", needs: ["b"] },
						{ name: "b", run: "true", needs: ["a"] },
					],
				}),
			),
		).toMatchObject({
			ok: false,
			problems: [expect.objectContaining({ code: "CYCLE" })],
		});
		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "a", run: "true", needs: ["c"] },
						{ name: "b", run: "true", needs: ["a"] },
						{ name: "c", run: "true", needs: ["b"] },
					],
				}),
			),
		).toMatchObject({
			ok: false,
			problems: [expect.objectContaining({ code: "CYCLE" })],
		});
	});
});

describe("parseCodeChangesIndex, codeChecksTail and buildPreflightCheckCommand", () => {
	it("parses notices, total count and bounded recent changes from changes/index.md", () => {
		const index = [
			"# Changes",
			"Put back to an earlier copy on 2026-11-10.",
			"Live: https://shop-demo.qorpera.com/ (change 4)",
			"- 5 · 2026-11-21 · ready · Fifth change",
			"- 4 · 2026-11-20 · live · Fourth change",
			"- 3 · 2026-11-19 · undone · Third change",
		].join("\n");
		expect(parseCodeChangesIndex(index, 2)).toEqual({
			notices: ["Put back to an earlier copy on 2026-11-10.", "Live: https://shop-demo.qorpera.com/ (change 4)"],
			totalListed: 3,
			changes: [
				{ change: 5, date: "2026-11-21", state: "ready", summary: "Fifth change" },
				{ change: 4, date: "2026-11-20", state: "live", summary: "Fourth change" },
			],
		});
	});

	it("bounds and sanitizes output tails", () => {
		const many = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\r\n");
		const tail = codeChecksTail(many);
		expect(tail.split("\n")).toHaveLength(30);
		expect(tail.startsWith("line-20\n")).toBe(true);
		expect(tail.endsWith("\nline-49")).toBe(true);
		expect(codeChecksTail("ok\u0007\u202Ebad\uD800end")).toBe("ok\uFFFD\uFFFDbad\uFFFDend");
		const longLine = codeChecksTail("x".repeat(3000), 64);
		expect(longLine.startsWith("…")).toBe(true);
		expect(Buffer.byteLength(longLine, "utf8")).toBeLessThanOrEqual(64);
	});

	it("builds isolated check commands with CI=true, QORPERA_CHECKS=1, closed stdin and shell quoting", () => {
		expect(buildPreflightCheckCommand({ cwd: ".", run: "echo 'hi'" })).toBe(
			`CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c 'echo '\\''hi'\\''' </dev/null`,
		);
		expect(buildPreflightCheckCommand({ cwd: "apps/web", run: "npm test" })).toBe(
			`( cd -- 'apps/web' && CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c 'npm test' </dev/null )`,
		);
	});
});

describe("coding_run_command runChecks pre-flight runner", () => {
	async function preflightFixture(options: {
		onStart: (
			input: { commandId: string; inputSha256: string; command: string; timeoutMs: number | null },
			ctx: { workerId: string },
		) => Promise<unknown> | unknown;
		onRead?: (
			input: { commandId: string; offset?: number; limit?: number; tail?: boolean },
			ctx: { workerId: string },
		) => Promise<unknown> | unknown;
		onCancel?: (commandId: string, ctx: { workerId: string }) => Promise<unknown> | unknown;
		authorize?: CloudCodingCommandGateway["authorize"];
		pollMs?: number;
		timeoutGraceMs?: number;
	}) {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
		const begunOperations: {
			logicalOperationKey: string;
			inputSha256: string;
			receiptId: string;
			idempotencyKey: string;
		}[] = [];
		const ledger = new Map<string, { receiptId: string; inputSha256: string; result: JsonValue | null }>();
		const control: CloudNativeToolOperationControlPlane = {
			beginToolOperation: vi.fn(async (b, input) => {
				begunOperations.push({
					logicalOperationKey: input.logicalOperationKey,
					inputSha256: input.inputSha256,
					receiptId: input.receiptId,
					idempotencyKey: input.idempotencyKey,
				});
				let row = ledger.get(input.logicalOperationKey);
				if (!row) {
					row = { receiptId: input.receiptId, inputSha256: input.inputSha256, result: null };
					ledger.set(input.logicalOperationKey, row);
				}
				return {
					run_id: b.runId,
					receipt_id: row.receiptId,
					state: row.result === null ? "executing" : "completed",
					result: row.result,
					output_snapshot_id: null,
					proposal_id: null,
					folder_commit_id: null,
				};
			}),
			completeToolOperation: vi.fn(async (b, input) => {
				const row = [...ledger.values()].find((r) => r.receiptId === input.receiptId);
				if (!row) throw new Error("missing receipt");
				row.result = structuredClone(input.result);
				return {
					run_id: b.runId,
					receipt_id: input.receiptId,
					state: "completed",
					result: input.result,
				};
			}),
		};
		const abort = new AbortController();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => structuredClone(authority) },
			abort.signal,
		);
		const operations = new CloudNativeToolOperations(run, control);
		const gateway: CloudCodingCommandGateway = {
			authorize: vi.fn<CloudCodingCommandGateway["authorize"]>(options.authorize ?? (async () => undefined)),
			start: vi.fn<CloudCodingCommandGateway["start"]>(async (_scope, input) =>
				options.onStart(input, { workerId: scope.workerId }),
			),
			read: vi.fn<CloudCodingCommandGateway["read"]>(async (_scope, input) => {
				if (options.onRead) return options.onRead(input, { workerId: scope.workerId });
				throw new Error(`Unexpected read for ${input.commandId}`);
			}),
			cancel: vi.fn<CloudCodingCommandGateway["cancel"]>(async (_scope, commandId) => {
				if (options.onCancel) return options.onCancel(commandId, { workerId: scope.workerId });
				return receiptOf(scope.workerId, commandId, "a".repeat(64), { state: "cancelled", exitCode: null });
			}),
		};
		const tools = cloudCodingCommandTools({
			scope,
			identity,
			operations,
			gateway,
			pollMs: options.pollMs ?? 5,
			timeoutGraceMs: options.timeoutGraceMs ?? 25,
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: identity.companyId,
			runId: identity.runId,
			identity,
			tools,
			assertActive: (signal) => run.assertActive(signal),
			signal: abort.signal,
		});
		const invoke = async (args: Record<string, unknown>) => {
			const response = await boundary.invoke(`pf_${randomUUID()}`, "qorpera", "coding_run_command", args);
			const envelope = JSON.parse(response.contentItems[0].text);
			return {
				success: response.success,
				status: envelope.status as string,
				truncated: envelope.content.truncated as boolean,
				text: envelope.content.text as string,
			};
		};
		return { scope, identity, run, boundary, gateway, begunOperations, invoke };
	}

	it.each([
		[44, "missing", undefined],
		[45, "invalid", "NOT_A_FILE"],
		[46, "invalid", "TOO_LARGE"],
	])("handles checks file read exit code %i as %s", async (exitCode, state, problemCode) => {
		const f = await preflightFixture({
			onStart: (input, ctx) =>
				receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "failed", exitCode }),
		});
		try {
			const result = await f.invoke({ operationKey: `read-${exitCode}`, runChecks: true });
			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.text);
			expect(parsed.state).toBe(state);
			if (problemCode) expect(parsed.problems[0]?.code).toBe(problemCode);
		} finally {
			f.boundary.close();
			f.run.close();
		}
	});

	it("returns invalid problems when .qorpera/checks.json fails validation without running checks", async () => {
		const f = await preflightFixture({
			onStart: (input, ctx) =>
				receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "succeeded",
					output: '{"checks":[]}',
				}),
		});
		try {
			const result = await f.invoke({ operationKey: "bad-json", runChecks: true });
			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.text);
			expect(parsed).toMatchObject({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "invalid",
				problems: [{ at: "/checks", code: "INVALID_VALUE" }],
			});
			expect(f.gateway.start).toHaveBeenCalledTimes(1);
		} finally {
			f.boundary.close();
			f.run.close();
		}
	});

	it("runs sequential checks in order with CI=true QORPERA_CHECKS=1 and matches command-authority digest parity", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "lint", run: "npm run lint", timeoutSeconds: 60 },
				{ name: "test", run: "npm test", cwd: "apps/web", timeoutSeconds: 120 },
			],
			site: { folder: "dist", name: "acme-app", title: "Acme App" },
		});
		const startedCommands: {
			commandId: string;
			inputSha256: string;
			command: string;
			timeoutMs: number | null;
		}[] = [];
		const f = await preflightFixture({
			onStart: (input, ctx) => {
				startedCommands.push({ ...input });
				if (startedCommands.length === 1) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "succeeded",
					output: "ok\n",
				});
			},
		});
		try {
			const result = await f.invoke({ operationKey: "seq-pass", runChecks: true });
			expect(result).toMatchObject({ success: true, status: "ok", truncated: false });
			const parsed = JSON.parse(result.text);
			expect(parsed).toMatchObject({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "passed",
				mode: "sequential",
				notRun: [],
				skipped: [],
				site: { folder: "dist", name: "acme-app", title: "Acme App" },
			});
			expect(parsed.checks).toMatchObject([
				{ name: "lint", cwd: ".", status: "passed", exitCode: 0 },
				{ name: "test", cwd: "apps/web", status: "passed", exitCode: 0 },
			]);
			expect(startedCommands[1]).toMatchObject({
				command: `CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c 'npm run lint' </dev/null`,
				timeoutMs: 60_000,
			});
			expect(startedCommands[2]).toMatchObject({
				command: `( cd -- 'apps/web' && CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c 'npm test' </dev/null )`,
				timeoutMs: 120_000,
			});
			expect(f.begunOperations).toHaveLength(3);
			for (const [index, op] of f.begunOperations.entries()) {
				const sent = startedCommands[index]!;
				expect(op.logicalOperationKey.startsWith("coding_run_command:pf:")).toBe(true);
				expect(sent.commandId).toBe(op.receiptId);
				expect(sent.inputSha256).toBe(op.inputSha256);
				const subKey = op.logicalOperationKey.slice("coding_run_command:".length);
				const expectedDigest = createHash("sha256")
					.update(
						cloudNativeToolOperationEnvelope(f.identity, {
							tool: "coding_run_command",
							toolVersion: "v1",
							logicalOperationKey: subKey,
							arguments: {
								operationKey: subKey,
								command: sent.command,
								...(sent.timeoutMs === null ? {} : { timeoutMs: sent.timeoutMs }),
							},
							target: { schema: "qorpera.coding-command-target/v1", ...f.scope },
							requiresCompanyRevision: false,
						}),
					)
					.digest("hex");
				expect(op.inputSha256).toBe(expectedDigest);
			}
		} finally {
			f.boundary.close();
			f.run.close();
		}
	});

	it("stops after first failure by default (failFast:true) with redacted output tail, and runs all when failFast:false", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "lint", run: "npm run lint" },
				{ name: "test", run: "npm test" },
				{ name: "build", run: "npm run build" },
			],
		});
		const secret = "whsec_TESTCHECKTAILSECRET99999";
		const runOnce = async (failFast: boolean) => {
			let call = 0;
			const commandLog = new Map<string, string>();
			const f = await preflightFixture({
				onStart: (input, ctx) => {
					call++;
					if (call === 1) {
						return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
							state: "succeeded",
							output: checksFile,
						});
					}
					if (input.command.includes("npm run lint")) {
						const fullLog = `ERR header\n${"x".repeat(500)}\nAssertion failed with ${secret}\n`;
						commandLog.set(input.commandId, fullLog);
						return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
							state: "failed",
							exitCode: 2,
							output: fullLog.slice(0, 10),
							offset: 0,
							nextOffset: 10,
							totalBytes: Buffer.byteLength(fullLog, "utf8"),
							truncated: true,
						});
					}
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: "passed\n",
					});
				},
				onRead: (input, ctx) => {
					const full = commandLog.get(input.commandId) ?? "";
					return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), {
						state: "failed",
						exitCode: 2,
						output: full,
					});
				},
			});
			try {
				const result = await f.invoke({ operationKey: `ff-${String(failFast)}`, runChecks: true, failFast });
				return JSON.parse(result.text);
			} finally {
				f.boundary.close();
				f.run.close();
			}
		};

		const fast = await runOnce(true);
		expect(fast.state).toBe("failed");
		expect(fast.checks).toHaveLength(1);
		expect(fast.checks[0]).toMatchObject({ name: "lint", status: "failed", exitCode: 2 });
		expect(fast.checks[0].tail).toContain("whsec_[REDACTED]");
		expect(fast.checks[0].tail).not.toContain(secret);
		expect(fast.notRun).toEqual(["test", "build"]);
		expect(fast.skipped).toEqual([]);

		const all = await runOnce(false);
		expect(all.state).toBe("failed");
		expect(all.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
			["lint", "failed"],
			["test", "passed"],
			["build", "passed"],
		]);
		expect(all.notRun).toEqual([]);
		expect(all.skipped).toEqual([]);
	});

	it("runs parallel needs DAG waves concurrently and waits for all parents before downstream checks", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "lint", run: "npm run lint", needs: ["install"] },
				{ name: "typecheck", run: "npm run typecheck", needs: ["install"] },
				{ name: "build", run: "npm run build", needs: ["lint", "typecheck"] },
			],
		});
		let activeChecks = 0;
		let maxConcurrent = 0;
		const finished = new Set<string>();
		const runningChecks = new Map<string, { name: string; pollsLeft: number; inputSha256: string }>();
		const f = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				const name = input.command.includes("npm ci")
					? "install"
					: input.command.includes("npm run lint")
						? "lint"
						: input.command.includes("npm run typecheck")
							? "typecheck"
							: "build";
				if (name === "build") {
					expect(finished.has("lint")).toBe(true);
					expect(finished.has("typecheck")).toBe(true);
				}
				activeChecks++;
				maxConcurrent = Math.max(maxConcurrent, activeChecks);
				runningChecks.set(input.commandId, {
					name,
					pollsLeft: name === "lint" || name === "typecheck" ? 2 : 1,
					inputSha256: input.inputSha256,
				});
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
			},
			onRead: (input, ctx) => {
				const entry = runningChecks.get(input.commandId)!;
				entry.pollsLeft--;
				if (entry.pollsLeft > 0) {
					return receiptOf(ctx.workerId, input.commandId, entry.inputSha256, { state: "running", exitCode: null });
				}
				activeChecks--;
				finished.add(entry.name);
				return receiptOf(ctx.workerId, input.commandId, entry.inputSha256, { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const result = await f.invoke({ operationKey: "dag-wave", runChecks: true });
			const parsed = JSON.parse(result.text);
			expect(parsed.state).toBe("passed");
			expect(parsed.mode).toBe("dag");
			expect(maxConcurrent).toBe(2);
			expect(parsed.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
				["install", "passed"],
				["lint", "passed"],
				["typecheck", "passed"],
				["build", "passed"],
			]);
		} finally {
			f.boundary.close();
			f.run.close();
		}
	});

	it("cancels running wave siblings on DAG failFast:true and skips transitive dependents on DAG failFast:false", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "a", run: "run-a", needs: [] },
				{ name: "b", run: "run-b", needs: [] },
				{ name: "c", run: "run-c", needs: ["a"] },
				{ name: "d", run: "run-d", needs: ["c"] },
			],
		});
		const states = new Map<string, { name: string; polls: number; inputSha256: string }>();
		const cancelledIds: string[] = [];
		const tailReadIds: string[] = [];
		const fastFixture = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				const name = input.command.includes("run-a") ? "a" : "b";
				states.set(input.commandId, { name, polls: 0, inputSha256: input.inputSha256 });
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
			},
			onRead: (input, ctx) => {
				if (input.tail) tailReadIds.push(input.commandId);
				const entry = states.get(input.commandId)!;
				entry.polls++;
				if (entry.name === "a") {
					return receiptOf(ctx.workerId, input.commandId, entry.inputSha256, {
						state: "failed",
						exitCode: 1,
						output: "a failed\n",
					});
				}
				return receiptOf(ctx.workerId, input.commandId, entry.inputSha256, { state: "running", exitCode: null });
			},
			onCancel: (commandId, ctx) => {
				cancelledIds.push(commandId);
				const entry = states.get(commandId)!;
				return receiptOf(ctx.workerId, commandId, entry.inputSha256, { state: "cancelled", exitCode: null });
			},
		});
		try {
			const res = await fastFixture.invoke({ operationKey: "dag-ff-true", runChecks: true, failFast: true });
			const parsed = JSON.parse(res.text);
			expect(parsed.state).toBe("failed");
			expect(cancelledIds).toHaveLength(1);
			expect(tailReadIds).not.toContain(cancelledIds[0]);
			expect(parsed.checks).toMatchObject([
				{ name: "a", status: "failed", exitCode: 1, tail: "a failed" },
				{ name: "b", status: "cancelled", exitCode: null },
			]);
			expect(parsed.checks[1].tail).toBeUndefined();
			expect(parsed.notRun).toEqual(["c", "d"]);
		} finally {
			fastFixture.boundary.close();
			fastFixture.run.close();
		}

		const fullFixture = await preflightFixture({
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				if (input.command.includes("run-a")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "failed",
						exitCode: 1,
						output: "boom\n",
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "succeeded",
					output: "ok\n",
				});
			},
		});
		try {
			const res = await fullFixture.invoke({ operationKey: "dag-ff-false", runChecks: true, failFast: false });
			const parsed = JSON.parse(res.text);
			expect(parsed.state).toBe("failed");
			expect(parsed.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
				["a", "failed"],
				["b", "passed"],
			]);
			expect(parsed.skipped).toEqual([
				{ name: "c", blockedBy: ["a"] },
				{ name: "d", blockedBy: ["c"] },
			]);
			expect(parsed.notRun).toEqual([]);
		} finally {
			fullFixture.boundary.close();
			fullFixture.run.close();
		}
	});

	it("supports checkNames subset selection and reports unknown check names with availableChecks", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "test", run: "npm test", needs: ["install"] },
				{ name: "build", run: "npm run build", needs: ["test"] },
			],
		});
		const f = await preflightFixture({
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const unknown = JSON.parse(
				(await f.invoke({ operationKey: "sub-bad", runChecks: true, checkNames: ["nope"] })).text,
			);
			expect(unknown).toMatchObject({
				state: "invalid",
				problems: [{ code: "UNKNOWN_CHECK" }],
				availableChecks: ["install", "test", "build"],
			});
			const subset = JSON.parse(
				(await f.invoke({ operationKey: "sub-ok", runChecks: true, checkNames: ["test"] })).text,
			);
			expect(subset.state).toBe("passed");
			expect(subset.checks).toHaveLength(1);
			expect(subset.checks[0].name).toBe("test");
		} finally {
			f.boundary.close();
			f.run.close();
		}
	});

	it("enforces timeout with cancellation, reports machine_stopped as not_run, and refuses after authority revocation", async () => {
		const checksFile = JSON.stringify({
			checks: [{ name: "slow", run: "sleep 30", timeoutSeconds: 10 }],
		});
		let cancelled = false;
		let checkSha = "";
		vi.useFakeTimers();
		try {
			const f = await preflightFixture({
				pollMs: 1000,
				timeoutGraceMs: 500,
				onStart: (input, ctx) => {
					if (input.command.includes(".qorpera/checks.json")) {
						return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
							state: "succeeded",
							output: checksFile,
						});
					}
					checkSha = input.inputSha256;
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
				},
				onRead: (input, ctx) =>
					receiptOf(ctx.workerId, input.commandId, checkSha, {
						state: "running",
						exitCode: null,
						output: "still waiting...\n",
					}),
				onCancel: (commandId, ctx) => {
					cancelled = true;
					return receiptOf(ctx.workerId, commandId, checkSha, {
						state: "cancelled",
						exitCode: null,
						output: "timed out output\n",
					});
				},
			});
			try {
				const pending = f.invoke({ operationKey: "timeout-1", runChecks: true });
				await vi.advanceTimersByTimeAsync(15_000);
				const parsed = JSON.parse((await pending).text);
				expect(cancelled).toBe(true);
				expect(parsed.state).toBe("failed");
				expect(parsed.checks[0]).toMatchObject({
					name: "slow",
					status: "failed",
					timedOut: true,
					tail: "timed out output",
				});
			} finally {
				f.boundary.close();
				f.run.close();
			}
		} finally {
			vi.useRealTimers();
		}

		const stopped = await preflightFixture({
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "machine_stopped",
					exitCode: null,
					output: "partial\n",
				});
			},
		});
		try {
			const parsed = JSON.parse((await stopped.invoke({ operationKey: "stopped-1", runChecks: true })).text);
			expect(parsed.state).toBe("not_run");
			expect(parsed.checks[0]).toMatchObject({ name: "slow", status: "machine_stopped" });
		} finally {
			stopped.boundary.close();
			stopped.run.close();
		}

		let authCalls = 0;
		const revoked = await preflightFixture({
			authorize: async () => {
				authCalls++;
				if (authCalls >= 4) throw new Error("revoked");
			},
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const result = await revoked.invoke({ operationKey: "revoked-1", runChecks: true });
			expect(result.success).toBe(false);
		} finally {
			revoked.boundary.close();
			revoked.run.close();
		}
	});
});
