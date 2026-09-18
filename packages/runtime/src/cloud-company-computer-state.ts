import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerDriver,
	assertCompanyComputerScope,
	COMPANY_COMPUTER_MAX_LEASE_MS,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerDriver,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
	sameCompanyComputerDriver,
} from "@qorpera/cloud-client/cloud-company-computer-contract";

export interface CompanyComputerScreenState {
	screenId: string;
	ordinal: number;
	generation: number;
	staffAgentId: string | null;
	status: "active" | "retired";
	power: "open" | "closed";
	epoch: number;
	touchedAt: number;
	lease: { leaseId: string; driver: CompanyComputerDriver; expiresAt: number } | null;
	/** A takeover is not usable until the guest has drained the previous driver. */
	takeover: { leaseId: string; driver: Extract<CompanyComputerDriver, { kind: "member" }>; expiresAt: number } | null;
	viewers: Array<{ memberId: string; sessionId: string; expiresAt: number }>;
}

/** Enforcement projection over the existing registry; never a second store of company semantics. */
export interface CompanyComputerScreenRegistry {
	scope: CompanyComputerScope;
	computerGeneration: number;
	revision: number;
	lifecycle: "active" | "recovering" | "maintenance" | "retired";
	maxScreens: number;
	screens: CompanyComputerScreenState[];
}

export type CompanyComputerScreenCommand =
	| { type: "ensure"; staffAgentId: string; newScreenId: string }
	| { type: "close"; screenId: string }
	| { type: "detach"; screenId: string }
	| { type: "retire"; screenId: string }
	| { type: "claim"; screenId: string; leaseId: string; driver: CompanyComputerDriver; validForMs: number }
	| {
			type: "renew";
			screenId: string;
			leaseId: string;
			epoch: number;
			driver: CompanyComputerDriver;
			validForMs: number;
	  }
	| { type: "release"; screenId: string; leaseId: string; epoch: number; driver: CompanyComputerDriver }
	| {
			type: "begin_takeover";
			screenId: string;
			leaseId: string;
			driver: Extract<CompanyComputerDriver, { kind: "member" }>;
			validForMs: number;
	  }
	| {
			type: "complete_takeover";
			screenId: string;
			leaseId: string;
			epoch: number;
			acknowledgedComputerGeneration: number;
			acknowledgedScreenGeneration: number;
	  }
	| { type: "revoke"; screenId: string }
	| { type: "watch"; screenId: string; memberId: string; sessionId: string; validForMs: number }
	| { type: "unwatch"; screenId: string; memberId: string; sessionId: string }
	| { type: "sweep_idle"; idleMs: number }
	| { type: "recover"; expectedComputerGeneration: number };

export interface CompanyComputerScreenTransition {
	registry: CompanyComputerScreenRegistry;
	screen?: CompanyComputerScreenState;
	events: Array<{ type: CompanyComputerScreenCommand["type"]; screenId: string; epoch: number }>;
}

function uuid(value: string): void {
	if (!COMPANY_COMPUTER_UUID.test(value)) throw new Error("INVALID_SCREEN_IDENTITY");
}

function duration(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > COMPANY_COMPUTER_MAX_LEASE_MS) {
		throw new Error("INVALID_SCREEN_LEASE_DURATION");
	}
}

function occupied(screen: CompanyComputerScreenState, now: number): boolean {
	return (screen.lease !== null && screen.lease.expiresAt > now) || screen.takeover !== null;
}

