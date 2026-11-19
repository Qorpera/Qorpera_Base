import { randomUUID } from "node:crypto";
import { CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES, parseCloudCodingCommandReceipt } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { CLOUD_COMMAND_PAGE_ASK, cloudCommandFits, fitCloudCommandPage } from "../src/cloud-command-page-fit.ts";
import { CLOUD_COMMAND_PAGE_HEADER, CloudCommandPages } from "../src/cloud-command-pages.ts";
import { MAX_CLOUD_TOOL_RESULT_BYTES } from "../src/cloud-native-tool-boundary.ts";

/** A page of `output` at `offset` of a log of `totalBytes`, its cursor counted in the output's own bytes. */
function page(output: string, offset = 0, totalBytes = 200_000, state = "running") {
	return parseCloudCodingCommandReceipt({
		schema: "qorpera.coding-command-result/v2",
		workerId: randomUUID(),
		commandId: randomUUID(),
		inputSha256: "a".repeat(64),
		state,
		exitCode: state === "succeeded" ? 0 : null,
		output,
		truncated: offset + Buffer.byteLength(output) < totalBytes,
		log: {
			offset,
			nextOffset: offset + Buffer.byteLength(output),
			totalBytes,
			limitBytes: 67108864,
			limitReached: false,
		},
	});
}
/** A build log's lines: plain text with a line break each, as most command output is. */
const lines = (bytes: number) => {
	let text = "";
	for (let n = 0; Buffer.byteLength(text) < bytes; n++)
		text += `[${String(n).padStart(5, "0")}] compiled src/module-${n}.ts in 12 ms "ok"\n`;
	return text.slice(0, bytes);
};

