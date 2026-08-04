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

	it("lists trail sessions and serves the controller↔founder message round-trip", async () => {
		// A trail session appears in state with its first user message as title.
		writeFileSync(
			join(root, "trail", "2026-08-04T10-00-00-000Z_abc.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "t", cwd: root }),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					message: { role: "user", content: [{ type: "text", text: "plan the pricing analysis" }] },
				}),
			].join("\n"),
			"utf-8",
		);
		// An agent-authored inbox message awaits the founder.
		writeFileSync(
			join(root, "inbox", "msg-pricing.md"),
			"# Pricing question\n\nWhich currency do customers pay in?\n",
			"utf-8",
		);

		// An autonomous session (tagged at spawn via --name) is distinguished.
		writeFileSync(
			join(root, "trail", "2026-08-04T11-00-00-000Z_auto.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "auto", timestamp: "t", cwd: root }),
				JSON.stringify({ type: "session_info", id: "s1", parentId: null, name: "autonomous — conception" }),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s1",
					message: { role: "user", content: [{ type: "text", text: "begin conception" }] },
				}),
			].join("\n"),
			"utf-8",
		);

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			sessions: Array<{ file: string; title: string; kind: string }>;
			inbox: Array<{ file: string; kind: string; status: string }>;
		};
		const chat = state.sessions.find((s) => s.file.includes("_abc"));
		const auto = state.sessions.find((s) => s.file.includes("_auto"));
		expect(chat?.title).toBe("plan the pricing analysis");
		expect(chat?.kind).toBe("chat");
		expect(auto?.kind).toBe("autonomous");
		expect(auto?.title).toBe("autonomous — conception");
		const message = state.inbox.find((item) => item.file === "msg-pricing.md");
		expect(message?.kind).toBe("message");
		expect(message?.status).toBe("pending");

		// Body is served; the founder's response lands in the file; status flips.
		const body = await (await fetch(`${base}/api/inbox/msg-pricing.md`)).text();
		expect(body).toContain("Which currency");
		const respond = await fetch(`${base}/api/inbox/respond`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ file: "msg-pricing.md", response: "DKK primarily, EUR later." }),
		});
		expect(respond.status).toBe(200);
		expect(readFileSync(join(root, "inbox", "msg-pricing.md"), "utf-8")).toContain("DKK primarily");
		const after = (await (await fetch(`${base}/api/state`)).json()) as {
			inbox: Array<{ file: string; status: string }>;
		};
		expect(after.inbox.find((item) => item.file === "msg-pricing.md")?.status).toBe("answered");

		// Traversal-shaped names are refused.
		const bad = await fetch(`${base}/api/inbox/..%2Fauthority.toml`);
		expect(bad.status).toBe(400);
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
