import { createHash, randomUUID } from "node:crypto";
import { DigitalPostAnswerTooLarge, DigitalPostKeyRefused } from "@qorpera/runtime/cloud-connector-digital-post";
import { ConnectorRequestError } from "@qorpera/runtime/cloud-connector-http";
import {
	CloudDigitalPostSyncs,
	DIGITAL_POST_CHUNK_BYTES,
	type DigitalPostSyncAuthority,
} from "@qorpera/runtime/cloud-digital-post-sync";
import { expect, it, vi } from "vitest";

/* The vault's Digital Post sync (cloud-digital-post-sync.ts): claim, open the key, list, and for each letter fetch,
 * read, keep, stage, seal and only then receipt; hold what cannot be read; record the pass. */

const NOW = new Date("2026-10-22T06:00:00.000Z");
const signal = new AbortController().signal;
const envelope = Buffer.from("sealed envelope bytes");
const SYSTEM = "e545b339-8542-4a30-ae75-c67e4d2a7b99";
const KEY = Buffer.from(`${SYSTEM}:15632a8d-407c-4c3a-b7b1-aebaa514fcab`).toString("base64");

function claim(overrides: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.digital-post-sync-claim/v1",
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		secretVersion: 1,
		lease: "0c0c0c0c-0000-4000-8000-00000000c1a1",
		keyId: "k1",
		encryptedEnvelopeBase64: envelope.toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		held: [],
		scanPage: 0,
		...overrides,
	};
}

/** A small letter as Digital Post delivers it, with a main document of `size` bytes. */
function letter(message: string, size = 16): Uint8Array {
	const pdf = Buffer.alloc(size, 7).toString("base64");
	return new Uint8Array(
		Buffer.from(`<memo:Message xmlns:memo="https://DigitalPost.dk/MeMo-1" memoVersion="1.2">
	<memo:MessageHeader>
		<memo:messageType>DIGITALPOST</memo:messageType>
		<memo:messageUUID>${message}</memo:messageUUID>
		<memo:label>Årsopgørelse</memo:label>
		<memo:Sender><memo:senderID>19552101</memo:senderID><memo:idType>CVR</memo:idType><memo:label>Skattestyrelsen</memo:label></memo:Sender>
		<memo:Recipient><memo:recipientID>12345678</memo:recipientID><memo:idType>CVR</memo:idType></memo:Recipient>
	</memo:MessageHeader>
	<memo:MessageBody>
		<memo:createdDateTime>2026-10-21T23:30:00Z</memo:createdDateTime>
		<memo:MainDocument><memo:File><memo:encodingFormat>application/pdf</memo:encodingFormat><memo:filename>brev.pdf</memo:filename><memo:content>${pdf}</memo:content></memo:File></memo:MainDocument>
	</memo:MessageBody>
</memo:Message>`),
	);
}

const MEMO_A = "0a000000-0000-4000-8000-00000000000a";
const MEMO_B = "0a000000-0000-4000-8000-00000000000b";
const MESSAGE_A = "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a";
const MESSAGE_B = "7a000000-0000-4000-8000-00000000000b";

