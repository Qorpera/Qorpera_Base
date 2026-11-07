import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { isUuid } from "@qorpera/contracts";

// WS18's boot gate and node health (qorpera-os ws/WS18/HEALTH.md at 35fbae9). An image that ships the gate on
// its read-only /usr also runs node health every 15 seconds, so the gate's presence is what makes the record required:
// a write to /etc or /run cannot switch the check off, and a node without the gate (today's nodes) has nothing to read.
const GATE = "/usr/lib/qorpera/qorpera-health";
const RECORD = "/run/qorpera-health/node.json";
const MAX_RECORD_BYTES = 16384;
const MAX_AGE_MS = 45000;
const MAX_CHECKS = 64;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Where the gate and the record are, who must own them (root on a node; a test's own user in tests) and the clock. */
export interface NodeHealthRecordPaths {
	gate?: string;
	record?: string;
	owner?: number;
	now?: () => number;
}

/** Why the record does not let the node take work: a closed code, and for a record that is not ok the local checks
 * that failed, by name only (the record keeps their reasons). */
export class NodeHealthRefusal extends Error {
	readonly entries: string[] | undefined;
	constructor(code: string, entries?: string[]) {
		super(code);
		this.name = "NodeHealthRefusal";
		this.entries = entries;
	}
}

async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new NodeHealthRefusal("NODE_HEALTH_RECORD_UNREADABLE");
	}
}
const ownedSafely = (info: Stats, owner: number): boolean => info.uid === owner && (info.mode & 0o022) === 0;
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** The node health record under HEALTH.md §6's consumer rule, read only when the node's image ships the gate. The
 * node may take work only when `node.json` is there, is this boot's, is at most 45 seconds old by its own `ts_ms`, and
 * says `ok` with no local check failed. Its folder and the file must belong to `owner` and not be group- or
 * world-writable; the file is opened without following a link or blocking, must be a regular file of at most 16 KiB
 * (64 checks with reasons of HEALTH.md's 64 characters fit), and hold one strict JSON record. A refusal is
 * NODE_HEALTH_RECORD_MISSING, _UNSAFE, _UNREADABLE, _INVALID (a `ts_ms` ahead of the clock too), _OTHER_BOOT or
 * _STALE, or NODE_HEALTH_NOT_OK. Remote checks (`remote_ok`) never count. */
export async function assertNodeHealthRecord(
	bootId: string,
	{ gate = GATE, record = RECORD, owner = 0, now = Date.now }: NodeHealthRecordPaths = {},
): Promise<void> {
	if (!(await lstatOrNull(gate))) return;
	const folder = await lstatOrNull(dirname(record));
	if (!folder) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_MISSING");
	if (!folder.isDirectory() || !ownedSafely(folder, owner)) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_UNSAFE");
	// Node health replaces the file by a rename every run: one open and its fstat read one whole record, old or new.
	let bytes: Buffer;
	try {
		const handle = await open(record, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = await handle.stat();
			if (!info.isFile() || !ownedSafely(info, owner)) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_UNSAFE");
			if (info.size > MAX_RECORD_BYTES) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_INVALID");
			bytes = await handle.readFile();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof NodeHealthRefusal) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		throw new NodeHealthRefusal(
			code === "ENOENT"
				? "NODE_HEALTH_RECORD_MISSING"
				: code === "ELOOP"
					? "NODE_HEALTH_RECORD_UNSAFE"
					: "NODE_HEALTH_RECORD_UNREADABLE",
		);
	}
	let value: unknown;
	try {
		if (bytes.length > MAX_RECORD_BYTES) throw new Error();
		value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	} catch {
		throw new NodeHealthRefusal("NODE_HEALTH_RECORD_INVALID");
	}
	const checks = object(value) ? value.checks : undefined;
	const at = now();
	if (
		!object(value) ||
		value.schema !== "qorpera.health/v1" ||
		value.level !== "node" ||
		!isUuid(value.boot_id) ||
		!Number.isSafeInteger(value.ts_ms) ||
		typeof value.ok !== "boolean" ||
		typeof value.final !== "boolean" ||
		!Array.isArray(checks) ||
		checks.length > MAX_CHECKS ||
		!checks.every(
			(check) =>
				object(check) &&
				typeof check.name === "string" &&
				CHECK_NAME.test(check.name) &&
				(check.scope === "local" || check.scope === "remote") &&
				typeof check.ok === "boolean",
		) ||
		(value.ts_ms as number) > at
	)
		throw new NodeHealthRefusal("NODE_HEALTH_RECORD_INVALID");
	if (value.boot_id !== bootId) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_OTHER_BOOT");
	if (at - (value.ts_ms as number) > MAX_AGE_MS) throw new NodeHealthRefusal("NODE_HEALTH_RECORD_STALE");
	const failed = [
		...new Set(
			(checks as Record<string, unknown>[]).flatMap((check) =>
				check.scope === "local" && check.ok === false ? [check.name as string] : [],
			),
		),
	].sort();
	// A record written at the first local failure (`final: false`) is never ok; one that says ok but is not final, or
	// lists a failed local check, is not trusted either.
	if (value.ok !== true || value.final !== true || failed.length > 0)
		throw new NodeHealthRefusal("NODE_HEALTH_NOT_OK", failed);
}
