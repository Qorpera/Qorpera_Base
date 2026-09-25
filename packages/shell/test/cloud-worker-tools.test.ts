import { randomUUID } from "node:crypto";
import type { CloudCompanyPathControl, CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudWorkerToolFilter, cloudWorkerTools } from "@qorpera/runtime/cloud-worker-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const parentWake = { kind: "room", source: { kind: "room", id: randomUUID(), occurrenceKey: "k" } } as const;
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
				? { schema: "qorpera.agent-workers/v1", runId: binding.runId, workers: [] }
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
					todos: [],
					moreTodos: 7,
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
			// The list is a page; what it leaves out reaches the agent as a count (runtime v95).
			expect(JSON.parse(body(listed).content.text).moreTodos).toBe(7);
			expect(f.mutate.mock.calls.map((entry) => entry[0])).toEqual(["mkdir", "write"]);
		} finally {
			failing.run.close();
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
