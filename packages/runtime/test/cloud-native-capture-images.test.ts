import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { CloudNativeCaptureImages } from "../src/cloud-native-capture-images.ts";
import { startCloudNativeResultFence } from "../src/cloud-native-result-fence.ts";
import { CloudNativeToolBoundary, type CloudToolContent } from "../src/cloud-native-tool-boundary.ts";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const asset = {
	assetId: randomUUID(),
	screenId: randomUUID(),
	sha256: createHash("sha256").update(png).digest("hex"),
	bytes: png.length,
	mediaType: "image/png" as const,
	width: 1,
	height: 1,
	surface: "browser" as const,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function fixture(content: CloudToolContent = { kind: "json", value: asset }, images = true) {
	const abort = new AbortController();
	const reader = { read: vi.fn(async () => Uint8Array.from(png)), assertReadable: vi.fn(async () => undefined) };
	const captures = new CloudNativeCaptureImages(reader);
	const execute = vi.fn(async () => content);
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		captures: images ? captures : undefined,
		assertActive: async () => undefined,
		tools: [
			{
				name: "computer_screenshot",
				source: "runtime",
				description: "Capture an authorized browser.",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: (value) => value,
				execute,
			},
		],
	});
	const invoke = (callId = "capture-1") => boundary.invoke(callId, "qorpera", "computer_screenshot", {});
	const input = (text: string, sha256 = asset.sha256, callId = "capture-1") => ({
		kind: "function_call_output" as const,
		callId,
		output: [
			{ type: "input_text", text },
			{ type: "input_image", sha256 },
		] as JsonValue,
	});
	return { abort, captures, reader, boundary, execute, invoke, input };
}

it("delivers exact pixels with their issued envelope and rechecks replay without reexecution", async () => {
	const f = fixture();
	const result = await f.invoke();
	expect(result.success).toBe(true);
	expect(result.contentItems[1]).toEqual({
		type: "inputImage",
		imageUrl: `data:image/png;base64,${png.toString("base64")}`,
	});
	const text = result.contentItems[0].text;
	expect(await f.boundary.fenceNativeResults([f.input(text)])).toEqual([
		{ kind: "function_call_output", callId: "capture-1", output: text, imageSha256: asset.sha256, capture: asset },
	]);
	expect(await f.invoke()).toEqual(result);
	expect(await f.boundary.fenceNativeResults([f.input(text)])).toEqual([
		{ kind: "function_call_output", callId: "capture-1", output: text, imageSha256: asset.sha256, capture: asset },
	]);
	expect(f.reader.read).toHaveBeenCalledTimes(1);
	expect(f.execute).toHaveBeenCalledTimes(1);
	expect(f.reader.assertReadable).toHaveBeenCalledTimes(4);
});

it("does not execute a screenshot when the native image adapter is unavailable", async () => {
	const f = fixture(undefined, false);
	const result = await f.invoke();
	expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
		status: "denied",
		content: { text: "TOOL_UNAVAILABLE" },
	});
	expect(f.execute).not.toHaveBeenCalled();
});

it.each<JsonValue>([
	{
		screenId: asset.screenId,
		surface: "desktop",
		completed: false,
		heldBack: { code: "COMPANY_FOLDER_HELD_BACK", message: "held back" },
	},
	{ completed: false, refused: { code: "COMPANY_FOLDER_UNAVAILABLE", message: "given back" } },
])("issues no picture for a screenshot the company folder held back or gave back (F3 4d): %j", async (value) => {
	const f = fixture({ kind: "json", value });
	const result = await f.invoke();
	expect(result.success).toBe(true);
	expect(result.contentItems).toHaveLength(1);
	const envelope = JSON.parse(result.contentItems[0].text);
	expect(envelope.status).toBe("ok");
	expect(JSON.parse(envelope.content.text)).toEqual(value);
	expect(f.reader.read).not.toHaveBeenCalled();
	expect(await f.boundary.fenceNativeResults([])).toEqual([]);
});

