import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import { CloudFolderProposals } from "@qorpera/runtime/cloud-folder-proposals";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const run of runs.splice(0)) run.close();
});

const HIRE = "5b0c2d3e-1111-4111-8111-111111111111";
const MIXED = "5b0c2d3e-2222-4222-8222-222222222222";
const AGENT = "0a1b2c3d-3333-4333-8333-333333333333";
const REVIEW = "6c1d2e3f-4444-4444-8444-444444444444";
const COMMIT = "7d2e3f40-5555-4555-8555-555555555555";
const VERSION = "8e3f4051-6666-4666-8666-666666666666";

const hireUnit = {
	unit: 1,
	op: "new_folder",
	path: "agents/mira",
	items: 2,
	contains: [
		{ path: "agents/mira/agent.md", kind: "file" },
		{ path: "agents/mira/notes.md", kind: "file" },
	],
	structured: [
		{
			path: "agents/mira/agent.md",
			kind: "agent",
			parse: {
				kind: "agent",
				id: AGENT,
				name: "Mira",
				role: "Bookkeeper",
				status: "active",
				instructions: "Keep the books straight and close each month by the 5th.",
			},
		},
	],
};
const mixedUnits = [
	{
		unit: 1,
		op: "write",
		path: "routines/monday-report.md",
		structured: [
			{
				path: "routines/monday-report.md",
				kind: "routine",
				parse: {
					kind: "routine",
					title: "Monday report",
					status: "active",
					trigger: { when: "weekly", days: ["monday"], time: "09:00" },
					timezone: "Europe/Copenhagen",
					instructions: "Sum up last week's sales for the team.",
				},
			},
		],
	},
	{ unit: 2, op: "delete", path: "docs/old/q3-plan.md" },
	{ unit: 3, op: "move", path: "docs/draft-offer.md", to: "docs/final-offer.md" },
];
const AUTHORITY = {
	resourceId: "9f405162-7777-4777-8777-777777777777",
	resourceRevision: 2,
	grantId: null,
	grantRevision: null,
};
// Every path a proposal names, with the authority its list was decided on (as the kernel gives them).
const readsOf = (units: unknown[]) =>
	(units as { path: string; to?: string; structured?: { path: string }[] }[])
		.flatMap((unit) => [unit.path, ...(unit.to ? [unit.to] : []), ...(unit.structured ?? []).map(({ path }) => path)])
		.map((path) => ({ path, authority: AUTHORITY }));
const proposal = (proposalId: string, units: unknown[], extra: Record<string, unknown> = {}) => ({
	proposalId,
	createdAt: "2026-10-05T10:00:00+00:00",
	viewKind: "computer_desktop",
	effect: "delegation",
	createsAgent: true,
	unitCount: units.length,
	units,
	moreUnits: 0,
	reads: readsOf(units),
	...extra,
});
const page = (proposals: { proposalId: string }[], moreProposals = 0) => ({
	schema: "qorpera.folder-agent-proposals/v1",
	proposals,
	moreProposals,
	nextCursor: moreProposals ? (proposals.at(-1)?.proposalId ?? null) : null,
});
const LISTED = page(
	[
		proposal(HIRE, [hireUnit]),
		proposal(MIXED, mixedUnits, {
			viewKind: "computer_shell_command",
			effect: "destructive",
			createsAgent: false,
			unitCount: 5,
			moreUnits: 2,
		}),
	],
	1,
);
const committed = (units: Record<string, unknown>[]) => ({
	schema: "qorpera.folder-commit/v1",
	commitId: COMMIT,
	seq: units.some((unit) => unit.outcome === "saved") ? 7 : null,
	replay: false,
	units,
});
const closed = (proposalId: string, status: string) => ({ schema: "qorpera.folder-proposal/v1", proposalId, status });

