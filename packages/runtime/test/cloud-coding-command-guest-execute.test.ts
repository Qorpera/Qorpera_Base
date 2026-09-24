import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CODING_GUEST_REFUSED_EXIT_CODE,
	type CodingGuestCommandPorts,
	codingCommandWritablePaths,
	executeCodingGuestCommand,
} from "../src/cloud-coding-command-guest.ts";
import type { CodingGuestConfiguration } from "../src/cloud-coding-guest-configuration.ts";
import type { CodingGuestSandbox } from "../src/cloud-coding-storage-guest.ts";

// The execute step runs inside the command unit as the coding uid. These tests
// cover its refusal before the command starts; they need no chown, so they run
// under any test uid.
const roots: string[] = [];
beforeEach(() => {
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-command-execute-")));
	roots.push(root);
	const commandId = randomUUID();
	for (const name of ["commands", "logs", "repository", "home", "cache"])
		await mkdir(join(root, name), { mode: 0o755 });
	await mkdir(join(root, "logs", commandId), { mode: 0o755 });
	// The root supervisor pre-creates the empty log owned by the coding uid.
	const log = join(root, "logs", commandId, "output.log");
	await writeFile(log, "", { mode: 0o600 });
	const guest = {
		schema: "qorpera.coding-command-guest/v2",
		workerId: randomUUID(),
		vmId: randomUUID(),
		bootId: randomUUID(),
		uid: Math.max(1000, process.getuid?.() ?? 1000),
		gid: Math.max(1000, process.getgid?.() ?? 1000),
		workspacePath: join(root, "repository"),
		homePath: join(root, "home"),
		cachePath: join(root, "cache"),
		outputRoot: join(root, "logs"),
		resourceProfile: {
			maxTimeoutMs: 1800000,
			memoryBytes: 2147483648,
			tasksMax: 256,
			cpuQuotaPercent: 200,
			maxLogBytes: 67108864,
		},
	};
	const configurationPath = join(root, "guest.json");
	await writeFile(configurationPath, JSON.stringify(guest), { mode: 0o444 });
	const sandboxes: (CodingGuestSandbox | undefined)[] = [];
	let refusal: unknown = new Error("CODING_GUEST_STORAGE_MOUNT_INVALID");
	const ports: CodingGuestCommandPorts = {
		root,
		configurationPath,
		protectedUid: process.getuid?.() ?? 0,
		protectedDirectoryRoot: root,
		inspectMachine: async () => guest.bootId,
		assertStorage: async (_guest: CodingGuestConfiguration, sandbox?: CodingGuestSandbox) => {
			sandboxes.push(sandbox);
			throw refusal;
		},
	};
	return {
		root,
		commandId,
		log,
		guest,
		ports,
		sandboxes,
		refuseWith: (error: unknown) => {
			refusal = error;
		},
	};
}

describe("coding command execute step refused before the command starts", () => {
	it("exits 125 with only the fixed code in the command's log", async () => {
		const f = await fixture();
		expect(await executeCodingGuestCommand(f.commandId, f.ports)).toBe(CODING_GUEST_REFUSED_EXIT_CODE);
		expect(CODING_GUEST_REFUSED_EXIT_CODE).toBe(125);
		expect(await readFile(f.log, "utf8")).toBe("CODING_GUEST_STORAGE_MOUNT_INVALID\n");
		// The same code reaches the unit's journal (StandardError=journal).
		expect(process.stderr.write).toHaveBeenCalledWith(
			"CODING_GUEST_COMMAND_REFUSED CODING_GUEST_STORAGE_MOUNT_INVALID\n",
		);
	});
	it("asserts storage against exactly the unit's ReadWritePaths", async () => {
		const f = await fixture();
		await executeCodingGuestCommand(f.commandId, f.ports);
		const paths = codingCommandWritablePaths(f.guest as CodingGuestConfiguration, f.commandId);
		expect(f.sandboxes).toEqual([{ writablePaths: paths }]);
		expect(paths).toEqual([
			f.guest.workspacePath,
			f.guest.homePath,
			f.guest.cachePath,
			join(f.guest.outputRoot, f.commandId),
		]);
	});
	it.each([
		[
			"free text",
			new Error("token ghp_abcdefghijklmnopqrstuvwxyz0123 at /workspace/repository/.env"),
			"UNCLASSIFIED",
		],
		[
			"a coded reason",
			new Error("CODING_HOST_MACHINE_REFUSED:MACHINE_CAPACITY_EXHAUSTED"),
			"CODING_HOST_MACHINE_REFUSED:MACHINE_CAPACITY_EXHAUSTED",
		],
		[
			"a system error",
			Object.assign(new Error("EROFS: read-only file system, open '/workspace/x'"), { code: "EROFS" }),
			"ERRNO:EROFS",
		],
		["a non-error", "CODING_GUEST_X", "UNCLASSIFIED"],
	])("writes only a safe code for %s", async (_case, error, code) => {
		const f = await fixture();
		f.refuseWith(error);
		expect(await executeCodingGuestCommand(f.commandId, f.ports)).toBe(125);
		expect(await readFile(f.log, "utf8")).toBe(`${code}\n`);
	});
	it("reports an unreadable configuration by its errno code", async () => {
		const f = await fixture();
		await rm(f.ports.configurationPath!);
		expect(await executeCodingGuestCommand(f.commandId, f.ports)).toBe(125);
		expect(await readFile(f.log, "utf8")).toBe("ERRNO:ENOENT\n");
		expect(f.sandboxes).toEqual([]);
	});
	it("never appends to output that already exists", async () => {
		const f = await fixture();
		await writeFile(f.log, "partial output");
		expect(await executeCodingGuestCommand(f.commandId, f.ports)).toBe(125);
		expect(await readFile(f.log, "utf8")).toBe("partial output");
	});
	it("never follows a replaced log or creates a missing one", async () => {
		const f = await fixture();
		const outside = join(f.root, "outside.log");
		await writeFile(outside, "");
		await rm(f.log);
		await symlink(outside, f.log);
		expect(await executeCodingGuestCommand(f.commandId, f.ports)).toBe(125);
		expect(await readFile(outside, "utf8")).toBe("");
		const g = await fixture();
		await rm(join(g.root, "logs", g.commandId), { recursive: true });
		expect(await executeCodingGuestCommand(g.commandId, g.ports)).toBe(125);
		expect(await readdir(join(g.root, "logs"))).toEqual([]);
	});
	it("writes nothing for an invalid command id", async () => {
		const f = await fixture();
		expect(await executeCodingGuestCommand("../logs", f.ports)).toBe(125);
		expect(await readFile(f.log, "utf8")).toBe("");
		expect(f.sandboxes).toEqual([]);
	});
});
