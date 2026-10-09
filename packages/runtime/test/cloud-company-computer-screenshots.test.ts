import { createHash, randomUUID } from "node:crypto";
import type { CompanyComputerOperation } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CloudCompanyComputerScreenshots,
	CompanyComputerInlineScreenshots,
	parseCompanyComputerScreenshotAsset,
} from "@qorpera/runtime/cloud-company-computer-screenshots";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { cloudNativeToolOperationEnvelope } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerLease, computerOperation } from "./fixtures/company-computer.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
	vi.restoreAllMocks();
});

async function fixture() {
	const source = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		source.binding,
		{ describeToolAuthority: async () => source.authority },
		new AbortController().signal,
	);
	runs.push(run);
	const scope = {
		companyId: run.identity.companyId,
		environmentId: run.identity.environmentId,
		companyComputerId: randomUUID(),
		logicalComputerId: randomUUID(),
	};
	const binding = { ...computerBinding(), ...scope, staffAgentId: run.identity.staffAgentId };
	const lease = {
		...computerLease(),
		binding,
		driver: { kind: "agent" as const, runId: run.identity.runId, staffAgentId: run.identity.staffAgentId },
	};
	const stop = new AbortController();
	const context = {
		identity: run.identity,
		receiptId: randomUUID(),
		idempotencyKey: "a".repeat(64),
		signal: stop.signal,
	};
	const operation: CompanyComputerOperation = {
		...computerOperation(),
		tool: "computer_screenshot",
		arguments: { kind: "screenshot", surface: "browser" },
		target: {
			realm: "company_computer",
			binding,
			resources: { browserGrantId: randomUUID(), browserGrantVersion: 1 },
		},
	};
	const bytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
		"base64",
	);
	// A capture is stored nowhere: the receipt names it.
	const asset = {
		assetId: context.receiptId,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		mediaType: "image/png" as const,
		screenId: binding.screenId,
		surface: "browser" as const,
		width: 1,
		height: 1,
	};
	const calls: string[] = [];
	const call = vi.fn(async (method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
		signal.throwIfAborted();
		calls.push(`${method}:${args.p_action ?? "read"}`);
		return args.p_action === "authorize" ? { state: "authorized", storage: "none" } : { ...asset };
	});
	const screenshots = new CloudCompanyComputerScreenshots({ run, scope, registry: { call } });
	return {
		source,
		run,
		scope,
		lease,
		context,
		operation,
		bytes,
		asset,
		call,
		calls,
		screenshots,
		stop,
		publish: () => screenshots.publish(bytes, lease, context, operation),
	};
}

