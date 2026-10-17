import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { expect, it, vi } from "vitest";
import { CloudNativeToolBoundary, type CloudToolContent } from "../src/cloud-native-tool-boundary.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

// A folder image company_read shows (chat images PR3): the PNG it made goes to the model right after the envelope that
// cites its read, and comes back only with exactly that envelope.
const png = pngFile(pngHeader(1, 1, 8, 2), pngRows([[255, 0, 0]]));
const sha256 = createHash("sha256").update(png).digest("hex");

function fixture(options: { images?: boolean; content?: Partial<CloudToolContent> } = {}) {
	const content = {
		kind: "json",
		value: { path: "photos/red.png", kind: "image", imageSha256: sha256 },
		companyReadId: randomUUID(),
		image: { png, sha256 },
		...options.content,
	} as CloudToolContent;
	const execute = vi.fn(async () => content);
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: new AbortController().signal,
		assertActive: async () => undefined,
		tools: [
			{
				name: "company_read",
				source: "company_file",
				...(options.images === false ? {} : { images: true as const }),
				description: "Read the company folder.",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: (value) => value,
				execute,
			},
		],
	});
	const invoke = (callId = "read-1") => boundary.invoke(callId, "qorpera", "company_read", {});
	const input = (text: string, image = sha256, callId = "read-1") => ({
		kind: "function_call_output" as const,
		callId,
		output: [
			{ type: "input_text", text },
			{ type: "input_image", sha256: image },
		] as JsonValue,
	});
	return { boundary, execute, invoke, input };
}

it("shows a tool's image after the envelope citing its read, and fences it back with that envelope", async () => {
	const f = fixture();
	// A session with a tool that shows images carries images, with no screenshots.
	expect(f.boundary.captureImagesEnabled).toBe(true);
	const result = await f.invoke();
	expect(result.success).toBe(true);
	expect(result.contentItems).toHaveLength(2);
	expect(result.contentItems[1]).toEqual({
		type: "inputImage",
		imageUrl: `data:image/png;base64,${png.toString("base64")}`,
	});
	const text = result.contentItems[0].text;
	expect(JSON.parse(text)).toMatchObject({ status: "ok", provenance: { tool: "company_read" } });
	const fenced = [{ kind: "function_call_output", callId: "read-1", output: text, imageSha256: sha256 }];
	expect(await f.boundary.fenceNativeResults([f.input(text)])).toEqual(fenced);
	// A replay answers from the call, and compaction may send the same result again.
	expect(await f.invoke()).toEqual(result);
	expect(await f.boundary.fenceNativeResults([f.input(text)])).toEqual(fenced);
	expect(f.execute).toHaveBeenCalledTimes(1);
});

it.each([
	["hash", "Native image not issued"],
	["missing", "Native image not issued"],
	["envelope", "Native captures unavailable"],
	["call", "Native captures unavailable"],
])("rejects %s substitution before native release", async (fault, error) => {
	const f = fixture();
	const text = (await f.invoke()).contentItems[0].text;
	const input =
		fault === "hash"
			? f.input(text, "a".repeat(64))
			: fault === "missing"
				? { ...f.input(text), output: [{ type: "input_text", text }] }
				: fault === "envelope"
					? f.input(`${text} `)
					: f.input(text, sha256, "read-2");
	await expect(f.boundary.fenceNativeResults([input])).rejects.toThrow(error);
});

const unshown: [string, Parameters<typeof fixture>[0]][] = [
	["a tool that shows no images", { images: false }],
	["an answer citing no read", { content: { companyReadId: undefined } }],
	["another image's hash", { content: { image: { png, sha256: "a".repeat(64) } } }],
	["an image larger than the fence takes", { content: { image: oversized() } }],
];

it.each(unshown)("never shows an image from %s", async (_, options = {}) => {
	const f = fixture(options);
	const result = await f.invoke();
	expect(result.contentItems).toHaveLength(1);
	expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
		status: "unconfirmed",
		content: { text: "TOOL_OUTCOME_UNCONFIRMED" },
	});
	if (options.images === false) expect(f.boundary.captureImagesEnabled).toBe(false);
});

function oversized(): { png: Buffer; sha256: string } {
	const large = Buffer.alloc(8 * 1024 * 1024 + 1);
	return { png: large, sha256: createHash("sha256").update(large).digest("hex") };
}
