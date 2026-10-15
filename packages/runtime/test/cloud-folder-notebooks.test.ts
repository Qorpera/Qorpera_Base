import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { CloudFolderNotebooks } from "@qorpera/runtime/cloud-folder-notebooks";
import { cloudMemoryTools, composeCloudAgentMemory } from "@qorpera/runtime/cloud-memory-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import type { CloudNativeTool, CloudToolContent } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudSkillTools, composeCloudAgentSkills } from "@qorpera/runtime/cloud-skill-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});

const PLACE = { core: "folder-v2", handle: "nora" } as const;
const NOW = new Date("2026-10-03T08:00:00Z");
const LOG = "agents/nora/memory/log/2026-10.md";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const parse = (content: CloudToolContent) => JSON.parse(String(content.value));

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const notebooks = new CloudFolderNotebooks({
		folder: f.folder,
		runId: f.identity.runId,
		agentFolder: "agents/nora",
	});
	const tools = [
		...notebooks.tools((files) => cloudMemoryTools(files, f.identity, PLACE, () => NOW), f.operations()),
		...notebooks.tools((files) => cloudSkillTools(files, f.identity, PLACE), f.operations()),
	];
	const call = async (name: string, value: JsonValue) => {
		const tool = tools.find((candidate) => candidate.name === name) as CloudNativeTool;
		return tool.execute(tool.parseArguments(value), { ...f.context, callId: randomUUID() });
	};
	return { ...f, notebooks, tools, call };
}

it("offers the same memory and skill tools for a folder-v2 run", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => tool.name)).toEqual([
		"update_memory",
		"recall_memory",
		"read_skill",
		"search_skills",
		"update_skill",
	]);
});

it("writes a fact into the agent's notebook through the folder core, making its folders, each under a receipt", async () => {
	const f = await fixture();
	const content = await f.call("update_memory", { action: "write", fact: "Ada prefers short replies" });
	expect(parse(content)).toMatchObject({ state: "written", tier: "log", path: LOG });
	expect(f.text(LOG)).toBe("- (2026-10-03) Ada prefers short replies\n");
	// The folder core never invents a folder: memory/ and log/ first, then the file, each its own change set.
	expect(
		f.commits.map((commit) => [commit.key.split(":")[0], commit.units.map((unit) => [unit.op, unit.path])]),
	).toEqual([
		["update_memory", [["mkdir", "agents/nora/memory"]]],
		["update_memory", [["mkdir", "agents/nora/memory/log"]]],
		["update_memory", [["write", LOG]]],
	]);
	expect(f.commits.every((commit) => typeof commit.receiptId === "string")).toBe(true);
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(3);
	// The folders it read on the way are released under the answer's text.
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]?.p_output_sha256).toBe(sha(String(content.value)));
});

it("answers a duplicate from the notebook, recalls facts with a release of what it read, and forgets under the file's version", async () => {
	const f = await fixture({
		files: { [LOG]: "- (2026-10-01) Ada prefers short replies\n- (2026-10-02) The bank is Nordea\n" },
	});
	expect(parse(await f.call("update_memory", { action: "write", fact: "ada prefers  short replies" }))).toMatchObject({
		state: "duplicate",
		path: LOG,
	});
	expect(f.commits).toHaveLength(0);
	const recall = await f.call("recall_memory", { query: "Nordea" });
	expect(parse(recall).facts).toEqual([{ date: "2026-10-02", tier: "log", fact: "The bank is Nordea" }]);
	const released = f.releases.at(-1);
	expect(released?.p_output_sha256).toBe(sha(String(recall.value)));
	expect(
		(released?.p_reads as { path: string; fileSha256?: string }[]).find((read) => read.path === LOG),
	).toMatchObject({
		fileSha256: f.files.get(LOG)?.file.fileSha256,
	});
	const version = f.files.get(LOG)?.version;
	expect(parse(await f.call("update_memory", { action: "forget", fact: "The bank is Nordea" }))).toMatchObject({
		state: "forgotten",
		removed: 1,
	});
	expect(f.text(LOG)).toBe("- (2026-10-01) Ada prefers short replies\n");
	expect(f.commits.at(-1)?.units).toEqual([
		{ op: "write", path: LOG, file: expect.any(Object), expectedVersion: version },
	]);
});