function fixture(
	options: {
		claim?: unknown;
		ids?: string[];
		complete?: boolean;
		letters?: Record<string, Uint8Array | null>;
		kept?: Record<string, "staging" | "kept">;
		fields?: Record<string, string>;
		listError?: Error;
		keepError?: Error;
		/** Digital Post's list page by page; without it, every page answers `ids` and `complete`. */
		pages?: { ids: string[]; complete: boolean }[];
		letterErrors?: Record<string, Error>;
	} = {},
) {
	const log: string[] = [];
	const finished: Parameters<DigitalPostSyncAuthority["finishDigitalPostSync"]>[0][] = [];
	const kept: Parameters<DigitalPostSyncAuthority["keepDigitalPostLetter"]>[0][] = [];
	const chunks: Parameters<DigitalPostSyncAuthority["stageDigitalPostChunk"]>[0][] = [];
	const held: Parameters<DigitalPostSyncAuthority["holdDigitalPostLetter"]>[0][] = [];
	const letterIds = new Map<string, string>();
	const authority: DigitalPostSyncAuthority = {
		claimDigitalPostSync: vi.fn(async () =>
			typeof options.claim === "function" ? options.claim() : options.claim === undefined ? claim() : options.claim,
		),
		keepDigitalPostLetter: vi.fn(async (input) => {
			if (options.keepError) throw options.keepError;
			kept.push(input);
			log.push(`keep ${input.memoId}`);
			const letterId = letterIds.get(input.summary.messageUuid) ?? randomUUID();
			letterIds.set(input.summary.messageUuid, letterId);
			return {
				schema: "qorpera.digital-post-letter-kept/v1",
				letterId,
				state: options.kept?.[input.summary.messageUuid] ?? "staging",
			};
		}),
		stageDigitalPostChunk: vi.fn(async (input) => {
			chunks.push({ ...input, content: new Uint8Array(input.content) });
			log.push(`stage ${input.fileIndex}/${input.chunkIndex}`);
			return { schema: "qorpera.digital-post-chunk/v1", staged: true };
		}),
		sealDigitalPostLetter: vi.fn(async (input) => {
			log.push("seal");
			return { schema: "qorpera.digital-post-letter-kept/v1", letterId: input.letterId, state: "kept" };
		}),
		holdDigitalPostLetter: vi.fn(async (input) => {
			held.push(input);
			log.push(`hold ${input.memoId}`);
			return { schema: "qorpera.digital-post-held/v1", held: true };
		}),
		finishDigitalPostSync: vi.fn(async (input) => {
			finished.push(input);
			return { schema: "qorpera.digital-post-sync-result/v1" };
		}),
	};
	const opened: unknown[] = [];
	const keyring = {
		use: vi.fn(
			async (
				bytes: Uint8Array,
				identity: unknown,
				callback: (fields: Record<string, string>) => Promise<unknown>,
			) => {
				opened.push({ bytes: Buffer.from(bytes).toString(), identity });
				return callback(options.fields ?? { api_key: KEY });
			},
		),
	};
	const letters = options.letters ?? { [MEMO_A]: letter(MESSAGE_A) };
	const post = {
		available: vi.fn(async (key: { authorization: string }, _signal: AbortSignal, page = 0) => {
			expect(key.authorization).toBe(`Basic ${KEY}`);
			if (options.listError) throw options.listError;
			log.push(page === 0 ? "list" : `list ${page}`);
			if (options.pages) return options.pages[page] ?? { ids: [], complete: true };
			return { ids: options.ids ?? Object.keys(letters), complete: options.complete ?? true };
		}),
		letter: vi.fn(async (_key: unknown, id: string) => {
			log.push(`fetch ${id}`);
			const error = options.letterErrors?.[id];
			if (error) throw error;
			return letters[id] ?? null;
		}),
		receipt: vi.fn(async (_key: unknown, id: string, message: string) => {
			log.push(`receipt ${id} ${message}`);
			return "receipted" as const;
		}),
	};
	// The keyring's real `use` is generic in its callback's answer; the fake answers whatever the callback does.
	const syncs = new CloudDigitalPostSyncs({ authority, keyring: keyring as never, post, now: () => NOW });
	return { syncs, authority, keyring, post, log, finished, kept, chunks, held, opened, letterIds };
}

it("is idle when nothing is due and refuses a claim it cannot read", async () => {
	expect(await fixture({ claim: null }).syncs.pass(signal)).toBe("idle");
	await expect(fixture({ claim: { ...claim(), extra: 1 } }).syncs.pass(signal)).rejects.toThrow(
		"Digital Post sync claim is invalid",
	);
	await expect(fixture({ claim: claim({ held: ["not-a-uuid"] }) }).syncs.pass(signal)).rejects.toThrow(
		"Digital Post sync claim is invalid",
	);
});

it("keeps, stages and seals a letter before its receipt, and records the pass", async () => {
	const f = fixture({ letters: { [MEMO_A]: letter(MESSAGE_A, DIGITAL_POST_CHUNK_BYTES + 5) } });
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.log).toEqual([
		"list",
		`fetch ${MEMO_A}`,
		`keep ${MEMO_A}`,
		"stage 0/0",
		"stage 1/0",
		"stage 2/0",
		"stage 2/1",
		"seal",
		`receipt ${MEMO_A} ${MESSAGE_A}`,
	]);
	const [keep] = f.kept;
	expect(keep?.summary).toMatchObject({
		messageUuid: MESSAGE_A,
		folder: `digital-post/2026/2026-10-22 Skattestyrelsen - Årsopgørelse (${MESSAGE_A})`,
		sender: "Skattestyrelsen",
	});
	expect(keep?.files.map((file) => [file.name, file.bytes])).toEqual([
		["letter.md", expect.any(Number)],
		["letter.json", expect.any(Number)],
		["brev.pdf", DIGITAL_POST_CHUNK_BYTES + 5],
	]);
	expect(f.chunks.filter((chunk) => chunk.fileIndex === 2).map((chunk) => chunk.content.byteLength)).toEqual([
		DIGITAL_POST_CHUNK_BYTES,
		5,
	]);
	const letterId = f.letterIds.get(MESSAGE_A);
	expect(f.finished).toEqual([
		{
			secretId: expect.any(String),
			version: 1,
			lease: "0c0c0c0c-0000-4000-8000-00000000c1a1",
			outcome: "current",
			systemId: SYSTEM,
			receipted: [letterId],
			scanPage: 0,
			error: null,
		},
	]);
	const identity = (f.opened[0] as { identity: Record<string, unknown> }).identity;
	expect(Object.keys(identity).sort()).toEqual(["companyId", "environmentId", "keyId", "secretId", "version"]);
});

