import { companyComputerStopHistoryDirectory, parseCompanyComputerStopHistoryManifest } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LxdInstanceFile, LxdOfficeServiceStartClient } from "../src/lxd-client.ts";
import { lxdOfficeGuestPlan } from "../src/lxd-office-guest.ts";
import { officeStopHash } from "../src/lxd-office-stop-evidence.ts";
import { readLxdOfficeStopHistory } from "../src/lxd-office-stop-history.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const bootId = "11111111-1111-4111-8111-111111111111",
	activationId = "22222222-2222-4222-8222-222222222222";
const fixture = () => ({
	schema: "qorpera.office-stop-history/v1",
	command: { commandId: "33333333-3333-4333-8333-333333333333", bootId, requestSha256: "a".repeat(64) },
	activationId,
	completionPath: "/run/qorpera-office-preparation/service-stop-completion.json",
	entries: [
		{ path: "/etc/qorpera-office/adoption.json", bytes: 12, mode: 0o444, sha256: "b".repeat(64) },
		{
			path: "/run/qorpera-office-preparation/service-stop-completion.json",
			bytes: 12,
			mode: 0o600,
			sha256: "c".repeat(64),
		},
	],
});
describe("portable root stop history", () => {
	it.each(["adoption.json", "configuration-claim.json", "configuration-completion.json", "credentials/config.json"])(
		"accepts current boot public %s while preserving wire bytes",
		(name) => {
			const input = fixture();
			input.entries[0].path = `/etc/qorpera-office/boots/${bootId.replaceAll("-", "")}/${name}`;
			expect(JSON.stringify(parseCompanyComputerStopHistoryManifest(input, bootId, activationId))).toBe(
				JSON.stringify(input),
			);
		},
	);
	it.each([
		"credentials/native",
		"credentials/registry",
		"credentials/tls-key.pem",
		"../adoption.json",
		"preparation.json",
	])("refuses non-public boot path %s", (name) => {
		const input = fixture();
		input.entries[0].path = `/etc/qorpera-office/boots/${bootId.replaceAll("-", "")}/${name}`;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow();
	});
	it("refuses a public receipt from a different boot", () => {
		const input = fixture();
		input.entries[0].path = `/etc/qorpera-office/boots/${activationId.replaceAll("-", "")}/adoption.json`;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow();
	});
	it("preserves existing wire key order and returns independent immutable metadata", () => {
		const input = fixture(),
			wire = JSON.stringify(input),
			parsed = parseCompanyComputerStopHistoryManifest(input, bootId, activationId);
		expect(JSON.stringify(parsed)).toBe(wire);
		input.entries[0].sha256 = "d".repeat(64);
		expect(parsed.entries[0].sha256).toBe("b".repeat(64));
		expect(Object.isFrozen(parsed.entries[0])).toBe(true);
		expect(Object.isFrozen(parsed.entries)).toBe(true);
		expect(Object.isFrozen(parsed.command)).toBe(true);
	});
	it.each(["../run", "", "11111111-1111-1111-1111-111111111111"])("rejects malformed directory identity %s", (id) => {
		expect(() => companyComputerStopHistoryDirectory(id, activationId)).toThrow();
		expect(() => parseCompanyComputerStopHistoryManifest(fixture(), bootId, id)).toThrow();
	});
	it.each([
		"traversal",
		"credential",
		"duplicate",
		"ordering",
		"missing-completion",
		"size",
		"count",
		"mode",
		"length",
		"hash",
		"prototype",
		"extra",
		"boot",
		"activation",
	])("refuses %s manifests", (fault) => {
		const input = fixture();
		if (fault === "traversal") input.entries[0].path = "/run/qorpera-office-preparation/../secret.json";
		if (fault === "credential") input.entries[0].path = "/etc/qorpera-office/credentials/tls-key.pem";
		if (fault === "duplicate") input.entries[1] = { ...input.entries[0] };
		if (fault === "ordering") input.entries.reverse();
		if (fault === "missing-completion")
			input.entries[1].path = "/run/qorpera-office-preparation/service-start-completion.json";
		if (fault === "size")
			input.entries = Array.from({ length: 70 }, (_, index) => ({
				...input.entries[0],
				path: `/run/qorpera-office-preparation/a${String(index).padStart(3, "0")}.json`,
				bytes: 65536,
			}));
		if (fault === "count") input.entries = Array.from({ length: 129 }, () => input.entries[0]);
		if (fault === "mode") input.entries[0].mode = 0o644;
		if (fault === "length") input.entries[0].bytes = 65537;
		if (fault === "hash") input.entries[0].sha256 = "x".repeat(64);
		if (fault === "prototype") Object.setPrototypeOf(input, { foreign: true });
		if (fault === "extra") Object.assign(input, { authority: true });
		if (fault === "boot") input.command.bootId = activationId;
		if (fault === "activation") input.activationId = bootId;
		expect(() => parseCompanyComputerStopHistoryManifest(input, bootId, activationId)).toThrow(
			"INVALID_OFFICE_STOP_HISTORY_MANIFEST",
		);
	});
});

function deferred() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