/** Validate a restored projection before it can drive a guest. Missing state is never treated as open. */
export function assertCompanyComputerScreenRegistry(registry: CompanyComputerScreenRegistry): void {
	assertCompanyComputerScope(registry.scope, registry.scope);
	if (
		!Number.isSafeInteger(registry.computerGeneration) ||
		registry.computerGeneration < 1 ||
		!Number.isSafeInteger(registry.revision) ||
		registry.revision < 1 ||
		!Number.isSafeInteger(registry.maxScreens) ||
		registry.maxScreens < 1 ||
		registry.maxScreens > 32 ||
		!["active", "recovering", "maintenance", "retired"].includes(registry.lifecycle) ||
		registry.screens.length > 32
	)
		throw new Error("INVALID_SCREEN_REGISTRY");
	const ids = new Set<string>();
	const ordinals = new Set<number>();
	const agents = new Set<string>();
	let active = 0;
	for (const screen of registry.screens) {
		uuid(screen.screenId);
		if (screen.staffAgentId !== null) uuid(screen.staffAgentId);
		if (
			ids.has(screen.screenId) ||
			ordinals.has(screen.ordinal) ||
			!Number.isSafeInteger(screen.ordinal) ||
			screen.ordinal < 1 ||
			screen.ordinal > 32 ||
			!Number.isSafeInteger(screen.generation) ||
			screen.generation < 1 ||
			!Number.isSafeInteger(screen.epoch) ||
			screen.epoch < 0 ||
			!Number.isSafeInteger(screen.touchedAt) ||
			screen.touchedAt < 0 ||
			!["active", "retired"].includes(screen.status) ||
			!["open", "closed"].includes(screen.power) ||
			(screen.staffAgentId !== null && agents.has(screen.staffAgentId)) ||
			(screen.status === "retired" && (screen.staffAgentId !== null || screen.power !== "closed")) ||
			(screen.power === "closed" &&
				(screen.lease !== null || screen.takeover !== null || screen.viewers.length > 0)) ||
			(screen.lease !== null && screen.takeover !== null) ||
			screen.viewers.length > 32
		)
			throw new Error("INVALID_SCREEN_REGISTRY");
		ids.add(screen.screenId);
		ordinals.add(screen.ordinal);
		if (screen.staffAgentId !== null) agents.add(screen.staffAgentId);
		if (screen.status === "active") active++;
		for (const holder of [screen.lease, screen.takeover]) {
			if (!holder) continue;
			uuid(holder.leaseId);
			assertCompanyComputerDriver(holder.driver);
			if (
				!Number.isSafeInteger(holder.expiresAt) ||
				holder.expiresAt < 1 ||
				screen.epoch < 1 ||
				screen.staffAgentId === null ||
				(holder.driver.kind === "agent" && holder.driver.staffAgentId !== screen.staffAgentId)
			)
				throw new Error("INVALID_SCREEN_REGISTRY");
		}
		if (screen.takeover && screen.takeover.driver.kind !== "member") throw new Error("INVALID_SCREEN_REGISTRY");
		const sessions = new Set<string>();
		for (const viewer of screen.viewers) {
			uuid(viewer.memberId);
			uuid(viewer.sessionId);
			if (sessions.has(viewer.sessionId) || !Number.isSafeInteger(viewer.expiresAt) || viewer.expiresAt < 1) {
				throw new Error("INVALID_SCREEN_REGISTRY");
			}
			sessions.add(viewer.sessionId);
		}
	}
	if (active > registry.maxScreens) throw new Error("INVALID_SCREEN_REGISTRY");
}

/**
 * Reuses the older registry's ensure/open/claim/idle rules, adding generations,
 * exact leases, viewer presence and acknowledged takeover. Pure transition only.
 * The Step 2 authorized transaction MUST lock the company registry and screen,
 * recheck live principals/grants, persist state + events + operation receipt
 * atomically, and publish fencing changes to the guest. Never call this on a
 * model-supplied state or persist its output in a desktop/local authority file.
 */