async function fixture(
	options: {
		listed?: () => unknown;
		recorder?: (request: Record<string, unknown>) => Record<string, unknown> | null;
		apply?: (args: Record<string, unknown>) => unknown;
		close?: (args: Record<string, unknown>) => unknown;
	} = {},
) {
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const f = await folderWriterFixture(
		{},
		{
			recorder:
				options.recorder ??
				((request) => ({
					schema: "qorpera.folder-review/v1",
					reviewId: REVIEW,
					approvedBy: null,
					units: request.proposalId === HIRE ? 1 : 5,
				})),
			rpc: (method, args) => {
				calls.push({ method, args: structuredClone(args) });
				if (method === "qorpera_folder_agent_proposals") return (options.listed ?? (() => LISTED))();
				if (method === "qorpera_folder_apply_proposal") return options.apply?.(args);
				if (method === "qorpera_folder_close_proposal") return options.close?.(args);
				return undefined;
			},
		},
	);
	runs.push(f.run);
	const proposals = await CloudFolderProposals.list(f.folder, f.context.signal);
	const tools = proposals?.tools(f.operations()) ?? [];
	return { ...f, calls, proposals, apply: tools[0] as CloudNativeTool, discard: tools[1] as CloudNativeTool };
}

const parse = (content: { value: unknown }) => JSON.parse(String(content.value));
async function refuses(call: Promise<unknown>, reason: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(reason);
}

it("lists nothing when no proposal waits, or when the list fails, and never fails the run", async () => {
	const empty = await fixture({ listed: () => page([]) });
	expect(empty.proposals).toBeUndefined();
	expect(empty.calls.map((call) => [call.method, call.args.p_request])).toEqual([
		["qorpera_folder_agent_proposals", {}],
	]);
	const refused = await fixture({
		listed: () => {
			throw new CloudCompanyFolderRpcError("42501", "Proposal authority is unavailable");
		},
	});
	expect(refused.proposals).toBeUndefined();
	// A malformed page is not shown either.
	const malformed = await fixture({ listed: () => ({ ...LISTED, nextCursor: HIRE }) });
	expect(malformed.proposals).toBeUndefined();
});

it("shows each waiting proposal in the context as its changes, with the paths, and counts the rest", async () => {
	const f = await fixture();
	expect(f.proposals?.context).toEqual({
		waiting: [
			{
				proposalId: HIRE,
				savedAt: "2026-10-05T10:00:00+00:00",
				savedFrom: "a computer",
				changes: [{ change: "Hire “Mira” as Bookkeeper", path: "agents/mira" }],
			},
			{
				proposalId: MIXED,
				savedAt: "2026-10-05T10:00:00+00:00",
				savedFrom: "a command on a computer",
				changes: [
					{ change: "Set up or change the routine “Monday report”", path: "routines/monday-report.md" },
					{ change: "Delete “Q3 plan” from “Old”", path: "docs/old/q3-plan.md" },
					{
						change: "Rename “Draft offer” to “Final offer”",
						path: "docs/draft-offer.md",
						to: "docs/final-offer.md",
					},
				],
				moreChanges: 2,
			},
		],
		moreWaiting: 1,
	});
	expect(f.apply.name).toBe("apply_proposal");
	expect(f.discard.name).toBe("discard_proposal");
	// What the run releases with that context: every listed proposal's paths, with no version (no file was read).
	expect(f.proposals?.reads).toEqual(
		[...readsOf([hireUnit]), ...readsOf(mixedUnits)].map((read) => ({ ...read, version: null })),
	);
});

