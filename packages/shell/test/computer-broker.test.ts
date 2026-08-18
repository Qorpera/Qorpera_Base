import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { describe, expect, it } from "vitest";
import { createComputerBroker } from "../src/computer-broker.ts";

interface SnapshotState {
	url: string;
	title: string;
	snapshot: string;
	handoffReady: boolean;
}

class FakePage {
	static snapshot: SnapshotState = {
		url: "https://provider.example/",
		title: "Provider",
		snapshot: '[q1] link "Log in"',
		handoffReady: false,
	};
	static sensitiveRefs = new Set<string>();
	static publicValues = new Map<string, string>();
	static secretValues = new Map<string, string>();
	static fills: Array<{ ref: string; text: string }> = [];
	readonly keyboard = {
		press: async () => {},
	};
	private closed = false;

	isClosed(): boolean {
		return this.closed;
	}
	async waitForLoadState(): Promise<void> {}
	async waitForTimeout(): Promise<void> {}
	async evaluate(): Promise<SnapshotState> {
		return FakePage.snapshot;
	}
	async goto(url: string): Promise<void> {
		FakePage.snapshot = { ...FakePage.snapshot, url };
	}
	async bringToFront(): Promise<void> {}
	async screenshot(): Promise<Buffer> {
		return Buffer.from("png");
	}
	locator(selector: string): object {
		const ref = selector.match(/q\d+/)?.[0] ?? "";
		const locator = {
			first: () => locator,
			count: async () => (ref ? 1 : 0),
			click: async () => {},
			fill: async (text: string) => {
				FakePage.fills.push({ ref, text });
			},
			evaluate: async (_callback: unknown, marker?: unknown) => {
				if (marker === "qorpera-read-public-value") return FakePage.publicValues.get(ref);
				if (marker === "qorpera-store-secret") return FakePage.secretValues.get(ref);
				return FakePage.sensitiveRefs.has(ref);
			},
		};
		return locator;
	}
	close(): void {
		this.closed = true;
	}
}

class FakeBrowserContext {
	readonly page = new FakePage();
	pages(): FakePage[] {
		return [this.page];
	}
	async newPage(): Promise<FakePage> {
		return this.page;
	}
	on(): this {
		return this;
	}
	async close(): Promise<void> {
		this.page.close();
	}
}

function intent(): KernelIntentCapability {
	const issuedAt = Date.now();
	return {
		nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "session-1",
		requestHash: "hash",
		attended: true,
		issuedAt: new Date(issuedAt).toISOString(),
		expiresAt: new Date(issuedAt + 60_000).toISOString(),
		budget: { maxCalls: 100, maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 1 },
		signature: "signature",
	};
}

function request(
	broker: ReturnType<typeof createComputerBroker>,
	frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		expect(broker.handleFrame(frame, (response) => resolve(response as Record<string, unknown>))).toBe(true);
	});
}