it("receipts a letter already kept without staging it again, skips held and gone letters", async () => {
	const gone = "0a000000-0000-4000-8000-0000000000ff";
	const held = "0a000000-0000-4000-8000-0000000000ee";
	const f = fixture({
		claim: claim({ held: [held] }),
		ids: [held, MEMO_A, gone],
		letters: { [MEMO_A]: letter(MESSAGE_A), [gone]: null, [held]: letter(MESSAGE_B) },
		kept: { [MESSAGE_A]: "kept" },
	});
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.log).toEqual([
		"list",
		`fetch ${MEMO_A}`,
		`keep ${MEMO_A}`,
		`receipt ${MEMO_A} ${MESSAGE_A}`,
		`fetch ${gone}`,
	]);
	expect(f.finished[0]?.receipted).toEqual([f.letterIds.get(MESSAGE_A)]);
});

it("holds a letter it cannot read or keep whole, without a receipt", async () => {
	const big = "0a000000-0000-4000-8000-0000000000bb";
	const f = fixture({
		letters: {
			[MEMO_A]: new Uint8Array(Buffer.from("<memo:Message>not closed")),
			[MEMO_B]: letter(MESSAGE_B),
			[big]: letter("6f000000-0000-4000-8000-0000000000bb", 25 * 1024 * 1024),
		},
	});
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.held.map((entry) => [entry.memoId, entry.reason])).toEqual([
		[MEMO_A, "the letter's XML is malformed"],
		[big, "the letter is too large"],
	]);
	expect(f.post.receipt).toHaveBeenCalledTimes(1);
	expect(f.post.receipt).toHaveBeenCalledWith(expect.anything(), MEMO_B, MESSAGE_B, NOW, expect.anything());
});

it("holds a letter Digital Post answers larger than Qorpera keeps, and takes the next one", async () => {
	const f = fixture({
		letters: { [MEMO_A]: letter(MESSAGE_A), [MEMO_B]: letter(MESSAGE_B) },
		letterErrors: { [MEMO_A]: new DigitalPostAnswerTooLarge() },
	});
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.held.map((entry) => [entry.memoId, entry.reason])).toEqual([
		[MEMO_A, "the letter is too large for Qorpera"],
	]);
	expect(f.post.receipt).toHaveBeenCalledExactlyOnceWith(expect.anything(), MEMO_B, MESSAGE_B, NOW, expect.anything());
});