it("reads the notebook again and redoes a write that met a newer version", async () => {
	const f = await fixture({ files: { [LOG]: "- (2026-10-01) First\n" } });
	const original = CloudCompanyFolderClient.prototype.commit;
	vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		// Another writer saved the month between this write's read and its commit.
		f.seed(LOG, "- (2026-10-01) First\n- (2026-10-02) Second\n");
		return original.apply(this, args);
	});
	expect(parse(await f.call("update_memory", { action: "write", fact: "Third" }))).toMatchObject({ state: "written" });
	expect(f.text(LOG)).toBe("- (2026-10-01) First\n- (2026-10-02) Second\n- (2026-10-03) Third\n");
	// Two change sets under two receipts: the first was a conflict, nothing of it was written.
	expect(f.commits).toHaveLength(2);
	expect(f.commits[0]?.key).not.toBe(f.commits[1]?.key);
});

it("composes the notebook and the skill catalog through the folder, and releases what it read once, under the context", async () => {
	const f = await fixture({
		files: {
			"agents/nora/memory/profile.md": "- (2026-09-01) I am Nora, the bookkeeper\n",
			[LOG]: "- (2026-10-02) The bank is Nordea\n",
			"skills/invoices/SKILL.md": "---\nname: invoices\ndescription: How to send an invoice\n---\nSteps.\n",
		},
		folders: ["skills"],
	});
	const signal = new AbortController().signal;
	const memory = await composeCloudAgentMemory(f.notebooks.composition, "agents/nora", NOW, signal);
	expect(memory.profile.facts).toEqual([{ date: "2026-09-01", tier: "profile", fact: "I am Nora, the bookkeeper" }]);
	expect(memory.recentLog.facts).toEqual([{ date: "2026-10-02", tier: "log", fact: "The bank is Nordea" }]);
	const skills = await composeCloudAgentSkills(f.notebooks.composition, f.identity, signal, PLACE);
	expect(skills.company.skills.map((skill) => skill.name)).toEqual(["invoices"]);
	expect(f.releases).toHaveLength(0);
	const context = sha("the composed context");
	await f.notebooks.releaseComposition(context, signal);
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]?.p_output_sha256).toBe(context);
	const paths = (f.releases[0]?.p_reads as { path: string }[]).map((read) => read.path);
	expect(paths).toEqual(expect.arrayContaining(["agents/nora/memory/profile.md", LOG, "skills/invoices/SKILL.md"]));
	// Released once: nothing more to release.
	await f.notebooks.releaseComposition(context, signal);
	expect(f.releases).toHaveLength(1);
	// Composition changes nothing.
	await expect(
		f.notebooks.composition.mutate("mkdir", { path: "x", operationKey: "x-1", expectedVersion: null }, signal),
	).rejects.toThrow("inside a tool call");
});

it("creates, reads and deletes the agent's own skill through the folder core; the deletion records its review", async () => {
	const f = await fixture({ folders: ["agents/nora/skills"] });
	const path = "agents/nora/skills/call-the-bank/SKILL.md";
	const created = parse(
		await f.call("update_skill", {
			action: "create",
			scope: "agent",
			name: "call-the-bank",
			description: "How to call the bank",
			body: "Ask for the loan desk.",
		}),
	);
	expect(created).toMatchObject({ state: "created", path });
	const read = await f.call("read_skill", { scope: "agent", name: "call-the-bank" });
	expect(parse(read)).toMatchObject({ name: "call-the-bank" });
	expect(f.releases.at(-1)?.p_output_sha256).toBe(sha(String(read.value)));
	const deleted = parse(
		await f.call("update_skill", {
			action: "delete",
			scope: "agent",
			name: "call-the-bank",
			version: f.files.get(path)?.version as string,
		}),
	);
	expect(deleted).toMatchObject({ state: "deleted", path });
	expect(f.files.has(path)).toBe(false);
	// The automatic review's approval of the call is recorded for exactly this deletion, and the commit names it.
	expect(f.recordings).toHaveLength(1);
	expect(f.recordings[0]?.p_request).toMatchObject({ actionReviewId: f.context.actionReviewId, tool: "update_skill" });
	expect(f.commits.at(-1)).toMatchObject({ reviewId: expect.any(String), units: [{ op: "delete", path }] });
});

