import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { connectCompanyComputerViewChannel } from "@qorpera/cloud-client/cloud-company-computer-view-channel";
import type { CompanyComputerLinuxGuestOptions } from "@qorpera/runtime/cloud-company-computer-linux-guest";
import { startCompanyComputerLinuxOfficeService } from "@qorpera/runtime/cloud-company-computer-linux-service";
import {
	HttpCloudCompanyComputerRegistry,
	OfficeComputerMeteringPending,
} from "@qorpera/runtime/cloud-company-computer-registry-http";
import {
	type CompanyComputerServiceGuest,
	startCompanyComputerOfficeService,
} from "@qorpera/runtime/cloud-company-computer-service";
import { CompanyComputerStartupControl } from "@qorpera/runtime/cloud-company-computer-startup";
import { CompanyComputerOfficeSupervisor } from "@qorpera/runtime/cloud-company-computer-supervisor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import {
	computerBinding,
	computerDeferred,
	computerId,
	computerLease,
	computerOperation,
	computerRfbServerHello,
	computerScope,
} from "./fixtures/company-computer.ts";

const linuxGuest = vi.hoisted(() => ({ construct: vi.fn(), ready: vi.fn(), physical: vi.fn() }));
vi.mock("../src/cloud-company-computer-linux-boundary.ts", () => ({
	CompanyComputerLinuxBoundary: class {
		assertOfficeReady = linuxGuest.ready;
		assertPhysicalReady = linuxGuest.physical;
	},
}));
vi.mock("../src/cloud-company-computer-linux-guest.ts", () => ({
	CompanyComputerLinuxGuest: class {
		constructor(options: CompanyComputerLinuxGuestOptions) {
			Object.assign(this, linuxGuest.construct(options));
		}
	},
}));

let directory: string;
let cert: Buffer;
let key: Buffer;
let originalCAs: string[];
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "qorpera-office-service-tls-"));
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(directory, "key.pem"),
			"-out",
			join(directory, "cert.pem"),
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
		],
		{ timeout: 15000, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error("Disposable TLS certificate creation failed");
	cert = await readFile(join(directory, "cert.pem"));
	key = await readFile(join(directory, "key.pem"));
	originalCAs = getCACertificates("default");
	setDefaultCACertificates([...originalCAs, cert]);
});
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	linuxGuest.construct.mockReset();
	linuxGuest.ready.mockReset();
	linuxGuest.physical.mockReset();
});
afterAll(async () => {
	setDefaultCACertificates(originalCAs);
	await rm(directory, { recursive: true, force: true });
});

