import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	COMPANY_COMPUTER_BROWSER_REQUEST_FILE,
	CompanyComputerLinuxDesktopLauncher,
	takeCompanyComputerBrowserRequest,
} from "@qorpera/runtime/cloud-company-computer-linux-desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function fixture() {
	return {
		scope: computerScope(),
		computerGeneration: 1,
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		workbenchMount: { filesystem: "nfs4", source: "192.0.2.90:/workbench", root: "/", mountPoint: "/srv/workbench" },
		limits: { memoryBytes: 1073741824, pids: 256, cpuQuota: 200000, cpuPeriod: 100000 },
		runtimeRoot: "/run/office-screens",
		boundary: { assertReady: vi.fn(async () => undefined) },
	};
}

afterEach(() => vi.useRealTimers());
describe("Linux desktop admission (real XFCE lifecycle uses the explicit Linux probe)", () => {
	it("drains pending startup before a handle exists and rejects a substituted binding", async () => {
		vi.useFakeTimers();
		const options = fixture();
		options.boundary.assertReady.mockImplementation(() => new Promise(() => {}));
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		const starting = launcher.launch(computerBinding(), new AbortController().signal).catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		await expect(launcher.drain({ ...computerBinding(), screenId: computerId(99) })).rejects.toThrow(
			"SCREEN_BINDING_MISMATCH",
		);
		let drained = false;
		const draining = launcher.drain(computerBinding()).then(() => {
			drained = true;
		});
		expect(drained).toBe(false);
		await vi.advanceTimersByTimeAsync(5001);
		expect(await starting).toBeInstanceOf(Error);
		await draining;
		expect(drained).toBe(true);
		await launcher.close();
		await expect(launcher.drain(computerBinding())).resolves.toBeUndefined();
	});
	it("requires a canonical private runtime path disjoint from every persistent root", () => {
		for (const runtimeRoot of [
			"/",
			"relative",
			"/run//screens",
			"/run/../screens",
			"/run/screens/",
			"/srv/workbench/tmp",
			"/srv",
			"/run/a\0b",
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), runtimeRoot })).toThrow(
				"UNSAFE_OFFICE_CONTROL_PATH",
			);
	});
	it("requires a finite admitted allocation, exact mount identity and positive generation", () => {
		for (const computerGeneration of [0, -1, 1.5, Infinity])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), computerGeneration })).toThrow(
				"INVALID_OFFICE_GENERATION",
			);
		for (const limits of [
			{ ...fixture().limits, pids: 0 },
			{ ...fixture().limits, cpuQuota: Infinity },
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), limits })).toThrow(
				"INVALID_OFFICE_COMMAND_LIMITS",
			);
		for (const workbenchMount of [
			{ ...fixture().workbenchMount, source: "" },
			{ ...fixture().workbenchMount, root: "/a\nb" },
		])
			expect(() => new CompanyComputerLinuxDesktopLauncher({ ...fixture(), workbenchMount })).toThrow(
				"INVALID_OFFICE_WORKBENCH_MOUNT",
			);
	});
	it("rejects another company's binding or a stale computer before any guest access", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		try {
			await expect(
				launcher.launch({ ...computerBinding(), companyId: computerId(900) }, new AbortController().signal),
			).rejects.toThrow("COMPUTER_BINDING_MISMATCH");
			await expect(
				launcher.launch({ ...computerBinding(), computerGeneration: 2 }, new AbortController().signal),
			).rejects.toThrow("OFFICE_GENERATION_MISMATCH");
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await launcher.close();
		}
	});
	it("refuses paths and RFB connections before exact desktop readiness", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		try {
			expect(() => launcher.xSocket(computerBinding())).toThrow("OFFICE_DESKTOP_NOT_READY");
			await expect(launcher.connectRfb(computerBinding(), new AbortController().signal)).rejects.toThrow(
				"OFFICE_DESKTOP_NOT_READY",
			);
			expect(options.boundary.assertReady).not.toHaveBeenCalled();
		} finally {
			await launcher.close();
		}
	});
	it("does not launch after a pre-cancelled request or completed service close", async () => {
		const options = fixture();
		const launcher = new CompanyComputerLinuxDesktopLauncher(options);
		const stop = new AbortController();
		stop.abort();
		await expect(launcher.launch(computerBinding(), stop.signal)).rejects.toThrow();
		await launcher.close();
		await launcher.close();
		await expect(launcher.launch(computerBinding(), new AbortController().signal)).rejects.toThrow();
		expect(options.boundary.assertReady).not.toHaveBeenCalled();
	});
});

