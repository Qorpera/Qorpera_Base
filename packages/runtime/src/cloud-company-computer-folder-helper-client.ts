import { createConnection } from "node:net";

/**
 * The office service's door to the folder helper (qorpera-office-folder-helper.socket): the root helper that mounts
 * the company folder for each desktop and command (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Mounts in the VM"). The stop
 * control, root, asks it too.
 */
export const COMPANY_COMPUTER_FOLDER_HELPER_SOCKET = "/run/qorpera-folder-helper/helper.sock";
/** Where the helper keeps every mount: root's, in memory. */
export const COMPANY_COMPUTER_FOLDER_ROOT = "/run/qorpera-folder";

/**
 * One mount's files: its view file (root, 0600), its state folder (the program's read log and version map, made
 * empty at `mount`, kept across `switch`), and its parent, bound onto itself and shared, with the program's FUSE
 * mount at `company` inside. A desktop's or a command's sandbox binds the parent and finds `/company` in it, so a
 * remount reaches it (Q3); a bind of `company` itself would keep a dead mount.
 */
export function companyComputerFolderPaths(name: string, root = COMPANY_COMPUTER_FOLDER_ROOT) {
	if (!isCompanyComputerFolderName(name)) throw new Error("INVALID_COMPANY_COMPUTER_FOLDER_NAME");
	return {
		view: `${root}/views/${name}.json`,
		state: `${root}/state/${name}`,
		parent: `${root}/mounts/${name}`,
		mountpoint: `${root}/mounts/${name}/company`,
	};
}

/** A mount's name: its desktop's screen or its command. */
const NAME = /^(desktop|command)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longest request line: a view is three values of at most 256 bytes. */
export const COMPANY_COMPUTER_FOLDER_REQUEST_BYTES = 4096;
/** Longest answer line: a boundary's report lists every changed path. */
export const COMPANY_COMPUTER_FOLDER_ANSWER_BYTES = 16 * 1024 * 1024;
/** A boundary's publish runs at most this long by default, and never longer than the maximum. */
export const COMPANY_COMPUTER_FOLDER_BOUNDARY_MS = 30000;
export const COMPANY_COMPUTER_FOLDER_BOUNDARY_MAXIMUM_MS = 120000;

/** The core's view as the folder program reads it from its view file. Only the office service and the helper see
 * the pass; it never reaches a desktop or a command. */
export interface CompanyComputerFolderView {
	readonly environmentId: string;
	readonly viewId: string;
	readonly pass: string;
}

export type CompanyComputerFolderRequest =
	| { readonly op: "mount" | "switch"; readonly name: string; readonly view: CompanyComputerFolderView }
	| { readonly op: "boundary" | "unmount"; readonly name: string; readonly final: boolean; readonly timeoutMs: number }
	| { readonly op: "drop"; readonly name: string }
	| { readonly op: "list" };

/** What `qorpera-folder publish --json` prints: each changed path's outcome, or the boundary's refusal. */
export interface CompanyComputerFolderReport {
	readonly commitId: string | null;
	readonly seq: number | null;
	readonly paths: ReadonlyArray<{
		readonly path: string;
		readonly outcome: string;
		readonly reason?: string;
		readonly receipt?: string;
		readonly kept?: boolean;
	}>;
	readonly refused?: string;
	readonly closed?: boolean;
}

/**
 * A boundary's answer, from the publish's exit code: `saved` (every path saved, or nothing pending), `refused` (a
 * path not saved or the boundary refused: the report says which and why; the caller decides whether that is final),
 * `closed` (the view is closed: the program exited 3, or the publish found the view closed), and `unanswered`
 * (no answer, whether the boundary ran is unknown; a report may still have come before the failure).
 */
export type CompanyComputerFolderBoundary =
	| { readonly answer: "saved" | "refused"; readonly report: CompanyComputerFolderReport }
	| { readonly answer: "closed" }
	| { readonly answer: "unanswered"; readonly report?: CompanyComputerFolderReport };

export interface CompanyComputerFolderMount {
	readonly name: string;
	readonly viewId: string;
	/** Its program: `running`, `restarting` (systemd starts it again), `closed` (exited 3), `stopped` (exited
	 * otherwise and not started again) or `unknown`. */
	readonly program: "running" | "restarting" | "closed" | "stopped" | "unknown";
}

