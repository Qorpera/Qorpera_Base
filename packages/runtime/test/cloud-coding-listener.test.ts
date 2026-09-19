import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudCodingListenerControl } from "../src/cloud-coding-control.ts";
import { CloudCodingCompletionListener } from "../src/cloud-coding-listener.ts";

describe("durable coding completion listener", () => {
	it("delivers each event by its durable ID and reports only confirmed receipts", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		const call = vi.fn<CloudCodingListenerControl["call"]>(async (method, args) =>
			method === "qorpera_read_coding_completions"
				? ids.map((id) => ({ id }))
				: {
						schema: "qorpera.coding-completion-delivery/v1",
						eventId: args.p_event_id,
						status:
							args.p_event_id === ids[0] ? "delivered" : args.p_event_id === ids[1] ? "pending" : "cancelled",
						occurrenceId: args.p_event_id === ids[0] ? randomUUID() : null,
					},
		);
		expect(
			await new CloudCodingCompletionListener({ call }, "coding-node-01").tick(new AbortController().signal),
		).toEqual({ inspected: 3, delivered: 1, pending: 1, cancelled: 1, unconfirmed: 0 });
		expect(call.mock.calls.slice(1).map((row) => row[1])).toEqual(ids.map((id) => ({ p_event_id: id })));
	});
	it("restarts from pending SQL events after a lost response without inventing success", async () => {
		const id = randomUUID();
		const call = vi
			.fn<CloudCodingListenerControl["call"]>()
			.mockResolvedValueOnce([{ id }])
			.mockRejectedValueOnce(new Error("secret remote text"))
			.mockResolvedValueOnce([]);
		expect(
			await new CloudCodingCompletionListener({ call }, "owner").tick(new AbortController().signal),
		).toMatchObject({ unconfirmed: 1, delivered: 0 });
		expect(
			await new CloudCodingCompletionListener({ call }, "owner").tick(new AbortController().signal),
		).toMatchObject({ inspected: 0, delivered: 0 });
		expect(call).toHaveBeenCalledTimes(3);
	});
	it("rejects duplicate event pages before admitting effects", async () => {
		const id = randomUUID();
		const call = vi.fn<CloudCodingListenerControl["call"]>().mockResolvedValue([{ id }, { id }]);
		await expect(
			new CloudCodingCompletionListener({ call }, "owner").tick(new AbortController().signal),
		).rejects.toThrow("Duplicate");
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("does not accept a forged occurrence or another event as delivered", async () => {
		const id = randomUUID();
		const call = vi.fn<CloudCodingListenerControl["call"]>().mockResolvedValueOnce([{ id }]).mockResolvedValueOnce({
			schema: "qorpera.coding-completion-delivery/v1",
			eventId: randomUUID(),
			status: "delivered",
			occurrenceId: null,
		});
		expect(
			await new CloudCodingCompletionListener({ call }, "owner").tick(new AbortController().signal),
		).toMatchObject({ delivered: 0, unconfirmed: 1 });
	});
	it("stops on cancellation without consuming another event", async () => {
		const stop = new AbortController();
		const call = vi.fn<CloudCodingListenerControl["call"]>(async () => {
			stop.abort();
			return [{ id: randomUUID() }];
		});
		await expect(new CloudCodingCompletionListener({ call }, "owner").tick(stop.signal)).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(1);
	});
});
