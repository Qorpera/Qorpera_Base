import { describe, expect, it } from "vitest";
import { assertCompanyComputerScreenBinding } from "../src/cloud-company-computer-contract.ts";
import {
	assertCompanyComputerScreenRegistry,
	companyComputerPowerIntent,
	companyComputerScreenBinding,
	companyComputerScreenLease,
	transitionCompanyComputerScreens,
} from "../src/cloud-company-computer-state.ts";
import { computerId, computerLease, computerRegistry, computerScope } from "./fixtures/company-computer.ts";

describe("company computer registry transitions (component, not authorization/database acceptance)", () => {
	it.each(["companyId", "environmentId", "companyComputerId", "logicalComputerId"] as const)(
		"rejects a foreign %s before changing state",
		(key) => {
			const registry = computerRegistry();
			expect(() =>
				transitionCompanyComputerScreens(
					registry,
					{ ...computerScope(), [key]: computerId(99) },
					{ type: "revoke", screenId: computerId(6) },
					10,
				),
			).toThrow("COMPUTER_BINDING_MISMATCH");
			expect(registry.revision).toBe(1);
		},
	);

	it("keeps one assigned screen per agent, parallel desktops on the same computer, and stable assignment across reopen", () => {
		let registry = computerRegistry();
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(12) },
			10,
		).registry;
		expect(registry.screens.map((screen) => screen.ordinal)).toEqual([1, 2]);
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(13) },
			20,
		).registry;
		expect(registry.screens).toHaveLength(2);
		const previous = companyComputerScreenBinding(registry, registry.screens[1]);
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "close", screenId: computerId(12) },
			30,
		).registry;
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(14) },
			40,
		).registry;
		const reopened = companyComputerScreenBinding(registry, registry.screens[1]);
		expect(reopened).toEqual({ ...previous, screenGeneration: previous.screenGeneration + 1 });
	});

	it("reuses a detached slot with a new generation and enforces capacity", () => {
		let registry = { ...computerRegistry(), maxScreens: 1 };
		expect(() =>
			transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(12) },
				10,
			),
		).toThrow("SCREEN_CAPACITY_EXHAUSTED");
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "detach", screenId: computerId(6) },
			20,
		).registry;
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(12) },
			30,
		).registry;
		expect(registry.screens).toHaveLength(1);
		expect(registry.screens[0]).toMatchObject({
			screenId: computerId(6),
			staffAgentId: computerId(11),
			power: "open",
		});
		expect(registry.screens[0].generation).toBeGreaterThan(1);
	});

	it("rejects wrong-agent claims, member claims without takeover, occupancy conflicts and occupied closure", () => {
		const base = computerRegistry();
		const claim = {
			type: "claim" as const,
			screenId: computerId(6),
			leaseId: computerId(9),
			driver: computerLease().driver,
			validForMs: 1000,
		};
		expect(() =>
			transitionCompanyComputerScreens(
				base,
				base.scope,
				{ ...claim, driver: { kind: "agent", runId: computerId(7), staffAgentId: computerId(99) } },
				10,
			),
		).toThrow("SCREEN_AGENT_MISMATCH");
		expect(() =>
			transitionCompanyComputerScreens(
				base,
				base.scope,
				{ ...claim, driver: { kind: "member", memberId: computerId(8), sessionId: computerId(30) } },
				10,
			),
		).toThrow("MEMBER_TAKEOVER_REQUIRED");
		const held = transitionCompanyComputerScreens(base, base.scope, claim, 10).registry;
		expect(() =>
			transitionCompanyComputerScreens(held, held.scope, { ...claim, leaseId: computerId(11) }, 11),
		).toThrow("SCREEN_OCCUPIED");
		expect(() =>
			transitionCompanyComputerScreens(held, held.scope, { type: "close", screenId: computerId(6) }, 11),
		).toThrow("SCREEN_OCCUPIED");
	});

	it("reuses retired physical slots beyond 32 retirements without reusing a binding generation", () => {
		let registry = { ...computerRegistry(), maxScreens: 1 };
		const original = companyComputerScreenBinding(registry, registry.screens[0]);
		let previous = original;
		for (let index = 0; index < 100; index++) {
			registry = transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "retire", screenId: original.screenId },
				index * 2,
			).registry;
			expect(registry.screens[0].status).toBe("retired");
			registry = transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "ensure", staffAgentId: computerId(100 + index), newScreenId: computerId(300 + index) },
				index * 2 + 1,
			).registry;
			const next = companyComputerScreenBinding(registry, registry.screens[0]);
			expect(registry.screens).toHaveLength(1);
			expect(next.screenId).toBe(original.screenId);
			expect(next.screenOrdinal).toBe(original.screenOrdinal);
			expect(next.screenGeneration).toBeGreaterThan(previous.screenGeneration);
			expect(() => assertCompanyComputerScreenBinding(previous, next)).toThrow("SCREEN_BINDING_MISMATCH");
			previous = next;
		}
		expect(registry.screens[0]).toMatchObject({ status: "active", power: "open", lease: null, viewers: [] });
	});

	it("does not revive a retired slot beyond the active capacity", () => {
		let registry = computerRegistry();
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "ensure", staffAgentId: computerId(11), newScreenId: computerId(12) },
			1,
		).registry;
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "retire", screenId: computerId(6) },
			2,
		).registry;
		registry.maxScreens = 1;
		expect(() =>
			transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "ensure", staffAgentId: computerId(13), newScreenId: computerId(14) },
				3,
			),
		).toThrow("SCREEN_CAPACITY_EXHAUSTED");
		expect(registry.screens[0].status).toBe("retired");
	});

	it("never resurrects an expired lease and stale cleanup cannot release its replacement", () => {
		const base = computerRegistry();
		const first = transitionCompanyComputerScreens(
			base,
			base.scope,
			{
				type: "claim",
				screenId: computerId(6),
				leaseId: computerId(9),
				driver: computerLease().driver,
				validForMs: 100,
			},
			10,
		).registry;
		const renew = {
			type: "renew" as const,
			screenId: computerId(6),
			leaseId: computerId(9),
			epoch: 1,
			driver: computerLease().driver,
			validForMs: 100,
		};
		expect(() => transitionCompanyComputerScreens(first, first.scope, renew, 110)).toThrow("SCREEN_LEASE_EXPIRED");
		let next = transitionCompanyComputerScreens(
			first,
			first.scope,
			{
				type: "claim",
				screenId: computerId(6),
				leaseId: computerId(12),
				driver: computerLease().driver,
				validForMs: 100,
			},
			111,
		).registry;
		const beforeCleanup = structuredClone(next);
		next = transitionCompanyComputerScreens(
			next,
			next.scope,
			{ type: "release", screenId: computerId(6), leaseId: computerId(9), epoch: 1, driver: computerLease().driver },
			112,
		).registry;
		expect(next).toEqual(beforeCleanup);
		expect(companyComputerScreenLease(next, next.screens[0], 112)).toMatchObject({
			leaseId: computerId(12),
			epoch: 2,
		});
	});

	it("grants member takeover only after the exact guest fence acknowledgement", () => {
		let registry = computerRegistry();
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{
				type: "claim",
				screenId: computerId(6),
				leaseId: computerId(9),
				driver: computerLease().driver,
				validForMs: 1000,
			},
			10,
		).registry;
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{
				type: "begin_takeover",
				screenId: computerId(6),
				leaseId: computerId(20),
				driver: { kind: "member", memberId: computerId(8), sessionId: computerId(21) },
				validForMs: 1000,
			},
			20,
		).registry;
		expect(() => companyComputerScreenLease(registry, registry.screens[0], 21)).toThrow("SCREEN_LEASE_EXPIRED");
		const complete = {
			type: "complete_takeover" as const,
			screenId: computerId(6),
			leaseId: computerId(20),
			epoch: 2,
			acknowledgedComputerGeneration: 1,
			acknowledgedScreenGeneration: 1,
		};
		for (const patch of [
			{ epoch: 1 },
			{ acknowledgedComputerGeneration: 2 },
			{ acknowledgedScreenGeneration: 2 },
			{ leaseId: computerId(22) },
		]) {
			expect(() =>
				transitionCompanyComputerScreens(registry, registry.scope, { ...complete, ...patch }, 21),
			).toThrow("TAKEOVER_NOT_ACKNOWLEDGED");
		}
		registry = transitionCompanyComputerScreens(registry, registry.scope, complete, 21).registry;
		expect(companyComputerScreenLease(registry, registry.screens[0], 22).driver).toEqual({
			kind: "member",
			memberId: computerId(8),
			sessionId: computerId(21),
		});
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "revoke", screenId: computerId(6) },
			23,
		).registry;
		expect(registry.screens[0]).toMatchObject({ lease: null, takeover: null, epoch: 3 });
	});

	it("keeps an unacknowledged takeover fenced after timeout until explicit recovery or revocation", () => {
		const base = computerRegistry();
		const pending = transitionCompanyComputerScreens(
			base,
			base.scope,
			{
				type: "begin_takeover",
				screenId: computerId(6),
				leaseId: computerId(20),
				driver: { kind: "member", memberId: computerId(8), sessionId: computerId(21) },
				validForMs: 100,
			},
			0,
		).registry;
		expect(() =>
			transitionCompanyComputerScreens(
				pending,
				pending.scope,
				{
					type: "claim",
					screenId: computerId(6),
					leaseId: computerId(9),
					driver: computerLease().driver,
					validForMs: 100,
				},
				101,
			),
		).toThrow("SCREEN_OCCUPIED");
	});

	it("uses exact viewer presence for idle power, never substitutes a different member", () => {
		const base = computerRegistry();
		let registry = transitionCompanyComputerScreens(
			base,
			base.scope,
			{
				type: "watch",
				screenId: computerId(6),
				memberId: computerId(8),
				sessionId: computerId(21),
				validForMs: 30_000,
			},
			60_000,
		).registry;
		expect(() =>
			transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "unwatch", screenId: computerId(6), memberId: computerId(99), sessionId: computerId(21) },
				60_001,
			),
		).toThrow("VIEWER_BINDING_MISMATCH");
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "sweep_idle", idleMs: 60_000 },
			80_000,
		).registry;
		expect(registry.screens[0].power).toBe("open");
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{ type: "sweep_idle", idleMs: 60_000 },
			120_001,
		).registry;
		expect(registry.screens[0]).toMatchObject({ power: "closed", viewers: [] });
		const power = {
			registry,
			liveResourceLeases: 0,
			stoppedFor: null,
			idleSince: 120_001,
			idleMs: 300_000,
			now: 420_001,
		} as const;
		expect(companyComputerPowerIntent(power)).toBe("stop");
		expect(companyComputerPowerIntent({ ...power, liveResourceLeases: 2 })).toBe("start");
		expect(companyComputerPowerIntent({ ...power, liveResourceLeases: 2, stoppedFor: "maintenance" })).toBe("keep");
	});

	it("recovers durable assignments while invalidating every ephemeral driver/viewer", () => {
		let registry = computerRegistry();
		registry = transitionCompanyComputerScreens(
			registry,
			registry.scope,
			{
				type: "claim",
				screenId: computerId(6),
				leaseId: computerId(9),
				driver: computerLease().driver,
				validForMs: 1000,
			},
			10,
		).registry;
		expect(() =>
			transitionCompanyComputerScreens(
				registry,
				registry.scope,
				{ type: "recover", expectedComputerGeneration: 1 },
				20,
			),
		).toThrow("COMPUTER_RECOVERY_NOT_ADMITTED");
		const recovered = transitionCompanyComputerScreens(
			{ ...registry, lifecycle: "recovering" },
			registry.scope,
			{ type: "recover", expectedComputerGeneration: 1 },
			20,
		).registry;
		expect(recovered).toMatchObject({ computerGeneration: 2, lifecycle: "recovering" });
		expect(recovered.screens[0]).toMatchObject({
			screenId: computerId(6),
			staffAgentId: computerId(5),
			power: "open",
			lease: null,
			viewers: [],
			epoch: 2,
		});
		expect(registry.computerGeneration).toBe(1);
	});

	it("rejects corrupt restored projection instead of assuming a runnable screen", () => {
		for (const registry of [
			{
				...computerRegistry(),
				screens: [...computerRegistry().screens, { ...computerRegistry().screens[0], screenId: computerId(12) }],
			},
			{ ...computerRegistry(), screens: [{ ...computerRegistry().screens[0], power: undefined }] },
		])
			expect(() => assertCompanyComputerScreenRegistry(registry as ReturnType<typeof computerRegistry>)).toThrow(
				"INVALID_SCREEN_REGISTRY",
			);
	});
});
