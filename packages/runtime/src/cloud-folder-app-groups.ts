import { createHash } from "node:crypto";
import {
	APP_DRAWER_PAGES,
	APP_GROUP_KEY_PREFIX,
	APP_GROUP_LEVELS,
	APP_GROUP_NAME_MAX_CHARS,
	APP_GROUPS_MAX_BYTES,
	APP_GROUPS_PATH,
	type AppGroupNode,
	appGroupName,
	appGroupSlug,
	isAppDrawerKey,
	isAppGroupId,
	parseAppGroups,
	writeAppGroups,
} from "@qorpera/cloud-client/app-groups";
import { AGENT_COLOURS, type AgentColour } from "@qorpera/cloud-client/company-state-shared";
import {
	APP_MANIFEST,
	APP_MANIFEST_MAX_BYTES,
	APPS_FOLDER,
	parseAppManifest,
} from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import type { JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderFileEntry,
	type CloudCompanyFolderUnit,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { releaseId, unavailable } from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

/*
 * `organize_apps` (APP-GROUPS-SPEC §3; Jonas, 11 November 2026: "the agents should be able to organize the interfaces
 * for you natively and help group interfaces to products and work"): the twin of `organize_sidebar` for the apps
 * drawer. It is a thin writer of the company's layout, `apps/groups.md` (the format is the cloud client's
 * `app-groups.ts`, which the web's drawer reads too), and of nothing else: what a member changed in their own drawer is
 * theirs (`qorpera_member_app_layouts`, §2) and no tool here touches it.
 *
 * As `organize_sidebar`, it is idempotent by content: a change already in the layout (its keys and groups in order,
 * whatever the words beside them) saves nothing and says so; a change saves the whole file under the tool call's
 * receipt with the version read, and a save that meets a newer file is refused, to be called again. The company's notes
 * in the file are kept. It refuses a third group level and a key the company does not have; the rules of a good
 * layout are guidance in its description, not refusals. An app whose folder is gone leaves the file with the next
 * change (the drawer skips it until then).
 *
 * `save_app`'s `group` places a new app in a group in the same commit (`placeAppInGroup`).
 *
 * A group may have the company's colour (Jonas, 12 November 2026: "have the co-founder pick colours for fjeldtur's
 * groups"), one of the agents' palette: `create_group`'s `colour` and `colour_group` set it, `list` shows it, and every
 * other change keeps it (a group ungrouped takes its colour with it). The drawer draws the group and what is in it in
 * that colour, unless a member chose their own.
 */

const TOOL_VERSION = "folder-v2/1";
const ACTIONS = ["list", "create_group", "rename_group", "colour_group", "ungroup", "move"] as const;
type Action = (typeof ACTIONS)[number];
const FIELDS: Record<Action, { required: readonly string[]; optional: readonly string[] }> = {
	list: { required: [], optional: ["cursor"] },
	create_group: { required: ["name"], optional: ["parent", "items", "colour"] },
	rename_group: { required: ["group", "name"], optional: [] },
	colour_group: { required: ["group", "colour"], optional: [] },
	ungroup: { required: ["group"], optional: [] },
	move: { required: ["item", "group"], optional: ["before"] },
};
/** Items one create_group moves into the new group, at most. */
const ITEMS_MAX = 64;
/** The app folders a company may have that one call reads; more is refused rather than drawn wrong. */
const APPS_MAX = 500;
/** Manifests read at once. */
const READS_AT_ONCE = 8;
/** A new file's notes. */
const HEAD = ["# Apps", "The company's apps in the drawer, kept by its agents with organize_apps."];
const TITLES: Record<string, string> = {
	"page:mailbox": "Mailbox",
	"page:members": "Members",
	"page:bank": "Bank",
	concepts: "Concepts",
	sites: "Sites",
	"whats-new": "What's new",
};

export interface OrganizeAppsRequest {
	readonly action: Action;
	readonly name?: string;
	/** A group's id. */
	readonly parent?: string | null;
	readonly group?: string | null;
	readonly items?: readonly string[];
	/** A drawer key or `group:<id>`. */
	readonly item?: string;
	readonly before?: string | null;
	/** Where a page of list starts: a line of the layout. */
	readonly cursor?: number;
	/** A group's colour; null takes it away (colour_group). */
	readonly colour?: AgentColour | null;
}

type Node =
	| { kind: "item"; key: string; words: string }
	| { kind: "group"; id: string; name: string; items: Node[]; colour?: AgentColour };

/** The drawer entries the company has, as one call reads them. */
interface Company {
	/** The keys in the drawer's own order for what the file does not list: pages, apps by name, Concepts. */
	readonly have: readonly string[];
	readonly titles: ReadonlyMap<string, string>;
	readonly unposted: ReadonlySet<string>;
	/** The names of the app folders, concepts and apps with broken manifests included. */
	readonly folders: ReadonlySet<string>;
	readonly concepts: ReadonlySet<string>;
	/** Whether `apps` is a folder (or absent): false when something else stands there. */
	readonly appsUsable: boolean;
	readonly appsExists: boolean;
	readonly reads: readonly CloudCompanyFolderEntry[];
}

export const ORGANIZE_APPS_DESCRIPTION =
	"Sort the company's apps into groups in the apps drawer, the grid where every member opens the company's pages and apps (Mailbox, Members, Bank, each posted app, Concepts, Sites, What's new). A group is a tile that opens into its apps, as agents sit in sidebar sections. The layout is the company's, in the file apps/groups.md: no member approval is needed and every member sees a change at once. " +
	"action list shows the layout: each entry by its key (page:mailbox, page:members, page:bank, app:<name>, concepts, sites, whats-new) with its title, in its group, groups by id and name with how many apps they hold and their colour, and the loose entries last, as the drawer shows them, one line each in the file's own form; a long layout comes in pages: call list again with the cursor it answers. An app marked not posted shows in the drawer only once it is posted. create_group makes a group called name and answers its id; parent puts it inside another group, items moves those keys (or group:<id>) into it, in order, and colour gives it a colour. A group of that name already there is that group. rename_group renames group; its id stays. " +
	`colour_group sets group's colour to colour, one of ${AGENT_COLOURS.join(", ")}; null takes it away. ` +
	"ungroup takes group away: what was in it stands where it stood. move puts item (a key, or group:<id> for a whole group) into group, or loose when group is null, before the entry named by before there, else last. save_app takes group to put a new app in a group as it is made. A change answers what it did, and list shows the layout after it. A change already made saves nothing and says so; a save can come back refused when the file changed since it was read: call again. It refuses a third group level, a key the company does not have and a colour not in the palette. " +
	"How to sort, plainly: 1. Group by what the founder thinks in: a product, a customer, a piece of work. Never by agent, by kind of page (such as Reports) or by date. 2. Name a group in one to three words, in the company's own words. 3. The company's basics (Mailbox, Bank, its finances, Members) stay loose at the front. 4. Two group levels at most. Three to twelve apps in a group; a group with one app goes away (ungroup it). 5. Give every group a colour that sets it apart from the others and fits its product or area, by the palette's names; a group inside a group usually takes its parent's colour, so leave its own unset. Members can pick their own colours, which win in their drawer. 6. You sort the company's layout; what a member changed in their own drawer is theirs, and you leave it. 7. After a change, say it in one line to the member who asked, or on your wall.";

const groupRef = (value: unknown, label: string): string => {
	const id =
		typeof value === "string" && value.startsWith(APP_GROUP_KEY_PREFIX)
			? value.slice(APP_GROUP_KEY_PREFIX.length)
			: value;
	if (typeof id !== "string" || !isAppGroupId(id))
		throw new CloudToolArgumentRefusal(`${label} must be a group's id from organize_apps list, such as trips`);
	return id;
};

const entryRef = (value: unknown, label: string): string => {
	if (typeof value === "string" && value.startsWith(APP_GROUP_KEY_PREFIX))
		return `${APP_GROUP_KEY_PREFIX}${groupRef(value, label)}`;
	if (typeof value !== "string" || !isAppDrawerKey(value))
		throw new CloudToolArgumentRefusal(
			`${label} must be a key from organize_apps list (page:mailbox, page:members, page:bank, app:<name>, concepts, sites, whats-new) or group:<id>`,
		);
	return value;
};

export function parseOrganizeAppsArguments(value: JsonValue): OrganizeAppsRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("organize_apps takes an object with action");
	const a = value as Record<string, JsonValue>;
	const action = a.action as Action;
	if (!ACTIONS.includes(action)) throw new CloudToolArgumentRefusal(`action must be one of ${ACTIONS.join(", ")}`);
	const fields = FIELDS[action];
	if (
		Object.keys(a).some((key) => key !== "action" && !fields.required.includes(key) && !fields.optional.includes(key))
	)
		throw new CloudToolArgumentRefusal(
			`${action} takes ${[...fields.required, ...fields.optional].join(", ") || "nothing else"}`,
		);
	const missing = fields.required.find((key) => !Object.hasOwn(a, key));
	if (missing) throw new CloudToolArgumentRefusal(`${action} needs ${missing}`);
	const request: Record<string, unknown> = { action };
	if (Object.hasOwn(a, "name")) {
		const name = typeof a.name === "string" ? appGroupName(a.name) : null;
		if (name === null)
			throw new CloudToolArgumentRefusal(
				`name must be one line of 1 to ${APP_GROUP_NAME_MAX_CHARS} characters: one to three words`,
			);
		request.name = name;
	}
	if (Object.hasOwn(a, "parent")) request.parent = a.parent === null ? null : groupRef(a.parent, "parent");
	if (Object.hasOwn(a, "group"))
		request.group = action === "move" && a.group === null ? null : groupRef(a.group, "group");
	if (Object.hasOwn(a, "items")) {
		if (!Array.isArray(a.items) || a.items.length > ITEMS_MAX)
			throw new CloudToolArgumentRefusal(`items must be a list of at most ${ITEMS_MAX} keys`);
		const items = a.items.map((item) => entryRef(item, "each of items"));
		request.items = [...new Set(items)];
	}
	if (Object.hasOwn(a, "item")) request.item = entryRef(a.item, "item");
	if (Object.hasOwn(a, "cursor")) {
		if (typeof a.cursor !== "number" || !Number.isSafeInteger(a.cursor) || a.cursor < 0 || a.cursor > 100000)
			throw new CloudToolArgumentRefusal("cursor must be the cursor a page of list answered");
		request.cursor = a.cursor;
	}
	if (Object.hasOwn(a, "before")) request.before = a.before === null ? null : entryRef(a.before, "before");
	if (Object.hasOwn(a, "colour")) {
		const colour = a.colour === null ? null : AGENT_COLOURS.find((name) => name === a.colour);
		if (colour === undefined)
			throw new CloudToolArgumentRefusal(
				`colour must be one of the palette's colours (${AGENT_COLOURS.join(", ")}), or null for none`,
			);
		// colour_group's null takes a group's colour away; create_group's gives it none, as leaving colour out does.
		if (colour !== null || action === "colour_group") request.colour = colour;
	}
	return request as unknown as OrganizeAppsRequest;
}

