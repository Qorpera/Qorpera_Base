import { randomUUID } from "node:crypto";
import type { CloudCompanyPathGateway } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyHeadConflict } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	cloudMemoryLogPath,
	cloudMemoryPaths,
	cloudMemoryTools,
	composeCloudAgentMemory,
	unavailableCloudAgentMemory,
} from "@qorpera/runtime/cloud-memory-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** An in-memory Company File: versioned text objects behind the gateway's trusted reads and governed writes. */
function companyFile(initial: Record<string, string> = {}) {
	const files = new Map<string, { version: string; text: string }>();
	// Folders are real entries, as in the live tree: the gateway never invents a parent.
	const folders = new Set<string>();
	const parent = (path: string) => path.split("/").slice(0, -1).join("/");
	for (const [path, text] of Object.entries(initial)) {
		files.set(path, { version: randomUUID(), text });
		for (let folder = parent(path); folder; folder = parent(folder)) folders.add(folder);
	}
	const conflicts: string[] = [];
	const readTrusted = vi.fn<CloudCompanyPathGateway["readTrusted"]>(async (path) => {
		const file = files.get(path);
		if (file) return { path, version: file.version, kind: "file", text: file.text, fileSha256: "a".repeat(64) };
		return folders.has(path) ? { path, version: randomUUID(), kind: "directory", text: "", fileSha256: null } : null;
	});
	const listTrusted = vi.fn<CloudCompanyPathGateway["listTrusted"]>(async (path) =>
		[...files.entries()]
			.filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
			.sort(([a], [b]) => a.localeCompare(b, "en"))
			.map(([key, file]) => ({ path: key, version: file.version, kind: "file" as const, bytes: file.text.length })),
	);
	const mutate = vi.fn<CloudCompanyPathGateway["mutate"]>(async (operation, input) => {
		if (parent(input.path) && !folders.has(parent(input.path))) throw new Error("Company File parent is absent");
		if (operation === "mkdir") {
			if (folders.has(input.path) || files.has(input.path)) throw new CloudCompanyHeadConflict();
			folders.add(input.path);
			return {
				schema: "qorpera.company-path-result/v1",
				state: "applied",
				operationKey: input.operationKey,
				path: input.path,
				version: randomUUID(),
				snapshotId: randomUUID(),
				receiptId: randomUUID(),
				proposalId: null,
			};
		}
		if (operation !== "write") throw new Error("Unexpected memory operation");
		const current = files.get(input.path) ?? null;
		if ((current?.version ?? null) !== input.expectedVersion) throw new CloudCompanyHeadConflict();
		if (conflicts.length) {
			conflicts.pop();
			files.set(input.path, { version: randomUUID(), text: current?.text ?? "" });
			throw new CloudCompanyHeadConflict();
		}
		const version = randomUUID();
		files.set(input.path, { version, text: input.text as string });
		return {
			schema: "qorpera.company-path-result/v1",
			state: "applied",
			operationKey: input.operationKey,
			path: input.path,
			version,
			snapshotId: randomUUID(),
			receiptId: randomUUID(),
			proposalId: null,
		};
	});
	return { files, conflicts, gateway: { readTrusted, listTrusted, mutate }, readTrusted, listTrusted, mutate };
}

const NOW = new Date(Date.UTC(2026, 8, 22, 21, 30, 0));

async function fixture(initial: Record<string, string> = {}) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const agent = run.identity.staffAgentId;
	const paths = cloudMemoryPaths(agent);
	const store = companyFile(
		Object.fromEntries(Object.entries(initial).map(([key, text]) => [key.replace("<agent>", agent), text])),
	);
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudMemoryTools(store.gateway, run.identity, () => NOW),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	const receipt = (result: Awaited<ReturnType<CloudNativeToolBoundary["invoke"]>>) =>
		JSON.parse(JSON.parse(result.contentItems[0].text).content.text);
	return { run, agent, paths, store, boundary, receipt };
}

