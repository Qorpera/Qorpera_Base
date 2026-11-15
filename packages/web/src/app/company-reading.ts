import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";
import {
	COMPANY_STATE_NAME_MAX_CHARS,
	companyStateName,
	isCompanyStateName,
	parseCompanyStateFile,
	READING_FILE_MAX_BYTES,
	READING_FOUNDERS,
	READING_PATH,
	type ReadingChange,
	type ReadingFile,
	type ReadingShape,
} from "@qorpera/cloud-client/company-state-files";
import type { StaffCharacterId } from "@qorpera/cloud-client/staff-characters";
import { CloudRpcError } from "../cloud/client.ts";
import type { CompanyStanding, StandingWhy } from "../cloud/company-standing.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../cloud/types.ts";
import { figureFor } from "../ui/avatar.ts";

/** The standing's read, from here, so the app takes the whole door from one module. */
export { readCompanyStanding } from "../cloud/company-standing.ts";

/* The company's reading of itself for an app's page (`qorpera.reading()`, RUNTIME-INTERFACE-APPS.md §5; Jonas,
 * 15 November 2026, on the company's page: "it should not be the platform that draws it, rather an agent should
 * maintain it", and asked how: "Use a map kit"). A page runs in a frame that reads no file of QorperaOS/, so the web
 * reads the reading (QorperaOS/vision/reading.md, which the Co-Founder keeps) as the member, with the company's agents
 * and whether it can run (`qorpera_read_company_standing`), and hands the page plain names: never a path, a handle, a
 * user id or an agent id. An agent is named by its name and drawn by its figure, one of the twelve a kit's page carries
 * (`figureFor`, as the rail draws it). An agent the reading names but the company does not have, or whose role has
 * ended, stands at no thing; a member a thing waits for is named, and `me` says it is the member looking. */

/** An agent at a thing, or in the team: its name, the figure it is drawn as, and whether it works now. */
export interface AppReadingAgent {
	readonly name: string;
	readonly figure: StaffCharacterId;
	readonly working: boolean;
}

export interface AppReadingThing {
	readonly key: string;
	readonly name: string;
	readonly shape: ReadingShape;
	readonly full: number;
	readonly state: string;
	readonly agents: readonly AppReadingAgent[];
	readonly waits: readonly { readonly name: string; readonly me: boolean }[];
}

/** What `qorpera.reading()` answers. */
export interface AppReadingAnswer {
	/** Null when the company has no reading yet (or none that reads). */
	readonly reading: {
		readonly sentence: string;
		readonly line: string | null;
		readonly attention: string;
		readonly things: readonly AppReadingThing[];
		/** An agent ended or unknown to the company still has its line; `agent` is null when nobody is found for it. */
		readonly changes: readonly {
			readonly agent: { readonly name: string; readonly figure: StaffCharacterId } | null;
			readonly what: ReadingChange["what"];
			readonly line: string;
		}[];
		readonly notes: readonly string[];
	} | null;
	/** The company's agents at work, the Co-Founder first, then by when they were hired. */
	readonly team: readonly (AppReadingAgent & { readonly cofounder: boolean })[];
	/** Null where the backend has no standing read. `you`: the login that holds the company is the member looking's;
	 * `member` names another member whose login it is, null when it is the member looking's or nobody can be named. */
	readonly standing: {
		readonly stopped: boolean;
		readonly since: string | null;
		readonly why: StandingWhy | null;
		readonly you: boolean;
		readonly member: string | null;
		readonly resetsAt: string | null;
	} | null;
}

/** The company's people as the open company holds them. */
export interface ReadingPeople {
	/** Every agent of the company, at work or ended. */
	readonly staff: readonly HostedStaffAgent[];
	readonly working: (agentId: string) => boolean;
	readonly cofounderId: string | undefined;
	readonly members: readonly HostedProfileMember[];
	/** The member looking. */
	readonly viewer: string;
}

/** Whether `handle` is a folder name the platform could have given an agent called `display` when it was hired: its
 * name by the platform's rule (`companyStateName`, "agent" when nothing is left), or that name numbered -2, -3 and so
 * on (`freeCompanyStateName`). Only a guess for an agent whose own file could not be read: a renamed agent is not
 * found by it. */
function couldBeFolderOf(display: string, handle: string): boolean {
	const base = companyStateName(display) || "agent";
	if (handle === base) return true;
	const numbered = /^(.+)(-(?:[2-9]|[1-9][0-9]+))$/.exec(handle);
	return (
		numbered !== null &&
		numbered[1] === base.slice(0, COMPANY_STATE_NAME_MAX_CHARS - (numbered[2] ?? "").length).replace(/-$/, "")
	);
}

const memberName = (member: HostedProfileMember) => member.displayName || member.email.split("@")[0] || "";

/** The answer for `file` (null: no reading), its agents found by their folder names (`handles`: handle to agent id,
 * the live agents' from their state folders and an ended agent's from its own `agent.md`). */
