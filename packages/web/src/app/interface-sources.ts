import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { cloudRoutineTriggerOfFile } from "@qorpera/cloud-client/cloud-routine-file";
import { type CloudRoutineTrigger, describeCloudRoutineTrigger } from "@qorpera/cloud-client/cloud-routines";
import {
	type CompanyStateFile,
	type CompanyStateFileResult,
	type CompanyStatePath,
	companyPathKey,
	companyStatePath,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";
import { INTERFACE_SOURCE_COLUMNS, type TableRow } from "@qorpera/cloud-client/interfaces";
import type { HostedRunRecovery, HostedStaffExecutionActivity } from "../cloud/types.ts";
import { presentationLocale, t } from "../ui/preferences.ts";
import type { CompanyController } from "./company.ts";
import type { FolderPage, FolderProblem, InterfaceFolderState } from "./interface-folder.ts";
import type { InterfaceRow } from "./interfaces.ts";
import { routineNextRun } from "./routine-next-run.ts";

/* The interfaces' sources from the company folder's own files (RUNTIME-INTERFACES.md §4, "From the company folder"):
 * `vision`, `agents`, `groups`, `todos`, `routines`, `connections`, `contacts`, `human_tasks` and `interfaces`, and the
 * `activity` source from the company's live state. app/interface-folder.ts lists and reads the files the active pages'
 * drawn blocks name, with the member's own authority, through the same reader and change feed as the pages and tables;
 * this module says which folders and files those are, parses them with the cloud client's `parseCompanyStateFile`, and
 * turns them into rows. The `agents` and `groups` sources read the folder too, not the store: their rows are what the
 * files say, as every other folder source's are. A file that doesn't parse is left out and listed as its source's
 * problem; one that is too large or isn't text is left out, as I7 leaves out such a file. */

/** The sources read from the company folder's own files. */
const FOLDER_SOURCES: ReadonlySet<string> = new Set([
	"vision",
	"agents",
	"groups",
	"todos",
	"routines",
	"connections",
	"contacts",
	"human_tasks",
	"interfaces",
]);

export function isFolderSource(source: string): boolean {
	return FOLDER_SOURCES.has(source);
}

/** The column `since` and ordering use. */
const TIMES: Readonly<Record<string, string>> = { todos: "updated", routines: "next", human_tasks: "due" };
/** The columns that hold ids, which a page shows as names. */
const IDS: Readonly<Record<string, Readonly<Record<string, "agent" | "member" | "agents" | "members">>>> = {
	agents: { id: "agent", figure: "agent" },
	groups: { agents: "agents", people: "members" },
	todos: { agent: "agent", requested_by: "member" },
	routines: { agent: "agent" },
	human_tasks: { from: "agent", person: "member" },
	activity: { agent: "agent", member: "member" },
};

/** A folder source's columns, §4's (the cloud client's `INTERFACE_SOURCE_COLUMNS`), and the column that is its time. */
export function folderSourceColumns(source: string): {
	readonly columns: readonly string[];
	readonly time: string | null;
} {
	return { columns: INTERFACE_SOURCE_COLUMNS[source] ?? [], time: TIMES[source] ?? null };
}

/** What a folder source's (or `activity`'s) column holds the ids of, or null. */
export function folderIdColumn(source: string, column: string): "agent" | "member" | "agents" | "members" | null {
	const ids = Object.hasOwn(IDS, source) ? IDS[source] : undefined;
	return ids && Object.hasOwn(ids, column) ? (ids[column] ?? null) : null;
}

/** An instant as a page's rows hold one, to the second: `2026-10-04T09:00:00Z`, which `since`, ordering and the
 * calendar read (the cloud client's `interfaceInstant`). Null for what isn't one. */
export function rowInstant(text: string | null | undefined): string | null {
	const at = text ? Date.parse(text) : Number.NaN;
	return Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

// ---- reading ---------------------------------------------------------------------

/** A file as last read for a folder source: its text at the version its listing named, or null when it is too large
 * or isn't text. */
export interface FolderSourceRead {
	readonly version: string;
	readonly text: string | null;
}

/** What the reader has listed and read: undefined for a folder or file it hasn't, or whose first read failed. */
export interface FolderView {
	listed(folder: string): readonly CloudMemberFolderEntry[] | undefined;
	read(path: string): FolderSourceRead | undefined;
}

type Kind = CompanyStatePath["kind"];

/** Which sources each kind of file is read for: the ones it is a row of, and those whose rows it names. */
const KIND_SOURCES: Readonly<Partial<Record<Kind, readonly string[]>>> = {
	vision: ["vision"],
	sections: ["agents"],
	agent: ["agents", "todos", "routines"],
	group: ["groups"],
	todo: ["todos"],
	routine: ["routines"],
	connection: ["connections"],
	contact: ["contacts", "human_tasks"],
	"human-task": ["human_tasks"],
};
/** Each source's own files: a bad one is that source's problem. */
const OWN_KINDS: Readonly<Record<string, readonly Kind[]>> = {
	vision: ["vision"],
	agents: ["agent", "sections"],
	groups: ["group"],
	todos: ["todo"],
	routines: ["routine"],
	connections: ["connection"],
	contacts: ["contact"],
	human_tasks: ["human-task"],
};

interface Walk {
	/** The folders the sources list. */
	readonly folders: string[];
	/** The listed files they read, each with its kind. */
	readonly takes: { readonly entry: CloudMemberFolderEntry; readonly kind: Kind }[];
	/** The sources a folder they list hasn't been listed for. */
	readonly unlisted: Set<string>;
}

/** The folders `names` list and the files they read, as far as what has been listed shows: an agent's folder is
 * listed once `agents/` lists it, and its `todos/` once the agent's folder lists that. A file is read for its kind,
 * by its path (`companyStatePath`), so a hook's or a mailbox's file under `connections/` is never read. */
function walk(names: ReadonlySet<string>, view: FolderView): Walk {
	const folders = new Map<string, string>();
	const takes = new Map<string, { entry: CloudMemberFolderEntry; kind: Kind }>();
	const unlisted = new Set<string>();
	const list = (folder: string, sources: readonly string[]) => {
		folders.set(companyPathKey(folder), folder);
		const entries = view.listed(folder);
		if (entries === undefined) for (const source of sources) unlisted.add(source);
		return entries ?? [];
	};
	const take = (entries: readonly CloudMemberFolderEntry[], kind: Kind) => {
		for (const entry of entries)
			if (entry.kind === "file" && companyStatePath(entry.path)?.kind === kind)
				takes.set(companyPathKey(entry.path), { entry, kind });
	};
	/** The folder `name` inside `folder`, as `folder`'s listing writes it. */
	const inside = (entries: readonly CloudMemberFolderEntry[], folder: string, name: string) => {
		const key = companyPathKey(`${folder}/${name}`);
		return entries.find((entry) => entry.kind === "folder" && companyPathKey(entry.path) === key)?.path;
	};
	if (names.has("vision")) take(list("vision", ["vision"]), "vision");
	const owners = ["agents", "todos", "routines"].filter((name) => names.has(name));
	if (owners.length > 0) {
		const top = list("agents", owners);
		if (names.has("agents")) take(top, "sections");
		for (const folder of top) {
			if (folder.kind !== "folder" || companyStatePath(`${folder.path}/agent.md`)?.kind !== "agent") continue;
			const own = list(folder.path, owners);
			take(own, "agent");
			for (const [source, name, kind] of [
				["todos", "todos", "todo"],
				["routines", "routines", "routine"],
			] as const) {
				const path = names.has(source) ? inside(own, folder.path, name) : undefined;
				if (path !== undefined) take(list(path, [source]), kind);
			}
		}
	}
	if (names.has("groups"))
		for (const folder of list("agents/groups", ["groups"]))
			if (folder.kind === "folder" && companyStatePath(`${folder.path}/group.md`)?.kind === "group")
				take(list(folder.path, ["groups"]), "group");
	if (names.has("connections")) take(list("connections", ["connections"]), "connection");
	// A human task names its contact by id: its rows show the contact's name.
	if (names.has("contacts") || names.has("human_tasks")) take(list("contacts", ["contacts", "human_tasks"]), "contact");
	if (names.has("human_tasks")) take(list("human-tasks", ["human_tasks"]), "human-task");
	return { folders: [...folders.values()], takes: [...takes.values()], unlisted };
}

/** The folders to list and the listed files to read for the folder sources `names`. */
export function folderSourcePlan(
	names: ReadonlySet<string>,
	view: FolderView,
): { readonly folders: readonly string[]; readonly takes: readonly CloudMemberFolderEntry[] } {
	const { folders, takes } = walk(names, view);
	return { folders, takes: takes.map(({ entry }) => entry) };
}

/** A folder source's file, parsed, with when its listing says it last changed and, for an agent's todo or routine,
 * the agent's id. */
export interface FolderSourceFile {
	readonly path: string;
	readonly file: CompanyStateFile;
	readonly text: string;
	readonly updatedAt: string;
	readonly agent: string | null;
}

/** A folder source as last read. It can't be `readable` while a folder or file it needs has never been read; the
 * next sync reads it again. */
export interface FolderSource {
	readonly files: readonly FolderSourceFile[];
	readonly problems: readonly FolderProblem[];
	readonly readable: boolean;
}

/** Each read's parse, kept while the read is. */
const parses = new WeakMap<FolderSourceRead, CompanyStateFileResult | null>();

/** The folder sources `names`, as what has been listed and read says. `interfaces` is the pages themselves. */
export function folderSourceState(
	names: ReadonlySet<string>,
	view: FolderView,
	pages: readonly FolderPage[],
): Map<string, FolderSource> {
	const { takes, unlisted } = walk(names, view);
	const unread = new Set(unlisted);
	const files: { kind: Kind; source: FolderSourceFile }[] = [];
	const problems = new Map<Kind, FolderProblem[]>();
	const owners = new Map<string, string>();
	for (const { entry, kind } of takes) {
		const read = view.read(entry.path);
		if (read === undefined) for (const source of KIND_SOURCES[kind] ?? []) unread.add(source);
		if (!read || read.text === null) continue;
		let parsed = parses.get(read);
		if (parsed === undefined) {
			parsed = parseCompanyStateFile(entry.path, read.text);
			parses.set(read, parsed);
		}
		if (parsed === null) continue;
		if (!parsed.ok) {
			const listed = problems.get(kind) ?? [];
			for (const problem of parsed.problems) listed.push(fileProblem(entry.path, problem));
			problems.set(kind, listed);
			continue;
		}
		if (parsed.file.kind === "agent") owners.set(companyPathKey(parentOf(entry.path)), parsed.file.id);
		files.push({
			kind,
			source: { path: entry.path, file: parsed.file, text: read.text, updatedAt: entry.updatedAt, agent: null },
		});
	}
	/** The agent whose folder holds a todo or a routine: `agents/<handle>/todos/<t>.md`. */
	const ownerOf = (path: string) => owners.get(companyPathKey(parentOf(parentOf(path)))) ?? null;
	const state = new Map<string, FolderSource>();
	// A human task's rows name its contact, so `human_tasks` reads `contacts` too.
	for (const name of new Set([...names, ...(names.has("human_tasks") ? ["contacts"] : [])])) {
		if (!FOLDER_SOURCES.has(name)) continue;
		if (name === "interfaces") {
			const broken = pages.flatMap((page) =>
				page.file === null
					? page.problems.map((problem) => fileProblem(`interfaces/${page.name}/interface.toml`, problem))
					: [],
			);
			state.set(name, { files: [], problems: broken, readable: true });
			continue;
		}
		const kinds = new Set(OWN_KINDS[name] ?? []);
		const readable = !unread.has(name);
		state.set(name, {
			files: readable
				? files.flatMap(({ kind, source }) =>
						!kinds.has(kind)
							? []
							: kind === "todo" || kind === "routine"
								? [{ ...source, agent: ownerOf(source.path) }]
								: [source],
					)
				: [],
			problems: [...kinds].flatMap((kind) => problems.get(kind) ?? []),
			readable,
		});
	}
	return state;
}

function parentOf(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** A bad file's problem as its source lists it: the file and the line. */
function fileProblem(path: string, problem: { readonly line: number | null; readonly message: string }): FolderProblem {
	return { line: null, message: `${path}${problem.line === null ? "" : `:${problem.line}`}: ${problem.message}` };
}

// ---- rows ------------------------------------------------------------------------

function agentHref(company: CompanyController, agentId: string): string | undefined {
	const agent = company.staffById(agentId);
	if (!agent || agent.employmentStatus !== "active") return undefined;
	const profileId = company.profile.profileId;
	return agentId === company.cofounderId() ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agentId}`;
}

/** A routine's trigger in few words, as the routine list says it; a file-change trigger, which the routine index
 * doesn't schedule, as the file says it. */
function routineWhen(file: Extract<CompanyStateFile, { kind: "routine" }>): string | null {
	let trigger: CloudRoutineTrigger | null = cloudRoutineTriggerOfFile(file);
	if (trigger === null && file.trigger.when === "file-change")
		trigger = {
			id: "file",
			kind: "listener",
			source: "company-file",
			path: file.trigger.watch,
			match: file.trigger.match,
			timeZone: file.timezone ?? "UTC",
		};
	return trigger === null ? null : describeCloudRoutineTrigger(trigger, t);
}

function row(source: string, path: string, values: TableRow, href?: string): InterfaceRow {
	return { row: values, key: `${source}:${companyPathKey(path)}`, ...(href ? { href } : {}) };
}

/** The rows of a folder source, or undefined while the folder hasn't been read or no page names it. `listed` names the
 * interfaces this member's Interfaces tab lists, which an `interfaces` row leads to. */
export function folderSourceRows(
	company: CompanyController,
	folder: InterfaceFolderState | undefined,
	source: string,
	listed: () => readonly string[],
): InterfaceRow[] | undefined {
	const read = folder?.sources.get(source);
	if (!folder || !read) return undefined;
	const files = <K extends CompanyStateFile["kind"]>(kind: K) =>
		read.files.flatMap((item) =>
			item.file.kind === kind ? [{ ...item, file: item.file as Extract<CompanyStateFile, { kind: K }> }] : [],
		);
	const byPath = (a: { path: string }, b: { path: string }) => {
		const [x, y] = [companyPathKey(a.path), companyPathKey(b.path)];
		return x < y ? -1 : x > y ? 1 : 0;
	};
	switch (source) {
		case "vision":
			return files("vision").map((item) => row(source, item.path, { text: item.text }));
		case "agents": {
			const sections = files("sections")[0]?.file.sections ?? [];
			const place = new Map<string, { section: string; index: number }>();
			sections.forEach((section, at) =>
				section.members.forEach((member, index) =>
					place.set(member.id, { section: section.name, index: at * 10_000 + index }),
				),
			);
			const collator = new Intl.Collator(presentationLocale(), { numeric: true, sensitivity: "base" });
			return files("agent")
				.sort(
					(a, b) =>
						(place.get(a.file.id)?.index ?? Number.MAX_SAFE_INTEGER) -
							(place.get(b.file.id)?.index ?? Number.MAX_SAFE_INTEGER) ||
						collator.compare(a.file.name, b.file.name) ||
						byPath(a, b),
				)
				.map(({ path, file }) =>
					row(
						source,
						path,
						{
							id: file.id,
							name: file.name,
							role: file.role,
							figure: file.id,
							colour: file.colour,
							status: file.status,
							section: place.get(file.id)?.section ?? null,
						},
						file.status === "active" ? agentHref(company, file.id) : undefined,
					),
				);
		}
		case "groups":
			return files("group")
				.sort(byPath)
				.map(({ path, file }) =>
					row(source, path, { id: file.id, name: file.name, agents: [...file.agents], people: [...file.people] }),
				);
		case "todos":
			return files("todo")
				.sort(byPath)
				.map(({ path, file, agent, updatedAt }) =>
					row(
						source,
						path,
						{
							id: file.id,
							agent,
							title: file.title,
							status: file.status,
							requested_by: file.requestedBy,
							updated: rowInstant(updatedAt),
						},
						agent === null ? undefined : agentHref(company, agent),
					),
				);
		case "routines": {
			const now = Date.now();
			return files("routine")
				.sort(byPath)
				.map(({ path, file, agent }) =>
					row(
						source,
						path,
						{
							id: file.id,
							agent,
							title: file.title,
							when: routineWhen(file),
							next: rowInstant(routineNextRun(file, now)),
							status: file.status,
						},
						agent === null ? undefined : agentHref(company, agent),
					),
				);
		}
		case "connections":
			return files("connection")
				.sort(byPath)
				.map(({ path, file }) =>
					row(source, path, { id: file.id, service: file.service, account: file.account, status: file.status }),
				);
		case "contacts":
			return files("contact")
				.sort(byPath)
				.map(({ path, file }) => row(source, path, { id: file.id, name: file.name, organization: file.organization }));
		case "human_tasks": {
			// A task for a contact names the contact's file by id; the row shows its name.
			const contacts = new Map(
				(folder.sources.get("contacts")?.files ?? []).flatMap(({ file }) =>
					file.kind === "contact" ? [[file.id, file.name] as const] : [],
				),
			);
			return files("human-task")
				.sort(byPath)
				.map(({ path, file }) =>
					row(source, path, {
						id: file.id,
						title: file.title,
						status: file.status,
						person: file.member ?? (file.contact === null ? null : (contacts.get(file.contact) ?? file.contact)),
						from: file.from,
						due: rowInstant(file.due),
					}),
				);
		}
		case "interfaces": {
			const shown = new Set(listed());
			const profileId = company.profile.profileId;
			return folder.pages.flatMap((page) =>
				page.file === null
					? []
					: [
							row(
								source,
								`interfaces/${page.name}`,
								{
									id: page.file.id,
									name: page.file.name,
									about: page.file.about,
									emblem: page.file.emblem,
									status: page.file.status,
								},
								shown.has(page.name) ? `#/c/${profileId}/i/${page.name}` : undefined,
							),
						],
			);
		}
		default:
			return undefined;
	}
}

