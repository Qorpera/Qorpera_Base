import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import type { CloudFolderTodos } from "@qorpera/runtime/cloud-folder-todos";
import type { CloudFolderWorkers } from "@qorpera/runtime/cloud-folder-workers";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeFolderReports,
	type CloudNativeTool,
	CloudNativeToolBoundary,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import {
	cloudWorkerToolFilter,
	cloudWorkerTools,
	describeCloudAgentOpenWork,
	fitsOneResult,
	workerSaveToText,
} from "@qorpera/runtime/cloud-worker-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const parentWake = { kind: "room", source: { kind: "room", id: randomUUID(), occurrenceKey: "k" } } as const;
const cursor = "5f0c1a3e-8b7d-4c2a-9e61-0d4f2b8a7c19";
const workerWake = {
	kind: "agent",
	source: { kind: "worker-dispatch", id: randomUUID(), occurrenceKey: "k" },
} as const;

/** The tools over folder writers that answer every call (the writers' own tests cover what they save). */
async function fixture(
	wake: typeof parentWake | typeof workerWake = parentWake,
	folderReports?: CloudNativeFolderReports,
	extraTools: readonly CloudNativeTool[] = [],
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const answer = (value: string) => async () => ({ kind: "text" as const, value });
	const folderTodos = {
		list: vi.fn<CloudFolderTodos["list"]>(answer('{"todos":[]}')),
		change: vi.fn<CloudFolderTodos["change"]>(answer('{"saved":true}')),
	};
	const folderWorkers = {
		status: vi.fn<CloudFolderWorkers["status"]>(answer('{"workers":[]}')),
		change: vi.fn<CloudFolderWorkers["change"]>(answer('{"saved":true}')),
		report: vi.fn<CloudFolderWorkers["report"]>(answer('{"reported":true}')),
	};
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: [
			...cloudWorkerTools(binding, run.identity, wake, {
				folderTodos: folderTodos as unknown as CloudFolderTodos,
				folderWorkers: folderWorkers as unknown as CloudFolderWorkers,
			}),
			...extraTools,
		],
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
		...(folderReports ? { folderReports } : {}),
	});
	// Every call the tools made to a writer.
	const writerCalls = () =>
		[folderTodos.list, folderTodos.change, folderWorkers.status, folderWorkers.change, folderWorkers.report].reduce(
			(count, writer) => count + writer.mock.calls.length,
			0,
		);
	return { binding, run, boundary, folderTodos, folderWorkers, writerCalls };
}
const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
const savedReport = {
	kind: "text" as const,
	value: JSON.stringify({ schema: "qorpera.worker-report-receipt/v1", outcome: "saved" }),
};
const reportCall = { operationKey: "r1", outcome: "succeeded", summary: "Done." };
/** A second tool for a response that holds another call beside the report. */
const noteTool: CloudNativeTool = {
	name: "read_note",
	source: "company_file",
	description: "Synthetic note.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	parseArguments: () => ({}),
	execute: async () => ({ kind: "text", value: "PUBLIC_NOTE" }),
};
const body = (result: { contentItems: readonly unknown[] }) =>
	JSON.parse((result.contentItems[0] as { text: string }).text);
const names = (boundary: CloudNativeToolBoundary) =>
	(boundary.specification as unknown as { tools: { name: string }[] }).tools.map((tool) => tool.name);
const dispatch = {
	action: "dispatch",
	operationKey: "d1",
	todoKey: "market-scan",
	workerKey: "prices",
	title: "Collect prices",
	goal: "Collect the public list prices of the three competitors.",
	definitionOfDone: "A table with one verified price per competitor.",
	context: "Competitors: Alfa, Beta, Gamma.",
	sources: ["research/competitors.md"],
	access: "write",
};

