import { createConnection, createServer, isIP, type Socket } from "node:net";
import type { LxdHostInventoryClient, LxdInstanceStateRecord } from "./lxd-client.ts";
import { lxdGuestIpv4 } from "./lxd-guest-network.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";

/** Members and the node's native provider reach the office guest through the
 * host: the mux forwards `/office/<id>/view` to a host port, and that port must
 * end at the guest's viewer or native listener. The guest is a DHCP client of
 * the office bridge, so its address is whatever its current lease says and it
 * changes whenever the guest was off for longer than the lease. The provider is
 * the only process that both starts the guest and can ask LXD where it is, so
 * it carries the two host ports itself and resolves the guest per connection.
 * Nothing is pinned: no address in a unit file, no address on the VM device
 * (the provider refuses to start a guest whose devices differ from its plan),
 * no operator step after the guest moves. */
export interface LxdOfficePassthroughLane {
	readonly name: "viewer" | "native";
	readonly listenPort: number;
	readonly guestPort: number;
}
export interface LxdOfficePassthroughConfig {
	readonly listenHost: string;
	readonly lanes: readonly LxdOfficePassthroughLane[];
	/** IPv4 networks whose clients may connect: the tailnet range for the mux and
	 * the node's native provider, nothing else. */
	readonly allowedClients: readonly { readonly address: number; readonly bits: number }[];
}

function port(value: unknown, minimum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 65535)
		throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	return value as number;
}

function ipv4Number(address: string): number | undefined {
	if (isIP(address) !== 4) return undefined;
	return address.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
}

function cidr(value: unknown): { address: number; bits: number } {
	if (typeof value !== "string" || !/^[0-9.]{7,15}\/[0-9]{1,2}$/.test(value))
		throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	const [address, bits] = value.split("/");
	const number = ipv4Number(address);
	const prefix = Number(bits);
	if (number === undefined || prefix < 8 || prefix > 32) throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
	if ((number & mask) >>> 0 !== number) throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	return { address: number, bits: prefix };
}

/** Closed document, root-protected beside the service configuration:
 * `{"schema":"qorpera.lxd-office-passthrough/v1","listenHost":"100.75.4.70",
 * "viewer":{"listenPort":18543,"guestPort":18543},
 * "native":{"listenPort":18544,"guestPort":18544},
 * "allowedClients":["100.64.0.0/10"]}`. */
export function parseLxdOfficePassthroughConfig(value: unknown): LxdOfficePassthroughConfig {
	const r = officeRecord(value, ["schema", "listenHost", "viewer", "native", "allowedClients"]);
	if (
		r.schema !== "qorpera.lxd-office-passthrough/v1" ||
		typeof r.listenHost !== "string" ||
		isIP(r.listenHost) === 0 ||
		!Array.isArray(r.allowedClients) ||
		r.allowedClients.length === 0 ||
		r.allowedClients.length > 16
	)
		throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	const lanes = (["viewer", "native"] as const).map((name) => {
		const lane = officeRecord(r[name], ["listenPort", "guestPort"]);
		return { name, listenPort: port(lane.listenPort, 1024), guestPort: port(lane.guestPort, 1) };
	});
	if (lanes[0].listenPort === lanes[1].listenPort) throw new Error("INVALID_OFFICE_PASSTHROUGH_CONFIG");
	return Object.freeze({
		listenHost: r.listenHost,
		lanes: Object.freeze(lanes),
		allowedClients: Object.freeze(r.allowedClients.map(cidr)),
	});
}

export function lxdOfficePassthroughClientAllowed(
	config: LxdOfficePassthroughConfig,
	remote: string | undefined,
): boolean {
	if (remote === undefined) return false;
	const address = ipv4Number(remote.startsWith("::ffff:") ? remote.slice(7) : remote);
	if (address === undefined) return false;
	return config.allowedClients.some(({ address: network, bits }) => {
		const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
		return (address & mask) >>> 0 === network;
	});
}

