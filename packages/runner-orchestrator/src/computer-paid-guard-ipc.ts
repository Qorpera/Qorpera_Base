import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type PaidComputerArm,
	type PaidComputerGuard,
	type PaidComputerGuardRecord,
	parsePaidComputerArm,
	parsePaidComputerGuardRecord,
} from "./computer-paid-guard.ts";
import type { LxdOperationReference } from "./lxd-client.ts";
import { checkDirectory, code } from "./lxd-office-journal-files.ts";

const MAX_PACKET = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type PaidComputerGuardRequest =
	| { action: "arm"; input: PaidComputerArm }
	| { action: "start"; permitId: string; generation: number }
	| { action: "stop" | "status"; permitId: string }
	| { action: "latest"; allocationId: string }
	| { action: "list" };

function packet(socket: Socket, maximum = MAX_PACKET): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const fail = () => {
			socket.destroy();
			reject(new Error("PAID_GUARD_IPC_UNCONFIRMED"));
		};
		socket.once("error", fail);
		socket.once("close", () => reject(new Error("PAID_GUARD_IPC_UNCONFIRMED")));
		socket.once("end", () => {
			try {
				resolve(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))));
			} catch {
				fail();
			}
		});
		socket.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maximum) {
				fail();
				return;
			}
			chunks.push(chunk);
		});
	});
}
async function handle(guard: PaidComputerGuard, value: unknown): Promise<unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAID_GUARD_IPC_INVALID");
	const input = value as Record<string, unknown>;
	if (input.action === "arm") return guard.arm(parsePaidComputerArm(input.input));
	if (input.action === "list") return guard.list();
	if (input.action === "latest" && typeof input.allocationId === "string" && UUID.test(input.allocationId))
		return guard.latest(input.allocationId);
	if (typeof input.permitId !== "string" || !UUID.test(input.permitId)) throw new Error("PAID_GUARD_IPC_INVALID");
	if (input.action === "status") return guard.status(input.permitId);
	if (input.action === "stop") return guard.stop(input.permitId);
	if (input.action === "start" && Number.isSafeInteger(input.generation) && Number(input.generation) > 0)
		return guard.start(input.permitId, Number(input.generation));
	throw new Error("PAID_GUARD_IPC_INVALID");
}

/** Dedicated trusted OS account only: private local socket and journal roots.
 * The executor and guard may share that account; neither is a guest/member.
 * Systemd must keep this daemon independent of the executor's process group.
 * No remote listener or observer credential acquires start/stop custody. */
export async function servePaidComputerGuard(options: {
	guard: PaidComputerGuard;
	socketPath: string;
	signal: AbortSignal;
	report?: (state: "ready" | "unconfirmed") => void;
}): Promise<void> {
	const { guard, socketPath, signal } = options;
	if (resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100)
		throw new Error("PAID_GUARD_SOCKET_INVALID");
	await checkDirectory(dirname(socketPath));
	const previous = await lstat(socketPath).catch((error) => {
		if (!code(error, "ENOENT")) throw error;
		return null;
	});
	if (previous) {
		if (!previous.isSocket() || previous.uid !== process.getuid?.() || (previous.mode & 0o7777) !== 0o600)
			throw new Error("PAID_GUARD_SOCKET_UNSAFE");
		// Restart after SIGKILL: remove only a custody-checked endpoint that
		// refuses a connection. A responsive or uncertain peer is never replaced.
		const stale = await new Promise<boolean>((resolve) => {
			const probe = createConnection(socketPath);
			probe.setTimeout(1000, () => {
				probe.destroy();
				resolve(false);
			});
			probe.once("connect", () => {
				probe.destroy();
				resolve(false);
			});
			probe.once("error", (error) => {
				probe.destroy();
				resolve(code(error, "ECONNREFUSED"));
			});
		});
		const after = await lstat(socketPath);
		if (!stale || previous.dev !== after.dev || previous.ino !== after.ino || previous.ctimeMs !== after.ctimeMs)
			throw new Error("PAID_GUARD_SOCKET_EXISTS");
		await unlink(socketPath);
	}
	await guard.initialize();
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		if (sockets.size >= 32) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.setTimeout(15000, () => socket.destroy());
		void packet(socket)
			.then((request) => handle(guard, request))
			.then((result) => {
				const bytes = JSON.stringify({ ok: true, result });
				if (Buffer.byteLength(bytes) > 16 * 1024 ** 2) throw new Error("PAID_GUARD_IPC_TOO_LARGE");
				socket.end(bytes);
			})
			.catch((error: unknown) => {
				const message =
					error instanceof Error && /^PAID_GUARD_[A-Z_]+$/.test(error.message)
						? error.message
						: "PAID_GUARD_UNCONFIRMED";
				socket.end(JSON.stringify({ ok: false, error: message }));
			});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	await chmod(socketPath, 0o600);
	options.report?.("ready");
	try {
		while (!signal.aborted) {
			try {
				await guard.sweep();
			} catch {
				options.report?.("unconfirmed");
			}
			if (!signal.aborted) await delay(1000, undefined, { signal }).catch(() => {});
		}
	} finally {
		// Shutdown is not a renewed permit. Best-effort immediate stop; retained
		// unresolved records are resumed by the independent supervisor restart.
		await Promise.allSettled(
			(await guard.list())
				.filter((record) => record.phase !== "stopped")
				.map((record) => guard.stop(record.permit.permitId)),
		);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await unlink(socketPath).catch((error) => {
			if (!code(error, "ENOENT")) throw error;
		});
	}
}

