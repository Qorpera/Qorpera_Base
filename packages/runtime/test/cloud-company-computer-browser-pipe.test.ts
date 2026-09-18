import { PassThrough } from "node:stream";
import { CompanyComputerBrowserPipe } from "@qorpera/runtime/cloud-company-computer-browser-pipe";
import { describe, expect, it, vi } from "vitest";

function fixture() {
	const input = new PassThrough();
	const output = new PassThrough();
	const stop = vi.fn();
	const pipe = new CompanyComputerBrowserPipe(input, output, stop);
	pipe.onmessage = vi.fn();
	pipe.onclose = vi.fn();
	pipe.open();
	return { input, output, stop, pipe };
}

describe("broker-only Chromium pipe", () => {
	it("starts reading on the first Chromium query without requiring the optional open hook", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const pipe = new CompanyComputerBrowserPipe(input, output, vi.fn());
		pipe.onmessage = vi.fn();
		pipe.send({ id: 1, method: "Browser.getVersion" });
		output.write('{"id":1,"result":{}}\0');
		await vi.waitFor(() => expect(pipe.onmessage).toHaveBeenCalledWith({ id: 1, result: {} }));
		pipe.close();
	});
	it("preserves fragmented/coalesced JSON messages and writes NUL-delimited requests", async () => {
		const f = fixture();
		const written: Buffer[] = [];
		f.input.on("data", (bytes) => written.push(bytes));
		f.pipe.send({ id: 1, method: "Browser.getVersion" });
		expect(Buffer.concat(written).toString()).toBe('{"id":1,"method":"Browser.getVersion"}\0');
		f.output.write('{"id":1,"result":');
		f.output.write('{"product":"fixture"}}\0{"method":"Target.targetCreated","params":{}}\0');
		await vi.waitFor(() => expect(f.pipe.onmessage).toHaveBeenCalledTimes(2));
		expect(f.pipe.onmessage).toHaveBeenNthCalledWith(1, { id: 1, result: { product: "fixture" } });
		expect(f.pipe.onmessage).toHaveBeenNthCalledWith(2, { method: "Target.targetCreated", params: {} });
		f.pipe.close();
	});
	it.each([Buffer.from("PRIVATE_INVALID_JSON\0"), Buffer.from("[]\0"), Buffer.from([0xff, 0])])(
		"closes malformed input without exposing its bytes in the failure reason",
		async (frame) => {
			const f = fixture();
			f.output.write(frame);
			await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
			expect(f.pipe.onmessage).not.toHaveBeenCalled();
			expect(f.pipe.onclose).toHaveBeenCalledWith("OFFICE_BROWSER_CHANNEL_CLOSED");
			f.pipe.close();
			expect(f.stop).toHaveBeenCalledOnce();
		},
	);
	it("bounds an unterminated inbound frame and outbound request allocation", async () => {
		const incoming = fixture();
		incoming.output.write(Buffer.alloc(16 * 1024 * 1024 + 1, 65));
		await vi.waitFor(() => expect(incoming.stop).toHaveBeenCalledOnce());
		const outgoing = fixture();
		expect(() => outgoing.pipe.send({ data: "x".repeat(16 * 1024 * 1024) })).toThrow("OFFICE_BROWSER_CHANNEL_LIMIT");
		expect(outgoing.stop).toHaveBeenCalledOnce();
	});
	it("terminates once on EOF or consumer failure and refuses further messages", async () => {
		const f = fixture();
		f.pipe.onmessage = () => {
			throw new Error("private callback detail");
		};
		f.output.write('{"id":1}\0');
		await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
		f.output.end();
		expect(() => f.pipe.send({ id: 2 })).toThrow("OFFICE_BROWSER_CHANNEL_CLOSED");
		expect(f.pipe.onclose).toHaveBeenCalledOnce();
	});
});