/** The current guest address, or undefined while there is no running office
 * guest to forward to. A caller must treat undefined as "close the connection",
 * never as "keep the last address": the last address is exactly the failure this
 * module exists to remove. */
export type LxdOfficeGuestResolver = (signal: AbortSignal) => Promise<string | undefined>;

export interface LxdOfficePassthroughGuestIdentity {
	readonly project: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
}

/** Finds the office guest by the identity the provider itself planned into the
 * VM (project, office tag, generation tag, name prefix) and reads its address
 * from the guest agent, bound to the planned NIC by MAC. One matching running
 * VM is required; two candidates or a stopped VM resolve to nothing. Results
 * are shared for a short window so a burst of viewer reconnects does not turn
 * into a burst of LXD inventories. */
export function createLxdOfficeGuestResolver(
	client: LxdHostInventoryClient & {
		getInstanceState(project: string, name: string, signal?: AbortSignal): Promise<LxdInstanceStateRecord>;
	},
	guest: LxdOfficePassthroughGuestIdentity,
	cacheMs = 1000,
	now: () => number = () => Date.now(),
): LxdOfficeGuestResolver {
	let cached: { at: number; address: string | undefined } | undefined;
	let inFlight: Promise<string | undefined> | undefined;
	const resolve = async (signal: AbortSignal): Promise<string | undefined> => {
		const inventory = await client.inspectHostInventory(signal);
		const candidates = inventory.instances.filter(
			(instance) =>
				instance.project === guest.project &&
				instance.type === "virtual-machine" &&
				instance.name.startsWith("qorpera-office-") &&
				instance.config["user.qorpera.office_id"] === guest.companyComputerId &&
				instance.config["user.qorpera.computer_generation"] === String(guest.computerGeneration),
		);
		if (candidates.length !== 1) return undefined;
		const instance = candidates[0];
		const state = await client.getInstanceState(instance.project, instance.name, signal);
		return lxdGuestIpv4(instance, state, "network");
	};
	return async (signal) => {
		signal.throwIfAborted();
		if (cached && now() - cached.at < cacheMs) return cached.address;
		if (!inFlight) {
			inFlight = resolve(signal)
				.then((address) => {
					cached = { at: now(), address };
					return address;
				})
				.finally(() => {
					inFlight = undefined;
				});
		}
		return inFlight;
	};
}

export interface LxdOfficePassthroughOptions {
	/** Concurrent connections per lane; beyond it new clients are closed. */
	readonly maxConnections?: number;
	/** Guest connect deadline; the guest answers on its own bridge in milliseconds. */
	readonly connectTimeoutMs?: number;
	readonly onError?: (error: unknown) => void;
}

/** Two listening sockets that live as long as the provider. Each accepted
 * connection resolves the guest first and is closed without a byte when there
 * is no guest; there is no queueing and no retry, the client's own reconnect is
 * the retry. Bytes are copied verbatim in both directions: the guest's TLS
 * terminates in the guest, so the mux keeps verifying the office certificate. */
export class LxdOfficePassthrough {
	readonly #servers: ReturnType<typeof createServer>[] = [];
	readonly #sockets = new Set<Socket>();
	readonly #counts = new Map<string, number>();
	readonly #config: LxdOfficePassthroughConfig;
	readonly #resolve: LxdOfficeGuestResolver;
	readonly #options: Required<Omit<LxdOfficePassthroughOptions, "onError">> &
		Pick<LxdOfficePassthroughOptions, "onError">;
	#closed = false;