export function appReading(
	file: ReadingFile | null,
	handles: ReadonlyMap<string, string>,
	people: ReadingPeople,
	standing: CompanyStanding | null,
): AppReadingAnswer {
	const active = people.staff.filter((agent) => agent.employmentStatus === "active");
	const byId = new Map(active.map((agent) => [agent.id.toLowerCase(), agent]));
	const cofounder = people.cofounderId?.toLowerCase();
	const agent = (staff: HostedStaffAgent): AppReadingAgent => ({
		name: staff.displayName,
		figure: figureFor(staff),
		working: people.working(staff.id),
	});
	const team = [...active]
		.sort(
			(a, b) =>
				Number(b.id.toLowerCase() === cofounder) - Number(a.id.toLowerCase() === cofounder) ||
				a.createdAt.localeCompare(b.createdAt),
		)
		.map((staff) => ({ ...agent(staff), cofounder: staff.id.toLowerCase() === cofounder }));
	const names = new Map(people.members.map((member) => [member.userId.toLowerCase(), memberName(member)]));
	const owners = people.members.filter((member) => member.role === "owner").map((member) => member.userId);
	const viewer = people.viewer.toLowerCase();
	const living = (handle: string) => {
		const id = handles.get(handle);
		return id ? byId.get(id.toLowerCase()) : undefined;
	};
	const reading: AppReadingAnswer["reading"] = file && {
		sentence: file.sentence,
		line: file.line,
		attention: file.attention,
		things: file.things.map((thing) => ({
			key: thing.key,
			name: thing.name,
			shape: thing.shape,
			full: thing.full,
			state: thing.state,
			agents: thing.agents.flatMap((handle) => {
				const found = living(handle);
				return found ? [agent(found)] : [];
			}),
			// "founders" is every owner of the company; a member the company no longer has is left out.
			waits: [
				...new Set(
					thing.waitsFor
						.flatMap((entry) => (entry === READING_FOUNDERS ? owners : [entry]))
						.map((id) => id.toLowerCase()),
				),
			].flatMap((id) => {
				const name = names.get(id);
				return name ? [{ name, me: id === viewer }] : [];
			}),
		})),
		changes: file.changes.map((change) => {
			// The agent its folder names (ended agents too); else, one ended agent alone whose name gives that folder.
			const id = handles.get(change.agent)?.toLowerCase();
			const guessed = people.staff.filter(
				(candidate) =>
					candidate.employmentStatus !== "active" && couldBeFolderOf(candidate.displayName, change.agent),
			);
			const found =
				(id ? people.staff.find((candidate) => candidate.id.toLowerCase() === id) : undefined) ??
				(guessed.length === 1 ? guessed[0] : undefined);
			return {
				agent: found ? { name: found.displayName, figure: figureFor(found) } : null,
				what: change.what,
				line: change.line,
			};
		}),
		notes: [...file.notes],
	};
	return {
		reading,
		team,
		standing: standing && {
			stopped: standing.stopped,
			since: standing.since,
			why: standing.why,
			you: standing.member !== null && standing.member.toLowerCase() === viewer,
			member:
				standing.member === null || standing.member.toLowerCase() === viewer
					? null
					: (names.get(standing.member.toLowerCase()) ?? null),
			resetsAt: standing.resetsAt,
		},
	};
}

/** What the reading needs of the open company. */
export interface CompanyReadingHost {
	/** The member's own folder client, under the company's checks. */
	readonly folder: () => Pick<CloudMemberFolderClient, "read" | "readFile" | "stateFolders">;
	readonly people: () => ReadingPeople;
	/** The company's standing; an older backend without the read throws a missing function. */
	readonly standing: () => Promise<CompanyStanding>;
}

/** How often the standing is read again while a page that reads the reading is open and the tab is shown. */
export const STANDING_EVERY_MS = 30_000;
const TEXT = new TextDecoder("utf-8", { fatal: true });
/** An agent's file is read up to this size when a change line names an ended agent. */
const AGENT_FILE_MAX_BYTES = 64 * 1024;

/**
 * The open company's reading for its app pages: one per open company, shared by every page that reads `reading`.
 * - The reading file is read as the member at each call, its bytes only when its version changed; a file that does not
 *   read keeps the last reading that did (with none, the company has none yet). The agents' folder names are read again
 *   when the file or the company's agents changed.
 * - The standing is read at the first call, then every 30 s while a page watches (`watch`) and the tab is shown, and
 *   when the tab comes back; a page is told (its `onChange`) when it changed. A backend without the read answers null
 *   for good, and is asked no more.
 * - It stops with the company (`signal`).
 */
export class CompanyReading {
	readonly #host: CompanyReadingHost;
	readonly #signal: AbortSignal;
	#file: ReadingFile | null | undefined;
	#version: string | undefined;
	#handles = new Map<string, string>();
	#handlesFor = "";
	/** Undefined until read; null where the backend has no standing read. */
	#standing: CompanyStanding | null | undefined;
	#standing$: Promise<void> | undefined;
	readonly #listeners = new Set<() => void>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#shown: AbortController | undefined;

