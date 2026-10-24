// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { BANK_SUMMARY_MAX_BYTES, BankSummaryWriter } from "../../object-gateway/src/bank-summary-files.ts";
import { BANK_SUMMARY_PATH } from "../src/app/bank-page.ts";
import { BANK_SUMMARY_SCHEMA, parseBankSummary } from "../src/app/bank-summary.ts";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import { pagesOn } from "../src/app/interfaces.ts";
import { fixture, profileA, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

/* From the object gateway's writer to the Bank page's reader: a large, valid bank summary the writer publishes as
 * bank/summary.json is read whole by the page's folder reader (its `file:` limit) and parsed by the page's parser. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	vi.useRealTimers();
});

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const profileId = "92400000-0000-4000-8000-000000000010";

/** A summary near the page's bounds: two sections of 24 categories with 30 receivers each, names of 70 characters. */
function largeSummary() {
	const section = (side: string) =>
		Array.from({ length: 24 }, (_, category) => ({
			name: `${side} category ${category}`.padEnd(70, "."),
			total: 30 * 1250,
			items: Array.from({ length: 30 }, (_, item) => ({
				name: `${side} receiver ${category}-${item}`.padEnd(70, "."),
				rhythm: "monthly",
				next: "2026-11-01",
				amount: 1250,
			})),
		}));
	return {
		schema: BANK_SUMMARY_SCHEMA,
		bank: "Danske Bank",
		updatedAt: "2026-10-22T12:00:00Z",
		pausedSince: null,
		saldo: 282730,
		disponibel: 268410,
		reserveret: 14320,
		payTo: { reg: "0040", account: "0440116243" },
		history: [{ date: "2026-10-22", saldo: 282730 }],
		expected: [],
		months: [{ month: "2026-10", in: 900000, out: 900000 }],
		moneyIn: { month: "2026-10", categories: section("In") },
		moneyOut: { month: "2026-10", repeating: 900000, categories: section("Out"), later: [] },
	};
}

/** The writer, publishing one claim's summary; answers what it staged as the file's text. */
async function publish(summary: Record<string, unknown>): Promise<string> {
	let manifest = "";
	const staged = new Map<string, Uint8Array>();
	let written = "";
	const authority = {
		async publisher(method: string, args: Record<string, unknown>) {
			switch (method) {
				case "qorpera_claim_bank_summary_file":
					return {
						schema: "qorpera.bank-summary-claim/v1",
						profileId,
						environmentId: "92400000-0000-4000-8000-000000000020",
						generation: 1,
						attempt: 1,
						operationKey: `bank-summary:${profileId}:1:1`,
						folderPresent: true,
						currentVersion: null,
						summary,
						leaseUntil: "2026-10-22T12:01:00Z",
					};
				case "qorpera_folder_open_upload":
					manifest = args.p_manifest as string;
					return {
						schema: "qorpera.folder-upload/v1",
						intentId: "98300000-0000-4000-8000-0000000000f0",
						manifestSha256: digest(manifest),
						expiresAt: "x",
						present: [],
					};
				case "qorpera_folder_authorize_object_upload":
					return { schema: "qorpera.folder-object-upload/v1", profileId };
				case "qorpera_folder_confirm_object":
					return { schema: "qorpera.folder-object/v1", sha256: args.p_sha256, bytes: args.p_bytes };
				case "qorpera_folder_seal_upload": {
					const sealed = JSON.parse(manifest);
					return {
						schema: "qorpera.folder-seal/v1",
						state: "sealed",
						intentId: "98300000-0000-4000-8000-0000000000f0",
						file: {
							manifestSha256: digest(manifest),
							fileSha256: sealed.fileSha256,
							bytes: sealed.bytes,
							mediaType: sealed.mediaType,
							executable: sealed.executable,
						},
					};
				}
				case "qorpera_folder_commit": {
					const unit = (args.p_units as { file?: { fileSha256: string } }[])[0];
					if (unit?.file) written = new TextDecoder().decode(staged.get(unit.file.fileSha256));
					return { schema: "qorpera.folder-commit/v1", units: [{ unit: 1, outcome: "saved" }] };
				}
				case "qorpera_finish_bank_summary_file":
					return { schema: "qorpera.bank-summary-finish/v1", finished: true };
			}
			throw new Error(`unexpected ${method}`);
		},
	};
	const replication = {
		async uploadWithAuthority(
			_profile: string,
			hash: string,
			bytes: Uint8Array,
			callbacks: { authorize(): Promise<void>; confirm(): Promise<void> },
		) {
			await callbacks.authorize();
			staged.set(hash, bytes);
			await callbacks.confirm();
			return "stored" as const;
		},
	};
	const writer = new BankSummaryWriter({
		workerId: "98300000-0000-4000-8000-0000000000e1",
		authority: authority as never,
		store: { get: async () => new Uint8Array() },
		replication,
	});
	expect(await writer.writeOne()).toBe(true);
	return written;
}

it("reads a large valid summary the writer published, whole, through the page's reader and parser", async () => {
	const summary = largeSummary();
	expect(parseBankSummary(JSON.stringify(summary))).not.toBeNull();
	// Pretty-printed it would pass the page's limit; as the writer writes it, it fits.
	const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
	expect(bytes(JSON.stringify(summary, null, 2))).toBeGreaterThan(BANK_SUMMARY_MAX_BYTES);
	const text = await publish(summary);
	expect(bytes(text)).toBeLessThanOrEqual(BANK_SUMMARY_MAX_BYTES);

	// The page's folder reader, following a folder that holds the published file, as the app does.
	const fake = folderFake({ seed: [] });
	fake.put(BANK_SUMMARY_PATH, text);
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => controller.stop());
	const stop = new AbortController();
	cleanup.push(() => stop.abort());
	const reader = new CompanyInterfaceFolder(
		{
			signal: stop.signal,
			current: () => {},
			folder: () => fake.folder,
			folderHints: () => ({ close: async () => {} }),
		},
		(state) => controller.store.set({ interfaceFolder: state }),
	);
	reader.read(
		pagesOn({
			pages: [
				{ page: "mailbox", on: false },
				{ page: "members", on: false },
				{ page: "bank", on: true },
			],
			mayChange: true,
		}),
	);
	await reader.open();
	await vi.waitFor(() => expect(controller.store.get().interfaceFolder?.files.get(BANK_SUMMARY_PATH)).toBeDefined());
	const read = controller.store.get().interfaceFolder?.files.get(BANK_SUMMARY_PATH) as string;
	expect(read).toBe(text);
	const parsed = parseBankSummary(read);
	expect(parsed?.moneyIn.categories).toHaveLength(24);
	expect(parsed?.moneyOut.categories[23]?.items).toHaveLength(30);
	expect(parsed?.saldo).toBe(282730);
});