it("reviews exactly the listed id, and shows the card the changes, never the files", async () => {
	const f = await fixture();
	const refused: JsonValue[] = [
		{ proposalId: HIRE.toUpperCase() },
		{ proposalId: HIRE, note: "now" },
		{ proposalId: "5b0c2d3e-9999-4999-8999-999999999999" },
		{},
		null,
	];
	for (const value of refused)
		expect(() => f.apply.parseArguments(value), JSON.stringify(value)).toThrow(CloudToolArgumentRefusal);
	expect(() => f.discard.parseArguments({ proposalId: "5b0c2d3e-9999-4999-8999-999999999999" })).toThrow(
		/not one of the proposals listed/,
	);
	expect(f.discard.parseArguments({ proposalId: HIRE })).toEqual({ proposalId: HIRE });
	const saved = (from: string) => ({
		key: "saved",
		value: `Saved earlier from ${from}; nothing of it applies until this is allowed`,
	});
	expect(f.apply.parseArguments({ proposalId: HIRE })).toEqual({
		proposalId: HIRE,
		effect: "delegation",
		title: "Hire a new agent",
		target: "Mira",
		details: [
			{ key: "role", value: "Bookkeeper" },
			{ key: "intent", value: "Keep the books straight and close each month by the 5th.", quoted: true },
			saved("a computer"),
		],
	});
	// Listed in part (5 changes, 3 listed): never applied on a review of a part, though it can still be dropped.
	expect(() => f.apply.parseArguments({ proposalId: MIXED })).toThrow(/more changes than its review can read in full/);
	expect(() => f.apply.reviewContents?.({ proposalId: MIXED })).toThrow(CloudToolArgumentRefusal);
	expect(f.discard.parseArguments({ proposalId: MIXED })).toEqual({ proposalId: MIXED });
	const whole = await fixture({
		listed: () =>
			page([
				proposal(MIXED, mixedUnits, {
					viewKind: "computer_shell_command",
					effect: "destructive",
					createsAgent: false,
				}),
			]),
	});
	expect(whole.apply.parseArguments({ proposalId: MIXED })).toEqual({
		proposalId: MIXED,
		effect: "destructive",
		title: "Apply 3 changes saved from a command on a computer",
		target: null,
		details: [
			saved("a command on a computer"),
			{ key: "change 1", value: "Set up or change the routine “Monday report”" },
			{ key: "change 2", value: "Delete “Q3 plan” from “Old”" },
			{ key: "change 3", value: "Rename “Draft offer” to “Final offer”" },
			{ key: "intent", value: "Sum up last week's sales for the team.", quoted: true },
		],
	});
});

it("words an event routine's trigger on the card, as manage_routine's card does", async () => {
	const routineId = "5b0c2d3e-3333-4333-8333-333333333333";
	const hook = "4e5f6071-8888-4888-8888-888888888888";
	const cases: [Record<string, unknown>, string][] = [
		[
			{ when: "event", hook, only: ["payment_intent.succeeded", "charge.refunded"] },
			"When a hook receives “payment_intent.succeeded” and “charge.refunded” events (Europe/Copenhagen)",
		],
		[{ when: "event", hook }, "When a hook receives an event (Europe/Copenhagen)"],
	];
	for (const [trigger, schedule] of cases) {
		const unit = {
			unit: 1,
			op: "write",
			path: "routines/stripe-payments.md",
			structured: [
				{
					path: "routines/stripe-payments.md",
					kind: "routine",
					parse: {
						kind: "routine",
						title: "Stripe payments",
						status: "active",
						trigger,
						timezone: "Europe/Copenhagen",
						instructions: "Thank each paying customer.",
					},
				},
			],
		};
		const f = await fixture({ listed: () => page([proposal(routineId, [unit], { createsAgent: false })]) });
		const card = f.apply.parseArguments({ proposalId: routineId }) as { title: string; details: unknown[] };
		expect(card.title).toBe("Set up or change a routine");
		expect(card.details).toContainEqual({ key: "schedule", value: schedule });
	}
});

it("gives the review every change in full, where the card counts the rest and cuts the text", async () => {
	const instructions = `Keep the books straight. ${"Check every invoice twice. ".repeat(60)}Then wire the balance to account 4410.`;
	const agentParse = { ...hireUnit.structured[0].parse, instructions };
	const hire = { ...hireUnit, structured: [{ ...hireUnit.structured[0], parse: agentParse }] };
	const deletes = Array.from({ length: 10 }, (_, index) => ({
		unit: index + 2,
		op: "delete",
		path: `docs/old/note-${index + 1}.md`,
	}));
	const f = await fixture({ listed: () => page([proposal(HIRE, [hire, ...deletes])]) });
	const card = f.apply.parseArguments({ proposalId: HIRE }) as { details: { key: string; value: string }[] };
	// The card shows eight changes and counts the rest; it quotes the start of the instructions.
	expect(card.details.filter((detail) => detail.key.startsWith("change "))).toHaveLength(8);
	expect(card.details).toContainEqual({ key: "more", value: "3 more changes" });
	expect(JSON.stringify(card)).not.toContain("account 4410");
	// The review reads all eleven, and the whole instructions.
	expect(f.apply.reviewContents?.(card)).toEqual({
		proposalId: HIRE,
		savedFrom: "computer_desktop",
		createsAgent: true,
		changes: [
			{
				op: "new_folder",
				path: "agents/mira",
				items: 2,
				contains: [
					{ path: "agents/mira/agent.md", kind: "file" },
					{ path: "agents/mira/notes.md", kind: "file" },
				],
				files: [{ path: "agents/mira/agent.md", kind: "agent", parse: agentParse }],
			},
			...deletes.map(({ op, path }) => ({ op, path })),
		],
	});
});