describe("dock browser request (an empty file in the service-owned session directory)", () => {
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});
	async function session() {
		const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-browser-request-"));
		roots.push(root);
		const directory = join(root, "session");
		await mkdir(directory);
		return { root, directory, request: join(directory, COMPANY_COMPUTER_BROWSER_REQUEST_FILE) };
	}

	it("is consumed exactly once and carries nothing", async () => {
		const f = await session();
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		await writeFile(f.request, "");
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(true);
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		expect(await readdir(f.directory)).toEqual([]);
		// Content is never read: a request with bytes in it is the same request.
		await writeFile(f.request, "https://example.test/ --profile-directory=/srv/profiles/other");
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(true);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("never follows a link and never descends into a directory the desktop put at the name", async () => {
		const f = await session();
		const outside = join(f.root, "outside");
		await writeFile(outside, "service-owned bytes");
		await symlink(outside, f.request);
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		expect(await readFile(outside, "utf8")).toBe("service-owned bytes");
		expect(await readdir(f.directory)).toEqual([]);
		// An empty directory is only an entry and is removed; it was never a request.
		await mkdir(f.request);
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		expect(await readdir(f.directory)).toEqual([]);
		// A non-empty directory is left exactly as it is: nothing inside it, and
		// nothing a link inside it points to, is ever removed.
		const tree = join(f.root, "tree");
		await mkdir(tree);
		await writeFile(join(tree, "kept"), "kept");
		await mkdir(f.request);
		await writeFile(join(f.request, "inner"), "inner");
		await symlink(tree, join(f.request, "link"));
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		expect(await readFile(join(tree, "kept"), "utf8")).toBe("kept");
		expect((await readdir(f.request)).sort()).toEqual(["inner", "link"]);
		// It only blocks further dock requests on this desktop.
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
	});

	it("removes a fifo as an entry without ever opening it", async () => {
		const f = await session();
		await promisify(execFile)("mkfifo", [f.request]);
		// Opening a fifo without a writer would block forever; this returns.
		expect(await takeCompanyComputerBrowserRequest(f.directory)).toBe(false);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("touches nothing outside the entry when the desktop swaps it between the look and the removal", async () => {
		const f = await session();
		const tree = join(f.root, "service-data");
		await mkdir(tree);
		await writeFile(join(tree, "kept"), "kept");
		const outside = join(f.root, "outside");
		await writeFile(outside, "service-owned bytes");
		const intact = async () => {
			expect(await readFile(join(tree, "kept"), "utf8")).toBe("kept");
			expect(await readFile(outside, "utf8")).toBe("service-owned bytes");
		};
		// Looked like a non-empty directory, became a link to service data.
		await mkdir(f.request);
		await writeFile(join(f.request, "inner"), "inner");
		expect(
			await takeCompanyComputerBrowserRequest(f.directory, async () => {
				await rm(f.request, { recursive: true });
				await symlink(tree, f.request);
			}),
		).toBe(false);
		await intact();
		await rm(f.request, { force: true });
		// Looked like a request, became a link to a directory, then to a file.
		for (const target of [tree, outside]) {
			await writeFile(f.request, "");
			expect(
				await takeCompanyComputerBrowserRequest(f.directory, async () => {
					await rm(f.request);
					await symlink(target, f.request);
				}),
			).toBe(true);
			await intact();
			expect(await readdir(f.directory)).toEqual([]);
		}
		// Looked like a request, became a populated directory: left alone.
		await writeFile(f.request, "");
		expect(
			await takeCompanyComputerBrowserRequest(f.directory, async () => {
				await rm(f.request);
				await mkdir(f.request);
				await symlink(tree, join(f.request, "link"));
			}),
		).toBe(false);
		await intact();
		expect(await readdir(f.request)).toEqual(["link"]);
	});
});
