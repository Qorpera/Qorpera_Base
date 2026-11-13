import { createHash } from "node:crypto";
import {
	CODE_IMPORT_FETCH_MS,
	CODE_IMPORT_IDLE_MS,
	CODE_IMPORT_MAXIMUM_BYTES_LIMIT,
	type CodeImportAnswer,
	type CodeImportFetched,
	type CodeImportFetchOptions,
	type CodeImportSink,
	CodeImportStop,
	codeImportAdvertisement,
	codeImportAnswerStop,
	codeImportBundleHeader,
	codeImportBundlePieces,
	codeImportFetchRequest,
	codeImportGitHubOf,
	codeImportLsRefsRequest,
	codeImportPack,
	codeImportRefList,
	codeImportWants,
} from "./code-import.ts";

/** The import's fetch from GitHub (own code storage, step 6, part C2): git's protocol v2 over smart HTTP as bytes only,
 * with no git process anywhere on the node. One GET of `info/refs` (the capability advertisement), one POST of
 * `ls-refs` (the default branch, every head and tag), one POST of `fetch` (every object wanted once, no haves); the
 * pack of side band 1 goes behind a `# v2 git bundle` header into the store's import writer in 1 MiB pieces, each
 * write awaited. Nothing is read from the network while a write waits, so a slow store holds the source back and the
 * executor holds one piece and one pkt-line of it. The code host parses it later (part B's look).
 *
 * The transport (`deploy/coding-worker/repository-fetch.ts`: the secret broker's relay with the company's GitHub
 * connection, or github.com straight for a public project) is all this file knows of the network. Every way the
 * source or the road to it can go wrong ends in one of part C1's stops (`CodeImportStop`): its code, never a byte of
 * what the source said, is all an error carries. The writer is only written to: the run that began it commits or
 * aborts it (part C3). */

/** The fetch's own bounds, for tests: in all (60 minutes), and the longest wait for the network (2 minutes: an answer's
 * headers, or the next piece of its body). A wait for the writer is not one. */
export interface CodeImportFetchBounds {
	readonly fetchMs?: number;
	readonly idleMs?: number;
}

const cut = () => new CodeImportStop("busy", "IMPORT_TRANSFER_CUT");
const protocol = () => new CodeImportStop("failed", "IMPORT_SOURCE_PROTOCOL");

/** `work`, but at most `ms`, and never after `signal`: past either, it rejects with a cut (the caller tells the two
 * apart by the signal). Its own rejection comes as it is. */
function waited<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			reject(cut());
		};
		const timer = setTimeout(stop, ms);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		work.then(resolve, reject).finally(() => {
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
		});
	});
}

/** Whether a transport's answer is one of its two kinds. */
function answerValid(answer: CodeImportAnswer): boolean {
	if (typeof answer !== "object" || answer === null || !Number.isSafeInteger(answer.status)) return false;
	if (answer.by === "relay") return answer.error === null || typeof answer.error === "string";
	return (
		answer.by === "source" &&
		(answer.contentType === null || typeof answer.contentType === "string") &&
		typeof answer.body?.[Symbol.asyncIterator] === "function"
	);
}

/**
 * The first bundle of a GitHub repository, written into `writer`: the advertisement (`version 2`, SHA-1), the ref list
 * (at most 20,000 lines and 4 MiB), the wants (the default branch, or `options.branch`, then every head and tag, at
 * most 5,000 objects), the fetch, and the header and the pack in 1 MiB pieces, at most `maximumBytes` in all
 * (`IMPORT_TOO_LARGE`, before the piece with the byte too many). A `not our ref` (the source moved between the ref
 * list and the fetch) is worth exactly one new ref list. Within 60 minutes in all (`IMPORT_FETCH_TIMEOUT`); no wait
 * for the network longer than 2 minutes, and no rejection of the transport, ends otherwise than busy
 * (`IMPORT_TRANSFER_CUT`); the run's signal ends it busy (`IMPORT_STOPPED`). A piece the writer refuses stops it with
 * the writer's own error. Every connection the fetch opened is ended when it ends.
 */