it("gives the review each link a parked new folder holds with its target, and a link's own change at its path", async () => {
	// A view makes links (LK1): one in a new folder is listed with its target; a link's own unit, as a write's, with
	// its path.
	const contains = [...hireUnit.contains, { path: "agents/mira/latest", kind: "symlink", target: "notes.md" }];
	const units = [
		{ ...hireUnit, items: 3, contains },
		{ unit: 2, op: "symlink", path: "docs/latest" },
	];
	const f = await fixture({ listed: () => page([proposal(HIRE, units)]) });
	const card = f.apply.parseArguments({ proposalId: HIRE }) as { details: { key: string; value: string }[] };
	expect(card.details).toContainEqual({ key: "change 2", value: "Change “Latest”" });
	expect(f.apply.reviewContents?.(card)).toEqual({
		proposalId: HIRE,
		savedFrom: "computer_desktop",
		createsAgent: true,
		changes: [
			{ op: "new_folder", path: "agents/mira", items: 3, contains, files: hireUnit.structured },
			{ op: "symlink", path: "docs/latest" },
		],
	});
});

it("records the review of the proposal's units before its receipt, then applies it under that receipt", async () => {
	const f = await fixture({
		apply: () => committed([{ unit: 1, op: "new_folder", path: "agents/mira", outcome: "saved", version: VERSION }]),
	});
	const execute = vi.spyOn(CloudNativeToolOperations.prototype, "execute");
	const result = parse(await f.apply.execute(f.apply.parseArguments({ proposalId: HIRE }), f.context));
	expect(result).toEqual({
		schema: "qorpera.folder-proposal-apply/v1",
		proposalId: HIRE,
		receiptId: expect.any(String),
		outcome: "applied",
		saved: 1,
		hired: [{ id: AGENT, name: "Mira" }],
		next: expect.stringContaining("wake it with send_coworker_message"),
	});
	expect(f.recordings.map((recording) => recording.p_request)).toEqual([
		{
			actionReviewId: f.context.actionReviewId,
			tool: "apply_proposal",
			argumentSha256: f.context.argumentSha256,
			proposalId: HIRE,
		},
	]);
	const applies = f.calls.filter((call) => call.method === "qorpera_folder_apply_proposal");
	expect(applies).toHaveLength(1);
	expect(applies[0]?.args).toMatchObject({
		p_operation_key: `apply-proposal:${HIRE}`,
		p_proposal_id: HIRE,
		p_review_id: REVIEW,
		p_receipt_id: result.receiptId,
	});
	expect(execute.mock.calls[0]?.[0].operation).toEqual({
		tool: "apply_proposal",
		toolVersion: "folder-v2/1",
		logicalOperationKey: `apply:${HIRE}`,
		arguments: { proposalId: HIRE },
		target: { proposalId: HIRE },
		requiresCompanyRevision: true,
	});
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	expect(f.operationControl.completeFolderToolOperation.mock.calls[0]?.[1]).toMatchObject({
		receiptId: result.receiptId,
		folderCommitId: COMMIT,
	});
});

