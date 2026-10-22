import { connect } from "node:net";
import { type DigitalPostFile, type DigitalPostLetter, digitalPostLetterText } from "./digital-post-memo.ts";

/**
 * The text of Digital Post's PDF letters (deploy/first-node/RUNTIME-DIGITAL-POST.md, part 5). Most authorities send a
 * letter as a PDF alone, with no text or HTML version. The vault hands the main document's PDF to a socket where
 * systemd starts one pdftotext per connection (deploy/cloud-secret-broker/qorpera-pdf-text.socket and
 * qorpera-pdf-text@.service): a throwaway user, no network, nothing it can write, a read-only system, 256 MiB and 30
 * seconds. A PDF is outside content and its parser is where an attack would land, so it never runs in the vault's
 * process or as the vault's user, who can read the vault's keys.
 *
 * Reading is best effort: a letter whose PDF has no text (a scan), or whose reading fails or takes too long, is kept
 * without it, as before part 5. Nothing here logs a letter's content.
 */

/** Where the socket listens. Only the vault's group may connect. */
export const DIGITAL_POST_PDF_TEXT_SOCKET = "/run/qorpera-pdf-text/socket";
/** The most text kept from one PDF, so letter.md stays well under what the Mailbox shows (1 MiB). */
export const DIGITAL_POST_PDF_TEXT_MAX_BYTES = 256 * 1024;
/** Longer than the service's own limit (RuntimeMaxSec=30), which ends a pdftotext that hangs. */
const DEADLINE_MS = 40_000;
/** Said after text cut at the limit. */
const CUT = "[The text stops here. The rest is in the PDF.]";

/** Why a PDF gave no text, for the log: no socket (not installed), too slow, or pdftotext failed or closed early. */
export type DigitalPostPdfTextFailure = "unavailable" | "timeout" | "failed";

export interface DigitalPostPdfTextReader {
	/** The PDF's text, or null when it has none or it could not be read. Rejects only when `signal` aborts. */
	read(pdf: Uint8Array, signal: AbortSignal): Promise<string | null>;
}

const isPdf = (file: DigitalPostFile): boolean =>
	file.encodingFormat === "application/pdf" ||
	// A PDF's header may come anywhere in its first 1024 bytes.
	Buffer.from(file.bytes.buffer, file.bytes.byteOffset, Math.min(file.bytes.byteLength, 1024)).includes("%PDF-");

/** The main document's PDF, when the letter has no text of its own: the file pdftotext reads. */
export function digitalPostPdfToRead(letter: DigitalPostLetter): DigitalPostFile | null {
	if (digitalPostLetterText(letter).text !== null) return null;
	return letter.documents.find((document) => document.role === "main")?.files.find(isPdf) ?? null;
}

/** pdftotext's output as letter.md shows it: page breaks as blank lines, no control characters, no blank runs. Null
 * when nothing is left (a scanned PDF has no text). `cut`: the output went past the limit and was cut there. */
export function digitalPostPdfTextOf(bytes: Uint8Array, cut: boolean): string | null {
	let text = new TextDecoder().decode(bytes);
	// A character the limit cut in two decodes as U+FFFD.
	if (cut) text = text.replace(/�+$/, "");
	text = [...text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n")]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || (code >= 32 && code !== 127);
		})
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!text) return null;
	return cut ? `${text}\n\n${CUT}` : text;
}

/** The reader over the systemd socket. */
export class DigitalPostPdfText implements DigitalPostPdfTextReader {
	readonly #path: string;
	readonly #deadlineMs: number;
	readonly #maxBytes: number;
	readonly #log: (failure: DigitalPostPdfTextFailure) => void;

	constructor(
		options: {
			path?: string;
			deadlineMs?: number;
			maxBytes?: number;
			log?: (failure: DigitalPostPdfTextFailure) => void;
		} = {},
	) {
		this.#path = options.path ?? DIGITAL_POST_PDF_TEXT_SOCKET;
		this.#deadlineMs = options.deadlineMs ?? DEADLINE_MS;
		this.#maxBytes = options.maxBytes ?? DIGITAL_POST_PDF_TEXT_MAX_BYTES;
		this.#log = options.log ?? logFailure();
	}

	async read(pdf: Uint8Array, signal: AbortSignal): Promise<string | null> {
		signal.throwIfAborted();
		const answer = await this.#ask(pdf, signal);
		if ("failure" in answer) {
			this.#log(answer.failure);
			return null;
		}
		return digitalPostPdfTextOf(answer.bytes, answer.cut);
	}

	/** Sends the PDF and closes the sending side, which is pdftotext's end of input; reads its text until it closes. */
	#ask(
		pdf: Uint8Array,
		signal: AbortSignal,
	): Promise<{ bytes: Buffer; cut: boolean } | { failure: DigitalPostPdfTextFailure }> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let connected = false;
			/** The whole PDF is handed over: pdftotext reads all of it before it writes. */
			let sent = false;
			let settled = false;
			const socket = connect({ path: this.#path });
			const settle = (): boolean => {
				if (settled) return false;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				socket.destroy();
				return true;
			};
			const finish = (answer: { bytes: Buffer; cut: boolean } | { failure: DigitalPostPdfTextFailure }) => {
				if (settle()) resolve(answer);
			};
			const abort = () => {
				if (settle()) reject(signal.reason);
			};
			const timer = setTimeout(() => finish({ failure: "timeout" }), this.#deadlineMs);
			signal.addEventListener("abort", abort, { once: true });
			socket.on("connect", () => {
				connected = true;
				socket.end(pdf, () => {
					sent = true;
				});
			});
			socket.on("data", (chunk: Buffer) => {
				const room = this.#maxBytes - size;
				if (chunk.byteLength > room) {
					chunks.push(chunk.subarray(0, room));
					finish({ bytes: Buffer.concat(chunks), cut: true });
					return;
				}
				chunks.push(chunk);
				size += chunk.byteLength;
			});
			// Closed before it had the whole PDF: pdftotext ended early.
			socket.on("end", () => finish(sent ? { bytes: Buffer.concat(chunks), cut: false } : { failure: "failed" }));
			// A socket that is not there or refuses is the service not installed; an error once connected is pdftotext
			// ending before it read the whole PDF.
			socket.on("error", () => finish({ failure: connected ? "failed" : "unavailable" }));
			socket.on("close", () => finish({ failure: "failed" }));
		});
	}
}

/** Logs each failure as a fixed phrase, and a missing service once per process. */
function logFailure(): (failure: DigitalPostPdfTextFailure) => void {
	let toldUnavailable = false;
	return (failure) => {
		if (failure === "unavailable") {
			if (toldUnavailable) return;
			toldUnavailable = true;
			console.error(
				"Digital Post PDF text: the pdftotext socket is not there; PDF letters are kept without their text.",
			);
			return;
		}
		console.error(
			failure === "timeout"
				? "Digital Post PDF text: pdftotext took too long; the letter is kept without its text."
				: "Digital Post PDF text: pdftotext could not read a PDF; the letter is kept without its text.",
		);
	};
}
