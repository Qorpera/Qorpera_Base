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
	server = createCompanyAppServer({ root, authToken: "test-token" });
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

	it("serves the surface design system, read-only kit, theme override, and substrate reads", async () => {
		// Tokens: every rendered markdown surface links the shared stylesheet
		// (not an inline hardcoded style) plus the company theme override.
		writeFileSync(join(root, "app", "surfaces", "notes.md"), "# Notes\ncontent", "utf-8");
		const rendered = await (await fetch(`${base}/surface/notes.md`)).text();
		expect(rendered).toContain('href="/assets/surface.css"');
		expect(rendered).toContain('href="/assets/theme.css"');
		expect(rendered).not.toContain("<style>");

		const css = await fetch(`${base}/assets/surface.css`);
		expect(css.headers.get("content-type")).toContain("text/css");
		expect(await css.text()).toContain("--bg: #2d2d2b");

		// Theme override: empty when absent, the company file when present.
		expect(await (await fetch(`${base}/assets/theme.css`)).text()).toBe("");
		writeFileSync(join(root, "app", "surfaces", "theme.css"), ":root { --accent: #35b8a5; }", "utf-8");
		expect(await (await fetch(`${base}/assets/theme.css`)).text()).toContain("#35b8a5");

		// The kit is read-only capability: state + substrate + inbox reads.
		const kit = await (await fetch(`${base}/assets/surface-kit.js`)).text();
		expect(kit).toContain("window.qorpera");
		expect(kit).not.toContain("x-qorpera-token");

		writeFileSync(join(root, "app", "substrates", "beliefs.md"), "price: 249 DKK (estimate)", "utf-8");
		const substrate = await fetch(`${base}/api/substrate/beliefs.md`);
		expect(await substrate.text()).toContain("249 DKK");

		// Traversal out of app/substrates is refused.
		const traversal = await fetch(`${base}/api/substrate/..%2F..%2Fauthority.toml`);
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

		// A founder-scoped chat carries its product scope in the session name.
		writeFileSync(
			join(root, "trail", "2026-08-04T12-00-00-000Z_scoped.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "scoped", timestamp: "t", cwd: root }),
				JSON.stringify({ type: "session_info", id: "s2", parentId: null, name: "scope — work/my-product" }),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s2",
					message: { role: "user", content: [{ type: "text", text: "fix the launcher" }] },
				}),
			].join("\n"),
			"utf-8",
		);

		// A sidechat carries its surface in the session name, and its title comes
		// from the founder's words — the chrome's context preamble is stripped.
		writeFileSync(
			join(root, "trail", "2026-08-04T13-00-00-000Z_sidechat.jsonl"),
			[
				JSON.stringify({ type: "session", version: 3, id: "sidechat", timestamp: "t", cwd: root }),
				JSON.stringify({ type: "session_info", id: "s3", parentId: null, name: "surface — revenue.html" }),
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: "s3",
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: '[Sidechat context: this chat is docked to the surface "Revenue" — app/surfaces/revenue.html. The founder is looking at it right now; orient from that file before answering.]\n\nwhy did July dip?',
							},
						],
					},
				}),
			].join("\n"),
			"utf-8",
		);

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			sessions: Array<{ file: string; title: string; kind: string; scope?: string; surface?: string }>;
			inbox: Array<{ file: string; kind: string; status: string }>;
		};
		const chat = state.sessions.find((s) => s.file.includes("_abc"));
		const auto = state.sessions.find((s) => s.file.includes("_auto"));
		const scoped = state.sessions.find((s) => s.file.includes("_scoped"));
		const sidechat = state.sessions.find((s) => s.file.includes("_sidechat"));
		expect(chat?.title).toBe("plan the pricing analysis");
		expect(chat?.kind).toBe("chat");
		expect(chat?.scope).toBeUndefined();
		expect(chat?.surface).toBeUndefined();
		expect(auto?.kind).toBe("autonomous");
		expect(auto?.title).toBe("autonomous — conception");
		expect(scoped?.kind).toBe("chat");
		expect(scoped?.scope).toBe("work/my-product");
		expect(scoped?.title).toBe("fix the launcher");
		expect(sidechat?.kind).toBe("chat");
		expect(sidechat?.surface).toBe("revenue.html");
		expect(sidechat?.title).toBe("why did July dip?");

		// The declared product zones ride along for the chrome's scope selector.
		writeFileSync(join(root, "authority.toml"), `[products]\nmode = "gate"\npaths = ["work/my-product"]\n`, "utf-8");
		const withScopes = (await (await fetch(`${base}/api/state`)).json()) as {
			scopes: Array<{ path: string; name: string; exists: boolean }>;
		};
		expect(withScopes.scopes).toEqual([{ path: "work/my-product", name: "my-product", exists: false }]);
		const message = state.inbox.find((item) => item.file === "msg-pricing.md");
		expect(message?.kind).toBe("message");
		expect(message?.status).toBe("pending");

		// Body is served; the founder's response lands in the file; status flips.
		const body = await (await fetch(`${base}/api/inbox/msg-pricing.md`)).text();
		expect(body).toContain("Which currency");
		const respond = await fetch(`${base}/api/inbox/respond`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
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
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
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
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
			body: JSON.stringify({ file: "../authority.toml", action: "approved" }),
		});
		expect(bad.status).toBe(400);
	});

	it("rejects mutations without the kernel token — the agent cannot curl its own approvals", async () => {
		const authority = discoverAuthority(root)!;
		const blocked = evaluateToolCall(authority, "bash", { command: "rm -rf work" }, root);
		const gateId = (blocked as { gateId: string }).gateId;
		const state = (await (await fetch(`${base}/api/state`)).json()) as { inbox: Array<{ file: string }> };
		const gateFile = state.inbox.find((item) => item.file.startsWith(gateId))!.file;

		for (const [path, payload] of [
			["/api/gate", { file: gateFile, action: "approved" }],
			["/api/inbox/respond", { file: gateFile, response: "yes" }],
			["/api/authority", { content: `[irreversible]\nmode = "auto"\n` }],
		] as const) {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(res.status, path).toBe(401);
		}
		// And the gate is still pending — nothing was authorized.
		expect(readFileSync(join(root, "inbox", gateFile), "utf-8")).toContain("status: pending");
		// The bash screen also gates any curl mention of these endpoints.
		expect(
			evaluateToolCall(authority, "bash", { command: `curl -X POST localhost:4700/api/gate -d approved` }, root)
				.kind,
		).toBe("block");
	});

	it("structured authority config: reads toggles, saves surgically, preserves [tools]", async () => {
		// Seed a custom [tools] section the structured editor must not clobber.
		writeFileSync(
			join(root, "authority.toml"),
			`[irreversible]\nmode = "gate"\n\n[products]\nmode = "gate"\npaths = ["work/old"]\n\n[tools]\ndeploy = "irreversible"\n`,
			"utf-8",
		);
		const cfg = (await (await fetch(`${base}/api/authority/config`)).json()) as {
			classes: Record<string, { mode: string }>;
			productPaths: string[];
		};
		expect(cfg.classes.irreversible.mode).toBe("gate");
		expect(cfg.productPaths).toEqual(["work/old"]);

		const save = await fetch(`${base}/api/authority/config`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
			body: JSON.stringify({
				classes: { irreversible: { mode: "notify" }, money: { mode: "gate", limitUsd: 100 } },
				productPaths: ["work/new-product"],
			}),
		});
		expect(save.status).toBe(200);
		const written = readFileSync(join(root, "authority.toml"), "utf-8");
		expect(written).toContain('deploy = "irreversible"'); // [tools] survived
		const authority = discoverAuthority(root)!;
		const config = (await import("../src/core/authority.ts")).readAuthorityConfig(authority);
		expect(config.classes.irreversible.mode).toBe("notify");
		expect(config.classes.money.limitUsd).toBe(100);
		expect(config.productPaths).toEqual(["work/new-product"]);
		expect(config.classes.authority.mode).toBe("gate"); // never configurable
	});

	it("authority editor endpoint: reads, rejects invalid TOML, applies valid edits", async () => {
		const current = await (await fetch(`${base}/api/authority`)).text();
		expect(current).toContain("[irreversible]");

		const invalid = await fetch(`${base}/api/authority`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
			body: JSON.stringify({ content: "not [valid toml" }),
		});
		expect(invalid.status).toBe(400);

		const valid = await fetch(`${base}/api/authority`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-qorpera-token": "test-token" },
			body: JSON.stringify({ content: `[irreversible]\nmode = "notify"\n` }),
		});
		expect(valid.status).toBe(200);
		const authority = discoverAuthority(root)!;
		expect(evaluateToolCall(authority, "bash", { command: "rm -rf scratch" }, root).kind).toBe("allow");
	});
});
