import { connect, createServer, type Server, type Socket } from "node:net";

/** Host-side viewer gateway: the point where member screen traffic
 * terminates. A member presents a short-lived single-use view capability
 * minted by the control plane; the gateway redeems it with provider
 * authority, resolves the guest attachment target from the provider's
 * durable journal, opens the guest leg with the per-computer viewer token,
 * and pipes bytes for as long as the connection lives. The gateway binds to
 * loopback or the private Tailscale address only and is never publicly
 * routable; the capability redemption is the authorization, and the guest
 * viewer token never leaves the host. */

const VIEW_SCHEMA = "qorpera.company-computer-screen-view/v1";
const ATTACH_SCHEMA = "qorpera.company-computer-screen-attach/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_HANDSHAKE_BYTES = 4_096;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface ScreenViewRedemption {
	screenId: string;
	screenOrdinal: number;
	profileId: string;
	companyComputerId: string;
	logicalComputerId: string;
	mintedByUserId: string;
}

export interface ScreenViewControlPlane {
	redeemScreenView(capability: string, signal?: AbortSignal): Promise<ScreenViewRedemption>;
}

export function parseScreenViewRedemption(value: unknown): ScreenViewRedemption {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Screen view redemption is invalid");
	}
	const input = value as Record<string, unknown>;
	const uuid = (candidate: unknown, label: string): string => {
		if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) throw new Error(`${label} is invalid`);
		return candidate;
	};
	if (
		!Number.isSafeInteger(input.screen_ordinal) ||
		(input.screen_ordinal as number) < 1 ||
		(input.screen_ordinal as number) > 32
	) {
		throw new Error("Screen view redemption ordinal is invalid");
	}
	return {
		screenId: uuid(input.screen_id, "Screen view redemption screen id"),
		screenOrdinal: input.screen_ordinal as number,
		profileId: uuid(input.profile_id, "Screen view redemption profile id"),
		companyComputerId: uuid(input.company_computer_id, "Screen view redemption computer id"),
		logicalComputerId: uuid(input.logical_computer_id, "Screen view redemption logical computer id"),
		mintedByUserId: uuid(input.minted_by_user_id, "Screen view redemption minter id"),
	};
}

export class SupabaseScreenViewControlPlane implements ScreenViewControlPlane {
	readonly #supabaseUrl: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;

	constructor(supabaseUrl: string, serviceKey: string, fetchImplementation: typeof fetch = fetch) {
		this.#supabaseUrl = supabaseUrl;
		this.#serviceKey = serviceKey;
		this.#fetch = fetchImplementation;
	}

	async redeemScreenView(capability: string, signal?: AbortSignal): Promise<ScreenViewRedemption> {
		const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
		if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3) {
			headers.authorization = `Bearer ${this.#serviceKey}`;
		}
		const response = await this.#fetch(
			new URL("/rest/v1/rpc/qorpera_redeem_company_computer_screen_view", this.#supabaseUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ p_capability: capability }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`Screen view redemption failed (${response.status})`);
		return parseScreenViewRedemption(await response.json());
	}
}

export interface ScreenViewerAttachmentTarget {
	guestAddress: string;
	viewerPort: number;
	viewerToken: string;
}

export interface ScreenViewerTargets {
	screenViewerTarget(logicalComputerId: string): Promise<ScreenViewerAttachmentTarget>;
}

export interface LxdCompanyComputerScreenViewerGatewayConfig {
	host: string;
	port: number;
	/** Optional single trusted IPv4 source; connections from anywhere else
	 * are dropped before the handshake, mirroring the guest listener. */
	trustedSource?: string;
}

export interface RunningScreenViewerGateway {
	port: number;
	close(): Promise<void>;
}

