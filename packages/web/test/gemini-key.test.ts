// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiKeyView } from "../src/app/views/settings-gemini-key.ts";
import {
	createWebGeminiKey,
	formatUsdCents,
	formatUsdMicrodollars,
	GeminiKeyInvalidError,
	GeminiKeyStaleError,
	type GeminiKeyState,
	geminiKeyLooksValid,
	type WebGeminiKey,
} from "../src/cloud/gemini-key.ts";
import { fixture, id, profileA, settle, timestamp, userA } from "./fixtures.ts";

const CANARY_KEY = "AIzaSyWebGeminiTestKey0123456789abcdef";
const CANARY_AQ_KEY = "AQ.Ab8RN6WebGeminiTestKey0123456789abcdef_ghij-aXtw";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function sampleState(patch: Partial<NonNullable<GeminiKeyState["key"]>> = {}): GeminiKeyState {
	return {
		vaultAvailable: true,
		key: {
			id: id(81),
			keyHint: "AIza...cdef",
			defaultForChats: false,
			monthlyCapCents: 10_000,
			spendMonth: "2026-11",
			monthSpendMicrodollars: 12_340_000,
			monthInputTokens: 2_000_000,
			monthCachedTokens: 1_000_000,
			monthOutputTokens: 400_000,
			capReached: false,
			lastErrorCode: null,
			lastErrorAt: null,
			lastCheckedAt: null,
			version: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			...patch,
		},
	};
}