describe("agent todo and worker tools", () => {
	it("offers the dispatcher its two tools and a worker only its report", async () => {
		const parent = await fixture();
		const child = await fixture(workerWake);
		try {
			expect(names(parent.boundary)).toEqual(["manage_todo", "manage_worker"]);
			expect(names(child.boundary)).toEqual(["report_work"]);
			const denied = await child.boundary.invoke("c1", "qorpera", "manage_worker", dispatch);
			expect(body(denied).status).toBe("denied");
			expect(child.writerCalls()).toBe(0);
		} finally {
			parent.run.close();
			child.run.close();
		}
	});

	it("hands both listings to the folder writers with their filters, and refuses a malformed filter before any writer call", async () => {
		const f = await fixture();
		try {
			const listed = await f.boundary.invoke("l1", "qorpera", "manage_todo", {
				action: "list",
				todoKey: "market-scan",
				state: "done",
				search: "  Invoice ",
				cursor,
			});
			expect(body(listed).status).toBe("ok");
			expect(JSON.parse(body(listed).content.text)).toEqual({ todos: [] });
			expect(f.folderTodos.list).toHaveBeenCalledWith(
				{ action: "list", todoKey: "market-scan", state: "done", search: "Invoice", cursor },
				expect.objectContaining({ callId: "l1" }),
				fitsOneResult,
			);
			const status = await f.boundary.invoke("s1", "qorpera", "manage_worker", {
				action: "status",
				todoKey: "market-scan",
				state: "active",
				search: "prices",
				cursor,
			});
			expect(body(status).status).toBe("ok");
			expect(f.folderWorkers.status).toHaveBeenCalledWith(
				{ action: "status", todoKey: "market-scan", state: "active", search: "prices", cursor },
				expect.objectContaining({ callId: "s1" }),
				fitsOneResult,
			);
			const calls = f.writerCalls();
			for (const [index, [tool, hostile]] of (
				[
					["manage_todo", { action: "list", state: "archived" }],
					["manage_todo", { action: "list", state: "active" }],
					["manage_todo", { action: "list", cursor: "page-2" }],
					["manage_todo", { action: "list", cursor: cursor.toUpperCase() }],
					["manage_todo", { action: "list", search: "" }],
					["manage_todo", { action: "list", search: "a\nb" }],
					["manage_todo", { action: "list", search: "tab\there" }],
					["manage_todo", { action: "list", search: "x".repeat(201) }],
					["manage_todo", { action: "list", search: "next\u0085line" }],
					["manage_todo", { action: "list", todoKey: "Market Scan" }],
					["manage_todo", { action: "list", workerKey: "prices" }],
					["manage_todo", { action: "upsert", operationKey: "u1", todoKey: "k", title: "t", state: "done" }],
					["manage_worker", { action: "status", state: "running" }],
					["manage_worker", { action: "status", state: "open" }],
					["manage_worker", { action: "status", cursor: 42 }],
					["manage_worker", { action: "status", offset: 16 }],
				] as const
			).entries()) {
				const refused = await f.boundary.invoke(`bad_${index}`, "qorpera", tool, hostile);
				expect(body(refused).status).toBe("denied");
			}
			expect(f.writerCalls()).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("hands a todo change to the todo writer, parsed, and keeps the run's binding out of the result", async () => {
		const f = await fixture();
		try {
			const request = { action: "upsert", operationKey: "t1", todoKey: "market-scan", title: "Market scan for Q4" };
			const saved = await f.boundary.invoke("todo_1", "qorpera", "manage_todo", request);
			expect(body(saved)).toMatchObject({ status: "ok", trust: "untrusted_data" });
			expect(f.folderTodos.change).toHaveBeenCalledWith(
				{ ...request, detail: "", state: "open" },
				expect.objectContaining({ callId: "todo_1" }),
			);
			await f.boundary.invoke("todo_2", "qorpera", "manage_todo", {
				action: "done",
				operationKey: "t2",
				todoKey: "market-scan",
			});
			expect(f.folderTodos.change.mock.calls.at(-1)?.[0]).toEqual({
				action: "done",
				operationKey: "t2",
				todoKey: "market-scan",
			});
			expect(JSON.stringify(saved)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it.each([
		["manage_todo", { action: "list" }, "todos"],
		["manage_worker", { action: "status", todoKey: "market-scan" }, "workers"],
	] as const)(
		"gives the %s writer a fit test that matches the fence: a page it passes reaches the model whole",
		async (tool, request, items) => {
			const f = await fixture();
			try {
				// A page whose items escape again inside the fence's provenance: as many as the fit test passes.
				const render = (count: number) =>
					JSON.stringify({
						[items]: Array.from({ length: count }, (_, index) => ({
							key: `item-${index}`,
							title: "\u0001".repeat(40),
							detail: 'Plan: "read", <check> & report.\n'.repeat(7).slice(0, 200),
						})),
					});
				let widest = 0;
				const writer = async (_request: unknown, _context: unknown, fits: (text: string) => boolean) => {
					let count = 1;
					while (count < 400 && fits(render(count + 1))) count++;
					widest = count;
					return { kind: "text" as const, value: render(count) };
				};
				if (items === "todos") f.folderTodos.list.mockImplementationOnce(writer);
				else f.folderWorkers.status.mockImplementationOnce(writer);
				const envelope = body(await f.boundary.invoke("page", "qorpera", tool, request));
				expect(envelope.status).toBe("ok");
				expect(widest).toBeGreaterThan(1);
				expect(widest).toBeLessThan(400);
				// The fence cuts anything past 8 KiB; a page the fit test passes never reaches that.
				expect(envelope.content.truncated).toBe(false);
				expect(JSON.parse(envelope.content.text)[items]).toHaveLength(widest);
			} finally {
				f.run.close();
			}
		},
	);

	it("counts open work for the prompt and refuses a receipt for another run", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const signal = new AbortController().signal;
		const counts = { todos: { open: 40, blocked: 2 }, workers: { active: 5, blocked: 1 } };
		const call = vi.fn<CloudCompanyPathControl["call"]>(async () => ({
			schema: "qorpera.agent-open-work/v1",
			runId: binding.runId,
			...counts,
		}));
		expect(await describeCloudAgentOpenWork(binding, { call }, signal)).toEqual(counts);
		expect(call.mock.calls[0].slice(0, 2)).toEqual(["qorpera_describe_agent_open_work", { p_binding: binding }]);
		for (const broken of [
			{ runId: randomUUID() },
			{ todos: { open: -1, blocked: 0 } },
			{ workers: { active: 1, blocked: 0, running: 1 } },
			{ schema: "qorpera.agent-todos/v1" },
		]) {
			call.mockResolvedValueOnce({
				schema: "qorpera.agent-open-work/v1",
				runId: binding.runId,
				...counts,
				...broken,
			});
			await expect(describeCloudAgentOpenWork(binding, { call }, signal)).rejects.toThrow();
		}
	});

	it("passes on the commands the platform stopped, and refuses a list it does not know", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const signal = new AbortController().signal;
		const counts = { todos: { open: 0, blocked: 0 }, workers: { active: 0, blocked: 0 } };
		const stopped = {
			command: "npm run dev",
			startedAt: "2026-10-03T02:00:00.123456+00:00",
			endedAt: "2026-10-03T03:00:00.654321+00:00",
			reason: "slept",
		};
		const call = vi.fn<CloudCompanyPathControl["call"]>(async () => ({
			schema: "qorpera.agent-open-work/v1",
			runId: binding.runId,
			...counts,
			computerStopped: [stopped],
		}));
		expect(await describeCloudAgentOpenWork(binding, { call }, signal)).toEqual({
			...counts,
			computerStopped: [stopped],
		});
		// A host reads only the keys it knows, as every host from before computerStopped did.
		call.mockResolvedValueOnce({
			schema: "qorpera.agent-open-work/v1",
			runId: binding.runId,
			...counts,
			coffeeStopped: [{}],
		});
		expect(await describeCloudAgentOpenWork(binding, { call }, signal)).toEqual(counts);
		for (const broken of [
			[],
			Array.from({ length: 33 }, () => stopped),
			[{ ...stopped, reason: "exited" }],
			[{ ...stopped, exitCode: 0 }],
			[{ ...stopped, command: 1 }],
			{ ...stopped },
		]) {
			call.mockResolvedValueOnce({
				schema: "qorpera.agent-open-work/v1",
				runId: binding.runId,
				...counts,
				computerStopped: broken,
			});
			await expect(describeCloudAgentOpenWork(binding, { call }, signal)).rejects.toThrow();
		}
	});

	it("passes on what a machine's stop or restart ended, commands and containers, and refuses what it does not know", async () => {
		const { binding } = nativeToolAuthorityFixture();
		const signal = new AbortController().signal;
		const counts = { todos: { open: 0, blocked: 0 }, workers: { active: 0, blocked: 0 } };
		const command = {
			machine: "build-a",
			work: "command",
			command: "npm run dev",
			startedAt: "2026-10-04T02:00:00.123456+00:00",
			endedAt: "2026-10-04T03:00:00.654321+00:00",
			reason: "slept",
		};
		const containers = {
			machine: "build-a",
			work: "containers",
			endedAt: "2026-10-04T03:00:00+00:00",
			reason: "hours",
		};
		const call = vi.fn<CloudCompanyPathControl["call"]>(async () => ({
			schema: "qorpera.agent-open-work/v1",
			runId: binding.runId,
			...counts,
			machineStopped: [command, containers],
		}));
		expect(await describeCloudAgentOpenWork(binding, { call }, signal)).toEqual({
			...counts,
			machineStopped: [command, containers],
		});
		for (const broken of [
			[],
			Array.from({ length: 33 }, () => command),
			[{ ...command, reason: "closed" }],
			[{ ...command, work: "shell" }],
			[{ ...command, busyAt: command.startedAt }],
			[{ ...containers, command: "docker" }],
			[{ ...containers, work: "outside" }],
			[{ ...containers, endedAt: 1 }],
			[{ ...command, machine: null }],
			{ ...command },
		]) {
			call.mockResolvedValueOnce({
				schema: "qorpera.agent-open-work/v1",
				runId: binding.runId,
				...counts,
				machineStopped: broken,
			});
			await expect(describeCloudAgentOpenWork(binding, { call }, signal)).rejects.toThrow();
		}
	});

	it("hands a complete dispatch to the worker writer and refuses an incomplete or widened one before any writer call", async () => {
		const f = await fixture();
		try {
			const sent = await f.boundary.invoke("w1", "qorpera", "manage_worker", dispatch);
			expect(body(sent).status).toBe("ok");
			expect(f.folderWorkers.change).toHaveBeenCalledWith(
				{ ...dispatch, revival: "batch" },
				expect.objectContaining({ callId: "w1" }),
			);
			// A folder named with a trailing slash is the same folder.
			await f.boundary.invoke("w2", "qorpera", "manage_worker", {
				...dispatch,
				operationKey: "d2",
				workerKey: "interviews",
				sources: ["founder/interviews/"],
			});
			expect(f.folderWorkers.change.mock.calls.at(-1)?.[0].sources).toEqual(["founder/interviews"]);
			const calls = f.writerCalls();
			const { definitionOfDone: _omitted, ...incomplete } = dispatch;
			const { workerKey: _unnamed, ...unnamed } = dispatch;
			for (const [index, hostile] of [
				incomplete,
				unnamed,
				{ ...dispatch, staffAgentId: randomUUID() },
				{ ...dispatch, parentRunId: randomUUID() },
				{ ...dispatch, access: "admin" },
				{ ...dispatch, sources: ["../outside"] },
				{ ...dispatch, tools: ["send_message"] },
				{ action: "followup", operationKey: "f1", todoKey: "market-scan", workerKey: "prices" },
				{ action: "decide", operationKey: "a1", todoKey: "market-scan", workerKey: "prices", decision: "approve" },
				{ action: "status", workerKey: "prices" },
			].entries()) {
				const refused = await f.boundary.invoke(`bad_${index}`, "qorpera", "manage_worker", hostile);
				expect(body(refused).status).toBe("denied");
			}
			expect(f.writerCalls()).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("tells a worker where the finished files belong when the dispatch names a folder (saveTo)", async () => {
		const f = await fixture();
		try {
			const sent = await f.boundary.invoke("s1", "qorpera", "manage_worker", {
				...dispatch,
				saveTo: "product/designs/",
			});
			expect(body(sent).status).toBe("ok");
			expect(f.folderWorkers.change).toHaveBeenCalledWith(
				{
					...dispatch,
					context: `${dispatch.context}\n\n${workerSaveToText("product/designs")}`,
					saveTo: "product/designs",
					revival: "batch",
				},
				expect.objectContaining({ callId: "s1" }),
			);
			expect(workerSaveToText("product/designs")).toBe(
				"Save the finished files in product/designs/ in the company folder, where they belong, and list them in your report.",
			);
			// Without context, the sentence is the context.
			const { context: _context, ...bare } = dispatch;
			await f.boundary.invoke("s2", "qorpera", "manage_worker", {
				...bare,
				operationKey: "d2",
				saveTo: "product/designs",
			});
			expect(f.folderWorkers.change.mock.calls.at(-1)?.[0].context).toBe(workerSaveToText("product/designs"));
			const calls = f.writerCalls();
			for (const [index, hostile] of [
				{ ...dispatch, operationKey: "d3", saveTo: "product/designs", access: "read" },
				{ ...dispatch, operationKey: "d4", saveTo: "../outside" },
				{ ...dispatch, operationKey: "d5", saveTo: "/product/designs" },
				{ ...dispatch, operationKey: "d6", saveTo: "product/designs", context: "c".repeat(3990) },
			].entries()) {
				const refused = await f.boundary.invoke(`save_bad_${index}`, "qorpera", "manage_worker", hostile);
				expect(body(refused).status).toBe("denied");
			}
			expect(f.writerCalls()).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("answers the writer's refusal in its words, once, and any other failure as an unknown outcome", async () => {
		const f = await fixture();
		try {
			f.folderWorkers.change.mockRejectedValueOnce(
				new CloudToolRefusal("That todo is closed: a worker belongs to an open or blocked todo"),
			);
			const refused = await f.boundary.invoke("w1", "qorpera", "manage_worker", dispatch);
			expect(body(refused)).toMatchObject({
				status: "denied",
				content: { text: "REFUSED: That todo is closed: a worker belongs to an open or blocked todo" },
			});
			expect(f.folderWorkers.change).toHaveBeenCalledTimes(1);
			// The writer words the database refusals it knows (cloud-folder-workers.test.ts). The tool adds no relay of its
			// own: once the writer has begun its receipt, another refusal does not prove that nothing happened.
			f.folderWorkers.change.mockRejectedValueOnce(
				new CloudControlRpcRefused("55000", "Coding workers come to the company folder with coding machines"),
			);
			const unworded = await f.boundary.invoke("w2", "qorpera", "manage_worker", {
				...dispatch,
				operationKey: "d2",
			});
			expect(body(unworded)).toMatchObject({ status: "unconfirmed", content: { text: "TOOL_OUTCOME_UNCONFIRMED" } });
			f.folderWorkers.change.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("transport_unavailable"));
			const lost = await f.boundary.invoke("w3", "qorpera", "manage_worker", { ...dispatch, operationKey: "d3" });
			expect(body(lost)).toMatchObject({ status: "unconfirmed", content: { text: "TOOL_OUTCOME_UNCONFIRMED" } });
			expect(f.folderWorkers.change).toHaveBeenCalledTimes(3);
		} finally {
			f.run.close();
		}
	});

	it("starts a coding session for the member who asked and refuses to name another member", async () => {
		const f = await fixture();
		try {
			const coding = {
				...dispatch,
				operationKey: "c1",
				workerKey: "fix-login",
				access: "read",
				species: "coding",
				harness: "codex",
				repository: { host: "github.com", owner: "qorpera", name: "site", baseBranch: "main" },
			};
			const sent = await f.boundary.invoke("c1", "qorpera", "manage_worker", coding);
			expect(body(sent).status).toBe("ok");
			const request = f.folderWorkers.change.mock.calls.at(-1)?.[0];
			expect(request?.species).toBe("coding");
			expect(request).not.toHaveProperty("owner");
			const calls = f.writerCalls();
			// The session runs for the member who asked (the run's requester); the model cannot pick a payer.
			const refused = await f.boundary.invoke("c2", "qorpera", "manage_worker", {
				...coding,
				operationKey: "c2",
				owner: randomUUID(),
			});
			expect(body(refused).status).toBe("denied");
			expect(f.writerCalls()).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("ends the worker's turn when its report is saved, and only then", async () => {
		const f = await fixture(workerWake);
		try {
			const answer = (outcome: string, schema = "qorpera.worker-report-receipt/v1") => ({
				kind: "text" as const,
				value: JSON.stringify({ schema, outcome }),
			});
			const report = { operationKey: "r1", outcome: "succeeded", summary: "Done." };
			// Not saved: the answer says to report again, so the model must get the next round.
			f.folderWorkers.report.mockResolvedValueOnce(answer("refused"));
			const refused = await f.boundary.invoke("r_1", "qorpera", "report_work", report);
			expect(body(refused).status).toBe("ok");
			expect(refused.completesTurn).toBeUndefined();
			// Another tool's answer that happens to read "saved" is not a report.
			f.folderWorkers.report.mockResolvedValueOnce(answer("saved", "qorpera.something-else/v1"));
			expect((await f.boundary.invoke("r_2", "qorpera", "report_work", report)).completesTurn).toBeUndefined();
			f.folderWorkers.report.mockResolvedValueOnce({ kind: "text", value: "not json" });
			expect((await f.boundary.invoke("r_3", "qorpera", "report_work", report)).completesTurn).toBeUndefined();
			// Saved, first made or replayed: the host-only marker, which never enters what the model reads.
			f.folderWorkers.report.mockResolvedValueOnce(answer("saved"));
			const saved = await f.boundary.invoke("r_4", "qorpera", "report_work", report);
			expect(saved.completesTurn).toBe("alone");
			expect(saved.contentItems[0].text).not.toContain("completesTurn");
			// A refused call never ends the turn, whatever the tool would have answered.
			const invalid = await f.boundary.invoke("r_5", "qorpera", "report_work", { ...report, outcome: "done" });
			expect(body(invalid).status).toBe("denied");
			expect(invalid.completesTurn).toBeUndefined();
		} finally {
			f.run.close();
		}
	});

	it("keeps the turn open when the saved report's answer tells of desktop paths the folder did not take", async () => {
		const notSaved = [{ path: "notes/plan.md", outcome: "conflict", reason: "it changed meanwhile" }];
		for (const [report, ends] of [
			[{ saved: 2 }, true],
			[{ saved: 1, notSaved }, false],
			[{ saved: 0, refused: "the company folder refused this desktop's last changes" }, false],
			[{ saved: 1, more: true }, false],
		] as const) {
			const next = vi.fn<CloudNativeFolderReports["next"]>();
			const f = await fixture(workerWake, { next });
			try {
				next.mockResolvedValue({ mark: `${randomUUID()}:1`, report });
				f.folderWorkers.report.mockResolvedValueOnce(savedReport);
				const saved = await f.boundary.invoke("r_1", "qorpera", "report_work", reportCall);
				expect(body(saved).companyFolder).toEqual(report);
				expect(saved.completesTurn).toBe(ends ? "alone" : undefined);
			} finally {
				f.run.close();
			}
		}
	});

	it("takes a saved report through the session to the interrupt, and a report that was not saved past it", async () => {
		const session = async (
			mode: "report-ends-turn" | "report-goes-on" | "report-then-note" | "report-after-note",
			answer: { kind: "text"; value: string },
			folderReports?: CloudNativeFolderReports,
		) => {
			const root = await mkdtemp(join(tmpdir(), "q-worker-report-"));
			const f = await fixture(workerWake, folderReports, [noteTool]);
			try {
				f.folderWorkers.report.mockResolvedValueOnce(answer);
				const evidence = join(root, "evidence.json");
				const result = await runCloudCodexToolSession({
					command: [process.execPath, rpcFixture, mode, evidence],
					binarySha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
					boundary: f.boundary,
					model: "offline-probe",
					prompt: "Private test input",
					signal: new AbortController().signal,
					timeoutMs: 15_000,
				});
				expect(f.folderWorkers.report).toHaveBeenCalledTimes(1);
				return { result, recorded: JSON.parse(await readFile(evidence, "utf8")) };
			} finally {
				f.run.close();
				await rm(root, { recursive: true, force: true });
			}
		};
		const ended = await session("report-ends-turn", savedReport);
		expect(ended.result).toMatchObject({ toolCalls: 1, fencedRequests: 2 });
		expect(ended.recorded.interrupt).toEqual({ threadId: "thread_fixture", turnId: "turn_fixture" });
		// The host-only marker never reaches the provider.
		expect(Object.keys(ended.recorded.reply.result).sort()).toEqual(["contentItems", "success"]);
		const refused = await session("report-goes-on", {
			kind: "text",
			value: JSON.stringify({ schema: "qorpera.worker-report-receipt/v1", outcome: "refused" }),
		});
		expect(refused.result).toMatchObject({ toolCalls: 1, fencedRequests: 2 });
		expect(refused.recorded.interrupt).toBeNull();
		const unread = await session("report-goes-on", savedReport, {
			next: async () => ({
				mark: `${randomUUID()}:1`,
				report: { saved: 0, refused: "the company folder refused this desktop's last changes" },
			}),
		});
		expect(unread.recorded.interrupt).toBeNull();
		expect(unread.recorded.reply.result.contentItems[0].text).toContain("refused this desktop");
		// Another call in the report's response: its answer must reach the model, so the turn goes on, also through a later
		// response of one other call.
		const sibling = await session("report-then-note", savedReport);
		expect(sibling.result).toMatchObject({ toolCalls: 3, fencedRequests: 3 });
		expect(sibling.recorded.interrupt).toBeNull();
		// A call in an earlier response is no sibling.
		const after = await session("report-after-note", savedReport);
		expect(after.result).toMatchObject({ toolCalls: 2, fencedRequests: 3 });
		expect(after.recorded.earlyInterrupt).toBeNull();
		expect(after.recorded.interrupt).toEqual({ threadId: "thread_fixture", turnId: "turn_fixture" });
	});

	it("lets a worker report once to its parent, with a question only when blocked", async () => {
		const f = await fixture(workerWake);
		try {
			const report = { operationKey: "r1", outcome: "succeeded", summary: "Alfa 49, Beta 59, Gamma 45." };
			const first = await f.boundary.invoke("r_1", "qorpera", "report_work", report);
			expect(body(first).status).toBe("ok");
			expect(f.folderWorkers.report).toHaveBeenCalledWith(report, expect.objectContaining({ callId: "r_1" }));
			for (const [index, invalid] of [
				{ ...report, outcome: "blocked" },
				{ ...report, needs: "A decision" },
				{ ...report, outcome: "done" },
				{ ...report, outputs: ["/etc/passwd"] },
				{ ...report, recipient: "member" },
			].entries())
				expect(body(await f.boundary.invoke(`bad_${index}`, "qorpera", "report_work", invalid)).status).toBe(
					"denied",
				);
			expect(f.writerCalls()).toBe(1);
		} finally {
			f.run.close();
		}
	});

	it("gives a read-only worker no Company File write tools", () => {
		const tool = (name: string) => ({ name }) as never;
		const readOnly = cloudWorkerToolFilter({ ...workerWake, payload: { access: "read" } });
		const writer = cloudWorkerToolFilter({ ...workerWake, payload: { access: "write" } });
		const parent = cloudWorkerToolFilter({ ...parentWake, payload: {} });
		expect([readOnly.isWorker, writer.isWorker, parent.isWorker]).toEqual([true, true, false]);
		expect(
			[
				"company_read",
				"company_list",
				"company_write",
				"company_edit",
				"company_move",
				"company_mkdir",
				"company_delete",
			].filter((name) => readOnly.companyFile(tool(name))),
		).toEqual(["company_read", "company_list"]);
		expect(writer.companyFile(tool("company_write")) && parent.companyFile(tool("company_delete"))).toBe(true);
		// Rows of a table are written as files are.
		const interfaces = ["table_read", "table_write"];
		expect(interfaces.filter((name) => readOnly.companyFile(tool(name)))).toEqual(["table_read"]);
		expect(interfaces.filter((name) => writer.companyFile(tool(name)))).toEqual(interfaces);
		expect(interfaces.filter((name) => parent.companyFile(tool(name)))).toEqual(interfaces);
	});
});

describe("a folder-v2 agent's todos", () => {
	it("saves through the folder writer and says the todos are files", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const change = vi.fn(async () => ({ kind: "text" as const, value: '{"saved":true}' }));
		const list = vi.fn(async () => ({ kind: "text" as const, value: '{"todos":[]}' }));
		const tools = cloudWorkerTools(binding, identity, parentWake, {
			folderTodos: { change, list } as unknown as CloudFolderTodos,
			folderWorkers: {} as CloudFolderWorkers,
		});
		const todo = tools.find((tool) => tool.name === "manage_todo");
		if (!todo) throw new Error("Missing todo tool");
		expect(todo.description).toContain("Each todo is a file in your folder");
		expect(todo.description).not.toContain("also a document in the shared Company File");
		expect(todo.description).not.toContain("latest 4 workers");
		const context = {
			companyId: identity.companyId,
			runId: identity.runId,
			callId: randomUUID(),
			argumentSha256: "a".repeat(64),
			signal: new AbortController().signal,
			identity,
		};
		const request = todo.parseArguments({
			action: "upsert",
			operationKey: "todo-1",
			todoKey: "call-the-bank",
			title: "Call the bank",
		});
		await expect(todo.execute(request, context)).resolves.toEqual({ kind: "text", value: '{"saved":true}' });
		expect(change).toHaveBeenCalledWith(
			{
				action: "upsert",
				operationKey: "todo-1",
				todoKey: "call-the-bank",
				title: "Call the bank",
				detail: "",
				state: "open",
			},
			context,
		);
		const listing = todo.parseArguments({ action: "list", includeClosed: true });
		await expect(todo.execute(listing, context)).resolves.toEqual({ kind: "text", value: '{"todos":[]}' });
		expect(list).toHaveBeenCalledWith({ action: "list", includeClosed: true }, context, fitsOneResult);
	});
});
