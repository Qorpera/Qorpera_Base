import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isRendererRequestAllowed } from "../src/renderer-boundary.ts";

const root = join(tmpdir(), `qorpera-renderer-boundary-${process.pid}`);

afterEach(() => {
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("renderer request boundary", () => {
	it("allows only the exact company backend origin during runtime", () => {
		const options = { backendOrigin: "http://127.0.0.1:4700", trustedFileRoot: root };
		expect(isRendererRequestAllowed("http://127.0.0.1:4700/api/state", options)).toBe(true);
		expect(isRendererRequestAllowed("blob:http://127.0.0.1:4700/asset", options)).toBe(true);
		expect(isRendererRequestAllowed("https://example.com/collect", options)).toBe(false);
		expect(isRendererRequestAllowed("ws://127.0.0.1:4700/socket", options)).toBe(false);
		expect(isRendererRequestAllowed("http://localhost:4700/api/state", options)).toBe(false);
		expect(isRendererRequestAllowed("blob:https://example.com/asset", options)).toBe(false);
	});

	it("limits hub file reads to physical files under the trusted userland", () => {
		const trusted = join(root, "trusted");
		const outsideDirectory = join(root, "outside");
		const outside = join(outsideDirectory, "outside.txt");
		mkdirSync(trusted, { recursive: true });
		mkdirSync(outsideDirectory, { recursive: true });
		writeFileSync(join(trusted, "index.html"), "trusted", "utf-8");
		writeFileSync(outside, "outside", "utf-8");
		symlinkSync(outsideDirectory, join(trusted, "linked"), process.platform === "win32" ? "junction" : "dir");
		const options = { trustedFileRoot: trusted };
		expect(isRendererRequestAllowed(pathToFileURL(join(trusted, "index.html")).href, options)).toBe(true);
		expect(isRendererRequestAllowed(pathToFileURL(outside).href, options)).toBe(false);
		expect(isRendererRequestAllowed(pathToFileURL(join(trusted, "linked", "outside.txt")).href, options)).toBe(false);
	});
});
