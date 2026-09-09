import { isDeepStrictEqual } from "node:util";
import { LxdUnixClient } from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import { inspectLxdOfficePhysicalHost, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import {
	assertLxdOfficePhysicalBinding,
	assertLxdOfficePhysicalImage,
	type LxdOfficePhysicalPolicy,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";

// Process-wide, including configuration loading and replacement gate objects.
// Timing out an NFS syscall cannot clear its slot or prove it was cancelled.
let pending = false;
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, caller: AbortSignal): Promise<T> {
	const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
	signal.throwIfAborted();
	if (pending) throw new Error("LXD_OFFICE_PHYSICAL_INSPECTION_PENDING");
	pending = true;
	let rejectAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(new Error("LXD_OFFICE_PHYSICAL_INSPECTION_ABORTED"));
		signal.addEventListener("abort", rejectAbort, { once: true });
	});
	const work = Promise.resolve()
		.then(() => {
			signal.throwIfAborted();
			return operation(signal);
		})
		.finally(() => {
			pending = false;
		});
	try {
		return await Promise.race([work, aborted]);
	} finally {
		signal.removeEventListener("abort", rejectAbort);
	}
}

/** Physical preparation gate for one enrolled office policy. Loading it does
 * not enroll a provider, reserve capacity, mutate LXD/NAS, adopt state or
 * activate an office. Cloud preparation authority is independently required. */
export class LxdOfficePhysicalGate {
	readonly #policy: Readonly<LxdOfficePhysicalPolicy>;
	readonly #client: LxdUnixClient;
	private constructor(policy: Readonly<LxdOfficePhysicalPolicy>) {
		this.#policy = policy;
		this.#client = new LxdUnixClient(policy.host.socketPath);
	}

	static async open(policyPath: string, provenancePath: string, signal: AbortSignal): Promise<LxdOfficePhysicalGate> {
		return bounded(async (checked) => {
			const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
			const policy = parseLxdOfficePhysicalPolicy(decode(await readLxdOfficeProtectedFile(policyPath, 16384)));
			checked.throwIfAborted();
			const provenance = decode(await readLxdOfficeProtectedFile(provenancePath, 16384));
			checked.throwIfAborted();
			assertLxdOfficePhysicalImage(policy, provenance);
			return new LxdOfficePhysicalGate(policy);
		}, signal);
	}

	async check(
		value: LxdOfficeGuestBinding,
		signal: AbortSignal,
	): Promise<{ signal: AbortSignal; validForMs: number; hostBootId: string }> {
		const binding = parseLxdOfficeGuestBinding(value);
		assertLxdOfficePhysicalBinding(this.#policy, binding);
		return this.inspect(signal);
	}

	/** Immutable infrastructure configuration, never client/model input. */
	get policy(): Readonly<LxdOfficePhysicalPolicy> {
		return this.#policy;
	}

	/** Physical policy observation without allocating an office identity. */
	async inspect(signal: AbortSignal): Promise<{ signal: AbortSignal; validForMs: number; hostBootId: string }> {
		const started = performance.now();
		return bounded(async (checked) => {
			const p = this.#policy;
			const before = await inspectLxdOfficePhysicalHost(p, checked);
			checked.throwIfAborted();
			const server = await this.#client.inspectOfficeServer(p.guest.project, checked);
			checked.throwIfAborted();
			if (
				!isDeepStrictEqual(server, {
					project: p.guest.project,
					certificateSha256: p.host.certificateSha256,
					serverName: p.host.serverName,
					serverVersion: p.host.serverVersion,
					architecture: p.host.architecture,
				})
			)
				throw new Error("LXD_OFFICE_DAEMON_POLICY_MISMATCH");
			const image = await this.#client.inspectOfficeImage(p.guest.project, p.guest.imageFingerprint, checked);
			checked.throwIfAborted();
			if (
				!isDeepStrictEqual(image, {
					fingerprint: p.guest.imageFingerprint,
					architecture: p.host.architecture,
					size: p.image.bytes,
				})
			)
				throw new Error("LXD_OFFICE_LOCAL_IMAGE_MISMATCH");
			const infrastructure = await this.#client.inspectOfficeInfrastructure(
				p.guest.project,
				p.guest.network,
				p.guest.storagePool,
				checked,
			);
			checked.throwIfAborted();
			if (
				officeDigest(infrastructure.project) !== p.infrastructure.projectSha256 ||
				officeDigest(infrastructure.network) !== p.infrastructure.networkSha256 ||
				officeDigest(infrastructure.storagePool) !== p.infrastructure.storagePoolSha256
			)
				throw new Error("LXD_OFFICE_INFRASTRUCTURE_POLICY_MISMATCH");
			const after = await inspectLxdOfficePhysicalHost(p, checked);
			checked.throwIfAborted();
			if (!isDeepStrictEqual(before, after)) throw new Error("LXD_OFFICE_PHYSICAL_HOST_CHANGED");
			const validForMs = Math.floor(5000 - (performance.now() - started));
			if (validForMs < 1) throw new Error("LXD_OFFICE_PHYSICAL_INSPECTION_EXPIRED");
			return {
				signal: AbortSignal.any([signal, AbortSignal.timeout(validForMs)]),
				validForMs,
				hostBootId: after.bootId,
			};
		}, signal);
	}
}