/** `organize_apps`, over the run's own view of the company folder. `operations` takes the receipts of its saves. */
export function cloudAppGroupsTool(options: {
	folder: CloudCompanyFolderClient;
	operations: CloudNativeToolOperations;
	identity: CloudNativeToolIdentity;
}): CloudNativeTool {
	const { folder, operations, identity } = options;
	return {
		name: "organize_apps" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: ORGANIZE_APPS_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				name: { type: "string", minLength: 1, maxLength: APP_GROUP_NAME_MAX_CHARS },
				parent: { type: ["string", "null"], maxLength: 46 },
				group: { type: ["string", "null"], maxLength: 46 },
				items: { type: "array", maxItems: ITEMS_MAX, items: { type: "string", maxLength: 80 } },
				item: { type: "string", maxLength: 80 },
				before: { type: ["string", "null"], maxLength: 80 },
				cursor: { type: "integer", minimum: 0, maximum: 100000 },
				colour: { type: ["string", "null"], enum: [...AGENT_COLOURS, null] },
			},
		},
		parseArguments: (value) => parseOrganizeAppsArguments(value) as unknown as JsonValue,
		async execute(value, context) {
			const request = value as unknown as OrganizeAppsRequest;
			context.signal.throwIfAborted();
			if (request.action !== "list" && !operations.completesFolderCommits)
				throw new Error("This run cannot complete folder writes");
			const [found, company] = await Promise.all([
				readGroups(folder, context.signal),
				readCompany(folder, context.signal),
			]);
			const reads = [...company.reads, ...(found ? [found.entry] : [])];
			const file = found ? parseAppGroups(found.text) : { head: HEAD, items: [], notes: [], retired: [] };
			const read = structuredClone(file.items) as Node[];
			const tree = structuredClone(read);
			const retired = [...file.retired];
			// A change answers what it did, never the whole layout, so its answer and its receipt stay small however many
			// apps the company has: list shows the layout, a page at a time.
			const show = (extra: Record<string, unknown>) =>
				cloudToolJsonText({
					schema: "qorpera.app-groups/v1",
					action: request.action,
					file: APP_GROUPS_PATH,
					...extra,
					next: "organize_apps list shows the layout",
				});
			// The reads are released as organize_sidebar releases its own: a runtime tool's answer names no Company File read
			// (the boundary takes a read's provenance only from a company_file tool).
			const answer = async (text: string): Promise<CloudToolContent> => {
				if (!fitsOneResult(text)) throw new Error("An organize_apps answer is larger than one tool result");
				context.observation?.update({ outputBytes: Buffer.byteLength(text) });
				const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
				try {
					await folder.release(
						releaseId(identity.runId, context.callId, outputSha256),
						reads.map(cloudCompanyFolderRelease),
						outputSha256,
						context.signal,
					);
				} catch (error) {
					unavailable(error, "shown");
				}
				return { kind: "text", value: text };
			};
			if (request.action === "list") return answer(listPage(read, company, request.cursor ?? 0));
			const made = apply(request, tree, retired, company);
			if (shape(tree, retired) === shape(read, file.retired))
				return answer(show({ changed: false, ...made, note: "Already so: nothing changed" }));
			const tidied = tidy(tree, company);
			const text = writeAppGroups({ ...file, items: tree, retired });
			if (new TextEncoder().encode(text).byteLength > APP_GROUPS_MAX_BYTES)
				throw new CloudToolRefusal(
					`${APP_GROUPS_PATH} would be larger than ${APP_GROUPS_MAX_BYTES / 1024} KiB: take groups away or move fewer notes into it first`,
				);
			const unit = groupsUnit(text, found?.entry ?? null, company);
			const content = await operations.execute({
				operation: {
					tool: "organize_apps",
					toolVersion: TOOL_VERSION,
					logicalOperationKey: `apps-layout:${context.callId}`,
					arguments: { ...request } as unknown as Record<string, JsonValue>,
					target: { path: APP_GROUPS_PATH },
					requiresCompanyRevision: true,
				},
				// The folder core decides at the commit, under this call's receipt.
				authorize: async () => {},
				perform: async (_operation, { receiptId, signal }) => {
					const committed = await folder.commit(`apps-layout:${receiptId}`, [unit], { receiptId }, signal);
					const written = committed.units[0];
					if (!written || committed.units.length !== 1)
						throw new Error("Company folder commit answered other units");
					const value =
						written.outcome === "saved"
							? show({ changed: true, ...made, ...named("tidied", tidied) })
							: show({
									changed: false,
									refused:
										written.outcome === "conflict"
											? `${APP_GROUPS_PATH} changed since it was read; nothing changed: call again`
											: written.problems.length
												? written.problems.map((problem) => problem.message).join("; ")
												: `Not saved (${written.reason ?? written.outcome})`,
								});
					return { content: { kind: "text", value }, folderCommitId: committed.commitId };
				},
				signal: context.signal,
				...(context.observation ? { observation: context.observation } : {}),
			});
			if (content.kind !== "text") throw new Error("organize_apps answered no text");
			// After the receipt the change is made or settled: an answer that cannot be shown is unconfirmed, never a
			// refusal (which says nothing happened), so the model repeats the call and its replay answers.
			try {
				return await answer(content.value);
			} catch (error) {
				if (error instanceof CloudToolRefusal)
					throw new Error("A committed answer could not be released", { cause: error });
				throw error;
			}
		},
	};
}