it("refuses an update_skill deletion outside the agent's own skills before anything is written", async () => {
	const f = await fixture({
		files: { "skills/invoices/SKILL.md": "---\nname: invoices\ndescription: How to send an invoice\n---\nSteps.\n" },
		folders: ["skills"],
	});
	const commits = f.commits.length;
	const deleted = parse(
		await f.call("update_skill", {
			action: "delete",
			scope: "company",
			name: "invoices",
			version: f.files.get("skills/invoices/SKILL.md")?.version as string,
		}),
	);
	expect(deleted).toMatchObject({ state: "denied", saved: false });
	expect(f.commits).toHaveLength(commits);
	expect(f.recordings).toHaveLength(0);
	expect(f.files.has("skills/invoices/SKILL.md")).toBe(true);
});

it("creates a skill again after deleting it in the same run, rather than replaying the first creation", async () => {
	const f = await fixture({ folders: ["agents/nora/skills"] });
	const path = "agents/nora/skills/call-the-bank/SKILL.md";
	const create = {
		action: "create",
		scope: "agent",
		name: "call-the-bank",
		description: "How to call the bank",
		body: "Ask for the loan desk.",
	};
	expect(parse(await f.call("update_skill", create))).toMatchObject({ state: "created" });
	await f.call("update_skill", {
		action: "delete",
		scope: "agent",
		name: "call-the-bank",
		version: f.files.get(path)?.version as string,
	});
	expect(f.files.has(path)).toBe(false);
	const commits = f.commits.length;
	// The same text at the same absent path, in a new call: its own receipt and commit, and the file is back.
	expect(parse(await f.call("update_skill", create))).toMatchObject({ state: "created" });
	expect(f.commits.length).toBeGreaterThan(commits);
	expect(f.files.has(path)).toBe(true);
});

it("reads a notebook file that starts with a byte order mark as the legacy reader did", async () => {
	const f = await fixture({ files: { "agents/nora/memory/profile.md": "﻿- (2026-09-01) I am Nora\n" } });
	const memory = await composeCloudAgentMemory(
		f.notebooks.composition,
		"agents/nora",
		NOW,
		new AbortController().signal,
	);
	expect(memory.profile.facts).toEqual([{ date: "2026-09-01", tier: "profile", fact: "I am Nora" }]);
});

it("refuses a skill deletion with no approval before taking a receipt", async () => {
	const f = await fixture({ folders: ["agents/nora/skills"] });
	const path = "agents/nora/skills/call-the-bank/SKILL.md";
	await f.call("update_skill", {
		action: "create",
		scope: "agent",
		name: "call-the-bank",
		description: "How to call the bank",
		body: "Ask for the loan desk.",
	});
	const begun = f.operationControl.beginToolOperation.mock.calls.length;
	const tool = f.tools.find((candidate) => candidate.name === "update_skill") as CloudNativeTool;
	const { actionReviewId: _approval, ...context } = f.context;
	const deleted = parse(
		await tool.execute(
			tool.parseArguments({
				action: "delete",
				scope: "agent",
				name: "call-the-bank",
				version: f.files.get(path)?.version as string,
			}),
			{ ...context, callId: randomUUID() },
		),
	);
	expect(deleted).toMatchObject({ state: "denied", saved: false });
	expect(f.operationControl.beginToolOperation.mock.calls.length).toBe(begun);
	expect(f.files.has(path)).toBe(true);
});

