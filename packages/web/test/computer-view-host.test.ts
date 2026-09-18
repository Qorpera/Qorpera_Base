// @vitest-environment jsdom
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import { afterEach, describe, expect, it, vi } from "vitest";
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
