import { createHash } from "node:crypto";
import {
	parseCompanyStateFile,
	workerStandingTexts,
	writeTodoFile,
	writeWorkerBriefFile,
	writeWorkerResultsFile,
} from "@qorpera/cloud-client/company-state-files";
import { type CloudFolderWorkerChange, CloudFolderWorkers } from "@qorpera/runtime/cloud-folder-workers";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudToolArgumentRefusal, CloudToolRefusal } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { cloudWorkerTools } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const TODO = "agents/nora/todos/market-scan.md";
const FOLDER = "agents/nora/todos/market-scan/prices";
const todoText = (status: "open" | "blocked" | "done" = "open") =>
	writeTodoFile({
		id: "4b0e9c1a-0000-4000-8000-0000000000d1",
		title: "Market scan",
		status,
		requestedBy: null,
		detail: "",
	});
const briefText = (followUps = 0) =>
	writeWorkerBriefFile({
		id: "4b0e9c1a-0000-4000-8000-0000000000b1",
		title: "Collect prices",
		species: "in-house",
		access: "read",
		revival: "batch",
		dispatchedAt: "2026-10-04T10:00:00.000Z",
		followUps,
		followedUpAt: followUps ? "2026-10-04T11:00:00.000Z" : null,
		goal: "Collect the list prices.",
		doneWhen: "One verified price per competitor.",
		context: null,
		sources: [],
		...workerStandingTexts({ species: "in-house", access: "read", revival: "batch" }),
		followUp: followUps ? "Add Delta." : null,
	});
const resultsText = (outcome: "succeeded" | "failed" = "succeeded") =>
	writeWorkerResultsFile({
		outcome,
		reportedAt: "2026-10-04T10:30:00.000Z",
		decision: null,
		note: null,
		summary: "Alfa 49, Beta 59, Gamma 45.",
		needs: null,
		files: [],
	});
const view = (state = "succeeded", workerKey = "prices", folder = FOLDER) => ({
	workerKey,
	title: workerKey === "prices" ? "Collect prices" : "Check stock",
	state,
	sequence: 1,
	access: "read",
	revival: "batch",
	outcome: state === "succeeded" ? "succeeded" : null,
	summary: state === "succeeded" ? "Alfa 49, Beta…" : null,
	needs: null,
	// The index keeps each output as {path} (a report's files).
	outputs: state === "succeeded" ? [{ path: `${folder}/prices.md` }] : [],
	reportedAt: state === "succeeded" ? "2026-10-04T10:30:00Z" : null,
	decision: null,
	folder,
});

async function fixture(
	seed: Parameters<typeof folderWriterFixture>[0] = {},
	options: Parameters<typeof folderWriterFixture>[1] & { outputFolder?: string } = {},
) {
	const f = await folderWriterFixture(seed, options);
	runs.push(f.run);
	const workers = (operations = new CloudNativeToolOperations(f.run, f.operationControl)) =>
		new CloudFolderWorkers({
			folder: f.folder,
			operations,
			identity: f.identity,
			handle: "nora",
			...(options.outputFolder ? { outputFolder: options.outputFolder } : {}),
		});
	return { ...f, workers };
}

