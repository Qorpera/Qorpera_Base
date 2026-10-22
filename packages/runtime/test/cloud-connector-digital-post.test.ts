import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import {
	DIGITAL_POST_LIST_SIZE,
	type DigitalPostAnswer,
	DigitalPostAnswerTooLarge,
	DigitalPostClient,
	DigitalPostKeyInvalid,
	DigitalPostKeyRefused,
	type DigitalPostRequest,
	digitalPostTransport,
	parseDigitalPostApp,
	parseDigitalPostKey,
} from "@qorpera/runtime/cloud-connector-digital-post";
import { ConnectorRequestError } from "@qorpera/runtime/cloud-connector-http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* The Digital Post client (cloud-connector-digital-post.ts): the company's API key read as Administrativ Adgang shows
 * it, Qorpera's certificate checked once and presented on every call, the letter list, a letter and its receipt, and
 * Digital Post's refusals told apart. */

const SYSTEM = "e545b339-8542-4a30-ae75-c67e4d2a7b99";
const VALUE = "15632a8d-407c-4c3a-b7b1-aebaa514fcab";
const KEY_TEXT = Buffer.from(`${SYSTEM}:${VALUE}`).toString("base64");
const signal = new AbortController().signal;

let dir = "";
/** A throwaway P-256 pair (openssl CLI), self-signed for `name`. */
function certificate(tag: string, name: string) {
	const key = join(dir, `${tag}.key`);
	const cert = join(dir, `${tag}.crt`);
	execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key], { stdio: "ignore" });
	execFileSync(
		"openssl",
		[
			"req",
			"-new",
			"-x509",
			"-key",
			key,
			"-out",
			cert,
			"-days",
			"2",
			"-subj",
			`/CN=${name}`,
			"-addext",
			`subjectAltName=DNS:${name}`,
		],
		{ stdio: "ignore" },
	);
	return { keyPem: readFileSync(key, "utf8"), certPem: readFileSync(cert, "utf8") };
}

let qorpera: { keyPem: string; certPem: string };
let other: { keyPem: string; certPem: string };
let server: { keyPem: string; certPem: string };
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "qorpera-digital-post-"));
	qorpera = certificate("qorpera", "qorpera-oces-test");
	other = certificate("other", "other-oces-test");
	server = certificate("server", "localhost");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseDigitalPostKey", () => {
	it("reads the encoded key, with or without Basic and spaces", () => {
		const expected = { systemId: SYSTEM, authorization: `Basic ${KEY_TEXT}` };
		expect(parseDigitalPostKey(KEY_TEXT)).toEqual(expected);
		expect(parseDigitalPostKey(`  Basic ${KEY_TEXT.slice(0, 20)}\n${KEY_TEXT.slice(20)} `)).toEqual(expected);
		const upper = Buffer.from(`${SYSTEM.toUpperCase()}:${VALUE}`).toString("base64");
		expect(parseDigitalPostKey(upper)).toEqual(expected);
	});

	it("refuses what is not a system id and a key", () => {
		for (const text of [
			"",
			"not base64 at all",
			Buffer.from(VALUE).toString("base64"),
			Buffer.from(`not-a-uuid:${VALUE}`).toString("base64"),
			Buffer.from(`${SYSTEM}:short`).toString("base64"),
			Buffer.from(`${SYSTEM}:has space inside`).toString("base64"),
			`${KEY_TEXT}x`,
		])
			expect(() => parseDigitalPostKey(text), text).toThrow(DigitalPostKeyInvalid);
	});
});

