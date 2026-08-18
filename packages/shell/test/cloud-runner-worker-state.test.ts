import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileCloudRunnerAuthorityStore } from "../src/cloud-runner-worker-state.ts";

const temporaryDirectories: string[] = [];

async function authorityPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-runner-state-test-"));
	temporaryDirectories.push(root);
	return join(root, "private", "authority.json");
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("cloud runner authority state", () => {
	it("atomically persists and replaces private runner authority", async () => {
		const path = await authorityPath();
		const store = new FileCloudRunnerAuthorityStore(path);
		const initial: JsonValue = { schema: "test/v1", token: "first" };
		const replacement: JsonValue = { schema: "test/v1", token: "second", leases: [1, 2] };

		await store.save(initial);
		await expect(store.load()).resolves.toEqual(initial);
		await store.save(replacement);
		await expect(store.load()).resolves.toEqual(replacement);
		const metadata = await stat(path);
		if (process.platform === "linux") expect(metadata.mode & 0o777).toBe(0o600);
	});

	it("never exposes a partially written value during concurrent replacement", async () => {
		const path = await authorityPath();
		const store = new FileCloudRunnerAuthorityStore(path);
		const values: JsonValue[] = [
			{ schema: "test/v1", sequence: 1, body: "a".repeat(4096) },
			{ schema: "test/v1", sequence: 2, body: "b".repeat(4096) },
		];
		await Promise.all(values.map((value) => store.save(value)));
		const loaded = await store.load();
		expect(values).toContainEqual(loaded);
	});

	it("rejects malformed state and permissive Linux file modes", async () => {
		const path = await authorityPath();
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		await writeFile(path, "not-json\n", { encoding: "utf-8", mode: 0o600 });
		const store = new FileCloudRunnerAuthorityStore(path);
		await expect(store.load()).rejects.toThrow("invalid JSON");
		if (process.platform === "linux") {
			await chmod(path, 0o644);
			await expect(store.load()).rejects.toThrow("not private");
		}
	});

	it("requires an absolute state path", () => {
		expect(() => new FileCloudRunnerAuthorityStore("authority.json")).toThrow("path is invalid");
	});
});
