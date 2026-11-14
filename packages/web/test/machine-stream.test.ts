import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebMachineScreens } from "../src/cloud/machine-screens.ts";
import {
	MACHINE_STREAM_PROTOCOL,
	machineStreamEnd,
	openMachineStream,
	readMachineStreamMessage,
} from "../src/cloud/machine-stream.ts";

/* A member's live picture of an agent's desktop (20260930745000): the browser's side of the stream. It only shows: the
 * page never sends on it, and it reads nothing but the three messages of the machine's node. */

const TICKET = "T".repeat(43);
const company = "11111111-1111-4111-8111-111111111111";
const machineId = "22222222-2222-4222-8222-222222222222";
const pass = "33333333-3333-4333-8333-333333333333";

/** The browser's WebSocket, as the stream uses it: what it was opened with, what the page sent (never anything), how
 * the page closed it, and the server's side (a message, a close). */
class FakeSocket extends EventTarget {
	static made: FakeSocket[] = [];
	readonly url: string;
	readonly protocol: string;
	binaryType = "blob";
	readyState = 0;
	readonly sent: unknown[] = [];
	closedWith: number | undefined;
	constructor(url: string, protocol: string) {
		super();
		this.url = url;
		this.protocol = protocol;
		FakeSocket.made.push(this);
	}
	send(data: unknown) {
		this.sent.push(data);
	}
	close(code?: number) {
		this.closedWith = code;
		this.readyState = 3;
	}
	message(data: unknown) {
		this.readyState = 1;
		this.dispatchEvent(Object.assign(new Event("message"), { data }));
	}
	closeWith(code: number, reason = "") {
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
	}
}
afterEach(() => {
	FakeSocket.made = [];
	vi.useRealTimers();
});

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat()).buffer;
const u16 = (value: number) => [value >> 8, value & 0xff];
const u32 = (value: number) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2];
const size = (width: number, height: number) => bytes([1], u16(width), u16(height));
const rects = (...areas: [number, number, number, number][]) =>
	bytes(
		[2],
		u16(areas.length),
		...areas.flatMap(([x, y, w, h]) => [[...u16(x), ...u16(y), ...u16(w), ...u16(h), ...u32(PNG.length), ...PNG]]),
	);

describe("the live picture's messages (20260930745000)", () => {
	it("reads the size, the changed areas in order and the pointer's shape", async () => {
		expect(readMachineStreamMessage(size(1600, 1000))).toEqual({ kind: "size", width: 1600, height: 1000 });
		const read = readMachineStreamMessage(rects([0, 0, 1600, 1000], [10, 20, 30, 40]));
		expect(read?.kind).toBe("rects");
		if (read?.kind !== "rects") return;
		expect(read.rects.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
			[0, 0, 1600, 1000],
			[10, 20, 30, 40],
		]);
		expect(new Uint8Array(await read.rects[1]!.png.arrayBuffer())).toEqual(new Uint8Array(PNG));
		expect(read.rects[1]!.png.type).toBe("image/png");
		const cursor = readMachineStreamMessage(bytes([3], u16(4), u16(5), u16(16), u16(16), u32(PNG.length), PNG));
		expect(cursor).toMatchObject({ kind: "cursor", hotX: 4, hotY: 5, width: 16, height: 16 });
		expect(readMachineStreamMessage(bytes([3], u16(0), u16(0), u16(0), u16(0), u32(0)))).toEqual({
			kind: "cursor",
			hotX: 0,
			hotY: 0,
			width: 0,
			height: 0,
			png: null,
		});
	});

	it("takes nothing else: another kind, a wrong length, an area off the screen, a shape too large", () => {
		for (const [name, data] of [
			["empty", bytes([])],
			["another kind", bytes([4, 0, 0])],
			["a size too short", bytes([1], u16(10))],
			["a size of nothing", size(0, 10)],
			["a size too large", size(5000, 10)],
			["no areas", bytes([2], u16(0))],
			["an area cut short", rects([0, 0, 10, 10]).slice(0, 20)],
			["bytes after the areas", bytes(Array.from(new Uint8Array(rects([0, 0, 10, 10]))), [0])],
			["an area off the largest screen", rects([4000, 0, 200, 10])],
			["an empty area", rects([0, 0, 0, 10])],
			["a shape past its hot spot", bytes([3], u16(16), u16(0), u16(16), u16(16), u32(PNG.length), PNG)],
			["a shape too large", bytes([3], u16(0), u16(0), u16(200), u16(16), u32(PNG.length), PNG)],
			["a shape of the wrong length", bytes([3], u16(0), u16(0), u16(16), u16(16), u32(PNG.length + 1), PNG)],
		] as const)
			expect(readMachineStreamMessage(data), name).toBeNull();
	});

	it("says why a close ended it, by its code", () => {
		expect(machineStreamEnd(1000, "", true)).toEqual({ kind: "closed", delivered: true });
		expect(machineStreamEnd(4001, "POINTER_PASS_ENDED", true)).toEqual({
			kind: "renew",
			reason: "POINTER_PASS_ENDED",
			delivered: true,
		});
		expect(machineStreamEnd(4003, "DESKTOP_HELD_SINCE", false)).toEqual({
			kind: "refused",
			code: "DESKTOP_HELD_SINCE",
			delivered: false,
		});
		expect(machineStreamEnd(4003, "<script>", false)).toEqual({
			kind: "refused",
			code: "STREAM_UNAVAILABLE",
			delivered: false,
		});
		expect(machineStreamEnd(4004, "MACHINE_BOOT_CHANGED", true)).toMatchObject({ kind: "desktop" });
		for (const code of [1001, 1002, 1006, 1008, 1011, 4999])
			expect(machineStreamEnd(code, "", false).kind).toBe("failed");
	});
});