it("says nothing was saved, rather than an unknown outcome, when the notebook file keeps changing", async () => {
	const f = await fixture({ files: { [LOG]: "- (2026-10-01) First\n" }, folders: ["agents/nora/memory"] });
	const original = CloudCompanyFolderClient.prototype.commit;
	let writers = 0;
	vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementation(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		// Another writer saves the month between each read of this write and its commit.
		if (args[1].some((unit) => unit.op === "write" && unit.path === LOG))
			f.seed(LOG, `${f.text(LOG)}- (2026-10-02) Other run ${++writers}\n`);
		return original.apply(this, args);
	});
	const answer = parse(await f.call("update_memory", { action: "write", fact: "Mine" }));
	expect(answer).toMatchObject({ state: "conflict", saved: false });
	expect(answer.hint).toMatch(/try again/i);
	expect(writers).toBe(3);
	expect(f.commits).toHaveLength(3);
	expect(f.text(LOG)).not.toContain("Mine");
});

it("treats a notebook month that is not text as a named gap, and refuses only a write into it", async () => {
	const months = "agents/nora/memory/log";
	const f = await fixture({
		files: {
			[`${months}/2026-07.md`]: "- (2026-07-01) Bills go out monthly\n",
			// An import or a member left months that are not notebook text: too large, and not UTF-8.
			[`${months}/2026-06.md`]: "a".repeat(40 * 1024),
			[`${months}/2026-05.md`]: "abc",
		},
		folders: ["agents/nora/memory"],
	});
	const range = CloudCompanyFolderClient.prototype.readRange;
	vi.spyOn(CloudCompanyFolderClient.prototype, "readRange").mockImplementation(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		return args[0].path === `${months}/2026-05.md` ? Uint8Array.from([0xff, 0xfe, 0x00]) : range.apply(this, args);
	});
	expect(parse(await f.call("update_memory", { action: "write", fact: "Fresh fact" }))).toMatchObject({
		state: "written",
		path: LOG,
	});
	const unreadable = [`${months}/2026-06.md`, `${months}/2026-05.md`];
	const recalled = parse(await f.call("recall_memory", { query: "Bills monthly" }));
	expect(recalled.facts).toEqual([{ date: "2026-07-01", tier: "log", fact: "Bills go out monthly" }]);
	expect(recalled.searched).toEqual({ logMonths: 4, oldestMonth: "2026-05", unreadable });
	// Forget removes what it can reach and never claims every copy is gone.
	expect(parse(await f.call("update_memory", { action: "forget", fact: "Bills go out monthly" }))).toMatchObject({
		state: "partial",
		removed: 1,
		searched: { unreadable },
	});
	expect(f.text(`${months}/2026-07.md`)).toBe("");
	// Only a write into the unreadable file itself is refused, and it says so.
	f.seed(LOG, "b".repeat(40 * 1024));
	expect(parse(await f.call("update_memory", { action: "write", fact: "Another fact" }))).toMatchObject({
		state: "unreadable",
		saved: false,
		path: LOG,
	});
});

it("does not append a fact to a month another run created with it after the listing", async () => {
	const f = await fixture({ folders: ["agents/nora/memory", "agents/nora/memory/log"] });
	const read = CloudCompanyFolderClient.prototype.read;
	let raced = false;
	vi.spyOn(CloudCompanyFolderClient.prototype, "read").mockImplementation(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		// Another run saves the same fact into this month just before this write reads it.
		if (args[0] === LOG && !raced) {
			raced = true;
			f.seed(LOG, "- (2026-10-03) Mine\n");
		}
		return read.apply(this, args);
	});
	expect(parse(await f.call("update_memory", { action: "write", fact: "Mine" }))).toMatchObject({
		state: "duplicate",
		path: LOG,
	});
	expect(raced).toBe(true);
	expect(f.text(LOG)).toBe("- (2026-10-03) Mine\n");
	expect(f.commits).toHaveLength(0);
});