/**
 * `save_app`'s `group`: the unit that puts `app:<name>` last in the group `groupId`, or none when the file already
 * lists the app (wherever it stands: moving it is organize_apps' work). Refused, before anything is written, when the
 * file has no such group.
 */
export async function placeAppInGroup(
	folder: CloudCompanyFolderClient,
	name: string,
	groupId: string,
	signal: AbortSignal,
): Promise<{
	readonly unit: CloudCompanyFolderUnit | null;
	readonly read: CloudCompanyFolderFileEntry;
	readonly placed: "added" | "already_listed";
}> {
	const found = await readGroups(folder, signal);
	const file = found ? parseAppGroups(found.text) : null;
	const tree = structuredClone(file?.items ?? []) as Node[];
	const at = findGroup(tree, groupId);
	if (!found || !file || !at)
		throw new CloudToolRefusal(
			`APP_GROUP_NOT_FOUND: ${APP_GROUPS_PATH} has no group ${groupId}; organize_apps list shows the groups and create_group makes one`,
		);
	const key = `app:${name}`;
	if (findItem(tree, key)) return { unit: null, read: found.entry, placed: "already_listed" };
	at.group.items.push({ kind: "item", key, words: "" });
	const text = writeAppGroups({ ...file, items: tree });
	if (new TextEncoder().encode(text).byteLength > APP_GROUPS_MAX_BYTES)
		throw new CloudToolRefusal(
			`APP_GROUP_FULL: ${APP_GROUPS_PATH} would be larger than ${APP_GROUPS_MAX_BYTES / 1024} KiB; leave group out`,
		);
	return {
		unit: {
			op: "write",
			path: found.entry.path,
			content: { text, mediaType: found.entry.file.mediaType },
			expectedVersion: found.entry.version,
		},
		read: found.entry,
		placed: "added",
	};
}