describe("Gemini key helpers and transport", () => {
	it("formats USD amounts and validates key syntax", () => {
		expect(geminiKeyLooksValid(CANARY_KEY)).toBe(true);
		expect(geminiKeyLooksValid(CANARY_AQ_KEY)).toBe(true);
		expect(geminiKeyLooksValid("AQ.short")).toBe(false);
		expect(geminiKeyLooksValid("sk-not-google")).toBe(false);
		expect(formatUsdMicrodollars(12_340_000)).toBe("$12.34");
		expect(formatUsdCents(10_000)).toBe("$100");
		expect(formatUsdCents(1250)).toBe("$12.50");
	});

	it("saves a Gemini API key in two hops without ever sending the key to Supabase", async () => {
		const f = fixture();
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const ticketId = id(82);
		const capability = "a".repeat(64);
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.endsWith("/rpc/qorpera_begin_gemini_key_save")) {
				return Response.json({
					schema: "qorpera.gemini-key-ticket/v1",
					ticketId,
					capability,
					serviceOrigin: "https://vault.example",
					profileId: profileA.profileId,
				});
			}
			if (url.startsWith("https://vault.example/v1/gemini-keys/")) {
				return Response.json({
					schema: "qorpera.gemini-key-saved/v1",
					id: id(81),
					keyHint: "AIza...cdef",
					defaultForChats: true,
					monthlyCapCents: 10_000,
					version: 1,
				});
			}
			if (url.endsWith("/rpc/qorpera_get_gemini_key")) {
				return Response.json({ schema: "qorpera.gemini-key/v1", ...sampleState({ defaultForChats: true }) });
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const client = createWebGeminiKey(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			() => undefined,
			fetchImpl,
		);
		const saved = await client.save({
			apiKey: CANARY_KEY,
			defaultForChats: true,
			monthlyCapCents: 10_000,
		});
		expect(saved.key?.keyHint).toBe("AIza...cdef");
		expect(saved.key?.defaultForChats).toBe(true);
		expect(requests).toHaveLength(3);
		expect(requests[0]?.url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_begin_gemini_key_save");
		expect(JSON.stringify(requests[0]?.body)).not.toContain(CANARY_KEY);
		expect(requests[1]?.url).toBe(
			`https://vault.example/v1/gemini-keys/${ticketId}?company=${profileA.profileId.toLowerCase()}`,
		);
		expect(requests[1]?.body).toEqual({
			schema: "qorpera.gemini-key-save-request/v1",
			capability,
			apiKey: CANARY_KEY,
		});
	});

	it("rejects bad key format locally and maps broker invalid_key and SQL QRC01 errors", async () => {
		const f = fixture();
		const ticketId = id(83);
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/rpc/qorpera_begin_gemini_key_save")) {
				return Response.json({
					schema: "qorpera.gemini-key-ticket/v1",
					ticketId,
					capability: "b".repeat(64),
					serviceOrigin: "https://vault.example",
					profileId: profileA.profileId,
				});
			}
			if (url.startsWith("https://vault.example/v1/gemini-keys/")) {
				return Response.json({ schema: "qorpera.gemini-key-error/v1", reason: "invalid_key" }, { status: 403 });
			}
			if (url.endsWith("/rpc/qorpera_update_gemini_key_settings")) {
				return Response.json({ code: "QRC01", message: "stale" }, { status: 409 });
			}
			return Response.json({ schema: "qorpera.gemini-key/v1", vaultAvailable: true, key: null });
		}) as unknown as typeof fetch;

		const client = createWebGeminiKey(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			() => undefined,
			fetchImpl,
		);
		await expect(
			client.save({ apiKey: "invalid-key", defaultForChats: false, monthlyCapCents: null }),
		).rejects.toBeInstanceOf(GeminiKeyInvalidError);
		expect(fetchImpl).not.toHaveBeenCalled();

		await expect(
			client.save({ apiKey: CANARY_KEY, defaultForChats: false, monthlyCapCents: null }),
		).rejects.toBeInstanceOf(GeminiKeyInvalidError);

		await expect(
			client.updateSettings({ defaultForChats: true, monthlyCapCents: 5_000, expectedVersion: 1 }),
		).rejects.toBeInstanceOf(GeminiKeyStaleError);

		expect(await client.revoke()).toEqual({ vaultAvailable: true, key: null });
	});

	it("checks a saved Gemini key through the vault broker and parses health metadata", async () => {
		const f = fixture();
		const ticketId = id(84);
		const capability = "c".repeat(64);
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url, body });
			if (url.endsWith("/rpc/qorpera_begin_gemini_key_check")) {
				return Response.json({
					schema: "qorpera.gemini-key-ticket/v1",
					ticketId,
					capability,
					serviceOrigin: "https://vault.example",
					profileId: profileA.profileId,
				});
			}
			if (url.endsWith(`/v1/gemini-keys/${ticketId}/check?company=${profileA.profileId.toLowerCase()}`)) {
				return Response.json({
					schema: "qorpera.gemini-key-checked/v1",
					ok: false,
					errorCode: "billing_required",
					checkedAt: timestamp,
				});
			}
			if (url.endsWith("/rpc/qorpera_get_gemini_key")) {
				return Response.json({
					schema: "qorpera.gemini-key/v1",
					...sampleState({
						lastErrorCode: "billing_required",
						lastErrorAt: timestamp,
						lastCheckedAt: timestamp,
					}),
				});
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const client = createWebGeminiKey(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			() => undefined,
			fetchImpl,
		);
		const checked = await client.check!();
		expect(checked.ok).toBe(false);
		expect(checked.errorCode).toBe("billing_required");
		expect(checked.state.key?.lastErrorCode).toBe("billing_required");
		expect(checked.state.key?.lastCheckedAt).toBe(timestamp);
		expect(requests).toHaveLength(3);
		expect(requests[1]?.body).toEqual({
			schema: "qorpera.gemini-key-check-request/v1",
			capability,
		});
	});
});

