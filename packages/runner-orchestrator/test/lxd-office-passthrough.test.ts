import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdHostInventory, LxdInstanceStateRecord } from "../src/lxd-client.ts";
import {
	createLxdOfficeGuestResolver,
	LxdOfficePassthrough,
	lxdOfficePassthroughClientAllowed,
	parseLxdOfficePassthroughConfig,
	runLxdOfficePassthrough,
} from "../src/lxd-office-passthrough.ts";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((done) => probe.listen({ host: "127.0.0.1", port: 0 }, () => done()));
	const port = (probe.address() as AddressInfo).port;
	await new Promise<void>((done) => probe.close(() => done()));
	return port;
}

/** A guest stand-in that answers with what it was sent, prefixed. */
async function guest(prefix = "guest:"): Promise<{ port: number; connections: () => number }> {
	let connections = 0;
	const server = createServer((socket) => {
		connections++;
		socket.on("data", (chunk) => socket.write(`${prefix}${chunk}`));
		socket.on("error", () => {});
	});
	await new Promise<void>((done) => server.listen({ host: "127.0.0.1", port: 0 }, () => done()));
	closers.push(() => new Promise<void>((done) => server.close(() => done())));
	return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

function document(viewerListen: number, viewerGuest: number, nativeListen: number, nativeGuest: number) {
	return {
		schema: "qorpera.lxd-office-passthrough/v1",
		listenHost: "127.0.0.1",
		viewer: { listenPort: viewerListen, guestPort: viewerGuest },
		native: { listenPort: nativeListen, guestPort: nativeGuest },
		allowedClients: ["127.0.0.0/8"],
	};
}

async function exchange(port: number, payload: string, timeoutMs = 2000): Promise<string | "closed"> {
	return new Promise((done, fail) => {
		const socket: Socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(payload));
		let received = "";
		const timer = setTimeout(() => {
			socket.destroy();
			fail(new Error("no reply"));
		}, timeoutMs);
		socket.on("data", (chunk) => {
			received += chunk;
			clearTimeout(timer);
			socket.end();
			done(received);
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			if (received === "") done("closed");
		});
	});
}

describe("parseLxdOfficePassthroughConfig", () => {
	it("accepts the closed document and rejects anything looser", () => {
		const parsed = parseLxdOfficePassthroughConfig(document(18543, 18543, 18544, 18544));
		expect(parsed.lanes.map((lane) => [lane.name, lane.listenPort, lane.guestPort])).toEqual([
			["viewer", 18543, 18543],
			["native", 18544, 18544],
		]);
		expect(parsed.allowedClients).toEqual([{ address: 127 * 2 ** 24, bits: 8 }]);
		for (const broken of [
			{ ...document(18543, 18543, 18544, 18544), schema: "qorpera.lxd-office-passthrough/v2" },
			{ ...document(18543, 18543, 18544, 18544), extra: true },
			{ ...document(18543, 18543, 18544, 18544), listenHost: "node-01.example" },
			{ ...document(18543, 18543, 18544, 18544), allowedClients: [] },
			{ ...document(18543, 18543, 18544, 18544), allowedClients: ["100.64.0.1/10"] },
			{ ...document(18543, 18543, 18544, 18544), allowedClients: ["100.64.0.0/4"] },
			document(80, 18543, 18544, 18544),
			document(18543, 18543, 18543, 18544),
			document(18543, 0, 18544, 18544),
			{ ...document(18543, 18543, 18544, 18544), viewer: { listenPort: 18543 } },
		])
			expect(() => parseLxdOfficePassthroughConfig(broken)).toThrow(
				/INVALID_OFFICE_(PASSTHROUGH_CONFIG|PHYSICAL_RECORD)/,
			);
	});

	it("admits only clients inside the allowed networks, including IPv4-mapped peers", () => {
		const config = parseLxdOfficePassthroughConfig({
			...document(18543, 18543, 18544, 18544),
			allowedClients: ["100.64.0.0/10", "10.41.0.0/24"],
		});
		expect(lxdOfficePassthroughClientAllowed(config, "100.75.4.70")).toBe(true);
		expect(lxdOfficePassthroughClientAllowed(config, "::ffff:100.127.255.254")).toBe(true);
		expect(lxdOfficePassthroughClientAllowed(config, "10.41.0.89")).toBe(true);
		expect(lxdOfficePassthroughClientAllowed(config, "10.41.1.1")).toBe(false);
		expect(lxdOfficePassthroughClientAllowed(config, "100.128.0.1")).toBe(false);
		expect(lxdOfficePassthroughClientAllowed(config, "fd7a:115c:a1e0::1")).toBe(false);
		expect(lxdOfficePassthroughClientAllowed(config, undefined)).toBe(false);
	});
});

