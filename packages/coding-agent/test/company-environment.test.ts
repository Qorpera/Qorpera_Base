/**
 * Environment operations (Build 5): snapshot, restore, fork, erase, and
 * trail playback/verification — on the export substrate, with severed
 * authority proven structurally.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimCompanyRuntimeLock,
	eraseCompany,
	forkCompany,
	listSnapshots,
	releaseCompanyRuntimeLock,
	restoreCompany,
	scaffoldCompany,
	snapshotCompany,
	snapshotsDir,
	validateCompanyKernelStorage,
	verifyTrailFile,
} from "../src/core/company.ts";
import { bindCompanySecret, companyConnectionsPath, readCompanyConnections } from "../src/core/company-connections.ts";

let root: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-env-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	prevAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	process.env.QORPERA_CODING_AGENT_DIR = `${root}-agent-home`;
	scaffoldCompany(root);
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = prevAgentDir;
	for (const dir of [root, `${root}-agent-home`, `${root}-fork`]) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("snapshot and restore", () => {
	it("captures, lists, and restores the environment with a pre-restore safety snapshot", () => {
		writeFileSync(join(root, "departments", "note.md"), "v1\n", "utf-8");
		const snapshot = snapshotCompany(root, "Before Changes!");
		expect(snapshot.id).toMatch(/_before-changes$/);
		expect(existsSync(join(snapshot.path, "export-manifest.json"))).toBe(true);
		expect(listSnapshots(root).map((record) => record.id)).toContain(snapshot.id);

		writeFileSync(join(root, "departments", "note.md"), "v2\n", "utf-8");
		writeFileSync(join(root, "departments", "stray.md"), "stray\n", "utf-8");
		const result = restoreCompany(root, snapshot.id);
		expect(readFileSync(join(root, "departments", "note.md"), "utf-8")).toBe("v1\n");
		expect(existsSync(join(root, "departments", "stray.md"))).toBe(false);
		validateCompanyKernelStorage(root);
		// The replaced state was captured first: restore is reversible.
		const safety = listSnapshots(root).find((record) => record.id === result.safetySnapshot);
		expect(safety).toBeDefined();
		expect(readFileSync(join(safety!.path, "company", "departments", "note.md"), "utf-8")).toBe("v2\n");
	});

	it("refuses to snapshot a live environment", () => {
		const lock = claimCompanyRuntimeLock(root);
		try {
			expect(() => snapshotCompany(root)).toThrow(/already owned/);
		} finally {
			releaseCompanyRuntimeLock(lock);
		}
	});
});

describe("fork", () => {
	it("carries files, history, and lineage — and structurally no credentials or bindings", () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		writeFileSync(join(root, "departments", "work.md"), "state\n", "utf-8");
		const target = `${root}-fork`;

		const result = forkCompany(root, target);
		validateCompanyKernelStorage(target);
		expect(readFileSync(join(target, "departments", "work.md"), "utf-8")).toBe("state\n");
		const lineage = JSON.parse(readFileSync(join(target, ".qorpera", "lineage.json"), "utf-8"));
		expect(lineage.forkedFrom.head).toBe(result.manifest.sourceHead);
		const log = spawnSync("git", ["-C", target, "log", "-1", "--format=%B"], { encoding: "utf-8" });
		expect(log.stdout).toContain("record fork lineage");
		// Severed authority: the fork's machine-local stores start empty.
		expect(readCompanyConnections(target).secretNames).toEqual([]);
		expect(readCompanyConnections(root).secretNames).toEqual(["api-key"]);
	});
});

describe("erase", () => {
	it("removes the folder and every machine-local record for it", () => {
		bindCompanySecret(root, "api-key", { kind: "static", value: "raw-value" });
		snapshotCompany(root, "kept-until-erase");
		const connections = companyConnectionsPath(root);
		const snapshots = snapshotsDir(root);
		expect(existsSync(connections)).toBe(true);
		expect(existsSync(snapshots)).toBe(true);

		const result = eraseCompany(root);
		expect(existsSync(root)).toBe(false);
		expect(existsSync(connections)).toBe(false);
		expect(existsSync(snapshots)).toBe(false);
		expect(result.removed.length).toBe(3);
	});

	it("refuses to erase anything that is not a company", () => {
		const plain = join(tmpdir(), `qorpera-env-plain-${Date.now()}`);
		mkdirSync(plain, { recursive: true });
		try {
			expect(() => eraseCompany(plain)).toThrow();
			expect(existsSync(plain)).toBe(true);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("trail verification (playback is inspection)", () => {
	function chained(entries: Array<Record<string, unknown>>): string {
		const header = { type: "session", version: 5, id: "s1", timestamp: "2026-08-10T12:00:00.000Z", cwd: root };
		const lines = [JSON.stringify(header)];
		let lastHash = "";
		for (const [index, unsigned] of entries.entries()) {
			const hash = createHash("sha256")
				.update(`${lastHash}\n${JSON.stringify(unsigned)}`)
				.digest("hex");
			lines.push(
				JSON.stringify({
					...unsigned,
					kernel: { sequence: index + 1, receivedAt: unsigned.timestamp, previousHash: lastHash || null, hash },
				}),
			);
			lastHash = hash;
		}
		return `${lines.join("\n")}\n`;
	}

	const entry = (id: string, text: string) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-10T12:00:01.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
		provenance: { source: "child", trust: "assertion" },
	});

	it("verifies an intact kernel chain and detects tampering", () => {
		const path = join(root, "trail", "chained.jsonl");
		writeFileSync(path, chained([entry("e1", "first"), entry("e2", "second")]), "utf-8");
		expect(verifyTrailFile(path)).toMatchObject({ status: "verified", entries: 2 });

		// One flipped byte in recorded content breaks the chain.
		writeFileSync(path, chained([entry("e1", "first"), entry("e2", "second")]).replace("first", "farst"), "utf-8");
		const tampered = verifyTrailFile(path);
		expect(tampered.status).toBe("broken");
		expect(tampered.detail).toContain("integrity break");
	});

	it("reports sessions without kernel envelopes as unaudited, not broken", () => {
		const path = join(root, "trail", "plain.jsonl");
		const header = { type: "session", version: 5, id: "s2", timestamp: "2026-08-10T12:00:00.000Z", cwd: root };
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry("e1", "hello"))}\n`, "utf-8");
		expect(verifyTrailFile(path)).toMatchObject({ status: "unaudited", entries: 1 });
	});
});