describe("receipt-bound immutable office captures", () => {
	it("publishes between exact receipt checks and returns the catalog identity", async () => {
		const f = await fixture();
		await expect(f.publish()).resolves.toEqual(f.asset);
		expect(f.calls).toEqual(["qorpera_native_office_capture:authorize", "qorpera_native_office_capture:publish"]);
		expect(f.call.mock.calls[0][1]).toEqual({
			p_binding: f.run.binding,
			p_scope: f.scope,
			p_lease: f.lease,
			p_envelope: cloudNativeToolOperationEnvelope(f.run.identity, f.operation),
			p_receipt_id: f.context.receiptId,
			p_idempotency_sha256: createHash("sha256").update(f.context.idempotencyKey).digest("hex"),
			p_action: "authorize",
			p_image: { sha256: f.asset.sha256, bytes: f.bytes.length, mediaType: "image/png", width: 1, height: 1 },
		});
	});
	it("copies caller bytes and operation metadata before awaiting authority", async () => {
		const f = await fixture();
		const expected = Buffer.from(f.bytes),
			receiptId = f.context.receiptId;
		const pending = f.publish();
		f.bytes.fill(0);
		f.context.receiptId = randomUUID();
		f.lease.binding.screenId = randomUUID();
		(f.operation.target.resources as Record<string, unknown>).browserGrantVersion = 99;
		await expect(pending).resolves.toEqual(f.asset);
		expect(f.screenshots.takeInline(receiptId)).toEqual(Uint8Array.from(expected));
		expect(f.call.mock.calls[1][1].p_receipt_id).toBe(receiptId);
		expect(
			JSON.parse(f.call.mock.calls[1][1].p_envelope as string).operation.target.resources.browserGrantVersion,
		).toBe(1);
	});
	it.each(["identity", "receipt", "idempotency", "screen", "operation"])(
		"rejects substituted %s before I/O",
		async (change) => {
			const f = await fixture();
			if (change === "identity") f.context.identity = { ...f.context.identity, requesterUserId: randomUUID() };
			if (change === "receipt") (f.context as { receiptId: string }).receiptId = "invalid";
			if (change === "idempotency") f.context.idempotencyKey = "invalid";
			if (change === "screen") f.lease.driver.runId = randomUUID();
			if (change === "operation") (f.operation as { tool: string }).tool = "computer_shell";
			await expect(f.publish()).rejects.toThrow();
			expect(f.call).not.toHaveBeenCalled();
		},
	);
	it.each(["signature", "width", "height", "length"])("rejects invalid PNG %s before I/O", async (change) => {
		const f = await fixture();
		let bytes: Uint8Array = f.bytes;
		if (change === "signature") f.bytes[0] = 0;
		if (change === "width") f.bytes.writeUInt32BE(1921, 16);
		if (change === "height") f.bytes.writeUInt32BE(0, 20);
		if (change === "length") bytes = new Uint8Array(8 * 1024 * 1024 + 1);
		await expect(f.screenshots.publish(bytes, f.lease, f.context, f.operation)).rejects.toThrow(
			"INVALID_OFFICE_CAPTURE",
		);
		expect(f.call).not.toHaveBeenCalled();
	});
	it("does not publish without current capture authority", async () => {
		const f = await fixture();
		f.call.mockResolvedValueOnce({ state: "denied", storage: "none" });
		await expect(f.publish()).rejects.toThrow();
		expect(f.call).toHaveBeenCalledOnce();
	});
	it("cancels after authority without registering an asset", async () => {
		const f = await fixture();
		f.call.mockImplementationOnce(async () => {
			f.stop.abort();
			return { state: "authorized", storage: "none" };
		});
		await expect(f.publish()).rejects.toThrow();
		expect(f.call).toHaveBeenCalledOnce();
		expect(f.screenshots.takeInline(f.asset.assetId)).toBeUndefined();
	});
	it.each([{ sha256: "0".repeat(64) }, { width: 2 }, { screenId: randomUUID() }, { extra: true }, { bytes: 99 }])(
		"rejects changed publication metadata %j",
		async (changed) => {
			const f = await fixture();
			f.call
				.mockResolvedValueOnce({ state: "authorized", storage: "none" })
				.mockResolvedValueOnce({ ...f.asset, ...changed });
			await expect(f.publish()).rejects.toThrow();
			expect(f.screenshots.takeInline(f.asset.assetId)).toBeUndefined();
		},
	);
	it("does not take the pixels without a completed authorized receipt", async () => {
		const f = await fixture();
		f.screenshots.holdInline(f.asset, f.bytes);
		f.call.mockRejectedValueOnce(new Error("denied"));
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow();
		expect(f.screenshots.takeInline(f.asset.assetId)).toEqual(Uint8Array.from(f.bytes));
	});
	it("rejects authority revoked after the pixels are taken", async () => {
		const f = await fixture();
		f.screenshots.holdInline(f.asset, f.bytes);
		f.call.mockResolvedValueOnce(f.asset).mockRejectedValueOnce(new Error("revoked"));
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow("revoked");
	});
	it("rejects an expired run even with cached artifact metadata", async () => {
		const f = await fixture();
		f.run.close();
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow();
		expect(f.call).not.toHaveBeenCalled();
	});
	it("copies a bounded capture set and checks it without downloading pixels", async () => {
		const f = await fixture();
		const values = [{ ...f.asset }];
		f.call.mockImplementationOnce(async (_method, args) => ({ state: "authorized", assets: args.p_assets }));
		const checked = f.screenshots.assertReadable(values, f.stop.signal);
		values[0].sha256 = "a".repeat(64);
		await checked;
		expect(f.call).toHaveBeenCalledWith(
			"qorpera_assert_native_office_captures",
			{ p_binding: f.run.binding, p_assets: [f.asset] },
			expect.any(AbortSignal),
		);
	});
	it.each(["changed", "revoked", "abort"])("withholds capture-set authority on %s", async (fault) => {
		const f = await fixture();
		f.call.mockImplementationOnce(async () => {
			if (fault === "revoked") throw new Error("revoked");
			if (fault === "abort") f.stop.abort();
			return { state: "authorized", assets: fault === "changed" ? [] : [f.asset] };
		});
		await expect(f.screenshots.assertReadable([f.asset], f.stop.signal)).rejects.toThrow();
		expect(f.call).toHaveBeenCalledTimes(1);
	});
	it("refuses an oversized capture batch before contacting authority", async () => {
		const f = await fixture();
		await expect(
			f.screenshots.assertReadable(
				Array.from({ length: 129 }, () => f.asset),
				f.stop.signal,
			),
		).rejects.toThrow("INVALID_OFFICE_CAPTURE_BATCH");
		expect(f.call).not.toHaveBeenCalled();
	});
	it("parses only immutable image references, never URLs or paths", async () => {
		const f = await fixture();
		expect(() => parseCompanyComputerScreenshotAsset({ ...f.asset, url: "file:///secret" })).toThrow();
	});
});

