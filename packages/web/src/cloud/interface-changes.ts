import type {
	CloudMemberFolderClient,
	CloudMemberFolderEntry,
	CloudMemberFolderFile,
	CloudMemberFolderOp,
	CloudMemberFolderUnit,
	CloudMemberFolderUnitResult,
} from "@qorpera/cloud-client/cloud-member-folder";
import { companyPathKey } from "@qorpera/cloud-client/company-state-files";
import { array, boundedInteger, CloudShapeError, oneOf, record, uuid } from "./parse.ts";

/*
 * An agent's change to the company's pages and tables, and its Undo (Interfaces I10; deploy/first-node/
 * RUNTIME-INTERFACES.md §7 and §9 decision 2). A change that needs no review is saved at once, whatever tool or machine
 * carried it, and the runtime notes it in the agent's conversation: a session_info event naming the commit and each
 * path version it made under interfaces/ and tables/ (a table's rows are its data, never in a note), with the version
 * before it. Undo is the member's own change set, through the member commit route (C4), based on those versions: a
 * path the commit made is deleted, a file it rewrote gets its earlier text back. When anything the commit made changed
 * since, nothing is undone; the member sees why.
 */

export const INTERFACE_CHANGE_SCHEMA = "qorpera.interface-change/v1";

/** One path version the agent's commit made, with the version it replaced (null for a new path). */
export interface InterfaceChangePath {
	readonly unit: number;
	readonly op: CloudMemberFolderOp;
	readonly kind: "file" | "folder";
	readonly path: string;
	readonly version: string;
	readonly priorVersion: string | null;
}

export interface InterfaceChange {
	readonly commitId: string;
	/** The folder seq the commit saved at. */
	readonly seq: number;
	readonly runId: string;
	readonly staffAgentId: string;
	readonly changes: readonly InterfaceChangePath[];
}

/** What Undo answered. `changed`: something the agent's change made changed since, so nothing was sent. `too_large`
 * and `unavailable`: this change can't be undone in one change set of the member's, or its earlier text can't be read.
 * `not_saved`: the core did not save every unit; `result` is the first one it did not save. */
export type InterfaceUndo =
	| { readonly outcome: "undone"; readonly already: boolean }
	| { readonly outcome: "changed" }
	| { readonly outcome: "too_large" }
	| { readonly outcome: "unavailable" }
	| { readonly outcome: "not_saved"; readonly saved: number; readonly result: CloudMemberFolderUnitResult };

/** What Undo needs of the member's folder client. */
export type InterfaceUndoFolder = Pick<CloudMemberFolderClient, "read" | "pathHistory" | "readFile" | "commit">;

const OPS: readonly CloudMemberFolderOp[] = ["write", "mkdir", "delete", "move_out", "move_in", "copy"];
const KINDS = ["file", "folder"] as const;
/** The member commit route's limits: units a change set, bytes a file's text and a change set's. */
const MAX_UNITS = 16;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
/** A path under interfaces/ or tables/, by its key: the folder's paths are one path in any case. */
const UNDER = /^(?:interfaces|tables)\/[^/]+(?:\/[^/]+)*$/;

/** A note's body as an interface change, or null when it is not a well-formed one: every path is under interfaces/ or
 * tables/, since a note names nothing else. */
export function parseInterfaceChange(value: unknown): InterfaceChange | null {
	try {
		const body = record(value, "interface change");
		if (body.schema !== INTERFACE_CHANGE_SCHEMA) return null;
		const items = array(body.changes, "interface change paths");
		if (!items.length) return null;
		const changes = items.map((item): InterfaceChangePath => {
			const change = record(item, "interface change path");
			const { path } = change;
			if (
				typeof path !== "string" ||
				path.length > 1024 ||
				!UNDER.test(companyPathKey(path)) ||
				path.split("/").some((part) => part === "." || part === "..")
			)
				throw new CloudShapeError("interface change path");
			return {
				unit: boundedInteger(change.unit, "interface change unit", 1, Number.MAX_SAFE_INTEGER),
				op: oneOf(change.op, OPS, "interface change op"),
				kind: oneOf(change.kind, KINDS, "interface change kind"),
				path,
				version: uuid(change.version, "interface change version"),
				priorVersion: change.priorVersion === null ? null : uuid(change.priorVersion, "interface change version"),
			};
		});
		return {
			commitId: uuid(body.commitId, "interface change commit"),
			seq: boundedInteger(body.seq, "interface change seq", 1, Number.MAX_SAFE_INTEGER),
			runId: uuid(body.runId, "interface change run"),
			staffAgentId: uuid(body.staffAgentId, "interface change agent"),
			changes,
		};
	} catch (error) {
		if (error instanceof CloudShapeError) return null;
		throw error;
	}
}

