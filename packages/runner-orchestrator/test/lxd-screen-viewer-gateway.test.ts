import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
	LxdCompanyComputerScreenViewerGateway,
	parseScreenViewRedemption,
	type ScreenViewRedemption,
	SupabaseScreenViewControlPlane,
} from "../src/lxd-screen-viewer-gateway.ts";

const capability = "C".repeat(43);
const viewerToken = "T".repeat(43);
const logicalComputerId = "30000000-0000-4000-8000-000000000001";

function redemption(): ScreenViewRedemption {
	return {
		screenId: "30000000-0000-4000-8000-000000000031",
		screenOrdinal: 3,
		profileId: "30000000-0000-4000-8000-000000000003",
		companyComputerId: "30000000-0000-4000-8000-000000000002",
		logicalComputerId,
		mintedByUserId: "30000000-0000-4000-8000-000000000016",
	};
}

function redemptionJson(): Record<string, unknown> {
	return {
		screen_id: "30000000-0000-4000-8000-000000000031",
		screen_ordinal: 3,
		profile_id: "30000000-0000-4000-8000-000000000003",
		company_computer_id: "30000000-0000-4000-8000-000000000002",
		logical_computer_id: logicalComputerId,
		minted_by_user_id: "30000000-0000-4000-8000-000000000016",
	};
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

/** Speaks the guest attach protocol exactly like the shell screen agent's
 * viewer listener: one JSON line in, ok line + VNC greeting out, then echo. */
async function fakeGuestViewer(expectedToken: string): Promise<{ port: number; server: Server }> {
	const server = createServer((socket) => {
		socket.on("error", () => {});
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline === -1) return;
			socket.off("data", onData);
			const handshake = JSON.parse(buffered.subarray(0, newline).toString("utf-8")) as Record<string, unknown>;
			if (
				handshake.schema !== "qorpera.company-computer-screen-attach/v1" ||
				handshake.token !== expectedToken ||
				handshake.screen_ordinal !== 3
			) {
				socket.end(`${JSON.stringify({ ok: false, error: "attach handshake is not authorized" })}\n`);
				return;
			}
			socket.write(`${JSON.stringify({ ok: true, screen_ordinal: handshake.screen_ordinal })}\n`);
			socket.write("RFB 003.008\n");
			socket.on("data", (echo) => socket.write(echo));
		};
		socket.on("data", onData);
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("fake guest viewer has no port");
	return { port: address.port, server };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function refusedPort(): Promise<number> {
	const placeholder = createServer();
	await new Promise<void>((resolveListen) => placeholder.listen(0, "127.0.0.1", () => resolveListen()));
	const address = placeholder.address();
	if (typeof address !== "object" || !address) throw new Error("placeholder server has no port");
	await closeServer(placeholder);
	return address.port;
}

describe("LxdCompanyComputerScreenViewerGateway", () => {
	it("redeems a capability, opens the guest leg, and pipes the screen bytes", async () => {
		const guest = await fakeGuestViewer(viewerToken);
		const redeemed: string[] = [];
		const gateway = new LxdCompanyComputerScreenViewerGateway(
			{ host: "127.0.0.1", port: 0 },
			{
				redeemScreenView: async (presented) => {
					redeemed.push(presented);
					if (presented !== capability) throw new Error("capability is expired or unknown");
					return redemption();
				},
			},
			{
				screenViewerTarget: async (requested) => {
					expect(requested).toBe(logicalComputerId);
					return { guestAddress: "127.0.0.1", viewerPort: guest.port, viewerToken };
				},
			},
		);
		const running = await gateway.start();
		try {
			const view = connect(running.port, "127.0.0.1");
			const viewReader = reader(view);
			view.write(`${JSON.stringify({ schema: "qorpera.company-computer-screen-view/v1", capability })}\n`);
			expect(JSON.parse(await viewReader.readLine())).toEqual({ ok: true, screen_ordinal: 3 });
			expect(await viewReader.readLine()).toBe("RFB 003.008");
			view.write("drive");
			expect((await viewReader.readBytes(5)).toString("utf-8")).toBe("drive");
			view.destroy();
			expect(redeemed).toEqual([capability]);

			const replay = connect(running.port, "127.0.0.1");
			const replayReader = reader(replay);
			replay.write(
				`${JSON.stringify({ schema: "qorpera.company-computer-screen-view/v1", capability: "D".repeat(43) })}\n`,
			);
			expect(JSON.parse(await replayReader.readLine())).toEqual({
				ok: false,
				error: "capability is expired or unknown",
			});
		} finally {
			await running.close();
			await closeServer(guest.server);
		}
	});

	it("surfaces a refused guest attach and an unreachable guest as clean errors", async () => {
		const guest = await fakeGuestViewer("W".repeat(43));
		const deadPort = await refusedPort();
		let target = { guestAddress: "127.0.0.1", viewerPort: guest.port, viewerToken };
		const gateway = new LxdCompanyComputerScreenViewerGateway(
			{ host: "127.0.0.1", port: 0 },
			{ redeemScreenView: async () => redemption() },
			{ screenViewerTarget: async () => target },
		);
		const running = await gateway.start();
		try {
			const refused = connect(running.port, "127.0.0.1");
			const refusedReader = reader(refused);
			refused.write(`${JSON.stringify({ schema: "qorpera.company-computer-screen-view/v1", capability })}\n`);
			expect(JSON.parse(await refusedReader.readLine())).toEqual({
				ok: false,
				error: "attach handshake is not authorized",
			});

			target = { guestAddress: "127.0.0.1", viewerPort: deadPort, viewerToken };
			const unreachable = connect(running.port, "127.0.0.1");
			const unreachableReader = reader(unreachable);
			unreachable.write(`${JSON.stringify({ schema: "qorpera.company-computer-screen-view/v1", capability })}\n`);
			const failure = JSON.parse(await unreachableReader.readLine()) as { ok: boolean; error: string };
			expect(failure.ok).toBe(false);
			expect(failure.error).toContain("screen guest is unreachable");

			const garbled = connect(running.port, "127.0.0.1");
			const garbledReader = reader(garbled);
			garbled.write("not json\n");
			expect(JSON.parse(await garbledReader.readLine())).toEqual({
				ok: false,
				error: "view handshake is invalid",
			});

			const wrongSchema = connect(running.port, "127.0.0.1");
			const wrongSchemaReader = reader(wrongSchema);
			wrongSchema.write(`${JSON.stringify({ schema: "nope", capability })}\n`);
			expect(JSON.parse(await wrongSchemaReader.readLine())).toEqual({
				ok: false,
				error: "view handshake is not authorized",
			});
		} finally {
			await running.close();
			await closeServer(guest.server);
		}
	});

	it("destroys connections from any source but the trusted one", async () => {
		const gateway = new LxdCompanyComputerScreenViewerGateway(
			{ host: "127.0.0.1", port: 0, trustedSource: "10.99.99.99" },
			{
				redeemScreenView: async () => {
					throw new Error("must not redeem");
				},
			},
			{
				screenViewerTarget: async () => {
					throw new Error("must not resolve");
				},
			},
		);
		const running = await gateway.start();
		try {
			const attach = connect(running.port, "127.0.0.1");
			attach.on("error", () => {});
			const closed = new Promise<void>((resolveClose) => attach.once("close", () => resolveClose()));
			attach.write("anything");
			await closed;
			expect(attach.destroyed).toBe(true);
		} finally {
			await running.close();
		}
	});

	it("parses redemptions and calls the redeem RPC with the provider header convention", async () => {
		expect(parseScreenViewRedemption(redemptionJson())).toEqual(redemption());
		expect(() => parseScreenViewRedemption({ ...redemptionJson(), screen_ordinal: 0 })).toThrow("ordinal is invalid");
		expect(() => parseScreenViewRedemption({ ...redemptionJson(), screen_id: "nope" })).toThrow(
			"screen id is invalid",
		);

		const calls: Array<{ url: string; body: unknown }> = [];
		const controlPlane = new SupabaseScreenViewControlPlane("https://control.example.com", "service-key", (async (
			url: unknown,
			init?: { body?: unknown },
		) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify(redemptionJson()), { status: 200 });
		}) as typeof fetch);
		await expect(controlPlane.redeemScreenView(capability)).resolves.toEqual(redemption());
		expect(calls).toEqual([
			{
				url: "https://control.example.com/rest/v1/rpc/qorpera_redeem_company_computer_screen_view",
				body: { p_capability: capability },
			},
		]);
		const failing = new SupabaseScreenViewControlPlane(
			"https://control.example.com",
			"service-key",
			(async () => new Response("nope", { status: 500 })) as typeof fetch,
		);
		await expect(failing.redeemScreenView(capability)).rejects.toThrow("failed (500)");
	});
});
