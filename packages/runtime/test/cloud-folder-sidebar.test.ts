import { randomUUID } from "node:crypto";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { CloudFolderSidebar, type CloudFolderSidebarRequest } from "@qorpera/runtime/cloud-folder-sidebar";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { type FolderWriterHookAnswer, folderWriterFixture, sha } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const NORA = "2d1c4a8e-5b6f-4c3d-9e2a-7f8b9c0d1e2f";
const OLE = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const PIA = "9c0d1e2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f";
const PATH = "agents/sections.md";
const SEEDED = `# Sections

Each line is an id. The words after it are only for reading.
Our own note: research sits first.

## Research
- ${NORA} Nora the researcher
- ${OLE}

## Sales
`;

async function fixture(
	text = SEEDED,
	options: { hook?: (path: string, text: string) => FolderWriterHookAnswer | null; peopleComplete?: boolean } = {},
) {
	const f = await folderWriterFixture({ files: { [PATH]: text } }, options.hook ? { hook: options.hook } : {});
	runs.push(f.run);
	const sidebar = (operations = f.operations()) =>
		new CloudFolderSidebar({
			folder: f.folder,
			operations,
			identity: f.identity,
			people: new Map([
				[NORA, "Nora"],
				[OLE, "Ole"],
				[PIA, "Pia"],
			]),
			peopleComplete: options.peopleComplete ?? true,
		});
	const raw = async (request: CloudFolderSidebarRequest, callId: string = randomUUID(), sidebarTool = sidebar()) =>
		String((await sidebarTool.run(request, { ...f.context, callId })).value);
	const call = async (request: CloudFolderSidebarRequest, sidebarTool = sidebar()) =>
		JSON.parse(await raw(request, randomUUID(), sidebarTool));
	return { ...f, sidebar, call, raw };
}

it("lists the sections as the file has them, the unlisted as Unassigned, and releases the read", async () => {
	const f = await fixture();
	const listed = await f.call({ action: "list" });
	expect(listed).toEqual({
		schema: "qorpera.agent-sidebar/v1",
		runId: f.identity.runId,
		action: "list",
		changed: false,
		sections: [
			{
				name: "Research",
				agents: [
					{ id: NORA, name: "Nora" },
					{ id: OLE, name: "Ole" },
				],
			},
			{ name: "Sales", agents: [] },
		],
		unassigned: [{ id: PIA, name: "Pia" }],
	});
	expect(f.commits).toHaveLength(0);
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_reads: [{ path: PATH }] });
});

it("moves an agent and keeps the company's notes and each line's words", async () => {
	const f = await fixture();
	const moved = await f.call({ action: "move_agent", agentId: OLE, section: "sales" });
	expect(moved).toMatchObject({
		changed: true,
		sections: [
			{ name: "Research", agents: [{ id: NORA }] },
			{ name: "Sales", agents: [{ id: OLE, name: "Ole" }] },
		],
	});
	expect(f.text(PATH)).toBe(`# Sections

Each line is an id. The words after it are only for reading.
Our own note: research sits first.

## Research
- ${NORA} Nora the researcher

## Sales
- ${OLE} Ole
`);
	expect(f.commits[0]).toMatchObject({ receiptId: expect.any(String) });
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "write", path: PATH, expectedVersion: expect.any(String) });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// The same move again saves nothing and says so.
	await expect(f.call({ action: "move_agent", agentId: OLE, section: "Sales" })).resolves.toMatchObject({
		changed: false,
		note: "Already so: nothing changed",
	});
	expect(f.commits).toHaveLength(1);
	// Out of every section: Unassigned.
	await expect(f.call({ action: "move_agent", agentId: OLE, section: null })).resolves.toMatchObject({
		changed: true,
		unassigned: [
			{ id: OLE, name: "Ole" },
			{ id: PIA, name: "Pia" },
		],
	});
});

