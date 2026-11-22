import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedAbortScope, withAbortScopes } from "../src/abort-scope.ts";
import { WebMemberAccount } from "../src/account.ts";
import { mountMemberWeb } from "../src/app.ts";
import { webAuthStorage } from "../src/auth.ts";
import type { MemberWebConfig } from "../src/config.ts";
import { WebFileDownloads } from "../src/files.ts";
import { showOfficePanel } from "../src/office-panel.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scopeFixture = {
	companyId: id(10),
	environmentId: id(11),
	companyComputerId: id(12),
	logicalComputerId: id(13),
};
const config: MemberWebConfig = {
	schema: "qorpera.member-web-config/v1",
	supabaseUrl: "https://control.test",
	publishableKey: "sb_publishable_fixture1",
	officeViewerOrigin: "wss://views.test",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

class FakeNode {
	readonly tag: string;
	textContent = "";
	type = "";
	value = "";
	autocomplete = "";
	required = false;
	hidden = false;
	disabled = false;
	inert = false;
	checked = false;
	maxLength = 0;
	href = "";
	download = "";
	onclick?: () => void;
	onchange?: () => void;
	readonly children: FakeNode[] = [];
	readonly attrs = new Map<string, string>();
	reportValidity = vi.fn(() => true);
	click = vi.fn(() => {
		this.onclick?.();
	});
	remove = vi.fn();
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	append(...nodes: FakeNode[]): void {
		this.children.push(...nodes);
		if (this.tag === "select" && !this.value && nodes[0]?.value) this.value = nodes[0].value;
	}
	replaceChildren(...nodes: FakeNode[]): void {
		this.children.splice(0, this.children.length, ...nodes);
		if (this.tag === "select") this.value = nodes[0]?.value ?? "";
	}
	findAll(predicate: (node: FakeNode) => boolean): FakeNode[] {
		const found: FakeNode[] = [];
		const walk = (node: FakeNode) => {
			if (predicate(node)) found.push(node);
			for (const child of node.children) walk(child);
		};
		walk(this);
		return found;
	}
}

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installFakeDom() {
	const body = new FakeNode("body");
	const fakeDocument = {
		body,
		createElement: (tag: string) => new FakeNode(tag),
	};
	const fakeWindow = {
		location: { origin: "https://member.test", assign: vi.fn(), replace: vi.fn() },
		qorperaScreenViewer: undefined as unknown,
	};
	(globalThis as unknown as { document: unknown }).document = fakeDocument;
	(globalThis as unknown as { window: unknown }).window = fakeWindow;
	return { body, fakeDocument, fakeWindow };
}

afterEach(() => {
	(globalThis as unknown as { document: unknown }).document = originalDocument;
	(globalThis as unknown as { window: unknown }).window = originalWindow;
	vi.restoreAllMocks();
});

describe("member-web abort-scope, storage, downloads, and office lifecycle", () => {
	it("detaches listeners from parent signals on linkedAbortScope.dispose and withAbortScopes exit", async () => {
		const parent = new AbortController();
		const addSpy = vi.spyOn(parent.signal, "addEventListener");
		const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
		const linked = linkedAbortScope([parent.signal]);
		expect(addSpy).toHaveBeenCalledTimes(1);
		linked.dispose();
		expect(linked.signal.aborted).toBe(true);
		expect(removeSpy).toHaveBeenCalledTimes(1);

		const value = await withAbortScopes([parent.signal], async (scoped) => {
			expect(scoped.aborted).toBe(false);
			return 42;
		});
		expect(value).toBe(42);
		expect(addSpy).toHaveBeenCalledTimes(2);
		expect(removeSpy).toHaveBeenCalledTimes(2);
	});

	it("webAuthStorage.clear uses Storage.length and Storage.key instead of Object.keys", () => {
		const map = new Map<string, string>([
			["qorpera.member-web.auth", "token"],
			["qorpera.member-web.auth-code-verifier", "pkce"],
			["unrelated-app-key", "keep"],
		]);
		const storage: Storage = {
			get length() {
				return map.size;
			},
			key(index: number) {
				return [...map.keys()][index] ?? null;
			},
			getItem(key: string) {
				return map.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				map.set(key, value);
			},
			removeItem(key: string) {
				map.delete(key);
			},
			clear() {
				map.clear();
			},
		};
		expect(Object.keys(storage)).not.toContain("qorpera.member-web.auth");
		webAuthStorage(storage).clear();
		expect(map.has("qorpera.member-web.auth")).toBe(false);
		expect(map.has("qorpera.member-web.auth-code-verifier")).toBe(false);
		expect(map.get("unrelated-app-key")).toBe("keep");
	});

	it("WebFileDownloads removes its abort listener on close and copies whole bytes cleanly", async () => {
		installFakeDom();
		const createdBlobs: Blob[] = [];
		const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
			createdBlobs.push(blob as Blob);
			return `blob:test-${createdBlobs.length}`;
		});
		const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
		const stop = new AbortController();
		const removeSpy = vi.spyOn(stop.signal, "removeEventListener");
		const downloads = new WebFileDownloads({ current: () => undefined, signal: stop.signal });
		const source = new Uint8Array([1, 2, 3, 4]);
		downloads.offer("dir/report.bin", source);
		source[0] = 99;
		expect(createUrl).toHaveBeenCalledOnce();
		expect(new Uint8Array(await createdBlobs[0].arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
		downloads.close();
		expect(removeSpy).toHaveBeenCalledOnce();
		expect(revokeUrl).toHaveBeenCalledWith("blob:test-1");
	});

	it("bootstraps office panel in parallel and resets startId after confirmed cancel while preserving it on retry", async () => {
		installFakeDom();
		const startGate = deferred<Response>();
		const accessGate = deferred<Response>();
		const viewsGate = deferred<Response>();
		const privacyGate = deferred<Response>();
		const started: string[] = [];
		const startRequestIds: string[] = [];
		let failFirstStart = true;
		let intent: null | {
			schema: string;
			intentId: string;
			companyComputerId: string;
			computerGeneration: number;
			state: string;
		} = null;
		const session = { user: { id: id(1) }, access_token: "member-1" } as Session;
		const account = new WebMemberAccount({
			config,
			client: {
				auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) },
			} as unknown as SupabaseClient,
			fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = url.split("/").at(-1)!;
				if (method === "qorpera_list_hosted_profiles") {
					return Response.json([
						{
							profile_id: id(10),
							environment_id: id(11),
							profile_name: "Alpha",
							environment_name: "Main",
							role: "owner",
							contract_version: 1,
							created_at: "2026-09-08T00:00:00Z",
							bootstrap_state: "completed",
						},
					]);
				}
				if (method === "qorpera_member_office_catalog") {
					return Response.json({
						companyId: id(10),
						environmentId: id(11),
						canManage: true,
						scope: scopeFixture,
						staff: [{ staffAgentId: id(14), name: "Analyst" }],
						nextAfter: null,
					});
				}
				if (method === "qorpera_runtime_office_start_status" && started.indexOf(method) === -1) {
					started.push(method);
					return startGate.promise;
				}
				if (method === "qorpera_runtime_office_start_status") {
					return Response.json({
						scope: scopeFixture,
						computerGeneration: 1,
						officeState: "provisioning",
						intent,
					});
				}
				if (method === "qorpera_runtime_office_access_status") {
					if (!started.includes(method)) {
						started.push(method);
						return accessGate.promise;
					}
					return Response.json({
						schema: "qorpera.office-access-status/v1",
						scope: scopeFixture,
						staffAgentId: id(14),
						grant: null,
					});
				}
				if (method === "qorpera_runtime_office_member_status") {
					if (!started.includes(method)) {
						started.push(method);
						return viewsGate.promise;
					}
					return Response.json({
						scope: scopeFixture,
						computerGeneration: 1,
						state: "provisioning",
						privacyState: "shared",
						privacyVersion: 0,
						screens: [],
						viewers: [],
					});
				}
				if (method === "qorpera_runtime_office_privacy_status") {
					if (!started.includes(method)) {
						started.push(method);
						return privacyGate.promise;
					}
					return Response.json({
						scope: scopeFixture,
						computerGeneration: 1,
						state: "shared",
						version: 0,
						challenge: null,
					});
				}
				if (method === "qorpera_member_browser_profiles") {
					return Response.json({
						scope: scopeFixture,
						memberId: id(1),
						canUse: true,
						profiles: [],
						nextAfter: null,
					});
				}
				if (method === "qorpera_request_runtime_office_start") {
					const body = JSON.parse(String(init?.body)) as { p_request_id: string };
					startRequestIds.push(body.p_request_id);
					if (failFirstStart) {
						failFirstStart = false;
						return new Response(null, { status: 503 });
					}
					intent = {
						schema: "qorpera.office-start-intent/v1",
						intentId: body.p_request_id,
						companyComputerId: id(12),
						computerGeneration: 1,
						state: "requested",
					};
					return Response.json(intent);
				}
				if (method === "qorpera_cancel_runtime_office_start") {
					const cancelled = { ...intent!, state: "cancelled" };
					intent = null;
					return Response.json(cancelled);
				}
				throw new Error(`Unexpected RPC ${method}`);
			}),
		});
		account.setSession(session);
		await account.companies();
		const company = account.openCompany(id(11));
		const root = new FakeNode("div");
		let pendingAction: Promise<void> = Promise.resolve();
		const work = (action: () => Promise<void>) => {
			pendingAction = action().catch(() => undefined);
			return pendingAction;
		};
		const panelPromise = showOfficePanel({
			root: root as unknown as HTMLElement,
			company,
			work,
			status: () => undefined,
			current: () => undefined,
		});
		await vi.waitFor(() => expect(started).toHaveLength(4));
		expect(new Set(started)).toEqual(
			new Set([
				"qorpera_runtime_office_start_status",
				"qorpera_runtime_office_access_status",
				"qorpera_runtime_office_member_status",
				"qorpera_runtime_office_privacy_status",
			]),
		);
		startGate.resolve(
			Response.json({ scope: scopeFixture, computerGeneration: 1, officeState: "provisioning", intent: null }),
		);
		accessGate.resolve(
			Response.json({
				schema: "qorpera.office-access-status/v1",
				scope: scopeFixture,
				staffAgentId: id(14),
				grant: null,
			}),
		);
		viewsGate.resolve(
			Response.json({
				scope: scopeFixture,
				computerGeneration: 1,
				state: "provisioning",
				privacyState: "shared",
				privacyVersion: 0,
				screens: [],
				viewers: [],
			}),
		);
		privacyGate.resolve(
			Response.json({ scope: scopeFixture, computerGeneration: 1, state: "shared", version: 0, challenge: null }),
		);
		const dispose = await panelPromise;

		const buttonNamed = (text: string) => {
			const match = root.findAll((node) => node.tag === "button" && node.textContent === text)[0];
			if (!match) throw new Error(`Missing button ${text}`);
			return match;
		};
		buttonNamed("Start computer").click();
		await pendingAction;
		buttonNamed("Start computer").click();
		await pendingAction;
		expect(startRequestIds).toHaveLength(2);
		expect(startRequestIds[1]).toBe(startRequestIds[0]);

		buttonNamed("Cancel pending start").click();
		await pendingAction;
		buttonNamed("Start computer").click();
		await pendingAction;
		expect(startRequestIds).toHaveLength(3);
		expect(startRequestIds[2]).not.toBe(startRequestIds[0]);
		dispose();
	});

	it("validates email before setting panel inert and skips reload if mountMemberWeb closes during signOut", async () => {
		installFakeDom();
		const root = new FakeNode("div");
		const signInWithOtp = vi.fn(async () => ({ error: null }));
		const signOutDeferred = deferred<{ error: null }>();
		const signOut = vi.fn(() => signOutDeferred.promise);
		const clearAuth = vi.fn();
		const reload = vi.fn();
		const mounted = mountMemberWeb(root as unknown as HTMLElement, {
			config,
			clearAuth,
			reload,
			client: {
				auth: {
					onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
					getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
					signInWithOAuth: vi.fn(),
					signInWithOtp,
					signOut,
				},
			} as unknown as SupabaseClient,
		});
		await vi.waitFor(() =>
			expect(
				root.findAll((node) => node.tag === "button" && node.textContent === "Email a sign-in link"),
			).toHaveLength(1),
		);
		const panel = root.findAll((node) => node.tag === "main")[0];
		const emailInput = root.findAll((node) => node.tag === "input")[0];
		const emailButton = root.findAll(
			(node) => node.tag === "button" && node.textContent === "Email a sign-in link",
		)[0];
		let inertDuringValidity: boolean | undefined;
		emailInput.reportValidity = vi.fn(() => {
			inertDuringValidity = panel.inert;
			return false;
		});
		emailButton.click();
		expect(emailInput.reportValidity).toHaveBeenCalledOnce();
		expect(inertDuringValidity).toBe(false);
		expect(signInWithOtp).not.toHaveBeenCalled();
		mounted.close();
		expect(reload).not.toHaveBeenCalled();
	});
});
