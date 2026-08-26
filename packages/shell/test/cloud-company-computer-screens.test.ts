import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
	CloudCompanyComputerScreenManager,
	type CompanyComputerScreenLaunch,
	type CompanyComputerScreenLauncher,
	type CompanyComputerScreenRecord,
	companyComputerScreenDisplay,
	companyComputerScreenVncPort,
	ExecCompanyComputerScreenLauncher,
	parseCloudCompanyComputerScreensConfig,
	parseCompanyComputerScreenRecords,
	runCloudCompanyComputerScreenAgent,
	SupabaseCompanyComputerScreensControlPlane,
	startCompanyComputerScreenViewer,
} from "../src/cloud-company-computer-screens.ts";

const companyComputerId = "30000000-0000-4000-8000-000000000002";
const screenId = "30000000-0000-4000-8000-000000000031";
const staffAgentId = "30000000-0000-4000-8000-000000000014";
const viewerToken = "A".repeat(43);

function screenRecord(ordinal: number, status: "active" | "retired" = "active"): CompanyComputerScreenRecord {
	return {
		screenId,
		screenOrdinal: ordinal,
		displayName: `Screen ${ordinal}`,
		status,
	};
}

class FakeLauncher implements CompanyComputerScreenLauncher {
	launches: CompanyComputerScreenLaunch[] = [];
	handles = new Map<number, { resolveExit: () => void; stopped: boolean }>();

	async launch(screen: CompanyComputerScreenLaunch) {
		this.launches.push(screen);
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolveExited) => {
			resolveExit = resolveExited;
		});
		const entry = { resolveExit, stopped: false };
		this.handles.set(screen.ordinal, entry);
		return {
			exited,
			stop: async () => {
				entry.stopped = true;
				resolveExit();
			},
		};
	}
}

class FakeScreenProcess extends EventEmitter {
	signals: NodeJS.Signals[] = [];

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		return true;
	}
}

function reader(socket: Socket): { readLine: () => Promise<string>; readBytes: (count: number) => Promise<Buffer> } {
	let buffered = Buffer.alloc(0);
	let notify: (() => void) | undefined;
	let closed = false;
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		notify?.();
	});
	socket.on("close", () => {
		closed = true;
		notify?.();
	});
	socket.on("error", () => {
		closed = true;
		notify?.();
	});
	const waitFor = async <T>(attempt: () => T | undefined): Promise<T> => {
		for (;;) {
			const value = attempt();
			if (value !== undefined) return value;
			if (closed) throw new Error("socket closed before the expected bytes arrived");
			await new Promise<void>((resolveWait) => {
				notify = resolveWait;
			});
			notify = undefined;
		}
	};
	return {
		readLine: () =>
			waitFor(() => {
				const newline = buffered.indexOf(0x0a);
				if (newline === -1) return undefined;
				const line = buffered.subarray(0, newline).toString("utf-8");
				buffered = buffered.subarray(newline + 1);
				return line;
			}),
		readBytes: (count) =>
			waitFor(() => {
				if (buffered.byteLength < count) return undefined;
				const bytes = buffered.subarray(0, count);
				buffered = buffered.subarray(count);
				return Buffer.from(bytes);
			}),
	};
}

async function fakeVncServer(): Promise<{ port: number; server: Server }> {
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.write("RFB 003.008\n");
		socket.on("data", (chunk) => socket.write(chunk));
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("fake VNC server has no port");
	return { port: address.port, server };
}

async function refusedPort(): Promise<number> {
	const placeholder = createServer();
	await new Promise<void>((resolveListen) => placeholder.listen(0, "127.0.0.1", () => resolveListen()));
	const address = placeholder.address();
	if (typeof address !== "object" || !address) throw new Error("placeholder server has no port");
	await closeServer(placeholder);
	return address.port;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose) => server.close(() => resolveClose()));
}

