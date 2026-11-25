import { createHash } from "node:crypto";
import {
	type AgentFigure,
	type AgentFile,
	COMPANY_STATE_FILE_MAX_BYTES,
	COMPANY_STATE_RESERVED_AGENT_NAMES,
	freeCompanyStateName,
	isCompanyStateName,
	osPath,
	parseCompanyStateFile,
	setCompanyStateSettings,
	writeAgentFile,
	writeTodoFile,
} from "@qorpera/cloud-client/company-state-files";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderFileEntry,
	type CloudCompanyFolderUnit,
	sha256Hex,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/*
 * `hire_agent` as a thin writer of a folder-v2 company's agent folders (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2 "agent.md", §5; RUNTIME-COMPANY-FOLDER-C2.md §4): one `new_folder` unit `QorperaOS/agents/<handle>` holding
 * `agent.md`, the agent's folders, and its first assignment as an open todo. The folder core's commit decides it and
 * indexes the new agent in the same transaction. A new agent folder is delegation, so the save carries the automatic
 * review's approval of this call, recorded for exactly these units (C2 R1).
 *
 * The files are checked with the arguments, before the automatic review (`check`), so a card is never raised for a
 * hire that cannot be saved. Every other check that can refuse runs before the receipt: a begun receipt that ends in
 * an error holds the run's other operations until it is resolved. The ids come from the run and the operation key.
 * The handle comes from a listing taken before the receipt and may differ on a rebuilt call; the receipt's target is
 * the agent's id, so a call that already completed replays its stored result.
 *
 * Contract 14.1 (20260929940000): an agent that cannot delegate the new agent's default access hires only on an
 * owner's or admin's answer to the review's card; the kernel's layering asks for it and the recorder checks again.
 *
 * `end_role` (the company's reading of itself, 20260930766000) is the other end of a hire: one `write` unit that sets an
 * agent's agent.md to `status: archived`, over the version read. A status change is delegation, so the save carries the
 * automatic review's approval of the call, as a hire's does. The agent is read before the review (`prepareEndRole`),
 * which refuses the Co-Founder, the calling agent and a handle that is no agent's folder, and gives the card the agent's
 * name. An agent already archived is told apart by the call's receipt (reviews r1 and r2 of #1819), looked up read
 * only (`runReceiptExists`) before the review and again before the receipt: with one, the call is a repeat of a call
 * that archived it, and goes on to its receipt, which replays its stored answer, in this run or a resumed one; with
 * none, it is a new call on a role that has already ended, refused before the review with no receipt and no commit.
 * Once archived, the folder core's follow-up pauses its routines, revokes its access and closes its threads; its files
 * stay, and a member who sets it active again brings it back.
 */

const TOOL_VERSION = "folder-v2/1";
/** A todo's title is one line of at most 200 bytes (§2 "todo"). */
const TITLE_BYTES = 200;
/** The folders a seeded agent has (the Co-Founder's in the seeded tree). */
const AGENT_FOLDERS = ["memory", "skills", "routines", "todos"] as const;
const FIRST_TODO = "todos/first-assignment.md";
/** The agent folder listing this writer reads, at most: far beyond any company's roster. */
const MAX_AGENTS = 10_000;

export interface CloudFolderHire {
	readonly operationKey: string;
	readonly name: string;
	readonly role: string;
	readonly jobDescription: string;
	readonly firstAssignment: string;
	readonly figure: AgentFigure;
}

export type CloudFolderTeamMember = Omit<CloudFolderHire, "operationKey">;

export interface CloudFolderTeamHire {
	readonly operationKey: string;
	readonly hires: readonly CloudFolderTeamMember[];
}

export const TEAM_HIRES_MIN = 2;
export const TEAM_HIRES_MAX = 12;

const teamKey = (operationKey: string, index: number) => `${operationKey}:${index}`;

function agentUnit(root: string, files: { agent: string; todo: string }): CloudCompanyFolderUnit {
	return {
		op: "new_folder",
		path: root,
		contents: [
			{ path: "agent.md", kind: "file", content: { text: files.agent, mediaType: "text/markdown" } },
			...AGENT_FOLDERS.map((path) => ({ path, kind: "folder" as const })),
			{ path: FIRST_TODO, kind: "file", content: { text: files.todo, mediaType: "text/markdown" } },
		],
	};
}

function sameName(name: string): string {
	return name.trim().normalize("NFC").toLocaleLowerCase("en");
}

