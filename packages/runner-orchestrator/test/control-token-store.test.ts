import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRunnerOrchestratorControlTokenStore } from "../src/control-token-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runner orchestrator control token store", () => {
	it("persists bootstrap and ambiguous rotation state across restarts", async () => {
		const directory = await mkdtemp(join(await realpath(tmpdir()), "qorpera-orchestrator-control-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "control.json");
		const current = "a".repeat(43);
		const pending = "b".repeat(43);
		const store = new FileRunnerOrchestratorControlTokenStore(path);

		await expect(store.load(current)).resolves.toEqual({ current });
		await store.save({ current, pending });
		await expect(new FileRunnerOrchestratorControlTokenStore(path).load("c".repeat(43))).resolves.toEqual({
			current,
			pending,
		});
		await store.save({ current: pending });
		await expect(new FileRunnerOrchestratorControlTokenStore(path).load(current)).resolves.toEqual({
			current: pending,
		});
		expect(await readFile(path, "utf-8")).not.toContain(current);
	});
});
