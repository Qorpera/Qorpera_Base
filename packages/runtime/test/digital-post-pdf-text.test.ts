import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigitalPostLetter } from "@qorpera/runtime/digital-post-memo";
import { DigitalPostPdfText, digitalPostPdfTextOf, digitalPostPdfToRead } from "@qorpera/runtime/digital-post-pdf-text";
import { afterEach, describe, expect, it, vi } from "vitest";

/* A PDF-only letter's text (digital-post-pdf-text.ts): which file is read, the reader over the pdftotext socket (a
 * stand-in server here; deploy/cloud-secret-broker/test/prove-pdf-text.mjs proves the real service on a host), and the
 * text as letter.md keeps it. */

const servers: Server[] = [];
const sockets: Socket[] = [];
const folders: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const socket of sockets.splice(0)) socket.destroy();
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A stand-in for the socket: reads the PDF until the vault closes its side, then `answer`s on the same connection. */
async function service(answer: (pdf: Buffer, socket: Socket) => void, onConnect?: (socket: Socket) => void) {
	const folder = mkdtempSync(join(tmpdir(), "pdf-text-"));
	folders.push(folder);
	const path = join(folder, "socket");
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.push(socket);
		onConnect?.(socket);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("end", () => answer(Buffer.concat(chunks), socket));
		socket.on("error", () => {});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return path;
}

const signal = new AbortController().signal;

describe("the reader", () => {
	it("sends the PDF whole and reads its text back, cleaned for letter.md", async () => {
		const pdf = Buffer.alloc(3 * 1024 * 1024, 1);
		const received: Buffer[] = [];
		const path = await service((input, socket) => {
			received.push(input);
			socket.end("Skattestyrelsen  \r\nAfgørelse\f\fSide 2\u0007\n\n\n\nSlut\n");
		});
		const log = vi.fn();
		expect(await new DigitalPostPdfText({ path, log }).read(pdf, signal)).toBe(
			"Skattestyrelsen\nAfgørelse\n\nSide 2\n\nSlut",
		);
		expect(received[0]?.equals(pdf)).toBe(true);
		expect(log).not.toHaveBeenCalled();
	});

	it("gives no text for a PDF that has none, as a scan", async () => {
		const path = await service((_input, socket) => socket.end("\f\n  \n"));
		const log = vi.fn();
		expect(await new DigitalPostPdfText({ path, log }).read(Buffer.from("%PDF-1.4"), signal)).toBeNull();
		expect(log).not.toHaveBeenCalled();
	});

	it("cuts long text at the limit, at a whole character, and says so", async () => {
		const path = await service((_input, socket) => socket.end("æææææææææ"));
		expect(await new DigitalPostPdfText({ path, maxBytes: 11 }).read(Buffer.from("%PDF"), signal)).toBe(
			"æææææ\n\n[The text stops here. The rest is in the PDF.]",
		);
	});

	it("gives no text and says once when the service is not installed", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const reader = new DigitalPostPdfText({ path: join(tmpdir(), "no-such-folder", "socket") });
		expect(await reader.read(Buffer.from("%PDF"), signal)).toBeNull();
		expect(await reader.read(Buffer.from("%PDF"), signal)).toBeNull();
		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toContain("the pdftotext socket is not there");
	});

	it("gives no text when pdftotext ends before it read the PDF, or takes too long", async () => {
		const closing = await service(
			() => {},
			(socket) => socket.destroy(),
		);
		const log = vi.fn();
		expect(
			await new DigitalPostPdfText({ path: closing, log }).read(Buffer.alloc(8 * 1024 * 1024), signal),
		).toBeNull();
		const silent = await service(() => {});
		expect(
			await new DigitalPostPdfText({ path: silent, log, deadlineMs: 50 }).read(Buffer.from("%PDF"), signal),
		).toBeNull();
		expect(log.mock.calls.map(([failure]) => failure)).toEqual(["failed", "timeout"]);
	});

	it("stops at once when the pass is stopped", async () => {
		const path = await service(() => {});
		const stop = new AbortController();
		const reading = new DigitalPostPdfText({ path, log: vi.fn() }).read(Buffer.from("%PDF"), stop.signal);
		stop.abort(new Error("closing"));
		await expect(reading).rejects.toThrow("closing");
	});
});

describe("which file is read", () => {
	const file = (filename: string, encodingFormat: string, content: string) => ({
		filename,
		encodingFormat,
		language: null,
		bytes: new Uint8Array(Buffer.from(content)),
	});
	const letter = (main: ReturnType<typeof file>[], additional: ReturnType<typeof file>[] = []) =>
		({
			documents: [
				{ role: "main", label: null, files: main, actions: [] },
				{ role: "additional", label: null, files: additional, actions: [] },
			],
		}) as unknown as DigitalPostLetter;

	it("reads the main document's PDF only when the letter has no text of its own", () => {
		const pdf = file("brev.pdf", "application/pdf", "%PDF-1.7 ...");
		expect(digitalPostPdfToRead(letter([pdf]))).toBe(pdf);
		// A PDF the sender did not name as one is still a PDF by its header.
		const unnamed = file("brev", "application/octet-stream", `${" ".repeat(100)}%PDF-1.4`);
		expect(digitalPostPdfToRead(letter([unnamed]))).toBe(unnamed);
		expect(digitalPostPdfToRead(letter([pdf, file("brev.txt", "text/plain", "Tekst")]))).toBeNull();
		expect(digitalPostPdfToRead(letter([file("brev.docx", "application/octet-stream", "PK")]))).toBeNull();
		expect(digitalPostPdfToRead(letter([], [pdf]))).toBeNull();
	});
});

describe("the text kept", () => {
	it("is null when only white space is left, and keeps tabs and line breaks", () => {
		expect(digitalPostPdfTextOf(Buffer.from(" \f \n\t"), false)).toBeNull();
		expect(digitalPostPdfTextOf(Buffer.from("Beløb\t1.200 kr.\nForfald\t1. november"), false)).toBe(
			"Beløb\t1.200 kr.\nForfald\t1. november",
		);
	});
});
