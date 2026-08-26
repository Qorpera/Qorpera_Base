import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
	CloudCompanyComputerScreenManager,
	type CompanyComputerScreenLaunch,
	type CompanyComputerScreenLauncher,
	type CompanyComputerScreenRecord,
	companyComputerScreenCreature,
	companyComputerScreenDisplay,
	companyComputerScreenVncPort,
	ExecCompanyComputerScreenKeyframeCapturer,
	ExecCompanyComputerScreenLauncher,
	parseCloudCompanyComputerScreensConfig,
	parseCompanyComputerScreenRecords,
	runCloudCompanyComputerScreenAgent,
	SupabaseCompanyComputerScreenService,
	SupabaseCompanyComputerScreensControlPlane,
	startCompanyComputerScreenBroker,
	startCompanyComputerScreenViewer,
} from "../src/cloud-company-computer-screens.ts";
import { CloudContentAddressedStore, type CloudObjectTransport } from "../src/cloud-object-store.ts";

class MemoryObjectTransport implements CloudObjectTransport {
	readonly objects = new Map<string, Uint8Array>();

	async put(path: string, bytes: Uint8Array): Promise<"exists" | "stored"> {
		if (this.objects.has(path)) return "exists";
		this.objects.set(path, Uint8Array.from(bytes));
		return "stored";
	}