it("composes around a recent month that is not notebook text and names it, but not around an unreadable profile", async () => {
	const profile = "agents/nora/memory/profile.md";
	const f = await fixture({
		files: {
			[LOG]: "- (2026-10-02) Current fact\n",
			"agents/nora/memory/log/2026-09.md": "a".repeat(40 * 1024),
			[profile]: "- (2026-01-01) I keep the books\n",
		},
	});
	const signal = new AbortController().signal;
	expect(await composeCloudAgentMemory(f.notebooks.composition, "agents/nora", NOW, signal)).toMatchObject({
		available: true,
		profile: { facts: [{ fact: "I keep the books" }] },
		recentLog: { facts: [{ fact: "Current fact" }], unreadable: ["agents/nora/memory/log/2026-09.md"] },
	});
	// An unreadable profile cannot be composed whole, so the block degrades with a named reason.
	f.seed(profile, "b".repeat(40 * 1024));
	await expect(composeCloudAgentMemory(f.notebooks.composition, "agents/nora", NOW, signal)).rejects.toMatchObject({
		category: "invalid_response",
	});
});

it("never answers not found or an empty recall when the notebook could not be listed", async () => {
	const kept = "agents/nora/memory/log/2026-08.md";
	const f = await fixture({ files: { [kept]: "- (2026-08-01) Kept fact\n" }, folders: ["agents/nora/memory"] });
	vi.spyOn(CloudCompanyFolderClient.prototype, "listAll").mockRejectedValue(new Error("PRIVATE_OUTAGE"));
	const calls: [string, JsonValue][] = [
		["recall_memory", { query: "Kept fact" }],
		["update_memory", { action: "forget", fact: "Kept fact" }],
		["update_memory", { action: "write", fact: "Kept fact" }],
	];
	for (const [tool, value] of calls) await expect(f.call(tool, value)).rejects.toThrow("PRIVATE_OUTAGE");
	expect(f.text(kept)).toBe("- (2026-08-01) Kept fact\n");
	expect(f.commits).toHaveLength(0);
});

it("searches and forgets across every month, past one listing page", async () => {
	const log = "agents/nora/memory/log";
	const files: Record<string, string> = {};
	// 205 monthly files: more than the two-year horizon and more than one 200-entry listing page.
	for (let index = 0; index < 205; index++) {
		const month = new Date(Date.UTC(2009, index, 1)).toISOString().slice(0, 7);
		const fact = index === 0 ? "Ancient archive needle." : `Routine note ${index}.`;
		files[`${log}/${month}.md`] = `- (${month}-01) ${fact}\n`;
	}
	// The same fact again this month, written before notebook-wide dedupe existed.
	files[LOG] = "- (2026-10-02) ancient archive  needle.\n";
	const f = await fixture({ files, folders: ["agents/nora/memory"] });
	const pages = vi.spyOn(CloudCompanyFolderClient.prototype, "list");
	const recalled = parse(await f.call("recall_memory", { query: "Ancient archive needle" }));
	expect(pages.mock.calls.filter(([parent]) => parent === log).length).toBeGreaterThan(1);
	expect(recalled.facts).toEqual([
		{ date: "2026-10-02", tier: "log", fact: "ancient archive  needle." },
		{ date: "2009-01-01", tier: "log", fact: "Ancient archive needle." },
	]);
	expect(recalled.searched).toEqual({ logMonths: 206, oldestMonth: "2009-01" });
	const forgotten = parse(await f.call("update_memory", { action: "forget", fact: "Ancient archive needle." }));
	expect(forgotten).toMatchObject({ state: "forgotten", removed: 2 });
	expect(forgotten.changes.map((change: { path: string }) => change.path)).toEqual([LOG, `${log}/2009-01.md`]);
	expect(f.text(`${log}/2009-01.md`)).toBe("");
	expect(parse(await f.call("recall_memory", { query: "Ancient archive needle" })).facts).toEqual([]);
	expect(parse(await f.call("update_memory", { action: "forget", fact: "Ancient archive needle." }))).toMatchObject({
		state: "not_found",
		searched: { logMonths: 206, oldestMonth: "2009-01" },
	});
});