describe("parseDigitalPostApp", () => {
	it("takes a certificate with its own key, and nothing else", () => {
		const app = { environment: "test", certificatePem: qorpera.certPem, privateKeyPem: qorpera.keyPem };
		expect(parseDigitalPostApp(app)).toEqual(app);
		expect(parseDigitalPostApp(undefined)).toBeUndefined();
		for (const bad of [
			{ ...app, privateKeyPem: other.keyPem },
			{ ...app, environment: "staging" },
			{ ...app, extra: 1 },
			{ ...app, certificatePem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" },
			null,
			[],
		])
			expect(() => parseDigitalPostApp(bad)).toThrow("Digital Post certificate is invalid");
		try {
			parseDigitalPostApp({ ...app, privateKeyPem: other.keyPem });
		} catch (error) {
			expect(String(error)).not.toContain("PRIVATE KEY");
		}
	});
});

/** A fake Digital Post behind the transport: every request is recorded and answered by `route`. */
function fake(route: (request: DigitalPostRequest) => DigitalPostAnswer) {
	const requests: DigitalPostRequest[] = [];
	const client = new DigitalPostClient(
		{ environment: "test", certificatePem: "unused", privateKeyPem: "unused" },
		async (request, maximumBytes, deadlineMs) => {
			expect(maximumBytes).toBeGreaterThan(0);
			expect(deadlineMs).toBeGreaterThan(0);
			requests.push(request);
			return route(request);
		},
	);
	return { client, requests };
}
const key = parseDigitalPostKey(KEY_TEXT);
const json = (value: unknown, status = 200): DigitalPostAnswer => ({
	status,
	body: new Uint8Array(Buffer.from(JSON.stringify(value))),
});
const ID = "a66fcd7b-3392-4c69-ae2e-48f5c2e5ad98";
const MESSAGE = "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a";

describe("DigitalPostClient", () => {
	it("lists the letters waiting, and says whether that is all", async () => {
		const { client, requests } = fake(() => json({ content: [ID.toUpperCase(), ID, MESSAGE], totalPages: 1 }));
		expect(await client.available(key, signal)).toEqual({ ids: [ID, MESSAGE], complete: true });
		expect(requests).toEqual([
			{
				method: "GET",
				path: `/apis/v1/memos/?page=0&size=${DIGITAL_POST_LIST_SIZE}`,
				headers: { accept: "application/json", authorization: `Basic ${KEY_TEXT}` },
			},
		]);
		const full = Array.from(
			{ length: DIGITAL_POST_LIST_SIZE },
			(_, index) => `a66fcd7b-3392-4c69-ae2e-${String(index).padStart(12, "0")}`,
		);
		expect((await fake(() => json({ content: full, totalPages: 3 })).client.available(key, signal)).complete).toBe(
			false,
		);
		expect((await fake(() => json({ content: full })).client.available(key, signal)).complete).toBe(false);
		expect((await fake(() => json({ content: full, totalPages: 1 })).client.available(key, signal)).complete).toBe(
			true,
		);
		// A later page, zero-based: complete when no page follows it.
		const paged = fake(() => json({ content: full, totalPages: 3 }));
		expect((await paged.client.available(key, signal, 2)).complete).toBe(true);
		expect((await paged.client.available(key, signal, 1)).complete).toBe(false);
		expect(paged.requests[0]?.path).toBe(`/apis/v1/memos/?page=2&size=${DIGITAL_POST_LIST_SIZE}`);
		await expect(paged.client.available(key, signal, -1)).rejects.toThrow("Digital Post page is invalid");
	});

	it("refuses a list it cannot read", async () => {
		for (const answer of [
			{ status: 200, body: new Uint8Array(Buffer.from("<xml/>")) },
			json({ content: ["not-a-uuid"] }),
			json({ content: "x" }),
			json({ content: Array.from({ length: DIGITAL_POST_LIST_SIZE + 1 }, () => ID) }),
		])
			await expect(fake(() => answer).client.available(key, signal)).rejects.toThrow(ConnectorRequestError);
	});

	it("tells a refused key apart from every other refusal", async () => {
		await expect(fake(() => json({}, 401)).client.available(key, signal)).rejects.toBeInstanceOf(
			DigitalPostKeyRefused,
		);
		const reasons = async (status: number) => {
			try {
				await fake(() => json({ message: "secret detail" }, status)).client.available(key, signal);
			} catch (error) {
				expect(String(error)).not.toContain("secret detail");
				return error instanceof ConnectorRequestError ? error.reason : String(error);
			}
		};
		expect(await reasons(403)).toBe("forbidden");
		expect(await reasons(429)).toBe("rate_limited");
		expect(await reasons(400)).toBe("invalid_request");
		expect(await reasons(503)).toBe("provider_error");
	});

	it("fetches a letter as XML, and answers null for one Digital Post no longer has", async () => {
		const xml = new Uint8Array(Buffer.from("<memo:Message/>"));
		const { client, requests } = fake((request) =>
			request.path.endsWith(ID) ? { status: 200, body: xml } : json({}, 404),
		);
		expect(await client.letter(key, ID, signal)).toEqual(xml);
		expect(await client.letter(key, MESSAGE, signal)).toBeNull();
		expect(requests[0]).toEqual({
			method: "GET",
			path: `/apis/v1/memos/${ID}`,
			headers: { accept: "application/xml", authorization: `Basic ${KEY_TEXT}` },
		});
		await expect(client.letter(key, "../receipts", signal)).rejects.toThrow("Digital Post letter id is invalid");
		await expect(fake(() => json({}, 500)).client.letter(key, ID, signal)).rejects.toThrow(ConnectorRequestError);
	});

	it("receipts a letter as completed, and takes a letter that is gone as settled", async () => {
		const now = new Date("2026-10-22T08:00:00Z");
		const { client, requests } = fake((request) => ({
			status: request.path.includes(ID) ? 200 : 404,
			body: new Uint8Array(),
		}));
		expect(await client.receipt(key, ID, MESSAGE, now, signal)).toBe("receipted");
		expect(await client.receipt(key, MESSAGE, MESSAGE, now, signal)).toBe("gone");
		const [first] = requests;
		expect(first?.method).toBe("POST");
		expect(first?.path).toBe(`/apis/v1/memos/${ID}/receipt`);
		expect(first?.headers).toEqual({
			accept: "application/json",
			"content-type": "application/json",
			authorization: `Basic ${KEY_TEXT}`,
		});
		expect(JSON.parse(Buffer.from(first?.body ?? []).toString())).toEqual({
			messageUUID: MESSAGE,
			receiptStatus: "COMPLETED",
			timeStamp: "2026-10-22T08:00:00.000Z",
		});
		await expect(fake(() => json({}, 409)).client.receipt(key, ID, MESSAGE, now, signal)).rejects.toThrow(
			ConnectorRequestError,
		);
		await expect(fake(() => json({}, 401)).client.receipt(key, ID, MESSAGE, now, signal)).rejects.toBeInstanceOf(
			DigitalPostKeyRefused,
		);
	});
});

describe("digitalPostTransport", () => {
	let https: Server;
	let port = 0;
	const seen: { subject: string | null; authorization: string | undefined; body: string }[] = [];
	beforeAll(async () => {
		https = createServer(
			{ key: server.keyPem, cert: server.certPem, requestCert: true, rejectUnauthorized: false },
			(request, response) => {
				const peer = (request.socket as TLSSocket).getPeerCertificate();
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					seen.push({
						subject: peer && Object.keys(peer).length > 0 ? String(peer.subject?.CN) : null,
						authorization: request.headers.authorization,
						body: Buffer.concat(chunks).toString(),
					});
					if (request.url === "/big") {
						response.writeHead(200);
						response.end(Buffer.alloc(4096));
						return;
					}
					response.writeHead(201, { "content-type": "text/plain" });
					response.end(`${request.method} ${request.url}`);
				});
			},
		);
		await new Promise<void>((resolve) => https.listen(0, resolve));
		port = (https.address() as AddressInfo).port;
	});
	afterAll(() => new Promise<void>((resolve) => https.close(() => resolve())));

	const app = () => ({ environment: "test" as const, certificatePem: qorpera.certPem, privateKeyPem: qorpera.keyPem });

	it("presents Qorpera's certificate and sends the request as given", async () => {
		const send = digitalPostTransport(app(), { host: "localhost", port, ca: server.certPem });
		const answer = await send(
			{
				method: "POST",
				path: "/apis/v1/memos/x/receipt",
				headers: { authorization: "Basic abc" },
				body: new Uint8Array(Buffer.from("{}")),
			},
			1024,
			5000,
			signal,
		);
		expect(answer.status).toBe(201);
		expect(Buffer.from(answer.body).toString()).toBe("POST /apis/v1/memos/x/receipt");
		expect(seen.at(-1)).toEqual({ subject: "qorpera-oces-test", authorization: "Basic abc", body: "{}" });
	});

	it("refuses a server whose certificate it does not trust, and an answer over its bound", async () => {
		const untrusted = digitalPostTransport(app(), { host: "localhost", port, ca: other.certPem });
		await expect(untrusted({ method: "GET", path: "/", headers: {} }, 1024, 5000, signal)).rejects.toThrow();
		const send = digitalPostTransport(app(), { host: "localhost", port, ca: server.certPem });
		await expect(send({ method: "GET", path: "/big", headers: {} }, 1024, 5000, signal)).rejects.toBeInstanceOf(
			DigitalPostAnswerTooLarge,
		);
	});

	it("ends at the caller's signal", async () => {
		const send = digitalPostTransport(app(), { host: "localhost", port, ca: server.certPem });
		const stop = new AbortController();
		stop.abort();
		await expect(send({ method: "GET", path: "/", headers: {} }, 1024, 5000, stop.signal)).rejects.toThrow(
			"Digital Post request ended",
		);
	});
});
