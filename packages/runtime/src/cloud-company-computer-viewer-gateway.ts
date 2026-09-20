import {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerGrant,
} from "@qorpera/cloud-client/cloud-company-computer-viewer";

export {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerGrant,
} from "@qorpera/cloud-client/cloud-company-computer-viewer";

import { createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { type Duplex, Transform, type TransformCallback } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { CompanyComputerRfbClientParser } from "@qorpera/cloud-client/node/cloud-company-computer-rfb";
import {
	assertPrivateCompanyComputerAddress,
	COMPANY_COMPUTER_VIEW_SCHEMA,
	COMPANY_COMPUTER_VIEW_TOKEN,
	readCompanyComputerViewLine,
} from "@qorpera/cloud-client/node/company-computer-view-protocol";
import type { CompanyComputerDrainChallenge } from "./cloud-company-computer-drain.ts";
import { CompanyComputerRfbServerParser } from "./cloud-company-computer-rfb-server.ts";

export interface CompanyComputerViewerAuthority {
	/** Existing single-use view-capability ledger, with fresh membership/grant and exact-screen checks. */
	redeem(capability: string, signal: AbortSignal): Promise<CompanyComputerViewerGrant>;
	/** Includes revocation, handoff privacy, assignment generation and current takeover epoch. */
	check(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<CompanyComputerViewerGrant>;
	/** Windowed effect/audit boundary: one round trip per window, never per
	 * packet. Re-validates everything `check` validates plus input authority,
	 * and records the audit of the packets recorded since the previous call.
	 * The returned validity is at most one second. Never called concurrently
	 * for one grant. A rejection ends the viewer's input for good. */
	admitInputWindow(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<{ validForMs: number }>;
	/** Synchronous and local, immediately before a packet is dispatched under a
	 * valid window. Validates the packet, consumes its sequence and folds a keyed
	 * commitment into the open window; returns the packets in that window. Do
	 * not log or retain raw keystrokes/secrets. */
	recordInput(grant: CompanyComputerViewerGrant, input: { sequence: number; bytes: Uint8Array }): number;
	/** Removes only this exact viewer presence/lease, never a replacement connection. */
	release(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<void>;
}

export interface CompanyComputerViewerGuestTransport {
	/** Resolve this exact registry/journal binding, authenticate the guest leg, return a paused raw RFB socket. */
	connect(grant: CompanyComputerViewerGrant, signal: AbortSignal): Promise<{ socket: Socket; remainder: Buffer }>;
}

/** Shared by the private TCP and public TLS/WebSocket listeners. Barriers are
 * installed synchronously before sockets close; in-flight redemption, input
 * and output must observe them too. Closing streams is only the viewer half
 * of physical drain: the guest must separately release held input/resources. */
export class CompanyComputerViewerConnections {
	readonly #authority: CompanyComputerViewerAuthority;
	readonly #guest: CompanyComputerViewerGuestTransport;
	readonly #sessions = new Map<Duplex, { grant?: CompanyComputerViewerGrant; task: Promise<void> }>();
	readonly #privacy = new Map<string, CompanyComputerPrivacyChallenge>();
	readonly #screens = new Map<string, CompanyComputerDrainChallenge>();
	#closed = false;

	constructor(options: { authority: CompanyComputerViewerAuthority; guest: CompanyComputerViewerGuestTransport }) {
		this.#authority = options.authority;
		this.#guest = options.guest;
	}

	#inspect(grant: CompanyComputerViewerGrant): void {
		if (this.#closed) throw new Error("VIEWER_GATEWAY_CLOSED");
		const privacy = this.#privacy.get(grant.binding.companyComputerId);
		if (privacy) {
			assertCompanyComputerScope(grant.binding, privacy.scope);
			if (grant.binding.computerGeneration < privacy.computerGeneration || grant.privacyVersion < privacy.version)
				throw new Error("VIEWER_PRIVACY_FENCED");
			if (
				grant.binding.computerGeneration === privacy.computerGeneration &&
				grant.privacyVersion === privacy.version &&
				(privacy.state === "entering"
					? grant.memberId !== privacy.memberId ||
						grant.binding.screenId !== privacy.screenId ||
						grant.privateSignIn?.challengeId !== privacy.challengeId ||
						grant.privateSignIn.profileId !== privacy.profileId ||
						grant.privateSignIn.profileVersion !== privacy.profileVersion
					: !!grant.privateSignIn)
			)
				throw new Error("VIEWER_PRIVACY_FENCED");
		}
		const screen = this.#screens.get(`${grant.binding.companyComputerId}:${grant.binding.screenOrdinal}`);
		if (screen) {
			assertCompanyComputerScope(grant.binding, screen.binding);
			if (
				grant.binding.computerGeneration < screen.binding.computerGeneration ||
				(grant.binding.computerGeneration === screen.binding.computerGeneration &&
					grant.binding.screenGeneration < screen.binding.screenGeneration)
			)
				throw new Error("VIEWER_SCREEN_FENCED");
			if (
				grant.binding.computerGeneration === screen.binding.computerGeneration &&
				grant.binding.screenGeneration === screen.binding.screenGeneration
			) {
				assertCompanyComputerScreenBinding(grant.binding, screen.binding);
				if (grant.screenEpoch < screen.epoch) throw new Error("VIEWER_SCREEN_FENCED");
			}
		}
	}

	serve(socket: Duplex): Promise<void> {
		if (this.#closed || this.#sessions.size >= 64) {
			socket.destroy();
			return Promise.resolve();
		}
		const session: { grant?: CompanyComputerViewerGrant; task: Promise<void> } = { task: Promise.resolve() };
		this.#sessions.set(socket, session);
		session.task = serveCompanyComputerViewer(socket, this.#authority, this.#guest, (grant) => {
			this.#inspect(grant);
			session.grant = structuredClone(grant);
		}).finally(() => {
			this.#sessions.delete(socket);
		});
		return session.task;
	}

	async #closeFenced(signal: AbortSignal): Promise<void> {
		const tasks: Promise<void>[] = [];
		for (const [socket, session] of this.#sessions) {
			try {
				if (!session.grant) throw new Error("UNKNOWN_VIEWER");
				this.#inspect(session.grant);
			} catch {
				socket.destroy();
				tasks.push(session.task);
			}
		}
		await companyComputerRequest(() => Promise.all(tasks).then(() => undefined), signal, 10000);
	}

	fencePrivacy(value: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void> {
		const challenge = parseCompanyComputerPrivacyChallenge(value, value.scope);
		const previous = this.#privacy.get(challenge.scope.companyComputerId);
		if (previous) {
			assertCompanyComputerScope(challenge.scope, previous.scope);
			if (
				challenge.version < previous.version ||
				challenge.computerGeneration < previous.computerGeneration ||
				(challenge.version === previous.version && !isDeepStrictEqual(challenge, previous))
			)
				return Promise.reject(new Error("STALE_VIEWER_PRIVACY_BARRIER"));
			// Reconciliation of an acknowledged privacy challenge must retain a
			// newer screen drain (for example an expired private viewer), not try
			// to restore the entry challenge's older screen epochs.
			if (challenge.version === previous.version) return this.#closeFenced(signal);
		}
		this.#privacy.set(challenge.scope.companyComputerId, challenge);
		for (const drain of challenge.drains) this.#installScreenFence(drain);
		return this.#closeFenced(signal);
	}

	#installScreenFence(value: CompanyComputerDrainChallenge): void {
		const challenge = structuredClone(value);
		assertCompanyComputerScreenBinding(challenge.binding, challenge.binding);
		if (
			challenge.state !== "draining" ||
			!COMPANY_COMPUTER_UUID.test(challenge.drainId) ||
			!Number.isSafeInteger(challenge.epoch) ||
			challenge.epoch < 1
		)
			throw new Error("INVALID_VIEWER_DRAIN");
		const key = `${challenge.binding.companyComputerId}:${challenge.binding.screenOrdinal}`;
		const previous = this.#screens.get(key);
		if (previous) {
			assertCompanyComputerScope(challenge.binding, previous.binding);
			if (
				challenge.binding.computerGeneration < previous.binding.computerGeneration ||
				(challenge.binding.computerGeneration === previous.binding.computerGeneration &&
					(challenge.binding.screenGeneration < previous.binding.screenGeneration ||
						(challenge.binding.screenGeneration === previous.binding.screenGeneration &&
							challenge.epoch < previous.epoch)))
			)
				throw new Error("STALE_VIEWER_DRAIN");
			if (
				challenge.binding.computerGeneration === previous.binding.computerGeneration &&
				challenge.binding.screenGeneration === previous.binding.screenGeneration
			) {
				assertCompanyComputerScreenBinding(challenge.binding, previous.binding);
				if (challenge.epoch === previous.epoch && challenge.drainId !== previous.drainId)
					throw new Error("STALE_VIEWER_DRAIN");
			}
		}
		this.#screens.set(key, challenge);
	}

	fenceScreen(challenge: CompanyComputerDrainChallenge, signal: AbortSignal): Promise<void> {
		this.#installScreenFence(challenge);
		return this.#closeFenced(signal);
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const socket of this.#sessions.keys()) socket.destroy();
		await Promise.all([...this.#sessions.values()].map((session) => session.task));
	}
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
}): Promise<{ port: number; connections: CompanyComputerViewerConnections; close(): Promise<void> }> {
	assertPrivateCompanyComputerAddress(options.host);
	if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
		throw new Error("INVALID_VIEWER_PORT");
	const connections = new CompanyComputerViewerConnections(options);
	const server = createServer((socket) => {
		// Input packets and update requests are a few bytes each; never let Nagle hold them.
		socket.setNoDelay(true);
		void connections.serve(socket);
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
		connections,
		close: async () => {
			await connections.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** A client→guest packet needs an authority confirmation at most this old. */
const VIEWER_VALIDATION_MS = 1_000;
/** Keep renewing this long after the last input, so typing with short pauses
 * does not pay a cold window round trip on every burst. Idle viewers stop. */
const VIEWER_INPUT_LINGER_MS = 3_000;
/** Renew early once a window holds this many packets (the registry bound is 4096). */
const VIEWER_INPUT_WINDOW_RENEW_PACKETS = 2_048;

type ViewerClientMessage = { kind: "protocol" | "input" | "blocked"; bytes: Buffer };
const pointerMask = (message: ViewerClientMessage): number | undefined =>
	message.kind === "input" && message.bytes[0] === 5 && message.bytes.length === 6 ? message.bytes[1] : undefined;

/**
 * Pointer moves that are already pending together collapse to the latest one.
 * A packet is dropped only when it repeats the button mask of the pointer
 * packet before it (it is a plain move, not a press or release) and the next
 * input packet is another pointer packet with that same mask. Key events and
 * button transitions are never dropped or reordered, so a press still lands at
 * its own position. `mask` is the last pointer mask seen on this connection.
 */
export function coalesceCompanyComputerPointerMoves<T extends ViewerClientMessage>(
	messages: readonly T[],
	mask: number | undefined,
): T[] {
	const kept: T[] = [];
	let current = mask;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		const own = pointerMask(message);
		if (own !== undefined && own === current) {
			let next = index + 1;
			while (next < messages.length && messages[next].kind !== "input") next++;
			if (next < messages.length && pointerMask(messages[next]) === own) continue;
		}
		if (message.kind === "input") current = own;
		kept.push(message);
	}
	return kept;
}

async function serveCompanyComputerViewer(
	socket: Duplex,
	authority: CompanyComputerViewerAuthority,
	guest: CompanyComputerViewerGuestTransport,
	inspect: (grant: CompanyComputerViewerGrant) => void,
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
	const heldKeys = new Set<number>();
	let pointer: Buffer | undefined;
	let lastPointerMask: number | undefined;
	let validatedUntil = 0;
	let windowUntil = 0;
	let windowRenewAt = 0;
	let windowPackets = 0;
	let lastInputAt = Number.NEGATIVE_INFINITY;
	let inputStopped = false;
	let windowTimer: ReturnType<typeof setTimeout> | undefined;
	let windowRenewal: Promise<void> | undefined;
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
		if (grant) inspect(grant);
	};
	const arm = (next: CompanyComputerViewerGrant, started: number): void => {
		assertCompanyComputerViewerGrant(next, grant);
		grant = structuredClone(next);
		inspect(grant);
		if (started + next.validForMs <= performance.now()) throw new Error("VIEWER_EXPIRED");
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
			validatedUntil = Math.max(validatedUntil, started + VIEWER_VALIDATION_MS);
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
		const attached = await companyComputerRequest(
			async (signal) => {
				const result = await guest.connect(structuredClone(grant!), signal);
				if (signal.aborted) {
					result.socket.destroy();
					throw new Error("VIEWER_STOPPED");
				}
				return result;
				// The first view of a screen starts its desktop; that is slower than a warm attach.
			},
			stop.signal,
			25_000,
		);
		upstream = attached.socket;
		upstream.setNoDelay(true);
		upstream.on("error", () => socket.destroy());
		upstream.on("close", () => socket.destroy());
		await check();
		const activeGrant = grant!;
		socket.write(`${JSON.stringify({ ok: true, binding: activeGrant.binding, mode: activeGrant.mode })}\n`);
		connected = true;
		const parser = new CompanyComputerRfbClientParser();
		// Input is dispatched at once under a valid window. A window is one
		// registry round trip: it re-validates this viewer and records the audit
		// of the previous window. While input flows it is renewed at half its
		// validity, in the background, so the hot path never waits.
		const renewWindow = (): Promise<void> => {
			windowRenewal ??= (async () => {
				clearTimeout(windowTimer);
				windowTimer = undefined;
				try {
					assertDeadline();
					const started = performance.now();
					const result = await companyComputerRequest(
						(signal) => {
							windowPackets = 0;
							return authority.admitInputWindow(structuredClone(grant!), signal);
						},
						stop.signal,
						VIEWER_VALIDATION_MS,
					);
					if (
						!Number.isSafeInteger(result.validForMs) ||
						result.validForMs < 1 ||
						result.validForMs > VIEWER_VALIDATION_MS ||
						started + result.validForMs <= performance.now()
					)
						throw new Error("VIEWER_INPUT_UNCONFIRMED");
					assertDeadline();
					windowUntil = started + result.validForMs;
					windowRenewAt = started + result.validForMs / 2;
					validatedUntil = Math.max(validatedUntil, started + VIEWER_VALIDATION_MS);
				} catch (error) {
					// Refused, lost or late. Stop dispatching now; packets that arrive
					// without a window are never held back for a later replay. Ending
					// the connection releases held keys/buttons in the close path.
					inputStopped = true;
					windowUntil = 0;
					socket.destroy();
					throw error;
				}
			})().finally(() => {
				windowRenewal = undefined;
				scheduleWindow();
			});
			return windowRenewal;
		};
		const scheduleWindow = (): void => {
			const now = performance.now();
			if (windowTimer || windowRenewal || inputStopped || stop.signal.aborted || now >= windowUntil) return;
			// No input since the last report and none recently: let the window lapse.
			if (windowPackets === 0 && now - lastInputAt > VIEWER_INPUT_LINGER_MS) return;
			windowTimer = setTimeout(
				() => {
					windowTimer = undefined;
					void renewWindow().catch(() => undefined);
				},
				Math.max(0, windowRenewAt - now),
			);
		};
		const forward = async (bytes: Buffer): Promise<void> => {
			const messages = coalesceCompanyComputerPointerMoves(parser.push(bytes), lastPointerMask);
			for (const message of messages) {
				assertDeadline();
				if (message.kind === "input") lastPointerMask = message.bytes[0] === 5 ? message.bytes[1] : undefined;
				if (message.kind === "blocked" || (message.kind === "input" && grant!.mode === "watch")) continue;
				if (message.kind === "input") {
					if (inputStopped) throw new Error("VIEWER_INPUT_STOPPED");
					if (performance.now() >= windowUntil) {
						// Cold start or a lapsed window: the socket stays paused and this
						// packet waits for a confirmed window. If none comes, it is dropped.
						await (windowRenewal ?? renewWindow());
						assertDeadline();
						if (inputStopped || performance.now() >= windowUntil)
							throw new Error("VIEWER_INPUT_WINDOW_UNAVAILABLE");
					}
					if (
						grant!.mode === "shared" &&
						message.bytes[0] === 4 &&
						message.bytes[1] === 1 &&
						!heldKeys.has(message.bytes.readUInt32BE(4)) &&
						heldKeys.size >= 256
					)
						throw new Error("VIEWER_HELD_INPUT_LIMIT");
					windowPackets = authority.recordInput(grant!, { sequence: ++sequence, bytes: message.bytes });
					lastInputAt = performance.now();
					upstream!.write(message.bytes);
					if (grant!.mode === "shared") {
						if (message.bytes[0] === 4) {
							const key = message.bytes.readUInt32BE(4);
							if (message.bytes[1] === 1) heldKeys.add(key);
							else heldKeys.delete(key);
						} else if (message.bytes[0] === 5) {
							pointer = message.bytes[1] === 0 ? undefined : Buffer.from(message.bytes);
						}
					}
					if (windowPackets >= VIEWER_INPUT_WINDOW_RENEW_PACKETS) await renewWindow();
					else scheduleWindow();
				} else {
					// Other client traffic keeps the same one-second bound without a
					// round trip per chunk: refresh in the background at half age, wait
					// only when no confirmation is fresh.
					const now = performance.now();
					if (now >= validatedUntil) await (windowRenewal ?? check());
					else if (now >= validatedUntil - VIEWER_VALIDATION_MS / 2 && !checking && !windowRenewal)
						void check().catch(() => socket.destroy());
					assertDeadline();
					upstream!.write(message.bytes);
				}
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
					// The parser emits one buffer per RFB field. Forward each guest
					// chunk as one write (one WebSocket frame, one TLS record), not as
					// dozens of few-byte frames per rectangle.
					const parts = serverParser.push(chunk);
					if (parts.length > 0) this.push(parts.length === 1 ? parts[0] : Buffer.concat(parts));
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
		inputStopped = true;
		clearTimeout(expiry);
		clearTimeout(refresh);
		clearTimeout(windowTimer);
		upstream?.unpipe(output);
		output?.destroy();
		socket.destroy();
		// Shared viewing must not fence the agent's screen just to release this
		// connection's held input. Drain only keys/buttons actually forwarded by
		// this viewer, over its exact guest socket; no new input is authorized.
		if (upstream && !upstream.destroyed && (heldKeys.size > 0 || pointer)) {
			const releases: Buffer[] = [];
			for (const key of heldKeys) {
				const release = Buffer.alloc(8);
				release[0] = 4;
				release.writeUInt32BE(key, 4);
				releases.push(release);
			}
			if (pointer) {
				pointer[1] = 0;
				releases.push(pointer);
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => upstream!.destroy(), 1000);
				upstream!.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				upstream!.end(Buffer.concat(releases));
			});
		}
		heldKeys.clear();
		pointer?.fill(0);
		upstream?.destroy();
		if (grant)
			await companyComputerRequest(
				(signal) => authority.release(grant!, signal),
				new AbortController().signal,
			).catch(() => undefined);
	}
}
