// @vitest-environment jsdom
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ComputerViewHost } from "../src/ui/computer-view-host.ts";
import * as viewer from "../src/ui/computer-viewer.ts";
import { deferred, id, profileA, staff } from "./fixtures.ts";

const scope = {
	companyId: profileA.profileId,
	environmentId: profileA.environmentId,
	companyComputerId: id(30),
	logicalComputerId: id(31),
};
const binding = {
	...scope,
	computerGeneration: 1,
	screenId: id(32),
	screenGeneration: 1,
	screenOrdinal: 1,
	staffAgentId: staff.id,
};

// The renderer chunk itself is not loaded here; computer-runtime tests the viewer's options.
let load: MockInstance<typeof viewer.loadComputerViewer>;
beforeEach(() => {
	load = vi.spyOn(viewer, "loadComputerViewer").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("viewer presentation races", () => {
	it("cancels an opening viewer before attachment and refuses parallel opens", async () => {
		const f = { host: new ComputerViewHost(new AbortController().signal) },
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		const options = {
			binding,
			title: "Computer",
			canControl: false,
			requestConnection: vi.fn<viewer.ComputerViewerOptions["requestConnection"]>(),
		};
		const pending = f.host.open(options);
		const second = f.host.open(options);
		await f.host.close();
		await expect(pending).rejects.toThrow("Viewer closed");
		await expect(second).rejects.toThrow("already opening");
		expect(open).not.toHaveBeenCalled();
		// Closed before the renderer was needed: it is not fetched.
		expect(load).not.toHaveBeenCalled();
	});
	it("fetches the renderer before opening, and a close while it arrives wins", async () => {
		const f = { host: new ComputerViewHost(new AbortController().signal) },
			renderer = deferred<void>(),
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		load.mockReturnValue(renderer.promise);
		const options = { binding, title: "Computer", canControl: false, requestConnection: vi.fn() };
		const pending = f.host.open(options);
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		await f.host.close();
		renderer.resolve();
		await expect(pending).rejects.toThrow("Viewer closed");
		expect(open).not.toHaveBeenCalled();
		// Once it is here, the next open uses it.
		await f.host.open(options);
		expect(open).toHaveBeenCalledOnce();
	});
	it("opens nothing while the renderer cannot load, open after open", async () => {
		const f = { host: new ComputerViewHost(new AbortController().signal) },
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		// loadComputerViewer keeps a failed load, as the browser keeps the failed module.
		load.mockRejectedValue(new viewer.ComputerViewerUnavailable(new TypeError("Failed to fetch")));
		const options = { binding, title: "Computer", canControl: false, requestConnection: vi.fn() };
		await expect(f.host.open(options)).rejects.toBeInstanceOf(viewer.ComputerViewerUnavailable);
		await expect(f.host.open(options)).rejects.toBeInstanceOf(viewer.ComputerViewerUnavailable);
		expect(open).not.toHaveBeenCalled();
		expect(options.requestConnection).not.toHaveBeenCalled();
	});
	it("releases a late connection after the viewer closes", async () => {
		const f = { host: new ComputerViewHost(new AbortController().signal) },
			pending = deferred<CompanyComputerMemberView>(),
			open = vi.spyOn(viewer, "openComputerViewer").mockReturnValue({ close: vi.fn(async () => {}) });
		await f.host.open({ binding, title: "Computer", canControl: false, requestConnection: () => pending.promise });
		const request = open.mock.calls[0]![0].requestConnection({
			binding,
			mode: "watch",
			signal: new AbortController().signal,
		});
		await f.host.close();
		const close = vi.fn(async () => {});
		pending.resolve({
			connectionId: id(60),
			binding,
			mode: "watch",
			close,
			channel: {
				readyState: 1,
				protocol: "",
				binaryType: "arraybuffer",
				onopen: null,
				onclose: null,
				onerror: null,
				onmessage: null,
				send() {},
				close() {},
			},
		});
		await expect(request).rejects.toThrow("Viewer closed");
		expect(close).toHaveBeenCalledOnce();
	});
});