async function readGroups(
	folder: CloudCompanyFolderClient,
	signal: AbortSignal,
): Promise<{ entry: CloudCompanyFolderFileEntry; text: string } | null> {
	try {
		// The reader takes the first 64 KiB; a larger file is still read, and the rest is left out of what is written.
		return await folder.readText(APP_GROUPS_PATH, 16 * APP_GROUPS_MAX_BYTES, signal);
	} catch (error) {
		if (error instanceof CloudCompanyPathNotText)
			throw new CloudToolRefusal(
				`${APP_GROUPS_PATH} is not a text file of at most 1 MiB; replace it with company_write or company_delete first`,
			);
		return unavailable(error, "saved");
	}
}

async function readCompany(folder: CloudCompanyFolderClient, signal: AbortSignal): Promise<Company> {
	const reads: CloudCompanyFolderEntry[] = [];
	const pages = APP_DRAWER_PAGES.map((page) => `page:${page}`);
	const titles = new Map<string, string>(Object.entries(TITLES));
	const none = (appsUsable: boolean, appsExists: boolean): Company => ({
		have: pages,
		titles,
		unposted: new Set(),
		folders: new Set(),
		concepts: new Set(),
		appsUsable,
		appsExists,
		reads,
	});
	let apps: CloudCompanyFolderEntry | null;
	try {
		apps = (await folder.read(APPS_FOLDER, signal)).entry;
	} catch (error) {
		return unavailable(error, "saved");
	}
	if (apps === null) return none(true, false);
	reads.push(apps);
	if (apps.kind !== "folder") return none(false, true);
	let listed: CloudCompanyFolderEntry[];
	try {
		listed = (await folder.listAll(APPS_FOLDER, { maxEntries: APPS_MAX }, signal)).entries;
	} catch (error) {
		if (error instanceof Error && /more entries than its bound/.test(error.message))
			throw new CloudToolRefusal(
				`The company has more than ${APPS_MAX} entries in apps/, more than this tool reads`,
			);
		return unavailable(error, "saved");
	}
	reads.push(...listed);
	const names = listed
		.filter((entry) => entry.kind === "folder")
		.map((entry) => entry.path.slice(APPS_FOLDER.length + 1))
		.filter((name) => isInterfaceName(name))
		.sort();
	const manifests = new Map<string, ReturnType<typeof parseAppManifest> | null>();
	for (let start = 0; start < names.length; start += READS_AT_ONCE)
		await Promise.all(
			names.slice(start, start + READS_AT_ONCE).map(async (name) => {
				let stored: { entry: CloudCompanyFolderFileEntry; text: string } | null = null;
				try {
					stored = await folder.readText(`${APPS_FOLDER}/${name}/${APP_MANIFEST}`, APP_MANIFEST_MAX_BYTES, signal);
				} catch (error) {
					if (!(error instanceof CloudCompanyPathNotText)) return unavailable(error, "saved");
				}
				if (stored) reads.push(stored.entry);
				manifests.set(name, stored ? parseAppManifest(stored.text) : null);
			}),
		);
	const unposted = new Set<string>();
	const concepts = new Set<string>();
	const have: string[] = [...pages];
	for (const name of names) {
		const parsed = manifests.get(name);
		const manifest = parsed?.ok ? parsed.manifest : null;
		// A concept is drawn inside Concepts, not on its own.
		if (manifest?.concept) {
			concepts.add(name);
			continue;
		}
		const key = `app:${name}`;
		have.push(key);
		titles.set(key, manifest?.name ?? name);
		if (!manifest?.posted) unposted.add(key);
	}
	if (concepts.size > 0) have.push("concepts");
	return { have, titles, unposted, folders: new Set(names), concepts, appsUsable: true, appsExists: true, reads };
}