describe("cloud company computer screens", () => {
	it("parses exactly the bootstrap screens block and rejects out-of-contract values", () => {
		expect(
			parseCloudCompanyComputerScreensConfig({
				viewer_host: "0.0.0.0",
				viewer_port: 8446,
				viewer_trusted_source: "10.41.0.1",
				poll_seconds: 30,
				future_field: true,
			}),
		).toEqual({
			viewerHost: "0.0.0.0",
			viewerPort: 8446,
			viewerTrustedSource: "10.41.0.1",
			pollSeconds: 30,
		});
		expect(() =>
			parseCloudCompanyComputerScreensConfig({
				viewer_host: "not-an-ip",
				viewer_port: 8446,
				viewer_trusted_source: "10.41.0.1",
				poll_seconds: 30,
			}),
		).toThrow("viewer host is invalid");
		expect(() =>
			parseCloudCompanyComputerScreensConfig({
				viewer_host: "0.0.0.0",
				viewer_port: 80,
				viewer_trusted_source: "10.41.0.1",
				poll_seconds: 30,
			}),
		).toThrow("viewer port is invalid");
		expect(() =>
			parseCloudCompanyComputerScreensConfig({
				viewer_host: "0.0.0.0",
				viewer_port: 8446,
				viewer_trusted_source: "fd00::1",
				poll_seconds: 30,
			}),
		).toThrow("trusted source is invalid");
		expect(() =>
			parseCloudCompanyComputerScreensConfig({
				viewer_host: "0.0.0.0",
				viewer_port: 8446,
				viewer_trusted_source: "10.41.0.1",
				poll_seconds: 4,
			}),
		).toThrow("poll interval is invalid");
	});

	it("parses screen records from the service listing and rejects malformed rows", () => {
		const records = parseCompanyComputerScreenRecords([
			{
				screen_id: screenId,
				profile_id: "30000000-0000-4000-8000-000000000003",
				company_computer_id: companyComputerId,
				screen_ordinal: 2,
				display_name: "Screen 2",
				status: "active",
				attached_staff_agent_id: staffAgentId,
				attached_at: "2026-08-26T12:00:00.000Z",
				occupying_run_id: null,
				occupancy_expires_at: null,
				created_at: "2026-08-26T12:00:00.000Z",
				updated_at: "2026-08-26T12:00:00.000Z",
			},
		]);
		expect(records).toEqual([
			{
				screenId,
				screenOrdinal: 2,
				displayName: "Screen 2",
				status: "active",
				attachedStaffAgentId: staffAgentId,
			},
		]);
		expect(() => parseCompanyComputerScreenRecords([{ screen_id: "nope" }])).toThrow("record is invalid");
		expect(() => parseCompanyComputerScreenRecords({})).toThrow("listing is invalid");
	});

	it("lists screens through the service RPC with the provider header convention", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const controlPlane = new SupabaseCompanyComputerScreensControlPlane(
			"https://control.example.com",
			"service-key",
			(async (url: unknown, init?: { body?: unknown }) => {
				calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
				return new Response(JSON.stringify([]), { status: 200 });
			}) as typeof fetch,
		);
		await expect(controlPlane.listScreens(companyComputerId)).resolves.toEqual([]);
		expect(calls).toEqual([
			{
				url: "https://control.example.com/rest/v1/rpc/qorpera_list_company_computer_screens",
				body: { p_company_computer_id: companyComputerId },
			},
		]);
		const failing = new SupabaseCompanyComputerScreensControlPlane(
			"https://control.example.com",
			"service-key",
			(async () => new Response("nope", { status: 500 })) as typeof fetch,
		);
		await expect(failing.listScreens(companyComputerId)).rejects.toThrow("failed (500)");
	});

	it("converges desktop sessions to the registry and relaunches crashed sessions", async () => {
		const launcher = new FakeLauncher();
		const manager = new CloudCompanyComputerScreenManager(launcher);
		await manager.reconcile([screenRecord(1), screenRecord(3)]);
		expect(launcher.launches).toEqual([
			{ ordinal: 1, display: ":1", vncPort: 5901 },
			{ ordinal: 3, display: ":3", vncPort: 5903 },
		]);
		expect(manager.liveOrdinals()).toEqual([1, 3]);
		expect(manager.liveVncPort(3)).toBe(5903);
		expect(manager.liveVncPort(2)).toBeUndefined();

		await manager.reconcile([screenRecord(1), screenRecord(3, "retired")]);
		expect(manager.liveOrdinals()).toEqual([1]);
		expect(launcher.handles.get(3)?.stopped).toBe(true);

		launcher.handles.get(1)?.resolveExit();
		await new Promise((resolveTick) => setImmediate(resolveTick));
		expect(manager.liveOrdinals()).toEqual([]);
		await manager.reconcile([screenRecord(1)]);
		expect(manager.liveOrdinals()).toEqual([1]);
		expect(launcher.launches).toHaveLength(3);

		await manager.stopAll();
		expect(manager.liveOrdinals()).toEqual([]);
		expect(launcher.handles.get(1)?.stopped).toBe(true);
	});

	it("substitutes the screen into the exec template and stops with escalation wiring", async () => {
		const spawned: Array<{ command: string; args: readonly string[]; child: FakeScreenProcess }> = [];
		const launcher = new ExecCompanyComputerScreenLauncher(
			["/usr/local/bin/qorpera-screen-session", "--display", "{display}", "--rfbport", "{vnc_port}"],
			(command, args) => {
				const child = new FakeScreenProcess();
				spawned.push({ command, args, child });
				return child;
			},
		);
		const handle = await launcher.launch({
			ordinal: 2,
			display: companyComputerScreenDisplay(2),
			vncPort: companyComputerScreenVncPort(2),
		});
		expect(spawned).toHaveLength(1);
		expect(spawned[0].command).toBe("/usr/local/bin/qorpera-screen-session");
		expect(spawned[0].args).toEqual(["--display", ":2", "--rfbport", "5902"]);

		const stopped = handle.stop();
		expect(spawned[0].child.signals).toEqual(["SIGTERM"]);
		spawned[0].child.emit("exit");
		await stopped;
		await handle.exited;

		expect(() => new ExecCompanyComputerScreenLauncher(["/bin/true"])).toThrow(
			"must reference {ordinal}, {display}, or {vnc_port}",
		);
	});

	it("bridges an authorized attach to the loopback VNC socket and refuses everything else", async () => {
		const vnc = await fakeVncServer();
		const deadPort = await refusedPort();
		const viewer = await startCompanyComputerScreenViewer({
			host: "127.0.0.1",
			port: 0,
			trustedSource: "127.0.0.1",
			viewerToken,
			liveVncPort: (ordinal) => (ordinal === 3 ? vnc.port : ordinal === 9 ? deadPort : undefined),
		});
		try {
			const attach = connect(viewer.port, "127.0.0.1");
			const attached = reader(attach);
			attach.write(
				`${JSON.stringify({
					schema: "qorpera.company-computer-screen-attach/v1",
					token: viewerToken,
					screen_ordinal: 3,
				})}\n`,
			);
			expect(JSON.parse(await attached.readLine())).toEqual({ ok: true, screen_ordinal: 3 });
			expect(await attached.readLine()).toBe("RFB 003.008");
			attach.write("hello");
			expect((await attached.readBytes(5)).toString("utf-8")).toBe("hello");
			attach.destroy();

			const badToken = connect(viewer.port, "127.0.0.1");
			const badTokenReader = reader(badToken);
			badToken.write(
				`${JSON.stringify({
					schema: "qorpera.company-computer-screen-attach/v1",
					token: "B".repeat(43),
					screen_ordinal: 3,
				})}\n`,
			);
			expect(JSON.parse(await badTokenReader.readLine())).toEqual({
				ok: false,
				error: "attach handshake is not authorized",
			});

			const noSession = connect(viewer.port, "127.0.0.1");
			const noSessionReader = reader(noSession);
			noSession.write(
				`${JSON.stringify({
					schema: "qorpera.company-computer-screen-attach/v1",
					token: viewerToken,
					screen_ordinal: 5,
				})}\n`,
			);
			expect(JSON.parse(await noSessionReader.readLine())).toEqual({
				ok: false,
				error: "screen has no live session",
			});

			const deadSession = connect(viewer.port, "127.0.0.1");
			const deadSessionReader = reader(deadSession);
			deadSession.write(
				`${JSON.stringify({
					schema: "qorpera.company-computer-screen-attach/v1",
					token: viewerToken,
					screen_ordinal: 9,
				})}\n`,
			);
			expect(JSON.parse(await deadSessionReader.readLine())).toEqual({
				ok: false,
				error: "screen session is unreachable",
			});

			const garbled = connect(viewer.port, "127.0.0.1");
			const garbledReader = reader(garbled);
			garbled.write("not json\n");
			expect(JSON.parse(await garbledReader.readLine())).toEqual({
				ok: false,
				error: "attach handshake is invalid",
			});
		} finally {
			await viewer.close();
			await closeServer(vnc.server);
		}
	});

	it("destroys connections from any source but the trusted host bridge", async () => {
		const viewer = await startCompanyComputerScreenViewer({
			host: "127.0.0.1",
			port: 0,
			trustedSource: "10.99.99.99",
			viewerToken,
			liveVncPort: () => undefined,
		});
		try {
			const attach = connect(viewer.port, "127.0.0.1");
			attach.on("error", () => {});
			const closed = new Promise<void>((resolveClose) => attach.once("close", () => resolveClose()));
			attach.write("anything");
			await closed;
			expect(attach.destroyed).toBe(true);
		} finally {
			await viewer.close();
		}
		await expect(
			startCompanyComputerScreenViewer({
				host: "127.0.0.1",
				port: 0,
				trustedSource: "127.0.0.1",
				viewerToken: "short",
				liveVncPort: () => undefined,
			}),
		).rejects.toThrow("viewer token is invalid");
	});

	it("runs the screen loop from the registry until aborted, then tears everything down", async () => {
		const launcher = new FakeLauncher();
		let firstLaunch!: () => void;
		const launched = new Promise<void>((resolveLaunch) => {
			firstLaunch = resolveLaunch;
		});
		const originalLaunch = launcher.launch.bind(launcher);
		launcher.launch = async (screen) => {
			const handle = await originalLaunch(screen);
			firstLaunch();
			return handle;
		};
		const controller = new AbortController();
		const agent = runCloudCompanyComputerScreenAgent({
			config: { viewerHost: "127.0.0.1", viewerPort: 0, viewerTrustedSource: "127.0.0.1", pollSeconds: 30 },
			companyComputerId,
			viewerToken,
			controlPlane: { listScreens: async () => [screenRecord(2)] },
			launcher,
			signal: controller.signal,
			onError: (error) => {
				throw error;
			},
		});
		await launched;
		controller.abort();
		await agent;
		expect(launcher.launches).toEqual([{ ordinal: 2, display: ":2", vncPort: 5902 }]);
		expect(launcher.handles.get(2)?.stopped).toBe(true);
	});
});
