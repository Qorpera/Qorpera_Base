import { createHash, timingSafeEqual } from "node:crypto";
import { isUuid, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import type { FolderActor } from "./core.ts";
import { type MachineCheck, type MachineRef, parseMachineRef } from "./machines.ts";
import { ErrorCode, type Hello, ProtocolError } from "./protocol.ts";

/** A mount the operator set up on one machine (step 1: the proof company on the execution host, outside any box).
 * It reads as a member or as the platform. Its pass is in the machine's view file; this node keeps its sha256. */
export interface OperatorMount {
	readonly id: string;
	readonly environmentId: string;
	readonly actor: Extract<FolderActor, { kind: "member" } | { kind: "platform" }>;
	readonly machine: MachineRef;
	readonly passSha256: Buffer;
}

/** What a machine's hello was granted. Connections with the same key share one view's tree. */
export interface Grant {
	readonly key: string;
	readonly environmentId: string;
	readonly actor: FolderActor;
}

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
	readonly #machines: MachineCheck;

	constructor(mounts: readonly OperatorMount[], machines: MachineCheck) {
		this.#mounts = new Map(mounts.map((m) => [m.id, m]));
		this.#machines = machines;
	}

	get environments(): string[] {
		return [...new Set([...this.#mounts.values()].map((m) => m.environmentId))];
	}

	async admit(hello: Hello, cid: number): Promise<Grant> {
		const mount = this.#mounts.get(hello.viewId);
		const pass = createHash("sha256").update(hello.pass).digest();
		const passOk = mount !== undefined && timingSafeEqual(pass, mount.passSha256);
		if (
			!mount ||
			!passOk ||
			mount.environmentId !== hello.environmentId ||
			!(await this.#machines.matches(cid, mount.machine))
		)
			throw new ProtocolError(ErrorCode.viewRefused, "The view, its pass or this machine did not match");
		return { key: `operator:${mount.id}`, environmentId: mount.environmentId, actor: mount.actor };
	}
}