describe("one stream on a ticket (20260930745000)", () => {
	const open = (signal = new AbortController().signal, onMessage = vi.fn()) => ({
		onMessage,
		ended: openMachineStream({
			url: "wss://screens.example.invalid",
			ticket: TICKET,
			onMessage,
			signal,
			WebSocket: FakeSocket as unknown as typeof WebSocket,
		}),
	});

	it("opens the one route with the subprotocol, hands every message over in order, and never sends anything", async () => {
		const { onMessage, ended } = open();
		const socket = FakeSocket.made[0]!;
		expect(socket.url).toBe(`wss://screens.example.invalid/v1/member-machine-streams/${TICKET}`);
		expect(socket.protocol).toBe(MACHINE_STREAM_PROTOCOL);
		expect(socket.binaryType).toBe("arraybuffer");
		socket.message(size(1600, 1000));
		socket.message(rects([0, 0, 1600, 1000]));
		socket.closeWith(4001, "POINTER_PASS_ENDED");
		expect(await ended).toEqual({ kind: "renew", reason: "POINTER_PASS_ENDED", delivered: true });
		expect(onMessage.mock.calls.map(([message]) => message.kind)).toEqual(["size", "rects"]);
		// It only shows: nothing was ever sent on it.
		expect(socket.sent).toEqual([]);
	});

	it("ends at once on anything that is not a message of the stream, or without the size first, and closes the socket", async () => {
		for (const data of ["text", rects([0, 0, 10, 10]), new Uint8Array([9]).buffer]) {
			const { onMessage, ended } = open();
			const socket = FakeSocket.made.at(-1)!;
			socket.message(data);
			expect(await ended).toEqual({ kind: "failed", delivered: false });
			expect(socket.closedWith).toBe(1000);
			expect(onMessage).not.toHaveBeenCalled();
			// Nothing it sends after counts.
			socket.message(size(10, 10));
			expect(onMessage).not.toHaveBeenCalled();
		}
	});

	it("is closed by the page when its signal aborts, gives up on a stream silent for 10 s, and leaves no timer", async () => {
		vi.useFakeTimers();
		const stop = new AbortController();
		const first = open(stop.signal);
		stop.abort();
		expect(await first.ended).toEqual({ kind: "closed", delivered: false });
		expect(FakeSocket.made[0]!.closedWith).toBe(1000);
		const silent = open();
		vi.advanceTimersByTime(10_000);
		expect(await silent.ended).toEqual({ kind: "failed", delivered: false });
		expect(FakeSocket.made[1]!.closedWith).toBe(1000);
		const talking = open();
		FakeSocket.made[2]!.message(size(10, 10));
		vi.advanceTimersByTime(60_000);
		FakeSocket.made[2]!.closeWith(1006);
		expect(await talking.ended).toEqual({ kind: "failed", delivered: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("opens nothing for a ticket that is not one, or an address that is not a secure WebSocket", async () => {
		for (const [url, ticket] of [
			["wss://screens.example.invalid", "short"],
			["https://screens.example.invalid", TICKET],
			["ws://screens.example.invalid", TICKET],
		] as const)
			expect(
				await openMachineStream({
					url,
					ticket,
					onMessage: vi.fn(),
					signal: new AbortController().signal,
					WebSocket: FakeSocket as unknown as typeof WebSocket,
				}),
			).toEqual({ kind: "failed", delivered: false });
		expect(FakeSocket.made).toEqual([]);
	});
});

describe("the ticket on the member's pointer pass (20260930745000)", () => {
	function screens(answer: () => Response, streamUrl: string | null = "wss://screens.example.invalid") {
		const sent: { url: string; body: unknown }[] = [];
		const value = createWebMachineScreens({
			companyId: company,
			objectGatewayUrl: "https://gateway.example.invalid",
			route: (url) => url.replace("https://gateway.example.invalid", "https://bridge.example.invalid"),
			accessToken: async () => "member-token",
			fetch: (async (url: string, init: RequestInit) => {
				sent.push({ url, body: JSON.parse(String(init.body)) });
				return answer();
			}) as typeof fetch,
			...(streamUrl ? { streamUrl } : {}),
			WebSocket: FakeSocket as unknown as typeof WebSocket,
		});
		return { value, sent };
	}
	const ticket = () => Response.json({ schema: "qorpera.member-machine-pointer/v1", ticket: TICKET, seconds: 30 });

	it("buys it on the pointer route with the pass and its hold, then opens the stream on it", async () => {
		const { value, sent } = screens(ticket);
		const onMessage = vi.fn();
		const stop = new AbortController();
		const ended = value.stream!(machineId, { pass, hold: { generation: 3 } }, onMessage, stop.signal);
		await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(1));
		expect(sent).toEqual([
			{
				url: `https://bridge.example.invalid/v1/member-machine-screens/${company}/${machineId}/pointer`,
				body: { stream: { pass, hold: { generation: 3 } } },
			},
		]);
		expect(FakeSocket.made[0]!.url).toContain(TICKET);
		stop.abort();
		expect(await ended).toEqual({ kind: "closed", delivered: false });
		// A private hold's ticket names its epoch and seat.
		const again = new AbortController();
		const second = value.stream!(machineId, { pass, hold: { epoch: 2, seat: 7 } }, onMessage, again.signal);
		await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(2));
		again.abort();
		await second;
		expect(sent.at(-1)?.body).toEqual({ stream: { pass, hold: { epoch: 2, seat: 7 } } });
	});

	it("says why there is none: a refusal, no stream route, an answer that is no ticket; and there is no stream without an address", async () => {
		const refused = screens(() => Response.json({ code: "POINTER_PASS_ENDED" }, { status: 409 })).value;
		expect(
			await refused.stream!(machineId, { pass, hold: { generation: 0 } }, vi.fn(), new AbortController().signal),
		).toEqual({
			kind: "refused",
			code: "POINTER_PASS_ENDED",
			delivered: false,
		});
		const old = screens(() => Response.json({ error: "member_pointer_invalid" }, { status: 400 })).value;
		expect(
			await old.stream!(machineId, { pass, hold: { generation: 0 } }, vi.fn(), new AbortController().signal),
		).toEqual({
			kind: "unavailable",
			delivered: false,
		});
		for (const body of [
			{ schema: "qorpera.member-machine-pointer/v1", ticket: "short", seconds: 30 },
			{ schema: "qorpera.member-machine-pointer/v1", ticket: TICKET, seconds: 300 },
			{ schema: "qorpera.member-machine-pointer/v1", moved: true },
		]) {
			const wrong = screens(() => Response.json(body)).value;
			await expect(
				wrong.stream!(machineId, { pass, hold: { generation: 0 } }, vi.fn(), new AbortController().signal),
			).rejects.toThrow("Invalid machine pointer answer");
		}
		expect(FakeSocket.made).toEqual([]);
		expect(screens(ticket, null).value.stream).toBeUndefined();
		// No ticket for a pass that is not an id.
		await expect(
			screens(ticket).value.pointer(
				machineId,
				{ stream: { pass: "x", hold: { generation: 0 } } },
				new AbortController().signal,
			),
		).rejects.toThrow("Invalid machine pointer");
	});
});
