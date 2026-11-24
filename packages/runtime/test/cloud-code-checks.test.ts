import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import {
	buildPreflightCheckCommand,
	codeChecksTail,
	MAX_CODE_CHECKS_FILE_BYTES,
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
	it("parses JSONC with comments, leading BOM, defaults and valid site", () => {
		const text = `\uFEFF{
			// single-line comment
			"$schema": "https://qorpera.com/schemas/checks.json",
			/* multi-line
			   comment */
			"checks": [
				{ "name": "install", "run": "npm ci", "timeoutSeconds": 180 },
				{ "name": "lint", "run": "npm run lint" },
				{ "name": "test", "run": "npm test", "cwd": "packages/app", "timeoutSeconds": 300 }
			],
			"site": { "folder": "dist", "name": "acme-shop", "title": "Acme Shop" }
		}`;
		expect(parseCodeChecksText(text)).toEqual({
			ok: true,
			mode: "sequential",
			criticalPathSeconds: 1080,
			totalTimeoutSeconds: 1080,
			checks: [
				{ name: "install", run: "npm ci", timeoutSeconds: 180, cwd: "." },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 600, cwd: "." },
				{ name: "test", run: "npm test", timeoutSeconds: 300, cwd: "packages/app" },
			],
			site: { folder: "dist", name: "acme-shop", title: "Acme Shop" },
		});
	});

	it("parses valid needs DAGs (including empty needs and forward references) and validates needs in parity with runner-orchestrator", () => {
		const diamond = parseCodeChecksText(
			JSON.stringify({
				checks: [
					{ name: "build", run: "npm run build", needs: ["lint", "test"] },
					{ name: "install", run: "npm ci", needs: [] },
					{ name: "lint", run: "npm run lint", needs: ["install"] },
					{ name: "test", run: "npm test", needs: ["install"] },
				],
			}),
		);
		expect(diamond).toEqual({
			ok: true,
			mode: "dag",
			criticalPathSeconds: 1800,
			totalTimeoutSeconds: 2400,
			checks: [
				{ name: "build", run: "npm run build", timeoutSeconds: 600, cwd: ".", needs: ["lint", "test"] },
				{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: ".", needs: [] },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 600, cwd: ".", needs: ["install"] },
				{ name: "test", run: "npm test", timeoutSeconds: 600, cwd: ".", needs: ["install"] },
			],
			site: null,
		});

		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "a", run: "true", needs: "install" },
						{ name: "b", run: "true", needs: [42, "BadName", "a", "a", "b", "missing"] },
					],
				}),
			),
		).toEqual({
			ok: false,
			problems: [
				{ at: "/checks/0/needs", code: "WRONG_TYPE", message: "Must be an array." },
				{ at: "/checks/1/needs/0", code: "WRONG_TYPE", message: "Must be a string." },
				{
					at: "/checks/1/needs/1",
					code: "INVALID_VALUE",
					message: "Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
				},
				{ at: "/checks/1/needs/3", code: "DUPLICATE", message: 'The check "a" is listed twice in needs.' },
				{ at: "/checks/1/needs/4", code: "INVALID_VALUE", message: 'The check "b" cannot depend on itself.' },
				{ at: "/checks/1/needs/5", code: "INVALID_VALUE", message: 'No check is named "missing".' },
			],
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
		).toEqual({
			ok: false,
			problems: [
				{
					at: "/checks",
					code: "CYCLE",
					message: "The checks form a dependency cycle: a -> b -> a.",
				},
			],
		});

		expect(
			parseCodeChecksText(
				JSON.stringify({
					checks: [
						{ name: "a", run: "true", needs: ["b"] },
						{ name: "b", run: "true", needs: ["c"] },
						{ name: "c", run: "true", needs: ["a"] },
					],
				}),
			),
		).toEqual({
			ok: false,
			problems: [
				{
					at: "/checks",
					code: "CYCLE",
					message: "The checks form a dependency cycle: a -> b -> c -> a.",
				},
			],
		});
	});

	it("rejects oversized files (including BOM bytes), syntax errors, trailing commas and duplicate keys", () => {
		expect(parseCodeChecksText(" ".repeat(MAX_CODE_CHECKS_FILE_BYTES + 1))).toMatchObject({
			ok: false,
			problems: [{ code: "TOO_LARGE" }],
		});
		expect(parseCodeChecksText(`\uFEFF${" ".repeat(MAX_CODE_CHECKS_FILE_BYTES - 2)}`)).toMatchObject({
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
});

describe("codeChecksTail and buildPreflightCheckCommand", () => {
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
		const runAbort = new AbortController();
		const callAbort = new AbortController();
		const run = await CloudNativeToolRun.open(
			binding,
			{ describeToolAuthority: async () => structuredClone(authority) },
			runAbort.signal,
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
			signal: callAbort.signal,
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
		return { scope, identity, run, runAbort, callAbort, boundary, gateway, begunOperations, invoke };
	}

	it.each([
		[44, "missing", undefined],
		[45, "invalid", "NOT_A_FILE"],
		[46, "invalid", "TOO_LARGE"],
		[47, "invalid", "NOT_UTF8"],
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

	it("clamps short remaining checks-file page reads to at least 4 bytes", async () => {
		const readLimits: number[] = [];
		const shortText = '{"a":}';
		const f = await preflightFixture({
			onStart: (input, ctx) =>
				receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "succeeded",
					output: shortText.slice(0, 4),
					offset: 0,
					nextOffset: 4,
					totalBytes: 6,
					truncated: true,
				}),
			onRead: (input, ctx) => {
				readLimits.push(input.limit ?? 0);
				return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), {
					state: "succeeded",
					output: shortText.slice(4),
					offset: 4,
					nextOffset: 6,
					totalBytes: 6,
					truncated: false,
				});
			},
		});
		try {
			const result = await f.invoke({ operationKey: "short-file", runChecks: true });
			expect(result.success).toBe(true);
			expect(readLimits).toEqual([4]);
			expect(JSON.parse(result.text)).toMatchObject({
				state: "invalid",
				problems: [{ code: "SYNTAX" }],
			});
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

	it("runs sequential checks in order (including BOM file) with CI=true QORPERA_CHECKS=1 and matches command-authority digest parity", async () => {
		const checksFile = `\uFEFF${JSON.stringify({
			checks: [
				{ name: "lint", run: "npm run lint", timeoutSeconds: 60 },
				{ name: "test", run: "npm test", cwd: "apps/web", timeoutSeconds: 120 },
			],
			site: { folder: "dist", name: "acme-app", title: "Acme App" },
		})}`;
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

		const all = await runOnce(false);
		expect(all.state).toBe("failed");
		expect(all.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
			["lint", "failed"],
			["test", "passed"],
			["build", "passed"],
		]);
		expect(all.notRun).toEqual([]);
	});

	it("supports checkNames subset selection and reports unknown check names with availableChecks", async () => {
		const checksFile = JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "test", run: "npm test" },
				{ name: "build", run: "npm run build" },
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

	it("cancels timed-out checks through coding_cancel_command receipt, cancels running checks on abort, and reports machine_stopped and authority revocation", async () => {
		const checksFile = JSON.stringify({
			checks: [{ name: "slow", run: "sleep 30", timeoutSeconds: 10 }],
		});
		let cancelled = false;
		let checkSha = "";
		let checkCommandId = "";
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
					checkCommandId = input.commandId;
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
				const cancelOp = f.begunOperations.find((op) =>
					op.logicalOperationKey.startsWith("coding_cancel_command:"),
				);
				expect(cancelOp).toBeDefined();
				expect(cancelOp?.logicalOperationKey.endsWith(":c:0:cancel")).toBe(true);
				const cancelKey = cancelOp!.logicalOperationKey.slice("coding_cancel_command:".length);
				const expectedCancelDigest = createHash("sha256")
					.update(
						cloudNativeToolOperationEnvelope(f.identity, {
							tool: "coding_cancel_command",
							toolVersion: "v1",
							logicalOperationKey: cancelKey,
							arguments: { commandId: checkCommandId, operationKey: cancelKey },
							target: { schema: "qorpera.coding-command-target/v1", ...f.scope },
							requiresCompanyRevision: false,
						}),
					)
					.digest("hex");
				expect(cancelOp?.inputSha256).toBe(expectedCancelDigest);
			} finally {
				f.boundary.close();
				f.run.close();
			}
		} finally {
			vi.useRealTimers();
		}

		for (const abortWholeRun of [false, true]) {
			const cancelledIds: string[] = [];
			let runningId = "";
			let runningSha = "";
			let startedCheck!: () => void;
			const checkStarted = new Promise<void>((resolve) => {
				startedCheck = resolve;
			});
			let cancelCalled!: () => void;
			const cancelledPromise = new Promise<void>((resolve) => {
				cancelCalled = resolve;
			});
			const aborted = await preflightFixture({
				pollMs: 200,
				onStart: (input, ctx) => {
					if (input.command.includes(".qorpera/checks.json")) {
						return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
							state: "succeeded",
							output: checksFile,
						});
					}
					runningId = input.commandId;
					runningSha = input.inputSha256;
					startedCheck();
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
				},
				onCancel: (commandId, ctx) => {
					cancelledIds.push(commandId);
					cancelCalled();
					return receiptOf(ctx.workerId, commandId, runningSha, { state: "cancelled", exitCode: null });
				},
			});
			try {
				const pending = aborted.invoke({ operationKey: `abort-${String(abortWholeRun)}`, runChecks: true });
				await checkStarted;
				await new Promise((resolve) => setTimeout(resolve, 15));
				if (abortWholeRun) aborted.runAbort.abort();
				aborted.callAbort.abort();
				const result = await pending;
				expect(result.success).toBe(false);
				await cancelledPromise;
				expect(cancelledIds).toEqual([runningId]);
				if (!abortWholeRun) {
					expect(
						aborted.begunOperations.some((op) => op.logicalOperationKey.startsWith("coding_cancel_command:")),
					).toBe(true);
				}
			} finally {
				aborted.boundary.close();
				aborted.run.close();
			}
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

	it("runs needs DAG checks in parallel waves capped at 4 and respects dependency order and checkNames subsets", async () => {
		const diamondFile = JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "lint", run: "npm run lint", needs: ["install"] },
				{ name: "typecheck", run: "npm run typecheck", needs: ["install"] },
				{ name: "build", run: "npm run build", needs: ["lint", "typecheck"] },
			],
		});
		const startedOrder: string[] = [];
		const finished = new Set<string>();
		let active = 0;
		let peakActive = 0;
		const reads = new Map<string, number>();
		const cmdName = new Map<string, string>();
		const nameFromCommand = (command: string): string => {
			if (command.includes("npm ci")) return "install";
			if (command.includes("npm run lint")) return "lint";
			if (command.includes("npm run typecheck")) return "typecheck";
			return "build";
		};
		const f = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: diamondFile,
					});
				}
				const name = nameFromCommand(input.command);
				startedOrder.push(name);
				cmdName.set(input.commandId, name);
				if (name === "lint" || name === "typecheck") {
					active++;
					peakActive = Math.max(peakActive, active);
					reads.set(input.commandId, 0);
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
				}
				if (name === "build") {
					expect(finished.has("lint")).toBe(true);
					expect(finished.has("typecheck")).toBe(true);
				}
				finished.add(name);
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "ok\n" });
			},
			onRead: (input, ctx) => {
				const count = (reads.get(input.commandId) ?? 0) + 1;
				reads.set(input.commandId, count);
				if (count < 2) {
					return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "running", exitCode: null });
				}
				active--;
				finished.add(cmdName.get(input.commandId)!);
				return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const result = await f.invoke({ operationKey: "dag-diamond", runChecks: true });
			expect(result).toMatchObject({ success: true, status: "ok", truncated: false });
			const parsed = JSON.parse(result.text);
			expect(parsed).toMatchObject({
				schema: "qorpera.coding-preflight-checks/v1",
				state: "passed",
				mode: "dag",
				notRun: [],
				skipped: [],
			});
			expect(peakActive).toBe(2);
			expect(startedOrder[0]).toBe("install");
			expect(startedOrder[3]).toBe("build");
			expect(parsed.checks.map((c: { name: string }) => c.name)).toEqual(["install", "lint", "typecheck", "build"]);
			expect(parsed.checks[1].needs).toEqual(["install"]);
			expect(parsed.checks[3].needs).toEqual(["lint", "typecheck"]);

			const subset = JSON.parse(
				(await f.invoke({ operationKey: "dag-subset", runChecks: true, checkNames: ["build"] })).text,
			);
			expect(subset.state).toBe("passed");
			expect(subset.mode).toBe("dag");
			expect(subset.autoIncludedNeeds).toEqual(["install", "lint", "typecheck"]);
			expect(subset.checks.map((c: { name: string }) => c.name)).toEqual(["install", "lint", "typecheck", "build"]);
		} finally {
			f.boundary.close();
			f.run.close();
		}

		const wideFile = JSON.stringify({
			checks: Array.from({ length: 5 }, (_, i) => ({ name: `w${i}`, run: `echo w${i}`, needs: [] })),
		});
		let wideActive = 0;
		let widePeak = 0;
		const wideReads = new Map<string, number>();
		const wide = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: wideFile,
					});
				}
				wideActive++;
				widePeak = Math.max(widePeak, wideActive);
				wideReads.set(input.commandId, 0);
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
			},
			onRead: (input, ctx) => {
				const count = (wideReads.get(input.commandId) ?? 0) + 1;
				wideReads.set(input.commandId, count);
				if (count < 2) {
					return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "running", exitCode: null });
				}
				wideActive--;
				return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const parsed = JSON.parse((await wide.invoke({ operationKey: "dag-wide", runChecks: true })).text);
			expect(parsed.state).toBe("passed");
			expect(parsed.mode).toBe("dag");
			expect(widePeak).toBe(4);
		} finally {
			wide.boundary.close();
			wide.run.close();
		}
	});

	it("cancels running DAG siblings via coding_cancel_command on failFast:true and skips transitive dependents on failFast:false", async () => {
		const dagFile = JSON.stringify({
			checks: [
				{ name: "a", run: "npm run a", needs: [] },
				{ name: "b", run: "npm run b", needs: [] },
				{ name: "c", run: "npm run c", needs: ["a"] },
				{ name: "d", run: "npm run d", needs: ["c"] },
			],
		});
		const cancelledIds: string[] = [];
		let bCommandId = "";
		let aReads = 0;
		const fastFixture = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: dagFile,
					});
				}
				if (input.command.includes("npm run b")) bCommandId = input.commandId;
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
			},
			onRead: (input, ctx) => {
				if (input.commandId === bCommandId) {
					return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "running", exitCode: null });
				}
				aReads++;
				if (aReads === 1) {
					return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), { state: "running", exitCode: null });
				}
				return receiptOf(ctx.workerId, input.commandId, "a".repeat(64), {
					state: "failed",
					exitCode: 1,
					output: "a failed\n",
				});
			},
			onCancel: (commandId, ctx) => {
				cancelledIds.push(commandId);
				return receiptOf(ctx.workerId, commandId, "a".repeat(64), { state: "cancelled", exitCode: null });
			},
		});
		try {
			const fast = JSON.parse(
				(await fastFixture.invoke({ operationKey: "dag-ff-true", runChecks: true, failFast: true })).text,
			);
			expect(fast.state).toBe("failed");
			expect(fast.mode).toBe("dag");
			expect(cancelledIds).toEqual([bCommandId]);
			expect(
				fastFixture.begunOperations.some(
					(op) =>
						op.logicalOperationKey.startsWith("coding_cancel_command:pf:") &&
						op.logicalOperationKey.endsWith(":c:1:cancel"),
				),
			).toBe(true);
			expect(fast.checks).toMatchObject([
				{ name: "a", status: "failed", exitCode: 1, tail: "a failed" },
				{ name: "b", status: "cancelled", exitCode: null },
			]);
			expect(fast.checks[1].tail).toBeUndefined();
			expect(fast.notRun).toEqual(["c", "d"]);
			expect(fast.skipped).toEqual([]);
		} finally {
			fastFixture.boundary.close();
			fastFixture.run.close();
		}

		const continueFixture = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: dagFile,
					});
				}
				if (input.command.includes("npm run a")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "failed",
						exitCode: 1,
						output: "broken a\n",
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
					state: "succeeded",
					output: "ok b\n",
				});
			},
		});
		try {
			const cont = JSON.parse(
				(await continueFixture.invoke({ operationKey: "dag-ff-false", runChecks: true, failFast: false })).text,
			);
			expect(cont.state).toBe("failed");
			expect(cont.mode).toBe("dag");
			expect(cont.checks.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
				["a", "failed"],
				["b", "passed"],
			]);
			expect(cont.notRun).toEqual([]);
			expect(cont.skipped).toEqual([
				{ name: "c", blockedBy: ["a"] },
				{ name: "d", blockedBy: ["c"] },
			]);
		} finally {
			continueFixture.boundary.close();
			continueFixture.run.close();
		}
	});

	it("avoids unhandled rejections and cancels siblings if an in-flight DAG check rejects while another check starts", async () => {
		const dagFile = JSON.stringify({
			checks: [
				{ name: "a", run: "npm run a", needs: [] },
				{ name: "b", run: "npm run b", needs: [] },
			],
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		let aRejected!: () => void;
		const aFailedPromise = new Promise<void>((resolve) => {
			aRejected = resolve;
		});
		const cancelledIds: string[] = [];
		let bCommandId = "";
		const f = await preflightFixture({
			pollMs: 5,
			onStart: async (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: dagFile,
					});
				}
				if (input.command.includes("npm run b")) {
					bCommandId = input.commandId;
					await aFailedPromise;
					await new Promise((resolve) => setTimeout(resolve, 15));
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "running", exitCode: null });
			},
			onRead: async () => {
				aRejected();
				throw new Error("transport boom");
			},
			onCancel: (commandId, ctx) => {
				cancelledIds.push(commandId);
				return receiptOf(ctx.workerId, commandId, "a".repeat(64), { state: "cancelled", exitCode: null });
			},
		});
		try {
			const result = await f.invoke({ operationKey: "dag-reject", runChecks: true });
			expect(result.success).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(unhandled).toEqual([]);
			expect(cancelledIds).toEqual([bCommandId]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			f.boundary.close();
			f.run.close();
		}
	});

	it("supports cleanCopy, validateSite, retries, exclusive, env, and structured failure artifacts in pre-flight", async () => {
		const checksFile = JSON.stringify({
			maxParallel: 2,
			checks: [
				{ name: "build", run: "npm run build", needs: [], exclusive: true, env: { MODE: "ci" } },
				{
					name: "test",
					run: "npm test",
					needs: ["build"],
					retries: 1,
					artifacts: { paths: ["reports/junit.xml"], format: "junit" },
				},
			],
			site: { folder: "dist" },
		});
		const startedCommands: string[] = [];
		let testAttempts = 0;
		const f = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				startedCommands.push(input.command);
				if (input.command.includes("QORPERA_CLEAN_COPY")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: `QORPERA_CLEAN_COPY ${"a".repeat(40)} dirty /home/qorpera-200001/.qorpera-preflight/abc123\n`,
					});
				}
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: checksFile,
					});
				}
				if (input.command.includes("npm test")) {
					testAttempts++;
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: testAttempts === 1 ? "failed" : "succeeded",
						exitCode: testAttempts === 1 ? 1 : 0,
						output: testAttempts === 1 ? "flaky fail\n" : "ok\n",
					});
				}
				if (input.command.includes("QORPERA_SITE_VALIDATE_EOF")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: "QORPERA_SITE_OK 12 4096\n",
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "" });
			},
		});
		try {
			const res = JSON.parse(
				(await f.invoke({ operationKey: "pf-v2-ok", runChecks: true, cleanCopy: true, validateSite: true })).text,
			);
			expect(res).toMatchObject({
				state: "passed",
				cleanCopy: { commit: "a".repeat(40), uncommittedChangesIgnored: true },
				siteValidation: { state: "valid", folder: "dist", files: 12, bytes: 4096 },
			});
			expect(res.checks[1].attempts).toBe(2);
			expect(startedCommands.some((c) => c.includes("MODE='ci' CI=true QORPERA_CHECKS=1"))).toBe(true);
			expect(startedCommands.some((c) => c.includes("/home/qorpera-200001/.qorpera-preflight/abc123"))).toBe(true);
			expect(startedCommands.some((c) => c.startsWith('rm -rf -- "$HOME/.qorpera-preflight/'))).toBe(true);
		} finally {
			f.boundary.close();
			f.run.close();
		}

		const badSite = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: JSON.stringify({
							checks: [{ name: "build", run: "npm run build" }],
							site: { folder: "dist" },
						}),
					});
				}
				if (input.command.includes("QORPERA_SITE_VALIDATE_EOF")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "failed",
						exitCode: 3,
						output: "QORPERA_SITE_PROBLEM SITE_NO_INDEX\n",
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "" });
			},
		});
		try {
			const res = JSON.parse(
				(await badSite.invoke({ operationKey: "pf-site-bad", runChecks: true, validateSite: true })).text,
			);
			expect(res).toMatchObject({
				state: "failed",
				siteValidation: { state: "invalid", folder: "dist", problem: { code: "SITE_NO_INDEX", path: null } },
			});
		} finally {
			badSite.boundary.close();
			badSite.run.close();
		}

		const artFail = await preflightFixture({
			pollMs: 5,
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: JSON.stringify({
							checks: [
								{
									name: "unit",
									run: "vitest run",
									artifacts: { paths: ["junit.xml"], format: "junit" },
								},
							],
						}),
					});
				}
				if (input.command.includes("vitest run")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "failed",
						exitCode: 1,
						output: "1 failed\n",
					});
				}
				if (input.command.includes("QORPERA_ARTIFACT_EOF")) {
					const m = /'junit' '([0-9a-f]{24})'/.exec(input.command);
					const nonce = m?.[1] ?? "";
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: `QORPERA_ARTIFACT_BEGIN:${nonce}:junit\n<testsuite name="ui"><testcase name="renders"><failure message="boom"/></testcase></testsuite>\nQORPERA_ARTIFACT_END:${nonce}\n`,
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "" });
			},
		});
		try {
			const res = JSON.parse((await artFail.invoke({ operationKey: "pf-art", runChecks: true })).text);
			expect(res.state).toBe("failed");
			expect(res.checks[0].failedTests).toEqual([{ suite: "ui", name: "renders", message: "boom" }]);
			expect(res.notices).toBeUndefined();
		} finally {
			artFail.boundary.close();
			artFail.run.close();
		}

		const withSecrets = await preflightFixture({
			onStart: (input, ctx) => {
				if (input.command.includes(".qorpera/checks.json")) {
					return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
						state: "succeeded",
						output: JSON.stringify({
							checks: [{ name: "deploy-check", run: "echo ok", secrets: ["API_TOKEN"] }],
						}),
					});
				}
				return receiptOf(ctx.workerId, input.commandId, input.inputSha256, { state: "succeeded", output: "ok\n" });
			},
		});
		try {
			const res = JSON.parse((await withSecrets.invoke({ operationKey: "pf-sec", runChecks: true })).text);
			expect(res.state).toBe("passed");
			expect(res.notices).toEqual([
				"Per-check secrets allow-lists are enforced at landing; pre-flight runs with the session environment (checks with secrets: deploy-check).",
			]);
		} finally {
			withSecrets.boundary.close();
			withSecrets.run.close();
		}
	});

	it("validates server site dockerfile with lstat in pre-flight clean copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-preflight-server-site-"));
		const dir = join(root, ".qorpera-preflight", "run");
		mkdirSync(dir, { recursive: true });
		try {
			const runServerSitePreflight = async (opKey: string, site: Record<string, unknown>) => {
				let sawSiteValidate = false;
				const f = await preflightFixture({
					pollMs: 5,
					onStart: (input, ctx) => {
						if (input.command.includes("QORPERA_CLEAN_COPY")) {
							return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
								state: "succeeded",
								output: `QORPERA_CLEAN_COPY ${"b".repeat(40)} clean ${dir}\n`,
							});
						}
						if (input.command.includes(".qorpera/checks.json")) {
							return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
								state: "succeeded",
								output: JSON.stringify({
									checks: [{ name: "test", run: "echo ok" }],
									site,
								}),
							});
						}
						if (input.command.includes("QORPERA_SITE_VALIDATE_EOF")) {
							sawSiteValidate = true;
							const run = spawnSync("bash", ["-c", input.command], { encoding: "utf8" });
							const code = run.status ?? 1;
							return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
								state: code === 0 ? "succeeded" : "failed",
								exitCode: code,
								output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
							});
						}
						return receiptOf(ctx.workerId, input.commandId, input.inputSha256, {
							state: "succeeded",
							output: "",
						});
					},
				});
				try {
					const parsed = JSON.parse(
						(await f.invoke({ operationKey: opKey, runChecks: true, cleanCopy: true, validateSite: true })).text,
					);
					return { parsed, sawSiteValidate };
				} finally {
					f.boundary.close();
					f.run.close();
				}
			};

			const missing = await runServerSitePreflight("pf-srv-missing", {
				kind: "server",
				dockerfile: "docker/Dockerfile",
			});
			expect(missing.sawSiteValidate).toBe(true);
			expect(missing.parsed).toMatchObject({
				state: "failed",
				siteValidation: {
					state: "invalid",
					folder: ".",
					problem: { code: "SITE_FOLDER_MISSING", path: "docker/Dockerfile" },
				},
			});

			mkdirSync(join(dir, "docker"), { recursive: true });
			writeFileSync(join(dir, "real-dockerfile"), "FROM node:22\n");
			symlinkSync(join(dir, "real-dockerfile"), join(dir, "docker", "Dockerfile"));
			const symlinked = await runServerSitePreflight("pf-srv-symlink", {
				kind: "server",
				dockerfile: "docker/Dockerfile",
			});
			expect(symlinked.sawSiteValidate).toBe(true);
			expect(symlinked.parsed).toMatchObject({
				state: "failed",
				siteValidation: {
					state: "invalid",
					folder: ".",
					problem: { code: "SITE_FOLDER_MISSING", path: "docker/Dockerfile" },
				},
			});

			unlinkSync(join(dir, "docker", "Dockerfile"));
			writeFileSync(join(dir, "docker", "Dockerfile"), "FROM node:22\n");
			const present = await runServerSitePreflight("pf-srv-present", {
				kind: "server",
				dockerfile: "docker/Dockerfile",
			});
			expect(present.sawSiteValidate).toBe(true);
			expect(present.parsed).toMatchObject({
				state: "passed",
				siteValidation: { state: "valid", folder: ".", files: 0, bytes: 0 },
			});

			const noDockerfile = await runServerSitePreflight("pf-srv-auto", { kind: "server" });
			expect(noDockerfile.sawSiteValidate).toBe(false);
			expect(noDockerfile.parsed).toMatchObject({
				state: "passed",
				siteValidation: { state: "valid", folder: ".", files: 0, bytes: 0 },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates optional surfaceGate in parseCodeChecksText", () => {
		const stage = parseCodeChecksText('{"surfaceGate":"stage","checks":[{"name":"test","run":"npm test"}]}');
		expect(stage.ok).toBe(true);
		if (stage.ok) expect(stage.surfaceGate).toBe("stage");

		const none = parseCodeChecksText('{"surfaceGate":"none","checks":[{"name":"test","run":"npm test"}]}');
		expect(none.ok).toBe(true);
		if (none.ok) expect(none.surfaceGate).toBe("none");

		const invalid = parseCodeChecksText('{"surfaceGate":"strict","checks":[{"name":"test","run":"npm test"}]}');
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) {
			expect(invalid.problems).toContainEqual({
				at: "/surfaceGate",
				code: "INVALID_VALUE",
				message: 'Must be "none" or "stage".',
			});
		}
	});
});