it("says which changes were not applied and why", async () => {
	const f = await fixture({
		apply: () =>
			committed([
				{ unit: 1, op: "write", path: "routines/monday-report.md", outcome: "saved", version: VERSION },
				{ unit: 2, op: "delete", path: "docs/old/q3-plan.md", outcome: "conflict", reason: "version_changed" },
				{
					unit: 3,
					op: "move",
					path: "docs/draft-offer.md",
					to: "docs/final-offer.md",
					outcome: "refused",
					reason: "structured_invalid",
					problems: [{ code: "rule", message: "unknown agent" }],
				},
				{ unit: 4, op: "write", path: "docs/a.md", outcome: "conflict", reason: "exists" },
				{ unit: 5, op: "write", path: "docs/b.md", outcome: "conflict", reason: "exists" },
			]),
	});
	const result = parse(await f.apply.execute({ proposalId: MIXED }, f.context));
	expect(result).toMatchObject({
		outcome: "applied",
		saved: 1,
		notSaved: [
			{ path: "docs/old/q3-plan.md", outcome: "conflict", reason: "version_changed" },
			{
				path: "docs/draft-offer.md",
				to: "docs/final-offer.md",
				outcome: "refused",
				reason: "structured_invalid",
				problems: ["unknown agent"],
			},
			{ path: "docs/a.md", outcome: "conflict", reason: "exists" },
			{ path: "docs/b.md", outcome: "conflict", reason: "exists" },
		],
	});
	expect(result.hired).toBeUndefined();
	expect(result.next).toContain("The changes in notSaved were not applied");
	const g = await fixture({
		apply: () =>
			committed([{ unit: 1, op: "new_folder", path: "agents/mira", outcome: "conflict", reason: "exists" }]),
	});
	const none = parse(await g.apply.execute({ proposalId: HIRE }, g.context));
	expect(none).toMatchObject({ outcome: "not_applied", saved: 0, notSaved: [{ path: "agents/mira" }] });
	expect(none.hired).toBeUndefined();
	// The commit is still the receipt's: nothing was saved, and the receipt says so.
	expect(g.operationControl.completeFolderToolOperation.mock.calls[0]?.[1]).toMatchObject({ folderCommitId: COMMIT });
	// Decided while the apply waited for it: every change refused for review, and nothing to redo.
	const h = await fixture({
		apply: () =>
			committed([{ unit: 1, op: "new_folder", path: "agents/mira", outcome: "denied", reason: "review_required" }]),
	});
	const decided = parse(await h.apply.execute({ proposalId: HIRE }, h.context));
	expect(decided).toMatchObject({
		outcome: "not_applied",
		saved: 0,
		next: expect.stringContaining("no longer waiting"),
	});
	expect(decided.notSaved).toBeUndefined();
	expect(h.operationControl.completeFolderToolOperation.mock.calls[0]?.[1]).toMatchObject({ folderCommitId: COMMIT });
});

it("refuses before any receipt when the proposal is no longer open, or the call has no approval", async () => {
	const f = await fixture({
		recorder: () => {
			throw new CloudCompanyFolderRpcError("42501", "This proposal is not open for this run");
		},
	});
	await refuses(f.apply.execute({ proposalId: HIRE }, f.context), "no longer waiting for this conversation");
	expect(f.operationControl.beginToolOperation).not.toHaveBeenCalled();
	expect(f.calls.some((call) => call.method === "qorpera_folder_apply_proposal")).toBe(false);
	// Another refusal of the recorder is not this one.
	const g = await fixture({
		recorder: () => {
			throw new CloudCompanyFolderRpcError("42501", "Proposal authority is unavailable");
		},
	});
	const other = await g.apply.execute({ proposalId: HIRE }, g.context).then(
		() => null,
		(error: unknown) => error,
	);
	expect(other).not.toBeInstanceOf(CloudToolRefusal);
	expect(g.operationControl.beginToolOperation).not.toHaveBeenCalled();
	const h = await fixture();
	const { actionReviewId: _, ...unreviewed } = h.context;
	await refuses(h.apply.execute({ proposalId: HIRE }, unreviewed), "needs the automatic review's approval");
	expect(h.recordings).toEqual([]);
	expect(h.operationControl.beginToolOperation).not.toHaveBeenCalled();
	// A recorded review for another change set is invalid, not an apply.
	const i = await fixture({
		recorder: () => ({ schema: "qorpera.folder-review/v1", reviewId: REVIEW, approvedBy: null, units: 2 }),
	});
	await expect(i.apply.execute({ proposalId: HIRE }, i.context)).rejects.toThrow(/invalid/);
	expect(i.operationControl.beginToolOperation).not.toHaveBeenCalled();
});