/** What each request may be answered. Any request may also get `invalid` (malformed). */
export interface CompanyComputerFolderAnswers {
	/** `held`: the name is mounted already. `closed`: the node closed or refused the view, so nothing is mounted.
	 * `unanswered`: no mount came in time. `failed`: the helper could not make it. Every answer but `mounted` and
	 * `held` gives the name back, unless taking the mount away failed too: then the name stays held, `list` shows it
	 * and `drop` takes it away. */
	readonly mount: { readonly answer: "mounted" | "held" | "closed" | "unanswered" | "failed" };
	/** `pending`: the program has not yet said hello with the newer view (it keeps trying, and a boundary or a
	 * restart carries it). `refused`: another company, a command's mount, or another pass for the same view; the view
	 * file is unchanged. `unknown`: no mount of that name. */
	readonly switch: { readonly answer: "switched" | "pending" | "closed" | "refused" | "unknown" | "failed" };
	readonly boundary: CompanyComputerFolderBoundary | { readonly answer: "unknown" };
	/** The boundary's answer, and whether the mount went: only after `saved` or `closed`. After any other answer
	 * the mount stays; a caller that takes that answer as final drops it. */
	readonly unmount: (CompanyComputerFolderBoundary & { readonly unmounted: boolean }) | { readonly answer: "unknown" };
	/** `failed`: something of the mount stayed; it is still listed and can be dropped again. */
	readonly drop: { readonly answer: "dropped" | "unknown" | "failed" };
	readonly list:
		| { readonly answer: "list"; readonly mounts: readonly CompanyComputerFolderMount[] }
		| {
				readonly answer: "failed";
		  };
}

export type CompanyComputerFolderAnswer<
	Op extends CompanyComputerFolderRequest["op"] = CompanyComputerFolderRequest["op"],
> = CompanyComputerFolderAnswers[Op] | { readonly answer: "invalid" };

export function companyComputerFolderName(kind: "desktop" | "command", id: string): string {
	const name = `${kind}-${id}`;
	if (!NAME.test(name)) throw new Error("INVALID_COMPANY_COMPUTER_FOLDER_NAME");
	return name;
}

export function isCompanyComputerFolderName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

/** As the folder program checks a view file: each value printable ASCII without spaces, 1 to 256 bytes. */
export function isCompanyComputerFolderView(value: unknown): value is CompanyComputerFolderView {
	if (!isRecord(value) || !exactKeys(value, ["environmentId", "viewId", "pass"])) return false;
	return [value.environmentId, value.viewId, value.pass].every(
		(part) => typeof part === "string" && /^[\x21-\x7e]{1,256}$/.test(part),
	);
}

/** The helper's side: one request line, exactly as the client sends it. */
export function parseCompanyComputerFolderRequest(line: string): CompanyComputerFolderRequest | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	switch (value.op) {
		case "list":
			return exactKeys(value, ["op"]) ? { op: "list" } : undefined;
		case "drop":
			return exactKeys(value, ["op", "name"]) && isCompanyComputerFolderName(value.name)
				? { op: "drop", name: value.name }
				: undefined;
		case "mount":
		case "switch":
			return exactKeys(value, ["op", "name", "view"]) &&
				isCompanyComputerFolderName(value.name) &&
				isCompanyComputerFolderView(value.view)
				? {
						op: value.op,
						name: value.name,
						view: { environmentId: value.view.environmentId, viewId: value.view.viewId, pass: value.view.pass },
					}
				: undefined;
		case "boundary":
		case "unmount":
			// Only a command has a last boundary, which closes its view.
			return exactKeys(value, ["op", "name", "final", "timeoutMs"]) &&
				isCompanyComputerFolderName(value.name) &&
				typeof value.final === "boolean" &&
				(!value.final || value.name.startsWith("command-")) &&
				Number.isSafeInteger(value.timeoutMs) &&
				(value.timeoutMs as number) >= 1000 &&
				(value.timeoutMs as number) <= COMPANY_COMPUTER_FOLDER_BOUNDARY_MAXIMUM_MS
				? { op: value.op, name: value.name, final: value.final, timeoutMs: value.timeoutMs as number }
				: undefined;
		default:
			return undefined;
	}
}

/**
 * Ask the folder helper one request. Resolves to its answer, or to undefined when none came (no helper, a closed
 * connection, a malformed answer or the deadline): the caller treats that as a boundary or mount with no answer.
 */