describe("a command's page fitted to one result (keyholes S1)", () => {
	it("asks for one result's room by default", () => {
		expect(CLOUD_COMMAND_PAGE_ASK).toBeGreaterThan(31_000);
		expect(CLOUD_COMMAND_PAGE_ASK).toBeLessThan(MAX_CLOUD_TOOL_RESULT_BYTES);
	});

	it("keeps a page that fits as it is", () => {
		const small = page(lines(20_000), 0, 20_000, "succeeded");
		expect(fitCloudCommandPage(small, false, cloudCommandFits)).toEqual({ page: small });
	});

	it("cuts a page read from an offset at its end, in one go, with the cursor where the shown part ends", () => {
		const log = lines(64_000);
		const asked = page(log.slice(0, 40_000), 1000);
		const fitted = fitCloudCommandPage(asked, false, cloudCommandFits);
		if (!fitted || !("page" in fitted)) throw new Error("not fitted");
		const shown = fitted.page;
		expect(cloudCommandFits(shown)).toBe(true);
		expect(log.startsWith(shown.output)).toBe(true);
		// These lines fill the result with about 27 KB (their quotes and line breaks escape to several bytes each).
		expect(Buffer.byteLength(shown.output)).toBeGreaterThan(26_000);
		// One character more would not fit.
		expect(
			cloudCommandFits({
				...shown,
				output: log.slice(0, shown.output.length + 1),
				log: { ...shown.log, nextOffset: shown.log.nextOffset + 1 },
			}),
		).toBe(false);
		expect(shown.log).toEqual({ ...asked.log, nextOffset: 1000 + Buffer.byteLength(shown.output) });
		expect(shown.truncated).toBe(true);
		expect(parseCloudCodingCommandReceipt(shown)).toEqual(shown);
	});

	it("shows about 31 KB of output without characters to escape", () => {
		const fitted = fitCloudCommandPage(page("abcdefghij".repeat(6000)), false, cloudCommandFits);
		if (!fitted || !("page" in fitted)) throw new Error("not fitted");
		expect(Buffer.byteLength(fitted.page.output)).toBeGreaterThan(31_000);
	});

	it("cuts a tail at its start, with the offset where the shown part begins", () => {
		const log = lines(40_000);
		const asked = page(log, 60_000, 100_000);
		const fitted = fitCloudCommandPage(asked, true, cloudCommandFits);
		if (!fitted || !("page" in fitted)) throw new Error("not fitted");
		const shown = fitted.page;
		expect(cloudCommandFits(shown)).toBe(true);
		expect(log.endsWith(shown.output)).toBe(true);
		expect(shown.log).toEqual({ ...asked.log, offset: 100_000 - Buffer.byteLength(shown.output) });
		expect(shown.truncated).toBe(false);
		expect(parseCloudCodingCommandReceipt(shown)).toEqual(shown);
	});

	it("cuts between characters, never inside one", () => {
		const asked = page("æøå 🙂 ".repeat(4000));
		const fitted = fitCloudCommandPage(asked, false, cloudCommandFits);
		if (!fitted || !("page" in fitted)) throw new Error("not fitted");
		expect(asked.output.startsWith(fitted.page.output)).toBe(true);
		expect(Buffer.from(fitted.page.output).toString("utf8")).toBe(fitted.page.output);
		expect(fitted.page.log.nextOffset).toBe(Buffer.byteLength(fitted.page.output));
	});

	it("counts the cursor from the side without U+FFFD, and asks for exactly what fits when both sides hold one", () => {
		const plain = lines(40_000);
		// Only the part left out holds one: the cursor is counted from the part shown.
		const late = page(`${plain}\uFFFD`);
		const fittedLate = fitCloudCommandPage(late, false, cloudCommandFits);
		if (!fittedLate || !("page" in fittedLate)) throw new Error("not fitted");
		expect(fittedLate.page.log.nextOffset).toBe(Buffer.byteLength(fittedLate.page.output));
		// Only the part shown holds one: counted back from the page's own end.
		const early = page(`\uFFFD${plain}`, 10);
		const fittedEarly = fitCloudCommandPage(early, false, cloudCommandFits);
		if (!fittedEarly || !("page" in fittedEarly)) throw new Error("not fitted");
		const leftOut = early.output.slice(fittedEarly.page.output.length);
		expect(fittedEarly.page.log.nextOffset).toBe(early.log.nextOffset - Buffer.byteLength(leftOut));
		// Both: the page cannot tell, so the read asks again for the bytes that fit.
		const both = page(`\uFFFD${plain}\uFFFD`);
		const asked = fitCloudCommandPage(both, false, cloudCommandFits);
		expect(asked).toEqual({ ask: expect.any(Number) });
		const ask = (asked as { ask: number }).ask;
		expect(ask).toBeLessThan(Buffer.byteLength(both.output));
		// The page of exactly that many bytes fits whole.
		const exact = page(Buffer.from(both.output).subarray(0, ask).toString("utf8"));
		expect(fitCloudCommandPage(exact, false, cloudCommandFits)).toEqual({ page: exact });
	});

	it("shows no output, with the cursor at the page's start, when nothing else fits, and nothing when even that does not", () => {
		const asked = page("x".repeat(60_000), 5);
		const none = fitCloudCommandPage(asked, false, () => false);
		expect(none).toBeNull();
		const empty = fitCloudCommandPage(asked, false, (shown) => shown.output === "");
		expect(empty).toEqual({ page: { ...asked, output: "", log: { ...asked.log, nextOffset: 5 }, truncated: true } });
	});

	it("does not fit a value whose JSON is past a tool JSON's own bound", () => {
		expect(cloudCommandFits({ output: "\u0001".repeat(40_000) })).toBe(false);
	});
});

describe("what an executor said it takes for a page (keyholes S1)", () => {
	const said = (value?: string) => new Headers(value === undefined ? {} : { [CLOUD_COMMAND_PAGE_HEADER]: value });
	it("is the legacy 16,384 until it says more, and again when an answer says nothing", () => {
		const pages = new CloudCommandPages();
		expect(pages.of("https://a.example")).toBe(CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES);
		pages.heard("https://a.example", said("65536"));
		expect(pages.of("https://a.example")).toBe(65536);
		expect(pages.of("https://b.example")).toBe(CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES);
		pages.heard("https://a.example", said());
		expect(pages.of("https://a.example")).toBe(CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES);
	});
	it("takes no more than the contract's page, less when it says less, and nothing that is not a number", () => {
		const pages = new CloudCommandPages();
		pages.heard("o", said("1048576"));
		expect(pages.of("o")).toBe(65536);
		pages.heard("o", said("8192"));
		expect(pages.of("o")).toBe(8192);
		for (const value of ["", "-1", "3", "64k", "0x10000", "1e5", "65 536"]) {
			pages.heard("o", said(value));
			expect(pages.of("o")).toBe(CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES);
		}
	});
});