function normalizedRemoteAddress(address: string | undefined): string {
	if (!address) return "";
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

export class LxdCompanyComputerScreenViewerGateway {
	readonly #config: LxdCompanyComputerScreenViewerGatewayConfig;
	readonly #controlPlane: ScreenViewControlPlane;
	readonly #targets: ScreenViewerTargets;

	constructor(
		config: LxdCompanyComputerScreenViewerGatewayConfig,
		controlPlane: ScreenViewControlPlane,
		targets: ScreenViewerTargets,
	) {
		this.#config = config;
		this.#controlPlane = controlPlane;
		this.#targets = targets;
	}

	start(): Promise<RunningScreenViewerGateway> {
		const openSockets = new Set<Socket>();
		const server: Server = createServer((socket) => {
			openSockets.add(socket);
			socket.once("close", () => openSockets.delete(socket));
			if (
				this.#config.trustedSource !== undefined &&
				normalizedRemoteAddress(socket.remoteAddress) !== this.#config.trustedSource
			) {
				socket.destroy();
				return;
			}
			this.#serve(socket);
		});
		return new Promise((resolveStart, rejectStart) => {
			server.once("error", rejectStart);
			server.listen(this.#config.port, this.#config.host, () => {
				const address = server.address();
				resolveStart({
					port: typeof address === "object" && address ? address.port : this.#config.port,
					close: () =>
						new Promise<void>((resolveClose) => {
							for (const open of [...openSockets]) open.destroy();
							server.close(() => resolveClose());
						}),
				});
			});
		});
	}

	#serve(socket: Socket): void {
		let buffered = Buffer.alloc(0);
		let settled = false;
		const refuse = (error: string): void => {
			settled = true;
			socket.off("data", onData);
			socket.end(`${JSON.stringify({ ok: false, error })}\n`);
		};
		const timeout = setTimeout(() => {
			if (!settled) refuse("view handshake timed out");
		}, HANDSHAKE_TIMEOUT_MS);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline === -1) {
				if (buffered.byteLength > MAX_HANDSHAKE_BYTES) {
					clearTimeout(timeout);
					refuse("view handshake is too large");
				}
				return;
			}
			clearTimeout(timeout);
			socket.off("data", onData);
			socket.pause();
			const remainder = buffered.subarray(newline + 1);
			let handshake: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(buffered.subarray(0, newline).toString("utf-8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
				handshake = parsed as Record<string, unknown>;
			} catch {
				refuse("view handshake is invalid");
				return;
			}
			if (
				handshake.schema !== VIEW_SCHEMA ||
				typeof handshake.capability !== "string" ||
				!CAPABILITY_PATTERN.test(handshake.capability)
			) {
				refuse("view handshake is not authorized");
				return;
			}
			settled = true;
			void this.#bridge(socket, handshake.capability, remainder).catch((error: unknown) => {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
				socket.end(`${JSON.stringify({ ok: false, error: message })}\n`);
			});
		};
		socket.on("data", onData);
		socket.on("error", () => {
			clearTimeout(timeout);
			socket.destroy();
		});
	}

	async #bridge(socket: Socket, capability: string, clientRemainder: Buffer): Promise<void> {
		const redemption = await this.#controlPlane.redeemScreenView(capability);
		const target = await this.#targets.screenViewerTarget(redemption.logicalComputerId);
		const upstream: Socket = connect(target.viewerPort, target.guestAddress);
		const teardown = (): void => {
			socket.destroy();
			upstream.destroy();
		};
		await new Promise<void>((resolveConnect, rejectConnect) => {
			upstream.once("connect", () => resolveConnect());
			upstream.once("error", (error) => rejectConnect(new Error(`screen guest is unreachable: ${error.message}`)));
		});
		upstream.write(
			`${JSON.stringify({
				schema: ATTACH_SCHEMA,
				token: target.viewerToken,
				screen_ordinal: redemption.screenOrdinal,
			})}\n`,
		);
		const attachLine = await new Promise<{ line: string; remainder: Buffer }>((resolveLine, rejectLine) => {
			let upstreamBuffered = Buffer.alloc(0);
			const onUpstreamData = (chunk: Buffer): void => {
				upstreamBuffered = Buffer.concat([upstreamBuffered, chunk]);
				const newline = upstreamBuffered.indexOf(0x0a);
				if (newline === -1) {
					if (upstreamBuffered.byteLength > MAX_HANDSHAKE_BYTES) {
						upstream.off("data", onUpstreamData);
						rejectLine(new Error("screen attach reply is too large"));
					}
					return;
				}
				upstream.off("data", onUpstreamData);
				upstream.pause();
				resolveLine({
					line: upstreamBuffered.subarray(0, newline).toString("utf-8"),
					remainder: upstreamBuffered.subarray(newline + 1),
				});
			};
			upstream.on("data", onUpstreamData);
			upstream.once("error", (error) => rejectLine(new Error(`screen guest failed: ${error.message}`)));
			upstream.once("close", () => rejectLine(new Error("screen guest closed during attach")));
		});
		let attach: Record<string, unknown>;
		try {
			attach = JSON.parse(attachLine.line) as Record<string, unknown>;
		} catch {
			throw new Error("screen attach reply is invalid");
		}
		if (attach.ok !== true) {
			throw new Error(typeof attach.error === "string" ? attach.error : "screen attach was refused");
		}
		socket.write(`${JSON.stringify({ ok: true, screen_ordinal: redemption.screenOrdinal })}\n`);
		if (attachLine.remainder.byteLength > 0) socket.write(attachLine.remainder);
		if (clientRemainder.byteLength > 0) upstream.write(clientRemainder);
		socket.pipe(upstream);
		upstream.pipe(socket);
		socket.resume();
		upstream.resume();
		socket.on("error", teardown);
		upstream.on("error", teardown);
		socket.on("close", teardown);
		upstream.on("close", teardown);
	}
}