/** Whether the company has a drawer key. Sites is the company's while it has a published site, and What's new (own
 * code storage, step 4) while a repository kept in Qorpera has a site; this tool reads neither, so both are taken, and
 * the drawer leaves them out while there is none. */
function has(company: Company, key: string): boolean {
	return key === "sites" || key === "whats-new" || company.have.includes(key);
}

function refuseKey(company: Company, key: string): never {
	const name = key.startsWith("app:") ? key.slice(4) : null;
	throw new CloudToolRefusal(
		name !== null && company.concepts.has(name)
			? `${key} is a concept: it shows inside concepts, so move concepts instead`
			: `The company has no ${key} in its drawer; organize_apps list shows the keys`,
	);
}

/** Applies a change in place. What a create answers (its id), or nothing; a refusal throws. */
function apply(
	request: OrganizeAppsRequest,
	tree: Node[],
	retired: string[],
	company: Company,
): { group?: string; reused?: true } {
	const missingGroup = (id: string) => new CloudToolRefusal(`No group ${id}; organize_apps list shows the groups`);
	if (request.action === "create_group") {
		const name = request.name ?? "";
		let level = 0;
		let container = tree;
		if (request.parent != null) {
			const parent = findGroup(tree, request.parent);
			if (!parent) throw missingGroup(request.parent);
			if (parent.level + 1 >= APP_GROUP_LEVELS) throw tooDeep();
			level = parent.level + 1;
			container = parent.group.items;
		}
		const same = container.find(
			(node): node is Extract<Node, { kind: "group" }> =>
				node.kind === "group" && node.name.toLowerCase() === name.toLowerCase(),
		);
		let group = same;
		if (!group) {
			const taken = new Set([...allGroups(tree).map((found) => found.group.id), ...retired]);
			group = { kind: "group", id: appGroupSlug(name, taken), name, items: [] };
			// It stands where its first item stood, when that is beside it; else last.
			const first = request.items?.[0];
			const index = first === undefined ? -1 : container.findIndex((node) => refOf(node) === first);
			if (index >= 0) container.splice(index, 0, group);
			else container.push(group);
		}
		// Its entries stand one level below it.
		for (const item of request.items ?? []) move(tree, company, item, group, level + 1, null);
		if (request.colour) group.colour = request.colour;
		return { group: group.id, ...(same ? { reused: true as const } : {}) };
	}
	if (request.action === "rename_group") {
		const found = findGroup(tree, request.group ?? "");
		if (!found) throw missingGroup(request.group ?? "");
		const name = request.name ?? found.group.name;
		const container = found.parent?.items ?? tree;
		if (
			container.some(
				(node) => node !== found.group && node.kind === "group" && node.name.toLowerCase() === name.toLowerCase(),
			)
		)
			throw new CloudToolRefusal("That name is taken by another group there");
		found.group.name = name;
		return {};
	}
	if (request.action === "colour_group") {
		const found = findGroup(tree, request.group ?? "");
		if (!found) throw missingGroup(request.group ?? "");
		if (request.colour) found.group.colour = request.colour;
		else delete found.group.colour;
		return {};
	}
	if (request.action === "ungroup") {
		const id = request.group ?? "";
		const found = findGroup(tree, id);
		// A group already taken away is already so.
		if (!found) {
			if (retired.includes(id)) return {};
			throw missingGroup(id);
		}
		const container = found.parent?.items ?? tree;
		container.splice(container.indexOf(found.group), 1, ...found.group.items);
		retired.push(id);
		return {};
	}
	if (request.action === "move") {
		let target: Extract<Node, { kind: "group" }> | null = null;
		let level = 0;
		if (request.group != null) {
			const found = findGroup(tree, request.group);
			if (!found) throw missingGroup(request.group);
			target = found.group;
			level = found.level + 1;
		}
		move(tree, company, request.item ?? "", target, level, request.before ?? null);
		return {};
	}
	return {};
}