export function askCompanyComputerFolderHelper<Request extends CompanyComputerFolderRequest>(
	request: Request,
	options: { socket?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CompanyComputerFolderAnswer<Request["op"]> | undefined> {
	const line = `${JSON.stringify(request)}\n`;
	if (
		Buffer.byteLength(line) > COMPANY_COMPUTER_FOLDER_REQUEST_BYTES ||
		parseCompanyComputerFolderRequest(line.trimEnd()) === undefined ||
		options.signal?.aborted
	)
		return Promise.resolve(undefined);
	// The helper answers within the request's own deadline and its clean-up; the client waits that long for the line.
	const waitMs =
		options.timeoutMs ?? (request.op === "boundary" || request.op === "unmount" ? request.timeoutMs + 60000 : 90000);
	return new Promise((resolve) => {
		const socket = createConnection(options.socket ?? COMPANY_COMPUTER_FOLDER_HELPER_SOCKET);
		const chunks: Buffer[] = [];
		let length = 0,
			done = false;
		const finish = (answer: CompanyComputerFolderAnswer<Request["op"]> | undefined): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			socket.destroy();
			resolve(answer);
		};
		const abort = () => finish(undefined);
		const timer = setTimeout(abort, waitMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		socket.on("error", abort);
		socket.on("end", abort);
		socket.on("data", (chunk: Buffer) => {
			const newline = chunk.indexOf(0x0a);
			if (newline < 0) {
				length += chunk.length;
				if (length > COMPANY_COMPUTER_FOLDER_ANSWER_BYTES) finish(undefined);
				else chunks.push(chunk);
				return;
			}
			if (length + newline > COMPANY_COMPUTER_FOLDER_ANSWER_BYTES) return finish(undefined);
			chunks.push(chunk.subarray(0, newline));
			let text: string;
			try {
				text = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
			} catch {
				return finish(undefined);
			}
			finish(parseCompanyComputerFolderAnswer(request.op, text));
		});
		socket.once("connect", () => socket.write(line));
	});
}

/** The plain answers each request may get, besides a boundary's and a list's. */
const PLAIN: Record<CompanyComputerFolderRequest["op"], readonly string[]> = {
	mount: ["mounted", "held", "closed", "unanswered", "failed", "invalid"],
	switch: ["switched", "pending", "closed", "refused", "unknown", "failed", "invalid"],
	boundary: ["unknown", "invalid"],
	unmount: ["unknown", "invalid"],
	drop: ["dropped", "unknown", "failed", "invalid"],
	list: ["failed", "invalid"],
};

/** The answers each request may get; anything else is no answer. */
export function parseCompanyComputerFolderAnswer<Op extends CompanyComputerFolderRequest["op"]>(
	op: Op,
	line: string,
): CompanyComputerFolderAnswer<Op> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.answer !== "string") return undefined;
	if (PLAIN[op].includes(value.answer)) return exactKeys(value, ["answer"]) ? (value as never) : undefined;
	if (op === "boundary") return boundary(value, []) ? (value as never) : undefined;
	if (op === "unmount")
		return boundary(value, ["unmounted"]) && typeof value.unmounted === "boolean" ? (value as never) : undefined;
	if (op === "list")
		return value.answer === "list" &&
			exactKeys(value, ["answer", "mounts"]) &&
			Array.isArray(value.mounts) &&
			value.mounts.every(
				(mount) =>
					isRecord(mount) &&
					exactKeys(mount, ["name", "viewId", "program"]) &&
					isCompanyComputerFolderName(mount.name) &&
					typeof mount.viewId === "string" &&
					["running", "restarting", "closed", "stopped", "unknown"].includes(mount.program as string),
			)
			? (value as never)
			: undefined;
	return undefined;
}

function boundary(value: Record<string, unknown>, extra: string[]): boolean {
	switch (value.answer) {
		case "saved":
		case "refused":
			return exactKeys(value, ["answer", "report", ...extra]) && isCompanyComputerFolderReport(value.report);
		case "closed":
			return exactKeys(value, ["answer", ...extra]);
		case "unanswered":
			return value.report === undefined
				? exactKeys(value, ["answer", ...extra])
				: exactKeys(value, ["answer", "report", ...extra]) && isCompanyComputerFolderReport(value.report);
		default:
			return false;
	}
}

export function isCompanyComputerFolderReport(value: unknown): value is CompanyComputerFolderReport {
	if (!isRecord(value) || !Array.isArray(value.paths)) return false;
	if (!(value.commitId === null || typeof value.commitId === "string")) return false;
	if (!(value.seq === null || (Number.isSafeInteger(value.seq) && (value.seq as number) >= 0))) return false;
	if (value.refused !== undefined && typeof value.refused !== "string") return false;
	if (value.closed !== undefined && typeof value.closed !== "boolean") return false;
	if (Object.keys(value).some((key) => !["commitId", "seq", "paths", "refused", "closed"].includes(key))) return false;
	return value.paths.every(
		(entry) =>
			isRecord(entry) &&
			typeof entry.path === "string" &&
			typeof entry.outcome === "string" &&
			(entry.reason === undefined || typeof entry.reason === "string") &&
			(entry.receipt === undefined || typeof entry.receipt === "string") &&
			(entry.kept === undefined || typeof entry.kept === "boolean") &&
			Object.keys(entry).every((key) => ["path", "outcome", "reason", "receipt", "kept"].includes(key)),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