function instance(name: string, overrides: Record<string, unknown> = {}) {
	return {
		name,
		project: "qprod01",
		location: "none",
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		profiles: [],
		config: {
			"user.qorpera.office_id": "aa551494-d3db-467c-a331-065c25216786",
			"user.qorpera.computer_generation": "2",
			"volatile.network.hwaddr": "00:16:3e:35:a0:bc",
		},
		devices: { network: { type: "nic", network: "qorpera0", name: "eth0" } },
		expandedDevices: { network: { type: "nic", network: "qorpera0", name: "eth0" } },
		expandedConfig: {},
		...overrides,
	} as unknown as LxdHostInventory["instances"][number];
}

function running(address: string): LxdInstanceStateRecord {
	return {
		status: "Running",
		statusCode: 103,
		network: {
			eth0: {
				hwaddr: "00:16:3e:35:a0:bc",
				addresses: [
					{ family: "inet", address, scope: "global" },
					{ family: "inet6", address: "fd42::1", scope: "global" },
				],
			},
			lo: { hwaddr: "00:00:00:00:00:00", addresses: [{ family: "inet", address: "127.0.0.1", scope: "local" }] },
		},
	};
}

const identity = {
	project: "qprod01",
	companyComputerId: "aa551494-d3db-467c-a331-065c25216786",
	computerGeneration: 2,
};

describe("createLxdOfficeGuestResolver", () => {
	it("finds the one planned office VM by its tags and reads the lease from the planned NIC", async () => {
		const state = vi.fn(async () => running("10.41.0.89"));
		const client = {
			inspectHostInventory: vi.fn(async () => ({
				server: {} as LxdHostInventory["server"],
				instances: [
					instance("qorpera-office-b3d8104be0e14a3fa1e85c4d85dbf39d"),
					instance("qorpera-office-old", {
						config: {
							"user.qorpera.office_id": identity.companyComputerId,
							"user.qorpera.computer_generation": "1",
						},
					}),
					instance("qorpera-office-other", { project: "qo26a1" }),
					instance("pr146-native", { config: {} }),
				],
			})),
			getInstanceState: state,
		};
		const resolve = createLxdOfficeGuestResolver(client, identity, 0);
		expect(await resolve(new AbortController().signal)).toBe("10.41.0.89");
		expect(state).toHaveBeenCalledWith(
			"qprod01",
			"qorpera-office-b3d8104be0e14a3fa1e85c4d85dbf39d",
			expect.anything(),
		);
	});

	it("resolves to nothing for a stopped guest, an ambiguous inventory or a moved lease that is not yet reported", async () => {
		const instances = [instance("qorpera-office-a")];
		const states: LxdInstanceStateRecord[] = [
			{ status: "Stopped", statusCode: 102, network: {} },
			running("10.41.0.89"),
		];
		const client = {
			inspectHostInventory: vi.fn(async () => ({ server: {} as LxdHostInventory["server"], instances })),
			getInstanceState: vi.fn(async () => states.shift() as LxdInstanceStateRecord),
		};
		const resolve = createLxdOfficeGuestResolver(client, identity, 0);
		const signal = new AbortController().signal;
		expect(await resolve(signal)).toBeUndefined();
		expect(await resolve(signal)).toBe("10.41.0.89");
		instances.push(instance("qorpera-office-b"));
		expect(await resolve(signal)).toBeUndefined();
	});

	it("shares one lookup across a burst and re-reads after the window", async () => {
		let clock = 0;
		const inventory = vi.fn(async () => ({
			server: {} as LxdHostInventory["server"],
			instances: [instance("qorpera-office-a")],
		}));
		const client = { inspectHostInventory: inventory, getInstanceState: vi.fn(async () => running("10.41.0.5")) };
		const resolve = createLxdOfficeGuestResolver(client, identity, 1000, () => clock);
		const signal = new AbortController().signal;
		await Promise.all([resolve(signal), resolve(signal), resolve(signal)]);
		expect(inventory).toHaveBeenCalledTimes(1);
		clock = 999;
		await resolve(signal);
		expect(inventory).toHaveBeenCalledTimes(1);
		clock = 1000;
		await resolve(signal);
		expect(inventory).toHaveBeenCalledTimes(2);
	});
});