/** Moves an entry (a key or group:<id>) into `target` (null: loose), whose entries stand at `level`, before `before`
 * there or last. */
function move(
	tree: Node[],
	company: Company,
	item: string,
	target: Extract<Node, { kind: "group" }> | null,
	level: number,
	before: string | null,
): void {
	const container = target?.items ?? tree;
	let node: Node;
	if (item.startsWith(APP_GROUP_KEY_PREFIX)) {
		const id = item.slice(APP_GROUP_KEY_PREFIX.length);
		const found = findGroup(tree, id);
		if (!found) throw new CloudToolRefusal(`No group ${id}; organize_apps list shows the groups`);
		if (target && (target === found.group || allGroups(found.group.items).some((inner) => inner.group === target)))
			throw new CloudToolRefusal("A group cannot go inside itself");
		const depth = allGroups(found.group.items).length > 0 ? 2 : 1;
		if (level + depth > APP_GROUP_LEVELS) throw tooDeep();
		node = found.group;
	} else {
		if (!has(company, item)) refuseKey(company, item);
		const found = findItem(tree, item);
		node = found?.node ?? { kind: "item", key: item, words: oneLine(company.titles.get(item) ?? "") };
	}
	if (before === item) throw new CloudToolRefusal("before must name another entry");
	// Already in that group (or loose) with no place asked: it stays where it stands, as organize_sidebar's move does.
	if (before === null && container.includes(node)) return;
	// An entry the file does not list stands loose at the end. To put something last among the loose ones, or before one
	// the file does not list, the unlisted ones are listed first, in the drawer's order.
	if (!target && (before === null || (!container.some((other) => refOf(other) === before) && !findRef(tree, before))))
		for (const key of company.have)
			if (!findItem(tree, key) && key !== item)
				tree.push({ kind: "item", key, words: oneLine(company.titles.get(key) ?? "") });
	detach(tree, node);
	if (before === null) {
		container.push(node);
		return;
	}
	const index = container.findIndex((other) => refOf(other) === before);
	if (index < 0)
		throw new CloudToolRefusal(
			`before must be an entry ${target ? `in group ${target.id}` : "that stands loose"}; organize_apps list shows where each stands`,
		);
	container.splice(index, 0, node);
}