const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
const hashedId = (namespace: string, runId: string, key: string) => {
	const hex = createHash("sha256").update(`${namespace}:${runId}:${key}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
async function refuses(
	call: Promise<unknown>,
	reason: string,
	kind: new (message: string) => Error = CloudToolRefusal,
) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(kind);
	expect((error as Error).message).toContain(reason);
}

const DISPATCH: CloudFolderWorkerChange = {
	action: "dispatch",
	operationKey: "dispatch-1",
	todoKey: "market-scan",
	workerKey: "prices",
	title: "Collect prices",
	goal: "Collect the list prices.\r\nOne per competitor.",
	definitionOfDone: "One verified price per competitor.",
	context: "",
	sources: ["research/competitors.md"],
	access: "read",
	revival: "batch",
};

it("dispatches a worker as its folder with brief.md, under the call's review and the worker tool's request", async () => {
	const f = await fixture({ files: { [TODO]: todoText() } });
	const result = parse(await f.workers().change(DISPATCH, f.context));
	expect(result).toMatchObject({
		schema: "qorpera.agent-worker-receipt/v1",
		runId: f.identity.runId,
		action: "dispatch",
		outcome: "saved",
		todoKey: "market-scan",
		worker: { workerKey: "prices", path: FOLDER, file: `${FOLDER}/brief.md` },
	});
	expect(result.next).toContain("end your turn");
	// The todo's folder first (the core never invents a parent), then the worker's folder holding only its brief.
	expect(f.commits).toHaveLength(1);
	const [commit] = f.commits;
	expect(commit).toMatchObject({ key: "worker-file:dispatch-1", receiptId: result.receiptId });
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["mkdir", "agents/nora/todos/market-scan"],
		["new_folder", FOLDER],
	]);
	expect((commit?.units[1]?.contents as { path: string }[]).map((item) => item.path)).toEqual(["brief.md"]);
	// Delegation: this call's approval, recorded for exactly these units.
	expect(f.recordings[0]?.p_request).toMatchObject({ tool: "manage_worker", units: commit?.units });
	expect(f.reviews.get(commit?.reviewId as string)).toBe(JSON.stringify(commit?.units));
	// The request the hook checks the brief against: texts as the file holds them, no context as null.
	expect(f.workerRequests).toEqual([
		{
			action: "dispatch",
			folder: FOLDER,
			title: "Collect prices",
			access: "read",
			revival: "batch",
			goal: "Collect the list prices.\nOne per competitor.",
			doneWhen: "One verified price per competitor.",
			context: null,
			sources: ["research/competitors.md"],
		},
	]);
	const parsed = parseCompanyStateFile(`${FOLDER}/brief.md`, f.text(`${FOLDER}/brief.md`) ?? "");
	expect(parsed?.ok && parsed.file).toMatchObject({
		kind: "worker-brief",
		id: hashedId("qorpera.folder-worker/v1", f.identity.runId, "dispatch-1"),
		title: "Collect prices",
		species: "in-house",
		followUps: 0,
		goal: "Collect the list prices.\nOne per competitor.",
		context: null,
		sources: ["research/competitors.md"],
		...workerStandingTexts({ species: "in-house", access: "read", revival: "batch" }),
	});
	// A replay of the same call returns its stored result and commits nothing more.
	expect(parse(await f.workers().change(DISPATCH, f.context))).toEqual(result);
	expect(f.commits).toHaveLength(1);
});

it("dispatches into a todo folder that exists without making it again", async () => {
	const f = await fixture({ files: { [TODO]: todoText("blocked") }, folders: ["agents/nora/todos/market-scan"] });
	expect(parse(await f.workers().change(DISPATCH, f.context)).outcome).toBe("saved");
	expect(f.commits[0]?.units.map((unit) => unit.op)).toEqual(["new_folder"]);
});

it("reports a dispatch by its worker folder: a todo folder another dispatch made meanwhile is no failure", async () => {
	const f = await fixture({ files: { [TODO]: todoText() } });
	// Read missing; made by another dispatch before this one commits: its mkdir is a conflict, its worker folder saves.
	const stage = f.folder.stage.bind(f.folder);
	vi.spyOn(f.folder, "stage").mockImplementation(async (units, signal) => {
		f.folders.add("agents/nora/todos/market-scan");
		return stage(units, signal);
	});
	const result = parse(await f.workers().change(DISPATCH, f.context));
	expect(f.commits[0]?.units.map((unit) => unit.op)).toEqual(["mkdir", "new_folder"]);
	expect(result).toMatchObject({ outcome: "saved", worker: { path: FOLDER } });
	expect(result.next).toContain("end your turn");
	expect(f.text(`${FOLDER}/brief.md`)).not.toBeNull();
});

it("follows up a worker that has no results without naming any", async () => {
	const f = await fixture({ files: { [TODO]: todoText(), [`${FOLDER}/brief.md`]: briefText() } });
	await f
		.workers()
		.change(
			{ action: "followup", operationKey: "follow-3", todoKey: "market-scan", workerKey: "prices", text: "Go on." },
			f.context,
		);
	expect(f.workerRequests).toEqual([{ action: "followup", folder: FOLDER, text: "Go on.", resultsVersion: null }]);
	expect(f.commits[0]?.units.map((unit) => unit.op)).toEqual(["write"]);
});

it.each<[string, Partial<CloudFolderWorkerChange>, Record<string, string>, string]>([
	["no todo", {}, {}, "You have no todo with that todoKey"],
	["a closed todo", {}, { [TODO]: todoText("done") }, "That todo is closed"],
	[
		"a coding session without its harness and repository",
		{ species: "coding" },
		{ [TODO]: todoText() },
		"A coding session needs a harness, a repository and read access",
	],
	["a key that cannot name a folder", { workerKey: "my_prices" }, { [TODO]: todoText() }, "names the worker's folder"],
	[
		"a todo key that is not a file name",
		{ todoKey: "Market.Scan" },
		{ [TODO]: todoText() },
		"todoKey is the todo's file name",
	],
	[
		"a goal that would start a section",
		{ goal: "Collect.\n## Done when\nnever" },
		{ [TODO]: todoText() },
		"## Done when",
	],
])("refuses a dispatch with %s before its receipt", async (_label, change, files, reason) => {
	const f = await fixture({ files });
	await refuses(f.workers().change({ ...DISPATCH, ...change }, f.context), reason);
	expect(f.commits).toHaveLength(0);
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
});

it("refuses a dispatch or a follow-up the automatic review did not approve", async () => {
	const f = await fixture({ files: { [TODO]: todoText() } });
	const { actionReviewId: _unused, ...unreviewed } = f.context;
	await refuses(f.workers().change(DISPATCH, unreviewed), "automatic review's approval");
	await refuses(
		f
			.workers()
			.change(
				{ action: "followup", operationKey: "f-1", todoKey: "market-scan", workerKey: "prices", text: "More." },
				unreviewed,
			),
		"automatic review's approval",
	);
	expect(f.commits).toHaveLength(0);
});

it("dispatches a coding session: its brief names the harness and repository, and the database gets them (C3a/C3b)", async () => {
	const f = await fixture({ files: { [TODO]: todoText() } });
	const repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" } as const;
	const result = parse(
		await f
			.workers()
			.change(
				{ ...DISPATCH, operationKey: "code-1", species: "coding", harness: "codex", repository, sources: [] },
				f.context,
			),
	);
	const id = hashedId("qorpera.folder-worker/v1", f.identity.runId, "code-1");
	// The session is queued for its machine; its result comes back by itself.
	expect(result).toMatchObject({
		action: "dispatch",
		outcome: "saved",
		coding: { phase: "queued", harness: "codex", branch: `qorpera/coding/${id}` },
	});
	expect(result.next).toContain("queued for its machine");
	expect(f.workerRequests).toEqual([
		expect.objectContaining({ action: "dispatch", species: "coding", harness: "codex", repository, access: "read" }),
	]);
	const parsed = parseCompanyStateFile(`${FOLDER}/brief.md`, f.text(`${FOLDER}/brief.md`) ?? "");
	expect(parsed?.ok && parsed.file).toMatchObject({
		kind: "worker-brief",
		id,
		species: "coding",
		harness: "codex",
		repository,
		...workerStandingTexts({ species: "coding", access: "read", revival: "batch" }),
	});
	// An in-house dispatch names no coding field and gets no coding answer.
	const plain = await fixture({ files: { [TODO]: todoText() } });
	const answer = parse(await plain.workers().change(DISPATCH, plain.context));
	expect(answer.coding).toBeUndefined();
	expect(Object.keys(plain.workerRequests[0] ?? {})).not.toContain("species");
});

it("follows a worker up: its brief with one more follow-up, and its earlier results removed, under review", async () => {
	const f = await fixture({
		files: { [TODO]: todoText(), [`${FOLDER}/brief.md`]: briefText(), [`${FOLDER}/results.md`]: resultsText() },
	});
	const read = f.files.get(`${FOLDER}/results.md`)?.version;
	const result = parse(
		await f.workers().change(
			{
				action: "followup",
				operationKey: "follow-1",
				todoKey: "market-scan",
				workerKey: "prices",
				text: "Add Delta.\r\n",
			},
			f.context,
		),
	);
	expect(result).toMatchObject({ action: "followup", outcome: "saved", worker: { file: `${FOLDER}/brief.md` } });
	const [commit] = f.commits;
	expect(commit?.units.map((unit) => [unit.op, unit.path])).toEqual([
		["write", `${FOLDER}/brief.md`],
		["delete", `${FOLDER}/results.md`],
	]);
	// It names the results it removes, as read: a decision that landed since makes it a conflict in SQL.
	expect(f.workerRequests).toEqual([{ action: "followup", folder: FOLDER, text: "Add Delta.", resultsVersion: read }]);
	expect(f.reviews.get(commit?.reviewId as string)).toBe(JSON.stringify(commit?.units));
	const parsed = parseCompanyStateFile(`${FOLDER}/brief.md`, f.text(`${FOLDER}/brief.md`) ?? "");
	expect(parsed?.ok && parsed.file).toMatchObject({
		followUps: 1,
		followUp: "Add Delta.",
		goal: "Collect the list prices.",
	});
	expect(f.text(`${FOLDER}/results.md`)).toBeNull();
	// A worker it does not have.
	await refuses(
		f
			.workers()
			.change(
				{ action: "followup", operationKey: "follow-2", todoKey: "market-scan", workerKey: "other", text: "x" },
				f.context,
			),
		"You have no worker",
	);
});

it("records a decision on a reported result, without a review, and only accepts a success", async () => {
	const f = await fixture({
		files: { [TODO]: todoText(), [`${FOLDER}/brief.md`]: briefText(), [`${FOLDER}/results.md`]: resultsText() },
	});
	const decide = (decision: "accept" | "reject", key: string, note?: string) =>
		f.workers().change(
			{
				action: "decide",
				operationKey: key,
				todoKey: "market-scan",
				workerKey: "prices",
				decision,
				...(note ? { note } : {}),
			},
			f.context,
		);
	expect(parse(await decide("accept", "decide-1", "Checked against the sites.")).outcome).toBe("saved");
	expect(f.workerRequests).toEqual([
		{ action: "decide", folder: FOLDER, decision: "accepted", note: "Checked against the sites." },
	]);
	expect(f.commits[0]?.reviewId).toBeUndefined();
	const parsed = parseCompanyStateFile(`${FOLDER}/results.md`, f.text(`${FOLDER}/results.md`) ?? "");
	expect(parsed?.ok && parsed.file).toMatchObject({
		outcome: "succeeded",
		decision: "accepted",
		note: "Checked against the sites.",
		summary: "Alfa 49, Beta 59, Gamma 45.",
	});
	const failed = await fixture({ files: { [`${FOLDER}/results.md`]: resultsText("failed") } });
	await refuses(
		failed
			.workers()
			.change(
				{ action: "decide", operationKey: "d-2", todoKey: "market-scan", workerKey: "prices", decision: "accept" },
				failed.context,
			),
		"Only a succeeded worker's result is accepted",
	);
	const none = await fixture({ files: { [TODO]: todoText() } });
	await refuses(
		none
			.workers()
			.change(
				{ action: "decide", operationKey: "d-3", todoKey: "market-scan", workerKey: "prices", decision: "reject" },
				none.context,
			),
		"has no report to decide on",
	);
});

it("writes a worker run's report in its own folder, from its wake", async () => {
	const f = await fixture({ files: { [`${FOLDER}/brief.md`]: briefText() } }, { outputFolder: FOLDER });
	const result = parse(
		await f.workers().report(
			{
				operationKey: "report-1",
				outcome: "blocked",
				summary: "Delta has no list price.",
				needs: "Which Delta?",
				outputs: [`${FOLDER}/prices.md`],
			},
			f.context,
		),
	);
	expect(result).toMatchObject({
		schema: "qorpera.worker-report-receipt/v1",
		outcome: "saved",
		report: { outcome: "blocked", path: `${FOLDER}/results.md` },
	});
	expect(f.commits[0]).toMatchObject({ key: "worker-report:report-1" });
	expect(f.commits[0]?.reviewId).toBeUndefined();
	expect(f.workerRequests).toEqual([{ action: "report", folder: FOLDER }]);
	const parsed = parseCompanyStateFile(`${FOLDER}/results.md`, f.text(`${FOLDER}/results.md`) ?? "");
	expect(parsed?.ok && parsed.file).toMatchObject({
		outcome: "blocked",
		decision: null,
		summary: "Delta has no list price.",
		needs: "Which Delta?",
		files: [`${FOLDER}/prices.md`],
	});
	// A run whose wake names no folder of this agent's never reports in one.
	for (const outputFolder of [undefined, "agents/otto/todos/market-scan/prices", "work/todos/x"]) {
		const other = await fixture({}, outputFolder ? { outputFolder } : {});
		await expect(
			other.workers().report({ operationKey: "report-2", outcome: "failed", summary: "No." }, other.context),
		).rejects.toThrow("This worker's folder is not known");
	}
});

it("lists one todo's workers, filtered, and reads one worker's whole result from its file", async () => {
	const workers = {
		"market-scan": [view("succeeded"), view("running", "stock", "agents/nora/todos/market-scan/stock")],
	};
	const f = await fixture({ files: { [`${FOLDER}/results.md`]: resultsText() } }, { workers });
	const fits = () => true;
	const all = parse(await f.workers().status({ todoKey: "market-scan" }, f.context, fits));
	expect(all).toMatchObject({
		schema: "qorpera.agent-workers/v1",
		todoKey: "market-scan",
		moreWorkers: 0,
		nextCursor: null,
	});
	expect(all.workers.map((worker: { workerKey: string; path: string }) => [worker.workerKey, worker.path])).toEqual([
		["prices", FOLDER],
		["stock", "agents/nora/todos/market-scan/stock"],
	]);
	// Outputs as paths; no cursor shown with a worker.
	expect(all.workers[0]).toMatchObject({ outputs: [`${FOLDER}/prices.md`] });
	expect(all.workers[0].cursor).toBeUndefined();
	expect(
		parse(await f.workers().status({ todoKey: "market-scan", state: "active" }, f.context, fits)).workers,
	).toHaveLength(1);
	expect(
		parse(await f.workers().status({ todoKey: "market-scan", search: "STOCK" }, f.context, fits)).workers,
	).toHaveLength(1);
	// As many as fit, and how many more.
	const one = parse(await f.workers().status({ todoKey: "market-scan" }, f.context, () => false));
	expect(one).toMatchObject({ moreWorkers: 1 });
	expect(one.workers).toHaveLength(1);
	// The next page continues after the last worker shown.
	const next = parse(await f.workers().status({ todoKey: "market-scan", cursor: one.nextCursor }, f.context, fits));
	expect(next).toMatchObject({ moreWorkers: 0, nextCursor: null });
	expect(next.workers.map((worker: { workerKey: string }) => worker.workerKey)).toEqual(["stock"]);
	// One worker whole: its results read from the file, and that read released with the result.
	const whole = parse(await f.workers().status({ todoKey: "market-scan", workerKey: "prices" }, f.context, fits));
	expect(whole.workers[0]).toMatchObject({ summary: "Alfa 49, Beta 59, Gamma 45.", results: `${FOLDER}/results.md` });
	expect(f.releases).toHaveLength(1);
	expect((f.releases[0]?.p_reads as { path: string }[])[0]?.path).toBe(`${FOLDER}/results.md`);
	await refuses(f.workers().status({}, f.context, fits), "name its todoKey", CloudToolArgumentRefusal);
	await refuses(
		f.workers().status({ todoKey: "market-scan", cursor: "0b1c2d3e-4444-4444-8444-444444444444" }, f.context, fits),
		"cursor must be a nextCursor",
		CloudToolArgumentRefusal,
	);
	await refuses(f.workers().status({ todoKey: "other" }, f.context, fits), "You have no todo with that todoKey");
});

it("cancels a worker as a run effect under its own receipt", async () => {
	const f = await fixture({}, { workers: { "market-scan": [view("running")] } });
	const result = parse(
		await f
			.workers()
			.change(
				{ action: "cancel", operationKey: "cancel-1", todoKey: "market-scan", workerKey: "prices" },
				f.context,
			),
	);
	expect(result).toMatchObject({
		schema: "qorpera.agent-worker-receipt/v1",
		action: "cancel",
		todoKey: "market-scan",
		worker: { workerKey: "prices", state: "cancelled", path: FOLDER },
	});
	expect(f.cancels[0]).toMatchObject({
		p_binding: f.binding,
		p_request: { folder: FOLDER, operationKey: "cancel-1" },
	});
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	await refuses(
		f
			.workers()
			.change({ action: "cancel", operationKey: "cancel-2", todoKey: "market-scan", workerKey: "other" }, f.context),
		"You have no worker",
	);
	// A coding session with a new turn since the agent was asked about it is left alone, in SQL's words (C3c); the
	// cancel's other 55000 is no refusal of the model's.
	const stale = await fixture(
		{},
		{ cancelError: { code: "55000", message: "The session has a new turn since you were asked; leave it" } },
	);
	await refuses(
		stale
			.workers()
			.change(
				{ action: "cancel", operationKey: "cancel-3", todoKey: "market-scan", workerKey: "prices" },
				stale.context,
			),
		"The session has a new turn since you were asked; leave it",
	);
	const reconciling = await fixture(
		{},
		{ cancelError: { code: "55000", message: "Worker operation needs reconciliation" } },
	);
	const error = await reconciling
		.workers()
		.change(
			{ action: "cancel", operationKey: "cancel-4", todoKey: "market-scan", workerKey: "prices" },
			reconciling.context,
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		);
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toBeInstanceOf(CloudToolRefusal);
});

it("archives a coding session as a run effect under its own receipt, and relays its refusals (C3b)", async () => {
	const f = await fixture({}, { workers: { "market-scan": [view("running")] } });
	const result = parse(
		await f
			.workers()
			.change(
				{ action: "archive", operationKey: "archive-1", todoKey: "market-scan", workerKey: "prices" },
				f.context,
			),
	);
	expect(result).toMatchObject({
		schema: "qorpera.agent-worker-receipt/v1",
		action: "archive",
		todoKey: "market-scan",
		worker: { workerKey: "prices", state: "cancelled", path: FOLDER },
		coding: { phase: "cancelled", archived: true },
	});
	expect(f.archives[0]).toMatchObject({
		p_binding: f.binding,
		p_request: { folder: FOLDER, operationKey: "archive-1" },
	});
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	await refuses(
		f
			.workers()
			.change(
				{ action: "archive", operationKey: "archive-2", todoKey: "market-scan", workerKey: "other" },
				f.context,
			),
		"You have no worker",
	);
	for (const [code, words] of [
		["22023", "Only a coding session can be archived"],
		["55000", "The session has a new turn since you were asked; leave it"],
	] as const) {
		const refused = await fixture({}, { archiveError: { code, message: words } });
		await refuses(
			refused
				.workers()
				.change(
					{ action: "archive", operationKey: "archive-3", todoKey: "market-scan", workerKey: "prices" },
					refused.context,
				),
			words,
		);
	}
});

it("routes manage_worker and report_work to the folder writer, and says how workers work there", async () => {
	const f = await fixture({ files: { [TODO]: todoText() } });
	const gateway = { read: async () => ({}), mutate: async () => ({}) } as never;
	const control = {
		call: async () => {
			throw new Error("The legacy worker functions are not called");
		},
	} as never;
	const [, manage] = cloudWorkerTools(
		f.binding,
		f.identity,
		control,
		gateway,
		{ kind: "human", source: { kind: "input", id: f.identity.runId, occurrenceKey: "x" } } as never,
		{
			folderWorkers: f.workers(),
		},
	);
	expect(manage?.description).toContain("status lists the workers of one todo (name its todoKey)");
	expect(manage?.description).toContain("holds brief.md");
	// Coding sessions and their archive are this company's too (C3b).
	expect(manage?.description).toContain("A coding session is a worker with species coding");
	expect(manage?.description).toContain("Actions: dispatch, status, followup, cancel, decide, archive.");
	expect(manage?.description).not.toContain("without todoKey, those of open todos");
	// As the model sends them: JSON, without the empty context.
	const { context: _context, ...sent } = DISPATCH;
	const request = manage?.parseArguments(JSON.parse(JSON.stringify(sent)));
	expect(parse(await manage!.execute(request, f.context))).toMatchObject({ action: "dispatch", outcome: "saved" });
	const reporting = await fixture({ files: { [`${FOLDER}/brief.md`]: briefText() } }, { outputFolder: FOLDER });
	const [report] = cloudWorkerTools(
		reporting.binding,
		reporting.identity,
		control,
		gateway,
		{ kind: "agent", source: { kind: "worker-dispatch", id: reporting.identity.runId, occurrenceKey: "y" } } as never,
		{ folderWorkers: reporting.workers() },
	);
	expect(report?.name).toBe("report_work");
	const parsed = report?.parseArguments({ operationKey: "report-1", outcome: "succeeded", summary: "Done." });
	expect(parse(await report!.execute(parsed, reporting.context))).toMatchObject({ outcome: "saved" });
});