describe("GeminiKeyView", () => {
	it("connects a key, shows remaining budget and health errors, checks key, updates cap, and removes the key", async () => {
		let state: GeminiKeyState = { vaultAvailable: true, key: null };
		const onChanged = vi.fn();
		const client: WebGeminiKey = {
			read: vi.fn(async () => state),
			save: vi.fn(async (input) => {
				state = sampleState({
					defaultForChats: input.defaultForChats,
					monthlyCapCents: input.monthlyCapCents,
					lastErrorCode: "billing_required",
					lastErrorAt: timestamp,
				});
				return state;
			}),
			updateSettings: vi.fn(async (input) => {
				state = sampleState({
					defaultForChats: input.defaultForChats,
					monthlyCapCents: input.monthlyCapCents,
					version: input.expectedVersion + 1,
					capReached: input.monthlyCapCents !== null && input.monthlyCapCents * 10_000 <= 12_340_000,
				});
				return state;
			}),
			check: vi.fn(async () => {
				state = sampleState({
					monthlyCapCents: state.key?.monthlyCapCents ?? 10_000,
					version: state.key?.version ?? 1,
					lastErrorCode: null,
					lastErrorAt: null,
					lastCheckedAt: timestamp,
				});
				return { ok: true, errorCode: null, checkedAt: timestamp, state };
			}),
			revoke: vi.fn(async () => {
				state = { vaultAvailable: true, key: null };
				return state;
			}),
		};
		const controller = new AbortController();
		const view = new GeminiKeyView(client, controller.signal, onChanged);
		document.body.append(view.el);
		await settle();

		const addButton = [...view.el.querySelectorAll("button")].find((btn) => btn.textContent === "Add API key");
		expect(addButton).toBeTruthy();
		addButton!.click();

		const keyInput = view.el.querySelector<HTMLInputElement>('input[type="password"]')!;
		keyInput.value = CANARY_KEY;
		keyInput.dispatchEvent(new Event("input"));
		expect(view.el.querySelector('input[type="checkbox"]')).toBeNull();
		view.el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();

		expect(client.save).toHaveBeenCalledWith(
			{ apiKey: CANARY_KEY, defaultForChats: false, monthlyCapCents: 10_000 },
			expect.any(AbortSignal),
		);
		expect(onChanged).toHaveBeenCalledTimes(1);
		expect(view.el.textContent).toContain("Key AIza...cdef");
		expect(view.el.textContent).toContain("$87.66 left of $100 ($12.34 spent)");
		expect(view.el.textContent).toContain("billing or AI Ultra credits are not active");
		expect(view.el.querySelector<HTMLAnchorElement>(".gemini-billing-link")?.href).toBe(
			"https://aistudio.google.com/spend",
		);
		expect(view.el.querySelector('[role="switch"]')).toBeNull();
		expect(view.el.textContent).not.toContain(CANARY_KEY);

		const checkButton = [...view.el.querySelectorAll("button")].find((btn) => btn.textContent === "Check key")!;
		checkButton.click();
		await settle();
		expect(client.check).toHaveBeenCalledOnce();
		expect(view.el.textContent).toContain("Key verified for Gemini 4 Neon.");
		expect(view.el.textContent).not.toContain("billing or AI Ultra credits are not active");

		const capInput = view.el.querySelector<HTMLInputElement>(".gemini-cap-input")!;
		capInput.value = "10";
		capInput.dispatchEvent(new Event("input"));
		view.el
			.querySelector<HTMLFormElement>(".gemini-cap-row")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		expect(client.updateSettings).toHaveBeenLastCalledWith(
			{ defaultForChats: false, monthlyCapCents: 1_000, expectedVersion: 1 },
			expect.any(AbortSignal),
		);
		expect(view.el.textContent).toContain("Cap reached");
		expect(view.el.textContent).toContain("Gemini conversations are paused");

		const removeButton = [...view.el.querySelectorAll("button")].find((btn) => btn.textContent === "Remove key")!;
		removeButton.click();
		await settle();
		expect(client.revoke).toHaveBeenCalledOnce();
		expect(onChanged).toHaveBeenCalledTimes(2);
		expect(view.el.textContent).toContain("Add API key");
		controller.abort();
	});
});
