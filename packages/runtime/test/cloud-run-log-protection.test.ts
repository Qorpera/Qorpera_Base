import { randomUUID } from "node:crypto";
import { CloudRunLogUnavailable } from "@qorpera/runtime/cloud-run-log";
import { type CloudRunLogProtectionCall, CloudRunLogRpcProtection } from "@qorpera/runtime/cloud-run-log-protection";
import { describe, expect, it, vi } from "vitest";

const binding = { environmentId: randomUUID(), jobId: randomUUID(), runId: randomUUID() };
const signal = new AbortController().signal;
const plain = { log: false, machine: false, restricted: [] };
const step = { j: 0, argumentsText: "{}", result: null, releases: [], readPaths: [], resultPaths: [] };

function setup(implementation: CloudRunLogProtectionCall = async () => plain) {
	const call = vi.fn(implementation);
	return { call, protection: new CloudRunLogRpcProtection({ ...binding, call }) };
}

describe("lease-bound run log protection", () => {
	it("reads current machine/log flags even without paths and binds all trusted identity arguments", async () => {
		const { call, protection } = setup();
		expect(await protection.narrow(binding.runId, step, signal)).toEqual({ log: false, narrow: false });
		expect(call).toHaveBeenCalledOnce();
		expect(call.mock.calls[0]?.slice(0, 2)).toEqual([
			"qorpera_memory_step_narrow",
			{
				p_environment_id: binding.environmentId,
				p_job_id: binding.jobId,
				p_run_id: binding.runId,
				p_paths: [],
			},
		]);
	});

	it("classifies full nested arguments, raw-result paths and reads beyond the stored envelope", async () => {
		const { call, protection } = setup(async () => ({ ...plain, restricted: ["projects/secret/last.txt"] }));
		expect(
			await protection.narrow(
				binding.runId,
				{
					...step,
					argumentsText: JSON.stringify({
						source: [{ from: "/company/projects/source" }],
						to: "projects/target",
						paths: ["projects/source"],
					}),
					result: '{"content":"clipped"}',
					resultPaths: ["projects/result", "projects/secret/last.txt"],
					readPaths: ["projects/read", "projects/result"],
				},
				signal,
			),
		).toEqual({ log: false, narrow: true });
		expect(call.mock.calls[0]?.[1].p_paths).toEqual(
			expect.arrayContaining([
				"projects/target",
				"projects/source",
				"projects/result",
				"projects/secret/last.txt",
				"projects/read",
			]),
		);
		expect(call.mock.calls[0]?.[1].p_paths).toHaveLength(5);
		expect(JSON.stringify(call.mock.calls)).not.toContain("clipped");
	});

	it("chunks complete path sets at 1024 and finds a restriction in the last batch", async () => {
		const paths = Array.from({ length: 2050 }, (_, index) => `projects/file-${index}`);
		const { call, protection } = setup(async (_method, args) => ({
			...plain,
			restricted: (args.p_paths as string[]).filter((path) => path === paths.at(-1)),
		}));
		expect(await protection.narrow(binding.runId, { ...step, readPaths: paths }, signal)).toEqual({
			log: false,
			narrow: true,
		});
		expect(call.mock.calls.map((entry) => (entry[1].p_paths as string[]).length)).toEqual([1024, 1024, 2]);
		expect(call.mock.calls.flatMap((entry) => entry[1].p_paths)).toEqual(paths);
	});

	it.each([
		{ answer: { ...plain, log: true }, expected: { log: true, narrow: false } },
		{ answer: { ...plain, machine: true }, expected: { log: false, narrow: true } },
	])("keeps the log flag separate from per-step causes: %o", async ({ answer, expected }) => {
		const { protection } = setup(async () => answer);
		expect(await protection.narrow(binding.runId, step, signal)).toEqual(expected);
	});

	it.each([
		{ value: null },
		{ value: {} },
		{ value: { ...plain, log: 0 } },
		{ value: { ...plain, extra: false } },
		{ value: { ...plain, restricted: ["unknown"] } },
		{ value: { ...plain, restricted: ["b", "a"] } },
		{ value: { ...plain, restricted: ["a", "a"] } },
		{ value: { ...plain, restricted: new Array(1) } },
	])("refuses malformed or unrelated classification results", async ({ value }) => {
		const { protection } = setup(async () => value);
		await expect(protection.narrow(binding.runId, { ...step, readPaths: ["a", "b"] }, signal)).rejects.toBeInstanceOf(
			CloudRunLogUnavailable,
		);
	});

	it("never answers broad if a later classification batch is unavailable", async () => {
		const { call, protection } = setup(async () => plain);
		call.mockRejectedValueOnce(new Error("sensitive diagnostic"));
		await expect(protection.narrow(binding.runId, step, signal)).rejects.toThrow("protection_unavailable");
		call.mockResolvedValueOnce(plain).mockRejectedValueOnce(new Error("sensitive diagnostic"));
		await expect(
			protection.narrow(
				binding.runId,
				{ ...step, readPaths: Array.from({ length: 1025 }, (_, index) => `projects/${index}`) },
				signal,
			),
		).rejects.toThrow("protection_unavailable");
	});

	it("returns only platform hashes, chunked at 128 and in input order", async () => {
		const inputs = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(64, "0"));
		const { call, protection } = setup(async (_method, args) =>
			(args.p_digests as string[]).map((digest) => `f${digest.slice(1)}`),
		);
		expect(await protection.hashes(binding.runId, inputs, signal)).toEqual(
			inputs.map((digest) => `f${digest.slice(1)}`),
		);
		expect(call.mock.calls.map((entry) => (entry[1].p_digests as string[]).length)).toEqual([128, 128, 1]);
		expect(call.mock.calls.every((entry) => entry[0] === "qorpera_memory_step_hashes")).toBe(true);
	});

	it("does not release a partial hash set after a later batch fails", async () => {
		const { call, protection } = setup(async (_method, args) => args.p_digests);
		call.mockResolvedValueOnce(Array(128).fill("b".repeat(64))).mockRejectedValueOnce(new Error("private path"));
		await expect(protection.hashes(binding.runId, Array(129).fill("a".repeat(64)), signal)).rejects.toThrow(
			"protection_unavailable",
		);
		expect(call).toHaveBeenCalledTimes(2);
	});

	it("normalizes the company prefix and ignores empty or oversized UTF-8 needles before RPC limits", async () => {
		const { call, protection } = setup();
		const path = "\u{1f600}".repeat(1024);
		expect(
			await protection.narrow(
				binding.runId,
				{
					...step,
					readPaths: [path, `${path}a`, "/company/", "", "/company/a", "a".repeat(5000), `/company/${path}`],
				},
				signal,
			),
		).toEqual({ log: false, narrow: false });
		expect(call.mock.calls[0]?.[1].p_paths).toEqual([path, "a"]);
		expect(call).toHaveBeenCalledOnce();
	});

	it("ignores controls and malformed UTF-16 in every needle source without changing valid Unicode paths", async () => {
		const invalid = [
			...Array.from({ length: 32 }, (_, code) => `a${String.fromCharCode(code)}b`),
			"a\u007fb",
			"a\ud800b",
			"a\udc00b",
			"a\ud800\ud800b",
		];
		const valid = ["restricted/\u{1f600}.md", "a\ufffdb"];
		const { call, protection } = setup(async () => ({ ...plain, restricted: [valid[0]] }));
		expect(
			await protection.narrow(
				binding.runId,
				{
					...step,
					argumentsText: JSON.stringify({ paths: invalid, path: valid[0] }),
					resultPaths: [...invalid.map((path) => `/company/${path}`), valid[1]!],
					readPaths: [...invalid, ...valid],
				},
				signal,
			),
		).toEqual({ log: false, narrow: true });
		expect(call.mock.calls[0]?.[1].p_paths).toEqual(valid);
		expect(call).toHaveBeenCalledOnce();
	});

	it("still checks machine and log flags when every needle is invalid Unicode or a control", async () => {
		const { call, protection } = setup(async () => ({ ...plain, log: true, machine: true }));
		expect(
			await protection.narrow(
				binding.runId,
				{ ...step, argumentsText: '{"path":"a\\u0000b"}', resultPaths: ["\ud800"], readPaths: ["\u007f"] },
				signal,
			),
		).toEqual({ log: true, narrow: true });
		expect(call.mock.calls[0]?.[1].p_paths).toEqual([]);
		expect(call).toHaveBeenCalledOnce();
	});

	it("cancels an in-flight transport that ignores its signal without starting later batches", async () => {
		const stop = new AbortController();
		let release: (value: unknown) => void = () => undefined;
		const { call, protection } = setup(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const pending = protection.narrow(
			binding.runId,
			{ ...step, readPaths: Array.from({ length: 1025 }, (_, index) => `projects/${index}`) },
			stop.signal,
		);
		const refused = expect(pending).rejects.toThrow("protection_unavailable");
		await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
		stop.abort();
		await refused;
		release(plain);
		await Promise.resolve();
		expect(call).toHaveBeenCalledOnce();
	});

	it.each([
		{ value: null },
		{ value: [] },
		{ value: ["a".repeat(64), "b".repeat(64)] },
		{ value: ["A".repeat(64)] },
		{ value: ["bad"] },
		{ value: new Array(1) },
	])("refuses missing or malformed keyed hashes", async ({ value }) => {
		const { protection } = setup(async () => value);
		await expect(protection.hashes(binding.runId, ["a".repeat(64)], signal)).rejects.toBeInstanceOf(
			CloudRunLogUnavailable,
		);
	});

	it("rejects invalid input and a different run before making any host call", async () => {
		const { call, protection } = setup();
		await expect(protection.narrow(randomUUID(), step, signal)).rejects.toThrow("protection_run_mismatch");
		await expect(protection.hashes(randomUUID(), [], signal)).rejects.toThrow("protection_run_mismatch");
		await expect(protection.narrow(binding.runId, { ...step, readPaths: [1 as never] }, signal)).rejects.toThrow(
			"paths_invalid",
		);
		await expect(protection.hashes(binding.runId, ["bad"], signal)).rejects.toThrow("protection_digests_invalid");
		await expect(protection.hashes(binding.runId, new Array(1), signal)).rejects.toThrow(
			"protection_digests_invalid",
		);
		expect(call).not.toHaveBeenCalled();
	});

	it("refuses an already cancelled request and an invalid construction", async () => {
		const { call, protection } = setup();
		await expect(protection.narrow(binding.runId, step, AbortSignal.abort())).rejects.toBeDefined();
		expect(call).not.toHaveBeenCalled();
		expect(() => new CloudRunLogRpcProtection({ ...binding, runId: "wrong", call })).toThrow(
			"Invalid run log protection binding",
		);
	});
});