it("creates, renames and deletes sections by name, idempotently", async () => {
	const f = await fixture();
	await expect(f.call({ action: "create_section", name: "Support" })).resolves.toMatchObject({ changed: true });
	await expect(f.call({ action: "create_section", name: "support" })).resolves.toMatchObject({ changed: false });
	await expect(
		f.call({ action: "rename_section", section: "SUPPORT", name: "Customer support" }),
	).resolves.toMatchObject({
		changed: true,
	});
	// A retried rename finds the new name.
	const commits = f.commits.length;
	await expect(
		f.call({ action: "rename_section", section: "Support", name: "Customer support" }),
	).resolves.toMatchObject({
		changed: false,
		note: "Already so: nothing changed",
	});
	expect(f.commits).toHaveLength(commits);
	await expect(f.call({ action: "rename_section", section: "Sales", name: "research" })).resolves.toMatchObject({
		changed: false,
		refused: "That name is taken by another section",
	});
	// Deleting a section keeps its agents: they become Unassigned.
	await expect(f.call({ action: "delete_section", section: "research" })).resolves.toMatchObject({
		changed: true,
		unassigned: [
			{ id: NORA, name: "Nora" },
			{ id: OLE, name: "Ole" },
			{ id: PIA, name: "Pia" },
		],
	});
	// A section already gone is already so, as today: a retried delete is no failure.
	const deleted = await f.call({ action: "delete_section", section: "Research" });
	expect(deleted).toMatchObject({ changed: false, note: "Already so: nothing changed" });
	expect(deleted).not.toHaveProperty("refused");
	expect(f.text(PATH)).toContain("## Customer support");
	expect(f.text(PATH)).not.toContain("## Research");
});

it("says refused when the folder core refuses or the file changed, and its receipt still completes", async () => {
	const f = await fixture();
	const original = CloudCompanyFolderClient.prototype.commit;
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	await expect(f.call({ action: "create_section", name: "Support" })).resolves.toMatchObject({
		changed: false,
		refused: "The sections changed since they were read; nothing changed: call again",
	});
	commit.mockRestore();
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// No sections file, or one that does not read as sections: correct it first.
	const empty = await folderWriterFixture();
	runs.push(empty.run);
	await expect(
		new CloudFolderSidebar({
			folder: empty.folder,
			operations: empty.operations(),
			identity: empty.identity,
			people: new Map(),
			peopleComplete: true,
		}).run({ action: "list" }, empty.context),
	).rejects.toThrow("no sections file");
	const broken = await fixture("# Sections\n\n## A\nnot an id\n");
	await expect(broken.call({ action: "list" })).rejects.toThrow("does not read as sections");
	// The tool's own refusals before any effect, which the boundary shows the model.
	await expect(broken.call({ action: "list" })).rejects.toBeInstanceOf(CloudToolRefusal);
});

it("refuses before reading when this run cannot complete a folder write", async () => {
	const f = await fixture();
	const { completeFolderToolOperation: _, ...legacy } = f.operationControl;
	await expect(
		f.call({ action: "create_section", name: "Support" }, f.sidebar(new CloudNativeToolOperations(f.run, legacy))),
	).rejects.toThrow("cannot complete folder writes");
	expect(f.commits).toHaveLength(0);
});

it("shows the sections as read when a save is refused or conflicts, and the Co-Founder rule as today", async () => {
	const f = await fixture(SEEDED, {
		hook: (_path, text) =>
			text.includes(PIA)
				? {
						outcome: "refused",
						reason: "structured_invalid",
						problems: [{ code: "cofounder", message: `the Co-Founder stands above the sections; remove ${PIA}` }],
					}
				: text.includes("## Blocked")
					? {
							outcome: "refused",
							reason: "structured_invalid",
							problems: [{ code: "x", message: "a rule says no" }],
						}
					: null,
	});
	const asRead = [
		{ name: "Research", agents: [{ id: NORA }, { id: OLE }] },
		{ name: "Sales", agents: [] },
	];
	const cofounder = await f.call({ action: "move_agent", agentId: PIA, section: "Research" });
	expect(cofounder).toMatchObject({
		changed: false,
		refused: "The Co-Founder stays on top, above the sections",
		sections: asRead,
		unassigned: [{ id: PIA }],
	});
	await expect(f.call({ action: "create_section", name: "Blocked" })).resolves.toMatchObject({
		changed: false,
		refused: "a rule says no",
		sections: asRead,
	});
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const original = CloudCompanyFolderClient.prototype.commit;
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	const callId = randomUUID();
	const conflict = JSON.parse(await f.raw({ action: "move_agent", agentId: OLE, section: "Sales" }, callId));
	commit.mockRestore();
	expect(conflict).toMatchObject({
		changed: false,
		refused: expect.stringContaining("changed since"),
		sections: asRead,
	});
	// The same call again (after a restart) answers from its receipt: no second commit.
	const commits = f.commits.length;
	expect(JSON.parse(await f.raw({ action: "move_agent", agentId: OLE, section: "Sales" }, callId))).toEqual(conflict);
	expect(f.commits).toHaveLength(commits);
	expect(f.text(PATH)).toBe(SEEDED);
});