export class PaidComputerGuardClient {
	readonly #socketPath: string;
	constructor(socketPath: string) {
		if (resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100)
			throw new Error("PAID_GUARD_SOCKET_INVALID");
		this.#socketPath = socketPath;
	}
	async #call(request: PaidComputerGuardRequest, caller?: AbortSignal): Promise<unknown> {
		const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(15000)]);
		signal.throwIfAborted();
		await checkDirectory(dirname(this.#socketPath));
		const stat = await lstat(this.#socketPath);
		if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600)
			throw new Error("PAID_GUARD_SOCKET_UNSAFE");
		const bytes = JSON.stringify(request);
		if (Buffer.byteLength(bytes) > MAX_PACKET) throw new Error("PAID_GUARD_IPC_TOO_LARGE");
		signal.throwIfAborted();
		const socket = createConnection({ path: this.#socketPath, allowHalfOpen: true, signal });
		socket.setTimeout(15000, () => socket.destroy(new Error("PAID_GUARD_IPC_TIMEOUT")));
		try {
			const response = packet(socket, 16 * 1024 ** 2);
			socket.once("connect", () => socket.end(bytes));
			const value = await response;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PAID_GUARD_IPC_INVALID");
			const data = value as Record<string, unknown>;
			if (data.ok !== true)
				throw new Error(
					typeof data.error === "string" && /^PAID_GUARD_[A-Z_]+$/.test(data.error)
						? data.error
						: "PAID_GUARD_IPC_UNCONFIRMED",
				);
			return data.result;
		} finally {
			socket.destroy();
		}
	}
	async arm(input: PaidComputerArm, signal?: AbortSignal): Promise<PaidComputerGuardRecord> {
		return parsePaidComputerGuardRecord(await this.#call({ action: "arm", input }, signal));
	}
	async start(permitId: string, generation: number, signal?: AbortSignal): Promise<LxdOperationReference> {
		const result = await this.#call({ action: "start", permitId, generation }, signal);
		if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("PAID_GUARD_IPC_INVALID");
		const r = result as Record<string, unknown>;
		if (
			typeof r.project !== "string" ||
			!/^[a-z][a-z0-9-]{0,62}$/.test(r.project) ||
			typeof r.instanceName !== "string" ||
			!/^qorpera-coding-machine-[0-9a-f]{32}$/.test(r.instanceName) ||
			typeof r.operationId !== "string" ||
			!UUID.test(r.operationId)
		)
			throw new Error("PAID_GUARD_IPC_INVALID");
		return { project: r.project, instanceName: r.instanceName, operationId: r.operationId };
	}
	async stop(permitId: string, signal?: AbortSignal): Promise<PaidComputerGuardRecord> {
		return parsePaidComputerGuardRecord(await this.#call({ action: "stop", permitId }, signal));
	}
	async status(permitId: string, signal?: AbortSignal): Promise<PaidComputerGuardRecord> {
		return parsePaidComputerGuardRecord(await this.#call({ action: "status", permitId }, signal));
	}
	async latest(allocationId: string, signal?: AbortSignal): Promise<PaidComputerGuardRecord | null> {
		const result = await this.#call({ action: "latest", allocationId }, signal);
		return result === null ? null : parsePaidComputerGuardRecord(result);
	}
	async list(signal?: AbortSignal): Promise<PaidComputerGuardRecord[]> {
		const result = await this.#call({ action: "list" }, signal);
		if (!Array.isArray(result) || result.length > 4096) throw new Error("PAID_GUARD_IPC_INVALID");
		return result.map(parsePaidComputerGuardRecord);
	}
}