	private constructor(
		config: LxdOfficePassthroughConfig,
		resolve: LxdOfficeGuestResolver,
		options: LxdOfficePassthroughOptions,
	) {
		this.#config = config;
		this.#resolve = resolve;
		this.#options = {
			maxConnections: options.maxConnections ?? 64,
			connectTimeoutMs: options.connectTimeoutMs ?? 5000,
			onError: options.onError,
		};
	}

	static async listen(
		config: LxdOfficePassthroughConfig,
		resolve: LxdOfficeGuestResolver,
		options: LxdOfficePassthroughOptions = {},
	): Promise<LxdOfficePassthrough> {
		const passthrough = new LxdOfficePassthrough(config, resolve, options);
		try {
			for (const lane of config.lanes) await passthrough.#listen(lane);
		} catch (error) {
			await passthrough.close();
			throw error;
		}
		return passthrough;
	}

	/** Bound ports, for observation and tests. */
	get addresses(): readonly { name: string; port: number }[] {
		return this.#servers.map((server, index) => {
			const address = server.address();
			return {
				name: this.#config.lanes[index].name,
				port: typeof address === "object" && address ? address.port : 0,
			};
		});
	}

	get openConnections(): number {
		return this.#sockets.size;
	}

	async #listen(lane: LxdOfficePassthroughLane): Promise<void> {
		const server = createServer({ allowHalfOpen: false, pauseOnConnect: true }, (client) => {
			void this.#accept(lane, client);
		});
		server.maxConnections = this.#options.maxConnections;
		server.on("error", (error) => this.#report(error));
		this.#servers.push(server);
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen({ host: this.#config.listenHost, port: lane.listenPort, exclusive: true }, () => {
				server.off("error", reject);
				resolveListen();
			});
		});
	}

	async #accept(lane: LxdOfficePassthroughLane, client: Socket): Promise<void> {
		const key = lane.name;
		const count = this.#counts.get(key) ?? 0;
		if (
			this.#closed ||
			count >= this.#options.maxConnections ||
			!lxdOfficePassthroughClientAllowed(this.#config, client.remoteAddress)
		) {
			client.destroy();
			return;
		}
		this.#counts.set(key, count + 1);
		this.#sockets.add(client);
		let upstream: Socket | undefined;
		const finish = () => {
			this.#sockets.delete(client);
			if (upstream) this.#sockets.delete(upstream);
			this.#counts.set(key, Math.max(0, (this.#counts.get(key) ?? 1) - 1));
			client.destroy();
			upstream?.destroy();
		};
		client.on("error", () => finish());
		client.on("close", () => finish());
		let address: string | undefined;
		try {
			address = await this.#resolve(AbortSignal.timeout(this.#options.connectTimeoutMs));
		} catch (error) {
			this.#report(error);
		}
		if (address === undefined || client.destroyed || this.#closed) {
			finish();
			return;
		}
		upstream = createConnection({ host: address, port: lane.guestPort, noDelay: true });
		this.#sockets.add(upstream);
		upstream.setTimeout(this.#options.connectTimeoutMs, () => {
			if (!upstream?.connecting) return;
			upstream.destroy(new Error("OFFICE_PASSTHROUGH_GUEST_UNREACHABLE"));
		});
		upstream.on("error", () => finish());
		upstream.on("close", () => finish());
		upstream.once("connect", () => {
			if (client.destroyed || this.#closed) return finish();
			upstream?.setTimeout(0);
			upstream?.setKeepAlive(true, 30000);
			client.setKeepAlive(true, 30000);
			client.setNoDelay(true);
			client.pipe(upstream as Socket).pipe(client);
			client.resume();
		});
	}

	#report(error: unknown): void {
		try {
			this.#options.onError?.(error);
		} catch {}
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		await Promise.all(
			this.#servers.map(
				(server) =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			),
		);
		this.#servers.length = 0;
	}
}

/** Runs beside the lifecycle loops for the whole service lifetime. Listening
 * does not depend on the office being active: a connection while the guest is
 * off is closed at once, which the mux reports as unavailable and the client
 * retries after the wake. */
export async function runLxdOfficePassthrough(
	config: LxdOfficePassthroughConfig,
	resolve: LxdOfficeGuestResolver,
	signal: AbortSignal,
	onError: (error: unknown) => void,
): Promise<void> {
	signal.throwIfAborted();
	const passthrough = await LxdOfficePassthrough.listen(config, resolve, { onError });
	try {
		await new Promise<void>((done) => {
			if (signal.aborted) return done();
			signal.addEventListener("abort", () => done(), { once: true });
		});
	} finally {
		await passthrough.close();
	}
}
