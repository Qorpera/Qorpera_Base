import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudSessionAttachments } from "../src/cloud-session-attachments.ts";

const sessionId = "29600000-0000-4000-8000-000000000060";
const inputId = "29600000-0000-4000-8000-000000000070";
const bytes = Buffer.from("PNG_BYTES");
const reference = {
	sha256: createHash("sha256").update(bytes).digest("hex"),
	bytes: bytes.length,
	mediaType: "image/png",
};
const signal = new AbortController().signal;

function fixture(response: () => Response = () => Response.json(reference)) {
	const fetcher = vi.fn<typeof fetch>(async () => response());
	const client = new CloudSessionAttachments({
		objectGatewayUrl: "https://gateway.test",
		accessToken: async () => "member-jwt",
		fetch: fetcher,
	});
	return { client, fetcher };
}

describe("member chat attachment transport", () => {
	it("uploads the actual bytes bound to the exact session and input", async () => {
		const { client, fetcher } = fixture();
		expect(await client.upload(sessionId, inputId, bytes, "image/png", signal)).toEqual(reference);
		const [url, request] = fetcher.mock.calls[0];
		expect(url).toBe(
			`https://gateway.test/v1/member-session-attachments/upload/${sessionId}/${inputId}/${reference.sha256}`,
		);
		expect(request?.method).toBe("PUT");
		expect(request?.redirect).toBe("error");
		expect(request?.body).toEqual(bytes);
		const headers = new Headers(request?.headers);
		expect(headers.get("authorization")).toBe("Bearer member-jwt");
		expect(headers.get("content-length")).toBe(String(bytes.length));
		expect(headers.has("apikey")).toBe(false);
	});
	it("downloads only through canonical input authority and checks exact bytes", async () => {
		const { client, fetcher } = fixture(() => new Response(bytes));
		expect(await client.read(sessionId, inputId, reference, signal)).toEqual(new Uint8Array(bytes));
		expect(fetcher.mock.calls[0][0]).toBe(
			`https://gateway.test/v1/member-session-attachments/input/${sessionId}/${inputId}/${reference.sha256}`,
		);
		expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
		fetcher.mockImplementationOnce(async () => new Response("BAD_BYTES"));
		await expect(client.read(sessionId, inputId, reference, signal)).rejects.toThrow("integrity");
		fetcher.mockImplementationOnce(async () => new Response("PNG_BYTES_PLUS"));
		await expect(client.read(sessionId, inputId, reference, signal)).rejects.toThrow();
	});
	it.each([
		{ ...reference, sha256: "a".repeat(64) },
		{ ...reference, mediaType: "image/jpeg" },
		{ ...reference, uploadId: inputId },
		{},
	])("rejects a changed upload receipt", async (receipt) => {
		const { client } = fixture(() => Response.json(receipt));
		await expect(client.upload(sessionId, inputId, bytes, "image/png", signal)).rejects.toThrow("receipt");
	});
	it.each([401, 403, 409, 503])("does not retry or expose a raw cloud error (%s)", async (status) => {
		const { client, fetcher } = fixture(() => new Response("PRIVATE DATABASE ERROR", { status }));
		await expect(client.upload(sessionId, inputId, bytes, "image/png", signal)).rejects.not.toThrow(
			"PRIVATE DATABASE ERROR",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("rejects malformed identifiers and unsupported or oversized media before network access", async () => {
		const { client, fetcher } = fixture();
		await expect(client.upload("../session", inputId, bytes, "image/png", signal)).rejects.toThrow();
		await expect(client.upload(sessionId, inputId, bytes, "text/html", signal)).rejects.toThrow();
		await expect(client.upload(sessionId, inputId, new Uint8Array(), "image/png", signal)).rejects.toThrow();
		await expect(client.upload(sessionId, inputId, new Uint8Array(8388609), "image/png", signal)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("bounds stalled tokens without submitting an upload", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const client = new CloudSessionAttachments({
			objectGatewayUrl: "https://gateway.test",
			accessToken: () => new Promise(() => {}),
			fetch: fetcher,
			timeoutMs: 10,
		});
		await expect(client.upload(sessionId, inputId, bytes, "image/png", signal)).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("keeps denials immediate even if their body never finishes", async () => {
		const { client } = fixture(() => new Response(new ReadableStream(), { status: 403 }));
		await expect(client.read(sessionId, inputId, reference, signal)).rejects.toThrow("denied");
	});
	it.each([
		"http://gateway.test",
		"https://gateway.test/path",
		"https://user:password@gateway.test",
		"https://gateway.test?query=yes",
	])("refuses credential-bearing or noncanonical gateway URLs: %s", (url) => {
		expect(() => new CloudSessionAttachments({ objectGatewayUrl: url, accessToken: async () => "token" })).toThrow();
	});
});
