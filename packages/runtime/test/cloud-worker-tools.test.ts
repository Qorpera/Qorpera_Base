import { randomUUID } from "node:crypto";
import type { CloudCompanyPathControl, CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyPathRpcRefusal } from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import type { CloudFolderTodos } from "@qorpera/runtime/cloud-folder-todos";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeDiagnosticError } from "@qorpera/runtime/cloud-runtime-observability";
import {
	cloudWorkerToolFilter,
	cloudWorkerTools,
	describeCloudAgentOpenWork,
} from "@qorpera/runtime/cloud-worker-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const parentWake = { kind: "room", source: { kind: "room", id: randomUUID(), occurrenceKey: "k" } } as const;
const cursor = "5f0c1a3e-8b7d-4c2a-9e61-0d4f2b8a7c19";
const workerWake = {
	kind: "agent",
	source: { kind: "worker-dispatch", id: randomUUID(), occurrenceKey: "k" },
} as const;

async function fixture(
	wake: typeof parentWake | typeof workerWake = parentWake,
	options: { present?: string[]; failWrite?: boolean } = {},
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const agent = run.identity.staffAgentId;
	const publication = (todoKey: string, revision: number) => ({
		path: `work/todos/${agent}/${todoKey}.json`,
		revision,
		expectedVersion: null,
		text: `{"schema":"qorpera.agent-todo/v1","todoKey":"${todoKey}"}\n`,
	});
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		const request = (args as { p_request: Record<string, unknown> }).p_request;
		if (method === "qorpera_confirm_agent_todo_publication")
			return { schema: "qorpera.agent-todo-publication/v1", runId: binding.runId, published: true };
		if (method === "qorpera_report_worker_result")
			return {
				schema: "qorpera.worker-report-receipt/v1",
				runId: binding.runId,
				receiptId: randomUUID(),
				workerKey: "prices",
				outcome: request.outcome,
				outputs: [],
				publication: publication("market-scan", 3),
			};
		if (method === "qorpera_manage_agent_worker")
			return request.action === "status"
				? {
						schema: "qorpera.agent-workers/v1",
						runId: binding.runId,
						workers: [{ workerKey: "prices", todoKey: "market-scan", state: "queued", cursor }],
						moreWorkers: 3,
						nextCursor: cursor,
					}
				: {
						schema: "qorpera.agent-worker-receipt/v1",
						runId: binding.runId,
						receiptId: randomUUID(),
						action: request.action,
						todoKey: request.todoKey,
						worker: { workerKey: request.workerKey, state: "queued" },
						publication: publication(request.todoKey as string, 2),
					};
		return request.action === "list"
			? {
					schema: "qorpera.agent-todos/v1",
					runId: binding.runId,
					todos: [{ todoKey: "market-scan", title: "Market scan", state: "open", cursor }],
					moreTodos: 7,
					nextCursor: cursor,
					unpublished: [publication("left-behind", 4)],
				}
			: {
					schema: "qorpera.agent-todo-receipt/v1",
					runId: binding.runId,
					receiptId: randomUUID(),
					action: request.action,
					todo: { todoKey: request.todoKey, state: "open" },
					publication: publication(request.todoKey as string, 1),
				};
	});
	// A small Company File: each present path has a version, and every applied change gives it a new one.
	const versions = new Map((options.present ?? []).map((path) => [path, randomUUID()]));
	const read = vi.fn(async (path: string) => ({
		path,
		version: versions.get(path) ?? null,
		kind: versions.has(path) ? (path.endsWith(".json") ? "file" : "directory") : "absent",
		readObservationId: randomUUID(),
	}));
	const mutate = vi.fn(async (operation: string, input: { path: string; operationKey: string }) => {
		if (options.failWrite && operation === "write") throw new Error("object store unavailable");
		versions.set(input.path, randomUUID());
		return {
			schema: "qorpera.company-path-result/v1" as const,
			state: "applied" as const,
			operationKey: input.operationKey,
			path: input.path,
			version: versions.get(input.path)!,
			snapshotId: randomUUID(),
			receiptId: randomUUID(),
			proposalId: null,
		};
	});
	const gateway = { read, mutate } as unknown as Pick<CloudCompanyPathGateway, "read" | "mutate">;
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudWorkerTools(binding, run.identity, { call }, gateway, wake),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, read, mutate, boundary, agent, versions };
}
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
			expect(child.call).not.toHaveBeenCalled();
		} finally {
			parent.run.close();
			child.run.close();
		}
	});

	it("records a todo in the kernel, then publishes and confirms its Company File document", async () => {
		const f = await fixture();
		try {
			const request = { action: "upsert", operationKey: "t1", todoKey: "market-scan", title: "Market scan for Q4" };
			const first = await f.boundary.invoke("todo_1", "qorpera", "manage_todo", request);
			expect(await f.boundary.invoke("todo_1", "qorpera", "manage_todo", request)).toEqual(first);
			expect(f.call.mock.calls.map((entry) => entry[0])).toEqual([
				"qorpera_manage_agent_todo",
				"qorpera_confirm_agent_todo_publication",
			]);
			expect(f.call.mock.calls[0][1]).toEqual({
				p_binding: f.binding,
				p_request: { ...request, detail: "", state: "open" },
			});
			// The gateway never invents folders: each missing one is created, once, before the document.
			expect(f.mutate.mock.calls.map((entry) => [entry[0], entry[1].path])).toEqual([
				["mkdir", "work"],
				["mkdir", "work/todos"],
				["mkdir", `work/todos/${f.agent}`],
				["write", `work/todos/${f.agent}/market-scan.json`],
			]);
			expect(f.mutate.mock.calls[3][1]).toMatchObject({
				operationKey: "todo-doc:market-scan:1:absent",
				expectedVersion: null,
			});
			const confirmation = f.call.mock.calls[1][1] as { p_request: Record<string, unknown> };
			expect(confirmation.p_request).toMatchObject({ todoKey: "market-scan", revision: 1 });
			const result = body(first);
			expect(result.trust).toBe("untrusted_data");
			expect(JSON.parse(result.content.text).document).toEqual({
				path: `work/todos/${f.agent}/market-scan.json`,
				published: true,
			});
			expect(result.content.text).not.toContain("qorpera.agent-todo/v1");
			expect(JSON.stringify(first)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("keeps the change when publication fails and publishes what is outstanding on the next list", async () => {
		const failing = await fixture(parentWake, { failWrite: true });
		const f = await fixture(parentWake, { present: ["work", "work/todos"] });
		try {
			const kept = await failing.boundary.invoke("todo_1", "qorpera", "manage_todo", {
				action: "done",
				operationKey: "t2",
				todoKey: "market-scan",
			});
			expect(body(kept).status).toBe("ok");
			expect(JSON.parse(body(kept).content.text).document.published).toBe(false);
			const listed = await f.boundary.invoke("todo_2", "qorpera", "manage_todo", { action: "list" });
			expect(JSON.parse(body(listed).content.text).documents).toEqual([
				{ path: `work/todos/${f.agent}/left-behind.json`, published: true },
			]);
			// The list is a page; what it leaves out is counted and reached by its cursor, never shown on an item.
			expect(JSON.parse(body(listed).content.text)).toMatchObject({
				todos: [{ todoKey: "market-scan", title: "Market scan", state: "open" }],
				moreTodos: 7,
				nextCursor: cursor,
			});
			expect(f.mutate.mock.calls.map((entry) => entry[0])).toEqual(["mkdir", "write"]);
		} finally {
			failing.run.close();
			f.run.close();
		}
	});

	it("pages both listings by cursor, with filters, and refuses a malformed filter before any cloud call", async () => {
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
			expect(f.call.mock.calls[0][1]).toEqual({
				p_binding: f.binding,
				p_request: { action: "list", todoKey: "market-scan", state: "done", search: "Invoice", cursor },
			});
			const status = await f.boundary.invoke("s1", "qorpera", "manage_worker", {
				action: "status",
				todoKey: "market-scan",
				state: "active",
				search: "prices",
				cursor,
			});
			expect(f.call.mock.calls.at(-1)?.[1]).toEqual({
				p_binding: f.binding,
				p_request: { action: "status", todoKey: "market-scan", state: "active", search: "prices", cursor },
			});
			expect(JSON.parse(body(status).content.text)).toEqual({
				schema: "qorpera.agent-workers/v1",
				runId: f.binding.runId,
				workers: [{ workerKey: "prices", todoKey: "market-scan", state: "queued" }],
				moreWorkers: 3,
				nextCursor: cursor,
			});
			const calls = f.call.mock.calls.length;
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
			expect(f.call.mock.calls.length).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("writes a todo document against the version it read, under a key naming that version", async () => {
		const f = await fixture(parentWake, { present: ["work", "work/todos"] });
		const path = `work/todos/${f.agent}/market-scan.json`;
		try {
			f.versions.set(`work/todos/${f.agent}`, randomUUID());
			f.versions.set(path, randomUUID());
			const before = f.versions.get(path);
			const request = { action: "upsert", operationKey: "t1", todoKey: "market-scan", title: "Market scan for Q4" };
			await f.boundary.invoke("todo_1", "qorpera", "manage_todo", request);
			expect(f.mutate.mock.calls.map((entry) => entry[0])).toEqual(["write"]);
			expect(f.mutate.mock.calls[0][1]).toMatchObject({
				operationKey: `todo-doc:market-scan:1:${before}`,
				expectedVersion: before,
			});
			// The file changed after that write (here: by the write itself). Publishing the same revision
			// again is a new write against the new version, not a replay of the old one.
			const after = f.versions.get(path);
			expect(after).not.toBe(before);
			await f.boundary.invoke("todo_2", "qorpera", "manage_todo", request);
			expect(f.mutate.mock.calls[1][1]).toMatchObject({
				operationKey: `todo-doc:market-scan:1:${after}`,
				expectedVersion: after,
			});
		} finally {
			f.run.close();
		}
	});

	it("reports a document the kernel refused as unpublished and keeps the change", async () => {
		const f = await fixture(parentWake, { present: ["work", "work/todos"] });
		try {
			f.mutate.mockImplementationOnce(async () => {
				throw new Error("Todo document is not the current revision");
			});
			const kept = await f.boundary.invoke("todo_1", "qorpera", "manage_todo", {
				action: "upsert",
				operationKey: "t1",
				todoKey: "market-scan",
				title: "Market scan for Q4",
			});
			expect(body(kept).status).toBe("ok");
			expect(JSON.parse(body(kept).content.text).document).toEqual({
				path: `work/todos/${f.agent}/market-scan.json`,
				published: false,
			});
			expect(f.call.mock.calls.map((entry) => entry[0])).toEqual(["qorpera_manage_agent_todo"]);
		} finally {
			f.run.close();
		}
	});

	it("refuses a page whose count and cursor disagree", async () => {
		const todos = [{ todoKey: "market-scan", cursor }];
		for (const broken of [
			{ todos, moreTodos: 7, nextCursor: null },
			{ todos, moreTodos: 0, nextCursor: cursor },
			{ todos, moreTodos: -1, nextCursor: null },
			{ todos, moreTodos: 1, nextCursor: "not-a-cursor" },
			{ todos, moreTodos: 1, nextCursor: randomUUID() },
			{ todos, moreTodos: 0 },
			{ todos: [{ todoKey: "market-scan" }], moreTodos: 0, nextCursor: null },
			{ todos: [{ todoKey: "market-scan", cursor: "page-2" }], moreTodos: 0, nextCursor: null },
		]) {
			const f = await fixture();
			try {
				f.call.mockImplementationOnce(async () => ({
					schema: "qorpera.agent-todos/v1",
					runId: f.binding.runId,
					unpublished: [],
					...broken,
				}));
				const listed = await f.boundary.invoke("l1", "qorpera", "manage_todo", { action: "list" });
				expect(body(listed).status).not.toBe("ok");
			} finally {
				f.run.close();
			}
		}
	});

	it.each([
		["manage_todo", { action: "list" }, "todos", "moreTodos", 32, 10],
		["manage_worker", { action: "status" }, "workers", "moreWorkers", 16, 0],
	] as const)(
		"shows as much of a %s page as reaches the model whole, and continues after the last item shown",
		async (tool, request, items, more, size, after) => {
			const f = await fixture();
			try {
				const cursors = Array.from({ length: size }, () => randomUUID());
				const listed = cursors.map((itemCursor, index) =>
					items === "todos"
						? {
								todoKey: `todo-${index}`,
								title: `A piece of work number ${index}`,
								detail: 'Plan: "read", <check> & report.\n'.repeat(7).slice(0, 200),
								state: "open",
								workers: [1, 2, 3, 4].map((n) => ({ workerKey: `w-${n}`, state: "queued" })),
								cursor: itemCursor,
							}
						: {
								workerKey: `worker-${index}`,
								todoKey: "market-scan",
								title: `Research part ${index}`,
								state: "succeeded",
								summary: 'Found "it": <b>\n'.repeat(14).slice(0, 200),
								cursor: itemCursor,
							},
				);
				f.call.mockImplementationOnce(async () => ({
					schema: items === "todos" ? "qorpera.agent-todos/v1" : "qorpera.agent-workers/v1",
					runId: f.binding.runId,
					[items]: listed,
					[more]: after,
					nextCursor: after > 0 ? cursors.at(-1) : null,
					...(items === "todos" ? { unpublished: [] } : {}),
				}));
				const envelope = body(await f.boundary.invoke("page", "qorpera", tool, request));
				expect(envelope.status).toBe("ok");
				// The fence cuts anything past 8 KiB; a fitted page never reaches that.
				expect(envelope.content.truncated).toBe(false);
				const page = JSON.parse(envelope.content.text);
				const shown = page[items].length;
				expect(shown).toBeGreaterThan(1);
				expect(shown).toBeLessThan(size);
				expect(page[items].some((item: Record<string, unknown>) => "cursor" in item)).toBe(false);
				expect(page[more]).toBe(after + size - shown);
				expect(page.nextCursor).toBe(cursors[shown - 1]);
			} finally {
				f.run.close();
			}
		},
	);

	it("still shows a prefix of a page that would be too wide to render whole", async () => {
		const f = await fixture();
		try {
			const cursors = Array.from({ length: 32 }, () => randomUUID());
			f.call.mockImplementationOnce(async () => ({
				schema: "qorpera.agent-todos/v1",
				runId: f.binding.runId,
				// Control characters escape to six bytes each: the whole page would pass 64 KiB.
				todos: cursors.map((itemCursor, index) => ({
					todoKey: `todo-${index}`,
					title: "\u0001".repeat(200),
					detail: "\u0001".repeat(200),
					cursor: itemCursor,
				})),
				moreTodos: 0,
				nextCursor: null,
				unpublished: [],
			}));
			const envelope = body(await f.boundary.invoke("wide", "qorpera", "manage_todo", { action: "list" }));
			expect(envelope.status).toBe("ok");
			const page = JSON.parse(envelope.content.text);
			expect(page.todos.length).toBeGreaterThan(0);
			expect(page).toMatchObject({ moreTodos: 32 - page.todos.length, nextCursor: cursors[page.todos.length - 1] });
		} finally {
			f.run.close();
		}
	});

	it("shows one item alone when even it does not fit, so a walk always moves on", async () => {
		const f = await fixture();
		try {
			const cursors = [randomUUID(), randomUUID()];
			f.call.mockImplementationOnce(async () => ({
				schema: "qorpera.agent-todos/v1",
				runId: f.binding.runId,
				todos: cursors.map((itemCursor, index) => ({
					todoKey: `todo-${index}`,
					title: "Wide",
					zDetail: "x".repeat(9000),
					cursor: itemCursor,
				})),
				moreTodos: 0,
				nextCursor: null,
				unpublished: [],
			}));
			const envelope = body(await f.boundary.invoke("big", "qorpera", "manage_todo", { action: "list" }));
			// Counts and cursor sort before the items, so they survive the fence's cut of the one wide item.
			expect(envelope.content.truncated).toBe(true);
			expect(envelope.content.text).toContain(`"moreTodos":1,"nextCursor":"${cursors[0]}"`);
		} finally {
			f.run.close();
		}
	});

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

	it("sends a complete dispatch and refuses an incomplete or widened one before any cloud call", async () => {
		const f = await fixture();
		try {
			const sent = await f.boundary.invoke("w1", "qorpera", "manage_worker", dispatch);
			expect(body(sent).status).toBe("ok");
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_manage_agent_worker",
				{ p_binding: f.binding, p_request: { ...dispatch, revival: "batch" } },
			]);
			// A folder named with a trailing slash is the same folder.
			await f.boundary.invoke("w2", "qorpera", "manage_worker", {
				...dispatch,
				operationKey: "d2",
				workerKey: "interviews",
				sources: ["founder/interviews/"],
			});
			expect((f.call.mock.calls.at(-2)?.[1] as { p_request: { sources: string[] } }).p_request.sources).toEqual([
				"founder/interviews",
			]);
			const calls = f.call.mock.calls.length;
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
			expect(f.call.mock.calls.length).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("answers a refusal of its call with the database's words, once, never as a lost connection", async () => {
		const f = await fixture();
		try {
			// The folder-v2 worker rules refuse a coding dispatch (55000); PostgREST answers 500. The agent is told why and
			// the call is not made again (control calls, 4 Oct 2026).
			f.call.mockRejectedValueOnce(
				new CloudControlRpcRefused("55000", "Coding workers come to the company folder with coding machines"),
			);
			const refused = await f.boundary.invoke("w1", "qorpera", "manage_worker", dispatch);
			expect(body(refused)).toMatchObject({
				status: "denied",
				content: { text: "REFUSED: NOT_AVAILABLE: Coding workers come to the company folder with coding machines" },
			});
			expect(f.call).toHaveBeenCalledTimes(1);
			// A 42501 with words is relayed the same way; one whose words are not plain says only that it is not available.
			f.call.mockRejectedValueOnce(new CloudCompanyPathRpcRefusal("Run is unavailable"));
			const denied = await f.boundary.invoke("w2", "qorpera", "manage_worker", { ...dispatch, operationKey: "d2" });
			expect(body(denied).content.text).toBe("REFUSED: NOT_AVAILABLE: Run is unavailable");
			f.call.mockRejectedValueOnce(
				new CloudControlRpcRefused("0A000", "Settings \u2192 General has no \u{1F600} here"),
			);
			const odd = await f.boundary.invoke("w3", "qorpera", "manage_worker", { ...dispatch, operationKey: "d3" });
			expect(body(odd).content.text).toBe("REFUSED: NOT_AVAILABLE: this is not available now");
			// Anything else stays an unknown outcome.
			f.call.mockRejectedValueOnce(new CloudRuntimeDiagnosticError("transport_unavailable"));
			const lost = await f.boundary.invoke("w4", "qorpera", "manage_worker", { ...dispatch, operationKey: "d4" });
			expect(body(lost)).toMatchObject({ status: "unconfirmed", content: { text: "TOOL_OUTCOME_UNCONFIRMED" } });
			expect(f.call).toHaveBeenCalledTimes(4);
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
			const request = (
				f.call.mock.calls.filter(([method]) => method === "qorpera_manage_agent_worker").at(-1)?.[1] as {
					p_request: Record<string, unknown>;
				}
			).p_request;
			expect(request.species).toBe("coding");
			expect(request).not.toHaveProperty("owner");
			const calls = f.call.mock.calls.length;
			// The session runs for the member who asked (the run's requester); the model cannot pick a payer.
			const refused = await f.boundary.invoke("c2", "qorpera", "manage_worker", {
				...coding,
				operationKey: "c2",
				owner: randomUUID(),
			});
			expect(body(refused).status).toBe("denied");
			expect(f.call.mock.calls.length).toBe(calls);
		} finally {
			f.run.close();
		}
	});

	it("lets a worker report once to its parent, with a question only when blocked", async () => {
		const f = await fixture(workerWake, { present: ["work", "work/todos"] });
		try {
			const report = { operationKey: "r1", outcome: "succeeded", summary: "Alfa 49, Beta 59, Gamma 45." };
			const first = await f.boundary.invoke("r_1", "qorpera", "report_work", report);
			expect(body(first).status).toBe("ok");
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_report_worker_result",
				{ p_binding: f.binding, p_request: report },
			]);
			expect(f.mutate.mock.calls.at(-1)?.[1]).toMatchObject({ operationKey: "todo-doc:market-scan:3:absent" });
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
			["company_read", "company_list", "company_write", "company_mkdir", "company_delete"].filter((name) =>
				readOnly.companyFile(tool(name)),
			),
		).toEqual(["company_read", "company_list"]);
		expect(writer.companyFile(tool("company_write")) && parent.companyFile(tool("company_delete"))).toBe(true);
	});
});

describe("a folder-v2 agent's todos", () => {
	it("saves through the folder writer and says the todos are files", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const identity = authority.identity;
		const call = vi.fn<CloudCompanyPathControl["call"]>(async () => ({}));
		const change = vi.fn(async () => ({ kind: "text" as const, value: '{"saved":true}' }));
		const list = vi.fn(async () => ({ kind: "text" as const, value: '{"todos":[]}' }));
		const gateway = { read: vi.fn(), mutate: vi.fn() } as unknown as Pick<CloudCompanyPathGateway, "read" | "mutate">;
		const tools = cloudWorkerTools(binding, identity, { call }, gateway, parentWake, {
			folderTodos: { change, list } as unknown as CloudFolderTodos,
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
		expect(list).toHaveBeenCalledWith({ action: "list", includeClosed: true }, context, expect.any(Function));
		expect(call).not.toHaveBeenCalled();
	});
});
