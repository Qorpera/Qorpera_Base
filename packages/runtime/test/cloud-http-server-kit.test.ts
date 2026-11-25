import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	bearerTokenMatches,
	isValidBase64UrlToken,
	parseTrustedOrigin,
	readBoundedJsonBody,
	writeJsonResponse,
} from "../src/cloud-http-server-kit.ts";

function fakeRequest(chunks: (string | Buffer)[], headers: Record<string, string> = {}): IncomingMessage {
	const stream = Readable.from(chunks) as unknown as IncomingMessage;
	stream.headers = headers;
	return stream;
}

describe("cloud-http-server-kit", () => {
	it("validates canonical 32-byte base64url tokens", () => {
		const token = randomBytes(32).toString("base64url");
		expect(isValidBase64UrlToken(token)).toBe(true);
		expect(isValidBase64UrlToken("a".repeat(42))).toBe(false);
		expect(isValidBase64UrlToken(`${"A".repeat(42)}B`)).toBe(false);
	});

	it("matches bearer tokens in constant time", () => {
		const token = randomBytes(32).toString("base64url");
		expect(bearerTokenMatches(token, `Bearer ${token}`)).toBe(true);
		expect(bearerTokenMatches(token, `Bearer ${token}x`)).toBe(false);
		expect(bearerTokenMatches(token, `Basic ${token}`)).toBe(false);
		expect(bearerTokenMatches(token, undefined)).toBe(false);
	});

	it("validates trusted origins with optional loopback", () => {
		expect(parseTrustedOrigin("https://example.test", false, "BAD")).toBe("https://example.test");
		expect(() => parseTrustedOrigin("http://127.0.0.1:8080", false, "BAD")).toThrow("BAD");
		expect(parseTrustedOrigin("http://127.0.0.1:8080", true, "BAD")).toBe("http://127.0.0.1:8080");
		expect(() => parseTrustedOrigin("https://example.test/path", false, "BAD")).toThrow("BAD");
	});

	it("reads bounded UTF-8 JSON bodies and enforces byte limits", async () => {
		const body = await readBoundedJsonBody(fakeRequest(['{"ok":true}']), { maxBytes: 64, zeroize: true });
		expect(body).toEqual({ ok: true });

		await expect(
			readBoundedJsonBody(fakeRequest(['{"ok":true}'], { "content-length": "999" }), {
				maxBytes: 64,
				checkContentLength: true,
				tooLargeError: "TOO_BIG",
			}),
		).rejects.toThrow("TOO_BIG");

		await expect(
			readBoundedJsonBody(fakeRequest([Buffer.alloc(100, 0x61)]), {
				maxBytes: 64,
				tooLargeError: "TOO_BIG",
				zeroize: true,
			}),
		).rejects.toThrow("TOO_BIG");
	});

	it("writes JSON responses with security headers, maxBytes, and closeUnread", () => {
		let writtenStatus = 0;
		let writtenHeaders: Record<string, unknown> = {};
		let writtenBody = "";
		const reply = {
			req: { headers: { "content-length": "12" }, complete: false },
			writeHead(status: number, headers: Record<string, unknown>) {
				writtenStatus = status;
				writtenHeaders = headers;
			},
			end(body: string) {
				writtenBody = body;
			},
		} as unknown as ServerResponse;

		writeJsonResponse(reply, 200, { ok: true }, { closeUnread: true, headers: { "x-extra": "1" } });
		expect(writtenStatus).toBe(200);
		expect(writtenBody).toBe('{"ok":true}');
		expect(writtenHeaders).toMatchObject({
			"content-type": "application/json",
			"content-length": 11,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			connection: "close",
			"x-extra": "1",
		});

		expect(() => writeJsonResponse(reply, 200, { a: "12345" }, { maxBytes: 4, maxBytesError: "LIMIT" })).toThrow(
			"LIMIT",
		);
	});
});