function fixture() {
	const drain = { state: "draining", drainId: computerId(44), epoch: 2, binding: computerBinding() };
	const challenge = {
		scope: computerScope(),
		computerGeneration: 1,
		challengeId: computerId(40),
		version: 1,
		state: "entering",
		memberId: computerId(41),
		profileId: computerId(42),
		profileVersion: 2,
		screenId: computerBinding().screenId,
		drains: [drain],
	};
	const state = {
		scope: computerScope(),
		computerGeneration: 1,
		revision: 1,
		state: "active",
		privacyState: "shared",
		privacyVersion: 0,
		privacyChallenge: null as unknown,
		drains: [] as unknown[],
	};
	const order: string[] = [];
	const sql = vi.fn<typeof fetch>(async (url, init) => {
		const method = String(url).split("/").at(-1);
		const body = JSON.parse(String(init?.body));
		if (method === "qorpera_runtime_office_supervisor_status") {
			order.push("status");
			return Response.json(state);
		}
		if (method === "qorpera_ack_runtime_office_drain") {
			order.push("ack-drain");
			state.drains = [];
			return Response.json({ state: "drained", drainId: body.p_drain_id, epoch: body.p_epoch });
		}
		if (method === "qorpera_ack_runtime_office_privacy") {
			order.push("ack-private");
			state.privacyState = "private";
			return Response.json({ state: "private", challengeId: challenge.challengeId, version: 1 });
		}
		throw new Error(`Unexpected synthetic RPC ${method}`);
	});
	const registry = new HttpCloudCompanyComputerRegistry({
		supabaseUrl: "https://registry.qorpera.test",
		serviceRoleKey: "synthetic-service-key",
		fetch: sql,
	});
	const guest = {
		createSession: vi.fn<CompanyComputerServiceGuest["createSession"]>(async () => {
			throw new Error("No native fixture run");
		}),
		viewer: {
			connect: vi.fn<CompanyComputerServiceGuest["viewer"]["connect"]>(async () => {
				throw new Error("No member fixture ticket");
			}),
		},
		privacy: {
			fence: vi.fn(async () => {
				order.push("guest:privacy-fence");
			}),
			secureSurface: vi.fn(async () => {
				order.push("guest:private-surface");
			}),
		},
		stopResources: vi.fn(async () => {
			order.push("guest:drain");
		}),
		close: vi.fn(async () => {
			order.push("guest:close");
		}),
	};
	const abort = new AbortController();
	const options = {
		scope: computerScope(),
		computerGeneration: 1,
		registry,
		guest,
		signal: abort.signal,
		native: { host: "127.0.0.1", port: 0, token: randomBytes(32).toString("base64url"), tls: { cert, key } },
		viewer: { host: "127.0.0.1", port: 0, origins: ["https://app.qorpera.test"], tls: { cert, key } },
	};
	const request = (port: number) =>
		fetch(`https://127.0.0.1:${port}/office/${computerScope().companyComputerId}/native`, {
			headers: { connection: "close" },
		});
	return { state, challenge, drain, sql, guest, abort, options, order, request };
}

function linuxFixture(f: ReturnType<typeof fixture>) {
	const identity = {
		scope: computerScope(),
		computerGeneration: 1,
		allocationId: computerId(70),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId: computerId(71),
		configurationSha256: "d".repeat(64),
		serviceInvocationId: "e".repeat(32),
	};
	const startup = new CompanyComputerStartupControl(identity, {
		call: async () => ({
			schema: "qorpera.office-startup-authority/v1",
			activationId: computerId(72),
			bootId: identity.bootId,
			configurationSha256: identity.configurationSha256,
			state: "active",
			serviceInvocationId: identity.serviceInvocationId,
			validForMs: 5000,
		}),
	});
	const screenLifecycle = {
		create: vi.fn(() => {
			throw new Error("PHYSICAL_GUEST_MOCKED");
		}),
	};
	linuxGuest.ready.mockResolvedValue(undefined);
	let fail!: (error: Error) => void;
	linuxGuest.construct.mockImplementation((options: CompanyComputerLinuxGuestOptions) => {
		expect(options.scope).toEqual(f.options.scope);
		expect(options.computerGeneration).toBe(f.options.computerGeneration);
		expect(options.registry).toBe(f.options.registry);
		expect(options.screenLifecycle).toBe(screenLifecycle);
		fail = options.onFailure;
		return f.guest;
	});
	return {
		fail: () => fail(new Error("synthetic idle display failure")),
		start: (control: CompanyComputerStartupControl = startup) =>
			startCompanyComputerLinuxOfficeService({
				...f.options,
				screenLifecycle,
				startup: control,
				captureObjectGateway: { baseUrl: "https://objects.example", token: "x".repeat(43) },
				linux: {
					layout: {
						workbenchRoot: "/srv/workbench",
						desktopHome: "/srv/desktop",
						screenStateRoot: "/srv/screens",
						browserProfilesRoot: "/srv/profiles",
					},
					limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
					workbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/srv" },
					privateWorkbenchMount: { filesystem: "tmpfs", source: "tmpfs", root: "/", mountPoint: "/run/private" },
					displayRuntimeRoot: "/run/screens",
					browserRuntimeRoot: "/run/browser",
					captureRoot: "/run/captures",
					attestation: {
						allocationId: computerId(70),
						instanceSha256: "a".repeat(64),
						imageSha256: "b".repeat(64),
						bootstrapSha256: "c".repeat(64),
						bootId: computerId(71),
						adoptionReceiptPath: "/etc/qorpera/adoption.json",
						adoptionReceiptSha256: "d".repeat(64),
					},
				},
			}),
	};
}