it.each(["hash", "envelope", "call", "missing"])("rejects %s substitution before native release", async (fault) => {
	const f = fixture();
	const result = await f.invoke();
	const input = f.input(result.contentItems[0].text);
	if (fault === "hash")
		input.output = [
			{ type: "input_text", text: result.contentItems[0].text },
			{ type: "input_image", sha256: "a".repeat(64) },
		];
	if (fault === "envelope")
		input.output = [
			{ type: "input_text", text: `${result.contentItems[0].text} ` },
			{ type: "input_image", sha256: asset.sha256 },
		];
	if (fault === "call") input.callId = "different-call";
	if (fault === "missing") input.output = result.contentItems[0].text;
	await expect(f.boundary.fenceNativeResults([input])).rejects.toThrow("NATIVE_CAPTURE_NOT_ISSUED");
});

it("checks capture authority after compaction removes the original output", async () => {
	const f = fixture();
	await f.invoke();
	expect(await f.boundary.fenceNativeResults([])).toEqual([]);
	f.reader.assertReadable.mockRejectedValue(new Error("private revoked grant"));
	await expect(f.boundary.fenceNativeResults([])).rejects.toThrow("private revoked grant");
	const replay = await f.invoke();
	expect(replay.contentItems).toHaveLength(1);
	expect(JSON.parse(replay.contentItems[0].text)).toMatchObject({
		status: "denied",
		content: { text: "AUTHORITY_UNAVAILABLE" },
	});
	expect(f.execute).toHaveBeenCalledTimes(1);
});

it("preserves all text items when a native result has no image", async () => {
	const f = fixture();
	const output = [
		{ type: "input_text", text: "first untrusted item" },
		{ type: "input_text", text: "second untrusted item" },
	];
	const results = await f.boundary.fenceNativeResults([{ kind: "function_call_output", callId: "text-only", output }]);
	const envelope = JSON.parse(results[0].output);
	expect(envelope.status).toBe("unconfirmed");
	expect(JSON.parse(envelope.content.text)).toEqual(output);
	expect(f.reader.read).not.toHaveBeenCalled();
});

const malformedImageOutputs: JsonValue[] = [
	[{ type: "input_image", sha256: asset.sha256 }],
	[
		{ type: "input_image", sha256: asset.sha256 },
		{ type: "input_text", text: "envelope" },
	],
	[
		{ type: "input_text", text: "envelope" },
		{ type: "input_image", sha256: asset.sha256 },
		{ type: "input_text", text: "extra" },
	],
];
it.each(malformedImageOutputs.map((output) => ({ output })))(
	"rejects malformed image item ordering %j",
	async ({ output }) => {
		const f = fixture();
		await expect(
			f.boundary.fenceNativeResults([{ kind: "function_call_output", callId: "bad-image", output }]),
		).rejects.toThrow("Invalid native capture content");
	},
);

it.each(["read", "digest", "abort"])(
	"withholds pixels on %s failure and never repeats the screenshot",
	async (fault) => {
		const f = fixture();
		if (fault === "read") f.reader.read.mockRejectedValue(new Error("private storage failure"));
		if (fault === "digest") f.reader.read.mockResolvedValue(new Uint8Array(png.length));
		if (fault === "abort")
			f.reader.read.mockImplementation(async () => {
				f.abort.abort();
				return png;
			});
		const first = await f.invoke();
		const second = await f.invoke();
		expect(first).toEqual(second);
		expect(first.success).toBe(false);
		expect(first.contentItems).toHaveLength(1);
		expect(JSON.stringify(first)).not.toContain("private storage failure");
		expect(f.execute).toHaveBeenCalledTimes(1);
		expect(f.reader.read).toHaveBeenCalledTimes(1);
	},
);

it.each([
	{ ...asset, url: "https://untrusted.invalid" },
	{ ...asset, width: 1921 },
	{ ...asset, bytes: 8388609 },
	{ ...asset, sha256: "not-a-digest" },
])("rejects malformed capture references before storage: %j", async (value) => {
	const f = fixture({ kind: "json", value });
	expect((await f.invoke()).success).toBe(false);
	expect(f.reader.read).not.toHaveBeenCalled();
});

