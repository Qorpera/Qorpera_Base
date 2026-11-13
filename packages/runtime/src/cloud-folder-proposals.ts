import { companyPathKey, osRelative } from "@qorpera/cloud-client/company-state-files";
import { isUuid, type JsonValue, UUID_PATTERN } from "@qorpera/contracts";
import { cloudActionEventWhen, cloudActionFileName, cloudActionListened } from "./cloud-action-review.ts";
import type {
	CloudCompanyFolderClient,
	CloudCompanyFolderCommitResult,
	CloudCompanyFolderProposal,
	CloudCompanyFolderProposalPage,
	CloudCompanyFolderProposalUnit,
	CloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { cloudFolderRefusal } from "./cloud-folder-file-tools.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import { type CloudNativeToolOperations, CloudToolOperationSettled } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * The runtime side of C2-R2 (deploy/first-node/RUNTIME-COMPANY-FOLDER-C2.md §8, P40b). A change the agent saved through
 * a view (its computer's desktop, a shell command, a coding session) that needs review, such as a new agent.md or a
 * deletion, is parked by the commit as a proposal (P40a). A run of that agent for the same member that can raise a card
 * lists the open proposals when its turn starts: its context shows each as its changes, and two tools act on them.
 * - apply_proposal {proposalId}: the arguments are exactly the proposal's id, so the call's digest is the one the
 *   kernel checks (SHA-256 of ["qorpera","apply_proposal",'{"proposalId":"…"}']). The gate reviews it with the
 *   proposal's own effect, and its card shows the changes, never a file list (`card`). On an approval, R1's recorder
 *   records the review of the proposal's units before the receipt, so a proposal no longer open is a refusal; the run
 *   then applies it under its receipt. A member's discard (or an erasure) that lands between the two leaves nothing to
 *   apply: the kernel cancels that receipt and says so, and the call ends refused, never a held receipt that would fence
 *   the run. On a denial (the reviewer's, or a member's on the card)
 *   the boundary hands the denial to `denied`, which closes the proposal as declined.
 * - discard_proposal {proposalId}: the agent drops one. The kernel answers a decided proposal as it stands.
 * Both are offered only while the list has proposals, and refuse an id it did not show before any review.
 */

const TOOL_VERSION = "folder-v2/1";
/** Where the agent saved a proposal, by its view's kind. */
const SAVED_FROM: Readonly<Record<string, string>> = {
	computer_desktop: "a computer",
	computer_shell_command: "a command on a computer",
	coding_session: "a coding session",
	test_machine: "a test machine",
	run_box: "a run's own copy of the folder",
};
/** Changes the context shows per proposal; the rest are counted. */
const CONTEXT_CHANGES = 20;
/** Changes a card lists one by one; the rest are counted. */
const CARD_CHANGES = 8;
/** A path as the context shows it, at most (a longer one is cut). */
const PATH_BYTES = 512;
/** A quoted text on the card, at most (the card cuts again to its own bound). */
const QUOTE_BYTES = 1300;
/** Units the apply's answer names one by one when they were not saved. */
const RESULT_UNITS = 20;
const NOT_WAITING =
	"These saved changes are no longer waiting for this conversation: they were applied, declined, discarded or erased since this run started. Nothing was applied now.";

/** One fact or quote of a card, in order. */
interface CardDetail {
	readonly key: string;
	readonly value: string;
	readonly quoted?: true;
}

/** One unit as people say it: what changes, never a path. */
interface Change {
	readonly text: string;
	/** For a card of this change alone. */
	readonly title: string;
	readonly target: string | null;
	readonly details: readonly CardDetail[];
	/** The agent this change hires, when it is saved. */
	readonly hires?: { readonly id: string; readonly name: string };
}

function head(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	let used = 0;
	let end = 0;
	for (const character of text) {
		used += Buffer.byteLength(character);
		if (used > bytes - 3) break;
		end += character.length;
	}
	return `${text.slice(0, end)}...`;
}

/** A name from a parse, on one line. */
function named(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? head(value.replace(/\s+/g, " ").trim(), 120) : fallback;
}

function parentOf(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

/** "Every 2 hours", "Mondays and Fridays at 09:00", "Once, at …", "When “Leads” changes", "When a hook receives an
 * event": a routine file's trigger. */
function routineWhen(parse: Readonly<Record<string, unknown>>): string {
	const trigger = (parse.trigger ?? {}) as Record<string, unknown>;
	const every = (minutes: unknown) =>
		typeof minutes !== "number"
			? ""
			: minutes % 1440 === 0
				? minutes === 1440
					? "Every day"
					: `Every ${minutes / 1440} days`
				: minutes % 60 === 0
					? minutes === 60
						? "Every hour"
						: `Every ${minutes / 60} hours`
					: `Every ${minutes} minutes`;
	const days = (value: unknown) =>
		Array.isArray(value)
			? value
					.filter((day): day is string => typeof day === "string")
					.map((day) => `${day.charAt(0).toUpperCase()}${day.slice(1)}s`)
					.join(", ")
			: "";
	const words =
		trigger.when === "every"
			? every(trigger.minutes)
			: trigger.when === "weekly"
				? `${days(trigger.days)} at ${String(trigger.time ?? "")}`
				: trigger.when === "window"
					? `${every(trigger.minutes)} from ${String(trigger.from ?? "")} to ${String(trigger.to ?? "")}`
					: trigger.when === "once" && typeof trigger.after === "string"
						? `When ${cloudActionListened(trigger.after)} is done, at the latest ${String(trigger.at ?? "")}`
						: trigger.when === "once"
							? `Once, at ${String(trigger.at ?? "")}`
							: trigger.when === "file-change" && typeof trigger.watch === "string"
								? trigger.match === "subtree"
									? `When anything in “${cloudActionFileName(trigger.watch)}” changes`
									: `When “${cloudActionFileName(trigger.watch)}” changes`
								: trigger.when === "event"
									? cloudActionEventWhen(trigger.only)
									: "";
	return words && typeof parse.timezone === "string" ? `${words} (${parse.timezone})` : words;
}

/** A unit as its change: by the structured file it writes (an agent, a group chat, a routine, an interface, a table),
 * else by its op. `createsAgent` is the proposal's: an active agent.md it parks is a hire when the proposal makes an
 * agent, else an agent made active again (only a new agent.md or a status change is parked). */
function changeOf(unit: CloudCompanyFolderProposalUnit, createsAgent: boolean): Change {
	const byKind = (kind: string) => unit.structured.find((file) => file.kind === kind)?.parse;
	const agent = byKind("agent");
	if (agent) {
		const name = named(agent.name, "an agent");
		if (agent.status === "archived")
			return { text: `Archive the agent “${name}”`, title: "Archive an agent", target: name, details: [] };
		if (!createsAgent)
			return {
				text: `Make the agent “${name}” active again`,
				title: "Make an agent active again",
				target: name,
				details: [],
			};
		const role = named(agent.role, "");
		return {
			text: role ? `Hire “${name}” as ${role}` : `Hire “${name}”`,
			title: "Hire a new agent",
			target: name,
			details: [
				...(role ? [{ key: "role", value: role }] : []),
				...(typeof agent.instructions === "string" && agent.instructions.trim()
					? [{ key: "intent", value: head(agent.instructions, QUOTE_BYTES), quoted: true as const }]
					: []),
			],
			...(typeof agent.id === "string" ? { hires: { id: agent.id, name } } : {}),
		};
	}
	const group = byKind("group");
	if (group) {
		const name = named(group.name, "a group chat");
		return {
			text: `Start the group chat “${name}”`,
			title: "Start a group chat",
			target: name,
			details:
				typeof group.purpose === "string" && group.purpose.trim()
					? [{ key: "purpose", value: head(group.purpose, QUOTE_BYTES) }]
					: [],
		};
	}
	const routine = byKind("routine");
	if (routine) {
		const name = named(routine.title, "a routine");
		const schedule = routineWhen(routine);
		const [text, title] =
			routine.status === "paused"
				? [`Pause the routine “${name}”`, "Pause a routine"]
				: routine.status === "concluded"
					? [`End the routine “${name}”`, "End a routine"]
					: [`Set up or change the routine “${name}”`, "Set up or change a routine"];
		return {
			text,
			title,
			target: name,
			details: [
				...(schedule ? [{ key: "schedule", value: schedule }] : []),
				...(typeof routine.instructions === "string" && routine.instructions.trim()
					? [{ key: "intent", value: head(routine.instructions, QUOTE_BYTES), quoted: true as const }]
					: []),
			],
		};
	}
	for (const [kind, words] of [
		["interface", "interface"],
		["table", "table"],
	] as const) {
		const parse = byKind(kind);
		if (parse) {
			const name = named(parse.name, `a ${words}`);
			return {
				text: `Set up or change the ${words} “${name}”`,
				title: `Set up or change ${kind === "interface" ? "an interface" : "a table"}`,
				target: name,
				details:
					typeof parse.about === "string" && parse.about.trim()
						? [{ key: "about", value: head(parse.about, QUOTE_BYTES) }]
						: [],
			};
		}
	}
	const name = cloudActionFileName(unit.path);
	const parent = parentOf(unit.path);
	if (unit.op === "delete")
		return {
			text: parent ? `Delete “${name}” from “${cloudActionFileName(parent)}”` : `Delete “${name}”`,
			title: "Delete from the Company File",
			target: name,
			details: [],
		};
	if (unit.op === "move" && unit.to !== null)
		return {
			text:
				parentOf(unit.to) === parent
					? renamed(unit.path, unit.to)
					: `Move “${name}” to “${parentOf(unit.to) ? cloudActionFileName(parentOf(unit.to)) : "the top of the Company File"}”`,
			title: "Move in the Company File",
			target: name,
			details: [],
		};
	return { text: `Change “${name}”`, title: "Change the Company File", target: name, details: [] };
}

/** A rename's words: the names as people say them, or the file names themselves when those read the same (7 November
 * 2026: Blender's room.blend to room.blend1 read "Rename “Room” to “Room”"). */
function renamed(from: string, to: string): string {
	const said = [cloudActionFileName(from), cloudActionFileName(to)];
	if (said[0] !== said[1]) return `Rename “${said[0]}” to “${said[1]}”`;
	const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
	return `Rename “${base(from)}” to “${base(to)}”`;
}

/** A path as the context shows it. */
function shownPath(path: string): string {
	return head(path, PATH_BYTES);
}

/** Whether applying it may change the company's pages or tables (Interfaces I10): a path it names, or where it moves
 * one, is under QorperaOS/interfaces/ or QorperaOS/tables/, or is one of them. An apply reads the proposal whole
 * (`#whole`). */
function touchesInterfaces(proposal: CloudCompanyFolderProposal): boolean {
	return proposal.units.some((unit) =>
		[unit.path, unit.to].some(
			(path) => path !== null && /^(?:interfaces|tables)(?:\/|$)/.test(osRelative(companyPathKey(path)) ?? ""),
		),
	);
}

/** The open proposals one run listed when its turn started, and the two tools that act on them. */
export class CloudFolderProposals {
	readonly #folder: CloudCompanyFolderClient;
	readonly #page: CloudCompanyFolderProposalPage;
	readonly #listed: ReadonlyMap<string, CloudCompanyFolderProposal>;

	constructor(options: { folder: CloudCompanyFolderClient; page: CloudCompanyFolderProposalPage }) {
		this.#folder = options.folder;
		this.#page = options.page;
		this.#listed = new Map(options.page.proposals.map((proposal) => [proposal.proposalId, proposal]));
	}

	/** The first page of the run's open proposals, or none: a run that cannot raise a card has none to list, and a list
	 * that fails never fails the run. */
	static async list(folder: CloudCompanyFolderClient, signal: AbortSignal): Promise<CloudFolderProposals | undefined> {
		const page = await folder.agentProposals({}, signal).catch(() => undefined);
		return page && page.proposals.length > 0 ? new CloudFolderProposals({ folder, page }) : undefined;
	}

	/** What the run's context shows: each proposal as its changes, with the paths for the agent. */
	get context(): JsonValue {
		return {
			waiting: this.#page.proposals.map((proposal) => {
				const shown = proposal.units.slice(0, CONTEXT_CHANGES);
				return {
					proposalId: proposal.proposalId,
					savedAt: proposal.createdAt,
					savedFrom: SAVED_FROM[proposal.viewKind] ?? "a computer",
					changes: shown.map((unit) => ({
						change: changeOf(unit, proposal.createsAgent).text,
						path: shownPath(unit.path),
						...(unit.to === null ? {} : { to: shownPath(unit.to) }),
					})),
					...(proposal.unitCount > shown.length ? { moreChanges: proposal.unitCount - shown.length } : {}),
				};
			}),
			...(this.#page.moreProposals > 0 ? { moreWaiting: this.#page.moreProposals } : {}),
		};
	}

	/** Every path the listed proposals name, with the authority the list was decided on: the run releases them with the
	 * context that shows them, before its first model request, so a grant revoked since fences the run. */
	get reads(): readonly CloudCompanyFolderRelease[] {
		return this.#page.proposals.flatMap((proposal) => proposal.reads);
	}

	/** The listed proposal a call names: its parsed arguments carry the id. */
	#proposal(value: JsonValue): CloudCompanyFolderProposal {
		const id = (value as { proposalId?: unknown } | null)?.proposalId;
		const proposal = typeof id === "string" ? this.#listed.get(id) : undefined;
		if (!proposal) throw new Error("Proposal call does not name a listed proposal");
		return proposal;
	}

	/** A call's exact arguments, closed: the id as listed, which the digest covers. */
	#parse(value: JsonValue): CloudCompanyFolderProposal {
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => key !== "proposalId") ||
			// The kernel writes a proposal's id in lower case, and the digest it checks covers it that way.
			!isUuid(value.proposalId)
		)
			throw new CloudToolArgumentRefusal("proposalId must be the id of a listed proposal, exactly as listed");
		const proposal = this.#listed.get(value.proposalId);
		if (!proposal) throw new CloudToolArgumentRefusal("proposalId is not one of the proposals listed in this run");
		return proposal;
	}

	/** A proposal the review can read in full: the list carries each one's first changes, and one with more is never
	 * applied here, since its review would judge a part of what it applies. */
	#whole(proposal: CloudCompanyFolderProposal): CloudCompanyFolderProposal {
		if (proposal.moreUnits > 0 || proposal.units.length !== proposal.unitCount)
			throw new CloudToolArgumentRefusal(
				"This proposal has more changes than its review can read in full, so it cannot be applied here. Discard it if it is no longer wanted, or tell the member",
			);
		return proposal;
	}

	/** Everything an apply would change, as the automatic review reads it beside the card: each change, with its files'
	 * whole parses, which the card cuts. A proposal listed only in part has none. */
	contents(proposal: CloudCompanyFolderProposal): JsonValue {
		const whole = this.#whole(proposal);
		return {
			proposalId: whole.proposalId,
			savedFrom: whole.viewKind,
			createsAgent: whole.createsAgent,
			changes: whole.units.map((unit) => ({
				op: unit.op,
				path: unit.path,
				...(unit.to === null ? {} : { to: unit.to }),
				...(unit.items === null ? {} : { items: unit.items }),
				...(unit.contains.length > 0
					? {
							contains: unit.contains.map(({ path, kind, target }) =>
								target === undefined ? { path, kind } : { path, kind, target },
							),
						}
					: {}),
				...(unit.structured.length > 0
					? { files: unit.structured.map(({ path, kind, parse }) => ({ path, kind, parse })) }
					: {}),
			})),
		} as unknown as JsonValue;
	}

	/** What the card shows, and the review reads beside the contents: the changes, in order, never their files. */
	card(proposal: CloudCompanyFolderProposal): JsonValue {
		const from = SAVED_FROM[proposal.viewKind] ?? "a computer";
		const saved: CardDetail = {
			key: "saved",
			value: `Saved earlier from ${from}; nothing of it applies until this is allowed`,
		};
		const changes = proposal.units.map((unit) => changeOf(unit, proposal.createsAgent));
		const only = proposal.unitCount === 1 ? changes[0] : undefined;
		const shown = changes.slice(0, CARD_CHANGES);
		// The rest, counted: past the card's list, and past the list's own page (`moreUnits`).
		const more = proposal.unitCount - shown.length;
		const details: CardDetail[] = only
			? [...only.details, saved]
			: [
					saved,
					...shown.map((change, index) => ({ key: `change ${index + 1}`, value: change.text })),
					...(more > 0 ? [{ key: "more", value: `${more} more ${more === 1 ? "change" : "changes"}` }] : []),
					// Each change's own text, as a member reads it before deciding: the first quote is the card's.
					...shown.flatMap((change, index) =>
						change.details
							.filter((detail) => detail.quoted)
							.map((detail) => ({
								...detail,
								key: index === 0 ? detail.key : `${detail.key} (change ${index + 1})`,
							})),
					),
				];
		return {
			proposalId: proposal.proposalId,
			effect: proposal.effect,
			title: only?.title ?? `Apply ${proposal.unitCount} changes saved from ${from}`,
			target: only?.target ?? null,
			details: details.map((detail) => ({ ...detail })) as unknown as JsonValue,
		};
	}

	tools(operations: CloudNativeToolOperations): CloudNativeTool[] {
		const proposalId = {
			type: "object",
			additionalProperties: false,
			required: ["proposalId"],
			properties: { proposalId: { type: "string", pattern: UUID_PATTERN.source } },
		} satisfies { [key: string]: JsonValue };
		return [
			{
				name: "apply_proposal" satisfies CloudRuntimeToolOperation,
				source: "runtime",
				description:
					"Apply one of the changes listed in proposals: changes you saved from a computer that need a review before they take effect. It is reviewed like any action, so it may wait for a member's approval on a card; once allowed, its changes are saved. A file that changed since you saved it keeps its current version, and that change is not applied. Use it only for changes that are still wanted, with the proposalId exactly as listed.",
				inputSchema: proposalId,
				parseArguments: (value) => this.card(this.#whole(this.#parse(value))),
				reviewContents: (value) => this.contents(this.#proposal(value)),
				refused: cloudFolderRefusal,
				execute: (value, context) => this.#apply(this.#proposal(value), operations, context),
				denied: (value, context) => this.#decline(this.#proposal(value), context),
			},
			{
				name: "discard_proposal" satisfies CloudRuntimeToolOperation,
				source: "runtime",
				description:
					"Drop one of the changes listed in proposals when it is no longer wanted: none of its changes is applied, and it cannot be undone. Use the proposalId exactly as listed.",
				inputSchema: proposalId,
				parseArguments: (value) => ({ proposalId: this.#parse(value).proposalId }),
				execute: (value, context) => this.#discard(this.#proposal(value), context),
			},
		];
	}

	async #apply(
		proposal: CloudCompanyFolderProposal,
		operations: CloudNativeToolOperations,
		context: CloudToolContext,
	): Promise<CloudToolContent> {
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"Applying saved changes needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		// The review of the proposal's own units, before the receipt: a proposal decided since the list is a refusal.
		const reviewId = await this.#folder.recordProposalReview(
			{ actionReviewId, argumentSha256: context.argumentSha256 },
			proposal,
			context.signal,
		);
		if (reviewId === null) {
			// The repeat of a call that applied it but whose note failed (below) ends here: it notes what that one missed.
			if (touchesInterfaces(proposal)) await this.#folder.noteInterfaceChanges(context.signal);
			throw new CloudToolRefusal(NOT_WAITING);
		}
		const { proposalId } = proposal;
		const content = await operations.execute({
			operation: {
				tool: "apply_proposal",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `apply:${proposalId}`,
				arguments: { proposalId },
				target: { proposalId },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			refused: cloudFolderRefusal,
			perform: async (_operation, { receiptId, signal }) => {
				const committed = await this.#folder.applyProposal(
					`apply-proposal:${proposalId}`,
					proposal,
					{ reviewId, receiptId },
					signal,
				);
				// Decided or erased after the review was recorded: the kernel cancelled this call's receipt, nothing applied.
				if ("unapplied" in committed)
					throw new CloudToolOperationSettled(receiptId, new CloudToolRefusal(NOT_WAITING));
				return {
					content: { kind: "text", value: applied(proposal, receiptId, committed) },
					folderCommitId: committed.commitId,
				};
			},
			signal: context.signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		// A change of the company's pages and tables shows in the run's conversation, with Undo (Interfaces I10), even
		// from a run with no computer: SQL notes each of the run's commits there once, a replay's too. Its failure is a
		// folder error, never a refusal, so the call is unconfirmed; its repeat finds the proposal applied, and notes it.
		if (touchesInterfaces(proposal)) await this.#folder.noteInterfaceChanges(context.signal);
		return content;
	}

	async #decline(
		proposal: CloudCompanyFolderProposal,
		context: CloudToolContext & { readonly actionReviewId: string },
	): Promise<string> {
		const status = await this.#folder.closeProposal(proposal.proposalId, context.actionReviewId, context.signal);
		return status === "declined"
			? "These saved changes are now closed as declined: none of them was applied, and they are not offered again, so do not repeat this call. If the member still wants one of the changes, make it with the tool made for it."
			: "";
	}

	async #discard(proposal: CloudCompanyFolderProposal, context: CloudToolContext): Promise<CloudToolContent> {
		const status = await this.#folder.closeProposal(proposal.proposalId, undefined, context.signal);
		return {
			kind: "text",
			value: cloudToolJsonText({
				schema: "qorpera.folder-proposal-close/v1",
				proposalId: proposal.proposalId,
				status: status ?? "unavailable",
				next:
					status === "discarded"
						? "Dropped: none of its changes was applied."
						: status === null
							? NOT_WAITING
							: `It was already decided (${status.replace("_", " ")}); nothing changed now.`,
			}),
		};
	}
}

/** The apply's answer for the model: what was saved, what was not and why, and who was hired. */
function applied(proposal: CloudCompanyFolderProposal, receiptId: string, committed: CloudCompanyFolderCommitResult) {
	// Every change refused for review: the proposal was decided or erased while the apply waited for it.
	if (
		committed.units.length > 0 &&
		committed.units.every((unit) => unit.outcome === "denied" && unit.reason === "review_required")
	)
		return cloudToolJsonText({
			schema: "qorpera.folder-proposal-apply/v1",
			proposalId: proposal.proposalId,
			receiptId,
			outcome: "not_applied",
			saved: 0,
			next: NOT_WAITING,
		});
	const saved = committed.units.filter((unit) => unit.outcome === "saved");
	const unsaved = committed.units.filter((unit) => unit.outcome !== "saved");
	const hired = committed.units.flatMap((unit) => {
		const listed = proposal.units[unit.unit - 1];
		const hires = unit.outcome === "saved" && listed ? changeOf(listed, proposal.createsAgent).hires : undefined;
		return hires ? [hires] : [];
	});
	return cloudToolJsonText({
		schema: "qorpera.folder-proposal-apply/v1",
		proposalId: proposal.proposalId,
		receiptId,
		outcome: saved.length > 0 ? "applied" : "not_applied",
		saved: saved.length,
		...(unsaved.length
			? {
					notSaved: unsaved.slice(0, RESULT_UNITS).map((unit) => ({
						path: shownPath(unit.path),
						...(unit.to === null ? {} : { to: shownPath(unit.to) }),
						outcome: unit.outcome,
						...(unit.reason ? { reason: unit.reason } : {}),
						...(unit.problems.length
							? { problems: unit.problems.slice(0, 3).map((problem) => head(problem.message, 200)) }
							: {}),
					})),
					...(unsaved.length > RESULT_UNITS ? { moreNotSaved: unsaved.length - RESULT_UNITS } : {}),
				}
			: {}),
		...(hired.length ? { hired } : {}),
		next: [
			unsaved.length === 0
				? "The changes are saved."
				: "The changes in notSaved were not applied: a path that changed since you saved it keeps its current version (where a file's text differed, your version is kept beside it as a conflict copy). Read the current files and make a change that is still wanted again with the tool made for it.",
			...(hired.length
				? [
						"A hired agent starts on its first todo by itself, usually within a minute; message it only if it has not begun after a few minutes.",
					]
				: []),
			"Tell the member what was applied, in plain words.",
		].join(" "),
	});
}
