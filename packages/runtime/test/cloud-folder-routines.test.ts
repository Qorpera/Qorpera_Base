import { createHash } from "node:crypto";
import { parseCompanyStateFile, type RoutineFile, writeRoutineFile } from "@qorpera/cloud-client/company-state-files";
import { CloudFolderRoutines, type CloudFolderRoutineUpsert } from "@qorpera/runtime/cloud-folder-routines";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	CloudToolArgumentRefusal,
	type CloudToolContext,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { CLOUD_ROUTINE_TOOL_DESCRIPTION, cloudRoutineTools } from "@qorpera/runtime/cloud-routine-tools";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.useRealTimers();
});

const ROUTINES = "QorperaOS/agents/nora/routines";
const OWN = "0c1d2e3f-5555-4555-8555-555555555555";

async function fixture(...args: Parameters<typeof folderWriterFixture>) {
	const f = await folderWriterFixture(...args);
	runs.push(f.run);
	const routines = (ownRoutineId?: string) =>
		new CloudFolderRoutines({
			folder: f.folder,
			operations: new CloudNativeToolOperations(f.run, f.operationControl),
			identity: f.identity,
			handle: "nora",
			...(ownRoutineId ? { ownRoutineId } : {}),
		});
	// Each call has its own approval: one approval stands for one change set.
	let calls = 0;
	const call = (): CloudToolContext => {
		calls += 1;
		const n = String(calls).padStart(12, "0");
		return { ...f.context, callId: `call-${calls}`, actionReviewId: `5b0c2d3e-3333-4333-8333-${n}` };
	};
	const routine = (key: string) => {
		const parsed = parseCompanyStateFile(`${ROUTINES}/${key}.md`, f.text(`${ROUTINES}/${key}.md`) ?? "");
		return parsed?.ok && parsed.file.kind === "routine" ? parsed.file : null;
	};
	return { ...f, routines, call, routine };
}