it("issues screenshots past the old per-run bound without retaining a second pixel cache", async () => {
	// Runtime v92: a run used to fail after 128 screenshots or 128 MiB of them.
	const pixels = Buffer.alloc(8 * 1024 * 1024);
	const large = { ...asset, bytes: pixels.length, sha256: createHash("sha256").update(pixels).digest("hex") };
	const reader = { read: vi.fn(async () => pixels), assertReadable: async () => undefined };
	const captures = new CloudNativeCaptureImages(reader);
	for (let i = 0; i < 17; i++)
		await captures.issue(`call-${i}`, "envelope", { kind: "json", value: large }, new AbortController().signal);
	expect(reader.read).toHaveBeenCalledTimes(17);
	// The same issued result is never issued twice.
	await expect(
		captures.issue("call-0", "envelope", { kind: "json", value: large }, new AbortController().signal),
	).rejects.toThrow("NATIVE_CAPTURE_REISSUED");
	expect(reader.read).toHaveBeenCalledTimes(17);
});

it("checks every issued screenshot in batches the kernel accepts", async () => {
	const pixels = Buffer.alloc(4 * 1024 * 1024, 7);
	const sha256 = createHash("sha256").update(pixels).digest("hex");
	const assertReadable = vi.fn(async (_assets: readonly (typeof asset)[]) => undefined);
	const captures = new CloudNativeCaptureImages({ read: async () => pixels, assertReadable });
	const signal = new AbortController().signal;
	const issued: string[] = [];
	for (let index = 0; index < 150; index++) {
		const value = { ...asset, assetId: randomUUID(), screenId: randomUUID(), sha256, bytes: pixels.length };
		issued.push(value.assetId);
		await captures.issue(`call-${index}`, "envelope", { kind: "json", value }, signal);
	}
	await captures.assertReadable(signal);
	const batches = assertReadable.mock.calls.map(([assets]) => assets);
	expect(batches.flat().map((item) => item.assetId)).toEqual(issued);
	for (const batch of batches) {
		expect(batch.length).toBeLessThanOrEqual(128);
		expect(batch.reduce((total, item) => total + item.bytes, 0)).toBeLessThanOrEqual(128 * 1024 * 1024);
	}
	// 150 screenshots of 4 MiB: 32 per batch by bytes, so five checks.
	expect(batches).toHaveLength(5);
});

async function exchange(path: string, value: unknown): Promise<unknown> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const body = Buffer.from(JSON.stringify(value));
		const header = Buffer.alloc(4);
		header.writeUInt32BE(body.length);
		let bytes = Buffer.alloc(0);
		socket.on("connect", () => socket.write(Buffer.concat([header, body])));
		socket.on("data", (data: Buffer) => {
			bytes = Buffer.concat([bytes, data]);
			if (bytes.length >= 4 && bytes.length === bytes.readUInt32BE() + 4) socket.end();
		});
		socket.on("error", () => resolve(undefined));
		socket.on("close", () => resolve(bytes.length ? JSON.parse(bytes.subarray(4).toString()) : undefined));
	});
}

it("keeps full capture evidence in the host audit while returning only the confirmed digest", async () => {
	const f = fixture();
	const result = await f.invoke();
	const root = await mkdtemp(join(tmpdir(), "q-image-"));
	const recordContextView = vi.fn(async () => undefined);
	const onFailure = vi.fn();
	const service = await startCloudNativeResultFence({
		root,
		boundary: f.boundary,
		assertSession: () => undefined,
		recordContextView,
		onFailure,
		signal: f.abort.signal,
	});
	cleanups.push(async () => {
		await service.close();
		await rm(root, { recursive: true, force: true });
	});
	const frame = {
		schema: "qorpera.native-result-fence/v1",
		requestId: randomUUID(),
		threadId: "thread-1",
		turnId: "turn-1",
		purpose: "turn",
		outputs: [f.input(result.contentItems[0].text)],
	};
	const response = await exchange(service.path, frame);
	expect(response).toEqual({
		schema: frame.schema,
		requestId: frame.requestId,
		threadId: frame.threadId,
		turnId: frame.turnId,
		outputs: [
			{
				kind: "function_call_output",
				callId: "capture-1",
				output: result.contentItems[0].text,
				imageSha256: asset.sha256,
			},
		],
	});
	expect(recordContextView).toHaveBeenCalledWith(
		frame,
		[expect.objectContaining({ capture: asset })],
		expect.any(AbortSignal),
	);
	expect(onFailure).not.toHaveBeenCalled();
});
