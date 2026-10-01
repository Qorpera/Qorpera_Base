import { randomUUID } from "node:crypto";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import {
	CloudFolderRoutineDecision,
	type CloudFolderRoutineDecisionRequest,
} from "@qorpera/runtime/cloud-folder-routine-decision";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});

const PATH = "agents/nora/routines/market-check.md";
const ROUTINE = `---
id: 4b8f2c1d-6e3a-4f5b-9c7d-8e9f0a1b2c3d
title: Check the market
status: active
when: once
at: 2026-10-02T09:00:00.000Z
timezone: Europe/Copenhagen
---
Look at the competitors' prices and report changes.
`;

async function fixture(text: string | null = ROUTINE) {
	const f = await folderWriterFixture(
		text === null ? {} : { files: { [PATH]: text }, folders: ["agents/nora/routines"] },
	);
	runs.push(f.run);
	const decision = (operations = f.operations()) =>
		new CloudFolderRoutineDecision({
			folder: f.folder,
			operations,
			identity: f.identity,
			handle: "nora",
			routineKey: "market-check",
		});
	const decide = async (request: CloudFolderRoutineDecisionRequest, writer = decision()) => {
		const { content, decided } = await writer.decide(request, f.context);
		return { result: JSON.parse(String(content.value)), decided };
	};
	return { ...f, decision, decide };
}

it("decides the next run as a new at, effort and reply, changing nothing else", async () => {
	const f = await fixture();
	const { result, decided } = await f.decide({
		action: "next",
		operationKey: "decide-1",
		at: "2026-10-03T07:30:00.000Z",
		effort: "high",
		report: "required",
	});
	expect(decided).toBe(true);
	expect(result).toMatchObject({
		schema: "qorpera.agent-routine-receipt/v1",
		runId: f.identity.runId,
		action: "upsert",
		routine: { routineKey: "market-check", path: PATH, status: "active", at: "2026-10-03T07:30:00.000Z" },
	});
	expect(f.text(PATH)).toBe(
		// The settings writer quotes a value with a colon; the parser reads both spellings.
		ROUTINE.replace("at: 2026-10-02T09:00:00.000Z", 'at: "2026-10-03T07:30:00.000Z"').replace(
			"timezone: Europe/Copenhagen\n",
			"timezone: Europe/Copenhagen\neffort: high\nreply: required\n",
		),
	);
	expect(f.commits[0]).toMatchObject({ key: "decide-file:decide-1", receiptId: result.receiptId });
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "write", path: PATH, expectedVersion: expect.any(String) });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("concludes the routine with its conclusion", async () => {
	const f = await fixture();
	const { result, decided } = await f.decide({
		action: "conclude",
		operationKey: "decide-1",
		summary: "Prices are stable; no need to keep checking.",
	});
	expect(decided).toBe(true);
	expect(result).toMatchObject({ action: "conclude", routine: { status: "concluded" } });
	expect(f.text(PATH)).toContain("status: concluded\n");
	expect(f.text(PATH)).toContain("conclusion: Prices are stable; no need to keep checking.\n");
});

it("writes a new title and instructions too, which the folder core takes only with a review", async () => {
	const f = await fixture();
	const commit = vi.spyOn(CloudCompanyFolderClient.prototype, "commit");
	commit.mockImplementationOnce(async (_key, units) => ({
		commitId: randomUUID(),
		seq: null,
		replay: false,
		units: [
			{
				unit: 1,
				op: "write",
				path: (units[0] as { path: string }).path,
				to: null,
				version: null,
				outcome: "denied",
				reason: "review_required",
				problems: [],
			},
		],
	}));
	const { result, decided } = await f.decide({
		action: "next",
		operationKey: "decide-1",
		at: "2026-10-03T07:30:00.000Z",
		title: "Check the market weekly",
		intent: "Compare this week's prices with last week's.",
	});
	expect(decided).toBe(false);
	expect(result).toMatchObject({ schema: "qorpera.agent-routine-decision/v1", state: "refused" });
	expect(result.reason).toContain("needs a member's review");
	// What it would have written: the title as a setting, the instructions as the body.
	const sent = commit.mock.calls[0]?.[1][0] as { content: { text: string } };
	expect(sent.content.text).toContain("title: Check the market weekly\n");
	expect(sent.content.text.endsWith("---\nCompare this week's prices with last week's.\n")).toBe(true);
	// Its receipt still completes, with the commit that carried it.
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("refuses a missing or unreadable routine file, and a run that cannot complete a folder write", async () => {
	const missing = await fixture(null);
	await expect(missing.decide({ action: "conclude", operationKey: "decide-1", summary: "Done." })).rejects.toThrow(
		"routine file is missing or does not read as a routine",
	);
	const broken = await fixture("---\nid: nope\n---\nx\n");
	await expect(broken.decide({ action: "conclude", operationKey: "decide-1", summary: "Done." })).rejects.toThrow(
		"does not read as a routine",
	);
	const f = await fixture();
	const { completeFolderToolOperation: _, ...legacy } = f.operationControl;
	await expect(
		f.decide(
			{ action: "conclude", operationKey: "decide-1", summary: "Done." },
			f.decision(new CloudNativeToolOperations(f.run, legacy)),
		),
	).rejects.toThrow("cannot complete folder writes");
	expect(f.commits).toHaveLength(0);
});