const tooDeep = () =>
	new CloudToolRefusal("Groups go two levels deep at most: a group in a group, never a group in that");

const refOf = (node: Node) => (node.kind === "group" ? `${APP_GROUP_KEY_PREFIX}${node.id}` : node.key);

function allGroups(
	items: Node[],
	parent: Extract<Node, { kind: "group" }> | null = null,
	level = 0,
): { group: Extract<Node, { kind: "group" }>; parent: Extract<Node, { kind: "group" }> | null; level: number }[] {
	return items.flatMap((node) =>
		node.kind === "group" ? [{ group: node, parent, level }, ...allGroups(node.items, node, level + 1)] : [],
	);
}

function findGroup(tree: Node[], id: string) {
	return allGroups(tree).find((found) => found.group.id === id) ?? null;
}

function findItem(items: Node[], key: string): { node: Node; container: Node[] } | null {
	for (const node of items) {
		if (node.kind === "item" && node.key === key) return { node, container: items };
		if (node.kind === "group") {
			const inner = findItem(node.items, key);
			if (inner) return inner;
		}
	}
	return null;
}

function findRef(tree: Node[], ref: string): boolean {
	return ref.startsWith(APP_GROUP_KEY_PREFIX)
		? findGroup(tree, ref.slice(APP_GROUP_KEY_PREFIX.length)) !== null
		: findItem(tree, ref) !== null;
}

function detach(items: Node[], node: Node): void {
	const index = items.indexOf(node);
	if (index >= 0) {
		items.splice(index, 1);
		return;
	}
	for (const other of items) if (other.kind === "group") detach(other.items, node);
}

/** Takes out the apps whose folder is gone, as a change saves: what it took out. */
function tidy(items: Node[], company: Company): string[] {
	const taken: string[] = [];
	for (let index = items.length - 1; index >= 0; index--) {
		const node = items[index] as Node;
		if (node.kind === "group") taken.unshift(...tidy(node.items, company));
		else if (
			company.appsExists &&
			node.key.startsWith("app:") &&
			isAppDrawerKey(node.key) &&
			!company.folders.has(node.key.slice(4))
		) {
			items.splice(index, 1);
			taken.unshift(node.key);
		}
	}
	return taken;
}

/** The layout as the parser compares it: keys and groups (with their colours) in order, and the retired ids. */
const shape = (items: readonly AppGroupNode[] | Node[], retired: readonly string[]): string =>
	JSON.stringify([walkShape(items as readonly AppGroupNode[]), retired]);
const walkShape = (items: readonly AppGroupNode[]): unknown[] =>
	items.map((node) =>
		node.kind === "group" ? [node.id, node.name, node.colour ?? null, walkShape(node.items)] : node.key,
	);