	constructor(host: CompanyReadingHost, signal: AbortSignal) {
		this.#host = host;
		this.#signal = signal;
		signal.addEventListener("abort", () => this.#stop(), { once: true });
	}

	/** The answer now. The first call that cannot read the file fails; a later one answers what was read last. */
	async read(signal: AbortSignal): Promise<AppReadingAnswer> {
		const standing = this.#standing === undefined ? this.#readStanding() : undefined;
		try {
			await this.#readFile(signal);
		} catch (error) {
			if (this.#file === undefined) throw error;
		}
		await standing;
		signal.throwIfAborted();
		return appReading(this.#file ?? null, this.#handles, this.#host.people(), this.#standing ?? null);
	}

	/** Tells `changed` when the standing changed, while `page` lasts; the standing is read on its clock meanwhile. */
	watch(page: AbortSignal, changed: () => void): void {
		if (page.aborted || this.#signal.aborted) return;
		const listener = () => changed();
		this.#listeners.add(listener);
		page.addEventListener(
			"abort",
			() => {
				this.#listeners.delete(listener);
				if (this.#listeners.size === 0) this.#stop();
			},
			{ once: true },
		);
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => {
			if (document.visibilityState !== "hidden") void this.#readStanding();
		}, STANDING_EVERY_MS);
		this.#shown = new AbortController();
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState !== "hidden") void this.#readStanding();
			},
			{ signal: AbortSignal.any([this.#shown.signal, this.#signal]) },
		);
	}

	#stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#shown?.abort();
		this.#shown = undefined;
	}

	async #readFile(signal: AbortSignal): Promise<void> {
		const folder = this.#host.folder();
		const { entry } = await folder.read(READING_PATH, signal);
		let file = this.#file;
		let version = this.#version;
		if (!entry?.file || entry.kind !== "file") {
			file = null;
			version = undefined;
		} else if (entry.file.bytes > READING_FILE_MAX_BYTES) file ??= null;
		else if (entry.version !== version || file === undefined) {
			const text = TEXT.decode(await folder.readFile(entry.file, signal, READING_FILE_MAX_BYTES, { cached: true }));
			const parsed = parseCompanyStateFile(READING_PATH, text);
			if (parsed?.ok && parsed.file.kind === "reading") file = parsed.file;
			else file ??= null;
			version = entry.version;
		}
		const live = this.#host
			.people()
			.staff.filter((agent) => agent.employmentStatus === "active")
			.map((agent) => agent.id)
			.sort()
			.join(",");
		let handles = this.#handles;
		let handlesFor = this.#handlesFor;
		if (file && (version !== this.#version || live !== handlesFor || handles.size === 0)) {
			const folders = await folder.stateFolders(signal);
			handles = new Map(
				folders.agents.flatMap((item) => {
					const handle = item.file.split("/").at(-2);
					return handle ? [[handle, item.staffAgentId.toLowerCase()] as const] : [];
				}),
			);
			handlesFor = live;
			// A change line may name an agent whose role ended, which the state folders no longer list: its own file says
			// which agent it was, renamed or numbered alike.
			for (const change of file.changes) {
				if (handles.has(change.agent) || !isCompanyStateName(change.agent)) continue;
				const id = await this.#endedAgent(folder, change.agent, signal);
				if (id) handles.set(change.agent, id);
			}
		}
		signal.throwIfAborted();
		this.#file = file;
		this.#version = version;
		this.#handles = handles;
		this.#handlesFor = handlesFor;
	}

	/** The id in an agent folder's `agent.md`, or null when it is not there or does not read. */
	async #endedAgent(
		folder: Pick<CloudMemberFolderClient, "read" | "readFile">,
		handle: string,
		signal: AbortSignal,
	): Promise<string | null> {
		try {
			const path = `QorperaOS/agents/${handle}/agent.md`;
			const { entry } = await folder.read(path, signal);
			if (!entry?.file || entry.kind !== "file" || entry.file.bytes > AGENT_FILE_MAX_BYTES) return null;
			const parsed = parseCompanyStateFile(
				path,
				TEXT.decode(await folder.readFile(entry.file, signal, AGENT_FILE_MAX_BYTES, { cached: true })),
			);
			return parsed?.ok && parsed.file.kind === "agent" ? parsed.file.id.toLowerCase() : null;
		} catch {
			signal.throwIfAborted();
			return null;
		}
	}

	/** Reads the standing; one read at a time, which a call meanwhile joins. */
	#readStanding(): Promise<void> {
		if (this.#standing === null || this.#signal.aborted) return Promise.resolve();
		this.#standing$ ??= (async () => {
			let next: CompanyStanding | null;
			try {
				next = await this.#host.standing();
			} catch (error) {
				// An older backend: no standing, and no more asking. Any other failure keeps what was read.
				if (!(error instanceof CloudRpcError && error.missing)) return;
				next = null;
			}
			if (this.#signal.aborted) return;
			const before = this.#standing;
			this.#standing = next;
			if (before !== undefined && JSON.stringify(before) !== JSON.stringify(next))
				for (const listener of [...this.#listeners])
					try {
						listener();
					} catch {
						/* One page's trouble is not another's. */
					}
		})().finally(() => {
			this.#standing$ = undefined;
		});
		return this.#standing$;
	}
}