describe("headless office service lifetime (TLS listeners, synthetic physical adapters)", () => {
	it("keeps actual listeners closed during a post-activation metering gap and recovers without replacing the invocation", async () => {
		const f = fixture(),
			linux = linuxFixture(f),
			recovered = computerDeferred<void>();
		let nativePort = 0;
		const identity = {
			scope: computerScope(),
			computerGeneration: 1,
			allocationId: computerId(70),
			instanceSha256: "a".repeat(64),
			imageSha256: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			bootId: computerId(71),
			configurationSha256: "d".repeat(64),
			serviceInvocationId: "e".repeat(32),
		};
		const startup = new CompanyComputerStartupControl(identity, {
			call: async (_method, args) => {
				if (typeof args.p_native_port === "number") nativePort = args.p_native_port;
				return {
					schema: "qorpera.office-startup-authority/v1",
					activationId: computerId(72),
					bootId: identity.bootId,
					configurationSha256: identity.configurationSha256,
					state: "active",
					serviceInvocationId: identity.serviceInvocationId,
					validForMs: 5000,
				};
			},
		});
		linuxGuest.ready
			.mockRejectedValueOnce(new OfficeComputerMeteringPending())
			.mockImplementationOnce(() => recovered.promise);
		const starting = linux.start(startup);
		cleanups.push(async () => {
			recovered.resolve();
			await (await starting).close();
		});
		await vi.waitFor(() => expect(linuxGuest.ready).toHaveBeenCalledOnce());
		const reply = await fetch(`https://127.0.0.1:${nativePort}/office/${computerScope().companyComputerId}/native`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${f.options.native.token}`,
				"content-type": "application/json",
				connection: "close",
			},
			body: "{}",
		});
		expect(reply.status).toBe(503);
		expect(f.guest.createSession).not.toHaveBeenCalled();
		expect(f.guest.close).not.toHaveBeenCalled();
		recovered.resolve();
		await starting;
		expect(linuxGuest.construct).toHaveBeenCalledOnce();
		expect(linuxGuest.ready).toHaveBeenCalledTimes(2);
	});
	it("keeps both actual TLS listeners closed to work until provider activation", async () => {
		const f = fixture(),
			bound = computerDeferred<{ nativePort: number; viewerPort: number }>(),
			activated = computerDeferred<void>();
		const starting = startCompanyComputerOfficeService({
			...f.options,
			waitForActivation: async (ports) => {
				bound.resolve(ports);
				await activated.promise;
			},
		});
		cleanups.push(async () => {
			activated.resolve();
			await (await starting).close();
		});
		const ports = await bound.promise;
		const result = await fetch(
			`https://127.0.0.1:${ports.nativePort}/office/${computerScope().companyComputerId}/native`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${f.options.native.token}`,
					"content-type": "application/json",
					connection: "close",
				},
				body: "{}",
			},
		);
		expect(result.status).toBe(503);
		await expect(
			connectCompanyComputerViewChannel({
				url: `wss://127.0.0.1:${ports.viewerPort}/office/${computerScope().companyComputerId}/view`,
				capability: randomBytes(32).toString("base64url"),
				binding: computerBinding(),
				mode: "watch",
				validForMs: 30000,
				signal: new AbortController().signal,
				createWebSocket: (url) => new WebSocket(url, { headers: { Origin: "https://app.qorpera.test" } }),
			}),
		).rejects.toThrow();
		expect(f.sql).not.toHaveBeenCalled();
		expect(f.guest.createSession).not.toHaveBeenCalled();
		expect(f.guest.viewer.connect).not.toHaveBeenCalled();
		activated.resolve();
		await starting;
		expect(f.sql).toHaveBeenCalled();
	});
	it("closes both listeners and the guest when startup authorization is revoked", async () => {
		const f = fixture();
		let ports!: { nativePort: number; viewerPort: number };
		await expect(
			startCompanyComputerOfficeService({
				...f.options,
				waitForActivation: async (bound) => {
					ports = bound;
					throw new Error("startup revoked");
				},
			}),
		).rejects.toThrow("OFFICE_SERVICE_START_FAILED");
		expect(f.guest.close).toHaveBeenCalledOnce();
		expect(f.sql).not.toHaveBeenCalled();
		await expect(f.request(ports.nativePort)).rejects.toThrow();
		await expect(fetch(`https://127.0.0.1:${ports.viewerPort}/`)).rejects.toThrow();
	});
	it("runs physical-only preflight before standby, then active preflight before ordinary reconciliation", async () => {
		const f = fixture(),
			linux = linuxFixture(f);
		f.state.state = "provisioning";
		const startupIdentity = {
			scope: computerScope(),
			computerGeneration: 1,
			allocationId: computerId(70),
			instanceSha256: "a".repeat(64),
			imageSha256: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			bootId: computerId(71),
			configurationSha256: "d".repeat(64),
			serviceInvocationId: "e".repeat(32),
		};
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (url, init) => {
			const method = String(url).split("/").at(-1);
			if (method === "qorpera_check_runtime_office_startup" || method === "qorpera_report_runtime_office_ready") {
				const ready = method === "qorpera_report_runtime_office_ready";
				if (ready) {
					expect(linuxGuest.ready).not.toHaveBeenCalled();
					f.state.state = "active";
				}
				return Response.json({
					schema: "qorpera.office-startup-authority/v1",
					activationId: computerId(72),
					bootId: startupIdentity.bootId,
					configurationSha256: startupIdentity.configurationSha256,
					state: ready ? "active" : "prepared",
					serviceInvocationId: ready ? startupIdentity.serviceInvocationId : null,
					validForMs: 5000,
				});
			}
			return original(url, init);
		});
		linuxGuest.physical.mockResolvedValue(undefined);
		const service = await linux.start(new CompanyComputerStartupControl(startupIdentity, f.options.registry));
		cleanups.push(service.close);
		expect(linuxGuest.physical).toHaveBeenCalledTimes(2);
		expect(linuxGuest.ready).toHaveBeenCalledOnce();
	});
	it("refuses startup before constructing a guest when physical adoption cannot be confirmed", async () => {
		const f = fixture();
		const linux = linuxFixture(f);
		linuxGuest.physical.mockRejectedValue(new Error("OFFICE_GUEST_READINESS_UNCONFIRMED"));
		await expect(linux.start()).rejects.toThrow("OFFICE_GUEST_READINESS_UNCONFIRMED");
		expect(linuxGuest.construct).not.toHaveBeenCalled();
		expect(f.sql).not.toHaveBeenCalled();
	});
	it("closes both actual listeners and reports failure when the Linux guest fails while idle", async () => {
		const f = fixture();
		const linux = linuxFixture(f);
		const service = await linux.start();
		cleanups.push(() => service.close().catch(() => undefined));
		expect((await f.request(service.nativePort)).status).toBe(403);
		linux.fail();
		await expect(service.finished).rejects.toThrow("OFFICE_LINUX_GUEST_FAILED");
		expect(f.guest.close).toHaveBeenCalledOnce();
		await expect(f.request(service.nativePort)).rejects.toThrow();
		await expect(f.request(service.viewerPort)).rejects.toThrow();
		await expect(service.close()).rejects.toThrow("OFFICE_LINUX_GUEST_FAILED");
	});
	it("does not report Linux service readiness when its guest fails during startup reconciliation", async () => {
		const f = fixture();
		const linux = linuxFixture(f);
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (...args) => {
			linux.fail();
			return original(...args);
		});
		await expect(linux.start()).rejects.toThrow("OFFICE_SERVICE_START_FAILED");
		expect(f.guest.close).toHaveBeenCalledOnce();
	});
	it("preserves an unconfirmed physical drain when a Linux guest failure stops the service", async () => {
		const f = fixture();
		const linux = linuxFixture(f);
		const service = await linux.start();
		cleanups.push(() => service.close().catch(() => undefined));
		f.guest.close.mockRejectedValue(new Error("synthetic physical drain unknown"));
		linux.fail();
		await expect(service.finished).rejects.toThrow("OFFICE_SERVICE_DRAIN_UNCONFIRMED");
		await expect(f.request(service.nativePort)).rejects.toThrow();
		await expect(f.request(service.viewerPort)).rejects.toThrow();
	});
	it("cancels an in-flight member input admission on service stop before bytes reach the guest", async () => {
		const f = fixture();
		const sockets = new Set<Socket>();
		const received: Buffer[] = [];
		const guestServer = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => undefined);
			socket.on("data", (bytes: Buffer) => received.push(bytes));
			socket.write(computerRfbServerHello());
		});
		await new Promise<void>((resolve) => guestServer.listen(0, "127.0.0.1", resolve));
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => guestServer.close(() => resolve()));
		});
		const address = guestServer.address();
		if (!address || typeof address === "string") throw new Error("Missing guest fixture port");
		f.guest.viewer.connect.mockImplementation(async () => {
			const socket = connect(address.port, "127.0.0.1");
			sockets.add(socket);
			socket.on("error", () => undefined);
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.pause();
			return { socket, remainder: Buffer.alloc(0) };
		});
		const grant = {
			binding: computerBinding(),
			viewerSessionId: computerId(21),
			memberId: computerId(8),
			mode: "control",
			privacyVersion: 0,
			screenEpoch: 1,
			validForMs: 30000,
			lease: { ...computerLease(), driver: { kind: "member", memberId: computerId(8), sessionId: computerId(21) } },
		};
		const entered = computerDeferred<void>();
		const admission = computerDeferred<Response>();
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (url, init) => {
			const method = String(url).split("/").at(-1);
			if (method === "qorpera_redeem_runtime_office_viewer" || method === "qorpera_check_runtime_office_viewer")
				return Response.json(grant);
			if (method === "qorpera_release_runtime_office_viewer") return Response.json({ state: "released" });
			if (method === "qorpera_admit_runtime_office_viewer_input_window") {
				entered.resolve();
				return admission.promise;
			}
			return original(url, init);
		});
		const service = await startCompanyComputerOfficeService(f.options);
		cleanups.push(service.close);
		const channel = await connectCompanyComputerViewChannel({
			url: `wss://127.0.0.1:${service.viewerPort}/office/${computerScope().companyComputerId}/view`,
			capability: randomBytes(32).toString("base64url"),
			binding: computerBinding(),
			mode: "control",
			validForMs: 30000,
			signal: new AbortController().signal,
			createWebSocket: (url) => new WebSocket(url, { headers: { Origin: "https://app.qorpera.test" } }),
		});
		cleanups.push(async () => channel.close());
		channel.send(new TextEncoder().encode("RFB 003.008\n"));
		channel.send(Uint8Array.from([1, 1]));
		const hello = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
		await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(hello));
		channel.send(Uint8Array.from([4, 1, 0, 0, 0, 0, 0, 65]));
		await entered.promise;
		f.abort.abort();
		await service.finished;
		admission.resolve(Response.json({ state: "admitted", validForMs: 1000 }));
		expect(Buffer.concat(received)).toEqual(hello);
		expect(f.guest.close).toHaveBeenCalledOnce();
	});
	it("reconciles with every member offline and closes both actual listeners on service cancellation", async () => {
		const f = fixture();
		const service = await startCompanyComputerOfficeService(f.options);
		cleanups.push(service.close);
		await vi.waitFor(() => expect(f.sql.mock.calls.length).toBeGreaterThanOrEqual(2));
		expect((await f.request(service.nativePort)).status).toBe(403);
		expect((await f.request(service.viewerPort)).status).toBe(404);
		expect(f.guest.viewer.connect).not.toHaveBeenCalled();
		expect(f.guest.createSession).not.toHaveBeenCalled();
		f.abort.abort();
		await service.finished;
		expect(f.guest.close).toHaveBeenCalledOnce();
		await expect(f.request(service.nativePort)).rejects.toThrow();
		await expect(f.request(service.viewerPort)).rejects.toThrow();
	});
	it("waits for physical resource drain before startup and before the exact cloud acknowledgement", async () => {
		const f = fixture();
		f.state.drains = [f.drain];
		const drained = computerDeferred<void>();
		f.guest.stopResources.mockImplementationOnce(async () => {
			await drained.promise;
			f.order.push("guest:drain");
		});
		let ready = false;
		const starting = startCompanyComputerOfficeService(f.options).then((service) => {
			ready = true;
			return service;
		});
		await vi.waitFor(() => expect(f.guest.stopResources).toHaveBeenCalledOnce());
		expect(ready).toBe(false);
		expect(f.order).not.toContain("ack-drain");
		drained.resolve();
		const service = await starting;
		cleanups.push(service.close);
		expect(f.order.indexOf("guest:drain")).toBeLessThan(f.order.indexOf("ack-drain"));
	});
	it("composes privacy entry in fence, drain, private-surface and acknowledgement order", async () => {
		const f = fixture();
		Object.assign(f.state, {
			privacyState: "entering",
			privacyVersion: 1,
			privacyChallenge: f.challenge,
			drains: [f.drain],
		});
		const service = await startCompanyComputerOfficeService(f.options);
		cleanups.push(service.close);
		expect(f.order.indexOf("guest:privacy-fence")).toBeLessThan(f.order.indexOf("guest:drain"));
		expect(f.order.indexOf("ack-drain")).toBeLessThan(f.order.indexOf("guest:private-surface"));
		expect(f.order.indexOf("guest:private-surface")).toBeLessThan(f.order.indexOf("ack-private"));
		expect(f.guest.privacy.secureSurface).toHaveBeenCalledOnce();
	});
	it("restores the physical private barrier without replaying sign-in preparation", async () => {
		const f = fixture();
		Object.assign(f.state, { privacyState: "private", privacyVersion: 1, privacyChallenge: f.challenge });
		const service = await startCompanyComputerOfficeService(f.options);
		cleanups.push(service.close);
		expect(f.guest.privacy.fence).toHaveBeenCalled();
		expect(f.guest.privacy.secureSurface).not.toHaveBeenCalled();
		expect(f.order).not.toContain("ack-private");
	});
	it("fails startup for an inactive office and still reaps the supplied guest", async () => {
		const f = fixture();
		f.state.state = "provisioning";
		await expect(startCompanyComputerOfficeService(f.options)).rejects.toThrow("OFFICE_SERVICE_START_FAILED");
		expect(f.guest.close).toHaveBeenCalledOnce();
		expect(f.guest.stopResources).not.toHaveBeenCalled();
	});
	it("refuses new viewer admission during a transient unconfirmed status gap and serves again after it", async () => {
		const f = fixture();
		const original = f.sql.getMockImplementation()!;
		const held = computerDeferred<Response>();
		let statusCalls = 0;
		f.sql.mockImplementation(async (url, init) => {
			const method = String(url).split("/").at(-1);
			if (method === "qorpera_runtime_office_supervisor_status") {
				statusCalls++;
				// The second poll never answers inside the registry deadline; the
				// third waits until the admission attempts below have been observed.
				if (statusCalls === 2) return new Promise<Response>(() => undefined);
				if (statusCalls === 3) return held.promise;
			}
			if (method === "qorpera_redeem_runtime_office_viewer") throw new Error("redeem reached SQL");
			return original(url, init);
		});
		const journal: string[] = [];
		const capabilities: string[] = [];
		const service = await startCompanyComputerOfficeService({
			...f.options,
			writeDiagnostic: (line) => journal.push(line),
		});
		cleanups.push(service.close);
		const admit = () =>
			connectCompanyComputerViewChannel({
				url: `wss://127.0.0.1:${service.viewerPort}/office/${computerScope().companyComputerId}/view`,
				capability: capabilities[capabilities.push(randomBytes(32).toString("base64url")) - 1],
				binding: computerBinding(),
				mode: "watch",
				validForMs: 30000,
				signal: new AbortController().signal,
				createWebSocket: (url) => new WebSocket(url, { headers: { Origin: "https://app.qorpera.test" } }),
			});
		const redeems = () =>
			f.sql.mock.calls.filter(([url]) => String(url).endsWith("qorpera_redeem_runtime_office_viewer")).length;
		await vi.waitFor(() => expect(statusCalls).toBe(3), { timeout: 10000 });
		await expect(admit()).rejects.toThrow();
		expect(redeems()).toBe(0);
		// The member saw only a closed view; this machine's journal says why, with
		// the supervisor facts that closed admission and nothing about the member.
		expect(journal).toHaveLength(1);
		const refusal = JSON.parse(journal[0]);
		expect(refusal).toEqual({
			schema: "qorpera.office-viewer-refusal/v1",
			stage: "redeem",
			codes: ["OFFICE_SUPERVISOR_STATUS_STALE"],
			categories: ["unknown"],
			suppressed: 0,
			serving: true,
			supervisor: {
				failed: false,
				unconfirmedMs: expect.any(Number),
				unconfirmedPolls: expect.any(Number),
				confirmedRevision: 1,
			},
		});
		expect(refusal.supervisor.unconfirmedMs).toBeGreaterThanOrEqual(0);
		expect(refusal.supervisor.unconfirmedPolls).toBeGreaterThanOrEqual(1);
		held.resolve(Response.json(f.state));
		await vi.waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(4), { timeout: 10000 });
		await expect(admit()).rejects.toThrow();
		expect(redeems()).toBe(1);
		expect(f.guest.close).not.toHaveBeenCalled();
		// A different cause is a new line: admission was open, SQL refused the ticket.
		expect(journal).toHaveLength(2);
		expect(JSON.parse(journal[1])).toMatchObject({
			stage: "redeem",
			serving: true,
			supervisor: { failed: false, unconfirmedMs: null, unconfirmedPolls: 0 },
		});
		expect(JSON.parse(journal[1]).codes).not.toContain("OFFICE_SUPERVISOR_STATUS_STALE");
		const written = journal.join("\n");
		for (const capability of capabilities) expect(written).not.toContain(capability);
		for (const secret of ["redeem reached SQL", "app.qorpera.test", "127.0.0.1", computerScope().companyComputerId])
			expect(written).not.toContain(secret);
	});
	it("keeps exact native release available when the composed service refuses stale new work", async () => {
		const f = fixture();
		const source = nativeToolAuthorityFixture();
		const scope = {
			...computerScope(),
			companyId: source.authority.identity.companyId,
			environmentId: source.authority.identity.environmentId,
		};
		f.options.scope = scope;
		f.state.scope = scope;
		const lease = {
			...computerLease(),
			binding: { ...computerBinding(), ...scope, staffAgentId: source.authority.identity.staffAgentId },
			driver: { kind: "agent", runId: source.binding.runId, staffAgentId: source.authority.identity.staffAgentId },
		};
		const resources = { officeGrantId: randomUUID(), officeGrantVersion: 1, officePrivacyVersion: 0 };
		const perform = vi.fn(async () => ({ kind: "text" as const, value: "fixture" }));
		const physicalClose = vi.fn(async () => {
			f.order.push("native:physical-close");
		});
		f.guest.createSession.mockResolvedValue({
			endpoint: { capabilities: ["shell"], resourceTarget: resources, authorize: async () => undefined, perform },
			close: physicalClose,
		});
		const original = f.sql.getMockImplementation()!;
		f.sql.mockImplementation(async (url, init) => {
			const method = String(url).split("/").at(-1);
			if (method === "qorpera_describe_native_tool_authority") return Response.json(source.authority);
			if (method === "qorpera_native_office_descriptor")
				return Response.json({ state: "available", scope, capabilities: ["shell"], resources });
			if (method === "qorpera_native_office_operation") return Response.json({ state: "authorized" });
			if (method === "qorpera_native_office_screen") {
				f.order.push("native:sql-release");
				return Response.json({ state: "released" });
			}
			return original(url, init);
		});
		const service = await startCompanyComputerOfficeService(f.options);
		cleanups.push(service.close);
		const post = (body: unknown) =>
			fetch(`https://127.0.0.1:${service.nativePort}/office/${scope.companyComputerId}/native`, {
				method: "POST",
				headers: { authorization: `Bearer ${f.options.native.token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const body = {
			schema: "qorpera.company-computer-native/v1",
			action: "perform",
			nativeBinding: source.binding,
			lease,
			operation: {
				...computerOperation(),
				tool: "computer_shell",
				arguments: { kind: "shell", command: "printf fixture", timeoutMs: 1000 },
				target: { realm: "company_computer", binding: lease.binding, resources },
			},
			receipt: { receiptId: randomUUID(), idempotencyKey: "a".repeat(64) },
		};
		expect((await post(body)).status).toBe(200);
		const status = vi.spyOn(CompanyComputerOfficeSupervisor.prototype, "assertConfirmed").mockImplementation(() => {
			throw new Error("OFFICE_SUPERVISOR_STATUS_STALE");
		});
		try {
			expect((await post(body)).status).toBe(503);
			expect(
				(await post({ schema: body.schema, action: "release", nativeBinding: source.binding, lease })).status,
			).toBe(200);
			expect(perform).toHaveBeenCalledOnce();
			expect(physicalClose).toHaveBeenCalledOnce();
			expect(f.order.indexOf("native:physical-close")).toBeLessThan(f.order.indexOf("native:sql-release"));
			expect(f.guest.close).not.toHaveBeenCalled();
		} finally {
			status.mockRestore();
		}
	});
	it("shuts both listeners and physical resources when supervision becomes unavailable", async () => {
		const f = fixture();
		const service = await startCompanyComputerOfficeService(f.options);
		f.state.state = "maintenance";
		await expect(service.finished).rejects.toThrow("OFFICE_SERVICE_SUPERVISION_FAILED");
		expect(f.guest.close).toHaveBeenCalledOnce();
		await expect(f.request(service.nativePort)).rejects.toThrow();
		await expect(f.request(service.viewerPort)).rejects.toThrow();
	});
	it("reports uncertain guest shutdown even when both listeners have closed", async () => {
		const f = fixture();
		const service = await startCompanyComputerOfficeService(f.options);
		f.guest.close.mockRejectedValue(new Error("private supervisor diagnostic"));
		await expect(service.close()).rejects.toThrow("OFFICE_SERVICE_DRAIN_UNCONFIRMED");
		await expect(f.request(service.nativePort)).rejects.toThrow();
		await expect(f.request(service.viewerPort)).rejects.toThrow();
		expect(f.guest.close).toHaveBeenCalledOnce();
	});
});