describe("LxdOfficePassthrough", () => {
	it("copies bytes both ways to the guest resolved for each connection and follows the guest when it moves", async () => {
		const first = await guest("one:");
		const second = await guest("two:");
		let target: number | undefined = first.port;
		const [viewer, native] = [await freePort(), await freePort()];
		// The stand-ins live on one address, so the lane's guest port stands in for the moving address.
		const passthrough = await LxdOfficePassthrough.listen(
			{
				...parseLxdOfficePassthroughConfig(document(viewer, first.port, native, second.port)),
				lanes: [
					{ name: "viewer", listenPort: viewer, guestPort: first.port },
					{ name: "native", listenPort: native, guestPort: second.port },
				],
			},
			async () => (target === undefined ? undefined : "127.0.0.1"),
		);
		closers.push(() => passthrough.close());
		expect(passthrough.addresses).toEqual([
			{ name: "viewer", port: viewer },
			{ name: "native", port: native },
		]);
		expect(await exchange(viewer, "hello")).toBe("one:hello");
		expect(await exchange(native, "hi")).toBe("two:hi");
		expect(first.connections()).toBe(1);
		expect(second.connections()).toBe(1);
		// Guest off: the connection is closed without a byte, nothing is queued.
		target = undefined;
		expect(await exchange(viewer, "while off")).toBe("closed");
		expect(first.connections()).toBe(1);
		// Guest back: the next connection is forwarded again with no operator step in between.
		target = first.port;
		expect(await exchange(viewer, "again")).toBe("one:again");
		await vi.waitFor(() => expect(passthrough.openConnections).toBe(0));
	});

	it("closes connections from outside the allowed networks and above the per-lane limit", async () => {
		const stand = await guest();
		const [viewer, native] = [await freePort(), await freePort()];
		const denied = await LxdOfficePassthrough.listen(
			parseLxdOfficePassthroughConfig({
				...document(viewer, stand.port, native, stand.port),
				allowedClients: ["10.41.0.0/24"],
			}),
			async () => "127.0.0.1",
		);
		closers.push(() => denied.close());
		expect(await exchange(viewer, "x")).toBe("closed");
		expect(stand.connections()).toBe(0);
		await denied.close();
		const limited = await LxdOfficePassthrough.listen(
			parseLxdOfficePassthroughConfig(document(viewer, stand.port, native, stand.port)),
			async () => "127.0.0.1",
			{ maxConnections: 1 },
		);
		closers.push(() => limited.close());
		const held = createConnection({ host: "127.0.0.1", port: viewer });
		held.on("error", () => {});
		await new Promise<void>((done) => held.once("connect", () => done()));
		await vi.waitFor(() => expect(stand.connections()).toBe(1));
		expect(await exchange(viewer, "second")).toBe("closed");
		held.destroy();
		await vi.waitFor(() => expect(limited.openConnections).toBe(0));
		expect(await exchange(viewer, "third")).toBe("guest:third");
	});

	it("closes the client when the guest does not answer within the connect deadline", async () => {
		const [viewer, native] = [await freePort(), await freePort()];
		const unreachable = await freePort();
		const passthrough = await LxdOfficePassthrough.listen(
			parseLxdOfficePassthroughConfig(document(viewer, unreachable, native, unreachable)),
			async () => "127.0.0.1",
			{ connectTimeoutMs: 200 },
		);
		closers.push(() => passthrough.close());
		expect(await exchange(viewer, "x")).toBe("closed");
		await vi.waitFor(() => expect(passthrough.openConnections).toBe(0));
	});

	it("runs until the service stops and refuses to start on a port that is taken", async () => {
		const stand = await guest();
		const [viewer, native] = [await freePort(), await freePort()];
		const config = parseLxdOfficePassthroughConfig(document(viewer, stand.port, native, stand.port));
		const controller = new AbortController();
		const errors: unknown[] = [];
		const run = runLxdOfficePassthrough(
			config,
			async () => "127.0.0.1",
			controller.signal,
			(error) => errors.push(error),
		);
		await vi.waitFor(async () => expect(await exchange(viewer, "up")).toBe("guest:up"));
		await expect(LxdOfficePassthrough.listen(config, async () => "127.0.0.1")).rejects.toThrow(/EADDRINUSE/);
		controller.abort();
		await run;
		expect(await exchange(viewer, "down").catch(() => "closed")).toBe("closed");
		expect(errors).toEqual([]);
	});
});
