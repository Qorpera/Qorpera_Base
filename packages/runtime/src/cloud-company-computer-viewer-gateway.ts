import {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerGrant,
} from "@qorpera/cloud-client/cloud-company-computer-viewer";

export {
	assertCompanyComputerViewerGrant,
	type CompanyComputerViewerGrant,
} from "@qorpera/cloud-client/cloud-company-computer-viewer";

import { createHash } from "node:crypto";
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
import type {
	CompanyComputerViewerRefusalObserver,
	CompanyComputerViewerRefusalStage,
} from "./cloud-company-computer-diagnostics.ts";
import type { CompanyComputerDrainChallenge } from "./cloud-company-computer-drain.ts";
import { CompanyComputerRfbServerParser } from "./cloud-company-computer-rfb-server.ts";

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

	readonly #onRefusal: CompanyComputerViewerRefusalObserver | undefined;

	constructor(options: {
		authority: CompanyComputerViewerAuthority;
		guest: CompanyComputerViewerGuestTransport;
		/** Service-side diagnostics only. It sees the internal cause; the viewer never does. */
		onRefusal?: CompanyComputerViewerRefusalObserver;
	}) {
		this.#authority = options.authority;
		this.#guest = options.guest;
		this.#onRefusal = options.onRefusal;
	}

	/** Report a refusal decided outside a served connection (the transport's upgrade checks). */
	refused(stage: CompanyComputerViewerRefusalStage, error: unknown): void {
		try {
			this.#onRefusal?.(stage, error);
		} catch {
			/* Diagnostics never decide what happens to a viewer. */
		}
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
			this.refused("capacity", new Error(this.#closed ? "VIEWER_GATEWAY_CLOSED" : "VIEWER_CAPACITY_LIMIT"));
			socket.destroy();
			return Promise.resolve();
		}
		const session: { grant?: CompanyComputerViewerGrant; task: Promise<void> } = { task: Promise.resolve() };
		this.#sessions.set(socket, session);
		session.task = serveCompanyComputerViewer(
			socket,
			this.#authority,
			this.#guest,
			(grant) => {
				this.#inspect(grant);
				session.grant = structuredClone(grant);
			},
			(stage, error) => this.refused(stage, error),
		).finally(() => {
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
			} catch (error) {
				this.refused("stream", error);
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
	onRefusal?: CompanyComputerViewerRefusalObserver;
}): Promise<{ port: number; connections: CompanyComputerViewerConnections; close(): Promise<void> }> {
	assertPrivateCompanyComputerAddress(options.host);
	if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
		throw new Error("INVALID_VIEWER_PORT");
	const connections = new CompanyComputerViewerConnections(options);
	const server = createServer((socket) => {
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

async function serveCompanyComputerViewer(
	socket: Duplex,
	authority: CompanyComputerViewerAuthority,
	guest: CompanyComputerViewerGuestTransport,
	inspect: (grant: CompanyComputerViewerGrant) => void,
	refused: CompanyComputerViewerRefusalObserver,
): Promise<void> {
	const stop = new AbortController();
	let stage: CompanyComputerViewerRefusalStage = "handshake";
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
				void check().catch((error) => {
					refused("stream", error);
					socket.destroy();
				});
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
		stage = "redeem";
		arm(
			await companyComputerRequest(
				(signal) => authority.redeem(handshake.capability as string, signal),
				stop.signal,
			),
			started,
		);
		stage = "connect";
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
		upstream.on("error", () => socket.destroy());
		upstream.on("close", () => socket.destroy());
		await check();
		const activeGrant = grant!;
		socket.write(`${JSON.stringify({ ok: true, binding: activeGrant.binding, mode: activeGrant.mode })}\n`);
		connected = true;
		stage = "stream";
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
									if (
										grant!.mode === "shared" &&
										message.bytes[0] === 4 &&
										message.bytes[1] === 1 &&
										!heldKeys.has(message.bytes.readUInt32BE(4)) &&
										heldKeys.size >= 256
									)
										throw new Error("VIEWER_HELD_INPUT_LIMIT");
									forwarded = true;
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
				(error) => {
					refused("stream", error);
					socket.destroy();
				},
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
	} catch (error) {
		// The cause stays on this machine, as a closed code chain in the journal.
		refused(stage, error);
		// Never echo service errors, guest endpoints or credentials into a viewer or transcript.
		if (!connected && !socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: "VIEW_UNAVAILABLE" })}\n`);
	} finally {
		stop.abort();
		clearTimeout(expiry);
		clearTimeout(refresh);
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
