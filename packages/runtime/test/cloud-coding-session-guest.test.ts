import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodingGuestConfiguration,
	DEFAULT_CODING_GUEST_RESOURCES,
} from "../src/cloud-coding-guest-configuration.ts";
import {
	detachCloudCodingGuestSession,
	registerCodingSessionUser,
	removeCodingSessionUser,
} from "../src/cloud-coding-session-guest.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function guest(uid = 200000, workerId = randomUUID()): CodingGuestConfiguration {
	return {
		schema: "qorpera.coding-command-guest/v3",
		workerId,
		vmId: randomUUID(),
		bootId: randomUUID(),
		uid,
		gid: uid,
		workspacePath: `/workspace/${workerId}/repository`,
		homePath: `/workspace/${workerId}/home`,
		cachePath: `/workspace/${workerId}/cache`,
		outputRoot: `/var/lib/qorpera-coding/${workerId}/logs`,
		resourceProfile: { ...DEFAULT_CODING_GUEST_RESOURCES },
	};
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "coding-session-guest-"));
	roots.push(root);
	await chmod(root, 0o755);
	const userdbRoot = join(root, "userdb"),
		runtimeRoot = join(root, "session");
	const system = vi.fn(
		async (_executable: string, args: readonly string[]): Promise<string> =>
			args.includes("--property=LoadState")
				? "loaded\n"
				: args.includes("--property=ActiveState")
					? "inactive\n"
					: "",
	);
	const ports = { userdbRoot, runtimeRoot, protectedUid: process.getuid?.() ?? 0, system };
	return { root, userdbRoot, runtimeRoot, ports, system };
}

describe("a session's own guest user", () => {
	it("registers a boot-local userdb record for a session uid, once, and removes it", async () => {
		const f = await fixture();
		const g = guest();
		await registerCodingSessionUser(g, f.ports);
		await registerCodingSessionUser(g, f.ports);
		expect(JSON.parse(await readFile(join(f.userdbRoot, "qorpera-coding-200000.user"), "utf8"))).toEqual({
			userName: "qorpera-coding-200000",
			uid: 200000,
			gid: 200000,
			homeDirectory: g.homePath,
			shell: "/usr/sbin/nologin",
			disposition: "regular",
		});
		expect(JSON.parse(await readFile(join(f.userdbRoot, "qorpera-coding-200000.group"), "utf8"))).toEqual({
			groupName: "qorpera-coding-200000",
			gid: 200000,
			disposition: "regular",
		});
		expect(await readlink(join(f.userdbRoot, "200000.user"))).toBe("qorpera-coding-200000.user");
		expect(await readlink(join(f.userdbRoot, "200000.group"))).toBe("qorpera-coding-200000.group");
		expect((await lstat(join(f.userdbRoot, "qorpera-coding-200000.user"))).mode & 0o7777).toBe(0o644);
		await removeCodingSessionUser(200000, f.ports);
		await expect(lstat(join(f.userdbRoot, "200000.user"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(join(f.userdbRoot, "qorpera-coding-200000.group"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("never rewrites another record under the same uid", async () => {
		const f = await fixture();
		await registerCodingSessionUser(guest(), f.ports);
		await expect(registerCodingSessionUser(guest(), f.ports)).rejects.toThrow("USER_CHANGED");
	});
	it("leaves the image's own coding user alone and refuses a split uid and gid", async () => {
		const f = await fixture();
		await registerCodingSessionUser(guest(1100), f.ports);
		await expect(lstat(f.userdbRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(registerCodingSessionUser({ ...guest(), gid: 200001 }, f.ports)).rejects.toThrow("USER_INVALID");
	});
	it("refuses a record folder others may write", async () => {
		const f = await fixture();
		await mkdir(f.userdbRoot, { mode: 0o777 });
		await chmod(f.userdbRoot, 0o777);
		await expect(registerCodingSessionUser(guest(), f.ports)).rejects.toThrow("PATH_UNPROTECTED");
	});
});

describe("detaching a session inside its member's machine", () => {
	async function attached(f: Awaited<ReturnType<typeof fixture>>, g = guest()) {
		await mkdir(join(f.runtimeRoot, "configuration"), { recursive: true, mode: 0o755 });
		await chmod(f.runtimeRoot, 0o755);
		await writeFile(join(f.runtimeRoot, "configuration", "guest.json"), JSON.stringify(g), { mode: 0o444 });
		await writeFile(join(f.runtimeRoot, "lease.json"), "{}", { mode: 0o444 });
		await registerCodingSessionUser(g, f.ports);
		return g;
	}
	it("stops and sees stopped the session's slice, flushes, removes its boot-local state and user, then stops it again", async () => {
		const f = await fixture();
		const g = await attached(f);
		const slice = `qorpera-coding-${g.workerId.replaceAll("-", "")}.slice`;
		const stopped = [
			["/usr/bin/systemctl", ["show", slice, "--property=LoadState", "--value"]],
			["/usr/bin/systemctl", ["stop", slice]],
			["/usr/bin/systemctl", ["show", slice, "--property=ActiveState", "--value"]],
		];
		let removedBeforeSecondStop = false;
		f.system.mockImplementation(async (_executable, args) => {
			if (f.system.mock.calls.length === 5)
				removedBeforeSecondStop = await lstat(f.runtimeRoot).then(
					() => false,
					() => true,
				);
			return args.includes("--property=LoadState")
				? "loaded\n"
				: args.includes("--property=ActiveState")
					? "inactive\n"
					: "";
		});
		await detachCloudCodingGuestSession(g.workerId, f.ports);
		// A command started between the first stop and the removal stops with the second.
		expect(f.system.mock.calls).toEqual([...stopped, ["/usr/bin/sync", []], ...stopped]);
		expect(removedBeforeSecondStop).toBe(true);
		await expect(lstat(f.runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(join(f.userdbRoot, "200000.user"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("is repeatable: a session with no slice or state left detaches again", async () => {
		const f = await fixture();
		f.system.mockImplementation(async (_executable, args) =>
			args.includes("--property=LoadState") ? "not-found\n" : "",
		);
		await detachCloudCodingGuestSession(randomUUID(), f.ports);
		expect(f.system.mock.calls.map(([executable, args]) => [executable, args[0]])).toEqual([
			["/usr/bin/systemctl", "show"],
			["/usr/bin/sync", undefined],
			["/usr/bin/systemctl", "show"],
		]);
	});
	it("refuses to call a slice that did not stop detached, and keeps its state", async () => {
		const f = await fixture();
		const g = await attached(f);
		f.system.mockImplementation(async (_executable, args) =>
			args.includes("--property=LoadState")
				? "loaded\n"
				: args.includes("--property=ActiveState")
					? "deactivating\n"
					: "",
		);
		await expect(detachCloudCodingGuestSession(g.workerId, f.ports)).rejects.toThrow("STOP_UNCONFIRMED");
		expect((await lstat(join(f.runtimeRoot, "lease.json"))).isFile()).toBe(true);
	});
	it("refuses another session's configuration in its folder", async () => {
		const f = await fixture();
		await attached(f);
		await expect(detachCloudCodingGuestSession(randomUUID(), f.ports)).rejects.toThrow("SCOPE_CHANGED");
		expect(f.system).not.toHaveBeenCalled();
	});
	it.runIf(process.getuid?.() !== 0)("requires root without trusted ports", async () => {
		await expect(detachCloudCodingGuestSession(randomUUID())).rejects.toThrow("ROOT_REQUIRED");
	});
});