	async get(path: string): Promise<Uint8Array> {
		const bytes = this.objects.get(path);
		if (!bytes) throw new Error("object not found");
		return Uint8Array.from(bytes);
	}
}

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

	it("dresses each screen with its owning agent's creature, seeded randomly when unowned", async () => {
		const templated = {
			...screenRecord(2),
			attachedStaffAgentId: staffAgentId,
			attachedStaffTemplateId: "product-manager",
		};
		expect(companyComputerScreenCreature(templated)).toBe("folio");
		const untemplated = { ...screenRecord(2), attachedStaffAgentId: staffAgentId };
		expect(companyComputerScreenCreature(untemplated)).toBe(companyComputerScreenCreature(untemplated));
		const unowned = screenRecord(3);
		expect(companyComputerScreenCreature(unowned)).toBe(companyComputerScreenCreature(unowned));
		expect(["pebble", "folio", "brain", "wisp", "halo", "ribbon", "bloom"]).toContain(
			companyComputerScreenCreature(unowned),
		);

		const parsed = parseCompanyComputerScreenRecords([
			{
				screen_id: screenId,
				screen_ordinal: 2,
				display_name: "Screen 2",
				status: "active",
				attached_staff_agent_id: staffAgentId,
				attached_staff_template_id: "product-manager",
				attached_staff_display_name: "Grok Bot Teacher",
			},
		])[0];
		expect(parsed?.attachedStaffTemplateId).toBe("product-manager");
		expect(parsed?.attachedStaffDisplayName).toBe("Grok Bot Teacher");
	});

	it("keeps the per-screen wallpapers current with the attachment", async () => {
		const launcher = new FakeLauncher();
		const copies: Array<{ source: string; destination: string }> = [];
		let firstCopy!: () => void;
		const copied = new Promise<void>((resolveCopy) => {
			firstCopy = resolveCopy;
		});
		const controller = new AbortController();
		const agent = runCloudCompanyComputerScreenAgent({
			config: { viewerHost: "127.0.0.1", viewerPort: 0, viewerTrustedSource: "127.0.0.1", pollSeconds: 30 },
			companyComputerId,
			viewerToken,
			controlPlane: {
				listScreens: async () => [
					{ ...screenRecord(2), attachedStaffAgentId: staffAgentId, attachedStaffTemplateId: "product-manager" },
				],
			},
			launcher,
			signal: controller.signal,
			wallpapers: {
				directory: "/tmp/qorpera-test-wallpapers",
				sourceFor: (creature) => `/usr/share/backgrounds/qorpera-screen-${creature}.png`,
				copy: async (source, destination) => {
					copies.push({ source, destination });
					firstCopy();
				},
			},
			onError: (error) => {
				throw error;
			},
		});
		await copied;
		controller.abort();
		await agent;
		expect(copies).toEqual([
			{
				source: "/usr/share/backgrounds/qorpera-screen-folio.png",
				destination: "/tmp/qorpera-test-wallpapers/screen-2.png",
			},
		]);
	});

	it("captures keyframes with the substituted command and DISPLAY exported", async () => {
		const { writeFile } = await import("node:fs/promises");
		const invocations: Array<{ command: string; args: readonly string[]; display: string | undefined }> = [];
		const capturer = new ExecCompanyComputerScreenKeyframeCapturer(
			["/usr/bin/scrot", "--overwrite", "{output}"],
			async (command, args, environment) => {
				invocations.push({ command, args, display: environment.DISPLAY });
				const output = args.find((argument) => argument.endsWith("keyframe.png"));
				if (!output) throw new Error("no output argument");
				await writeFile(output, Buffer.from("png-bytes"));
				return { code: 0, stderr: "" };
			},
		);
		const bytes = await capturer.capture({ ordinal: 3, display: ":3" });
		expect(Buffer.from(bytes).toString("utf-8")).toBe("png-bytes");
		expect(invocations).toHaveLength(1);
		expect(invocations[0].command).toBe("/usr/bin/scrot");
		expect(invocations[0].display).toBe(":3");
		expect(() => new ExecCompanyComputerScreenKeyframeCapturer(["/usr/bin/scrot"])).toThrow(
			"must reference {output}",
		);
		const failing = new ExecCompanyComputerScreenKeyframeCapturer(["/usr/bin/scrot", "{output}"], async () => ({
			code: 1,
			stderr: "no display",
		}));
		await expect(failing.capture({ ordinal: 1, display: ":1" })).rejects.toThrow("no display");
	});

	it("speaks the occupancy and keyframe service RPCs with the provider header convention", async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const service = new SupabaseCompanyComputerScreenService("https://control.example.com", "service-key", (async (
			url: unknown,
			init?: { body?: unknown },
		) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ url: String(url), body });
			if (String(url).includes("claim")) {
				return new Response(
					JSON.stringify({
						screen_id: screenId,
						screen_ordinal: 2,
						display_name: "Screen 2",
						status: "active",
						attached_staff_agent_id: staffAgentId,
						occupying_run_id: body.p_run_id,
					}),
					{ status: 200 },
				);
			}
			return new Response("null", { status: 200 });
		}) as typeof fetch);
		const runId = "30000000-0000-4000-8000-000000000100";
		const claimed = await service.claim(screenId, runId, "2026-08-26T13:00:00.000Z");
		expect(claimed.occupyingRunId).toBe(runId);
		await service.release(screenId, runId);
		await service.recordKeyframe({
			screenId,
			runId,
			clientArtifactId: "30000000-0000-4000-8000-000000000200",
			rootObjectSha256: "a".repeat(64),
			contentSha256: "b".repeat(64),
			bytes: 9,
		});
		expect(calls.map((call) => call.url)).toEqual([
			"https://control.example.com/rest/v1/rpc/qorpera_claim_company_computer_screen",
			"https://control.example.com/rest/v1/rpc/qorpera_release_company_computer_screen",
			"https://control.example.com/rest/v1/rpc/qorpera_record_company_computer_screen_keyframe",
		]);
		expect(calls[2].body).toEqual({
			p_screen_id: screenId,
			p_run_id: runId,
			p_client_artifact_id: "30000000-0000-4000-8000-000000000200",
			p_root_object_sha256: "a".repeat(64),
			p_content_sha256: "b".repeat(64),
			p_bytes: 9,
		});
	});

	it("brokers screen occupancy for the attached staff agent over loopback", async () => {
		const runId = "30000000-0000-4000-8000-000000000100";
		const claims: Array<{ screenId: string; runId: string }> = [];
		const releases: Array<{ screenId: string; runId: string }> = [];
		const broker = await startCompanyComputerScreenBroker({
			port: 0,
			occupancy: {
				claim: async (claimedScreenId, claimedRunId) => {
					claims.push({ screenId: claimedScreenId, runId: claimedRunId });
					return {
						...screenRecord(2),
						screenId,
						attachedStaffAgentId: staffAgentId,
						occupyingRunId: claimedRunId,
					};
				},
				release: async (releasedScreenId, releasedRunId) => {
					releases.push({ screenId: releasedScreenId, runId: releasedRunId });
				},
			},
			records: () => [{ ...screenRecord(2), screenId, attachedStaffAgentId: staffAgentId }],
		});
		try {
			const occupied = await fetch(`http://127.0.0.1:${broker.port}/v1/screens/occupy`, {
				method: "POST",
				body: JSON.stringify({ run_id: runId, staff_agent_id: staffAgentId }),
			});
			expect(occupied.status).toBe(200);
			const grant = (await occupied.json()) as Record<string, unknown>;
			expect(grant.ok).toBe(true);
			expect(grant.screen_ordinal).toBe(2);
			expect(grant.display).toBe(":2");
			expect(grant.vnc_port).toBe(5902);
			expect(claims).toEqual([{ screenId, runId }]);

			const unattached = await fetch(`http://127.0.0.1:${broker.port}/v1/screens/occupy`, {
				method: "POST",
				body: JSON.stringify({ run_id: runId, staff_agent_id: "30000000-0000-4000-8000-000000000099" }),
			});
			expect(unattached.status).toBe(409);

			const released = await fetch(`http://127.0.0.1:${broker.port}/v1/screens/release`, {
				method: "POST",
				body: JSON.stringify({ run_id: runId, screen_ordinal: 2 }),
			});
			expect(released.status).toBe(200);
			expect(releases).toEqual([{ screenId, runId }]);

			const invalid = await fetch(`http://127.0.0.1:${broker.port}/v1/screens/occupy`, {
				method: "POST",
				body: JSON.stringify({ run_id: "nope", staff_agent_id: staffAgentId }),
			});
			expect(invalid.status).toBe(400);
		} finally {
			await broker.close();
		}
	});

	it("publishes a keyframe for each occupied live screen on the poll tick", async () => {
		const runId = "30000000-0000-4000-8000-000000000100";
		const launcher = new FakeLauncher();
		const transport = new MemoryObjectTransport();
		const recorded: Array<Record<string, unknown>> = [];
		let firstKeyframe!: () => void;
		const keyframed = new Promise<void>((resolveKeyframe) => {
			firstKeyframe = resolveKeyframe;
		});
		const controller = new AbortController();
		const agent = runCloudCompanyComputerScreenAgent({
			config: { viewerHost: "127.0.0.1", viewerPort: 0, viewerTrustedSource: "127.0.0.1", pollSeconds: 30 },
			companyComputerId,
			viewerToken,
			controlPlane: {
				listScreens: async () => [{ ...screenRecord(2), occupyingRunId: runId }],
			},
			launcher,
			signal: controller.signal,
			keyframes: {
				capturer: { capture: async () => new Uint8Array(Buffer.from("frame")) },
				store: new CloudContentAddressedStore(transport),
				recorder: {
					recordKeyframe: async (input) => {
						recorded.push(input as unknown as Record<string, unknown>);
						firstKeyframe();
					},
				},
				profileId: "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f",
			},
			onError: (error) => {
				throw error;
			},
		});
		await keyframed;
		controller.abort();
		await agent;
		expect(recorded).toHaveLength(1);
		expect(recorded[0].screenId).toBe(screenId);
		expect(recorded[0].runId).toBe(runId);
		expect(transport.objects.size).toBeGreaterThan(0);
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
