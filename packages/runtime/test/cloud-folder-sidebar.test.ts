import { randomUUID } from "node:crypto";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import { CloudFolderSidebar, type CloudFolderSidebarRequest } from "@qorpera/runtime/cloud-folder-sidebar";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

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

async function fixture(text = SEEDED) {
	const f = await folderWriterFixture({ files: { [PATH]: text } });
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
			peopleComplete: true,
		});
	const call = async (request: CloudFolderSidebarRequest, sidebarTool = sidebar()) =>
		JSON.parse(String((await sidebarTool.run(request, { ...f.context, callId: randomUUID() })).value));
	return { ...f, sidebar, call };
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
	await expect(
		f.call({ action: "rename_section", section: "Support", name: "Customer support" }),
	).resolves.toMatchObject({
		changed: false,
	});
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
	await expect(f.call({ action: "delete_section", section: "Research" })).resolves.toMatchObject({
		changed: false,
		refused: "No such section",
	});
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
});

it("refuses before reading when this run cannot complete a folder write", async () => {
	const f = await fixture();
	const { completeFolderToolOperation: _, ...legacy } = f.operationControl;
	await expect(
		f.call({ action: "create_section", name: "Support" }, f.sidebar(new CloudNativeToolOperations(f.run, legacy))),
	).rejects.toThrow("cannot complete folder writes");
	expect(f.commits).toHaveLength(0);
});