export function transitionCompanyComputerScreens(
	current: CompanyComputerScreenRegistry,
	expected: CompanyComputerScope,
	command: CompanyComputerScreenCommand,
	now: number,
): CompanyComputerScreenTransition {
	assertCompanyComputerScreenRegistry(current);
	assertCompanyComputerScope(current.scope, expected);
	if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_SCREEN_TIME");
	const registry = structuredClone(current);
	const events: CompanyComputerScreenTransition["events"] = [];
	const changed = (screen: CompanyComputerScreenState): void => {
		screen.touchedAt = now;
		events.push({ type: command.type, screenId: screen.screenId, epoch: screen.epoch });
	};
	if (command.type === "recover") {
		if (registry.lifecycle !== "recovering" || registry.computerGeneration !== command.expectedComputerGeneration) {
			throw new Error("COMPUTER_RECOVERY_NOT_ADMITTED");
		}
		registry.computerGeneration++;
		for (const screen of registry.screens) {
			screen.epoch++;
			screen.lease = null;
			screen.takeover = null;
			screen.viewers = [];
			changed(screen);
		}
		// The provider, not this transition, marks the computer active after guest readiness.
	} else {
		if (registry.lifecycle !== "active") throw new Error("COMPUTER_NOT_ACTIVE");
		if (command.type === "ensure") {
			uuid(command.staffAgentId);
			uuid(command.newScreenId);
			let screen = registry.screens.find((entry) => entry.staffAgentId === command.staffAgentId);
			if (!screen) {
				screen = registry.screens.find((entry) => entry.status === "active" && entry.staffAgentId === null);
				if (!screen && registry.screens.filter((entry) => entry.status === "active").length < registry.maxScreens) {
					// Rows identify physical display slots. Retirement is kept in the existing
					// event history; it must not consume an ordinal for the company's lifetime.
					screen = registry.screens.find((entry) => entry.status === "retired");
				}
				if (screen) {
					screen.generation++;
					screen.status = "active";
				} else {
					const ordinal = Array.from({ length: 32 }, (_, index) => index + 1).find(
						(value) => !registry.screens.some((entry) => entry.ordinal === value),
					);
					if (
						!ordinal ||
						registry.screens.filter((entry) => entry.status === "active").length >= registry.maxScreens
					) {
						throw new Error("SCREEN_CAPACITY_EXHAUSTED");
					}
					if (registry.screens.some((entry) => entry.screenId === command.newScreenId))
						throw new Error("SCREEN_ID_REUSED");
					screen = {
						screenId: command.newScreenId,
						ordinal,
						generation: 1,
						staffAgentId: null,
						status: "active",
						power: "closed",
						epoch: 0,
						touchedAt: now,
						lease: null,
						takeover: null,
						viewers: [],
					};
					registry.screens.push(screen);
				}
				screen.staffAgentId = command.staffAgentId;
			}
			if (screen.power === "closed") screen.generation++;
			screen.power = "open";
			changed(screen);
		} else if (command.type === "sweep_idle") {
			if (!Number.isSafeInteger(command.idleMs) || command.idleMs < 60_000)
				throw new Error("INVALID_SCREEN_IDLE_WINDOW");
			for (const screen of registry.screens) {
				screen.viewers = screen.viewers.filter((viewer) => viewer.expiresAt > now);
				if (
					screen.status !== "active" ||
					screen.power !== "open" ||
					occupied(screen, now) ||
					screen.viewers.length > 0 ||
					now - screen.touchedAt < command.idleMs
				)
					continue;
				screen.power = "closed";
				screen.lease = null;
				screen.epoch++;
				changed(screen);
			}
		} else {
			const screen = registry.screens.find(
				(entry) => entry.screenId === command.screenId && entry.status === "active",
			);
			if (!screen) throw new Error("SCREEN_UNAVAILABLE");
			if (command.type === "close" || command.type === "detach" || command.type === "retire") {
				if (occupied(screen, now)) throw new Error("SCREEN_OCCUPIED");
				screen.power = "closed";
				screen.lease = null;
				screen.viewers = [];
				screen.epoch++;
				if (command.type !== "close") {
					screen.staffAgentId = null;
					screen.generation++;
				}
				if (command.type === "retire") screen.status = "retired";
			} else if (command.type === "revoke") {
				screen.epoch++;
				screen.lease = null;
				screen.takeover = null;
				screen.viewers = [];
			} else {
				if (screen.power !== "open" || !screen.staffAgentId) throw new Error("SCREEN_UNAVAILABLE");
				if (command.type === "watch" || command.type === "unwatch") {
					uuid(command.memberId);
					uuid(command.sessionId);
					const previous = screen.viewers.find((viewer) => viewer.sessionId === command.sessionId);
					if (previous && previous.memberId !== command.memberId) throw new Error("VIEWER_BINDING_MISMATCH");
					screen.viewers = screen.viewers.filter(
						(viewer) => viewer.sessionId !== command.sessionId && viewer.expiresAt > now,
					);
					if (command.type === "watch") {
						duration(command.validForMs);
						if (screen.viewers.length >= 32) throw new Error("VIEWER_CAPACITY_EXHAUSTED");
						screen.viewers.push({
							memberId: command.memberId,
							sessionId: command.sessionId,
							expiresAt: now + command.validForMs,
						});
					}
				} else if (command.type === "complete_takeover") {
					if (
						!screen.takeover ||
						screen.takeover.leaseId !== command.leaseId ||
						screen.epoch !== command.epoch ||
						screen.takeover.expiresAt <= now ||
						registry.computerGeneration !== command.acknowledgedComputerGeneration ||
						screen.generation !== command.acknowledgedScreenGeneration
					)
						throw new Error("TAKEOVER_NOT_ACKNOWLEDGED");
					screen.lease = screen.takeover;
					screen.takeover = null;
				} else {
					assertCompanyComputerDriver(command.driver);
					uuid(command.leaseId);
					if (command.type !== "release") duration(command.validForMs);
					if (command.driver.kind === "agent" && command.driver.staffAgentId !== screen.staffAgentId) {
						throw new Error("SCREEN_AGENT_MISMATCH");
					}
					if (command.type === "begin_takeover") {
						if (command.driver.kind !== "member") throw new Error("MEMBER_TAKEOVER_REQUIRED");
						if (screen.takeover) throw new Error("TAKEOVER_PENDING");
						screen.epoch++;
						screen.lease = null;
						screen.takeover = {
							leaseId: command.leaseId,
							driver: command.driver,
							expiresAt: now + command.validForMs,
						};
					} else if (command.type === "claim") {
						// Members enter via acknowledged takeover, even when the screen appears idle.
						if (command.driver.kind !== "agent") throw new Error("MEMBER_TAKEOVER_REQUIRED");
						if (occupied(screen, now)) throw new Error("SCREEN_OCCUPIED");
						screen.epoch++;
						screen.lease = {
							leaseId: command.leaseId,
							driver: command.driver,
							expiresAt: now + command.validForMs,
						};
					} else {
						const matches =
							screen.lease !== null &&
							screen.lease.leaseId === command.leaseId &&
							screen.epoch === command.epoch &&
							sameCompanyComputerDriver(screen.lease.driver, command.driver);
						if (command.type === "release") {
							if (!matches) return { registry, screen, events };
							screen.lease = null;
							screen.epoch++;
						} else {
							if (!matches || !screen.lease || screen.lease.expiresAt <= now || screen.takeover)
								throw new Error("SCREEN_LEASE_EXPIRED");
							screen.lease.expiresAt = now + command.validForMs;
						}
					}
				}
			}
			changed(screen);
		}
	}
	registry.revision++;
	assertCompanyComputerScreenRegistry(registry);
	const screen =
		command.type === "ensure"
			? registry.screens.find((entry) => entry.staffAgentId === command.staffAgentId)
			: "screenId" in command
				? registry.screens.find((entry) => entry.screenId === command.screenId)
				: undefined;
	return { registry, events, ...(screen ? { screen } : {}) };
}