/** What `list` shows, one line an entry in the file's own form, two spaces a level: the drawer as the company has it,
 * every group (empty ones too, to be tidied) with how many posted apps it holds and its colour, and the loose entries the
 * file does not list after the rest; the keys the file lists that the company does not have. */
function layout(
	items: readonly Node[],
	company: Company,
): { lines: string[]; looseApps: number; groups: number; missing: string[] } {
	const seen = new Set<string>();
	const missing: string[] = [];
	const lines: string[] = [];
	let looseApps = 0;
	let groups = 0;
	const entry = (key: string, level: number) =>
		`${"  ".repeat(level)}${key} ${oneLine(company.titles.get(key) ?? key)}${company.unposted.has(key) ? " (not posted)" : ""}`;
	/** Writes the nodes' lines; answers how many posted apps they hold. */
	const walk = (nodes: readonly Node[], level: number): number => {
		let apps = 0;
		for (const node of nodes) {
			if (node.kind === "group") {
				groups++;
				const at = lines.length;
				lines.push("");
				const inner = walk(node.items, level + 1);
				lines[at] =
					`${"  ".repeat(level)}group ${node.id}: ${node.name} (${inner} ${inner === 1 ? "app" : "apps"}${node.colour ? `, ${node.colour}` : ""})`;
				apps += inner;
				continue;
			}
			if (!isAppDrawerKey(node.key) || seen.has(node.key)) continue;
			seen.add(node.key);
			if (!has(company, node.key)) {
				missing.push(node.key);
				continue;
			}
			if (looseCounts(node.key, company)) {
				apps++;
				if (level === 0) looseApps++;
			}
			lines.push(entry(node.key, level));
		}
		return apps;
	};
	walk(items, 0);
	for (const key of company.have)
		if (!seen.has(key)) {
			lines.push(entry(key, 0));
			if (looseCounts(key, company)) looseApps++;
		}
	return { lines, looseApps, groups, missing };
}

/** One page of `list`: the lines from `cursor` on, as many as one tool result holds, and the cursor of the next page. */
function listPage(items: readonly Node[], company: Company, cursor: number): string {
	const { lines, looseApps, groups, missing } = layout(items, company);
	const page = (count: number) =>
		cloudToolJsonText({
			schema: "qorpera.app-groups/v1",
			action: "list",
			file: APP_GROUPS_PATH,
			groups,
			looseApps,
			...(cursor === 0 ? named("notInCompany", missing) : {}),
			layout: lines.slice(cursor, cursor + count),
			...(cursor + count < lines.length
				? { cursor: cursor + count, next: "More lines: call list again with this cursor" }
				: {}),
		});
	// The most lines that fit one tool result: a page too large for a tool's JSON at all does not fit either.
	const fits = (count: number) => {
		try {
			return fitsOneResult(page(count));
		} catch {
			return false;
		}
	};
	let low = Math.min(1, Math.max(0, lines.length - cursor));
	let high = Math.max(0, lines.length - cursor);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) low = middle;
		else high = middle - 1;
	}
	return page(low);
}

/** A title as one line of a list. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A loose entry the Co-Founder's tidy pass counts: a posted app (pages, Concepts, Sites and What's new are the
 * drawer's own). */
const looseCounts = (key: string, company: Company) => key.startsWith("app:") && !company.unposted.has(key);

/** At most this many keys a result names of a kind (tidied, not in the company); it says how many more. */
const NAMED_MAX = 20;
const named = (label: string, keys: readonly string[]) =>
	keys.length === 0
		? {}
		: {
				[label]: keys.slice(0, NAMED_MAX),
				...(keys.length > NAMED_MAX ? { [`${label}More`]: keys.length - NAMED_MAX } : {}),
			};

/** The unit that saves the file: over the version read, as a new file, or with the apps folder when there is none. */
function groupsUnit(text: string, entry: CloudCompanyFolderFileEntry | null, company: Company): CloudCompanyFolderUnit {
	if (entry)
		return {
			op: "write",
			path: entry.path,
			content: { text, mediaType: entry.file.mediaType },
			expectedVersion: entry.version,
		};
	if (!company.appsUsable)
		throw new CloudToolRefusal(`${APPS_FOLDER} is not a folder, so the company's apps have no layout to keep`);
	return company.appsExists
		? { op: "write", path: APP_GROUPS_PATH, content: { text, mediaType: "text/markdown" } }
		: {
				op: "new_folder",
				path: APPS_FOLDER,
				contents: [{ path: "groups.md", kind: "file", content: { text, mediaType: "text/markdown" } }],
			};
}
