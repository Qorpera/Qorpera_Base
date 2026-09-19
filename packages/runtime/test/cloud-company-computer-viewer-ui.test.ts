import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId } from "./fixtures/company-computer.ts";

interface ViewConnection {
	connectionId: string;
	url?: string;
	channel?: { readyState: number; send(bytes: unknown): void; close(): void };
	mode: "watch" | "shared" | "control";
	binding: CompanyComputerScreenBinding;
}

interface ViewerOptions {
	canControl?: boolean;
	privateSignIn?: boolean;
	sharedControl?: boolean;
	binding: CompanyComputerScreenBinding;
	title: string;
	requestConnection(input: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "shared" | "control";
		signal: AbortSignal;
	}): Promise<ViewConnection>;
	releaseConnection(input: { connectionId: string }): Promise<void>;
	onClosed(): void;
}

class FakeElement {
	className = "";
	textContent = "";
	type = "";
	hidden = false;
	disabled = false;
	removed = false;
	onclick?: () => void;
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly classes = new Set<string>();
	readonly classList = {
		add: (name: string) => {
			this.classes.add(name);
		},
		remove: (name: string) => {
			this.classes.delete(name);
		},
	};
	readonly focus = vi.fn();
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	append(...elements: FakeElement[]): void {
		this.children.push(...elements);
	}
	appendChild(element: FakeElement): void {
		this.children.push(element);
	}
	replaceChildren(...elements: FakeElement[]): void {
		this.children.splice(0, this.children.length, ...elements);
	}
	remove(): void {
		this.removed = true;
	}
}

function viewerFixture() {
	const elements: FakeElement[] = [];
	const instances: FakeRfb[] = [];
	class FakeRfb {
		viewOnly = false;
		scaleViewport = false;
		resizeSession = true;
		background = "";
		readonly listeners = new Map<string, Array<() => void>>();
		readonly disconnect = vi.fn(() => this.emit("disconnect"));
		readonly focus = vi.fn();
		readonly transport: unknown;
		constructor(_target: unknown, transport: unknown) {
			this.transport = transport;
			instances.push(this);
		}
		addEventListener(name: string, listener: () => void): void {
			const list = this.listeners.get(name) ?? [];
			list.push(listener);
			this.listeners.set(name, list);
		}
		emit(name: string): void {
			for (const listener of this.listeners.get(name) ?? []) listener();
		}
	}
	const previous = new FakeElement();
	const document = {
		activeElement: previous,
		body: new FakeElement(),
		createElement: () => {
			const element = new FakeElement();
			elements.push(element);
			return element;
		},
	};
	const context: {
		window: {
			qorperaScreenViewer?: { open(options: ViewerOptions): { close(): Promise<void>; readonly closed: boolean } };
		};
		document: typeof document;
		RFB: typeof FakeRfb;
		AbortController: typeof AbortController;
		URL: typeof URL;
	} = { window: {}, document, RFB: FakeRfb, AbortController, URL };
	const source = readFileSync(new URL("../../shell/userland/screen-viewer.js", import.meta.url), "utf8");
	// Execute the actual UI state machine; only the vendored browser transport and DOM are doubled.
	runInNewContext(source.replace('import RFB from "./vendor/novnc-rfb.js";', ""), context);
	const api = context.window.qorperaScreenViewer;
	if (!api) throw new Error("VIEWER_DID_NOT_INITIALIZE");
	let sequence = 0;
	const requestConnection = vi.fn(
		async ({ mode }: Parameters<ViewerOptions["requestConnection"]>[0]): Promise<ViewConnection> => {
			sequence++;
			return {
				connectionId: computerId(20 + sequence),
				url: `ws://127.0.0.1:4500/${String(sequence).padStart(43, "a")}`,
				mode,
				binding: computerBinding(),
			};
		},
	);
	const releaseConnection = vi.fn(async () => undefined);
	const onClosed = vi.fn();
	const options: ViewerOptions = {
		binding: computerBinding(),
		title: "Cloud screen",
		requestConnection,
		releaseConnection,
		onClosed,
	};
	const button = (text: string): FakeElement => {
		const found = elements.find((element) => element.type === "button" && element.textContent === text);
		if (!found) throw new Error("BUTTON_MISSING");
		return found;
	};
	return {
		api,
		options,
		requestConnection,
		releaseConnection,
		onClosed,
		button,
		instances,
		elements,
		previous,
		document,
	};
}

