import {
	CloudMemberCompanyAccessDenied,
	type CloudMemberCompanyFileClient,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { isCloudSkillName, parseCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";

/** A skill the composer can offer after "/" (contract 15.2): the company library
 * (skills/<name>/SKILL.md) and the agent's own (agents/<agentId>/skills/<name>/SKILL.md),
 * read through the member's own Company File access, as agents read them. */
export interface SkillSuggestion {
	readonly name: string;
	readonly description: string | null;
	/** agent: the conversation's agent's own library; company: the shared one. */
	readonly scope: "agent" | "company";
}

const COMPANY_LIBRARY = "skills";
/** A library listing stops after this many pages (50 entries each). */
const LISTED_PAGES = 10;
/** Listings restarted because the company changed between pages. */
const LIST_ATTEMPTS = 3;
/** Skills per library whose descriptions are read; the rest are offered by name. */
const DESCRIBED = 60;
const READ_CONCURRENCY = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A skill folder may exist without its SKILL.md; only a read can tell. */
interface Located {
	readonly name: string;
	readonly path: string;
}

/** Every skill in one library by name: skill folders, then flat <name>.md files. A library
 * that does not exist lists empty; one that cannot be listed is a failure, never "no skills". */
async function library(files: CloudMemberCompanyFileClient, root: string, signal: AbortSignal): Promise<Located[]> {
	for (let attempt = 1; ; attempt++) {
		const found = new Map<string, Located>();
		const flat: Located[] = [];
		let after: string | null = null;
		let snapshot: string | null = null;
		try {
			for (let page = 0; page < LISTED_PAGES; page++) {
				const listed = await files.list(root, signal, after, snapshot);
				for (const item of listed.items) {
					const leaf = item.path.slice(root.length + 1);
					if (item.kind === "directory" && isCloudSkillName(leaf))
						found.set(leaf, { name: leaf, path: `${item.path}/SKILL.md` });
					else if (item.kind === "file" && leaf.endsWith(".md") && isCloudSkillName(leaf.slice(0, -3)))
						flat.push({ name: leaf.slice(0, -3), path: item.path });
				}
				if (!listed.hasMore) break;
				after = listed.nextAfter;
				snapshot = listed.snapshotId;
			}
		} catch (error) {
			signal.throwIfAborted();
			// A write anywhere in the company moves the snapshot between pages: list again from the start.
			if (after === null || attempt >= LIST_ATTEMPTS) throw error;
			continue;
		}
		for (const skill of flat) if (!found.has(skill.name)) found.set(skill.name, skill);
		return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}
}

/** The skills the composer offers in one conversation: the agent's own first, then the
 * company's, each by name. Descriptions come from the same SKILL.md parser agents use. */
export async function loadSkillSuggestions(
	files: CloudMemberCompanyFileClient,
	agentId: string | null,
	signal: AbortSignal,
): Promise<SkillSuggestion[]> {
	const libraries = [
		...(agentId && UUID.test(agentId) ? [{ root: `agents/${agentId}/skills`, scope: "agent" as const }] : []),
		{ root: COMPANY_LIBRARY, scope: "company" as const },
	];
	const listed = await Promise.all(
		libraries.map(({ root, scope }) =>
			library(files, root, signal).catch((error: unknown) => {
				signal.throwIfAborted();
				// The agent's own folder may be closed to this member: its skills are then not offered.
				// Any other failure, and the company's library failing at all, is a failure: the composer
				// keeps its last list and tries again.
				if (scope === "agent" && error instanceof CloudMemberCompanyAccessDenied) return [];
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
					const file = await files.read(skill.path, signal);
					// A folder without its SKILL.md is not a skill.
					descriptions.set(skill, file.kind === "file" ? parseCloudSkillFile(file.text).description : undefined);
				} catch {
					signal.throwIfAborted();
					// Unreadable here (too large, not text, no access): still offered, by name.
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
 * the composer's own 20 s, a skill saved in the Company File shows within a minute. */
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
