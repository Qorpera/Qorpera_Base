import { describe, expect, it, vi } from "vitest";

// A console-subsystem child spawned from the GUI-subsystem shell (or its
// run-as-node kernel child) flashes a console window on Windows unless
// windowsHide is set. The wrappers must default it on for every call shape.
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: mocks.spawn, spawnSync: mocks.spawnSync };
});

const { spawn, spawnSync } = await import("../src/utils/child-process.ts");

describe("windowsHide-by-default spawn wrappers", () => {
	it("injects windowsHide into spawnSync(command, args, options)", () => {
		spawnSync("git", ["status"], { encoding: "utf-8", shell: false });
		expect(mocks.spawnSync).toHaveBeenCalledWith("git", ["status"], {
			windowsHide: true,
			encoding: "utf-8",
			shell: false,
		});
	});

	it("injects windowsHide into spawn(command, args, options)", () => {
		spawn("rg", ["--json"], { stdio: ["ignore", "pipe", "pipe"] });
		expect(mocks.spawn).toHaveBeenCalledWith("rg", ["--json"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("covers the options-without-args call shape", () => {
		spawnSync("git", { encoding: "utf-8" } as never);
		expect(mocks.spawnSync).toHaveBeenCalledWith("git", { windowsHide: true, encoding: "utf-8" });
	});

	it("covers the bare-command call shape", () => {
		spawn("clip");
		expect(mocks.spawn).toHaveBeenCalledWith("clip", { windowsHide: true });
	});

	it("lets an explicit windowsHide at the call site win", () => {
		spawn("cmd", ["/c", "start", "", "https://example.com"], { windowsHide: false });
		expect(mocks.spawn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "https://example.com"], {
			windowsHide: false,
		});
	});
});
