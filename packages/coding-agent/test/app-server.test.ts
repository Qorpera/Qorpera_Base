/**
 * Per-company app server (spec §7 v1): state API, surface serving with
 * traversal protection, and gate resolution through the UI endpoint.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompanyAppServer } from "../src/core/app-server.ts";
import { discoverAuthority, evaluateToolCall } from "../src/core/authority.ts";
import { scaffoldCompany } from "../src/core/company.ts";

let root: string;
let server: Server | undefined;
let base: string;

beforeEach(async () => {
	root = join(tmpdir(), `qorpera-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	scaffoldCompany(root);
	server = createCompanyAppServer({ root });
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
	const address = server!.address() as { port: number };
	base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("company app server", () => {
	it("serves chrome, live state, and surfaces as the controller builds them", async () => {
		const chrome = await (await fetch(`${base}/`)).text();
		expect(chrome).toContain("Controller — Qorpera Base");

		let state = (await (await fetch(`${base}/api/state`)).json()) as { surfaces: unknown[]; trailSessions: number };
		expect(state.surfaces).toEqual([]);

		// The controller builds a surface + registers it: it appears with no restart.
		writeFileSync(join(root, "app", "surfaces", "hello.html"), "<h1>live surface</h1>", "utf-8");
		writeFileSync(
			join(root, "app", "manifest.json"),
			JSON.stringify({ version: 1, surfaces: [{ name: "Hello", entry: "hello.html" }], routines: [] }),
			"utf-8",
		);
		state = (await (await fetch(`${base}/api/state`)).json()) as { surfaces: Array<{ name: string }> } as never;
		expect((state.surfaces[0] as { name: string }).name).toBe("Hello");

		const surface = await fetch(`${base}/surface/hello.html`);
		expect(await surface.text()).toContain("live surface");

		// Traversal out of app/surfaces is refused.
		const traversal = await fetch(`${base}/surface/..%2F..%2Fauthority.toml`);
		expect(traversal.status).toBe(403);
	});

	it("resolves gates from the inbox panel and approvals actually authorize", async () => {
		const authority = discoverAuthority(root)!;
		const first = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		expect(first.kind).toBe("block");
		const gateId = (first as { gateId: string }).gateId;

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			inbox: Array<{ file: string; status: string }>;
		};
		const gate = state.inbox.find((item) => item.file.startsWith(gateId));
		expect(gate?.status).toBe("pending");

		const post = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: gate!.file, action: "approved" }),
		});
		expect(post.status).toBe(200);
		expect(readFileSync(join(root, "inbox", gate!.file), "utf-8")).toContain("status: approved");

		// The approval is real: the same effect now proceeds (and is consumed).
		const second = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		expect(second.kind).toBe("allow");

		// Bad requests are refused.
		const bad = await fetch(`${base}/api/gate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "../authority.toml", action: "approved" }),
		});
		expect(bad.status).toBe(400);
	});
});
