import { describe, expect, it } from "vitest";
import {
	MAX_ROOM_DELEGATION_FANOUT,
	planRoomDelegation,
	rootRoomDelegationContext,
} from "../src/room-delegation-policy.ts";

describe("room delegation policy", () => {
	it("allows a bounded three-hop manager chain", () => {
		const first = planRoomDelegation(rootRoomDelegationContext("manager-a"), "manager-a", "manager-b");
		const second = planRoomDelegation(first.target, "manager-b", "manager-c");
		const third = planRoomDelegation(second.target, "manager-c", "worker");

		expect(third.target.depth).toBe(3);
		expect(() => planRoomDelegation(third.target, "worker", "another-worker")).toThrow("3 hops");
	});

	it("rejects self-delegation, cycles, and repeated targets", () => {
		const root = rootRoomDelegationContext("manager-a");
		expect(() => planRoomDelegation(root, "manager-a", "manager-a")).toThrow("itself");
		const first = planRoomDelegation(root, "manager-a", "manager-b");
		expect(() => planRoomDelegation(first.target, "manager-b", "manager-a")).toThrow("cycle");
		expect(() => planRoomDelegation(first.source, "manager-a", "manager-b")).toThrow("already delegated");
	});

	it("caps one manager turn's delegation fanout", () => {
		let context = rootRoomDelegationContext("manager");
		for (let index = 0; index < MAX_ROOM_DELEGATION_FANOUT; index += 1) {
			context = planRoomDelegation(context, "manager", `worker-${index}`).source;
		}
		expect(() => planRoomDelegation(context, "manager", "one-too-many")).toThrow("at most");
	});
});
