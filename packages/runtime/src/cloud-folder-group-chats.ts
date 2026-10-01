import {
	COMPANY_STATE_RESERVED_AGENT_NAMES,
	freeCompanyStateName,
	parseCompanyStateFile,
	writeGroupFile,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCompanyFolderClient, CloudCompanyFolderUnit } from "./cloud-company-folder-client.ts";
import { hashedId, invalidMessage } from "./cloud-folder-hiring.ts";
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
 * `create_group_chat` as a thin writer of a folder-v2 company's group chats (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2 "group.md", §5; RUNTIME-COMPANY-FOLDER-C2.md §4): one `new_folder` unit `agents/groups/<handle>` holding
 * `group.md`. Its agents are the run's own agent and the coworkers named; its people the run's requester, unless the
 * call leaves them out (an agent's change may add only that member). The commit opens the chat's room and conversation
 * in the same transaction. A new `group.md` is delegation, so the save carries the automatic review's approval of this
 * call, recorded for exactly this unit (C2 R1).
 *
 * As the hire (cloud-folder-hiring.ts): the file is checked with the arguments, before the review (`check`); every
 * other refusal comes before the receipt; the chat's id comes from the run and the operation key, and the receipt's
 * target is that id, so a call that already completed replays its stored result.
 */

const TOOL_VERSION = "folder-v2/1";
const GROUPS = "agents/groups";
/** The group folder listing this writer reads, at most: far beyond any company's chats. */
const MAX_GROUPS = 10_000;
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

export interface CloudFolderGroupChat {
	readonly operationKey: string;
	readonly name: string;
	readonly purpose: string;
	/** Other agents of the company, sorted; never the run's own agent. */
	readonly coworkerIds: readonly string[];
	readonly includeRequestingMember: boolean;
}

/** Opens group chats as folders of the company. */
export class CloudFolderGroupChats {
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

	#text(request: CloudFolderGroupChat, id: string): string {
		return writeGroupFile({
			id,
			name: request.name,
			subtitle: null,
			agents: [this.#identity.staffAgentId, ...request.coworkerIds],
			people: request.includeRequestingMember ? [this.#identity.requesterUserId] : [],
			purpose: request.purpose,
		});
	}

	#problems(path: string, text: string): readonly { message: string }[] {
		const parsed = parseCompanyStateFile(path, text);
		if (!parsed) return [{ message: `${path} is not a company state file` }];
		return parsed.ok ? [] : parsed.problems;
	}

	/** The file's own checks, which need no reads: with the arguments, before the automatic review. */
	check(request: CloudFolderGroupChat): void {
		const problems = this.#problems(`${GROUPS}/group/group.md`, this.#text(request, PLACEHOLDER_ID));
		if (problems.length)
			throw new CloudToolArgumentRefusal(
				invalidMessage(problems, "This group chat cannot be saved as the company's files"),
			);
	}

	async create(request: CloudFolderGroupChat, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"A group chat needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		const runId = this.#identity.runId;
		const chatId = hashedId("qorpera.folder-group/v1", runId, request.operationKey);
		const text = this.#text(request, chatId);
		// The handle: the name as a folder name, numbered past the names taken (§1 "Names").
		const units: CloudCompanyFolderUnit[] = [];
		const listing = (await this.#folder.read(GROUPS, signal)).entry
			? await this.#folder.listAll(GROUPS, { maxEntries: MAX_GROUPS }, signal)
			: null;
		// The folder core never invents a parent folder.
		if (!listing) units.push({ op: "mkdir", path: GROUPS });
		const taken = new Set<string>(COMPANY_STATE_RESERVED_AGENT_NAMES);
		for (const entry of listing?.entries ?? []) taken.add((entry.path.split("/").at(-1) ?? "").toLowerCase());
		const handle = freeCompanyStateName(request.name, "group", taken);
		const root = `${GROUPS}/${handle}`;
		const problems = this.#problems(`${root}/group.md`, text);
		if (problems.length)
			throw new CloudToolRefusal(invalidMessage(problems, "This group chat cannot be saved as the company's files"));
		units.push({
			op: "new_folder",
			path: root,
			contents: [{ path: "group.md", kind: "file", content: { text, mediaType: "text/markdown" } }],
		});
		return this.#operations.execute({
			operation: {
				tool: "create_group_chat",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `group:${request.operationKey}`,
				arguments: {
					name: request.name,
					purpose: request.purpose,
					coworkerIds: [...request.coworkerIds],
					includeRequestingMember: request.includeRequestingMember,
				},
				target: { chatId },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId = await this.#folder.recordReview(
					{ actionReviewId, tool: "create_group_chat", argumentSha256: context.argumentSha256 },
					staged,
					performSignal,
				);
				const committed = await this.#folder.commitStaged(
					`group-folder:${request.operationKey}`,
					staged,
					{ reviewId, receiptId },
					performSignal,
				);
				const saved = committed.units.at(-1);
				if (!saved) throw new Error("Company folder commit answered no unit");
				const output = cloudToolJsonText({
					schema: "qorpera.group-chat-receipt/v2",
					runId,
					receiptId,
					outcome: saved.outcome,
					...(saved.reason ? { reason: saved.reason } : {}),
					...(saved.problems.length ? { problems: saved.problems } : {}),
					chat: { id: chatId, name: request.name, folder: root },
					next:
						saved.outcome === "saved"
							? `The group chat ${request.name} is open: tell the member its name.`
							: saved.outcome === "conflict"
								? `${root} is taken: call again with a new operationKey, and if this repeats, choose a slightly different name.`
								: saved.outcome === "waiting_for_review"
									? "The group chat waits for a member's approval: do not open it again; tell the member it is waiting for them."
									: "No group chat was opened: say why to the member, or correct the arguments and call again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}
}
