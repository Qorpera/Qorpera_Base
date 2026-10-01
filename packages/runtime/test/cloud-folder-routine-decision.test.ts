import { randomUUID } from "node:crypto";
import { writeRoutineFile } from "@qorpera/cloud-client/company-state-files";
import { CloudCompanyFolderClient } from "@qorpera/runtime/cloud-company-folder-client";
import {
	CloudFolderRoutineDecision,
	type CloudFolderRoutineDecisionRequest,
} from "@qorpera/runtime/cloud-folder-routine-decision";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { type FolderWriterHookAnswer, folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});

const PATH = "agents/nora/routines/market-check.md";
const BASE = {
	id: "4b8f2c1d-6e3a-4f5b-9c7d-8e9f0a1b2c3d",
	title: "Check the market",
	status: "active",
	trigger: { when: "once", at: "2026-10-02T09:00:00Z" },
	timezone: "Europe/Copenhagen",
	ends: null,
	runs: null,
	quiet: null,
	effort: "medium",
	reply: "optional",
	conclusion: null,
	instructions: "Look at the competitors' prices and report changes.",
} as const;
// As the seeded writer writes it.
const ROUTINE = writeRoutineFile(BASE);

async function fixture(
	text: string | null = ROUTINE,
	hook?: (path: string, text: string) => FolderWriterHookAnswer | null,
	files: Record<string, string> = text === null ? {} : { [PATH]: text },
) {
	const f = await folderWriterFixture({ files }, hook ? { hook } : {});
	runs.push(f.run);
	// The routines folder is listed only when the file at the woken key is not this routine.
	const listed = vi.spyOn(CloudCompanyFolderClient.prototype, "list");
	const decision = (operations = f.operations()) =>
		new CloudFolderRoutineDecision({
			folder: f.folder,
			operations,
			identity: f.identity,
			handle: "nora",
			routineKey: "market-check",
			routineId: BASE.id,
		});
	const decide = async (request: CloudFolderRoutineDecisionRequest, writer = decision()) => {
		const { content, decided } = await writer.decide(request, f.context);
		return { result: JSON.parse(String(content.value)), decided };
	};
	return { ...f, decision, decide, listed };
}

/** The tool's own refusal before any effect (no key bound), which the boundary shows the model. */
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}

/** A commit the core answers with one unit's outcome, as the real one does for a hook's decision. */
function answerOnce(outcome: string, reason: string) {
	return vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async (_key, units) => ({
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
				outcome: outcome as "denied",
				reason,
				problems: [],
			},
		],
	}));
}

it("decides the next run as a new at, effort and reply, changing nothing else", async () => {
	const f = await fixture();
	const { result, decided } = await f.decide({
		action: "next",
		operationKey: "decide-1",
		at: "2026-10-03T07:30:00.000Z",
		effort: "high",
		report: "required",
		// The same title and instructions as the file change nothing.
		title: "Check the market",
		intent: "Look at the competitors' prices and report changes.\n",
	});
	expect(decided).toBe(true);
	expect(result).toMatchObject({
		schema: "qorpera.agent-routine-receipt/v1",
		runId: f.identity.runId,
		action: "upsert",
		routine: { routineKey: "market-check", path: PATH, status: "active", at: "2026-10-03T07:30:00Z" },
	});
	// The instant in its canonical form, as the seeded writer writes it.
	expect(f.text(PATH)).toBe(
		writeRoutineFile({
			...BASE,
			trigger: { when: "once", at: "2026-10-03T07:30:00Z" },
			effort: "high",
			reply: "required",
		}),
	);
	expect(f.commits[0]).toMatchObject({ key: "decide-file:decide-1", receiptId: result.receiptId });
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "write", path: PATH, expectedVersion: expect.any(String) });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
});

it("concludes the routine with its conclusion on one line", async () => {
	const f = await fixture();
	const { result, decided } = await f.decide({
		action: "conclude",
		operationKey: "decide-1",
		summary: "Prices are stable.\nNo need\tto keep checking.",
	});
	expect(decided).toBe(true);
	expect(result).toMatchObject({
		action: "conclude",
		routine: { status: "concluded", conclusion: "Prices are stable. No need to keep checking." },
	});
	expect(f.text(PATH)).toBe(
		writeRoutineFile({ ...BASE, status: "concluded", conclusion: "Prices are stable. No need to keep checking." }),
	);
});