describe("viewer UI state machine (fake DOM/noVNC, not visual cloud acceptance)", () => {
	it("opens shared input immediately and reconnects with fresh shared authority", async () => {
		const f = viewerFixture();
		f.options.sharedControl = true;
		const viewer = f.api.open(f.options);
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		expect(f.instances[0].viewOnly).toBe(true);
		f.instances[0].emit("connect");
		expect(f.instances[0].viewOnly).toBe(false);
		expect(f.button("Take control").hidden).toBe(true);
		f.button("Take control").onclick?.();
		expect(f.requestConnection).toHaveBeenCalledOnce();
		expect(f.elements.some((element) => element.textContent === "Shared with the agent")).toBe(true);
		f.instances[0].emit("disconnect");
		expect(f.instances[0].viewOnly).toBe(true);
		f.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		f.instances[1].emit("connect");
		expect(f.instances[1].viewOnly).toBe(false);
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["shared", "shared"]);
		await viewer.close();
		expect(f.releaseConnection).toHaveBeenCalledTimes(2);
	});
	it("keeps shared viewing read-only when the member cannot control", async () => {
		const f = viewerFixture();
		f.options.sharedControl = true;
		f.options.canControl = false;
		const viewer = f.api.open(f.options);
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.instances[0].emit("connect");
		expect(f.instances[0].viewOnly).toBe(true);
		expect(f.requestConnection.mock.calls[0][0].mode).toBe("watch");
		await viewer.close();
	});
	it("uses explicit private control, never shared takeover, and reconnects only on a new click", async () => {
		const f = viewerFixture();
		f.options.canControl = false;
		f.options.privateSignIn = true;
		const viewer = f.api.open(f.options);
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		expect(f.instances[0].viewOnly).toBe(true);
		f.instances[0].emit("connect");
		expect(f.instances[0].viewOnly).toBe(false);
		const toggle = f.button("Release control");
		expect(toggle.hidden).toBe(true);
		toggle.onclick?.();
		expect(f.requestConnection).toHaveBeenCalledOnce();
		f.instances[0].emit("disconnect");
		expect(f.requestConnection).toHaveBeenCalledOnce();
		expect(f.instances[0].viewOnly).toBe(true);
		f.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		expect(f.instances[1].viewOnly).toBe(true);
		f.instances[1].emit("connect");
		expect(f.instances[1].viewOnly).toBe(false);
		await viewer.close();
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["control", "control"]);
		expect(f.releaseConnection).toHaveBeenCalledTimes(2);
	});
	it("keeps ordinary members watch-only even when control is invoked programmatically", async () => {
		const f = viewerFixture();
		f.options.canControl = false;
		const viewer = f.api.open(f.options);
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.instances[0].emit("connect");
		expect(f.button("Take control").hidden).toBe(true);
		f.button("Take control").onclick?.();
		expect(f.requestConnection).toHaveBeenCalledOnce();
		expect(f.instances[0].viewOnly).toBe(true);
		await viewer.close();
	});
	it("attaches an authenticated raw SDK channel, closes it, and refuses channel reuse", async () => {
		const fixture = viewerFixture();
		const channel = { readyState: 1, send: vi.fn(), close: vi.fn() };
		fixture.requestConnection.mockResolvedValue({
			connectionId: computerId(21),
			binding: computerBinding(),
			mode: "watch",
			channel,
		});
		const viewer = fixture.api.open(fixture.options);
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(1));
		expect(fixture.instances[0].transport).toBe(channel);
		fixture.instances[0].emit("connect");
		fixture.instances[0].emit("disconnect");
		expect(channel.close).toHaveBeenCalledOnce();
		fixture.requestConnection.mockResolvedValue({
			connectionId: computerId(22),
			binding: computerBinding(),
			mode: "watch",
			channel,
		});
		fixture.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(fixture.releaseConnection).toHaveBeenCalledTimes(2));
		expect(fixture.instances).toHaveLength(1);
		await viewer.close();
	});
	it("rejects a closed raw channel or a channel accompanied by a URL", async () => {
		for (const connection of [
			{ channel: { readyState: 3, send: vi.fn(), close: vi.fn() } },
			{ channel: { readyState: 1, send: vi.fn(), close: vi.fn() }, url: "wss://untrusted.example" },
		]) {
			const fixture = viewerFixture();
			fixture.requestConnection.mockResolvedValue({
				connectionId: computerId(21),
				binding: computerBinding(),
				mode: "watch",
				...connection,
			});
			const viewer = fixture.api.open(fixture.options);
			await vi.waitFor(() => expect(fixture.releaseConnection).toHaveBeenCalledOnce());
			expect(fixture.instances).toHaveLength(0);
			await viewer.close();
		}
	});
	it("starts watch-only and requests a new acknowledged grant before enabling control", async () => {
		const fixture = viewerFixture();
		const viewer = fixture.api.open(fixture.options);
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(1));
		expect(fixture.instances[0].viewOnly).toBe(true);
		fixture.instances[0].emit("connect");
		expect(fixture.instances[0].viewOnly).toBe(true);
		fixture.button("Take control").onclick?.();
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(2));
		expect(fixture.instances[0].disconnect).toHaveBeenCalledOnce();
		expect(fixture.instances[1].viewOnly).toBe(true);
		fixture.instances[1].emit("connect");
		expect(fixture.instances[1].viewOnly).toBe(false);
		expect(fixture.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "control"]);
		fixture.button("Release control").onclick?.();
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(3));
		fixture.instances[2].emit("connect");
		expect(fixture.instances[1].viewOnly).toBe(true);
		expect(fixture.instances[2].viewOnly).toBe(true);
		await viewer.close();
		expect(fixture.releaseConnection).toHaveBeenCalledTimes(3);
	});

	it("never regains control automatically after disconnect; explicit reconnect mints a new watch connection", async () => {
		const fixture = viewerFixture();
		const viewer = fixture.api.open(fixture.options);
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(1));
		fixture.instances[0].emit("connect");
		fixture.button("Take control").onclick?.();
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(2));
		fixture.instances[1].emit("connect");
		fixture.instances[1].emit("disconnect");
		expect(fixture.requestConnection).toHaveBeenCalledTimes(2);
		expect(fixture.button("Reconnect").hidden).toBe(false);
		fixture.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(3));
		expect(fixture.requestConnection.mock.calls[2][0].mode).toBe("watch");
		expect(fixture.instances[2].viewOnly).toBe(true);
		await viewer.close();
	});

	it.each(["companyId", "staffAgentId", "screenGeneration"] as const)(
		"refuses a substituted %s on connect without displaying service errors",
		async (key) => {
			const fixture = viewerFixture();
			fixture.requestConnection.mockResolvedValue({
				connectionId: computerId(21),
				url: `ws://127.0.0.1:4500/${"a".repeat(43)}`,
				mode: "watch",
				binding: { ...computerBinding(), [key]: key === "screenGeneration" ? 2 : computerId(99) },
			});
			const viewer = fixture.api.open(fixture.options);
			await vi.waitFor(() => expect(fixture.releaseConnection).toHaveBeenCalledOnce());
			expect(fixture.instances).toHaveLength(0);
			expect(fixture.elements.some((element) => element.textContent.includes("Reconnect to check access"))).toBe(
				true,
			);
			await viewer.close();
		},
	);

	it("closes pending UI, cancels admission, and releases a late connection without attaching it", async () => {
		const fixture = viewerFixture();
		const pending = computerDeferred<ViewConnection>();
		fixture.requestConnection.mockImplementation(() => pending.promise);
		const viewer = fixture.api.open(fixture.options);
		await vi.waitFor(() => expect(fixture.requestConnection).toHaveBeenCalledOnce());
		await viewer.close();
		await viewer.close();
		expect(fixture.requestConnection.mock.calls[0][0].signal.aborted).toBe(true);
		pending.resolve({
			connectionId: computerId(21),
			url: `ws://127.0.0.1:4500/${"a".repeat(43)}`,
			mode: "watch",
			binding: computerBinding(),
		});
		await vi.waitFor(() => expect(fixture.releaseConnection).toHaveBeenCalledOnce());
		expect(fixture.instances).toHaveLength(0);
		expect(fixture.previous.focus).toHaveBeenCalledOnce();
		expect(fixture.onClosed).toHaveBeenCalledOnce();
	});

	it("does not reuse a consumed URL or connection after a failure", async () => {
		const fixture = viewerFixture();
		fixture.requestConnection.mockResolvedValue({
			connectionId: computerId(21),
			url: `ws://127.0.0.1:4500/${"a".repeat(43)}`,
			mode: "watch",
			binding: computerBinding(),
		});
		const viewer = fixture.api.open(fixture.options);
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(1));
		fixture.instances[0].emit("connect");
		fixture.instances[0].emit("disconnect");
		fixture.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(fixture.requestConnection).toHaveBeenCalledTimes(2));
		expect(fixture.instances).toHaveLength(1);
		await viewer.close();
	});
});