/** An interface or a table a change touched, by its folder's name as the note first spells it. `made`: the change made
 * its folder; `removed`: it deleted its folder or moved it away. */
export interface InterfaceChangeSubject {
	readonly kind: "interface" | "table";
	readonly name: string;
	readonly how: "made" | "changed" | "removed";
}

/** What a change touched, for its line: the interfaces and tables in the note's order, and whether it changed
 * `interfaces/order.md`. A path in an interface's or a table's folder counts as that one's. */
export function interfaceChangeSubjects(change: InterfaceChange): {
	subjects: InterfaceChangeSubject[];
	order: boolean;
} {
	const subjects = new Map<string, { -readonly [K in keyof InterfaceChangeSubject]: InterfaceChangeSubject[K] }>();
	let order = false;
	for (const { path, op } of change.changes) {
		const [top, folder, ...rest] = companyPathKey(path).split("/");
		const name = path.split("/")[1];
		if (!name || !folder) continue;
		if (top === "interfaces" && folder === "order.md" && !rest.length) {
			order = true;
			continue;
		}
		let subject = subjects.get(`${top}/${folder}`);
		if (!subject) {
			subject = { kind: top === "interfaces" ? "interface" : "table", name, how: "changed" };
			subjects.set(`${top}/${folder}`, subject);
		}
		if (rest.length) continue;
		if (op === "mkdir") subject.how = "made";
		else if (op === "delete" || op === "move_out") subject.how = "removed";
	}
	return { subjects: [...subjects.values()], order };
}

/** Whether Undo can take this change back at all, before reading anything: it made folders and wrote files. A delete,
 * move or copy by the agent is not undone here. */
export function interfaceChangeUndoable(change: InterfaceChange): boolean {
	return steps(change).every((step) => step !== null);
}

type Step =
	| {
			readonly change: InterfaceChangePath;
			readonly action: "delete";
			readonly inside: readonly InterfaceChangePath[];
	  }
	| { readonly change: InterfaceChangePath; readonly action: "restore" };

/** What Undo does with each path the change made, before reading anything: a folder it made is deleted with what it
 * made under it; a file it wrote new is deleted; a file it rewrote gets its version before back. Anything else is null:
 * a delete, move or copy, a path it saved twice, and a folder it made that holds something moved or copied in, which
 * deleting the folder would delete too. A path it made under a folder it made goes with that folder, so it has no step
 * of its own. */
function steps(change: InterfaceChange): (Step | null)[] {
	const key = (path: string) => companyPathKey(path);
	const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
	const folderMade = (item: InterfaceChangePath) => item.op === "mkdir" && item.kind === "folder";
	const fileWritten = (item: InterfaceChangePath) => item.op === "write" && item.kind === "file";
	if (new Set(change.changes.map((item) => key(item.path))).size !== change.changes.length) return [null];
	const made = new Set(change.changes.filter(folderMade).map((item) => key(item.path)));
	// A root is a folder the commit made in a folder it did not make; what it made under a root goes with the root.
	const roots = change.changes.filter((item) => folderMade(item) && !made.has(key(parent(item.path))));
	const rootOf = (item: InterfaceChangePath) =>
		roots.find((root) => root !== item && key(item.path).startsWith(`${key(root.path)}/`));
	return change.changes.flatMap((item): (Step | null)[] => {
		// Under a root was nothing before the commit, so a folder made or a file written there is new.
		if (rootOf(item)) return folderMade(item) || fileWritten(item) ? [] : [null];
		if (folderMade(item))
			return [{ change: item, action: "delete", inside: change.changes.filter((other) => rootOf(other) === item) }];
		if (!fileWritten(item)) return [null];
		if (item.priorVersion === null) return [{ change: item, action: "delete", inside: [] }];
		return [{ change: item, action: "restore" }];
	});
}

type Target =
	| {
			readonly change: InterfaceChangePath;
			/** Delete what the commit made. A folder it made is deleted as of the commit's seq, so the core refuses it
			 * when anything under it changed since; `inside` is what the commit made under it. */
			readonly action: "delete";
			readonly inside: readonly InterfaceChangePath[];
	  }
	| { readonly change: InterfaceChangePath; readonly action: "restore"; readonly prior: CloudMemberFolderFile };

/** Undoes an agent's interface change as the member: one change set, the last unit's change first. `check` throws when
 * the member's access changed while it waited. */
