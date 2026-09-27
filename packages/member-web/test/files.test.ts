import {
	type CloudMemberCompanyFileClient,
	CloudMemberCompanyRefusal,
	type CloudMemberCompanyUpload,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { describe, expect, it, vi } from "vitest";
import { WebFileUpload } from "../src/files.ts";

function fixture() {
	const stop = new AbortController(),
		calls: CloudMemberCompanyUpload[] = [];
	let fail = true;
	const send = vi.fn(async (input: CloudMemberCompanyUpload) => {
		calls.push(structuredClone(input));
		input.bytes[0] = 9;
		if (fail) throw new Error("Lost reply");
		return {} as Awaited<ReturnType<CloudMemberCompanyFileClient["upload"]>>;
	});
	const upload = new WebFileUpload({
		client: { upload: send },
		signal: stop.signal,
		current: () => stop.signal.throwIfAborted(),
	});
	return {
		upload,
		calls,
		send,
		stop,
		succeed: () => {
			fail = false;
		},
	};
}
describe("explicit browser file selection", () => {
	it("retains exact selected bytes, operation key and destination after a lost reply", async () => {
		const { upload, calls, succeed } = fixture();
		await upload.select(new File([Uint8Array.of(0, 255, 128)], "ø.bin"));
		await expect(upload.submit("documents/ø.bin", null)).rejects.toThrow("Lost reply");
		expect(upload.uncertain).toBe(true);
		await expect(upload.select(new File(["other"], "other.txt"))).rejects.toThrow();
		await expect(upload.submit("changed.bin", null)).rejects.toThrow();
		succeed();
		await upload.submit("documents/ø.bin", null);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual(calls[0]);
		expect(Array.from(calls[1].bytes)).toEqual([0, 255, 128]);
		expect(upload.uncertain).toBe(false);
		expect(upload.selected).toBe(false);
	});
	it("lets go of an upload the cloud refused, which saved nothing and can never apply", async () => {
		const { upload, send } = fixture();
		send.mockRejectedValueOnce(new CloudMemberCompanyRefusal("Company File changed", 412));
		await upload.select(new File(["bytes"], "notes.txt"));
		await expect(upload.submit("notes.txt", null)).rejects.toThrow("Company File changed");
		expect(upload.uncertain).toBe(false);
		expect(upload.selected).toBe(false);
		await upload.select(new File(["other"], "other.txt"));
		expect(upload.selected).toBe(true);
	});
	it.each(["../bad", "bad\0.txt", "..", "x".repeat(256)])(
		"rejects unsafe chooser name %s and clears a previous selection",
		async (name) => {
			const { upload, send } = fixture();
			await upload.select(new File(["old"], "valid.txt"));
			await expect(upload.select(new File(["new"], name))).rejects.toThrow();
			expect(upload.selected).toBe(false);
			await expect(upload.submit("valid.txt", null)).rejects.toThrow();
			expect(send).not.toHaveBeenCalled();
		},
	);
	it("rejects oversize bytes and invalid versions before retaining an operation", async () => {
		const { upload, send } = fixture();
		await expect(upload.select(new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.bin"))).rejects.toThrow();
		await upload.select(new File(["ok"], "ok.txt"));
		await expect(upload.submit("ok.txt", "invalid")).rejects.toThrow();
		expect(upload.uncertain).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});
	it("account cancellation drops an uncertain upload and forbids its retry", async () => {
		const { upload, stop, calls } = fixture();
		await upload.select(new File(["x"], "x.txt"));
		await expect(upload.submit("x.txt", null)).rejects.toThrow();
		stop.abort();
		expect(upload.selected).toBe(false);
		expect(upload.uncertain).toBe(false);
		await expect(upload.submit("x.txt", null)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
	it("cannot clear uncertain bytes to silently substitute another upload", async () => {
		const { upload } = fixture();
		await upload.select(new File(["x"], "x.txt"));
		await expect(upload.submit("x.txt", null)).rejects.toThrow();
		expect(() => upload.clearSelection()).toThrow();
	});
});