export async function fetchGitHubImport(
	options: CodeImportFetchOptions,
	writer: CodeImportSink,
	bounds: CodeImportFetchBounds = {},
): Promise<CodeImportFetched> {
	const { transport, repository, maximumBytes, signal } = options ?? {};
	const branch = options?.branch ?? null;
	const fetchMs = bounds.fetchMs ?? CODE_IMPORT_FETCH_MS,
		idleMs = bounds.idleMs ?? CODE_IMPORT_IDLE_MS;
	let named = true;
	try {
		codeImportGitHubOf(`${repository?.owner}/${repository?.name}`);
	} catch {
		named = false;
	}
	if (
		!named ||
		typeof transport?.refs !== "function" ||
		typeof transport.uploadPack !== "function" ||
		typeof writer?.write !== "function" ||
		!(signal instanceof AbortSignal) ||
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 1 ||
		maximumBytes > CODE_IMPORT_MAXIMUM_BYTES_LIMIT ||
		(branch !== null && typeof branch !== "string") ||
		![fetchMs, idleMs].every((ms) => Number.isSafeInteger(ms) && ms >= 1 && ms <= CODE_IMPORT_FETCH_MS)
	)
		throw new Error("INVALID_CODE_IMPORT_FETCH");
	if (signal.aborted) throw new CodeImportStop("busy", "IMPORT_STOPPED");
	const deadline = AbortSignal.timeout(fetchMs);
	const run = AbortSignal.any([signal, deadline]);
	/** Every request's own end: each is ended when the fetch ends, however it ends. */
	const calls: AbortController[] = [];

	/** One request, its answer within the idle bound; any rejection but a stop of the transport's own is a cut. */
	async function ask(
		send: (signal: AbortSignal) => Promise<CodeImportAnswer>,
	): Promise<{ answer: CodeImportAnswer; call: AbortController }> {
		const call = new AbortController();
		calls.push(call);
		let answer: CodeImportAnswer;
		try {
			answer = await waited(
				Promise.resolve().then(() => send(AbortSignal.any([run, call.signal]))),
				idleMs,
				run,
			);
		} catch (error) {
			call.abort();
			throw error instanceof CodeImportStop ? error : cut();
		}
		if (!answerValid(answer)) {
			call.abort();
			throw protocol();
		}
		return { answer, call };
	}

	/** An answer that stops the fetch: its body is not read, and its connection ends. */
	function stopped(answer: CodeImportAnswer, call: AbortController, stop: CodeImportStop): CodeImportStop {
		call.abort();
		if (answer.by === "source")
			void Promise.resolve()
				.then(() => answer.body[Symbol.asyncIterator]().return?.())
				.catch(() => undefined);
		return stop;
	}

	/** An answer's body, each piece within the idle bound: a read that fails is a cut. When its reader stops before the
	 * end, the connection ends and the body is let go. */
	async function* read(answer: CodeImportAnswer, call: AbortController): AsyncGenerator<Uint8Array, void, undefined> {
		if (answer.by !== "source") throw protocol();
		const pieces = answer.body[Symbol.asyncIterator]();
		let ended = false;
		try {
			for (;;) {
				let next: IteratorResult<Uint8Array>;
				try {
					next = await waited(
						Promise.resolve().then(() => pieces.next()),
						idleMs,
						run,
					);
				} catch (error) {
					throw error instanceof CodeImportStop ? error : cut();
				}
				if (next.done) {
					ended = true;
					return;
				}
				yield next.value;
			}
		} finally {
			if (!ended) {
				call.abort();
				void Promise.resolve()
					.then(() => pieces.return?.())
					.catch(() => undefined);
			}
		}
	}

	/** A request whose answer is read whole: `type` is the answer's asked type. */
	async function answered(
		send: (signal: AbortSignal) => Promise<CodeImportAnswer>,
		type: "advertisement" | "result",
	): Promise<AsyncIterable<Uint8Array>> {
		const { answer, call } = await ask(send);
		const stop = codeImportAnswerStop(answer, type);
		if (stop) throw stopped(answer, call, stop);
		return read(answer, call);
	}

	try {
		await codeImportAdvertisement(await answered((s) => transport.refs(s), "advertisement"));
		for (let relisted = false; ; ) {
			const list = await codeImportRefList(
				await answered((s) => transport.uploadPack(codeImportLsRefsRequest(), s), "result"),
			);
			const wanted = codeImportWants(list, { branch });
			const header = codeImportBundleHeader(wanted.refs);
			const body = await answered((s) => transport.uploadPack(codeImportFetchRequest(wanted.wants), s), "result");
			// The pack's first bytes before anything is written: a want the source no longer has is said there, and the
			// writer is still empty for one more try.
			const pack = codeImportPack(body);
			let first: IteratorResult<Buffer>;
			try {
				first = await pack.next();
			} catch (error) {
				if (error instanceof CodeImportStop && error.notOurRef && !relisted) {
					relisted = true;
					continue;
				}
				throw error;
			}
			const rest = (async function* () {
				if (!first.done) yield first.value;
				yield* pack;
			})();
			const hash = createHash("sha256");
			let bytes = 0;
			try {
				for await (const piece of codeImportBundlePieces(header, rest, maximumBytes)) {
					hash.update(piece);
					bytes += piece.length;
					await writer.write(piece, run);
				}
			} finally {
				// Also a pack that was never read on (a header alone over the bound) lets its body go.
				void pack.return(undefined).catch(() => undefined);
			}
			return {
				sha256: hash.digest("hex"),
				bytes,
				defaultBranch: wanted.defaultBranch,
				mainSha: wanted.mainSha,
				refs: wanted.refs,
				leftOut: wanted.leftOut,
				// GitHub's own default, when the request named another branch: the refs plan keeps it whatever its age.
				...(wanted.sourceBranch === null ? {} : { sourceBranch: wanted.sourceBranch }),
			};
		}
	} catch (error) {
		if (signal.aborted) throw new CodeImportStop("busy", "IMPORT_STOPPED");
		if (deadline.aborted) throw new CodeImportStop("failed", "IMPORT_FETCH_TIMEOUT");
		throw error;
	} finally {
		for (const call of calls) call.abort();
	}
}
