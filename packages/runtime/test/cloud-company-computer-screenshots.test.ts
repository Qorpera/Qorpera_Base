import { createHash, randomUUID } from "node:crypto";
import type { CompanyComputerOperation } from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	CloudCompanyComputerScreenshots,
	createHttpCompanyComputerScreenshots,
	parseCompanyComputerCaptureGateway,
	parseCompanyComputerScreenshotAsset,
} from "@qorpera/runtime/cloud-company-computer-screenshots";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { cloudNativeToolOperationEnvelope } from "@qorpera/runtime/cloud-native-tool-operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "../../shell/test/fixtures/native-tool-authority-fixture.ts";
import { computerBinding, computerLease, computerOperation } from "./fixtures/company-computer.ts";

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
	const asset = {
		assetId: randomUUID(),
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
		return args.p_action === "authorize" ? { state: "authorized" } : { ...asset };
	});
	const put = vi.fn(async () => {
		calls.push("put");
		return "stored" as const;
	});
	const get = vi.fn(async () => {
		calls.push("get");
		return Uint8Array.from(bytes);
	});
	const objects = vi.fn((_signal: AbortSignal) => ({ put, get }));
	const screenshots = new CloudCompanyComputerScreenshots({ run, scope, registry: { call }, objects });
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
		put,
		get,
		objects,
		screenshots,
		stop,
		publish: () => screenshots.publish(bytes, lease, context, operation),
	};
}

describe("receipt-bound immutable office captures", () => {
	it.each([
		"http://objects.example",
		"https://user:password@objects.example",
		"https://objects.example/path",
		"https://objects.example?token=secret",
	])("rejects unsafe object gateway %s before startup", (baseUrl) => {
		expect(() => parseCompanyComputerCaptureGateway({ baseUrl, token: "x".repeat(43) })).toThrow();
	});
	it("stages bytes between exact receipt checks and returns the catalog identity", async () => {
		const f = await fixture();
		await expect(f.publish()).resolves.toEqual(f.asset);
		expect(f.calls).toEqual([
			"qorpera_native_office_capture:authorize",
			"put",
			"qorpera_native_office_capture:publish",
		]);
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
		expect(f.put).toHaveBeenCalledWith(
			`${f.scope.companyId}/${f.asset.sha256}`,
			Uint8Array.from(f.bytes),
			"image/png",
		);
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
		expect(f.put).toHaveBeenCalledWith(
			`${f.scope.companyId}/${f.asset.sha256}`,
			Uint8Array.from(expected),
			"image/png",
		);
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
			expect(f.put).not.toHaveBeenCalled();
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
		expect(f.put).not.toHaveBeenCalled();
	});
	it("does not stage without current capture authority", async () => {
		const f = await fixture();
		f.call.mockResolvedValueOnce({ state: "denied" });
		await expect(f.publish()).rejects.toThrow();
		expect(f.put).not.toHaveBeenCalled();
	});
	it("does not publish or retry an uncertain upload", async () => {
		const f = await fixture();
		f.put.mockRejectedValueOnce(new Error("connection lost after write"));
		await expect(f.publish()).rejects.toThrow();
		expect(f.put).toHaveBeenCalledOnce();
		expect(f.call).toHaveBeenCalledOnce();
	});
	it("cancels after storage without registering an asset", async () => {
		const f = await fixture();
		f.put.mockImplementationOnce(async () => {
			f.stop.abort();
			return "stored";
		});
		await expect(f.publish()).rejects.toThrow();
		expect(f.call).toHaveBeenCalledOnce();
		expect(f.objects.mock.calls[0][0].aborted).toBe(true);
	});
	it.each([{ sha256: "0".repeat(64) }, { width: 2 }, { screenId: randomUUID() }, { extra: true }, { bytes: 99 }])(
		"rejects changed publication metadata %j",
		async (changed) => {
			const f = await fixture();
			f.call.mockResolvedValueOnce({ state: "authorized" }).mockResolvedValueOnce({ ...f.asset, ...changed });
			await expect(f.publish()).rejects.toThrow();
			expect(f.put).toHaveBeenCalledOnce();
		},
	);
	it("checks a completed capture both before and after fetching its exact immutable object", async () => {
		const f = await fixture();
		await expect(f.screenshots.read(f.asset, f.stop.signal)).resolves.toEqual(Uint8Array.from(f.bytes));
		expect(f.calls).toEqual([
			"qorpera_read_native_office_capture:read",
			"get",
			"qorpera_read_native_office_capture:read",
		]);
	});
	it("does not fetch an asset without a completed authorized receipt", async () => {
		const f = await fixture();
		f.call.mockRejectedValueOnce(new Error("denied"));
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow();
		expect(f.get).not.toHaveBeenCalled();
	});
	it("rejects authority revocation during object I/O", async () => {
		const f = await fixture();
		f.call.mockResolvedValueOnce(f.asset).mockRejectedValueOnce(new Error("revoked"));
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow("revoked");
		expect(f.get).toHaveBeenCalledOnce();
	});
	it("rejects altered stored bytes", async () => {
		const f = await fixture();
		const altered = Buffer.from(f.bytes);
		altered[30] ^= 1;
		f.get.mockResolvedValueOnce(altered);
		await expect(f.screenshots.read(f.asset, f.stop.signal)).rejects.toThrow("OFFICE_CAPTURE_CHANGED");
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
		expect(f.objects).not.toHaveBeenCalled();
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
		expect(f.objects).not.toHaveBeenCalled();
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
	it("uses the existing authenticated object route without exposing its credential in the asset", async () => {
		const f = await fixture();
		const token = "x".repeat(43);
		const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.headers).toMatchObject({
				authorization: `Bearer ${token}`,
				"x-qorpera-native-binding": Buffer.from(JSON.stringify(f.run.binding)).toString("base64url"),
			});
			return new Response(
				JSON.stringify({ status: "stored", sha256: f.asset.sha256, bytes: f.bytes.length, replication: "pending" }),
				{ status: 201 },
			);
		});
		const screenshots = createHttpCompanyComputerScreenshots({
			run: f.run,
			scope: f.scope,
			registry: { call: f.call },
			objectGateway: { baseUrl: "https://objects.example", token, fetch: fetcher },
		});
		await expect(screenshots.publish(f.bytes, f.lease, f.context, f.operation)).resolves.toEqual(f.asset);
		expect(fetcher.mock.calls[0][0]).toBe(
			`https://objects.example/v1/native-company-objects/${f.scope.companyId}/${f.asset.sha256}`,
		);
		expect(JSON.stringify(f.asset)).not.toContain(token);
	});
	it("parses only immutable image references, never URLs or paths", async () => {
		const f = await fixture();
		expect(() => parseCompanyComputerScreenshotAsset({ ...f.asset, url: "file:///secret" })).toThrow();
	});
});
