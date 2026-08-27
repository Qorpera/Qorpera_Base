import { createServer, type Server, type Socket } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
	connectCompanyComputerScreenView,
	describeCompanyComputerScreens,
	mintCompanyComputerScreenView,
	startLocalScreenViewWebSocketBridge,
} from "../src/cloud-company-computer-view.ts";
import type { HostedPrimaryDatabase } from "../src/hosted-primary.ts";
import { isRendererRequestAllowed } from "../src/renderer-boundary.ts";

const environmentId = "30000000-0000-4000-8000-000000000004";
const screenId = "30000000-0000-4000-8000-000000000031";
const capability = "C".repeat(43);

function fakeClient(
	handler: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string } },
): SupabaseClient<HostedPrimaryDatabase> {
	return {
		rpc: async (name: string, args: Record<string, unknown>) => {
			const result = handler(name, args);
			return { data: result.data ?? null, error: result.error ?? null };
		},
	} as unknown as SupabaseClient<HostedPrimaryDatabase>;
}

/** Speaks the gateway view protocol: one JSON line in, ok line + greeting
 * out, then echoes — the same shape the host viewer gateway serves. */
async function fakeGateway(expectedCapability: string): Promise<{ port: number; server: Server }> {
	const server = createServer((socket: Socket) => {
		socket.on("error", () => {});
		let buffered = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline === -1) return;
			socket.off("data", onData);
			const handshake = JSON.parse(buffered.subarray(0, newline).toString("utf-8")) as Record<string, unknown>;
			if (
				handshake.schema !== "qorpera.company-computer-screen-view/v1" ||
				handshake.capability !== expectedCapability
			) {
				socket.end(`${JSON.stringify({ ok: false, error: "capability is expired or unknown" })}\n`);
				return;
			}
			socket.write(`${JSON.stringify({ ok: true, screen_ordinal: 3 })}\n`);
			socket.write("RFB 003.008\n");
			socket.on("data", (echo) => socket.write(echo));
		};
		socket.on("data", onData);
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	if (typeof address !== "object" || !address) throw new Error("fake gateway has no port");
	return { port: address.port, server };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose) => server.close(() => resolveClose()));
}

describe("cloud company computer view", () => {
	it("describes the company's computer and screens through the member RPC", async () => {
		const client = fakeClient((name, args) => {
			expect(name).toBe("qorpera_describe_company_computer_screens");
			expect(args).toEqual({ p_environment_id: environmentId });
			return {
				data: {
					computer: {
						company_computer_id: "30000000-0000-4000-8000-000000000002",
						logical_computer_id: "30000000-0000-4000-8000-000000000001",
						lifecycle_state: "active",
					},
					screens: [
						{
							screen_id: screenId,
							screen_ordinal: 2,
							display_name: "Screen 2",
							status: "active",
							attached_staff_agent_id: "30000000-0000-4000-8000-000000000014",
							occupying_run_id: null,
						},
					],
				},
			};
		});
		const view = await describeCompanyComputerScreens(client, environmentId);
		expect(view?.lifecycleState).toBe("active");
		expect(view?.screens).toEqual([
			{
				screenId,
				screenOrdinal: 2,
				displayName: "Screen 2",
				attachedStaffAgentId: "30000000-0000-4000-8000-000000000014",
			},
		]);
		const empty = await describeCompanyComputerScreens(
			fakeClient(() => ({ data: null })),
			environmentId,
		);
		expect(empty).toBeUndefined();
		await expect(
			describeCompanyComputerScreens(
				fakeClient(() => ({ error: { message: "read access is required" } })),
				environmentId,
			),
		).rejects.toThrow("read access is required");
	});

	it("mints a view capability with the member session", async () => {
		const client = fakeClient((name, args) => {
			expect(name).toBe("qorpera_mint_company_computer_screen_view");
			expect(args).toEqual({ p_screen_id: screenId });
			return {
				data: {
					capability,
					expires_at: "2026-08-26T13:00:00.000Z",
					screen: { screen_id: screenId, screen_ordinal: 3, display_name: "Screen 3", status: "active" },
				},
			};
		});
		await expect(mintCompanyComputerScreenView(client, screenId)).resolves.toEqual({
			capability,
			expiresAt: "2026-08-26T13:00:00.000Z",
			screenOrdinal: 3,
		});
	});

	it("completes the gateway view handshake and hands over the raw session", async () => {
		const gateway = await fakeGateway(capability);
		try {
			const view = await connectCompanyComputerScreenView({
				host: "127.0.0.1",
				port: gateway.port,
				capability,
			});
			expect(view.screenOrdinal).toBe(3);
			const collected: Buffer[] = [Buffer.from(view.remainder)];
			const greeting = await new Promise<string>((resolveGreeting) => {
				const check = (): void => {
					const text = Buffer.concat(collected).toString("utf-8");
					if (text.includes("RFB 003.008")) resolveGreeting(text);
				};
				view.socket.on("data", (chunk: Buffer) => {
					collected.push(chunk);
					check();
				});
				view.socket.resume();
				check();
			});
			expect(greeting).toContain("RFB 003.008");
			view.socket.destroy();

			await expect(
				connectCompanyComputerScreenView({ host: "127.0.0.1", port: gateway.port, capability: "D".repeat(43) }),
			).rejects.toThrow("capability is expired or unknown");
		} finally {
			await closeServer(gateway.server);
		}
	});

	it("bridges the session to exactly one local noVNC WebSocket", async () => {
		const gateway = await fakeGateway(capability);
		try {
			const view = await connectCompanyComputerScreenView({
				host: "127.0.0.1",
				port: gateway.port,
				capability,
			});
			const bridge = await startLocalScreenViewWebSocketBridge(view);
			const rendererBoundary = { backendOrigin: "http://127.0.0.1:4700", trustedFileRoot: "/unused" };
			expect(isRendererRequestAllowed(bridge.url, rendererBoundary)).toBe(true);
			const websocket = new WebSocket(bridge.url);
			websocket.binaryType = "arraybuffer";
			const received: Buffer[] = [];
			let expected: (() => void) | undefined;
			websocket.addEventListener("message", (event) => {
				received.push(Buffer.from(event.data as ArrayBuffer));
				expected?.();
			});
			await new Promise<void>((resolveOpen, rejectOpen) => {
				websocket.addEventListener("open", () => resolveOpen());
				websocket.addEventListener("error", () => rejectOpen(new Error("bridge websocket failed")));
			});
			expect(isRendererRequestAllowed(bridge.url, rendererBoundary)).toBe(false);
			const until = (predicate: () => boolean): Promise<void> =>
				new Promise((resolveUntil) => {
					const check = (): void => {
						if (predicate()) resolveUntil();
						else expected = check;
					};
					check();
				});
			// The greeting the gateway already sent flows to the browser side.
			await until(() => Buffer.concat(received).toString("utf-8").includes("RFB 003.008"));
			received.length = 0;
			websocket.send(Buffer.from("drive-bytes"));
			await until(() => Buffer.concat(received).toString("utf-8") === "drive-bytes");

			const closed = new Promise<void>((resolveClosed) => {
				websocket.addEventListener("close", () => resolveClosed());
			});
			await bridge.close();
			await closed;
		} finally {
			await closeServer(gateway.server);
		}
	});
});
