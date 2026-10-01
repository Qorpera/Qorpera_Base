import { createHash } from "node:crypto";
import {
	type AgentFigure,
	COMPANY_STATE_RESERVED_AGENT_NAMES,
	freeCompanyStateName,
	parseCompanyStateFile,
	writeAgentFile,
	writeTodoFile,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCompanyFolderClient, CloudCompanyFolderUnit } from "./cloud-company-folder-client.ts";
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
 * §2 "agent.md", §5; RUNTIME-COMPANY-FOLDER-C2.md §4): one `new_folder` unit `agents/<handle>` holding `agent.md`, the
 * agent's folders, and its first assignment as an open todo. The folder core's commit decides it and indexes the new
 * agent in the same transaction. A new agent folder is delegation, so the save carries the automatic review's approval
 * of this call, recorded for exactly these units (C2 R1).
 *
 * The files are checked with the arguments, before the automatic review (`check`), so a card is never raised for a
 * hire that cannot be saved. Every other check that can refuse runs before the receipt: a begun receipt that ends in
 * an error holds the run's other operations until it is resolved. The ids come from the run and the operation key.
 * The handle comes from a listing taken before the receipt and may differ on a rebuilt call; the receipt's target is
 * the agent's id, so a call that already completed replays its stored result.
 *
 * Contract 14.1 (20260929940000): an agent that cannot delegate the new agent's default access hires only on an
 * owner's or admin's answer to the review's card; the kernel's layering asks for it and the recorder checks again.
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

/** One id per (namespace, run, operation key), formatted as the legacy hire's agent id (cloud-hiring-tools.ts), in a
 * namespace of its own so it never meets the legacy hire's or a group chat's. */
function hashedId(namespace: string, runId: string, operationKey: string): string {
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
function invalidMessage(problems: readonly { message: string }[]): string {
	let message = "This hire cannot be saved as the company's files";
	for (const problem of problems) {
		const next = `${message}${message.includes(":") ? ";" : ":"} ${problem.message}`;
		if (Buffer.byteLength(next) > 900) break;
		message = next;
	}
	return message;
}

/** The new agent's two files, for a handle and ids. */
function hireFiles(request: CloudFolderHire, agentId: string, todoId: string, requesterUserId: string) {
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
			"agents/agent",
			hireFiles(request, PLACEHOLDER_ID, PLACEHOLDER_ID, this.#identity.requesterUserId),
		);
		if (problems.length) throw new CloudToolArgumentRefusal(invalidMessage(problems));
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
		const listing = await this.#folder.listAll("agents", { maxEntries: MAX_AGENTS }, signal);
		const taken = new Set<string>(COMPANY_STATE_RESERVED_AGENT_NAMES);
		for (const entry of listing.entries) taken.add((entry.path.split("/").at(-1) ?? "").toLowerCase());
		const handle = freeCompanyStateName(request.name, "agent", taken);
		const root = `agents/${handle}`;
		const problems = problemsOf(root, files);
		if (problems.length) throw new CloudToolRefusal(invalidMessage(problems));
		const units: CloudCompanyFolderUnit[] = [
			{
				op: "new_folder",
				path: root,
				contents: [
					{ path: "agent.md", kind: "file", content: { text: files.agent, mediaType: "text/markdown" } },
					...AGENT_FOLDERS.map((path) => ({ path, kind: "folder" as const })),
					{ path: FIRST_TODO, kind: "file", content: { text: files.todo, mediaType: "text/markdown" } },
				],
			},
		];
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
							? `${request.name} is hired. The first assignment is an open todo in ${root}/todos. ${request.name} has not started yet: wake them with send_coworker_message (recipientStaffId ${agentId}), asking them to start on their first todo, and tell the member who you hired and why. If that message cannot be sent, tell the member that ${request.name} has not started.`
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
}
