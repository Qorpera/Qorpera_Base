import { CloudMemberFolderAccessDenied, type CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import { isCloudSkillName, parseCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";
import { COMPANY_STATE_FILE_MAX_BYTES, osPath } from "@qorpera/cloud-client/company-state-files";
import { parentPath } from "./company-folder-writes.ts";

/** A skill the composer can offer after "/" (contract 15.2): the company library
 * (QorperaOS/skills/<name>/SKILL.md) and the agent's own
 * (QorperaOS/agents/<handle>/skills/<name>/SKILL.md), read through the member's own access to
 * the company's folder, as agents read them. */
export interface SkillSuggestion {
	readonly name: string;
	readonly description: string | null;
	/** agent: the conversation's agent's own library; company: the shared one. */
	readonly scope: "agent" | "company";
}

/** What the loader reads through. */
export type SkillFolder = Pick<CloudMemberFolderClient, "list" | "read" | "readFile" | "stateFolders">;

const COMPANY_LIBRARY = osPath("skills");
/** A library listing stops after this many pages. */
const LISTED_PAGES = 10;
const PAGE = 100;
/** Skills per library whose descriptions are read; the rest are offered by name. */
const DESCRIBED = 60;
const READ_CONCURRENCY = 6;
/** A SKILL.md larger than this is offered by name. */
const DESCRIBED_BYTES = COMPANY_STATE_FILE_MAX_BYTES;

/** A skill folder may exist without its SKILL.md; only a read can tell. */
interface Located {
	readonly name: string;
	readonly path: string;
}

/** Every skill in one library by name: skill folders, then flat <name>.md files. A library
 * that does not exist lists empty; one that cannot be listed is a failure, never "no skills". */
async function library(folder: SkillFolder, root: string, signal: AbortSignal): Promise<Located[]> {
	const found = new Map<string, Located>();
	const flat: Located[] = [];
	let after: string | null = null;
	for (let page = 0; page < LISTED_PAGES; page++) {
		const listed = await folder.list(root, after, PAGE, signal);
		for (const entry of listed.entries) {
			const leaf = entry.path.slice(root.length + 1);
			if (entry.kind === "folder" && isCloudSkillName(leaf))
				found.set(leaf, { name: leaf, path: `${entry.path}/SKILL.md` });
			else if (entry.kind === "file" && leaf.endsWith(".md") && isCloudSkillName(leaf.slice(0, -3)))
				flat.push({ name: leaf.slice(0, -3), path: entry.path });
		}
		if (listed.next === null) break;
		after = listed.next;
	}
	for (const skill of flat) if (!found.has(skill.name)) found.set(skill.name, skill);
	return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A skill file's description; undefined when the file is not there (a folder without its SKILL.md is not a skill). */
async function describe(folder: SkillFolder, path: string, signal: AbortSignal): Promise<string | null | undefined> {
	const read = await folder.read(path, signal);
	if (!read.entry?.file) return undefined;
	if (read.entry.file.bytes > DESCRIBED_BYTES) return null;
	const bytes = await folder.readFile(read.entry.file, signal, DESCRIBED_BYTES);
	return parseCloudSkillFile(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).description;
}

/** The skills the composer offers in one conversation: the agent's own first, then the
 * company's, each by name. Descriptions come from the same SKILL.md parser agents use. */
export async function loadSkillSuggestions(
	folder: SkillFolder,
	agentId: string | null,
	signal: AbortSignal,
): Promise<SkillSuggestion[]> {
	// The agent's folder is where its agent.md is (QorperaOS/agents/<handle>, folder core state files).
	const agentFile = agentId
		? ((await folder.stateFolders(signal)).agents.find((agent) => agent.staffAgentId === agentId.toLowerCase())
				?.file ?? null)
		: null;
	const libraries = [
		...(agentFile ? [{ root: `${parentPath(agentFile)}/skills`, scope: "agent" as const }] : []),
		{ root: COMPANY_LIBRARY, scope: "company" as const },
	];
	const listed = await Promise.all(
		libraries.map(({ root, scope }) =>
			library(folder, root, signal).catch((error: unknown) => {
				signal.throwIfAborted();
				// The agent's own folder may be closed to this member: its skills are then not offered.
				// Any other failure, and the company's library failing at all, is a failure: the composer
				// keeps its last list and tries again.
				if (scope === "agent" && error instanceof CloudMemberFolderAccessDenied) return [];
				throw error;
			}),
		),
	);
	const skills = libraries.flatMap(({ scope }, index) =>
		(listed[index] ?? []).map((skill, order) => ({ ...skill, scope, order })),
	);
	const described = skills.filter((skill) => skill.order < DESCRIBED);
	const descriptions = new Map<(typeof skills)[number], string | null | undefined>();
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(READ_CONCURRENCY, described.length) }, async () => {
			for (let skill = described[next++]; skill; skill = described[next++]) {
				try {
					descriptions.set(skill, await describe(folder, skill.path, signal));
				} catch {
					signal.throwIfAborted();
					// Unreadable here (not text, no access): still offered, by name.
					descriptions.set(skill, null);
				}
			}
		}),
	);
	return skills.flatMap((skill) => {
		const description = descriptions.has(skill) ? descriptions.get(skill) : null;
		return description === undefined ? [] : [{ name: skill.name, description, scope: skill.scope }];
	});
}

/** How long a list read in one conversation serves the company's other conversations. With
 * the composer's own 20 s, a skill saved in the company's folder shows within a minute. */
const SHARED_FRESH_MS = 40_000;

/** The skill lists of one company, shared by its conversations: a list read in one thread
 * serves the others for a while, and threads opened together share one read. A failed read
 * is forgotten at once, so the next "/" reads again. */
export class SkillLists {
	readonly #lists = new Map<string, { at: number; list: Promise<SkillSuggestion[]> }>();
	get(agentId: string | null, read: () => Promise<SkillSuggestion[]>): Promise<SkillSuggestion[]> {
		const key = agentId ?? "";
		const cached = this.#lists.get(key);
		if (cached && Date.now() - cached.at < SHARED_FRESH_MS) return cached.list;
		const entry = { at: Date.now(), list: read() };
		this.#lists.set(key, entry);
		entry.list.catch(() => {
			if (this.#lists.get(key) === entry) this.#lists.delete(key);
		});
		return entry.list;
	}
}