export async function undoInterfaceChange(
	folder: InterfaceUndoFolder,
	change: InterfaceChange,
	signal: AbortSignal,
	check: () => void,
): Promise<InterfaceUndo> {
	const known = steps(change);
	if (known.some((step) => step === null)) return { outcome: "unavailable" };
	const targets = await Promise.all(
		(known as Step[]).map((step) => (step.action === "delete" ? step : priorOf(folder, step.change, signal))),
	);
	check();
	if (targets.some((target) => target === null)) return { outcome: "unavailable" };
	const planned = targets as Target[];

	const reads = await Promise.all(
		planned.map(async (target) => ({
			target,
			entry: (await folder.read(target.change.path, signal)).entry,
			inside: await Promise.all(
				target.action === "delete"
					? target.inside.map(async (item) => ({ item, entry: (await folder.read(item.path, signal)).entry }))
					: [],
			),
		})),
	);
	check();
	const states = reads.map(({ target, entry, inside }) => {
		if (entry?.version === target.change.version)
			return inside.every((read) => read.entry?.version === read.item.version) ? "pending" : "changed";
		if (target.action === "delete") return entry === null ? "before" : "changed";
		return sameFile(entry, target.prior) ? "before" : "changed";
	});
	if (states.includes("changed")) return { outcome: "changed" };
	const pending = planned.flatMap((target, index) => (states[index] === "pending" ? [{ target, index }] : []));
	if (!pending.length) return { outcome: "undone", already: true };

	const restores = pending.flatMap(({ target }) => (target.action === "restore" ? [target.prior] : []));
	if (
		pending.length > MAX_UNITS ||
		restores.some((prior) => prior.bytes > MAX_FILE_BYTES) ||
		restores.reduce((total, prior) => total + prior.bytes, 0) > MAX_TEXT_BYTES
	)
		return { outcome: "too_large" };
	const texts = await Promise.all(
		pending.map(async ({ target }) =>
			target.action === "restore" ? utf8(await folder.readFile(target.prior, signal, MAX_FILE_BYTES)) : null,
		),
	);
	check();
	if (texts.some((text, index) => text === null && pending[index]?.target.action === "restore"))
		return { outcome: "unavailable" };

	const units = pending
		.map(({ target }, index) => ({ target, text: texts[index] ?? null }))
		.sort((a, b) => b.target.change.unit - a.target.change.unit)
		.map(({ target, text }): CloudMemberFolderUnit => {
			const { path, version } = target.change;
			if (target.action === "restore") return { op: "write", path, text: text ?? "", expectedVersion: version };
			return target.change.kind === "folder"
				? { op: "delete", path, expectedVersion: version, asOfSeq: change.seq }
				: { op: "delete", path, expectedVersion: version };
		});
	// The same units under the same key replay one change set; a part already undone makes another set, so another key.
	const operationKey =
		pending.length === planned.length
			? `interface-undo:${change.commitId}`
			: `interface-undo:${change.commitId}:${pending.map(({ index }) => index).join(".")}`;
	const answer = await folder.commit(operationKey, units, signal);
	check();
	if (answer.units.length !== units.length) throw new Error("The company folder answered another change");
	const failed = answer.units.filter((result) => result.outcome !== "saved");
	const [first] = failed;
	if (!first) return { outcome: "undone", already: false };
	if (failed.length === units.length && failed.every((result) => result.outcome === "conflict"))
		return { outcome: "changed" };
	return { outcome: "not_saved", saved: units.length - failed.length, result: first };
}

/** The version before `item`'s, as a restore of its file or a delete when the path was gone then; null when it can't
 * be undone here (no such version, or a folder there). */
async function priorOf(
	folder: InterfaceUndoFolder,
	item: InterfaceChangePath,
	signal: AbortSignal,
): Promise<Target | null> {
	const history = await folder.pathHistory(item.path, item.version, 1, signal);
	const prior = history.items[0];
	if (!prior || prior.version !== item.priorVersion) return null;
	if (prior.kind === "file" && prior.file) return { change: item, action: "restore", prior: prior.file };
	if (prior.op === "delete" || prior.op === "move_out") return { change: item, action: "delete", inside: [] };
	return null;
}

function sameFile(entry: CloudMemberFolderEntry | null, file: CloudMemberFolderFile): boolean {
	return entry?.kind === "file" && entry.file?.fileSha256 === file.fileSha256;
}

/** Strict UTF-8, a byte-order mark kept; null when the bytes are not text. */
function utf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}