it("rewrites the title and instructions with the decision, on the review's approval recorded for the change set", async () => {
	const f = await fixture(writeRoutineFile({ ...BASE, ends: "2030-01-01T00:00:00Z" }));
	const { result, decided } = await f.decide({
		action: "next",
		operationKey: "decide-1",
		at: "2026-10-03T07:30:00.000Z",
		title: "Check the market weekly",
		intent: "Compare this week's prices with last week's.\n",
		effort: "low",
	});
	expect(decided).toBe(true);
	expect(result).toMatchObject({
		schema: "qorpera.agent-routine-receipt/v1",
		routine: {
			status: "active",
			at: "2026-10-03T07:30:00Z",
			title: "Check the market weekly",
			instructionsChanged: true,
		},
	});
	// Every other key of the file's parse is kept.
	expect(f.text(PATH)).toBe(
		writeRoutineFile({
			...BASE,
			ends: "2030-01-01T00:00:00Z",
			title: "Check the market weekly",
			instructions: "Compare this week's prices with last week's.",
			trigger: { when: "once", at: "2026-10-03T07:30:00Z" },
			effort: "low",
		}),
	);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: f.context.actionReviewId,
		tool: "decide_routine",
		argumentSha256: f.context.argumentSha256,
		units: f.commits[0]?.units,
	});
	expect(f.commits[0]).toMatchObject({ key: "decide-file:decide-1", receiptId: result.receiptId });
	// A plain decision records no review.
	const g = await fixture();
	await g.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z", title: BASE.title });
	expect(g.recordings).toEqual([]);
	expect(g.commits[0]?.reviewId).toBeUndefined();
});

it("does not take a rewrite the core refuses as the decision", async () => {
	const f = await fixture();
	vi.spyOn(CloudCompanyFolderClient.prototype, "commitStaged").mockImplementationOnce(async () => ({
		commitId: randomUUID(),
		seq: null,
		replay: false,
		units: [
			{
				unit: 1,
				op: "write",
				path: PATH,
				to: null,
				version: null,
				outcome: "denied",
				reason: "review_required",
				problems: [],
			},
		],
	}));
	await expect(
		f.decide({
			action: "next",
			operationKey: "decide-1",
			at: "2026-10-03T07:30:00Z",
			title: "Check the market weekly",
		}),
	).resolves.toMatchObject({
		decided: false,
		result: {
			state: "refused",
			reason: expect.stringContaining("decide again with a new operationKey, without intent or title"),
		},
	});
});

it("refuses before any receipt what can never be saved: a rewrite without approval, a conclusion's rewrite, a next run past the end", async () => {
	const f = await fixture(writeRoutineFile({ ...BASE, ends: "2030-01-05T00:00:00Z" }));
	const { actionReviewId: _, ...unreviewed } = f.context;
	for (const change of [{ title: "Check the market weekly" }, { intent: "Compare this week's prices." }])
		await refuses(
			f
				.decision()
				.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z", ...change }, unreviewed),
			"need the automatic review's approval of this call",
		);
	await refuses(
		f.decide({ action: "next", operationKey: "decide-1", at: "2030-01-05T00:00:00Z" }),
		"The routine ends at 2030-01-05T00:00:00Z. Choose an earlier time or conclude it.",
	);
	await refuses(
		f.decide({ action: "conclude", operationKey: "decide-1", summary: "Done.", title: "Other" }),
		"A conclusion keeps the routine's title and instructions",
	);
	// No key is bound: the same key decides once the request can be saved.
	expect(f.ledger.size).toBe(0);
	await expect(
		f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-04T07:30:00Z" }),
	).resolves.toMatchObject({ decided: true });
});

it("answers settled when the routine already moved on, as today", async () => {
	for (const text of [
		null,
		writeRoutineFile({ ...BASE, status: "paused" }),
		writeRoutineFile({ ...BASE, status: "concluded", conclusion: "A member ended it." }),
		writeRoutineFile({ ...BASE, trigger: { when: "every", minutes: 1440, starts: null } }),
		// Past its end: a rewrite would revive it.
		writeRoutineFile({
			...BASE,
			ends: "2026-09-30T00:00:00Z",
			trigger: { when: "once", at: "2026-09-29T09:00:00Z" },
		}),
	]) {
		const f = await fixture(text);
		const { result, decided } = await f.decide({
			action: "next",
			operationKey: "decide-1",
			at: "2026-10-03T07:30:00Z",
		});
		expect(decided, String(text)).toBe(true);
		expect(result).toMatchObject({
			schema: "qorpera.agent-routine-decision/v1",
			runId: f.identity.runId,
			state: "settled",
			routine: { routineKey: "market-check", status: text === null ? "retired" : expect.any(String) },
		});
		expect(f.commits).toHaveLength(0);
		expect(f.ledger.size).toBe(0);
	}
	// A plain decision the core calls delegation: a member changed the routine while this run worked, so nothing is owed.
	const f = await fixture();
	answerOnce("denied", "review_required");
	await expect(
		f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" }),
	).resolves.toMatchObject({ decided: true, result: { state: "settled" } });
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// It shows the routine as read: that read is released under the receipt.
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_reads: [{ path: PATH }] });
});