it("reads past a page of held letters to the letters after them", async () => {
	const held = Array.from({ length: 50 }, (_, index) => `0b000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
	const f = fixture({
		claim: claim({ held }),
		pages: [
			{ ids: held, complete: false },
			{ ids: [MEMO_B], complete: true },
		],
		letters: { [MEMO_B]: letter(MESSAGE_B) },
	});
	expect(await f.syncs.pass(signal)).toBe("current");
	expect(f.log.filter((line) => line.startsWith("list"))).toEqual(["list", "list 1"]);
	expect(f.post.letter).toHaveBeenCalledTimes(1);
	expect(f.finished[0]).toMatchObject({ receipted: [f.letterIds.get(MESSAGE_B)], scanPage: 0 });
	// A receipt shifts the pages after it: a pass that took a letter on a page that was not the last stops there, and
	// the next pass reads that page again.
	const more = fixture({
		pages: [
			{ ids: [MEMO_A], complete: false },
			{ ids: [MEMO_B], complete: true },
		],
		letters: { [MEMO_A]: letter(MESSAGE_A), [MEMO_B]: letter(MESSAGE_B) },
	});
	expect(await more.syncs.pass(signal)).toBe("more");
	expect(more.log.filter((line) => line.startsWith("list"))).toEqual(["list"]);
	expect(more.finished[0]).toMatchObject({ outcome: "more", scanPage: 0 });
	const later = fixture({ claim: claim({ scanPage: 7 }), pages: [], letters: {} });
	expect(await later.syncs.pass(signal)).toBe("current");
	expect(later.post.available).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), 7);
});

it("reaches a letter behind two thousand unreadable ones over passes, with the claim's held list capped", async () => {
	// Digital Post's list: 2000 letters the vault cannot read, then one it can (page 40). The database keeps every hold
	// but its claim lists only the newest 1000, as qorpera_claim_digital_post_sync does, and keeps the scan page.
	const bad = Array.from({ length: 2000 }, (_, index) => `0d000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
	const pages = [
		...Array.from({ length: 40 }, (_, page) => ({ ids: bad.slice(page * 50, page * 50 + 50), complete: false })),
		{ ids: [MEMO_B], complete: true },
	];
	const holds: string[] = [];
	let scanPage = 0;
	const malformed = new Uint8Array(Buffer.from("<memo:Message>not closed"));
	const f = fixture({
		claim: () => claim({ held: [...new Set(holds)].slice(-1000), scanPage }),
		pages,
		letters: { ...Object.fromEntries(bad.map((id) => [id, malformed])), [MEMO_B]: letter(MESSAGE_B) },
	});
	f.authority.holdDigitalPostLetter = vi.fn(async (input) => {
		holds.push(input.memoId);
		return { schema: "qorpera.digital-post-held/v1", held: true };
	});
	f.authority.finishDigitalPostSync = vi.fn(async (input) => {
		f.finished.push(input);
		scanPage = input.scanPage;
		return { schema: "qorpera.digital-post-sync-result/v1" };
	});
	const outcomes: string[] = [];
	for (let pass = 0; pass < 5 && !f.post.receipt.mock.calls.length; pass += 1)
		outcomes.push(await f.syncs.pass(signal));
	expect(outcomes).toEqual(["more", "more", "current"]);
	expect(f.finished.map((finish) => finish.scanPage)).toEqual([20, 40, 0]);
	expect(f.post.receipt).toHaveBeenCalledExactlyOnceWith(expect.anything(), MEMO_B, MESSAGE_B, NOW, expect.anything());
});

it("asks for more at once when the list was full and it took a letter, or when it read its pages", async () => {
	const took = fixture({ complete: false });
	expect(await took.syncs.pass(signal)).toBe("more");
	expect(took.finished[0]?.scanPage).toBe(0);
	// A list that never ends is read for twenty pages; the next pass reads on from there.
	const allHeld = fixture({ complete: false, claim: claim({ held: [MEMO_A], scanPage: 3 }) });
	expect(await allHeld.syncs.pass(signal)).toBe("more");
	expect(allHeld.post.available).toHaveBeenCalledTimes(20);
	expect(allHeld.finished[0]).toMatchObject({ outcome: "more", scanPage: 23 });
});

it("stops on a refused key, and on a key that is not one", async () => {
	const refused = fixture({ listError: new DigitalPostKeyRefused() });
	expect(await refused.syncs.pass(signal)).toBe("refused");
	expect(refused.finished[0]).toMatchObject({
		outcome: "refused",
		error: "Digital Post refused the company's key; connect Digital Post again",
		receipted: [],
	});
	const notAKey = fixture({ fields: { api_key: "nope" } });
	expect(await notAKey.syncs.pass(signal)).toBe("refused");
	expect(notAKey.post.available).not.toHaveBeenCalled();
	expect(notAKey.finished[0]?.systemId).toBeNull();
});

it("records a failure as a fixed phrase and sends no receipt for a letter it did not keep", async () => {
	const forbidden = fixture({ listError: new ConnectorRequestError("forbidden", "secret detail") });
	expect(await forbidden.syncs.pass(signal)).toBe("failed");
	expect(forbidden.finished[0]?.error).toBe(
		"Digital Post refused the call: check the system's IP addresses and that its supplier is Qorpera's CVR",
	);
	const database = fixture({ keepError: new Error("connection reset with secret detail") });
	expect(await database.syncs.pass(signal)).toBe("failed");
	expect(database.finished[0]).toMatchObject({ outcome: "failed", error: "the letters could not be fetched or kept" });
	expect(database.post.receipt).not.toHaveBeenCalled();
	const digest = fixture({ claim: claim({ envelopeSha256: "0".repeat(64) }) });
	expect(await digest.syncs.pass(signal)).toBe("failed");
	expect(digest.finished[0]?.error).toBe("the envelope digest differs");
	expect(digest.keyring.use).not.toHaveBeenCalled();
	for (const f of [forbidden, database, digest]) expect(JSON.stringify(f.finished)).not.toContain("secret detail");
});
