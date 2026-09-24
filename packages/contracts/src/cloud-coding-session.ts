/** Where one coding session lives inside its member's coding machine. A
 * member's machine carries any number of that member's sessions at once; each
 * has its own NAS folders (attached at its data and custody roots), its own
 * guest configuration, lease, user, slice and command units. Every path and
 * name derives from the worker id alone: no packet, request or model input
 * selects one. */
export interface CloudCodingSessionLayout {
	readonly workerId: string;
	/** Root-owned guest configuration (guest.json, storage.json, the install
	 * inbox). Boot-local like the lease: a machine that slept wakes with no
	 * session attached, and each turn installs its session again. */
	readonly configurationRoot: string;
	/** The session's NAS data volume. */
	readonly dataRoot: string;
	/** The session's NAS custody volume (commands, logs, Git transfers). */
	readonly custodyRoot: string;
	/** Boot-local session state (configuration and lease); never on the NAS. */
	readonly runtimeRoot: string;
	readonly workspacePath: string;
	readonly homePath: string;
	readonly cachePath: string;
	readonly outputRoot: string;
	/** The session's command slice, a child of qorpera-coding.slice. */
	readonly slice: string;
	/** Every command unit of the session starts with this prefix. */
	readonly unitPrefix: string;
}

export const CLOUD_CODING_GUEST_ROOTS = /* @__PURE__ */ Object.freeze({
	data: "/workspace",
	custody: "/var/lib/qorpera-coding",
	runtime: "/run/qorpera-coding",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function cloudCodingSessionLayout(workerId: string): Readonly<CloudCodingSessionLayout> {
	if (typeof workerId !== "string" || !UUID.test(workerId)) throw new Error("INVALID_CODING_SESSION");
	const dataRoot = `${CLOUD_CODING_GUEST_ROOTS.data}/${workerId}`,
		custodyRoot = `${CLOUD_CODING_GUEST_ROOTS.custody}/${workerId}`,
		compact = workerId.replaceAll("-", "");
	return Object.freeze({
		workerId,
		configurationRoot: `${CLOUD_CODING_GUEST_ROOTS.runtime}/${workerId}/configuration`,
		dataRoot,
		custodyRoot,
		runtimeRoot: `${CLOUD_CODING_GUEST_ROOTS.runtime}/${workerId}`,
		workspacePath: `${dataRoot}/repository`,
		homePath: `${dataRoot}/home`,
		cachePath: `${dataRoot}/cache`,
		outputRoot: `${custodyRoot}/logs`,
		slice: `qorpera-coding-${compact}.slice`,
		unitPrefix: `qorpera-coding-${compact}-`,
	});
}
