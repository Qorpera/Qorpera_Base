import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Transform, type TransformCallback } from "node:stream";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_MAX_LEASE_MS,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import { CompanyComputerRfbClientParser } from "./cloud-company-computer-rfb.ts";
import { CompanyComputerRfbServerParser } from "./cloud-company-computer-rfb-server.ts";

export const COMPANY_COMPUTER_VIEW_SCHEMA = "qorpera.company-computer-screen-view/v2";
export const COMPANY_COMPUTER_VIEW_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface CompanyComputerViewerGrant {
	binding: CompanyComputerScreenBinding;
	viewerSessionId: string;
	memberId: string;
	mode: "watch" | "control";
	validForMs: number;
	/** Only an acknowledged member takeover may mint a control connection. */
	lease?: CompanyComputerScreenLease;
}

export interface CompanyComputerViewerAuthority {
	/** Existing single-use view-capability ledger, with fresh membership/grant and exact-screen checks. */
	redeem(capability: string, signal: AbortSignal): Promise<CompanyComputerViewerGrant>;
	/** Includes revocation, handoff privacy, assignment generation and current takeover epoch. */
	check(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<CompanyComputerViewerGrant>;
	/** Existing effect/audit boundary. Recheck immediately before forward; do not log raw keystrokes/secrets. */
	forwardInput(
		grant: CompanyComputerViewerGrant,
		input: { sequence: number; sha256: string; bytes: Uint8Array },
		forward: () => void,
		signal: AbortSignal,
	): Promise<void>;
	/** Removes only this exact viewer presence/lease, never a replacement connection. */
	release(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<void>;
}

export interface CompanyComputerViewerGuestTransport {
	/** Resolve this exact registry/journal binding, authenticate the guest leg, return a paused raw RFB socket. */
	connect(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<{ socket: Socket; remainder: Buffer }>;
}

export function assertPrivateCompanyComputerAddress(host: string): void {
	if (host === "::1") return;
	const octets = host.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
		octets.join(".") !== host
	) {
		throw new Error("PRIVATE_VIEWER_ADDRESS_REQUIRED");
	}
	if (
		octets[0] === 127 ||
		octets[0] === 10 ||
		(octets[0] === 192 && octets[1] === 168) ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
	)
		return;
	throw new Error("PRIVATE_VIEWER_ADDRESS_REQUIRED");
}

export function assertCompanyComputerViewerGrant(
	grant: CompanyComputerViewerGrant,
	previous?: CompanyComputerViewerGrant,
): void {
	assertCompanyComputerScreenBinding(grant.binding, previous?.binding ?? grant.binding);
	if (
		!COMPANY_COMPUTER_UUID.test(grant.viewerSessionId) ||
		!COMPANY_COMPUTER_UUID.test(grant.memberId) ||
		(grant.mode !== "watch" && grant.mode !== "control") ||
		!Number.isSafeInteger(grant.validForMs) ||
		grant.validForMs < 1 ||
		grant.validForMs > COMPANY_COMPUTER_MAX_LEASE_MS ||
		(previous &&
			(previous.viewerSessionId !== grant.viewerSessionId ||
				previous.memberId !== grant.memberId ||
				previous.mode !== grant.mode))
	) {
		throw new Error("INVALID_VIEWER_GRANT");
	}
	if (grant.mode === "control") {
		if (!grant.lease) throw new Error("MEMBER_TAKEOVER_REQUIRED");
		assertCompanyComputerLease(grant.lease, grant.binding, {
			kind: "member",
			memberId: grant.memberId,
			sessionId: grant.viewerSessionId,
		});
		if (
			grant.validForMs > grant.lease.validForMs ||
			(previous?.lease &&
				(previous.lease.epoch !== grant.lease.epoch || previous.lease.leaseId !== grant.lease.leaseId))
		) {
			throw new Error("VIEWER_LEASE_CHANGED");
		}
	} else if (grant.lease) throw new Error("WATCHER_CANNOT_HOLD_CONTROL");
}

/** Strict bounded line framing reused by the member/gateway legs; retains coalesced initial RFB bytes. */
export function readCompanyComputerViewLine(
	socket: Socket,
	signal: AbortSignal,
): Promise<{ value: unknown; remainder: Buffer }> {
	return companyComputerRequest(
		(requestSignal) =>
			new Promise((resolve, reject) => {
				let buffered = Buffer.alloc(0);
				const cleanup = (): void => {
					socket.off("data", data);
					socket.off("error", failed);
					socket.off("close", failed);
					socket.off("end", failed);
					requestSignal.removeEventListener("abort", failed);
				};
				const failed = (): void => {
					cleanup();
					reject(new Error("VIEW_HANDSHAKE_FAILED"));
				};
				const data = (bytes: Buffer): void => {
					buffered = Buffer.concat([buffered, bytes]);
					const newline = buffered.indexOf(10);
					if (newline > 4096 || (newline < 0 && buffered.length > 4096) || buffered.length > 256 * 1024) {
						failed();
						return;
					}
					if (newline < 0) return;
					socket.pause();
					cleanup();
					try {
						resolve({
							value: JSON.parse(buffered.subarray(0, newline).toString("utf8")) as unknown,
							remainder: Buffer.from(buffered.subarray(newline + 1)),
						});
					} catch {
						reject(new Error("VIEW_HANDSHAKE_FAILED"));
					}
				};
				socket.on("data", data);
				socket.once("error", failed);
				socket.once("close", failed);
				socket.once("end", failed);
				requestSignal.addEventListener("abort", failed, { once: true });
				if (requestSignal.aborted) failed();
				else socket.resume();
			}),
		signal,
	);
}

/**
 * Reuses the historical private TCP viewer topology, but ends every connection
 * at grant expiry, revalidates open sessions and separates watch from control
 * in the server's RFB path. UI viewOnly is not an authorization boundary.
 */
export async function startCompanyComputerViewerGateway(options: {
	host: string;
	port: number;
	authority: CompanyComputerViewerAuthority;
	guest: CompanyComputerViewerGuestTransport;
}): Promise<{ port: number; close(): Promise<void> }> {
	assertPrivateCompanyComputerAddress(options.host);
	if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
		throw new Error("INVALID_VIEWER_PORT");
	const sessions = new Set<Socket>();
	const tasks = new Set<Promise<void>>();
	const server = createServer((socket) => {
		sessions.add(socket);
		const task = serveCompanyComputerViewer(socket, options.authority, options.guest).finally(() => {
			sessions.delete(socket);
			tasks.delete(task);
		});
		tasks.add(task);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	return {
		port: typeof address === "object" && address ? address.port : options.port,
		close: async () => {
			for (const socket of sessions) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.all(tasks);
		},
	};
}

async function serveCompanyComputerViewer(
	socket: Socket,
	authority: CompanyComputerViewerAuthority,
	guest: CompanyComputerViewerGuestTransport,
): Promise<void> {
	const stop = new AbortController();
	let grant: CompanyComputerViewerGrant | undefined;
	let upstream: Socket | undefined;
	let output: Transform | undefined;
	let expiry: ReturnType<typeof setTimeout> | undefined;
	let refresh: ReturnType<typeof setTimeout> | undefined;
	let deadline = 0;
	let sequence = 0;
	let connected = false;
	const ended = new Promise<void>((resolve) => {
		const finish = (): void => {
			stop.abort();
			resolve();
		};
		socket.once("close", finish);
		socket.once("error", finish);
		socket.once("end", finish);
	});
	const assertDeadline = (): void => {
		stop.signal.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("VIEWER_EXPIRED");
	};
	const arm = (next: CompanyComputerViewerGrant, started: number): void => {
		assertCompanyComputerViewerGrant(next, grant);
		if (started + next.validForMs <= performance.now()) throw new Error("VIEWER_EXPIRED");
		grant = structuredClone(next);
		deadline = started + next.validForMs;
		clearTimeout(expiry);
		clearTimeout(refresh);
		expiry = setTimeout(() => socket.destroy(), Math.max(1, deadline - performance.now()));
		refresh = setTimeout(
			() => {
				void check().catch(() => socket.destroy());
			},
			Math.max(1, Math.min(5_000, (deadline - performance.now()) / 2)),
		);
	};
	let checking: Promise<void> | undefined;
	const check = (): Promise<void> => {
		checking ??= (async () => {
			assertDeadline();
			const started = performance.now();
			const next = await companyComputerRequest(
				(signal) => authority.check(structuredClone(grant!), signal),
				stop.signal,
			);
			assertDeadline();
			arm(next, started);
		})().finally(() => {
			checking = undefined;
		});
		return checking;
	};
	try {
		const line = await readCompanyComputerViewLine(socket, stop.signal);
		if (!line.value || typeof line.value !== "object" || Array.isArray(line.value))
			throw new Error("INVALID_VIEW_HANDSHAKE");
		const handshake = line.value as Record<string, unknown>;
		if (
			Object.keys(handshake).sort().join() !== "capability,schema" ||
			handshake.schema !== COMPANY_COMPUTER_VIEW_SCHEMA ||
			typeof handshake.capability !== "string" ||
			!COMPANY_COMPUTER_VIEW_TOKEN.test(handshake.capability)
		)
			throw new Error("INVALID_VIEW_HANDSHAKE");
		const started = performance.now();
		arm(
			await companyComputerRequest(
				(signal) => authority.redeem(handshake.capability as string, signal),
				stop.signal,
			),
			started,
		);
		const attached = await companyComputerRequest(async (signal) => {
			const result = await guest.connect(structuredClone(grant!), signal);
			if (signal.aborted) {
				result.socket.destroy();
				throw new Error("VIEWER_STOPPED");
			}
			return result;
		}, stop.signal);
		upstream = attached.socket;
		upstream.on("error", () => socket.destroy());
		upstream.on("close", () => socket.destroy());
		await check();
		const activeGrant = grant!;
		socket.write(`${JSON.stringify({ ok: true, binding: activeGrant.binding, mode: activeGrant.mode })}\n`);
		connected = true;
		const parser = new CompanyComputerRfbClientParser();
		const forward = async (bytes: Buffer): Promise<void> => {
			const messages = parser.push(bytes);
			await check();
			for (const message of messages) {
				assertDeadline();
				if (message.kind === "blocked" || (message.kind === "input" && grant!.mode === "watch")) continue;
				if (message.kind === "input") {
					let accepting = true;
					let forwarded = false;
					try {
						await companyComputerRequest(async (signal) => {
							await authority.forwardInput(
								structuredClone(grant!),
								{
									sequence: ++sequence,
									sha256: createHash("sha256").update(message.bytes).digest("hex"),
									bytes: Uint8Array.from(message.bytes),
								},
								() => {
									signal.throwIfAborted();
									assertDeadline();
									if (!accepting || forwarded) throw new Error("VIEWER_INPUT_ALREADY_SETTLED");
									forwarded = true;
									upstream!.write(message.bytes);
								},
								signal,
							);
							if (!forwarded) throw new Error("VIEWER_INPUT_NOT_FORWARDED");
						}, stop.signal);
					} finally {
						accepting = false;
					}
				} else upstream!.write(message.bytes);
				if (upstream!.writableLength > 256 * 1024) throw new Error("VIEWER_BACKPRESSURE_LIMIT");
			}
		};
		if (line.remainder.length > 0) await forward(line.remainder);
		socket.on("data", (bytes: Buffer) => {
			socket.pause();
			void forward(bytes).then(
				() => {
					if (!stop.signal.aborted) socket.resume();
				},
				() => socket.destroy(),
			);
		});
		const serverParser = new CompanyComputerRfbServerParser();
		output = new Transform({
			transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
				try {
					assertDeadline();
					for (const bytes of serverParser.push(chunk)) this.push(bytes);
					callback();
				} catch {
					callback(new Error("VIEWER_OUTPUT_UNAVAILABLE"));
				}
			},
		});
		output.on("error", () => socket.destroy());
		output.pipe(socket);
		// Coalesced guest-handshake bytes must pass through the same clipboard filter.
		if (attached.remainder.length > 0) output.write(attached.remainder);
		upstream.pipe(output);
		upstream.resume();
		socket.resume();
		await ended;
	} catch {
		// Never echo service errors, guest endpoints or credentials into a viewer or transcript.
		if (!connected && !socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: "VIEW_UNAVAILABLE" })}\n`);
	} finally {
		stop.abort();
		clearTimeout(expiry);
		clearTimeout(refresh);
		upstream?.destroy();
		output?.destroy();
		socket.destroy();
		if (grant)
			await companyComputerRequest(
				(signal) => authority.release(grant!, signal),
				new AbortController().signal,
			).catch(() => undefined);
	}
}