export function companyComputerScreenBinding(
	registry: CompanyComputerScreenRegistry,
	screen: CompanyComputerScreenState,
): CompanyComputerScreenBinding {
	assertCompanyComputerScreenRegistry(registry);
	if (
		!isDeepStrictEqual(
			registry.screens.find((entry) => entry.screenId === screen.screenId),
			screen,
		)
	) {
		throw new Error("SCREEN_NOT_REGISTERED");
	}
	if (!screen.staffAgentId) throw new Error("SCREEN_NOT_ASSIGNED");
	return {
		...registry.scope,
		computerGeneration: registry.computerGeneration,
		screenId: screen.screenId,
		screenOrdinal: screen.ordinal,
		screenGeneration: screen.generation,
		staffAgentId: screen.staffAgentId,
	};
}

export function companyComputerScreenLease(
	registry: CompanyComputerScreenRegistry,
	screen: CompanyComputerScreenState,
	now: number,
): CompanyComputerScreenLease {
	if (
		!Number.isSafeInteger(now) ||
		now < 0 ||
		registry.lifecycle !== "active" ||
		screen.status !== "active" ||
		screen.power !== "open"
	) {
		throw new Error("SCREEN_UNAVAILABLE");
	}
	if (!screen.lease || screen.takeover || screen.lease.expiresAt <= now) throw new Error("SCREEN_LEASE_EXPIRED");
	return {
		binding: companyComputerScreenBinding(registry, screen),
		leaseId: screen.lease.leaseId,
		epoch: screen.epoch,
		driver: structuredClone(screen.lease.driver),
		validForMs: Math.min(COMPANY_COMPUTER_MAX_LEASE_MS, screen.lease.expiresAt - now),
	};
}

/** Provider hook only. Recheck revision + resource leases atomically before changing physical power. */
export function companyComputerPowerIntent(input: {
	registry: CompanyComputerScreenRegistry;
	liveResourceLeases: number;
	stoppedFor: "idle" | "maintenance" | null;
	idleSince: number | null;
	idleMs: number;
	now: number;
}): "keep" | "start" | "start_idle_window" | "stop" {
	assertCompanyComputerScreenRegistry(input.registry);
	if (
		!Number.isSafeInteger(input.liveResourceLeases) ||
		input.liveResourceLeases < 0 ||
		!Number.isSafeInteger(input.idleMs) ||
		input.idleMs < 0 ||
		!Number.isSafeInteger(input.now) ||
		input.now < 0 ||
		(input.idleSince !== null &&
			(!Number.isSafeInteger(input.idleSince) || input.idleSince < 0 || input.idleSince > input.now))
	) {
		throw new Error("INVALID_COMPUTER_ACTIVITY");
	}
	if (input.registry.lifecycle !== "active" || input.stoppedFor === "maintenance") return "keep";
	if (
		input.liveResourceLeases > 0 ||
		input.registry.screens.some((screen) => screen.status === "active" && screen.power === "open")
	)
		return "start";
	if (input.idleMs === 0) return "start";
	if (input.stoppedFor === "idle") return "keep";
	if (input.idleSince === null) return "start_idle_window";
	return input.now - input.idleSince >= input.idleMs ? "stop" : "keep";
}
