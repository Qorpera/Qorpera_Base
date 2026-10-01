import { createHash } from "node:crypto";
import {
	COMPANY_STATE_FILE_MAX_BYTES,
	parseCompanyStateFile,
	type SectionsFile,
} from "@qorpera/cloud-client/company-state-files";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderFileEntry,
	sha256,
} from "./cloud-company-folder-client.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/*
 * `organize_sidebar` as a thin writer of a folder-v2 company's `agents/sections.md` (deploy/first-node/
 * RUNTIME-COMPANY-STATE-FILES.md §2 "agents/sections.md", §5). The file is the sections, in order, each listing agents
 * and group chats by id; anyone not listed is Unassigned. The folder core's commit decides each save (F2-2's rules:
 * the Co-Founder is refused, an id the save adds must be a current agent or open group chat), under the tool call's
 * receipt.
 *
 * As today, the tool is idempotent by content: a change already in the file saves nothing and says so. Lines before
 * the first section (the company's own notes) are kept as they are; the sections are written back in the seeded form,
 * each line an id and the words after it only for reading.
 */

const PATH = "agents/sections.md";
const TOOL_VERSION = "folder-v2/1";

export interface CloudFolderSidebarRequest {
	readonly action: "list" | "create_section" | "rename_section" | "delete_section" | "move_agent";
	readonly name?: string;
	readonly section?: string | null;
	readonly agentId?: string;
}

interface Section {
	name: string;
	members: { id: string; words: string }[];
}

/** One release id per tool call: a replay of the same call releases the same reads under it. */
function releaseIdFor(runId: string, callId: string): string {
	const hex = createHash("sha256").update(`qorpera.sidebar-release/v1:${runId}:${callId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class CloudFolderSidebar {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	/** The run's agent and the coworkers its context lists, by id: the readable names. */
	readonly #people: ReadonlyMap<string, string>;
	readonly #peopleComplete: boolean;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		people: ReadonlyMap<string, string>;
		/** False when the context's coworker list was truncated: Unassigned is then partial. */
		peopleComplete: boolean;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#people = options.people;
		this.#peopleComplete = options.peopleComplete;
	}

	async run(request: CloudFolderSidebarRequest, context: CloudToolContext): Promise<CloudToolContent> {
		const signal = context.signal;
		if (request.action !== "list" && !this.#operations.completesFolderCommits)
			throw new Error("This run cannot complete folder writes");
		const found = await this.#folder.readText(PATH, COMPANY_STATE_FILE_MAX_BYTES, signal);
		if (!found) throw new CloudToolArgumentRefusal("This company has no sections file");
		const parsed = parseCompanyStateFile(PATH, found.text);
		if (!parsed?.ok || parsed.file.kind !== "sections")
			throw new CloudToolArgumentRefusal(
				"The sections file does not read as sections; correct it with the file tools first",
			);
		const lines = found.text.split("\n");
		const file = parsed.file as SectionsFile;
		const preamble = lines.slice(0, file.sections.length ? (file.sections[0]?.line ?? 1) - 1 : lines.length);
		const sections: Section[] = file.sections.map((section) => ({
			name: section.name,
			members: section.members.map((member) => ({
				id: member.id,
				words: /^[-*][ \t]+\S+[ \t]*(.*)$/.exec((lines[member.line - 1] ?? "").replace(/\r$/, ""))?.[1] ?? "",
			})),
		}));
		const refusal = request.action === "list" ? null : apply(sections, request, this.#people);
		const text = render(preamble, sections);
		const output = (changed: boolean, refused: string | null, extra: Record<string, unknown> = {}) =>
			cloudToolJsonText({
				schema: "qorpera.agent-sidebar/v1",
				runId: this.#identity.runId,
				action: request.action,
				changed,
				...(refused ? { refused } : {}),
				...extra,
				sections: sections.map((section) => ({
					name: section.name,
					agents: section.members.map((member) => ({ id: member.id, name: this.#name(member) })),
				})),
				unassigned: [...this.#people]
					.filter(([id]) => !sections.some((section) => section.members.some((member) => member.id === id)))
					.map(([id, name]) => ({ id, name })),
				...(this.#peopleComplete ? {} : { unassignedTruncated: true }),
			});
		const release = async (releaseId: string, shown: string, releaseSignal: AbortSignal) => {
			const entry: CloudCompanyFolderFileEntry = found.entry;
			await this.#folder.release(
				releaseId,
				[{ path: PATH, version: entry.version, authority: entry.authority, fileSha256: entry.file.fileSha256 }],
				sha256(new TextEncoder().encode(shown)),
				releaseSignal,
			);
		};
		// A list, a refusal, or a change already in the file: nothing to save.
		if (request.action === "list" || refusal !== null || text === found.text) {
			const shown =
				request.action === "list" || refusal !== null
					? output(false, refusal)
					: output(false, null, { note: "Already so: nothing changed" });
			await release(releaseIdFor(this.#identity.runId, context.callId), shown, signal);
			return { kind: "text", value: shown };
		}
		return this.#operations.execute({
			operation: {
				tool: "organize_sidebar",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `sidebar:${context.callId}`,
				arguments: { ...request },
				target: { path: PATH },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const committed = await this.#folder.commit(
					`sidebar-file:${receiptId}`,
					[
						{
							op: "write",
							path: PATH,
							content: { text, mediaType: "text/markdown" },
							expectedVersion: found.entry.version,
						},
					],
					{ receiptId },
					performSignal,
				);
				const written = committed.units[0];
				if (!written) throw new Error("Company folder commit answered no unit");
				const shown =
					written.outcome === "saved"
						? output(true, null)
						: output(
								false,
								written.outcome === "conflict"
									? "The sections changed since they were read; nothing changed: call again"
									: written.problems.length
										? written.problems.map((problem) => problem.message).join("; ")
										: `Not saved (${written.reason ?? written.outcome})`,
							);
				await release(receiptId, shown, performSignal);
				return { content: { kind: "text", value: shown }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	#name(member: { id: string; words: string }): string | null {
		return this.#people.get(member.id) ?? (member.words || null);
	}
}

/** Applies a change to the sections in place; a refusal the model can act on, or null. */
function apply(
	sections: Section[],
	request: CloudFolderSidebarRequest,
	people: ReadonlyMap<string, string>,
): string | null {
	const find = (name: string) => sections.find((section) => same(section.name, name));
	if (request.action === "create_section") {
		const name = request.name ?? "";
		if (!find(name)) sections.push({ name, members: [] });
		return null;
	}
	if (request.action === "rename_section") {
		const from = find(request.section ?? "");
		const to = find(request.name ?? "");
		// A retried rename finds the new name.
		if (!from) return to ? null : "No such section";
		if (to && to !== from) return "That name is taken by another section";
		from.name = request.name ?? from.name;
		return null;
	}
	if (request.action === "delete_section") {
		const index = sections.findIndex((section) => same(section.name, request.section ?? ""));
		if (index < 0) return "No such section";
		// Its agents become Unassigned.
		sections.splice(index, 1);
		return null;
	}
	if (request.action === "move_agent") {
		const id = request.agentId ?? "";
		const target = request.section == null ? null : find(request.section);
		if (request.section != null && !target) return "No such section";
		const last = target?.members.at(-1);
		if (target && last?.id === id) return null;
		let words = people.get(id) ?? "";
		for (const section of sections) {
			const index = section.members.findIndex((member) => member.id === id);
			if (index >= 0) {
				words = section.members[index]?.words || words;
				section.members.splice(index, 1);
			}
		}
		target?.members.push({ id, words });
		return null;
	}
	return null;
}

/** The company's notes before the first section, kept as they are, then the sections in the seeded form. */
function render(preamble: readonly string[], sections: readonly Section[]): string {
	const head = [...preamble];
	while (head.length > 0 && !(head.at(-1) ?? "").trim()) head.pop();
	const out = head;
	for (const section of sections) {
		out.push("", `## ${section.name}`);
		for (const member of section.members) out.push(`- ${member.id}${member.words ? ` ${member.words}` : ""}`);
	}
	return `${out.join("\n")}\n`;
}
