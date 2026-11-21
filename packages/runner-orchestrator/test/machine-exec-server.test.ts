import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LINE_PIPE_BYTES, LinePipe, SFTP_PIECE_BYTES, sftpBytes, sftpLines } from "../src/machine-exec-server.ts";

describe("LinePipe and SFTP line framing", () => {
	it("decodes split multi-byte UTF-8 lines and compacts chunk queues across many pushes", async () => {
		const pipe = new LinePipe();
		const line = "echo 'på maskinen æøå'\n";
		const bytes = Buffer.from(line, "utf8");
		for (let i = 0; i < 80; i += 1) {
			const split = bytes.indexOf(Buffer.from("å", "utf8")) + 1;
			pipe.push(bytes.subarray(0, split));
			pipe.push(bytes.subarray(split));
		}
		pipe.end();
		const received: string[] = [];
		for await (const item of pipe.lines()) received.push(item);
		expect(received).toHaveLength(80);
		expect(received.every((entry) => entry === "echo 'på maskinen æøå'")).toBe(true);
		expect(pipe.failed).toBe(false);
	});

	it("stops reading when a single unterminated line exceeds LINE_PIPE_BYTES", async () => {
		const pipe = new LinePipe();
		const chunk = Buffer.alloc(1024 * 1024, 0x61);
		const read = (async () => {
			const out: string[] = [];
			for await (const line of pipe.lines()) out.push(line);
			return out;
		})();
		for (let i = 0; i <= LINE_PIPE_BYTES / chunk.byteLength; i += 1) {
			pipe.push(chunk);
			await new Promise((resolve) => setImmediate(resolve));
		}
		pipe.end();
		expect(await read).toEqual([]);
	});

	it("encodes Uint8Array subarrays with non-zero byteOffset without copying wrong parent bytes", async () => {
		const raw = randomBytes(SFTP_PIECE_BYTES + 64);
		const view = new Uint8Array(raw.buffer, raw.byteOffset + 17, SFTP_PIECE_BYTES + 11);
		const encoded: string[] = [];
		for await (const line of sftpLines(
			(async function* () {
				yield view;
			})(),
		)) {
			encoded.push(line);
		}
		expect(encoded).toHaveLength(2);
		const decoded = Buffer.concat(
			encoded.map((line) => {
				const bytes = sftpBytes(line);
				if (!bytes) throw new Error("invalid base64");
				return bytes;
			}),
		);
		expect(decoded.equals(Buffer.from(view))).toBe(true);
	});
});
