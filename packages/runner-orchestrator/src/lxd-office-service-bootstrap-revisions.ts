import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import {
	type LxdOfficeServiceBootstrap,
	OFFICE_SERVICE_CREDENTIALS,
	parseLxdOfficeServiceBootstrap,
} from "./lxd-office-service-bootstrap.ts";

export const OFFICE_SERVICE_BOOTSTRAP_REVISIONS_FILE = "service-bootstrap-revisions.json";
export const OFFICE_SERVICE_BOOTSTRAP_REVISIONS_MAX_BYTES = 65536;
const MAX_REVISIONS = 32;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

export interface LxdOfficeServiceBootstrapRevision {
	readonly revision: number;
	readonly previousSha256: string;
	readonly nextSha256: string;
	/** Exact bytes of the plan this revision replaced; the credentials it names stay retained. */
	readonly previousPlan: string;
	readonly changed: readonly (typeof OFFICE_SERVICE_CREDENTIALS)[number][];
	readonly reason: string;
	readonly at: string;
}
export interface LxdOfficeServiceBootstrapRevisions {
	readonly schema: "qorpera.lxd-office-service-bootstrap-revisions/v1";
	readonly allocationId: string;
	readonly revisions: readonly LxdOfficeServiceBootstrapRevision[];
}

/** Root-owned chain document beside the service bootstrap. A later boot may
 * only take a plan whose digest differs from its predecessor boot's when one
 * contiguous chain of recorded credential revisions leads from that digest to
 * the current one; nothing but the named credentials may differ per step. */
export function parseLxdOfficeServiceBootstrapRevisions(
	value: unknown,
	allocationId: string,
): LxdOfficeServiceBootstrapRevisions {
	try {
		const input = officeRecord(value, ["schema", "allocationId", "revisions"]);
		if (
			input.schema !== "qorpera.lxd-office-service-bootstrap-revisions/v1" ||
			input.allocationId !== allocationId ||
			!Array.isArray(input.revisions) ||
			input.revisions.length < 1 ||
			input.revisions.length > MAX_REVISIONS
		)
			throw new Error("document");
		const revisions = input.revisions.map((entry, index): LxdOfficeServiceBootstrapRevision => {
			const r = officeRecord(entry, [
				"revision",
				"previousSha256",
				"nextSha256",
				"previousPlan",
				"changed",
				"reason",
				"at",
			]);
			if (
				r.revision !== index + 1 ||
				typeof r.previousPlan !== "string" ||
				r.previousPlan.length < 2 ||
				Buffer.byteLength(r.previousPlan) > 16384 ||
				hash(r.previousPlan) !== officeSha(r.previousSha256) ||
				officeSha(r.nextSha256) === r.previousSha256 ||
				!Array.isArray(r.changed) ||
				r.changed.length < 1 ||
				new Set(r.changed).size !== r.changed.length ||
				!r.changed.every((name) => (OFFICE_SERVICE_CREDENTIALS as readonly unknown[]).includes(name)) ||
				typeof r.reason !== "string" ||
				r.reason.length < 1 ||
				r.reason.length > 512 ||
				typeof r.at !== "string" ||
				Number.isNaN(Date.parse(r.at))
			)
				throw new Error("revision");
			return Object.freeze({
				revision: r.revision,
				previousSha256: r.previousSha256 as string,
				nextSha256: r.nextSha256 as string,
				previousPlan: r.previousPlan,
				changed: Object.freeze([...(r.changed as LxdOfficeServiceBootstrapRevision["changed"])]),
				reason: r.reason,
				at: r.at,
			});
		});
		for (let index = 1; index < revisions.length; index++)
			if (revisions[index]!.previousSha256 !== revisions[index - 1]!.nextSha256) throw new Error("chain");
		return Object.freeze({
			schema: "qorpera.lxd-office-service-bootstrap-revisions/v1",
			allocationId,
			revisions: Object.freeze(revisions),
		});
	} catch {
		throw new Error("INVALID_OFFICE_SERVICE_BOOTSTRAP_REVISIONS");
	}
}

function withoutCredentials(
	plan: LxdOfficeServiceBootstrap,
	changed: LxdOfficeServiceBootstrapRevision["changed"],
): unknown {
	const credentials: Record<string, unknown> = { ...plan.credentials };
	for (const name of changed) delete credentials[name];
	return { ...plan, credentials };
}

/** Confirms the current plan against the digest the predecessor boot recorded.
 * Returns the number of revisions applied since that boot (0 when unchanged).
 * Anything else — a missing or malformed chain, a step that changes more than
 * its named credentials, a chain that ends elsewhere — is refused. */
export async function assertLxdOfficeServiceBootstrapContinuity(
	input: {
		planBytes: Buffer;
		planPath: string;
		predecessorSha256: string;
		binding: LxdOfficeGuestBinding;
	},
	readProtected: typeof readLxdOfficeProtectedFile,
	signal: AbortSignal,
): Promise<number> {
	const current = hash(input.planBytes);
	if (current === officeSha(input.predecessorSha256)) return 0;
	signal.throwIfAborted();
	const separator = input.planPath.lastIndexOf("/");
	if (separator < 1) throw new Error("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
	let chain: LxdOfficeServiceBootstrapRevisions;
	try {
		chain = parseLxdOfficeServiceBootstrapRevisions(
			decode(
				await readProtected(
					`${input.planPath.slice(0, separator)}/${OFFICE_SERVICE_BOOTSTRAP_REVISIONS_FILE}`,
					OFFICE_SERVICE_BOOTSTRAP_REVISIONS_MAX_BYTES,
				),
			),
			input.binding.allocationId,
		);
	} catch {
		throw new Error("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
	}
	signal.throwIfAborted();
	const start = chain.revisions.findIndex((revision) => revision.previousSha256 === input.predecessorSha256);
	const last = chain.revisions.at(-1);
	if (start < 0 || !last || last.nextSha256 !== current)
		throw new Error("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
	try {
		const plan = (text: string) => parseLxdOfficeServiceBootstrap(JSON.parse(text), input.binding);
		const steps = chain.revisions.slice(start);
		for (const [index, step] of steps.entries()) {
			const next = steps[index + 1];
			const after = plan(next ? next.previousPlan : input.planBytes.toString("utf8"));
			const before = plan(step.previousPlan);
			if (!isDeepStrictEqual(withoutCredentials(before, step.changed), withoutCredentials(after, step.changed)))
				throw new Error("step");
			for (const name of step.changed)
				if (isDeepStrictEqual(before.credentials[name], after.credentials[name])) throw new Error("unchanged");
		}
		return steps.length;
	} catch {
		throw new Error("OFFICE_SERVICE_BOOTSTRAP_CONTINUITY_UNCONFIRMED");
	}
}