const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
const hashedId = (namespace: string, runId: string, key: string) => {
	const hex = createHash("sha256").update(`${namespace}:${runId}:${key}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}

const UPSERT: CloudFolderRoutineUpsert = {
	action: "upsert",
	operationKey: "inbox-1",
	routineKey: "inbox",
	title: "Inbox",
	intent: "Look at the inbox and tell the member about anything urgent.",
	trigger: { kind: "schedule", intervalMinutes: 60, replyPolicy: "optional" },
};
const FILE: RoutineFile = {
	kind: "routine",
	id: "0d1e2f3a-6666-4666-8666-666666666666",
	title: "Inbox",
	status: "active",
	trigger: { when: "every", minutes: 60, starts: null },
	timezone: null,
	ends: null,
	runs: null,
	quiet: null,
	effort: "high",
	reply: "optional",
	conclusion: null,
	instructions: "Look at the inbox and tell the member about anything urgent.",
};
const file = (changes: Partial<RoutineFile> = {}) => {
	const { kind: _kind, ...rest } = { ...FILE, ...changes };
	return writeRoutineFile(rest);
};
const seeded = (changes: Partial<RoutineFile> = {}) => ({ files: { [`${ROUTINES}/inbox.md`]: file(changes) } });

it("saves a new routine as its file, making the routines folder, with the review recorded for the change set", async () => {
	const f = await fixture();
	const execute = vi.spyOn(CloudNativeToolOperations.prototype, "execute");
	const context = f.call();
	const result = parse((await f.routines().change(UPSERT, context)).content);
	const id = hashedId("qorpera.folder-routine/v1", f.identity.runId, "inbox-1");
	expect(f.routine("inbox")).toEqual({ ...FILE, id, effort: "medium" });
	expect(result).toMatchObject({
		schema: "qorpera.agent-routine-receipt/v2",
		runId: f.identity.runId,
		action: "upsert",
		outcome: "saved",
		routine: {
			routineKey: "inbox",
			path: `${ROUTINES}/inbox.md`,
			status: "active",
			nextRunAt: "2026-10-02T09:00:00Z",
		},
		next: "Saved: tell the member what you set up or changed.",
	});
	// The file as it reads, without its kind and id.
	const { kind: _kind, id: _id, ...shown } = { ...FILE, effort: "medium" };
	expect(result.routine.file).toEqual(shown);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "routine-file:inbox-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["mkdir", ROUTINES],
		["write", `${ROUTINES}/inbox.md`],
	]);
	expect(f.recordings[0]?.p_request).toEqual({
		actionReviewId: context.actionReviewId,
		tool: "manage_routine",
		argumentSha256: context.argumentSha256,
		units: commit?.units,
	});
	// The receipt binds the request as parsed, never the defaults filled in.
	expect(execute.mock.calls[0]?.[0].operation).toEqual({
		tool: "manage_routine",
		toolVersion: "folder-v2/1",
		logicalOperationKey: "routine:inbox-1",
		arguments: { ...UPSERT },
		target: { path: `${ROUTINES}/inbox.md` },
		requiresCompanyRevision: true,
	});
	execute.mockRestore();
	// The login was pinned before the save.
	expect(f.logins).toEqual([{ p_binding: expect.objectContaining({ runId: f.identity.runId }) }]);
	// The receipt stores the save; how the routine runs now is read back after it, outside the stored result.
	const stored = ([...f.ledger.values()][0]?.result as { content?: { value: string } } | undefined)?.content;
	expect(JSON.parse(stored?.value ?? "{}")).toMatchObject({
		outcome: "saved",
		routine: { routineKey: "inbox", path: `${ROUTINES}/inbox.md`, version: expect.any(String) },
		next: "Saved: tell the member what you set up or changed.",
	});
	expect(JSON.parse(stored?.value ?? "{}").routine).not.toHaveProperty("status");
});

it("writes each trigger, the end, the runs, quiet hours and effort as the file says them", async () => {
	vi.useFakeTimers({ now: Date.parse("2026-10-01T08:00:00Z"), toFake: ["Date"] });
	const f = await fixture({ folders: [ROUTINES] });
	const routines = f.routines();
	await routines.change(
		{
			...UPSERT,
			operationKey: "weekly-1",
			routineKey: "weekly",
			trigger: {
				kind: "schedule",
				intervalMinutes: 1440,
				startAt: "2026-10-05T07:00:00.000Z",
				weekdays: ["monday", "wednesday"],
				localTime: "09:00",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "required",
			},
			expiresAt: "2026-12-31T23:00:00.000Z",
			maxOccurrences: 20,
			effort: "low",
		},
		f.call(),
	);
	expect(f.routine("weekly")).toMatchObject({
		trigger: { when: "weekly", days: ["mon", "wed"], time: "09:00", starts: "2026-10-05T07:00:00Z" },
		timezone: "Europe/Copenhagen",
		ends: "2026-12-31T23:00:00Z",
		runs: 20,
		effort: "low",
		reply: "required",
	});
	// every has no time zone of its own: quiet hours carry theirs.
	await routines.change(
		{
			...UPSERT,
			operationKey: "quiet-1",
			routineKey: "quiet",
			quietHours: { start: "22:00", end: "07:00", timeZone: "Europe/Copenhagen" },
		},
		f.call(),
	);
	expect(f.routine("quiet")).toMatchObject({
		trigger: { when: "every", minutes: 60, starts: null },
		timezone: null,
		quiet: { start: "22:00", end: "07:00", timezone: "Europe/Copenhagen" },
	});
	// A dynamic routine runs at firstRunAt, else now; saved again, it keeps a next run still ahead.
	const dynamic = (operationKey: string, at?: string): CloudFolderRoutineUpsert => ({
		...UPSERT,
		operationKey,
		routineKey: "follow-up",
		trigger: { kind: "once", ...(at ? { at } : {}), timeZone: "Europe/Copenhagen", replyPolicy: "optional" },
	});
	await routines.change(dynamic("follow-1"), f.call());
	expect(f.routine("follow-up")?.trigger).toEqual({ when: "once", at: "2026-10-01T08:00:00Z" });
	await routines.change(dynamic("follow-2", "2026-10-03T10:00:00.000Z"), f.call());
	expect(f.routine("follow-up")?.trigger).toEqual({ when: "once", at: "2026-10-03T10:00:00Z" });
	await routines.change({ ...dynamic("follow-3"), title: "Follow up" }, f.call());
	expect(f.routine("follow-up")).toMatchObject({
		title: "Follow up",
		trigger: { when: "once", at: "2026-10-03T10:00:00Z" },
		timezone: "Europe/Copenhagen",
	});
	// A file change (P29): the path as given, with its match and time zone; the folder core folds the watch.
	await routines.change(
		{
			...UPSERT,
			operationKey: "watch-1",
			routineKey: "vision-check",
			trigger: {
				kind: "listener",
				source: "company-file",
				path: "QorperaOS/vision/Vision.md",
				match: "exact",
				timeZone: "Europe/Copenhagen",
				replyPolicy: "optional",
			},
			maxOccurrences: 50,
		},
		f.call(),
	);
	expect(f.routine("vision-check")).toMatchObject({
		trigger: { when: "file-change", watch: "QorperaOS/vision/Vision.md", match: "exact" },
		timezone: "Europe/Copenhagen",
		runs: 50,
		reply: "optional",
	});
	// An event (E2): the hook and the types it takes, with its time zone; without only, every type.
	const hookId = "0a1b2c3d-1111-4111-8111-111111111111";
	await routines.change(
		{
			...UPSERT,
			operationKey: "payments-1",
			routineKey: "payments",
			trigger: {
				kind: "listener",
				source: "event",
				hookId,
				only: ["invoice.paid", "charge.refunded"],
				timeZone: "Europe/Copenhagen",
				replyPolicy: "required",
			},
		},
		f.call(),
	);
	expect(f.routine("payments")).toMatchObject({
		trigger: { when: "event", hook: hookId, only: ["invoice.paid", "charge.refunded"] },
		timezone: "Europe/Copenhagen",
		reply: "required",
	});
	expect(f.text(`${ROUTINES}/payments.md`)).toContain(
		`when: event\nhook: ${hookId}\nonly: [invoice.paid, charge.refunded]\ntimezone: Europe/Copenhagen\n`,
	);
	await routines.change(
		{
			...UPSERT,
			operationKey: "forms-1",
			routineKey: "forms",
			trigger: { kind: "listener", source: "event", hookId, timeZone: "UTC", replyPolicy: "optional" },
		},
		f.call(),
	);
	expect(f.routine("forms")).toMatchObject({ trigger: { when: "event", hook: hookId, only: null }, timezone: "UTC" });
});

it("saves over an existing file with its id, its version and its effort, and answers an unchanged save", async () => {
	const f = await fixture(seeded({ status: "paused" }));
	const version = f.files.get(`${ROUTINES}/inbox.md`)?.version;
	const routines = f.routines();
	const saved = parse((await routines.change(UPSERT, f.call())).content);
	expect(saved.outcome).toBe("saved");
	// A save revives a paused routine; the file keeps its id and its effort.
	expect(f.routine("inbox")).toEqual(FILE);
	expect(f.commits[0]?.units).toEqual([expect.objectContaining({ op: "write", expectedVersion: version })]);
	// The same routine again changes nothing: no review, no login, no receipt.
	const begun = f.operationControl.beginToolOperation.mock.calls.length;
	const again = parse((await routines.change({ ...UPSERT, operationKey: "inbox-2" }, f.call())).content);
	expect(again).toMatchObject({
		outcome: "unchanged",
		next: "Nothing to change: the routine already reads like this.",
	});
	expect(f.commits).toHaveLength(1);
	expect(f.recordings).toHaveLength(1);
	expect(f.logins).toHaveLength(1);
	expect(f.operationControl.beginToolOperation.mock.calls.length).toBe(begun);
	// Over the platform's pause it points at resume, and over an ended routine at a later end.
	f.routineStates.set("inbox", { status: "paused", pauseReason: "member" });
	expect(parse((await routines.change({ ...UPSERT, operationKey: "inbox-3" }, f.call())).content).next).toBe(
		"Nothing to change: the routine already reads like this. To switch it back on, use resume.",
	);
	f.routineStates.set("inbox", { status: "expired", pauseReason: null });
	expect(parse((await routines.change({ ...UPSERT, operationKey: "inbox-4" }, f.call())).content).next).toContain(
		"it has ended",
	);
	expect(f.commits).toHaveLength(1);
});

it("pauses, resumes and concludes in the file, and answers what is already so", async () => {
	const f = await fixture(seeded());
	const routines = f.routines();
	const change = (action: "pause" | "resume", operationKey: string) =>
		routines.change({ action, operationKey, routineKey: "inbox" }, f.call()).then(({ content }) => parse(content));
	expect(await change("pause", "pause-1")).toMatchObject({
		outcome: "saved",
		routine: { status: "paused", pauseReason: "agent" },
		next: "Paused: it does not run until it is resumed.",
	});
	expect(f.routine("inbox")?.status).toBe("paused");
	expect((await change("pause", "pause-2")).next).toBe("Nothing to change: the routine is already paused.");
	expect(await change("resume", "resume-1")).toMatchObject({ outcome: "saved", next: "Switched back on." });
	expect(f.routine("inbox")).toEqual(FILE);
	expect((await change("resume", "resume-2")).next).toBe("Nothing to change: the routine is already on.");
	const concluded = await routines.change(
		{ action: "conclude", operationKey: "end-1", routineKey: "inbox", summary: "The inbox\nmoved to email." },
		f.call(),
	);
	expect(concluded.concluded).toBe(true);
	expect(f.routine("inbox")).toMatchObject({ status: "concluded", conclusion: "The inbox moved to email." });
	const again = await routines.change(
		{ action: "conclude", operationKey: "end-2", routineKey: "inbox", summary: "Done." },
		f.call(),
	);
	expect(again.concluded).toBe(true);
	expect(parse(again.content).next).toBe("Nothing to change: the routine is already concluded.");
	await refuses(change("pause", "pause-3"), "That routine is concluded: save it again (upsert) to restart it");
	await refuses(change("resume", "resume-3"), "That routine is concluded: save it again (upsert) to restart it");
	// pause and conclude start no work: only the resume pinned the login.
	expect(f.logins).toHaveLength(1);
	expect(f.commits).toHaveLength(3);
});

it("resumes the platform's pause by saving the file unchanged, and keeps it while no login pays", async () => {
	let login: Record<string, unknown> | undefined;
	const f = await fixture(seeded(), { login: () => login as Record<string, unknown> });
	const routines = f.routines();
	const resume = (operationKey: string) =>
		routines
			.change({ action: "resume", operationKey, routineKey: "inbox" }, f.call())
			.then(({ content }) => parse(content));
	f.routineStates.set("inbox", { status: "paused", pauseReason: "authorization_failed" });
	login = { schema: "qorpera.routine-login/v1", runId: f.identity.runId, login: null };
	expect((await resume("resume-1")).next).toContain("Nothing was changed: no model account");
	expect(f.commits).toEqual([]);
	login = undefined;
	const text = f.text(`${ROUTINES}/inbox.md`);
	expect(await resume("resume-2")).toMatchObject({ outcome: "saved", routine: { status: "active" } });
	// The same bytes, over the version read.
	expect(f.text(`${ROUTINES}/inbox.md`)).toBe(text);
	expect(f.routineStates.has("inbox")).toBe(false);
	// The wake's refusals of work, in the runtime's words.
	f.routineStates.set("inbox", { status: "paused", pauseReason: "member" });
	for (const [kind, words] of [
		["Wake requires an acknowledgement before work", "needs your first reply before any work"],
		["Wake public output is already final", "already sent its final reply"],
		["Company execution is paused", "The company's work is paused"],
	] as const) {
		const g = await fixture(seeded());
		g.routineStates.set("inbox", { status: "paused", pauseReason: "member" });
		vi.spyOn(g.folder, "prepareRoutineLogin").mockResolvedValueOnce({
			refused: kind.startsWith("Wake requires")
				? "acknowledgement"
				: kind.startsWith("Wake public")
					? "final"
					: "paused",
		});
		await refuses(
			g.routines().change({ action: "resume", operationKey: "r-1", routineKey: "inbox" }, g.call()),
			words,
		);
		expect(g.commits).toEqual([]);
	}
	// An ended routine is saved again with a later end, not resumed.
	f.routineStates.set("inbox", { status: "expired", pauseReason: null });
	await refuses(resume("resume-3"), "That routine has ended");
});

it("treats an archive's pause as the platform's: the read-back says why, and resume saves the file unchanged", async () => {
	// A save by a run that outlived its agent's archive is recorded paused, and the read-back says why.
	let states: Map<string, unknown> | undefined;
	const w = await fixture(
		{ folders: [ROUTINES] },
		{
			hook: (path) => {
				if (path.endsWith("/inbox.md")) states?.set("inbox", { status: "paused", pauseReason: "agent_archived" });
				return null;
			},
		},
	);
	states = w.routineStates;
	const saved = parse((await w.routines().change(UPSERT, w.call())).content);
	expect(saved).toMatchObject({ outcome: "saved", routine: { status: "paused", pauseReason: "agent_archived" } });
	expect(saved.next).toContain("paused when its agent was archived");
	// Once the agent is active again, resume is a paid save of the same bytes.
	const f = await fixture(seeded());
	const text = f.text(`${ROUTINES}/inbox.md`);
	f.routineStates.set("inbox", { status: "paused", pauseReason: "agent_archived" });
	expect(
		parse(
			(await f.routines().change({ action: "resume", operationKey: "resume-a", routineKey: "inbox" }, f.call()))
				.content,
		),
	).toMatchObject({ outcome: "saved", routine: { status: "active" } });
	expect(f.text(`${ROUTINES}/inbox.md`)).toBe(text);
	expect(f.routineStates.has("inbox")).toBe(false);
});

it("removes the file with the version read, as a reviewed deletion, and answers a removal already made", async () => {
	const f = await fixture(seeded());
	const version = f.files.get(`${ROUTINES}/inbox.md`)?.version;
	const routines = f.routines();
	const removed = parse(
		(await routines.change({ action: "remove", operationKey: "rm-1", routineKey: "inbox" }, f.call())).content,
	);
	expect(removed).toMatchObject({
		outcome: "saved",
		next: "The routine is removed, and its name is free again.",
	});
	// The deletion's version shows the model nothing.
	expect(removed.routine).toEqual({ routineKey: "inbox", path: `${ROUTINES}/inbox.md` });
	expect(f.commits[0]?.units).toEqual([{ op: "delete", path: `${ROUTINES}/inbox.md`, expectedVersion: version }]);
	expect(f.files.has(`${ROUTINES}/inbox.md`)).toBe(false);
	expect(f.recordings).toHaveLength(1);
	expect(f.logins).toEqual([]);
	expect(
		parse((await routines.change({ action: "remove", operationKey: "rm-2", routineKey: "inbox" }, f.call())).content)
			.next,
	).toBe("Nothing to change: there is no routine with that routineKey.");
	for (const action of ["pause", "resume"] as const)
		await refuses(
			routines.change({ action, operationKey: "x-1", routineKey: "inbox" }, f.call()),
			"You have no routine with that routineKey",
		);
	await refuses(
		routines.change({ action: "conclude", operationKey: "x-2", routineKey: "inbox", summary: "Done." }, f.call()),
		"You have no routine with that routineKey",
	);
	expect(f.commits).toHaveLength(1);
});

it("never pauses or removes the routine that woke the run, and refuses a file that does not read as a routine", async () => {
	const f = await fixture(seeded({ id: OWN }));
	const own = f.routines(OWN);
	await refuses(
		own.change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, f.call()),
		"Conclude it instead",
	);
	await refuses(
		own.change({ action: "remove", operationKey: "r-1", routineKey: "inbox" }, f.call()),
		"Conclude it instead",
	);
	expect(
		parse(
			(
				await own.change(
					{ action: "conclude", operationKey: "c-1", routineKey: "inbox", summary: "Done." },
					f.call(),
				)
			).content,
		).outcome,
	).toBe("saved");
	const g = await fixture({ files: { [`${ROUTINES}/inbox.md`]: "---\ntitle: Inbox\n---\n" } });
	await refuses(
		g.routines().change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, g.call()),
		"does not read as a routine",
	);
	expect(f.commits).toHaveLength(1);
	expect(g.commits).toEqual([]);
});

it("checks the key and the file before the review, and refuses a save without the review's approval", async () => {
	const f = await fixture(seeded());
	const routines = f.routines();
	const argumentRefusal = (thunk: () => void) => {
		let thrown: unknown = null;
		try {
			thunk();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CloudToolArgumentRefusal);
		return (thrown as Error).message;
	};
	expect(argumentRefusal(() => routines.check({ ...UPSERT, routineKey: "weekly.report" }))).toContain(
		"lowercase letters, digits and single hyphens",
	);
	expect(argumentRefusal(() => routines.check({ ...UPSERT, routineKey: "a".repeat(65) }))).toContain(
		"at most 64 characters",
	);
	expect(argumentRefusal(() => routines.check({ ...UPSERT, expiresAt: "2020-01-01T00:00:00.000Z" }))).toContain(
		"expiresAt has already passed",
	);
	expect(argumentRefusal(() => routines.check({ ...UPSERT, title: "In\tbox" }))).toMatch(
		/^This routine cannot be saved as the company's files: \S/,
	);
	expect(() => routines.check(UPSERT)).not.toThrow();
	expect(() => routines.check({ action: "pause", operationKey: "p-1", routineKey: "inbox" })).not.toThrow();
	// A conclusion is one line of text: a control character in it is refused before the review.
	expect(
		argumentRefusal(() =>
			routines.check({ action: "conclude", operationKey: "c-1", routineKey: "inbox", summary: "Done\u0007." }),
		),
	).toMatch(/^This routine cannot be saved as the company's files: \S/);
	expect(() =>
		routines.check({ action: "conclude", operationKey: "c-1", routineKey: "inbox", summary: "Done.\nReally." }),
	).not.toThrow();
	const { actionReviewId: _, ...unreviewed } = f.call();
	await refuses(
		routines.change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, unreviewed),
		"needs the automatic review's approval",
	);
	// Without the approval nothing more happens: no login is pinned, no review recorded.
	await refuses(
		routines.change({ ...UPSERT, title: "Inbox again" }, unreviewed),
		"needs the automatic review's approval",
	);
	expect(f.logins).toEqual([]);
	expect(f.recordings).toEqual([]);
	expect(f.commits).toEqual([]);
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
});

it("tells the model what a conflict, a refusal, a waiting change and a routine that waits for a login mean", async () => {
	const f = await fixture(seeded());
	const routines = f.routines();
	// A file that changed since it was read is a conflict.
	const read = await f.folder.readText(`${ROUTINES}/inbox.md`, 65536, f.context.signal);
	vi.spyOn(f.folder, "readText").mockResolvedValueOnce(
		read && { ...read, entry: { ...read.entry, version: "0e1f2a3b-7777-4777-8777-777777777777" } },
	);
	const conflict = parse(
		(await routines.change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, f.call())).content,
	);
	expect(conflict).toMatchObject({ outcome: "conflict", reason: "version_changed" });
	expect(conflict.next).toContain("call again with a new operationKey");
	const g = await fixture(seeded(), {
		hook: () => ({
			outcome: "refused",
			reason: "structured_rule",
			problems: [{ code: "rule", message: "no login" }],
		}),
	});
	const refused = parse(
		(await g.routines().change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, g.call())).content,
	);
	expect(refused).toMatchObject({ outcome: "refused", problems: [{ message: "no login" }] });
	expect(refused.next).toContain("Nothing was saved");
	const h = await fixture(seeded(), { hook: () => ({ outcome: "waiting_for_review", reason: "waiting_for_review" }) });
	expect(
		parse(
			(await h.routines().change({ action: "pause", operationKey: "p-1", routineKey: "inbox" }, h.call())).content,
		).next,
	).toContain("do not make it again");
	// Saved with no paying login: it waits for a model account, and the read-back says so.
	let states: Map<string, unknown> | undefined;
	let runId = "";
	const w = await fixture(
		{ folders: [ROUTINES] },
		{
			hook: (path) => {
				if (path.endsWith("/inbox.md"))
					states?.set("inbox", { status: "paused", pauseReason: "needs_model_account" });
				return null;
			},
			login: () => ({ schema: "qorpera.routine-login/v1", runId, login: null }),
		},
	);
	states = w.routineStates;
	runId = w.identity.runId;
	const waiting = parse((await w.routines().change(UPSERT, w.call())).content);
	expect(waiting).toMatchObject({
		outcome: "saved",
		routine: { status: "paused", pauseReason: "needs_model_account" },
	});
	expect(waiting.next).toContain("no model account of the member you work for allows unattended runs yet");
	// A read-back that fails never fails the saved change.
	const x = await fixture({ folders: [ROUTINES] });
	vi.spyOn(x.folder, "agentRoutines").mockRejectedValueOnce(new Error("index unavailable"));
	const unread = parse((await x.routines().change(UPSERT, x.call())).content);
	expect(unread).toMatchObject({ outcome: "saved", routine: { routineKey: "inbox", path: `${ROUTINES}/inbox.md` } });
	expect(unread.next).toBe("Saved. List it (manage_routine list with this routineKey) to see how it runs now.");
});

it("lists the routines from the index as many as fit, with a cursor, or one whole", async () => {
	const long = "Read the inbox. ".repeat(40).trim();
	const files: Record<string, string> = {};
	for (let i = 1; i <= 34; i++)
		files[`${ROUTINES}/r-${i}.md`] = file({
			id: `0f1a2b3c-8888-4888-8888-${String(i).padStart(12, "0")}`,
			title: `Routine ${i}`,
			instructions: i === 34 ? long : FILE.instructions,
		});
	const f = await fixture({ files });
	f.routineStates.set("r-33", { status: "paused", pauseReason: "member" });
	const routines = f.routines();
	const first = parse(await routines.list({}, f.context, () => true));
	expect(first).toMatchObject({ schema: "qorpera.agent-routines/v2", runId: f.identity.runId, moreRoutines: 2 });
	expect(first.routines).toHaveLength(32);
	expect(first.routines[0]).toEqual({
		routineKey: "r-34",
		path: `${ROUTINES}/r-34.md`,
		status: "active",
		nextRunAt: "2026-10-02T09:00:00Z",
		runsUsed: 2,
		file: expect.objectContaining({ title: "Routine 34", instructions: long.slice(0, 200), effort: "high" }),
		instructionsTruncated: true,
	});
	expect(first.routines[0].file).not.toHaveProperty("kind");
	expect(first.routines[0].file).not.toHaveProperty("id");
	expect(first.routines[1]).toMatchObject({ routineKey: "r-33", status: "paused", pauseReason: "member" });
	const second = parse(await routines.list({ cursor: first.nextCursor }, f.context, () => true));
	expect(second.routines.map((routine: { routineKey: string }) => routine.routineKey)).toEqual(["r-2", "r-1"]);
	expect(second).toMatchObject({ moreRoutines: 0, nextCursor: null });
	// As many as fit: grown from one, the rest counted, the cursor at the last shown.
	const fitted = parse(await routines.list({}, f.context, (text) => JSON.parse(text).routines.length <= 3));
	expect(fitted.routines).toHaveLength(3);
	expect(fitted).toMatchObject({ moreRoutines: 31, nextCursor: "0f1a2b3c-8888-4888-8888-000000000032" });
	const one = parse(await routines.list({ routineKey: "r-34" }, f.context, () => true));
	expect(one.routines).toHaveLength(1);
	expect(one.routines[0].file.instructions).toBe(long);
	expect(one.routines[0]).not.toHaveProperty("instructionsTruncated");
	expect(parse(await routines.list({ routineKey: "none" }, f.context, () => true)).routines).toEqual([]);
	// A page that cuts instructions says to read the file before restating them.
	expect(first.next).toContain("company_read");
	expect(one).not.toHaveProperty("next");
	// One routine too long for one tool result: its instructions are cut, at a character, to fit, and marked.
	const huge = "Ré ".repeat(7000).trim();
	const g = await fixture({ files: { [`${ROUTINES}/huge.md`]: file({ instructions: huge }) } });
	const cut = await g.routines().list({ routineKey: "huge" }, g.context, fitsOneResult);
	expect(fitsOneResult(String(cut.value))).toBe(true);
	const shownCut = parse(cut);
	expect(shownCut.routines[0]).toMatchObject({ routineKey: "huge", instructionsTruncated: true });
	expect(huge.startsWith(shownCut.routines[0].file.instructions)).toBe(true);
	expect(shownCut.routines[0].file.instructions.length).toBeGreaterThan(1000);
	// The longest that fits: one more character would not.
	expect(
		fitsOneResult(
			JSON.stringify({
				...shownCut,
				routines: [
					{
						...shownCut.routines[0],
						file: {
							...shownCut.routines[0].file,
							instructions: Array.from(huge)
								.slice(0, Array.from(shownCut.routines[0].file.instructions).length + 1)
								.join(""),
						},
					},
				],
			}),
		),
	).toBe(false);
	expect(shownCut.next).toContain("read the routine's file (company_read at its path)");
	// A list reads the index: nothing is released.
	expect(f.releases).toEqual([]);
});

it("is manage_routine: its description, its list arguments, the checks before review, the writer behind execute", async () => {
	const f = await fixture(seeded());
	let settled = 0;
	const tool = cloudRoutineTools(
		f.binding,
		f.identity,
		{ routineKey: "inbox", decisionOwed: () => false, settled: () => settled++ },
		f.routines(),
	)[0];
	expect(tool?.description).not.toBe(CLOUD_ROUTINE_TOOL_DESCRIPTION);
	expect(tool?.description).toContain("Each change passes a quick automatic review against your job");
	expect(tool?.description).toContain("routines/<routineKey>.md");
	expect(tool?.description).toContain("cursor: the nextCursor of an earlier page");
	expect(tool?.description).toContain("resume switches a routine back on");
	expect(tool?.description).toContain(
		"file_change (a Company File path you can read, match exact or subtree), or event (hookId, a hook or mailbox from list_hooks; optional only, the event types to take; IANA timeZone). ",
	);
	expect(tool?.description).toContain(
		"Both listen from their last save, which drops what was not delivered yet; report required needs your public thread or the run is skipped. ",
	);
	expect(tool?.description).toContain("each run gets up to 20 new events");
	expect(tool?.description).not.toMatch(/No member approval|not available/);
	// The tool boundary takes a description of at most 4096 bytes.
	expect(Buffer.byteLength(tool?.description ?? "")).toBeLessThanOrEqual(4096);
	expect(tool?.inputSchema).toHaveProperty("properties.cursor");
	// list: one routine, or a page from a cursor.
	expect(tool?.parseArguments({ action: "list", routineKey: "inbox" })).toEqual({
		action: "list",
		routineKey: "inbox",
	});
	expect(() =>
		tool?.parseArguments({ action: "list", routineKey: "inbox", cursor: "0f1a2b3c-8888-4888-8888-000000000001" }),
	).toThrow(CloudToolArgumentRefusal);
	expect(() => tool?.parseArguments({ action: "list", cursor: "next" })).toThrow(CloudToolArgumentRefusal);
	// The key is a file name, said in words; a file change and an event are taken (the hook's id in lowercase); the file is
	// checked.
	expect(() => tool?.parseArguments({ action: "pause", operationKey: "p-1", routineKey: "weekly.report" })).toThrow(
		/lowercase letters, digits and single hyphens/,
	);
	const upsert = {
		action: "upsert",
		operationKey: "inbox-1",
		routineKey: "inbox",
		title: "Inbox",
		intent: FILE.instructions,
		trigger: { kind: "every", minutes: 60 },
	};
	expect(
		tool?.parseArguments({ ...upsert, trigger: { kind: "file_change", path: "sales", timeZone: "UTC" } }),
	).toMatchObject({
		trigger: {
			kind: "listener",
			source: "company-file",
			path: "sales",
			match: "exact",
			timeZone: "UTC",
			replyPolicy: "optional",
		},
	});
	expect(() =>
		tool?.parseArguments({ ...upsert, trigger: { kind: "file_change", path: "sales/../hr", timeZone: "UTC" } }),
	).toThrow();
	expect(
		tool?.parseArguments({
			...upsert,
			trigger: {
				kind: "event",
				hookId: "0A1B2C3D-1111-4111-8111-111111111111",
				only: ["form.posted"],
				timeZone: "UTC",
				report: "required",
			},
		}),
	).toMatchObject({
		trigger: {
			kind: "listener",
			source: "event",
			hookId: "0a1b2c3d-1111-4111-8111-111111111111",
			only: ["form.posted"],
			timeZone: "UTC",
			replyPolicy: "required",
		},
	});
	expect(() =>
		tool?.parseArguments({ ...upsert, trigger: { kind: "event", hookId: "forms", timeZone: "UTC" } }),
	).toThrow();
	expect(() => tool?.parseArguments({ ...upsert, title: "In\tbox" })).toThrow(CloudToolArgumentRefusal);
	// The schema offers the file name rule, the clock triggers, a file change and an event.
	expect(tool?.inputSchema).toHaveProperty("properties.routineKey.pattern", "^[a-z0-9]+(?:-[a-z0-9]+)*$");
	const kinds = (schema: unknown) =>
		(
			schema as { properties: { trigger: { oneOf: { properties: { kind: { const: string } } }[] } } }
		).properties.trigger.oneOf.map((item) => item.properties.kind.const);
	expect(kinds(tool?.inputSchema)).toEqual(["dynamic", "when_done", "every", "weekly", "file_change", "event"]);
	const list = parse((await tool?.execute({ action: "list" }, f.context)) as { value: unknown });
	expect(list.routines.map((routine: { routineKey: string }) => routine.routineKey)).toEqual(["inbox"]);
	// The run's own dynamic routine, concluded here, owes no decision.
	const concluded = parse(
		(await tool?.execute(
			tool.parseArguments({ action: "conclude", operationKey: "end-1", routineKey: "inbox", summary: "Done." }),
			f.call(),
		)) as { value: unknown },
	);
	expect(concluded.outcome).toBe("saved");
	expect(settled).toBe(1);
	// The key is bound to that request: other arguments under it are refused before the review; the same request is not.
	expect(() => tool?.parseArguments({ action: "pause", operationKey: "end-1", routineKey: "other" })).toThrow(
		/operationKey is already used in this run for a different routine change/,
	);
	expect(() =>
		tool?.parseArguments({ action: "conclude", operationKey: "end-1", routineKey: "inbox", summary: "Done." }),
	).not.toThrow();
});
