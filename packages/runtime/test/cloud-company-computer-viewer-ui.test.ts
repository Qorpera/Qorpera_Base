import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { describe, expect, it, vi } from "vitest";
import { computerBinding, computerDeferred, computerId } from "./fixtures/company-computer.ts";

interface ViewConnection {
	connectionId: string;
	url?: string;
	channel?: { readyState: number; send(bytes: unknown): void; close(): void };
	mode: "watch" | "control";
	binding: CompanyComputerScreenBinding;
}

interface ViewerOptions {
	mount?: FakeElement;
	autofocus?: boolean;
	onExpandedChange?(expanded: boolean): void;
	canControl?: boolean;
	privateSignIn?: boolean;
	binding: CompanyComputerScreenBinding;
	title: string;
	requestConnection(input: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "control";
		signal: AbortSignal;
	}): Promise<ViewConnection>;
	releaseConnection(input: { connectionId: string }): Promise<void>;
	onClosed(): void;
}

class FakeElement {
	className = "";
	textContent = "";
	type = "";
	tabIndex = 0;
	hidden = false;
	disabled = false;
	removed = false;
	isConnected = true;
	onclick?: () => void;
	requestFullscreen?: () => Promise<void>;
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
	contains(element: FakeElement | null): boolean {
		return this === element || this.children.some((child) => child.contains(element));
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
		this.isConnected = false;
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
	const fullscreenEvents = new EventTarget();
	const document = {
		activeElement: previous,
		body: new FakeElement(),
		fullscreenEnabled: true,
		fullscreenElement: null as FakeElement | null,
		addEventListener: fullscreenEvents.addEventListener.bind(fullscreenEvents),
		exitFullscreen: vi.fn(async () => {
			document.fullscreenElement = null;
			fullscreenEvents.dispatchEvent(new Event("fullscreenchange"));
		}),
		createElement: () => {
			const element = new FakeElement();
			element.focus.mockImplementation(() => {
				document.activeElement = element;
			});
			element.requestFullscreen = vi.fn(async () => {
				document.fullscreenElement = element;
				fullscreenEvents.dispatchEvent(new Event("fullscreenchange"));
			});
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
		AbortSignal: typeof AbortSignal;
		URL: typeof URL;
	} = { window: {}, document, RFB: FakeRfb, AbortController, AbortSignal, URL };
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
	const releaseConnection = vi.fn(async (): Promise<void> => undefined);
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
		fullscreenEvents,
	};
}

async function embeddedViewer(canControl = true, fullscreenEnabled = true) {
	const f = viewerFixture();
	f.document.fullscreenEnabled = fullscreenEnabled;
	const mount = new FakeElement();
	const expanded = vi.fn();
	const viewer = f.api.open({ ...f.options, mount, canControl, onExpandedChange: expanded });
	await vi.waitFor(() => expect(f.instances).toHaveLength(1));
	f.instances[0].emit("connect");
	return { ...f, mount, viewer, expanded };
}

describe("viewer UI state machine (fake DOM/noVNC, not visual cloud acceptance)", () => {
	it.each([false, true])("preserves keyboard focus through Enter and Back (can control: %s)", async (canControl) => {
		const f = await embeddedViewer(canControl, false);
		const pending = computerDeferred<ViewConnection>();
		if (canControl) f.requestConnection.mockImplementationOnce(() => pending.promise);
		const overlay = f.mount.children[0];
		expect(overlay.tabIndex).toBe(-1);
		f.button("Enter").focus();
		f.button("Enter").onclick?.();
		expect(f.document.activeElement).toBe(f.button("Back to thread"));
		if (canControl) await vi.waitFor(() => expect(f.requestConnection).toHaveBeenCalledTimes(2));
		f.button("Back to thread").onclick?.();
		expect(f.document.activeElement).toBe(overlay);
		expect(f.button("Back to thread").hidden).toBe(true);
		if (canControl) {
			pending.resolve({
				connectionId: computerId(50),
				url: `ws://127.0.0.1:4500/${"z".repeat(43)}`,
				mode: "control",
				binding: computerBinding(),
			});
			await vi.waitFor(() => expect(f.instances).toHaveLength(2));
			f.instances[1].emit("connect");
			expect(f.document.activeElement).toBe(overlay);
		}
		await f.viewer.close();
	});

	it("does not pull external focus into the mini on a fullscreen-exit callback", async () => {
		const f = await embeddedViewer(false);
		f.button("Enter").onclick?.();
		await vi.waitFor(() => expect(f.button("Exit full screen").disabled).toBe(false));
		f.document.activeElement = f.previous;
		await f.document.exitFullscreen();
		expect(f.expanded).toHaveBeenLastCalledWith(false);
		expect(f.document.activeElement).toBe(f.previous);
		expect(f.mount.children[0].focus).not.toHaveBeenCalled();
		await f.viewer.close();
	});

	it("keeps the mini watch-only and enters control only after an explicit Enter click", async () => {
		const f = await embeddedViewer();
		expect(f.button("Enter").disabled).toBe(false);
		f.button("Take control").onclick?.();
		expect(f.requestConnection).toHaveBeenCalledOnce();
		f.button("Enter").onclick?.();
		expect(f.document.fullscreenElement).toBe(f.mount.children[0]);
		expect(f.button("Enter").hidden).toBe(true);
		expect(f.button("Back to thread").hidden).toBe(false);
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		expect(f.instances[1].viewOnly).toBe(true);
		f.instances[1].emit("connect");
		expect(f.instances[1].viewOnly).toBe(false);
		expect(f.button("Release control").hidden).toBe(false);
		f.button("Back to thread").onclick?.();
		expect(f.instances[1].viewOnly).toBe(true);
		expect(f.button("Enter").hidden).toBe(true);
		expect(f.expanded.mock.calls).toEqual([[true], [false]]);
		await vi.waitFor(() => expect(f.instances).toHaveLength(3));
		f.instances[2].emit("connect");
		expect(f.instances[2].viewOnly).toBe(true);
		expect(f.button("Enter").hidden).toBe(false);
		expect(f.button("Take control").hidden).toBe(true);
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "control", "watch"]);
		expect(f.releaseConnection).toHaveBeenCalledTimes(2);
		await f.viewer.close();
	});