it("ends refused, not unconfirmed, when a member discarded the proposal after its review was recorded", async () => {
	const unapplied = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.folder-proposal-unapplied/v1",
		proposalId: args.p_proposal_id,
		status: "discarded",
		receiptId: args.p_receipt_id,
		...extra,
	});
	const f = await fixture({ apply: (args) => unapplied(args) });
	const finish = vi.fn();
	const observation = { attemptId: "attempt", result: null, child: vi.fn(), update: vi.fn(), finish };
	await refuses(
		f.apply.execute({ proposalId: HIRE }, { ...f.context, observation }),
		"no longer waiting for this conversation",
	);
	// The kernel cancelled the call's receipt: nothing completes it, and the outcome is definite.
	expect(f.operationControl.beginToolOperation).toHaveBeenCalledTimes(1);
	expect(f.operationControl.completeFolderToolOperation).not.toHaveBeenCalled();
	const receiptId = f.calls.find((call) => call.method === "qorpera_folder_apply_proposal")?.args.p_receipt_id;
	expect(finish.mock.calls[0]).toEqual(["failed", { receiptId, errorCategory: "stale_version" }]);
	// An erased one answers the same.
	const g = await fixture({ apply: (args) => unapplied(args, { status: "erased" }) });
	await refuses(g.apply.execute({ proposalId: HIRE }, g.context), "no longer waiting for this conversation");
	// The answer must be of this call's proposal and receipt, with a known status: otherwise it is invalid, not settled.
	for (const extra of [
		{ receiptId: COMMIT },
		{ proposalId: MIXED },
		{ status: "open" },
		{ status: "gone" },
		{ note: "x" },
	]) {
		const h = await fixture({ apply: (args) => unapplied(args, extra) });
		const error = await h.apply.execute({ proposalId: HIRE }, h.context).then(
			() => null,
			(thrown: unknown) => thrown,
		);
		expect(error, JSON.stringify(extra)).toBeInstanceOf(Error);
		expect(error, JSON.stringify(extra)).not.toBeInstanceOf(CloudToolRefusal);
	}
});

it("closes a denied proposal as declined, and drops a discarded one", async () => {
	const f = await fixture({
		close: (args) => {
			const request = args.p_request as { proposalId: string; actionReviewId?: string };
			return request.proposalId === HIRE
				? closed(HIRE, request.actionReviewId ? "declined" : "discarded")
				: closed(MIXED, "not_applied");
		},
	});
	const denial = "5b0c2d3e-7777-4777-8777-777777777777";
	expect(await f.apply.denied?.({ proposalId: HIRE }, { ...f.context, actionReviewId: denial })).toContain(
		"closed as declined",
	);
	expect(parse(await f.discard.execute({ proposalId: HIRE }, f.context))).toEqual({
		schema: "qorpera.folder-proposal-close/v1",
		proposalId: HIRE,
		status: "discarded",
		next: "Dropped: none of its changes was applied.",
	});
	expect(parse(await f.discard.execute({ proposalId: MIXED }, f.context)).next).toBe(
		"It was already decided (not applied); nothing changed now.",
	);
	// A denial of a proposal decided meanwhile adds nothing to the denial.
	expect(await f.apply.denied?.({ proposalId: MIXED }, { ...f.context, actionReviewId: denial })).toBe("");
	expect(f.calls.filter((call) => call.method === "qorpera_folder_close_proposal").map((call) => call.args)).toEqual([
		{ p_binding: expect.any(Object), p_request: { proposalId: HIRE, actionReviewId: denial } },
		{ p_binding: expect.any(Object), p_request: { proposalId: HIRE } },
		{ p_binding: expect.any(Object), p_request: { proposalId: MIXED } },
		{ p_binding: expect.any(Object), p_request: { proposalId: MIXED, actionReviewId: denial } },
	]);
	const g = await fixture({
		close: () => {
			throw new CloudCompanyFolderRpcError("P0002", "Proposal not found");
		},
	});
	expect(parse(await g.discard.execute({ proposalId: HIRE }, g.context))).toMatchObject({
		status: "unavailable",
		next: expect.stringContaining("no longer waiting"),
	});
});