it("says already so for a change already in the sections, however the file is laid out", async () => {
	for (const text of [
		SEEDED.replaceAll("\n", "\r\n"),
		SEEDED.trimEnd(),
		SEEDED.replace(`- ${NORA}`, `* ${NORA}`).replace(`- ${OLE}`, `  - ${OLE}`),
		SEEDED.replace("## Research", "## Research ##").replace("## Sales", "## Sales   "),
		SEEDED.replace(`- ${NORA} Nora the researcher\n`, `- ${NORA}\tNora the researcher\n\n`),
	]) {
		const f = await fixture(text);
		for (const request of [
			{ action: "create_section", name: "research" },
			{ action: "move_agent", agentId: NORA, section: "Research" },
			{ action: "move_agent", agentId: PIA, section: null },
			{ action: "delete_section", section: "Support" },
			{ action: "rename_section", section: "Support", name: "Sales" },
		] as const)
			await expect(f.call(request), JSON.stringify([text, request])).resolves.toMatchObject({
				changed: false,
				note: "Already so: nothing changed",
			});
		expect(f.commits).toHaveLength(0);
		expect(f.text(PATH)).toBe(text);
	}
});

it("keeps each line's words, indented or not, and writes names the heading rule can carry", async () => {
	const f = await fixture(SEEDED.replace(`- ${NORA} Nora the researcher`, `  - ${NORA} Nora the researcher`));
	// A moved agent keeps its line's words.
	await f.call({ action: "move_agent", agentId: NORA, section: "Sales" });
	expect(f.text(PATH)).toContain(`## Sales\n- ${NORA} Nora the researcher\n`);
	// A name ending in "#" takes the parser's closing " #", and reads back whole.
	await expect(f.call({ action: "create_section", name: "Team #" })).resolves.toMatchObject({
		changed: true,
		sections: [{ name: "Research" }, { name: "Sales" }, { name: "Team #" }],
	});
	expect(f.text(PATH)).toContain("\n## Team # #\n");
	await f.call({ action: "move_agent", agentId: OLE, section: "Team #" });
	await expect(f.call({ action: "list" })).resolves.toMatchObject({
		sections: [{ name: "Research" }, { name: "Sales" }, { name: "Team #", agents: [{ id: OLE }] }],
	});
});

it("releases what it shows: the save under its receipt, anything else under the call", async () => {
	const f = await fixture(SEEDED, { peopleComplete: false });
	const saved = await f.raw({ action: "create_section", name: "Support" });
	const receiptId = JSON.parse(saved).receiptId ?? f.commits[0]?.receiptId;
	expect(f.releases.at(-1)).toMatchObject({
		p_release_id: receiptId,
		p_reads: [{ path: PATH }],
		p_output_sha256: sha(saved),
	});
	expect(JSON.parse(saved)).toMatchObject({ unassignedTruncated: true });
	const callId = randomUUID();
	const listed = await f.raw({ action: "list" }, callId);
	const id = (f.releases.at(-1) as { p_release_id: string }).p_release_id;
	expect(f.releases.at(-1)).toMatchObject({ p_output_sha256: sha(listed) });
	await f.raw({ action: "list" }, callId);
	expect((f.releases.at(-1) as { p_release_id: string }).p_release_id).toBe(id);
	expect(f.releases).toHaveLength(3);
});