	it("cancels pending control admission on native exit and releases late control without attaching it", async () => {
		const f = await embeddedViewer();
		const pending = computerDeferred<ViewConnection>();
		f.requestConnection.mockImplementationOnce(() => pending.promise);
		f.button("Enter").onclick?.();
		await vi.waitFor(() => expect(f.requestConnection).toHaveBeenCalledTimes(2));
		await f.document.exitFullscreen();
		expect(f.requestConnection.mock.calls[1][0].signal.aborted).toBe(true);
		expect(f.expanded.mock.calls).toEqual([[true], [false]]);
		pending.resolve({
			connectionId: computerId(50),
			url: `ws://127.0.0.1:4500/${"z".repeat(43)}`,
			mode: "control",
			binding: computerBinding(),
		});
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		expect(f.releaseConnection).toHaveBeenCalledWith({ connectionId: computerId(50) });
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "control", "watch"]);
		f.instances[1].emit("connect");
		expect(f.instances.every((rfb) => rfb.viewOnly)).toBe(true);
		expect(f.button("Enter").hidden).toBe(false);
		await f.viewer.close();
	});

	it("does not request control if Back is clicked while the preceding watch grant is releasing", async () => {
		const f = await embeddedViewer(true, false);
		const releasing = computerDeferred<void>();
		f.releaseConnection.mockImplementationOnce(() => releasing.promise);
		f.button("Enter").onclick?.();
		f.button("Back to thread").onclick?.();
		releasing.resolve();
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "watch"]);
		expect(f.releaseConnection).toHaveBeenCalledOnce();
		await f.viewer.close();
	});

	it("hides Enter over connection and error statuses and restores it after a watch reconnect", async () => {
		const f = viewerFixture();
		const viewer = f.api.open({ ...f.options, mount: new FakeElement() });
		expect(f.button("Enter").hidden).toBe(true);
		f.button("Enter").onclick?.();
		expect(f.document.fullscreenElement).toBeNull();
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.instances[0].emit("connect");
		expect(f.button("Enter").hidden).toBe(false);
		f.instances[0].emit("disconnect");
		expect(f.button("Enter").hidden).toBe(true);
		expect(f.button("Reconnect").hidden).toBe(false);
		f.button("Reconnect").onclick?.();
		await vi.waitFor(() => expect(f.instances).toHaveLength(2));
		f.instances[1].emit("connect");
		expect(f.button("Enter").hidden).toBe(false);
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "watch"]);
		await viewer.close();
	});

	it("never converts an embedded private-sign-in option into shared control", async () => {
		const f = viewerFixture();
		const viewer = f.api.open({ ...f.options, mount: new FakeElement(), privateSignIn: true });
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.instances[0].emit("connect");
		f.button("Enter").onclick?.();
		expect(f.button("Take control").hidden).toBe(true);
		f.button("Take control").onclick?.();
		expect(f.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch"]);
		expect(f.instances[0].viewOnly).toBe(true);
		await viewer.close();
	});

	it("enters and exits embedded fullscreen without reopening or changing control", async () => {
		const f = await embeddedViewer(false);
		const { mount, viewer } = f;
		const fullscreen = f.button("Full screen");
		expect(fullscreen.hidden).toBe(true);
		expect(f.button("Take control").hidden).toBe(true);
		expect(f.button("Back to thread").hidden).toBe(true);
		expect(fullscreen.attributes.get("aria-label")).toBe("Full screen");
		expect(fullscreen.attributes.get("title")).toBe("Full screen");
		f.button("Enter").onclick?.();
		expect(f.document.fullscreenElement).toBe(mount.children[0]);
		expect(f.expanded).toHaveBeenCalledWith(true);
		expect(mount.children[0].classes.has("screen-viewer-entered")).toBe(true);
		await vi.waitFor(() => expect(fullscreen.disabled).toBe(false));
		expect(fullscreen.hidden).toBe(false);
		expect(f.document.fullscreenElement).toBe(mount.children[0]);
		expect(fullscreen.textContent).toBe("Exit full screen");
		expect(fullscreen.attributes.get("aria-label")).toBe("Exit full screen");
		expect(fullscreen.attributes.get("title")).toBe("Exit full screen");
		expect(fullscreen.attributes.get("aria-pressed")).toBe("true");
		await fullscreen.onclick?.();
		expect(f.document.fullscreenElement).toBeNull();
		expect(fullscreen.textContent).toBe("Full screen");
		expect(fullscreen.attributes.get("aria-label")).toBe("Full screen");
		expect(fullscreen.attributes.get("title")).toBe("Full screen");
		expect(fullscreen.attributes.get("aria-pressed")).toBe("false");
		expect(f.expanded).toHaveBeenLastCalledWith(false);
		expect(fullscreen.hidden).toBe(true);
		expect(f.button("Enter").hidden).toBe(false);
		f.button("Enter").onclick?.();
		await vi.waitFor(() => expect(fullscreen.disabled).toBe(false));
		// Browser Escape is reflected even when no button click reaches the renderer.
		await f.document.exitFullscreen();
		expect(fullscreen.textContent).toBe("Full screen");
		expect(f.expanded.mock.calls).toEqual([[true], [false], [true], [false]]);
		expect(viewer.closed).toBe(false);
		expect(f.requestConnection).toHaveBeenCalledOnce();
		expect(f.releaseConnection).not.toHaveBeenCalled();
		expect(f.instances[0].viewOnly).toBe(true);
		await viewer.close();
	});

	it("reports rejected fullscreen requests accessibly and allows retry", async () => {
		const f = await embeddedViewer(false);
		const { mount, viewer } = f;
		vi.spyOn(mount.children[0], "requestFullscreen").mockRejectedValueOnce(new Error("denied"));
		const fullscreen = f.button("Full screen");
		f.button("Enter").onclick?.();
		await vi.waitFor(() => expect(fullscreen.disabled).toBe(false));
		expect(mount.children[0].classes.has("screen-viewer-entered")).toBe(true);
		expect(f.expanded.mock.calls).toEqual([[true]]);
		expect(fullscreen.disabled).toBe(false);
		expect(fullscreen.textContent).toBe("Full screen unavailable");
		expect(fullscreen.attributes.get("aria-label")).toBe("Full screen unavailable. Try again.");
		expect(fullscreen.attributes.get("title")).toBe("Full screen unavailable. Try again.");
		expect(fullscreen.attributes.get("aria-live")).toBe("polite");
		await fullscreen.onclick?.();
		expect(fullscreen.textContent).toBe("Exit full screen");
		f.document.exitFullscreen.mockRejectedValueOnce(new Error("denied"));
		await fullscreen.onclick?.();
		expect(fullscreen.textContent).toBe("Could not exit full screen");
		expect(fullscreen.attributes.get("aria-label")).toBe("Could not exit full screen. Try again.");
		expect(fullscreen.attributes.get("title")).toBe("Could not exit full screen. Try again.");
		expect(fullscreen.disabled).toBe(false);
		await viewer.close();
		expect(f.document.fullscreenElement).toBeNull();
	});

	it("exits only its own fullscreen on close and removes its fullscreen listener", async () => {
		const f = await embeddedViewer(false);
		const { mount, viewer } = f;
		const fullscreen = f.button("Full screen");
		f.button("Enter").onclick?.();
		await vi.waitFor(() => expect(fullscreen.disabled).toBe(false));
		await viewer.close();
		expect(f.expanded.mock.calls).toEqual([[true], [false]]);
		expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
		expect(f.releaseConnection).toHaveBeenCalledOnce();
		expect(f.document.fullscreenElement).toBeNull();
		expect(fullscreen.textContent).toBe("Exit full screen");
		const otherViewer = f.api.open({ ...f.options, mount });
		f.document.fullscreenElement = new FakeElement();
		await otherViewer.close();
		expect(f.document.exitFullscreen).toHaveBeenCalledOnce();
	});

	it("cleans up fullscreen that finishes entering after the viewer closes", async () => {
		const f = await embeddedViewer(false);
		const { mount, viewer } = f;
		const pending = computerDeferred<void>();
		vi.spyOn(mount.children[0], "requestFullscreen").mockImplementation(async () => {
			await pending.promise;
			f.document.fullscreenElement = mount.children[0];
		});
		f.button("Enter").onclick?.();
		await viewer.close();
		pending.resolve();
		await vi.waitFor(() => expect(f.document.exitFullscreen).toHaveBeenCalledOnce());
		expect(f.document.fullscreenElement).toBeNull();
	});

	it("hides unavailable fullscreen and leaves standalone controls unchanged", async () => {
		const f = await embeddedViewer(false, false);
		expect(f.button("Full screen").hidden).toBe(true);
		f.button("Enter").onclick?.();
		expect(f.expanded).toHaveBeenCalledWith(true);
		expect(f.button("Back to thread").hidden).toBe(false);
		expect(f.button("Full screen").hidden).toBe(true);
		f.button("Back to thread").onclick?.();
		expect(f.expanded).toHaveBeenLastCalledWith(false);
		expect(f.requestConnection).toHaveBeenCalledOnce();
		await f.viewer.close();
		const standalone = viewerFixture();
		const viewer = standalone.api.open(standalone.options);
		expect(standalone.elements.some((element) => element.className === "screen-viewer-fullscreen")).toBe(false);
		await viewer.close();
	});

	it("keeps the member web renderer identical to the tested desktop source and its checksum", () => {
		const desktop = readFileSync(new URL("../../shell/userland/screen-viewer.js", import.meta.url), "utf8");
		const memberWeb = readFileSync(new URL("../../member-web/ui/screen-viewer.js", import.meta.url), "utf8");
		const manifest = JSON.parse(readFileSync(new URL("../../member-web/ui/SOURCE.json", import.meta.url), "utf8"));
		expect(memberWeb).toBe(desktop);
		expect(createHash("sha256").update(memberWeb).digest("hex")).toBe(
			manifest.sources.find((source: { file: string }) => source.file === "screen-viewer.js").sha256,
		);
	});

	it.each([undefined, false])(
		"respects optional autofocus when attaching an embedded viewer (%s)",
		async (autofocus) => {
			const f = viewerFixture();
			const viewer = f.api.open({ ...f.options, mount: new FakeElement(), autofocus });
			expect(f.button("×").focus).toHaveBeenCalledTimes(autofocus === false ? 0 : 1);
			await vi.waitFor(() => expect(f.instances).toHaveLength(1));
			f.instances[0].emit("connect");
			expect(f.instances[0].focus).not.toHaveBeenCalled();
			await viewer.close();
		},
	);

	it.each([false, true])("mounts the viewer with appropriate semantics (embedded: %s)", async (embedded) => {
		const f = viewerFixture();
		const mount = embedded ? new FakeElement() : undefined;
		const viewer = f.api.open({ ...f.options, mount });
		const container = mount ?? f.document.body;
		expect(container.children).toHaveLength(1);
		const overlay = container.children[0];
		expect(overlay.className).toBe(
			embedded ? "screen-viewer-overlay screen-viewer-embedded" : "screen-viewer-overlay",
		);
		expect(overlay.attributes.get("role")).toBe(embedded ? "region" : "dialog");
		expect(overlay.attributes.get("aria-modal")).toBe(embedded ? undefined : "true");
		expect(overlay.attributes.get("aria-label")).toBe("Cloud screen");
		if (embedded) expect(f.document.body.children).toHaveLength(0);
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.instances[0].emit("connect");
		expect(f.instances[0].viewOnly).toBe(true);
		await viewer.close();
		expect(overlay.removed).toBe(true);
		expect(f.instances[0].disconnect).toHaveBeenCalledOnce();
		expect(f.releaseConnection).toHaveBeenCalledOnce();
		expect(f.previous.focus).toHaveBeenCalledOnce();
		expect(f.onClosed).toHaveBeenCalledOnce();
	});

	it("does not restore focus to a removed opener when an embedded viewer closes", async () => {
		const f = viewerFixture();
		const viewer = f.api.open({ ...f.options, mount: new FakeElement() });
		await vi.waitFor(() => expect(f.instances).toHaveLength(1));
		f.previous.remove();
		await viewer.close();
		expect(f.previous.focus).not.toHaveBeenCalled();
		expect(f.releaseConnection).toHaveBeenCalledOnce();
		expect(f.onClosed).toHaveBeenCalledOnce();
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
		expect(fixture.button("Take control").className).toBe("screen-viewer-takeover");
		expect(fixture.button("Take control").attributes.get("aria-label")).toBe("Take control");
		expect(fixture.button("Take control").attributes.get("title")).toBe("Take control");
		expect(fixture.button("Reconnect").className).toBe("screen-viewer-reconnect");
		expect(fixture.button("Reconnect").attributes.get("aria-label")).toBe("Reconnect");
		expect(fixture.button("Reconnect").attributes.get("title")).toBe("Reconnect");
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
		expect(fixture.button("Take control").attributes.get("aria-pressed")).toBe("false");
		fixture.button("Take control").onclick?.();
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(2));
		expect(fixture.instances[0].disconnect).toHaveBeenCalledOnce();
		expect(fixture.instances[1].viewOnly).toBe(true);
		fixture.instances[1].emit("connect");
		expect(fixture.instances[1].viewOnly).toBe(false);
		expect(fixture.button("Release control").attributes.get("aria-pressed")).toBe("true");
		expect(fixture.button("Release control").attributes.get("aria-label")).toBe("Release control");
		expect(fixture.button("Release control").attributes.get("title")).toBe("Release control");
		expect(fixture.requestConnection.mock.calls.map(([input]) => input.mode)).toEqual(["watch", "control"]);
		fixture.button("Release control").onclick?.();
		expect(fixture.button("Take control").attributes.get("aria-label")).toBe("Take control");
		expect(fixture.button("Take control").attributes.get("title")).toBe("Take control");
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
		expect(fixture.button("Take control").attributes.get("aria-label")).toBe("Take control");
		expect(fixture.button("Take control").attributes.get("title")).toBe("Take control");
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