/** One plain sentence about a run, as the rest of the app says what an agent is doing: a run that needs a member reads
 * as the `waiting` source's rows do (`CompanyController.agentState`). */
function activityLine(item: HostedStaffExecutionActivity, recovery: HostedRunRecovery | undefined, name: string): string {
	if (item.activity === "needs_attention")
		return item.jobStatus === "failed" && !recovery?.proposalId
			? t("{name} has a run that did not finish", { name })
			: t("{name} needs you", { name });
	if (item.jobStatus === "queued") return t("{name} is starting", { name });
	if (item.jobStatus === "leased")
		return item.phase === "writing" ? t("{name} is writing", { name }) : t("{name} is working", { name });
	if (item.jobStatus === "completed") return t("{name} finished", { name });
	return t("{name} stopped", { name });
}

/** The `activity` source (§4): one row per run the company's live state reports for an agent that works here, newest
 * first, each with one plain sentence. A run is a `wake` when an agent or a routine woke it, else a `run`; `member` is
 * the member it was started for, where the run's details say so (today only a failed run's recovery does). */
export function activityRows(company: CompanyController): InterfaceRow[] {
	const state = company.store.get();
	return state.activity
		.flatMap((item): { at: number; row: InterfaceRow }[] => {
			const agent = company.staffById(item.staffAgentId);
			if (!agent || agent.employmentStatus !== "active") return [];
			const at = rowInstant(item.updatedAt);
			const recovery = state.recoveries[item.runId];
			const href = agentHref(company, agent.id);
			return [
				{
					at: at === null ? Number.NEGATIVE_INFINITY : Date.parse(at),
					row: {
						row: {
							at,
							kind: item.sourceKind === "wake" ? "wake" : "run",
							agent: agent.id,
							member: recovery?.requestedByUserId ?? null,
							line: activityLine(item, recovery, agent.displayName),
						},
						key: `activity:${item.runId}`,
						...(href ? { href } : {}),
					},
				},
			];
		})
		.map((entry, index) => ({ ...entry, index }))
		.sort((a, b) => b.at - a.at || a.index - b.index)
		.map(({ row }) => row);
}
