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
}

/** What a machine's hello was granted. Connections with the same key share one view's tree, and must present the same
 * pass (`passSha256`). A core view (`lease`) is the core's: this service keeps its lease while machines are connected. */
export interface Grant {
	readonly key: string;
	readonly environmentId: string;
	readonly actor: FolderActor;
	readonly passSha256: Buffer;
	readonly lease?: { readonly viewId: string; readonly pass: string };
}

/** The core's view passes: 32 random bytes, base64url without padding (C1b-3a `qorpera_folder_view_new_pass`). */
const CORE_PASS = /^[A-Za-z0-9_-]{43}$/;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The `mounts` list of the service's configuration. */
export function parseOperatorMounts(value: unknown): OperatorMount[] {
	if (!Array.isArray(value)) throw new Error("mounts must be a list");
	const seen = new Set<string>();
	return value.map((item) => {
		const m = item as Record<string, unknown>;
		if (!m || typeof m !== "object") throw new Error("A mount must be an object");
		const keys = ["id", "environmentId", "actor", "machine", "passSha256"];
		if (Object.keys(m).length !== keys.length || keys.some((k) => !(k in m)))
			throw new Error("A mount is {id, environmentId, actor, machine, passSha256}");
		if (typeof m.id !== "string" || !ID.test(m.id) || seen.has(m.id))
			throw new Error("Mount ids must be unique slugs");
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
		};
	});
}

/** Decides whether a machine's hello opens a view. Every refusal looks the same to the machine. */
export class MountGrants {
	readonly #mounts: Map<string, OperatorMount>;
	readonly #runBoxHosts: readonly MachineRef[];

	/** `runBoxHosts`: the machines on this node that may present the core's run box views (the execution host). */
	constructor(mounts: readonly OperatorMount[], runBoxHosts: readonly MachineRef[] = []) {
		this.#mounts = new Map(mounts.map((m) => [m.id, m]));
		this.#runBoxHosts = runBoxHosts;
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
		};
	}

	/** A view the core opened (step 2: a run's box, opened by the execution host's service). The core checks its pass
	 * on every list, read and feed; here only its shape, and that the calling machine may present one at all. Which
	 * run box views a host may hold is the core's (P7 adds the node). */
	#coreView(hello: Hello, bridge: BridgeInfo): Grant {
		if (!CORE_PASS.test(hello.pass))
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		if (bridge.lookup === "unavailable")
			throw new ProtocolError(ErrorCode.unavailable, "This node could not tell which machine is calling");
		if (!this.#runBoxHosts.some((host) => isMachine(bridge, host)))
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		return {
			key: `view:${hello.viewId}`,
			environmentId: hello.environmentId,
			actor: { kind: "view", viewId: hello.viewId, pass: hello.pass },
			passSha256: createHash("sha256").update(hello.pass).digest(),
			lease: { viewId: hello.viewId, pass: hello.pass },
		};
	}
}
