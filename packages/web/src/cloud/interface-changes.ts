import type { CloudMemberFolderOp } from "@qorpera/cloud-client/cloud-member-folder";
import { osRelative } from "@qorpera/cloud-client/company-state-files";
import { array, boundedInteger, CloudShapeError, oneOf, record, uuid } from "./parse.ts";

/*
 * An agent's change to the company's pages and tables, and its Undo (Interfaces I10; deploy/first-node/
 * RUNTIME-INTERFACES.md §7 and §9 decision 2). A change that needs no review is saved at once, whatever tool or machine
 * carried it, and the runtime notes it in the agent's conversation: a session_info event naming the commit and each
 * path version it made under QorperaOS/interfaces/ and QorperaOS/tables/ (a table's rows are its data, never in a
 * note), with the version before it. Undo is the member's own change set, through the member commit route (C4), based
 * on those versions: a path the commit made is deleted, a file it rewrote gets its earlier text back. When anything the
 * commit made changed since, nothing is undone; the member sees why.
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

const OPS: readonly CloudMemberFolderOp[] = ["write", "mkdir", "delete", "move_out", "move_in", "copy"];
const KINDS = ["file", "folder"] as const;
const UNDER = /^(?:interfaces|tables)\/[^/]+(?:\/[^/]+)*$/;

/** A note's body as an interface change, or null when it is not a well-formed one: every path is under
 * QorperaOS/interfaces/ or QorperaOS/tables/, since a note names nothing else. */
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
				!UNDER.test(osRelative(companyPathKey(path)) ?? "") ||
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
 * `QorperaOS/interfaces/order.md`. A path in an interface's or a table's folder counts as that one's. */
export function interfaceChangeSubjects(change: InterfaceChange): {
	subjects: InterfaceChangeSubject[];
	order: boolean;
} {
	const subjects = new Map<string, { -readonly [K in keyof InterfaceChangeSubject]: InterfaceChangeSubject[K] }>();
	let order = false;
	for (const { path, op } of change.changes) {
		// Below QorperaOS/, as the note spells it.
		const below = osRelative(path);
		if (below === null) continue;
		const [top, folder, ...rest] = companyPathKey(below).split("/");
		const name = below.split("/")[1];
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
