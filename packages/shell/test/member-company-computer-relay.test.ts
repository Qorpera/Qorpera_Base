import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CompanyComputerViewChannel } from "@qorpera/cloud-client/cloud-company-computer-view-channel";
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberCompanyComputerRelay } from "../src/member-company-computer-relay.ts";

function fixture() {
	const channel: CompanyComputerViewChannel = {
		readyState: 1,
		protocol: "",
		binaryType: "arraybuffer",
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null,
		send: vi.fn(),
		close: vi.fn(),
	};
	const close = vi.fn(async () => undefined),
		current = vi.fn();
	const view = {
		connectionId: "owned",
		binding: {},
		mode: "watch",
		channel,
		close,
	} as unknown as CompanyComputerMemberView;
	const relay = new MemberCompanyComputerRelay(view, current);
	return { channel, close, current, relay };
}
afterEach(() => vi.useRealTimers());
describe("member display relay", () => {
	it("preserves initial bytes and permits one bounded read while withholding credentials", async () => {
		const f = fixture();
		const read = f.relay.read();
		await expect(f.relay.read()).rejects.toThrow("already pending");
		f.channel.onmessage!({ data: new Uint8Array([82, 70, 66]).buffer });
		const reply = await read;
		expect(reply).toEqual({ state: "open", data: new Uint8Array([82, 70, 66]).buffer, ack: expect.any(String) });
		await expect(f.relay.read()).rejects.toThrow("acknowledgement differs");
		expect(Object.keys(f.relay.metadata).sort()).toEqual(["binding", "connectionId", "mode"]);
		await f.relay.close();
	});
	it("disconnects a stalled consumer when its queue exceeds the byte cap", async () => {
		const f = fixture();
		f.channel.onmessage!({ data: new Uint8Array(256 * 1024).buffer });
		f.channel.onmessage!({ data: new Uint8Array(1).buffer });
		expect(await f.relay.read()).toEqual({ state: "closed", data: new ArrayBuffer(0), ack: expect.any(String) });
		expect(f.close).toHaveBeenCalledOnce();
		expect(f.channel.close).toHaveBeenCalledOnce();
	});
	it("checks account identity before returning queued bytes and on an idle read", async () => {
		vi.useFakeTimers();
		for (const queued of [true, false]) {
			const f = fixture();
			if (queued) f.channel.onmessage!({ data: new Uint8Array([1]).buffer });
			if (queued)
				f.current.mockImplementation(() => {
					throw new Error("account changed");
				});
			const reading = expect(f.relay.read()).rejects.toThrow("account changed");
			if (!queued)
				f.current.mockImplementation(() => {
					throw new Error("account changed");
				});
			await vi.advanceTimersByTimeAsync(1000);
			await reading;
			expect(f.close).toHaveBeenCalledOnce();
			await f.relay.close();
		}
	});
	it("closes input immediately and permits retry of the same durable cancellation", async () => {
		const f = fixture();
		f.close.mockRejectedValueOnce(new Error("lost acknowledgement"));
		const read = f.relay.read();
		await expect(f.relay.close()).rejects.toThrow("lost acknowledgement");
		expect((await read).state).toBe("closed");
		expect(() => f.relay.send(new Uint8Array([1]))).toThrow();
		await f.relay.close();
		expect(f.close).toHaveBeenCalledTimes(2);
	});
	it("forwards only bounded binary data and rejects oversize or string input", async () => {
		const f = fixture();
		f.relay.send(new Uint8Array([1, 2]));
		expect(f.channel.send).toHaveBeenCalledWith(new Uint8Array([1, 2]));
		for (const data of ["credentials", new Uint8Array(256 * 1024 + 1)]) {
			const bad = fixture();
			expect(() => bad.relay.send(data)).toThrow();
			expect(bad.channel.send).not.toHaveBeenCalled();
		}
		await f.relay.close();
	});
});

function renderer(request: (input: Record<string, unknown>) => Promise<unknown>): CompanyComputerViewChannel {
	const source = readFileSync(new URL("../userland/company-computer-view-channel.js", import.meta.url), "utf8");
	const context = {
		request,
		ArrayBuffer,
		Uint8Array,
		Event,
		queueMicrotask,
		channel: undefined as CompanyComputerViewChannel | undefined,
	};
	runInNewContext(
		`${source.replace("export function", "function")}\nchannel = createMemberDisplayChannel(request, "owned");`,
		context,
	);
	return context.channel!;
}
describe("actual renderer display channel with fixture IPC", () => {
	it("pulls bytes only after attachment and closes without replaying input", async () => {
		const f = fixture(),
			requests: string[] = [];
		const channel = renderer(async (input) => {
			requests.push(input.method as string);
			if (input.method === "read") return { ok: true, result: await f.relay.read(input.ack) };
			if (input.method === "send") f.relay.send(input.data);
			if (input.method === "close") await f.relay.close();
			return { ok: true };
		});
		f.channel.onmessage!({ data: new Uint8Array([82, 70, 66]).buffer });
		expect(requests).toEqual([]);
		const received = vi.fn();
		channel.onmessage = received;
		await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ data: new Uint8Array([82, 70, 66]).buffer }));
		channel.send(new Uint8Array([4, 5]));
		await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalledOnce());
		channel.close();
		await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
		expect(channel.readyState).toBe(3);
	});
	it("bounds a stalled renderer writer including its in-flight bytes", async () => {
		const request = vi.fn(async (input: Record<string, unknown>) =>
			input.method === "send" ? new Promise(() => undefined) : { ok: true },
		);
		const channel = renderer(request);
		channel.send(new Uint8Array(256 * 1024).fill(7));
		channel.send(new Uint8Array([1]));
		expect(channel.readyState).toBe(3);
		expect(request.mock.calls.map(([input]) => input.method)).toEqual(["send", "close"]);
		expect((request.mock.calls[0][0].data as Uint8Array).every((byte) => byte === 0)).toBe(true);
	});
});
