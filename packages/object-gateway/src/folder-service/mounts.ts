import { createHash, timingSafeEqual } from "node:crypto";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { FolderActor } from "./core.ts";
import { isMachine, type MachineRef, parseMachineRef } from "./machines.ts";
import { type BridgeInfo, ErrorCode, type Hello, ProtocolError } from "./protocol.ts";

/** A mount the operator set up on one machine (step 1: the proof company on the execution host, outside any box).
 * It reads as a member or as the platform. Its pass is in the machine's view file; this node keeps its sha256. */
export interface OperatorMount {
	readonly id: string;
	readonly environmentId: string;
	readonly actor: Extract<FolderActor, { kind: "member" } | { kind: "platform" }>;
	readonly machine: MachineRef;
	readonly passSha256: Buffer;
	/** Writes through the mount (F3 step 3): off unless set. */
	readonly write: boolean;
	/** Publish after this long with no change (the desktop rule, RUNTIME-FOLDER-WRITES.md "A boundary"); none: only
	 * when the machine asks. */
	readonly quietMs?: number;
}

/** What a machine's hello was granted. Connections with the same key share one view's tree, and must present the same
 * pass (`passSha256`). A core view (`lease`) is the core's: this service keeps its lease while machines are connected. */
export interface Grant {
	readonly key: string;
	readonly environmentId: string;
	readonly actor: FolderActor;
	readonly passSha256: Buffer;
	readonly lease?: { readonly viewId: string; readonly pass: string };
	/** The view may write (step 3: an operator mount configured so). A core view's grant never writes: whether it may
	 * is learned from the core at its first renewal (`coreAccess`). */
	readonly write: boolean;
	readonly quietMs?: number;
}

/** What a core view of a given kind and machine is served as, and to which machines. */
export interface CoreAccess {
	readonly write: boolean;
	readonly quietMs?: number;
	/** A command's view (F3 4b): published after its quiet period while held (4b-2) and when asked, its last publish
	 * final (the core closes the view with it); kept when its last connection leaves; its renewals say nothing is
	 * unsaved (no seat waits on a command). */
	readonly command?: true;
	/** Whether the calling machine may present the view. */
	admits(bridge: BridgeInfo): boolean;
}

/** The core's view passes: 32 random bytes, base64url without padding (C1b-3a `qorpera_folder_view_new_pass`). */
const CORE_PASS = /^[A-Za-z0-9_-]{43}$/;

/** A company machine: the node names it after its allocation (`lxd-office-guest.ts`). */
const OFFICE = /^qorpera-office-[0-9a-f]{32}$/;

/** A desktop publishes this long after its last change (RUNTIME-COMPANY-FOLDER.md §2: "one to two seconds"), and so
 * does a running command (the contract's 14 October 2026 amendment, item 3: "as a desktop's saves do"). */
export const DESKTOP_QUIET_MS = 2_000;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The `mounts` list of the service's configuration. */
export function parseOperatorMounts(value: unknown): OperatorMount[] {
	if (!Array.isArray(value)) throw new Error("mounts must be a list");
	const seen = new Set<string>();
	return value.map((item) => {
		const m = item as Record<string, unknown>;
		if (!m || typeof m !== "object") throw new Error("A mount must be an object");
		const keys = ["id", "environmentId", "actor", "machine", "passSha256"];
		const optional = ["write", "quietMs"];
		if (keys.some((k) => !(k in m)) || Object.keys(m).some((k) => !keys.includes(k) && !optional.includes(k)))
			throw new Error("A mount is {id, environmentId, actor, machine, passSha256, write?, quietMs?}");
		if (m.write !== undefined && typeof m.write !== "boolean") throw new Error("A mount's write is true or false");
		if (
			m.quietMs !== undefined &&
			(typeof m.quietMs !== "number" || !Number.isSafeInteger(m.quietMs) || m.quietMs < 500 || m.quietMs > 60_000)
		)
			throw new Error("A mount's quietMs is from 500 to 60000");
		// A uuid-shaped id would be taken for a core view's and could never be used.
		if (typeof m.id !== "string" || !ID.test(m.id) || isUuid(m.id) || seen.has(m.id))
			throw new Error("Mount ids must be unique slugs, not uuids");
		seen.add(m.id);
		if (typeof m.environmentId !== "string" || !isUuid(m.environmentId)) throw new Error("Bad mount environment");
		const a = m.actor as Record<string, unknown>;
		let actor: OperatorMount["actor"];
		if (a?.kind === "platform" && Object.keys(a).length === 1) actor = { kind: "platform" };
		else if (a?.kind === "member" && Object.keys(a).length === 2 && typeof a.userId === "string" && isUuid(a.userId))
			actor = { kind: "member", userId: a.userId };
		else throw new Error("A mount's actor is {kind: platform} or {kind: member, userId}");
		if (typeof m.passSha256 !== "string" || !SHA256_HEX_PATTERN.test(m.passSha256))
			throw new Error("passSha256 must be 64 hex characters");
		return {
			id: m.id,
			environmentId: m.environmentId,
			actor,
			machine: parseMachineRef(m.machine),
			passSha256: Buffer.from(m.passSha256, "hex"),
			write: m.write === true,
			...(m.quietMs === undefined ? {} : { quietMs: m.quietMs as number }),
		};
	});
}