it("says refused with the reason and a new operationKey otherwise, and replays a finished call from its receipt", async () => {
	const f = await fixture(ROUTINE, (_path, text) =>
		text.includes("effort: low")
			? { outcome: "refused", reason: "structured_invalid", problems: [{ code: "x", message: "a rule says no" }] }
			: null,
	);
	await expect(
		f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z", effort: "low" }),
	).resolves.toMatchObject({
		decided: false,
		result: { state: "refused", reason: "a rule says no: decide again with a new operationKey" },
	});
	for (const [outcome, reason, says] of [
		["waiting_for_review", "review_required", "waits for a member's review"],
		["denied", "review_denied", "A member declined this change"],
		["denied", "denied", "may not change its routine's file"],
	] as const) {
		answerOnce(outcome, reason);
		const { result, decided } = await f.decide({
			action: "next",
			operationKey: `k-${reason}-${outcome}`,
			at: "2026-10-03T07:30:00Z",
		});
		expect(decided).toBe(false);
		expect(result.reason).toContain(says);
	}
	// A conflict: the file changed after it was read.
	const stored = f.files.get(PATH);
	if (!stored) throw new Error("Missing fixture file");
	const original = CloudCompanyFolderClient.prototype.commit;
	vi.spyOn(CloudCompanyFolderClient.prototype, "commit").mockImplementationOnce(async function (
		this: CloudCompanyFolderClient,
		...args
	) {
		stored.version = randomUUID();
		return original.apply(this, args);
	});
	const request = { action: "next", operationKey: "decide-2", at: "2026-10-03T07:30:00Z" } as const;
	const conflict = await f.decide(request);
	expect(conflict).toMatchObject({
		decided: false,
		result: {
			state: "refused",
			reason: "The routine's file changed since it was read: decide again with a new operationKey",
		},
	});
	// The same call again (after a restart) answers from its receipt, with no second commit.
	const commits = f.commits.length;
	await expect(f.decide(request)).resolves.toEqual(conflict);
	expect(f.commits).toHaveLength(commits);
	await expect(f.decide({ ...request, operationKey: "decide-3" })).resolves.toMatchObject({ decided: true });
});

it("refuses an unreadable routine file, and a run that cannot complete a folder write", async () => {
	const broken = await fixture("---\nid: nope\n---\nx\n");
	await refuses(
		broken.decide({ action: "conclude", operationKey: "decide-1", summary: "Done." }),
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

it("finds its routine after a member renamed the file mid-run, by the routine's id in its folder", async () => {
	const moved = "agents/nora/routines/market-watch.md";
	const f = await fixture(null, undefined, {
		"agents/nora/routines/a-broken-one.md": "---\nid: nope\n---\nx\n",
		"agents/nora/routines/another.md": writeRoutineFile({ ...BASE, id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" }),
		[moved]: ROUTINE,
	});
	const request = { action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" } as const;
	const { result, decided } = await f.decide(request);
	expect(decided).toBe(true);
	expect(result).toMatchObject({
		schema: "qorpera.agent-routine-receipt/v1",
		routine: { routineKey: "market-watch", path: moved, at: "2026-10-03T07:30:00Z" },
	});
	expect(f.commits[0]?.units[0]).toMatchObject({ path: moved });
	expect(f.text(moved)).toBe(writeRoutineFile({ ...BASE, trigger: { when: "once", at: "2026-10-03T07:30:00Z" } }));
	expect(f.listed).toHaveBeenCalled();
	// The receipt shows the name the file was found under: that read is released with it.
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_release_id: result.receiptId, p_reads: [{ path: moved }] });
	// Renamed again before the same call is retried: it is the same call, answered from its receipt.
	const stored = f.files.get(moved);
	if (!stored) throw new Error("Missing fixture file");
	f.files.set("agents/nora/routines/market-later.md", stored);
	f.files.delete(moved);
	const commits = f.commits.length;
	await expect(f.decide(request)).resolves.toEqual({ result, decided: true });
	expect(f.commits).toHaveLength(commits);
});

it("is settled when another routine took its file's name, and lists the folder only when the file is not its own", async () => {
	const other = writeRoutineFile({ ...BASE, id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", title: "Someone else's" });
	const f = await fixture(other);
	await expect(
		f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" }),
	).resolves.toMatchObject({ decided: true, result: { state: "settled", routine: { status: "retired" } } });
	expect(f.commits).toHaveLength(0);
	expect(f.listed).toHaveBeenCalled();
	// Its own file at its key: no listing.
	const h = await fixture();
	h.listed.mockClear();
	await h.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" });
	expect(h.listed).not.toHaveBeenCalled();
});

it("releases the read a settled answer shows", async () => {
	const f = await fixture(writeRoutineFile({ ...BASE, status: "paused" }));
	const { result } = await f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" });
	expect(result).toMatchObject({ state: "settled", routine: { status: "paused", path: PATH } });
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({ p_reads: [{ path: PATH }] });
});

it("pages through the routines folder until it finds the file", async () => {
	const moved = "agents/nora/routines/market-watch.md";
	const f = await fixture(null, undefined, { [moved]: ROUTINE });
	// A first page that holds no routine and names more to come.
	f.listed.mockResolvedValueOnce({ asOfSeq: 1, entries: [], next: "agents/nora/routines/a.md" });
	await expect(
		f.decide({ action: "next", operationKey: "decide-1", at: "2026-10-03T07:30:00Z" }),
	).resolves.toMatchObject({ decided: true, result: { routine: { path: moved } } });
	expect(f.listed).toHaveBeenCalledTimes(2);
	expect(f.listed.mock.calls[1]?.[1]).toEqual({ after: "agents/nora/routines/a.md" });
});