describe("agent memory notebook", () => {
	it("keeps the Grok Bot layout: profile.md plus one dated log file per month, one fact per line", async () => {
		const f = await fixture();
		try {
			const logged = await f.boundary.invoke("m1", "qorpera", "update_memory", {
				action: "write",
				fact: "Jonas prefers short replies in Danish.",
			});
			expect(logged.success, JSON.stringify(logged)).toBe(true);
			expect(f.receipt(logged)).toMatchObject({ state: "written", tier: "log", date: "2026-09-22" });
			// Company first: a notebook has no scopes and no member shard.
			expect(f.receipt(logged)).not.toHaveProperty("scope");
			const profiled = await f.boundary.invoke("m2", "qorpera", "update_memory", {
				action: "write",
				tier: "profile",
				fact: "I own the weekly ledger review.",
			});
			expect(f.receipt(profiled)).toMatchObject({ state: "written", tier: "profile", path: f.paths.profile });
			const noted = await f.boundary.invoke("m3", "qorpera", "update_memory", {
				action: "write",
				tier: "note",
				fact: "The September export is still running.",
			});
			expect(f.receipt(noted).state).toBe("written");
			expect(f.store.files.get(cloudMemoryLogPath(f.agent, NOW))?.text).toBe(
				"- (2026-09-22) Jonas prefers short replies in Danish.\n- (2026-09-22) [note] The September export is still running.\n",
			);
			expect(f.store.files.get(f.paths.profile)?.text).toBe("- (2026-09-22) I own the weekly ledger review.\n");
			expect(cloudMemoryLogPath(f.agent, NOW)).toBe(`agents/${f.agent}/memory/log/2026-09.md`);
			// The first fact created the notebook's folders, once each and in order.
			const mkdirs = f.store.mutate.mock.calls.filter(([operation]) => operation === "mkdir");
			expect(mkdirs.map(([, input]) => input.path)).toEqual([
				"agents",
				`agents/${f.agent}`,
				`agents/${f.agent}/memory`,
				`agents/${f.agent}/memory/log`,
			]);
			for (const [, input] of mkdirs) {
				expect(input.operationKey).toMatch(/^memory-folder-[0-9a-f]{40}$/);
				expect(input.expectedVersion).toBeNull();
			}
			// Every write carried the exact version it read and its own operation key.
			const writes = f.store.mutate.mock.calls
				.map((call, index) => ({ call, index }))
				.filter(({ call: [operation] }) => operation === "write");
			for (const { call } of writes) expect(call[1].operationKey).toMatch(/^memory-write-[0-9a-f]{40}$/);
			expect(writes[0].call[1].expectedVersion).toBeNull();
			expect(writes[2].call[1].expectedVersion).toBe(
				(await f.store.mutate.mock.results[writes[0].index].value).version,
			);
		} finally {
			f.run.close();
		}
	});

	it("deduplicates on write", async () => {
		const f = await fixture({
			"agents/<agent>/memory/log/2026-09.md": "- (2026-09-01) Jonas prefers short replies.\n",
		});
		try {
			const again = await f.boundary.invoke("d1", "qorpera", "update_memory", {
				action: "write",
				fact: "  Jonas   prefers short replies. ",
			});
			expect(f.receipt(again)).toMatchObject({ state: "duplicate", tier: "log" });
			expect(f.store.mutate).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("forgets by exact recorded text and rewrites the file with its current version", async () => {
		const f = await fixture({
			"agents/<agent>/memory/profile.md":
				"- (2026-08-01) I report to Jonas.\n- (2026-08-02) I use British spelling.\n",
			"agents/<agent>/memory/log/2026-08.md":
				"- (2026-08-28) [note] Old export path.\n- (2026-08-29) Decided to bill monthly.\n",
		});
		try {
			const before = f.store.files.get(f.paths.profile)!.version;
			const gone = await f.boundary.invoke("f1", "qorpera", "update_memory", {
				action: "forget",
				fact: "I use British spelling.",
			});
			expect(f.receipt(gone)).toMatchObject({ state: "forgotten", removed: 1, path: f.paths.profile });
			expect(f.store.mutate.mock.calls[0][1]).toMatchObject({
				expectedVersion: before,
				text: "- (2026-08-01) I report to Jonas.\n",
			});
			const note = await f.boundary.invoke("f2", "qorpera", "update_memory", {
				action: "forget",
				fact: "Old export path.",
			});
			expect(f.receipt(note)).toMatchObject({ state: "forgotten", removed: 1 });
			expect(f.store.files.get(`agents/${f.agent}/memory/log/2026-08.md`)?.text).toBe(
				"- (2026-08-29) Decided to bill monthly.\n",
			);
			const missing = await f.boundary.invoke("f3", "qorpera", "update_memory", {
				action: "forget",
				fact: "Never recorded.",
			});
			expect(f.receipt(missing).state).toBe("not_found");
			expect(f.store.mutate).toHaveBeenCalledTimes(2);
		} finally {
			f.run.close();
		}
	});

	it("re-reads and retries once when the notebook's head moved under a write", async () => {
		const f = await fixture({ "agents/<agent>/memory/log/2026-09.md": "- (2026-09-01) First.\n" });
		try {
			f.store.conflicts.push("once");
			const result = await f.boundary.invoke("c1", "qorpera", "update_memory", { action: "write", fact: "Second." });
			expect(f.receipt(result).state).toBe("written");
			expect(f.store.mutate).toHaveBeenCalledTimes(2);
			expect(f.store.mutate.mock.calls[1][1].expectedVersion).not.toBe(
				f.store.mutate.mock.calls[0][1].expectedVersion,
			);
			expect(f.store.files.get(cloudMemoryLogPath(f.agent, NOW))?.text).toBe(
				"- (2026-09-01) First.\n- (2026-09-22) Second.\n",
			);
		} finally {
			f.run.close();
		}
	});

	it("recalls by distinctive words first, newest first, and falls back to a substring match", async () => {
		const f = await fixture({
			"agents/<agent>/memory/profile.md": "- (2026-07-01) I prefer the Danish ledger format.\n",
			"agents/<agent>/memory/log/2026-08.md":
				"- (2026-08-10) Ledger review moved to Fridays.\n- (2026-08-11) [note] Ledger export took 40 minutes.\n",
			"agents/<agent>/memory/log/2026-09.md":
				"- (2026-09-02) Jonas approved the Q3 ledger review plan.\n- (2026-09-03) Coffee machine is on floor two.\n",
		});
		try {
			const result = await f.boundary.invoke("r1", "qorpera", "recall_memory", { query: "ledger review", limit: 2 });
			expect(result.success, JSON.stringify(result)).toBe(true);
			const recall = f.receipt(result);
			expect(recall).toMatchObject({ moreFacts: 2 });
			// Grok-shaped result: facts with date and tier, nothing about files, ranking or scopes.
			expect(Object.keys(recall).sort()).toEqual(["facts", "moreFacts", "query", "runId", "schema"]);
			expect(recall.facts.map((fact: { fact: string }) => fact.fact)).toEqual([
				"Jonas approved the Q3 ledger review plan.",
				"Ledger review moved to Fridays.",
			]);
			expect(recall.facts[1]).toEqual({ date: "2026-08-10", tier: "log", fact: "Ledger review moved to Fridays." });
			const literal = f.receipt(await f.boundary.invoke("r2", "qorpera", "recall_memory", { query: "floor two" }));
			expect(literal).toMatchObject({ facts: [{ fact: "Coffee machine is on floor two." }] });
			const substring = f.receipt(await f.boundary.invoke("r3", "qorpera", "recall_memory", { query: "Q3 le" }));
			expect(substring.facts).toEqual([
				{ fact: "Jonas approved the Q3 ledger review plan.", tier: "log", date: "2026-09-02" },
			]);
			const none = f.receipt(await f.boundary.invoke("r4", "qorpera", "recall_memory", { query: "unicorns" }));
			expect(none.facts).toEqual([]);
		} finally {
			f.run.close();
		}
	});

	it.each([
		["a newline in a fact", { action: "write", fact: "two\nlines" }],
		["an unknown tier", { action: "write", fact: "x", tier: "episode" }],
		["a member scope", { action: "write", fact: "x", scope: "user" }],
		["an agent scope", { action: "write", fact: "x", scope: "agent" }],
		["a tier on forget", { action: "forget", fact: "x", tier: "log" }],
		["an unknown field", { action: "write", fact: "x", path: "agents/other/memory/profile.md" }],
	])("rejects %s before any read or write", async (_label, request) => {
		const f = await fixture();
		try {
			expect((await f.boundary.invoke("bad", "qorpera", "update_memory", request)).success).toBe(false);
			expect(f.store.readTrusted).not.toHaveBeenCalled();
			expect(f.store.mutate).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it.each([
		["a member scope", { query: "ledger", scope: "user" }],
		["an all scope", { query: "ledger", scope: "all" }],
	])("refuses recall with %s before any read", async (_label, request) => {
		const f = await fixture();
		try {
			expect((await f.boundary.invoke("bad", "qorpera", "recall_memory", request)).success).toBe(false);
			expect(f.store.readTrusted).not.toHaveBeenCalled();
			expect(f.store.listTrusted).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("advertises no scope parameter: memory is company first, with no member shard", () => {
		const { gateway } = companyFile();
		const identity = nativeToolAuthorityFixture().authority.identity;
		for (const tool of cloudMemoryTools(gateway, identity)) {
			expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toContain("scope");
			expect(tool.description).not.toMatch(/scope|shard/i);
		}
	});

	it("only ever addresses the executing agent's own notebook", async () => {
		const f = await fixture();
		try {
			await f.boundary.invoke("o1", "qorpera", "update_memory", { action: "write", fact: "Mine." });
			await f.boundary.invoke("o2", "qorpera", "recall_memory", { query: "mine" });
			const touched = [
				...f.store.readTrusted.mock.calls.map(([path]) => path),
				...f.store.listTrusted.mock.calls.map(([path]) => path),
				...f.store.mutate.mock.calls.map(([, input]) => input.path),
			];
			expect(touched.length).toBeGreaterThan(0);
			// Its own notebook, plus the two folders on the way to it; never another agent's.
			for (const path of touched)
				expect(
					path === "agents" || path === `agents/${f.agent}` || path.startsWith(`agents/${f.agent}/memory`),
					path,
				).toBe(true);
		} finally {
			f.run.close();
		}
	});
});

describe("composed agent memory", () => {
	it("composes the whole profile, the newest log facts of two months, and fades old notes", async () => {
		const agent = randomUUID();
		const store = companyFile({
			[`agents/${agent}/memory/profile.md`]: "# Profile\n- (2026-07-01) I report to Jonas.\n",
			[`agents/${agent}/memory/log/2026-07.md`]: "- (2026-07-15) Too old for the slice.\n",
			[`agents/${agent}/memory/log/2026-08.md`]:
				"- (2026-08-20) [note] Faded note.\n- (2026-08-29) Decided to bill monthly.\n",
			[`agents/${agent}/memory/log/2026-09.md`]:
				"- (2026-09-18) [note] Fresh note.\n- (2026-09-21) Ledger review moved to Fridays.\n",
		});
		const block = await composeCloudAgentMemory(store.gateway, agent, NOW, new AbortController().signal);
		expect(block).toMatchObject({
			schema: "qorpera.agent-memory/v1",
			trust: "own_notebook_not_authority",
			available: true,
			tools: ["update_memory", "recall_memory"],
			profile: {
				path: `agents/${agent}/memory/profile.md`,
				facts: [{ date: "2026-07-01", tier: "profile" }],
				moreFacts: 0,
			},
		});
		expect(block).not.toHaveProperty("scope");
		expect(block.profile.version).toBe(store.files.get(`agents/${agent}/memory/profile.md`)!.version);
		expect(block.recentLog.files.map((file) => file.path)).toEqual([
			`agents/${agent}/memory/log/2026-09.md`,
			`agents/${agent}/memory/log/2026-08.md`,
		]);
		expect(block.recentLog.facts.map((fact) => fact.fact)).toEqual([
			"Ledger review moved to Fridays.",
			"Fresh note.",
			"Decided to bill monthly.",
		]);
		expect(block.recentLog.facts[1].tier).toBe("note");
		expect(block.recentLog.moreFacts).toBe(0);
		// Composition never spends a model read: only the trusted lane was used.
		expect(store.readTrusted).toHaveBeenCalledTimes(3);
		expect(store.listTrusted).not.toHaveBeenCalled();
	});

	it("is an empty notebook for a new agent and an unavailable block when the read lane fails", async () => {
		const agent = randomUUID();
		const block = await composeCloudAgentMemory(companyFile().gateway, agent, NOW, new AbortController().signal);
		expect(block).toMatchObject({
			available: true,
			profile: { version: null, facts: [] },
			recentLog: { files: [], facts: [] },
		});
		expect(unavailableCloudAgentMemory("transport_unavailable")).toMatchObject({
			available: false,
			reason: "transport_unavailable",
			tools: ["update_memory", "recall_memory"],
		});
	});
});