describe("captures stored nowhere (folder-v2, P06d)", () => {
	it("names the receipt and keeps the pixels once for the perform answer", async () => {
		const f = await fixture();
		await expect(f.publish()).resolves.toEqual(f.asset);
		expect(f.screenshots.takeInline(f.context.receiptId)).toEqual(Uint8Array.from(f.bytes));
		expect(f.screenshots.takeInline(f.context.receiptId)).toBeUndefined();
	});
	it("refuses a capture that does not name its receipt, and any answer but storage none", async () => {
		const f = await fixture();
		const other = randomUUID();
		f.call.mockImplementationOnce(async () => ({ state: "authorized", storage: "none" }));
		f.call.mockImplementationOnce(async () => ({ ...f.asset, assetId: other }));
		await expect(f.publish()).rejects.toThrow("OFFICE_CAPTURE_UNCONFIRMED");
		expect(f.screenshots.takeInline(other)).toBeUndefined();
		// A stored capture (snapshot-v1's answer, without storage) is gone with company objects.
		for (const answer of [
			{ state: "authorized" },
			{ state: "authorized", storage: "object" },
			{ state: "denied", storage: "none" },
		]) {
			f.call.mockImplementationOnce(async () => answer);
			await expect(f.publish()).rejects.toThrow();
		}
		expect(f.screenshots.takeInline(f.asset.assetId)).toBeUndefined();
	});
	it("reads pixels that came in the perform answer once, between both authority checks", async () => {
		const f = await fixture();
		f.screenshots.holdInline(f.asset, f.bytes);
		await expect(f.screenshots.read(f.asset, f.stop.signal)).resolves.toEqual(Uint8Array.from(f.bytes));
		expect(f.calls).toEqual(["qorpera_read_native_office_capture:read", "qorpera_read_native_office_capture:read"]);
		// Read once: they are kept nowhere else.
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow("OFFICE_CAPTURE_UNAVAILABLE");
	});
	it("keeps no pixels that are not exactly the published capture's", async () => {
		const f = await fixture();
		const altered = Buffer.from(f.bytes);
		altered[30] ^= 1;
		expect(() => f.screenshots.holdInline(f.asset, altered)).toThrow("OFFICE_CAPTURE_CHANGED");
		expect(() => f.screenshots.holdInline({ ...f.asset, width: 2 }, f.bytes)).toThrow("OFFICE_CAPTURE_CHANGED");
		expect(() => f.screenshots.holdInline({ ...f.asset, url: "file:///x" } as never, f.bytes)).toThrow();
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow("OFFICE_CAPTURE_UNAVAILABLE");
	});
	it("keeps at most four screenshots, each for at most a minute on its own timer", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const held = new CompanyComputerInlineScreenshots();
			const ids = Array.from({ length: 5 }, () => randomUUID());
			for (const id of ids) held.hold(id, Uint8Array.of(1));
			expect(held.size).toBe(4);
			expect(held.take(ids[0])).toBeUndefined();
			expect(held.take(ids[4])).toEqual(Uint8Array.of(1));
			expect(vi.getTimerCount()).toBe(3);
			// Nothing touches the holder again: its timers alone let the rest go.
			vi.advanceTimersByTime(59_999);
			expect(held.size).toBe(3);
			vi.advanceTimersByTime(1);
			expect(held.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			held.hold(ids[1], Uint8Array.of(1));
			held.clear();
			expect(held.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
	it("lets a waiting screenshot go when its run ends, on either side, and keeps none after", async () => {
		const f = await fixture();
		await f.publish();
		f.screenshots.holdInline(f.asset, f.bytes);
		f.run.close();
		expect(f.screenshots.takeInline(f.context.receiptId)).toBeUndefined();
		expect(f.screenshots.takeInline(f.asset.assetId)).toBeUndefined();
		expect(() => f.screenshots.holdInline(f.asset, f.bytes)).toThrow();
		expect(f.screenshots.takeInline(f.asset.assetId)).toBeUndefined();
	});
	it("keeps nothing when the run ends while the capture is being published", async () => {
		const f = await fixture();
		f.call.mockImplementationOnce(async () => ({ state: "authorized", storage: "none" }));
		f.call.mockImplementationOnce(async () => {
			f.run.close();
			return { ...f.asset, assetId: f.context.receiptId };
		});
		await expect(f.publish()).rejects.toThrow();
		expect(f.screenshots.takeInline(f.context.receiptId)).toBeUndefined();
	});
});