function plainMessage(message: string): string {
	return message.replace(/[^\u0020-\u007e\u00c0-\u00ff]/g, "-");
}

/** One id per (namespace, run, operation key), formatted as the legacy hire's agent id (cloud-hiring-tools.ts), in a
 * namespace of its own so it never meets the legacy hire's or a group chat's. */
export function hashedId(namespace: string, runId: string, operationKey: string): string {
	const hex = createHash("sha256").update(`${namespace}:${runId}:${operationKey}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The first assignment's first line, as one line of at most 200 bytes, for the todo's title. */
function titleOf(assignment: string): string {
	const line = (assignment.split(/\r?\n/).find((item) => item.trim()) ?? "")
		// A title is one line without control characters.
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	let title = "";
	for (const character of line) {
		if (Buffer.byteLength(title + character) > TITLE_BYTES) break;
		title += character;
	}
	return title.trim() || "First assignment";
}

/** What the shared parser found, within the boundary's plain one-kilobyte message. */
export function invalidMessage(
	problems: readonly { message: string }[],
	opening = "This hire cannot be saved as the company's files",
): string {
	let message = opening;
	for (const problem of problems) {
		const next = `${message}${message.includes(":") ? ";" : ":"} ${problem.message}`;
		if (Buffer.byteLength(next) > 900) break;
		message = next;
	}
	return message;
}

/** The new agent's two files, for a handle and ids. */
function hireFiles(request: CloudFolderTeamMember, agentId: string, todoId: string, requesterUserId: string) {
	return {
		agent: writeAgentFile({
			id: agentId,
			name: request.name,
			role: request.role,
			agentKind: "agent",
			status: "active",
			colour: null,
			figure: request.figure,
			model: null,
			effort: null,
			instructions: request.jobDescription,
		}),
		todo: writeTodoFile({
			id: todoId,
			title: titleOf(request.firstAssignment),
			status: "open",
			requestedBy: requesterUserId,
			detail: request.firstAssignment,
		}),
	};
}

/** The parser's problems with the two files at a handle. */
function problemsOf(root: string, files: { agent: string; todo: string }): { message: string }[] {
	const problems: { message: string }[] = [];
	for (const [path, text] of [
		[`${root}/agent.md`, files.agent],
		[`${root}/${FIRST_TODO}`, files.todo],
	] as const) {
		const parsed = parseCompanyStateFile(path, text);
		if (!parsed) problems.push({ message: `${path} is not a company state file` });
		else if (!parsed.ok) problems.push(...parsed.problems);
	}
	return problems;
}

const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

export interface CloudFolderRoleEnd {
	readonly operationKey: string;
	/** The agent's handle, its folder name under QorperaOS/agents. */
	readonly agent: string;
	/** One sentence a founder reads. */
	readonly reason: string;
}

/** An end of a role's logical operation key, as its receipt is kept under it (with the tool's name before it). */
const endRoleKey = (request: CloudFolderRoleEnd) => `end-role:${request.operationKey}`;

/** An agent's file as an end of its role reads it, or a refusal the model can act on: no agent's folder, the
 * Co-Founder, the calling agent. Read before the review and again before the receipt; none of these changes when the
 * call's own archive lands, so a repeated call still reaches its receipt. An archived agent is not refused here: only
 * a call with no receipt is (`#refuseEnded`). */
async function roleOf(
	folder: CloudCompanyFolderClient,
	identity: CloudNativeToolIdentity,
	handle: string,
	signal: AbortSignal,
): Promise<{ entry: CloudCompanyFolderFileEntry; text: string; agent: AgentFile; path: string }> {
	const path = osPath(`agents/${handle}/agent.md`);
	const none = () =>
		new CloudToolRefusal(`No agent has the folder ${osPath(`agents/${handle}`)}: agent is its folder name there`);
	if (!isCompanyStateName(handle) || (COMPANY_STATE_RESERVED_AGENT_NAMES as readonly string[]).includes(handle))
		throw none();
	let found: Awaited<ReturnType<CloudCompanyFolderClient["readText"]>>;
	try {
		found = await folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
	} catch (error) {
		if (error instanceof CloudCompanyPathNotText) throw none();
		throw error;
	}
	const parsed = found ? parseCompanyStateFile(path, found.text) : null;
	if (!found || !parsed?.ok || parsed.file.kind !== "agent") throw none();
	const agent = parsed.file;
	if (agent.agentKind === "co-founder") throw new CloudToolRefusal("The Co-Founder's role does not end");
	if (agent.id === identity.staffAgentId) throw new CloudToolRefusal("An agent does not end its own role");
	return { entry: found.entry, text: found.text, agent, path };
}

/** Hires agents as folders of the company. */
export class CloudFolderHiring {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
	}

	/** The files' own checks, which need no reads: with the arguments, before the automatic review. The handle and the
	 * ids are placeholders; the real ones cannot add a problem (the handle is a free folder name). */
	check(request: CloudFolderHire): void {
		const problems = problemsOf(
			osPath("agents/agent"),
			hireFiles(request, PLACEHOLDER_ID, PLACEHOLDER_ID, this.#identity.requesterUserId),
		);
		if (problems.length) throw new CloudToolArgumentRefusal(invalidMessage(problems));
	}

	/** An archived agent's role, for a call with no receipt under its key: a new call on a role that has already ended,
	 * refused before anything begins. A repeat of a call that archived it has a receipt and goes on to it. */
	async #refuseEnded(request: CloudFolderRoleEnd, agent: AgentFile, signal: AbortSignal): Promise<void> {
		if (agent.status !== "archived") return;
		// The operations layer's key for this call (`<tool>:<logicalOperationKey>`, cloud-native-tool-operations.ts).
		if (!(await this.#folder.runReceiptExists(`end_role:${endRoleKey(request)}`, signal)))
			throw new CloudToolRefusal(`${agent.name}'s role has already ended`);
	}

	/** What ending a role changes, read before the automatic review: the request with the agent's name, for its card, and
	 * `ended` for a repeat of a call that already archived it. A new call on a role that has already ended is refused. */
	async prepareEndRole(
		request: CloudFolderRoleEnd,
		signal: AbortSignal,
	): Promise<CloudFolderRoleEnd & { readonly name: string; readonly ended?: true }> {
		const role = await roleOf(this.#folder, this.#identity, request.agent, signal);
		await this.#refuseEnded(request, role.agent, signal);
		return {
			...request,
			name: role.agent.name,
			...(role.agent.status === "archived" ? { ended: true as const } : {}),
		};
	}

	async endRole(request: CloudFolderRoleEnd, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"Ending a role needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		const role = await roleOf(this.#folder, this.#identity, request.agent, signal);
		// Archived meanwhile, by another call: refused before the receipt as in prepare. A repeat goes on to its receipt.
		await this.#refuseEnded(request, role.agent, signal);
		const name = role.agent.name;
		const folder = osPath(`agents/${request.agent}`);
		const units: CloudCompanyFolderUnit[] = [
			{
				op: "write",
				path: role.path,
				content: { text: setCompanyStateSettings(role.text, { status: "archived" }), mediaType: "text/markdown" },
				expectedVersion: role.entry.version,
			},
		];
		return this.#operations.execute({
			operation: {
				tool: "end_role",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: endRoleKey(request),
				arguments: { agent: request.agent, reason: request.reason },
				target: { agentId: role.agent.id },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId = await this.#folder.recordReview(
					{ actionReviewId, tool: "end_role", argumentSha256: context.argumentSha256 },
					staged,
					performSignal,
				);
				const committed = await this.#folder.commitStaged(
					`end-role:${request.operationKey}`,
					staged,
					{ reviewId, receiptId },
					performSignal,
				);
				const saved = committed.units[0];
				if (!saved) throw new Error("Company folder commit answered no unit");
				const output = cloudToolJsonText({
					schema: "qorpera.agent-role-end-receipt/v1",
					runId: this.#identity.runId,
					receiptId,
					outcome: saved.outcome,
					...(saved.reason ? { reason: saved.reason } : {}),
					...(saved.problems.length ? { problems: saved.problems } : {}),
					agent: { id: role.agent.id, name, folder },
					next:
						saved.outcome === "saved"
							? `${name}'s role has ended. The platform now pauses its routines and closes its threads by itself; its files stay, and a member can bring it back. Tell the founders who and why.`
							: saved.outcome === "conflict"
								? `${folder}/agent.md changed since it was read: read it again and call once more with a new operationKey.`
								: saved.outcome === "waiting_for_review"
									? "Ending the role waits for a member's approval: do not call again; tell the member it is waiting for them."
									: "Nothing changed: say why to the member, or correct the call and repeat it with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	async hire(request: CloudFolderHire, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"A hire needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		const runId = this.#identity.runId;
		const agentId = hashedId("qorpera.folder-hire/v1", runId, request.operationKey);
		const files = hireFiles(
			request,
			agentId,
			hashedId("qorpera.folder-hire-todo/v1", runId, request.operationKey),
			this.#identity.requesterUserId,
		);
		// The handle: the name as a folder name, numbered past the names taken (§1 "Names").
		const listing = await this.#folder.listAll(osPath("agents"), { maxEntries: MAX_AGENTS }, signal);
		const taken = new Set<string>(COMPANY_STATE_RESERVED_AGENT_NAMES);
		for (const entry of listing.entries) taken.add((entry.path.split("/").at(-1) ?? "").toLowerCase());
		const handle = freeCompanyStateName(request.name, "agent", taken);
		const root = osPath(`agents/${handle}`);
		const problems = problemsOf(root, files);
		if (problems.length) throw new CloudToolRefusal(invalidMessage(problems));
		const units: CloudCompanyFolderUnit[] = [agentUnit(root, files)];
		return this.#operations.execute({
			operation: {
				tool: "hire_agent",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `hire:${request.operationKey}`,
				arguments: {
					name: request.name,
					role: request.role,
					jobDescription: request.jobDescription,
					firstAssignment: request.firstAssignment,
					figure: request.figure,
				},
				target: { agentId },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId = await this.#folder.recordReview(
					{ actionReviewId, tool: "hire_agent", argumentSha256: context.argumentSha256 },
					staged,
					performSignal,
				);
				const committed = await this.#folder.commitStaged(
					`hire-folder:${request.operationKey}`,
					staged,
					{ reviewId, receiptId },
					performSignal,
				);
				const saved = committed.units[0];
				if (!saved) throw new Error("Company folder commit answered no unit");
				const output = cloudToolJsonText({
					schema: "qorpera.agent-hire-receipt/v2",
					runId,
					receiptId,
					outcome: saved.outcome,
					...(saved.reason ? { reason: saved.reason } : {}),
					...(saved.problems.length ? { problems: saved.problems } : {}),
					agent: { id: agentId, name: request.name, role: request.role, folder: root },
					next:
						saved.outcome === "saved"
							? `${request.name} is hired. The first assignment is an open todo in ${root}/todos, and the platform starts ${request.name} on it by itself, usually within a minute: no start message is needed. Tell the member who you hired and why. To give ${request.name} more than the assignment says, or if ${request.name} has not begun after a few minutes, use send_coworker_message with priority true (recipientStaffId ${agentId}); a message sent while ${request.name} is still starting waits for it.`
							: saved.outcome === "conflict"
								? `${root} is taken: call again with a new operationKey, and if this repeats, choose a slightly different name.`
								: saved.outcome === "waiting_for_review"
									? "The hire waits for a member's approval: do not hire again; tell the member it is waiting for them."
									: "Nothing was hired: say why to the member, or correct the arguments and call again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	checkTeam(request: CloudFolderTeamHire): void {
		const seen = new Map<string, number>();
		for (const [index, hire] of request.hires.entries()) {
			const earlier = seen.get(sameName(hire.name));
			if (earlier !== undefined)
				throw new CloudToolArgumentRefusal(
					`hire ${index + 1}: name is the same as hire ${earlier + 1}'s: name each by its own work, and never a name a coworker already has`,
				);
			seen.set(sameName(hire.name), index);
		}
		const problems = request.hires.flatMap((hire, index) =>
			problemsOf(
				osPath("agents/agent"),
				hireFiles(hire, PLACEHOLDER_ID, PLACEHOLDER_ID, this.#identity.requesterUserId),
			).map((problem) => ({ message: `hire ${index + 1}: ${problem.message}` })),
		);
		if (problems.length)
			throw new CloudToolArgumentRefusal(
				plainMessage(invalidMessage(problems, "This team cannot be saved as the company's files")),
			);
	}

	async hireTeam(request: CloudFolderTeamHire, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"A hire needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		if (request.hires.length < TEAM_HIRES_MIN || request.hires.length > TEAM_HIRES_MAX)
			throw new Error("Invalid team hire");
		const runId = this.#identity.runId;
		const listing = await this.#folder.listAll(osPath("agents"), { maxEntries: MAX_AGENTS }, signal);
		const taken = new Set<string>(COMPANY_STATE_RESERVED_AGENT_NAMES);
		for (const entry of listing.entries) taken.add((entry.path.split("/").at(-1) ?? "").toLowerCase());
		const team = request.hires.map((hire, index) => {
			const agentId = hashedId("qorpera.folder-hire-team/v1", runId, teamKey(request.operationKey, index));
			const handle = freeCompanyStateName(hire.name, "agent", taken);
			taken.add(handle.toLowerCase());
			const root = osPath(`agents/${handle}`);
			const files = hireFiles(
				hire,
				agentId,
				hashedId("qorpera.folder-hire-team-todo/v1", runId, teamKey(request.operationKey, index)),
				this.#identity.requesterUserId,
			);
			return { hire, agentId, root, files };
		});
		const problems = team.flatMap(({ hire, root, files }) =>
			problemsOf(root, files).map((problem) => ({ message: `${hire.name}: ${problem.message}` })),
		);
		if (problems.length)
			throw new CloudToolRefusal(invalidMessage(problems, "This team cannot be saved as the company's files"));
		const units = team.map(({ root, files }) => agentUnit(root, files));
		return this.#operations.execute({
			operation: {
				tool: "hire_team",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `hire-team:${request.operationKey}`,
				arguments: {
					hires: request.hires.map((hire) => ({
						name: hire.name,
						role: hire.role,
						figure: hire.figure,
						jobDescriptionSha256: sha256Hex(Buffer.from(hire.jobDescription)),
						firstAssignmentSha256: sha256Hex(Buffer.from(hire.firstAssignment)),
					})),
				},
				target: { agentIds: team.map(({ agentId }) => agentId) },
				requiresCompanyRevision: true,
			},
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId = await this.#folder.recordReview(
					{ actionReviewId, tool: "hire_team", argumentSha256: context.argumentSha256 },
					staged,
					performSignal,
				);
				const committed = await this.#folder.commitStaged(
					`hire-team-folder:${request.operationKey}`,
					staged,
					{ reviewId, receiptId },
					performSignal,
				);
				if (committed.units.length !== team.length) throw new Error("Company folder commit answered other units");
				const hires = team.map(({ hire, agentId, root }, index) => {
					const saved = committed.units[index]!;
					return {
						id: agentId,
						name: hire.name,
						role: hire.role,
						folder: root,
						outcome: saved.outcome,
						...(saved.reason ? { reason: saved.reason } : {}),
						...(saved.problems.length ? { problems: saved.problems.slice(0, 5) } : {}),
					};
				});
				const hired = hires.filter((hire) => hire.outcome === "saved");
				const missed = hires.filter((hire) => hire.outcome !== "saved");
				const outcome = !missed.length ? "saved" : hired.length ? "partly_saved" : hires[0]!.outcome;
				const output = cloudToolJsonText({
					schema: "qorpera.agent-team-hire-receipt/v1",
					runId,
					receiptId,
					outcome,
					hires,
					next: teamNext(outcome, hired, missed),
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}
}

function names(items: readonly { name: string }[]): string {
	const all = items.map((item) => item.name);
	return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : (all[0] ?? "");
}

function teamNext(
	outcome: string,
	hired: readonly { name: string }[],
	missed: readonly { name: string; folder: string; reason?: string }[],
): string {
	const starts =
		"the platform starts each on its first assignment (an open todo in its own todos folder) by itself, usually within a minute";
	const after =
		"No start message or introduction is needed. Tell the member who you hired and why. Use send_coworker_message, with priority true, only for one that has not begun after a few minutes or needs more than its assignment says.";
	if (outcome === "saved")
		return `${names(hired)} are hired, together: ${starts}, and each one's first run already lists the whole team as coworkers. ${after}`;
	if (outcome === "partly_saved")
		return `${names(hired)} are hired: ${starts}. ${names(missed)} ${missed.length === 1 ? "was" : "were"} not (${missed.map((hire) => `${hire.name}: ${hire.reason === "exists" ? `${hire.folder} is taken` : (hire.reason ?? "not saved")}`).join("; ")}): hire ${missed.length === 1 ? "it" : "them"} again with a new operationKey (hire_agent for one, hire_team for several), and choose a slightly different name where a folder was taken. ${after}`;
	if (outcome === "conflict") {
		const taken = missed.filter((hire) => hire.reason === "exists").map((hire) => hire.folder);
		return `Nothing was hired: ${taken.length ? `${taken.join(", ")} ${taken.length === 1 ? "was" : "were"} taken meanwhile` : "the team's folders changed meanwhile"}. Call again with a new operationKey, and if this repeats, choose slightly different names.`;
	}
	if (outcome === "waiting_for_review")
		return "The team waits for a member's approval: do not hire again; tell the member it is waiting for them.";
	return "Nothing was hired: say why to the member, or correct the arguments and call again with a new operationKey.";
}