/** Decides whether a machine's hello opens a view. Every refusal looks the same to the machine. */
export class MountGrants {
	readonly #mounts: Map<string, OperatorMount>;
	readonly #runBoxHosts: readonly MachineRef[];
	readonly #companyMachineProjects: readonly string[];

	/** `runBoxHosts`: the machines on this node that may present the core's run box views (the execution host).
	 * `companyMachineProjects`: the LXD projects of this node's company machines, each of which may present its own
	 * desktop views. */
	constructor(
		mounts: readonly OperatorMount[],
		runBoxHosts: readonly MachineRef[] = [],
		companyMachineProjects: readonly string[] = [],
	) {
		this.#mounts = new Map(mounts.map((m) => [m.id, m]));
		this.#runBoxHosts = runBoxHosts;
		this.#companyMachineProjects = companyMachineProjects;
	}

	/** How a core view the core says is `kind`, on machine allocation `machineId`, is served; none for a kind this node
	 * does not serve yet (a coding session's: step 5). A run box view is read-only, from a run box host. A computer
	 * desktop's and a shell command's are served to their own company machine alone (named after the view's
	 * allocation, in a company machine project) and write, publishing after a quiet period; a command's also publishes
	 * when asked, its last publish final. */
	coreAccess(identity: { readonly kind: string; readonly machineId: string | null }): CoreAccess | undefined {
		if (identity.kind === "run_box")
			return { write: false, admits: (bridge) => this.#runBoxHosts.some((host) => isMachine(bridge, host)) };
		const desktop = identity.kind === "computer_desktop";
		if (
			(desktop || identity.kind === "computer_shell_command") &&
			identity.machineId !== null &&
			isUuid(identity.machineId)
		) {
			const name = `qorpera-office-${identity.machineId.replaceAll("-", "")}`;
			const admits = (bridge: BridgeInfo): boolean =>
				bridge.lookup === "found" &&
				bridge.machine !== undefined &&
				this.#companyMachineProjects.includes(bridge.machine.project) &&
				bridge.machine.name === name;
			return desktop
				? { write: true, quietMs: DESKTOP_QUIET_MS, admits }
				: { write: true, quietMs: DESKTOP_QUIET_MS, command: true, admits };
		}
		return undefined;
	}

	/** A wrong pass, environment or machine is refused, all alike. When LXD could not say which machine called,
	 * the answer is "unavailable": the machine asks again rather than taking it as its view's end. */
	admit(hello: Hello, bridge: BridgeInfo): Grant {
		if (isUuid(hello.viewId)) return this.#coreView(hello, bridge);
		const mount = this.#mounts.get(hello.viewId);
		const pass = createHash("sha256").update(hello.pass).digest();
		const passOk = mount !== undefined && timingSafeEqual(pass, mount.passSha256);
		if (!mount || !passOk || mount.environmentId !== hello.environmentId)
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		if (bridge.lookup === "unavailable")
			throw new ProtocolError(ErrorCode.unavailable, "This node could not tell which machine is calling");
		if (!isMachine(bridge, mount.machine))
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		return {
			key: `operator:${mount.id}`,
			environmentId: mount.environmentId,
			actor: mount.actor,
			passSha256: mount.passSha256,
			write: mount.write,
			...(mount.quietMs === undefined ? {} : { quietMs: mount.quietMs }),
		};
	}

	/** A view the core opened (step 2: a run's box, opened by the execution host's service; step 4: a computer desktop
	 * or a shell command, by its company machine). The core checks the pass when the view is first listed and at every
	 * renewal (40 s); between them the service serves from memory, never past the lease the core confirmed. Here only the
	 * pass's shape, and that the calling machine may present a core view at all (a run box host, or a company machine).
	 * The view's kind and machine are the core's: the first renewal says them, and the service then admits only the
	 * machines `coreAccess` names (P7 adds the node). */
	#coreView(hello: Hello, bridge: BridgeInfo): Grant {
		if (!CORE_PASS.test(hello.pass))
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		if (bridge.lookup === "unavailable")
			throw new ProtocolError(ErrorCode.unavailable, "This node could not tell which machine is calling");
		const companyMachine =
			bridge.lookup === "found" &&
			bridge.machine !== undefined &&
			this.#companyMachineProjects.includes(bridge.machine.project) &&
			OFFICE.test(bridge.machine.name);
		if (!companyMachine && !this.#runBoxHosts.some((host) => isMachine(bridge, host)))
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		return {
			key: `view:${hello.viewId}`,
			environmentId: hello.environmentId,
			actor: { kind: "view", viewId: hello.viewId, pass: hello.pass },
			passSha256: createHash("sha256").update(hello.pass).digest(),
			lease: { viewId: hello.viewId, pass: hello.pass },
			write: false,
		};
	}
}
