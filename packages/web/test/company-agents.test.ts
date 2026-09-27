import {
	CloudCompanyAgentOperationRejectedError,
	parseCloudCompanyAgentDocument,
} from "@qorpera/cloud-client/cloud-company-agent";
import { describe, expect, it, vi } from "vitest";
import { createWebCompanyAgents, prepareWebCompanyAgentCreation } from "../src/cloud/company-agents.ts";
import type { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { id, staff, timestamp } from "./fixtures.ts";

function fake() {
	let file: { version: string; text: string } | undefined;
	const edits: Array<{ operation: string; path: string; expectedVersion: string | null; text?: string }> = [];
	const editor = {
		read: vi.fn(async (path: string) =>
			file
				? { path, version: file.version, kind: "file" as const, executable: false, text: file.text }
				: { path, version: null, kind: "absent" as const, executable: false, text: "" },
		),
		edit: vi.fn(async (input: (typeof edits)[number]) => {
			edits.push(input);
			return { commandId: "c", state: "review_required", plan: {}, planSha256: "" } as never;
		}),
		review: vi.fn(async () => {
			file = { version: "10000000-0000-4000-8000-0000000000aa", text: edits.at(-1)!.text! };
			return { commandId: "c", state: "applied", result: {}, plan: {}, planSha256: "" } as never;
		}),
	};
	const current = vi.fn();
	const files = {
		signal: new AbortController().signal,
		current,
		files: vi.fn(async () => editor),
	} as unknown as WebCompanyFiles;
	return {
		files,
		editor,
		edits,
		current,
	};
}
const draft = {
	id: id(93),
	createdAt: timestamp,
	displayName: "Ledger",
	role: "Keeps the books",
	charter: "",
	figure: "owl",
	color: "#123456",
};

describe("web company agents", () => {
	it("rejects oversized escaped JSON before retaining a creation attempt", () => {
		expect(() => prepareWebCompanyAgentCreation({ ...draft, charter: "\u0000".repeat(10_000) })).toThrow(
			"text file limit",
		);
	});
	it("creates an agent as a reviewed Company File document with a first turn", async () => {
		const f = fake();
		const id = await createWebCompanyAgents(f.files).create(draft, new AbortController().signal);
		expect(f.edits).toHaveLength(1);
		expect(f.edits[0]).toMatchObject({
			operation: "write",
			path: `organization/agents/${id}.json`,
			expectedVersion: null,
		});
		const document = parseCloudCompanyAgentDocument(JSON.parse(f.edits[0]!.text!));
		expect(document).toMatchObject({
			agentId: id,
			revision: 1,
			displayName: "Ledger",
			role: "Keeps the books",
			appearance: { color: "#123456", shape: "round", creature: "owl" },
			employmentStatus: "active",
			lifecycleState: "setup",
		});
		// The description is the agent's responsibilities: a placeholder, never the name (a rename would leave it stale).
		expect(document.hireOverlay.charter).toContain("No responsibilities have been written");
		expect(document.hireOverlay.charter).not.toContain("Ledger");
		expect(document.startupInstructions).not.toContain("Ledger");
		expect(f.editor.review).toHaveBeenCalledTimes(1);
	});
	it("saves edits as the next revision and keeps startup instructions, grants and the creation text", async () => {
		const f = fake();
		const agents = createWebCompanyAgents(f.files);
		const id = await agents.create({ ...draft, charter: "Own the ledger." }, new AbortController().signal);
		const created = parseCloudCompanyAgentDocument(JSON.parse(f.edits[0]!.text!));
		// The roster reports the same instant in the database's spelling.
		const roster = {
			...staff,
			id,
			createdAt: created.createdAt.replace("Z", "+00:00"),
			appearance: { color: "x", shape: "round" },
		};
		const revision = await agents.update(
			roster,
			{ ...draft, displayName: "Ledger II", charter: "" },
			new AbortController().signal,
		);
		expect(revision).toBe(2);
		const next = parseCloudCompanyAgentDocument(JSON.parse(f.edits[1]!.text!));
		expect(next).toMatchObject({
			revision: 2,
			displayName: "Ledger II",
			createdAt: created.createdAt,
			startupInstructions: created.startupInstructions,
		});
		expect(next.hireOverlay.charter).toBe(staff.charter);
		expect(f.edits[1]!.expectedVersion).toBe("10000000-0000-4000-8000-0000000000aa");
	});
	it("refuses when company access changed and writes nothing", async () => {
		const f = fake();
		f.current.mockImplementation(() => {
			throw new Error("Company access changed.");
		});
		await expect(createWebCompanyAgents(f.files).create(draft, new AbortController().signal)).rejects.toThrow(
			"Company access changed.",
		);
		expect(f.edits).toHaveLength(0);
	});
	it("reconciles a creation whose approval applied but whose reply was lost", async () => {
		const f = fake();
		const approve = f.editor.review.getMockImplementation()!;
		f.editor.review.mockImplementationOnce(async () => {
			await approve();
			throw new TypeError("Failed to fetch");
		});
		await expect(createWebCompanyAgents(f.files).create(draft, new AbortController().signal)).rejects.toThrow(
			"Failed to fetch",
		);
		// The application recreates its adapter between calls. Identity belongs to the draft.
		await expect(createWebCompanyAgents(f.files).create(draft, new AbortController().signal)).resolves.toBe(draft.id);
		expect(f.editor.edit).toHaveBeenCalledTimes(1);
		expect(f.editor.review).toHaveBeenCalledTimes(1);
	});
	it("retries an unconfirmed submission with identical bytes, path, and operation key", async () => {
		const f = fake();
		f.editor.edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		await expect(createWebCompanyAgents(f.files).create(draft, new AbortController().signal)).rejects.toThrow();
		await createWebCompanyAgents(f.files).create(draft, new AbortController().signal);
		expect(f.editor.edit.mock.calls[0]![0]).toEqual(f.editor.edit.mock.calls[1]![0]);
		expect(f.editor.edit.mock.calls[1]![0]).toMatchObject({
			operationKey: `staff-create:${draft.id}`,
			expectedVersion: null,
		});
	});
	it.each(["edit", "review"] as const)(
		"reports a confirmed rejection from %s distinctly from uncertainty",
		async (stage) => {
			const f = fake();
			f.editor[stage].mockResolvedValueOnce({ commandId: "c", state: "rejected", result: null } as never);
			await expect(
				createWebCompanyAgents(f.files).create(draft, new AbortController().signal),
			).rejects.toBeInstanceOf(CloudCompanyAgentOperationRejectedError);
			expect(f.editor.edit).toHaveBeenCalledTimes(1);
			expect(f.editor.review).toHaveBeenCalledTimes(stage === "review" ? 1 : 0);
		},
	);
	it("recognizes a later revision without overwriting it when creation is retried", async () => {
		const f = fake();
		const agents = createWebCompanyAgents(f.files);
		await agents.create(draft, new AbortController().signal);
		await agents.update(
			{ ...staff, id: draft.id, createdAt: draft.createdAt },
			{ ...draft, displayName: "Changed" },
			new AbortController().signal,
		);
		await expect(agents.create(draft, new AbortController().signal)).resolves.toBe(draft.id);
		expect(f.editor.edit).toHaveBeenCalledTimes(2);
		expect(f.editor.review).toHaveBeenCalledTimes(2);
	});
	it.each(["agentId", "createdAt"])("rejects a conflicting immutable %s without writing", async (field) => {
		const f = fake();
		const agents = createWebCompanyAgents(f.files);
		await agents.create(draft, new AbortController().signal);
		const document = parseCloudCompanyAgentDocument(JSON.parse(f.edits[0]!.text!));
		f.editor.read.mockResolvedValueOnce({
			path: `organization/agents/${draft.id}.json`,
			kind: "file",
			version: id(99),
			executable: false,
			text: JSON.stringify({
				...document,
				revision: 2,
				[field]: field === "agentId" ? id(99) : "2026-01-01T00:00:00Z",
			}),
		});
		await expect(agents.create(draft, new AbortController().signal)).rejects.toThrow("creation document changed");
		expect(f.editor.edit).toHaveBeenCalledTimes(1);
	});
});
