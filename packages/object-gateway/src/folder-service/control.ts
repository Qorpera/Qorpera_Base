import { lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { isUuid } from "@qorpera/contracts";
import { ErrorCode, ProtocolError } from "./protocol.ts";
import type { MachineBoundary } from "./service.ts";

/** The folder service's control socket (F3 5c, the plan's "Boundaries"): host-local, for the coding executor alone,
 * which asks it for its coding machines' boundaries. One JSON object a line each way, one request at a time, each
 * answered in order:
 *
 *   {"op":"boundary","machine":"<coding machine id>","final":["<view id>", …]}
 *   → {"boundary":{"machine":…,"reads":…,"views":[…]}} (`MachineBoundary`), or {"error":{"code":…,"message":…}}
 *
 * Node cannot read a connection's peer credentials (SO_PEERCRED), so the kernel checks the peer's uid: connecting to
 * a Unix socket needs write permission on its file. The socket unit (qorpera-folder-control.socket) makes the file the
 * executor's, mode 0600, in a folder only root may change, and a connection is served only while the file still says
 * so (`socketRefusal`); otherwise it is refused at once. Root may connect, as it may do anything on the host. */
export const CONTROL_SOCKET = "/run/qorpera-folder-control/control.sock";

/** A request longer than this ends the connection. */
const MAX_LINE = 64 * 1024;
/** Views named final in one boundary: every session of one machine, with room. */
const MAX_FINAL = 256;
const REFUSED = "This socket admits only the coding executor";

export interface ControlTarget {
	boundary(machine: string, final: readonly string[]): Promise<MachineBoundary>;
}

export interface ControlOptions {
	readonly target: ControlTarget;
	/** The socket's file: whose it is, and who may write it, decides who may connect. */
	readonly path: string;
	/** The coding executor's uid (configuration `codingExecutorUid`); without it every connection is refused. */
	readonly executorUid: number | undefined;
	readonly log: (line: string) => void;
}

/** Why a uid other than the executor's (or root's) might connect to the socket at `path`, or nothing: it must be a
 * socket of the executor's that no one else may write (no group or other bits; an ACL's mask shows as the group
 * bits), in folders that only root or the executor may change (a sticky one's entries only their owners may). */
export function socketRefusal(path: string, executorUid: number | undefined): string | undefined {
	if (executorUid === undefined) return "no executor uid is configured (codingExecutorUid)";
	try {
		const socket = lstatSync(path);
		if (!socket.isSocket()) return `${path} is not a socket`;
		if (socket.uid !== executorUid)
			return `${path} belongs to uid ${socket.uid}, not the executor's (${executorUid})`;
		if ((socket.mode & 0o077) !== 0) return `${path} lets other users connect`;
		for (let folder = dirname(path); ; folder = dirname(folder)) {
			const stats = lstatSync(folder);
			const sticky = (stats.mode & 0o1000) !== 0;
			if (
				!stats.isDirectory() ||
				(stats.uid !== 0 && stats.uid !== executorUid) ||
				((stats.mode & 0o022) !== 0 && !sticky)
			)
				return `${folder} may be changed by another user`;
			if (dirname(folder) === folder) return undefined;
		}
	} catch (error) {
		return `${path} cannot be checked: ${(error as Error).message}`;
	}
}

/** The control server: listen on the socket systemd passes (cli.ts), or on a path (tests). */
export function createControlServer(options: ControlOptions): Server {
	// Half open: an executor that ends its side after its last request still gets the answer.
	return createServer({ allowHalfOpen: true }, (socket) => serve(socket, options));
}

function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function serve(socket: Socket, options: ControlOptions): void {
	socket.on("error", () => undefined);
	const refused = socketRefusal(options.path, options.executorUid);
	if (refused) {
		options.log(`folder-service: control connection refused: ${refused}`);
		// Closed once the answer is out: nothing it sends is read, so a peer that never ends its side holds nothing here.
		socket.end(line({ error: { code: ErrorCode.viewRefused, message: REFUSED } }));
		socket.destroySoon();
		return;
	}
	socket.setEncoding("utf8");
	let buffered = "";
	let busy = false;
	let ended = false;
	let closing = false;
	// One request at a time: the socket is paused while it is answered, and until the answer is written.
	const next = (): void => {
		if (busy || closing || socket.destroyed) return;
		const newline = buffered.indexOf("\n");
		if ((newline === -1 ? buffered.length : newline) > MAX_LINE) {
			closing = true;
			socket.pause();
			socket.end(line({ error: { code: ErrorCode.badRequest, message: "The request is too long" } }));
			socket.destroySoon();
			return;
		}
		if (newline === -1) {
			if (ended) socket.end();
			else socket.resume();
			return;
		}
		const request = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		busy = true;
		socket.pause();
		void answer(request, options).then((reply) => {
			busy = false;
			if (socket.destroyed) return;
			socket.write(line(reply), () => next());
		});
	};
	socket.on("data", (text: string) => {
		if (closing) return;
		buffered += text;
		next();
	});
	socket.on("end", () => {
		ended = true;
		next();
	});
}

async function answer(text: string, options: ControlOptions): Promise<unknown> {
	const request = parseRequest(text);
	if (typeof request === "string") return { error: { code: ErrorCode.badRequest, message: request } };
	try {
		return { boundary: await options.target.boundary(request.machine, request.final) };
	} catch (error) {
		if (error instanceof ProtocolError) return { error: { code: error.code, message: error.message } };
		options.log(`folder-service: control: boundary of ${request.machine} failed: ${(error as Error).message}`);
		return { error: { code: ErrorCode.unavailable, message: "The boundary could not be made now" } };
	}
}

/** A request, or what is wrong with it. */
function parseRequest(text: string): { machine: string; final: string[] } | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "A request is one JSON object a line";
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return "A request is one JSON object a line";
	const request = value as Record<string, unknown>;
	for (const key of Object.keys(request))
		if (key !== "op" && key !== "machine" && key !== "final") return `Unknown request key ${key}`;
	if (request.op !== "boundary") return "The only request is a boundary";
	if (!isUuid(request.machine)) return "machine is a coding machine's id";
	const final = request.final ?? [];
	if (!Array.isArray(final) || final.length > MAX_FINAL || !final.every((id) => isUuid(id)))
		return `final is a list of at most ${MAX_FINAL} view ids`;
	return { machine: request.machine, final: [...new Set(final as string[])] };
}