describe("kernel computer broker", () => {
	it("rejects a landing-page handoff and accepts an actual sign-in boundary", async () => {
		FakePage.snapshot = {
			url: "https://provider.example/",
			title: "Provider",
			snapshot: '[q1] link "Log in"',
			handoffReady: false,
		};
		const handoffs: SnapshotState[] = [];
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => new FakeBrowserContext() as never,
			allowedInitialUrl: (url) => url.origin === "https://provider.example",
			onHandoff: (snapshot) => {
				handoffs.push(snapshot);
			},
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);

		const opened = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "11111111-1111-4111-8111-111111111111",
			action: "open",
			url: "https://provider.example/",
			intent: capability,
		});
		expect(opened).toMatchObject({ handoffReady: false, url: "https://provider.example/" });
		FakePage.fills = [];
		await request(broker, {
			type: "qorpera_computer_request",
			requestId: "66666666-6666-4666-8666-666666666666",
			action: "fill",
			ref: "q8",
			text: "Public company name",
			intent: capability,
		});
		expect(FakePage.fills).toEqual([{ ref: "q8", text: "Public company name" }]);

		const rejected = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "22222222-2222-4222-8222-222222222222",
			action: "handoff",
			intent: capability,
		});
		expect(rejected.error).toContain("not ready");
		expect(broker.handoffReady()).toBe(false);

		FakePage.snapshot = {
			url: "https://provider.example/?login=true",
			title: "Sign in",
			snapshot: '[q2] input:email "Email"\n[q3] input:password "Password"\n[q4] button "Accept selected"',
			handoffReady: false,
		};
		FakePage.sensitiveRefs = new Set(["q2"]);
		const privateFill = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "77777777-7777-4777-8777-777777777777",
			action: "fill",
			ref: "q2",
			text: "founder@example.com",
			intent: capability,
		});
		expect(privateFill.error).toContain("private authentication");
		FakePage.sensitiveRefs.clear();
		const obstructed = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "33333333-3333-4333-8333-333333333333",
			action: "handoff",
			intent: capability,
		});
		expect(obstructed.error).toContain("not ready");
		expect(broker.handoffReady()).toBe(false);

		FakePage.snapshot = {
			url: "https://provider.example/?login=true",
			title: "Sign in",
			snapshot: '[q2] input:email "Email"\n[q3] input:password "Password"',
			handoffReady: true,
		};
		const accepted = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "55555555-5555-4555-8555-555555555555",
			action: "handoff",
			intent: capability,
		});
		expect(accepted).toMatchObject({ handoffReady: true, title: "Sign in" });
		expect(broker.handoffReady()).toBe(true);
		expect(handoffs).toHaveLength(1);
	});

	it("denies initial navigation outside owned connector registration origins", async () => {
		FakePage.snapshot = {
			url: "https://provider.example/",
			title: "Provider",
			snapshot: '[q1] link "Log in"',
			handoffReady: false,
		};
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => new FakeBrowserContext() as never,
			allowedInitialUrl: (url) => url.origin === "https://provider.example",
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);
		const response = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "44444444-4444-4444-8444-444444444444",
			action: "open",
			url: "https://unrelated.example/",
			intent: capability,
		});
		expect(response.error).toContain("not an owned connector registration origin");
	});

	it("keeps Google identity handoff private and resumes the managed profile afterward", async () => {
		FakePage.snapshot = {
			url: "https://accounts.google.com/v3/signin/identifier?service=cloudconsole",
			title: "Google Cloud Platform",
			snapshot:
				'[q1] input:text "Email or phone"\n[q2] button "Next"\n\nVisible text:\nSign in with your Google Account to continue',
			handoffReady: false,
		};
		const context = new FakeBrowserContext();
		const handoffs: SnapshotState[] = [];
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => context as never,
			allowedInitialUrl: (url) => url.origin === "https://accounts.google.com",
			onHandoff: async (snapshot) => {
				handoffs.push(snapshot);
			},
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);

		const accepted = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "88888888-8888-4888-8888-888888888888",
			action: "handoff",
			intent: capability,
		});

		expect(accepted).toMatchObject({ handoffReady: true, url: FakePage.snapshot.url });
		expect(handoffs).toHaveLength(1);
		expect(context.page.isClosed()).toBe(false);
		expect(broker.handoffReady()).toBe(true);

		const privateSnapshot = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "99999999-9999-4999-8999-999999999999",
			action: "snapshot",
			intent: capability,
		});
		expect(privateSnapshot.snapshot).toContain("Private authentication is still in progress");
		expect(privateSnapshot.snapshot).not.toContain("Email or phone");
		expect(broker.handoffReady()).toBe(true);

		FakePage.snapshot = {
			url: "https://console.cloud.google.com/welcome",
			title: "Google Cloud console",
			snapshot: '[q1] link "APIs & Services"',
			handoffReady: false,
		};
		const resumed = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			action: "snapshot",
			intent: capability,
		});
		expect(resumed).toMatchObject({
			handoffReady: false,
			url: "https://console.cloud.google.com/welcome",
			snapshot: '[q1] link "APIs & Services"',
		});
		expect(broker.handoffReady()).toBe(false);
	});

	it("stores a generated client secret in the host vault without returning its value", async () => {
		const generatedSecret = "provider-generated-secret-value";
		FakePage.snapshot = {
			url: "https://console.provider.example/oauth/clients",
			title: "OAuth client created",
			snapshot:
				'[q10] button "Copy client ID: public-client-id"\n[q11] button "Store generated client secret (value hidden)"',
			handoffReady: false,
		};
		FakePage.secretValues = new Map([["q11", generatedSecret]]);
		const stored: Array<{ name: string; value: string }> = [];
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => new FakeBrowserContext() as never,
			allowedInitialUrl: (url) => url.origin === "https://console.provider.example",
			storeSecret: (name, value) => {
				stored.push({ name, value });
			},
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);

		const response = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			action: "store_secret",
			ref: "q11",
			secretName: "google_sheets_client_secret",
			intent: capability,
		});

		expect(stored).toEqual([{ name: "google_sheets_client_secret", value: generatedSecret }]);
		expect(response.snapshot).toContain("Stored secret://google_sheets_client_secret");
		expect(response.snapshot).not.toContain(generatedSecret);
	});

	it("returns a generated public client ID without exposing the adjacent secret", async () => {
		const publicClientId = "public-client-id.apps.provider.example";
		FakePage.snapshot = {
			url: "https://console.provider.example/oauth/clients",
			title: "OAuth client created",
			snapshot:
				'[q10] button "Read generated public client ID"\n[q11] button "Store generated client secret (value hidden)"',
			handoffReady: false,
		};
		FakePage.publicValues = new Map([["q10", publicClientId]]);
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => new FakeBrowserContext() as never,
			allowedInitialUrl: (url) => url.origin === "https://console.provider.example",
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);

		const response = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			action: "read_public_value",
			ref: "q10",
			intent: capability,
		});

		expect(response.publicValue).toBe(publicClientId);
		expect(response.snapshot).not.toContain("provider-generated-secret-value");
	});

	it("redacts copied provider values from snapshots before they reach the agent trail", async () => {
		const exposedValue = "provider-generated-secret-value";
		FakePage.snapshot = {
			url: "https://console.provider.example/oauth/clients",
			title: "OAuth client",
			snapshot: `[q11] button "Copy to clipboard: ${exposedValue}"\n\nVisible text:\nClient secret ${exposedValue}`,
			handoffReady: false,
		};
		const broker = createComputerBroker({
			sessionId: "session-1",
			profilePath: "C:\\qorpera-test-chrome",
			launchChrome: async () => new FakeBrowserContext() as never,
			allowedInitialUrl: (url) => url.origin === "https://console.provider.example",
		});
		const capability = intent();
		expect(broker.authorizeIntent(capability)).toBe(true);

		const response = await request(broker, {
			type: "qorpera_computer_request",
			requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			action: "snapshot",
			intent: capability,
		});

		expect(response.snapshot).toContain("[copied value hidden]");
		expect(response.snapshot).not.toContain(exposedValue);
	});
});
