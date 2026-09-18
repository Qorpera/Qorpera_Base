import { parseCloudCompanyAgentDocument } from "@qorpera/cloud-client/cloud-company-agent";
import { describe, expect, it, vi } from "vitest";
import { createWebCompanyAgents } from "../src/cloud/company-agents.ts";
import type { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { staff } from "./fixtures.ts";

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
const draft = { displayName: "Ledger", role: "Keeps the books", charter: "", figure: "owl", color: "#123456" };

describe("web company agents", () => {
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
		expect(document.hireOverlay.charter).toContain("You are Ledger");
		expect(document.startupInstructions).toContain("Ledger");
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
		await agents.update(roster, { ...draft, displayName: "Ledger II", charter: "" }, new AbortController().signal);
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
});