function readerFixture() {
	const { binding } = officePhysicalFixture(),
		input = fixture(),
		root = companyComputerStopHistoryDirectory(bootId, activationId),
		sources = Array.from({ length: 10 }, (_, index) => ({
			path:
				index === 9
					? input.completionPath
					: `/run/qorpera-office-preparation/entry-${String(index).padStart(3, "0")}.json`,
			content: Buffer.from(JSON.stringify({ index })),
		}));
	input.entries = sources.map(({ path, content }) => ({
		path,
		bytes: content.length,
		mode: 0o600,
		sha256: officeStopHash(content),
	}));
	const manifest = parseCompanyComputerStopHistoryManifest(input, bootId, activationId),
		bytes = Buffer.from(JSON.stringify(manifest)),
		files = new Map<string, LxdInstanceFile>(
			[
				{ path: `${root}/manifest.json`, content: bytes },
				{ path: `${root}/claim.json`, content: bytes },
				...sources.map(({ content }) => ({ path: `${root}/${officeStopHash(content)}.json`, content })),
			].map(({ path, content }) => [path, { uid: 0, gid: 0, mode: 0o600, content }]),
		),
		blobs = manifest.entries.map((entry) => `${root}/${entry.sha256}.json`),
		returned: Buffer[] = [],
		requests: string[] = [],
		hooks = { read: async (_path: string, _signal: AbortSignal) => {} };
	const client: Pick<LxdOfficeServiceStartClient, "readInstanceFile"> = {
		readInstanceFile: vi.fn(async (project, name, path, limit, signal) => {
			expect(project).toBe(binding.project);
			expect(name).toBe(lxdOfficeGuestPlan(binding).request.name);
			requests.push(path);
			await hooks.read(path, signal);
			const file = files.get(path);
			if (!file) throw new Error("missing archive file");
			expect(limit).toBe(manifest.entries.find((entry) => `${root}/${entry.sha256}.json` === path)?.bytes ?? 65536);
			const content = Buffer.from(file.content);
			returned.push(content);
			return { ...file, content };
		}),
	};
	return {
		root,
		manifest,
		bytes,
		files,
		blobs,
		returned,
		requests,
		hooks,
		run: (signal = new AbortController().signal) =>
			readLxdOfficeStopHistory(
				client,
				binding,
				manifest.command,
				activationId,
				manifest.completionPath,
				Object.fromEntries(manifest.entries.map((entry) => [entry.path, entry.sha256])),
				signal,
			),
	};
}

describe("sealed stop history reader", () => {
	it("requires the exact manifest claim before reading any blobs", async () => {
		const f = readerFixture();
		f.files.get(`${f.root}/claim.json`)!.content = Buffer.from("{}");
		await expect(f.run()).rejects.toThrow("history binding differs");
		expect(f.requests).toEqual([`${f.root}/manifest.json`, `${f.root}/claim.json`]);
		expect(f.returned.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});
	it("does not start a read after caller cancellation", async () => {
		const f = readerFixture(),
			failure = new Error("cancelled before history");
		await expect(f.run(AbortSignal.abort(failure))).rejects.toBe(failure);
		expect(f.requests).toEqual([]);
	});
	it("reads at most four blobs concurrently between serial manifest and claim checks", async () => {
		const f = readerFixture(),
			gate = deferred();
		let active = 0,
			peak = 0;
		f.hooks.read = async (path) => {
			if (!f.blobs.includes(path)) return;
			peak = Math.max(peak, ++active);
			try {
				await gate.promise;
			} finally {
				active--;
			}
		};
		const result = f.run();
		try {
			await vi.waitFor(() => expect(active).toBe(4));
			expect(f.requests).toEqual([`${f.root}/manifest.json`, `${f.root}/claim.json`, ...f.blobs.slice(0, 4)]);
		} finally {
			gate.release();
			await result;
		}
		expect(peak).toBe(4);
		expect(await result).toEqual({ bytes: f.bytes, manifest: f.manifest, manifestSha256: officeStopHash(f.bytes) });
		expect(f.requests).toEqual([
			`${f.root}/manifest.json`,
			`${f.root}/claim.json`,
			...f.blobs,
			`${f.root}/claim.json`,
			`${f.root}/manifest.json`,
		]);
		expect(f.returned.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it.each(["read failure", "abort"])("settles and wipes late siblings before reporting %s", async (fault) => {
		const f = readerFixture(),
			gate = deferred(),
			controller = new AbortController(),
			failure = new Error(fault);
		let settled = false;
		f.hooks.read = async (path) => {
			if (!f.blobs.includes(path)) return;
			if (fault === "read failure" && path === f.blobs[0]) throw failure;
			await gate.promise;
		};
		const outcome = f.run(controller.signal).then(
			() => {
				settled = true;
				return undefined;
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await vi.waitFor(() => expect(f.requests.filter((path) => f.blobs.includes(path))).toHaveLength(4));
			if (fault === "abort") controller.abort(failure);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
		} finally {
			gate.release();
			await outcome;
		}
		expect(await outcome).toBe(failure);
		expect(f.requests).toHaveLength(6);
		expect(f.returned).toHaveLength(fault === "read failure" ? 5 : 6);
		expect(f.returned.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it.each(["uid", "gid", "mode", "length", "hash", "missing"])("refuses blob %s corruption", async (fault) => {
		const f = readerFixture(),
			file = f.files.get(f.blobs[2])!;
		if (fault === "uid") file.uid = 1000;
		if (fault === "gid") file.gid = 1000;
		if (fault === "mode") file.mode = 0o644;
		if (fault === "length") file.content = Buffer.from("{}");
		if (fault === "hash") file.content = Buffer.alloc(file.content.length, 0x61);
		if (fault === "missing") f.files.delete(f.blobs[2]);
		await expect(f.run()).rejects.toThrow();
		expect(f.requests).not.toContain(f.blobs[4]);
		expect(f.returned.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it.each(["claim.json", "manifest.json"])("refuses %s mutation after blob reads", async (name) => {
		const f = readerFixture();
		f.hooks.read = async (path) => {
			if (path === f.blobs.at(-1)) f.files.get(`${f.root}/${name}`)!.content = Buffer.from("{}");
		};
		await expect(f.run()).rejects.toThrow("history changed");
		expect(f.requests.filter((path) => f.blobs.includes(path))).toHaveLength(10);
		expect(f.returned.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});
});
