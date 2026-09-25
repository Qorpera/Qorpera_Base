#!/usr/bin/env node
// The deployment manifest: one record of what is live now, per component, with the acceptance
// evidence that was run against that exact identity. See README.md in this folder.
//
//   manifest.mjs apply  --dir <manifest dir> --changes <changes.json> [--root <workspace>] [--now <iso>]
//   manifest.mjs lane   --lane <cut lane dir> --root <workspace> [--cut <label>]   (prints a changes file)
//   manifest.mjs check  --manifest <file> [--root <workspace>]
//   manifest.mjs render --manifest <file>                                          (prints CURRENT.md)
//   manifest.mjs drift  --manifest <file> --observed <observed.json>
//   manifest.mjs web    --commit <sha> --check-runs <file> --compare <file> [--allow-behind yes]
//                                                              (prints changes for the web client's Pages deploy)
//
// Nothing here talks to a node or a database. `apply` only writes inside --dir.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = "qorpera.deployment-manifest/v1";
export const CHANGES_SCHEMA = "qorpera.deployment-manifest-changes/v1";
export const OBSERVED_SCHEMA = "qorpera.deployment-observed-state/v1";
export const STATES = ["accepted", "not-accepted-at-this-identity", "identity-unknown"];

// Display order. Ids outside this list sort after it, alphabetically.
export const COMPONENT_ORDER = [
	"database-migrations",
	"runtime-bundle",
	"runner-image",
	"codex-fence",
	"guest-provider-host",
	"node-01-release",
	"node-02-release",
	"node-01-login",
	"node-02-login",
	"node-agent",
	"node-01-observer",
	"node-02-observer",
	"exec-host",
	"office-service",
	"office-image",
	"office-service-test",
	"office-image-test",
	"coding-image",
	"coding-executor",
	"coding-vm-policy",
	"secret-broker-qorpera",
	"secret-broker-acceptance",
	"capture-proxy",
	"object-gateway",
	"web-client",
];

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------------------------------------------
// Canonical form and digests
// ---------------------------------------------------------------------------------------------------------------

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The digest acceptance evidence is bound to: sha256 of the canonical identity. */
export const identityDigest = (identity) => sha256(canonicalJson(identity));

/** Paths (a.b.c) of identity fields whose value is null: facts no record confirms. */
export function unknownFields(identity, prefix = "") {
	const out = [];
	for (const [key, value] of Object.entries(identity)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value === null) out.push(path);
		else if (typeof value === "object" && !Array.isArray(value)) out.push(...unknownFields(value, path));
	}
	return out;
}

/** accepted: some evidence was run against this exact identity. identity-unknown: a live fact is not recorded, so
 * no evidence can be tied to it. Otherwise not-accepted-at-this-identity (never accepted, or changed since). */
export function acceptanceState(component) {
	if (unknownFields(component.identity).length > 0) return "identity-unknown";
	const digest = identityDigest(component.identity);
	return component.acceptance.evidence.some((item) => item.identityDigest === digest)
		? "accepted"
		: "not-accepted-at-this-identity";
}

// ---------------------------------------------------------------------------------------------------------------
// Records: every fact points at where it is written down
// ---------------------------------------------------------------------------------------------------------------
// { path, sha256 }        a receipt file, pinned by content (path relative to the workspace root)
// { path, line, quote }   a line of an append-only log (the bundle registry); quote must appear on that line
// { url }                 an external record (a PR, a check run)

function resolveRecord(record, root) {
	if (record.url !== undefined) {
		if (!/^https:\/\/\S+$/.test(record.url)) throw new Error(`record url must be https: ${record.url}`);
		return { url: record.url };
	}
	if (typeof record.path !== "string" || record.path.length === 0) throw new Error("record needs path or url");
	if (isAbsolute(record.path) || record.path.split("/").includes(".."))
		throw new Error(`record path must be relative to the workspace root: ${record.path}`);
	if (!root) throw new Error(`--root is needed to resolve record ${record.path}`);
	const file = join(root, record.path);
	if (!existsSync(file)) throw new Error(`record file missing: ${record.path}`);
	if (record.line !== undefined) {
		if (!Number.isInteger(record.line) || record.line < 1)
			throw new Error(`record line must be >= 1: ${record.path}`);
		if (typeof record.quote !== "string" || record.quote.length < 8)
			throw new Error(`a line record needs a quote of 8+ characters: ${record.path}:${record.line}`);
		const text = readFileSync(file, "utf8").split("\n")[record.line - 1] ?? "";
		if (!text.includes(record.quote))
			throw new Error(`quote not on ${record.path}:${record.line}: ${JSON.stringify(record.quote)}`);
		return { path: record.path, line: record.line, quote: record.quote };
	}
	const digest = sha256(readFileSync(file));
	if (record.sha256 !== undefined && record.sha256 !== digest)
		throw new Error(`record ${record.path} changed: expected ${record.sha256}, found ${digest}`);
	return { path: record.path, sha256: digest };
}

function verifyRecord(record, root, where, problems) {
	try {
		const resolved = resolveRecord(record, root);
		if (resolved.sha256 && record.sha256 !== resolved.sha256)
			problems.push(`${where}: record ${record.path} changed`);
	} catch (error) {
		problems.push(`${where}: ${error.message}`);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Applying changes
// ---------------------------------------------------------------------------------------------------------------

const orderIndex = (id) => {
	const index = COMPONENT_ORDER.indexOf(id);
	return index === -1 ? COMPONENT_ORDER.length : index;
};
const byOrder = (a, b) => orderIndex(a.id) - orderIndex(b.id) || a.id.localeCompare(b.id);

/** Applies a changes document to a manifest (or to nothing, for the first one). Pure apart from record reads.
 * set:    a component's live identity. A new identity keeps its old evidence only as `superseded`.
 * accept: evidence run against the CURRENT identity of each named component.
 * retire: a component that is no longer live. */
export function applyChanges(previous, changes, { root, now, previousSha256 }) {
	if (changes?.schema !== CHANGES_SCHEMA) throw new Error(`changes schema must be ${CHANGES_SCHEMA}`);
	if (typeof changes.reason !== "string" || changes.reason.trim() === "") throw new Error("changes need a reason");
	if (!Array.isArray(changes.operations) || changes.operations.length === 0)
		throw new Error("changes need operations");
	const components = new Map((previous?.components ?? []).map((c) => [c.id, structuredClone(c)]));
	const retired = structuredClone(previous?.retired ?? []);
	for (const [index, op] of changes.operations.entries()) {
		const where = `operation ${index + 1} (${op.op} ${op.id ?? (op.ids ?? []).join(",")})`;
		try {
			if (op.op === "set") setComponent(components, op, root);
			else if (op.op === "accept") acceptComponents(components, op, root);
			else if (op.op === "retire") {
				const component = components.get(op.id);
				if (!component) throw new Error("unknown component");
				if (!op.at || !ISO.test(op.at)) throw new Error("retire needs at");
				components.delete(op.id);
				retired.push({ id: op.id, at: op.at, reason: String(op.reason ?? ""), identity: component.identity });
			} else throw new Error("op must be set, accept or retire");
		} catch (error) {
			throw new Error(`${where}: ${error.message}`);
		}
	}
	const list = [...components.values()].sort(byOrder);
	for (const component of list) {
		component.identityDigest = identityDigest(component.identity);
		component.acceptance.state = acceptanceState(component);
	}
	const manifest = {
		schema: MANIFEST_SCHEMA,
		sequence: (previous?.sequence ?? 0) + 1,
		previous: previous ? { sequence: previous.sequence, sha256: previousSha256 } : null,
		writtenAt: now,
		writtenBy: String(changes.writtenBy ?? ""),
		reason: changes.reason,
		components: list,
		retired,
	};
	const problems = checkManifest(manifest);
	if (problems.length > 0) throw new Error(`result does not check:\n  ${problems.join("\n  ")}`);
	return manifest;
}

function setComponent(components, op, root) {
	if (!ID.test(op.id ?? "")) throw new Error("id must be lower-case words joined by -");
	if (!op.identity || typeof op.identity !== "object" || Array.isArray(op.identity))
		throw new Error("identity must be an object");
	const old = components.get(op.id);
	const title = op.title ?? old?.title;
	const scope = op.scope ?? old?.scope;
	if (!title || !scope) throw new Error("a new component needs title and scope");
	const live = op.live ?? {};
	const changed = !old || identityDigest(old.identity) !== identityDigest(op.identity);
	const records = (live.records ?? []).map((record) => resolveRecord(record, root));
	const evidence = old?.acceptance.evidence ?? [];
	const superseded = old?.acceptance.superseded ?? [];
	if (changed && evidence.length > 0) {
		const last = evidence[evidence.length - 1];
		superseded.push({ identityDigest: identityDigest(old.identity), lastAcceptedAt: last.at, summary: last.summary });
	}
	// The same identity went live earlier: keep when and in which cut, and only add the new records. A cut lane
	// re-reports everything it carries (e.g. an unchanged Codex binary), which must not move its live date.
	// `replaceLive` corrects a wrongly recorded date or cut on purpose.
	const keep = !changed && !op.replaceLive;
	const known = new Set((keep ? old.live.records : []).map(canonicalJson));
	components.set(op.id, {
		id: op.id,
		title,
		scope,
		identity: op.identity,
		identityDigest: "",
		live: {
			since: (keep ? old.live.since : null) ?? live.since ?? null,
			cut: (keep ? old.live.cut : null) ?? live.cut ?? null,
			records: [...(keep ? old.live.records : []), ...records.filter((record) => !known.has(canonicalJson(record)))],
		},
		acceptance: { state: "", evidence: changed ? [] : evidence, superseded },
		notes: op.notes ?? (changed ? "" : (old?.notes ?? "")),
	});
}

function acceptComponents(components, op, root) {
	if (!Array.isArray(op.ids) || op.ids.length === 0) throw new Error("accept needs ids");
	if (!op.at || !ISO.test(op.at)) throw new Error("accept needs at (ISO time of the acceptance run)");
	if (typeof op.summary !== "string" || op.summary.trim() === "") throw new Error("accept needs a summary");
	if (!Array.isArray(op.records) || op.records.length === 0) throw new Error("accept needs at least one record");
	const records = op.records.map((record) => resolveRecord(record, root));
	for (const id of op.ids) {
		const component = components.get(id);
		if (!component) throw new Error(`unknown component ${id}`);
		const unknown = unknownFields(component.identity);
		if (unknown.length > 0) throw new Error(`${id}: identity not fully recorded (${unknown.join(", ")})`);
		if (op.expectIdentityDigest?.[id] && op.expectIdentityDigest[id] !== identityDigest(component.identity))
			throw new Error(`${id}: identity changed since the evidence was prepared`);
		if (component.live.since && Date.parse(op.at) < Date.parse(component.live.since))
			throw new Error(`${id}: evidence at ${op.at} predates the live identity (live since ${component.live.since})`);
		component.acceptance.evidence.push({
			at: op.at,
			summary: op.summary,
			identityDigest: identityDigest(component.identity),
			records,
		});
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------------------------------

/** Structural and consistency problems (empty when the manifest is sound). With root, also re-reads every record. */
export function checkManifest(manifest, { root } = {}) {
	const problems = [];
	const need = (condition, message) => {
		if (!condition) problems.push(message);
	};
	need(manifest?.schema === MANIFEST_SCHEMA, `schema must be ${MANIFEST_SCHEMA}`);
	need(Number.isInteger(manifest?.sequence) && manifest.sequence >= 1, "sequence must be a positive integer");
	need(ISO.test(manifest?.writtenAt ?? ""), "writtenAt must be an ISO time");
	need(typeof manifest?.reason === "string" && manifest.reason !== "", "reason is required");
	if (manifest?.sequence > 1)
		need(
			manifest.previous?.sequence === manifest.sequence - 1 && SHA256.test(manifest.previous?.sha256 ?? ""),
			"previous must name the prior sequence and its sha256",
		);
	const seen = new Set();
	for (const component of manifest?.components ?? []) {
		const where = component?.id ?? "(no id)";
		need(ID.test(component?.id ?? ""), `${where}: bad id`);
		need(!seen.has(component?.id), `${where}: duplicate id`);
		seen.add(component?.id);
		need(typeof component?.title === "string" && component.title !== "", `${where}: title required`);
		need(typeof component?.scope === "string" && component.scope !== "", `${where}: scope required`);
		if (!component?.identity || typeof component.identity !== "object") {
			problems.push(`${where}: identity must be an object`);
			continue;
		}
		need(component.identityDigest === identityDigest(component.identity), `${where}: identityDigest is stale`);
		need(component.live?.since === null || ISO.test(component.live?.since ?? ""), `${where}: live.since`);
		need(Array.isArray(component.live?.records), `${where}: live.records must be a list`);
		need(Array.isArray(component.acceptance?.evidence), `${where}: acceptance.evidence must be a list`);
		if (!Array.isArray(component.acceptance?.evidence)) continue;
		need(STATES.includes(component.acceptance.state), `${where}: unknown acceptance state`);
		need(component.acceptance.state === acceptanceState(component), `${where}: acceptance state does not follow`);
		for (const item of component.acceptance.evidence) {
			need(item.identityDigest === component.identityDigest, `${where}: evidence for another identity`);
			need(ISO.test(item.at ?? ""), `${where}: evidence needs at`);
			need(
				!component.live.since || Date.parse(item.at) >= Date.parse(component.live.since),
				`${where}: evidence at ${item.at} predates live since ${component.live.since}`,
			);
			need(Array.isArray(item.records) && item.records.length > 0, `${where}: evidence needs records`);
		}
		if (root) {
			for (const record of component.live?.records ?? []) verifyRecord(record, root, where, problems);
			for (const item of component.acceptance.evidence)
				for (const record of item.records ?? []) verifyRecord(record, root, where, problems);
		}
	}
	return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

const short = (value) => (typeof value === "string" && SHA256.test(value) ? `${value.slice(0, 12)}…` : value);

function identityText(identity, prefix = "") {
	const parts = [];
	for (const [key, value] of Object.entries(identity)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) parts.push(identityText(value, path));
		else if (value === null) parts.push(`${path} **not recorded**`);
		else if (Array.isArray(value))
			parts.push(
				`${path} ${value.map((item) => (typeof item === "object" ? canonicalJson(item) : short(item))).join(", ")}`,
			);
		else parts.push(`${path} ${short(value)}`);
	}
	return parts.join("; ");
}

const STATE_TEXT = {
	accepted: "accepted",
	"not-accepted-at-this-identity": "**not accepted at this identity**",
	"identity-unknown": "**identity not recorded**",
};

/** A readable page of the manifest (CURRENT.md). */
export function renderMarkdown(manifest) {
	const lines = [
		`# What is live now (deployment manifest #${manifest.sequence})`,
		"",
		`Written ${manifest.writtenAt} by ${manifest.writtenBy || "unknown"}: ${manifest.reason}`,
		"",
		"Generated from current.json by deploy/deployment-manifest/manifest.mjs render — do not edit by hand.",
		"",
	];
	const open = manifest.components.filter((c) => c.acceptance.state !== "accepted");
	lines.push("## Live without proof at the live version", "");
	if (open.length === 0) lines.push("None.", "");
	for (const component of open) {
		const last = component.acceptance.superseded.at(-1);
		const why =
			component.acceptance.state === "identity-unknown"
				? `not recorded: ${unknownFields(component.identity).join(", ")}`
				: last
					? `last accepted ${last.lastAcceptedAt} at an earlier identity`
					: "never accepted";
		lines.push(`- **${component.id}** (${component.title}): ${why}`);
	}
	lines.push(
		"",
		"## Components",
		"",
		"| Component | Identity | Live since / cut | Acceptance at this identity |",
		"|---|---|---|---|",
	);
	for (const component of manifest.components) {
		const last = component.acceptance.evidence.at(-1);
		const acceptance =
			component.acceptance.state === "accepted"
				? `accepted ${last.at}: ${last.summary}`
				: STATE_TEXT[component.acceptance.state];
		const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
		lines.push(
			`| **${component.id}**<br>${cell(component.title)} (${cell(component.scope)}) | ${cell(identityText(component.identity))} | ${component.live.since ?? "not recorded"}<br>${cell(component.live.cut ?? "")} | ${cell(acceptance)} |`,
		);
	}
	const notes = manifest.components.filter((c) => c.notes);
	if (notes.length > 0) {
		lines.push("", "## Notes", "");
		for (const component of notes) lines.push(`- **${component.id}**: ${component.notes}`);
	}
	if (manifest.retired.length > 0) {
		lines.push("", "## Retired", "");
		for (const item of manifest.retired) lines.push(`- ${item.id} (${item.at}): ${item.reason}`);
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Drift: the manifest against what the backend reports about itself (observed-state.sql)
// ---------------------------------------------------------------------------------------------------------------

/** Per component and field: match, DRIFT, or an observation that is neither (no use since live, not observable,
 * a note). Enrollment is checked twice: the policy must be enrolled, and the newest machine of that provider requested
 * since the component went live must have used it (re-enrolling an older policy keeps its old row, so "newest
 * enrolled" is not the policy in use after a rollback). */
export function drift(manifest, observed) {
	if (observed?.schema !== OBSERVED_SCHEMA) throw new Error(`observed schema must be ${OBSERVED_SCHEMA}`);
	const results = [];
	const compare = (id, field, expected, actual) =>
		results.push({ id, field, expected, actual, result: expected === actual ? "match" : "DRIFT" });
	const note = (id, field, result) => results.push({ id, field, expected: "-", actual: "-", result });
	const enrolled = (id, since, kind, providerId, sha) => {
		const rows = observed.enrolledProviders.filter((p) => p.kind === kind && p.providerId === providerId);
		compare(id, `${kind} policy enrolled`, sha, rows.find((p) => p.policySha256 === sha)?.policySha256);
		const use = observed.providerUse.find((p) => p.kind === kind && p.providerId === providerId);
		if (use && since && Date.parse(use.requestedAt) >= Date.parse(since))
			compare(id, `${kind} policy of the newest machine (${use.requestedAt})`, sha, use.policySha256);
		else note(id, `${kind} policy in use`, "no machine requested since live");
	};
	for (const component of manifest.components) {
		const identity = component.identity;
		const id = component.id;
		const since = component.live.since;
		const before = results.length;
		if (id === "runtime-bundle") {
			compare(id, "version", identity.version, observed.activeBundle?.version);
			compare(id, "sha256", identity.sha256, observed.activeBundle?.sha256);
			for (const run of observed.runsSinceActivation ?? []) {
				if (run.runtimeBundleSha256 === identity.sha256)
					compare(id, `${run.runs} runs since activation carry it`, identity.sha256, run.runtimeBundleSha256);
				// A run takes the bundle its inputs were recorded under: inputs sent before the activation (e.g. during
				// a cut's pause) run on the older bundle by design.
				else
					note(
						id,
						`${run.runs} runs since activation carry ${run.runtimeBundleSha256}`,
						"note: inputs from before the activation?",
					);
			}
		} else if (id === "database-migrations") {
			compare(id, "lastVersion", identity.lastVersion, observed.lastMigration?.version);
			compare(id, "lastName", identity.lastName, observed.lastMigration?.name);
		} else if (id === "exec-host" && identity.inventoryPolicySha256) {
			const policy = observed.inventoryPolicies.find((p) => p.nodeId === identity.nodeId);
			compare(id, "inventory policy", identity.inventoryPolicySha256, policy?.policySha256);
		} else if (id === "coding-vm-policy") {
			const row = observed.codingVmPolicies.find((p) => p.environmentId === identity.environmentId);
			compare(id, "vmPolicy", canonicalJson(identity.vmPolicy), row ? canonicalJson(row.vmPolicy) : undefined);
			const { providerId, providerPolicySha256 } = identity.vmPolicy;
			enrolled(id, since, "coding", providerId, providerPolicySha256);
		} else if (id === "coding-image") {
			for (const row of observed.codingVmPolicies) {
				compare(
					id,
					`image in ${row.environmentId.slice(0, 8)} vmPolicy`,
					identity.fingerprint,
					row.vmPolicy?.imageFingerprint,
				);
				compare(
					id,
					`bootstrap in ${row.environmentId.slice(0, 8)} vmPolicy`,
					identity.bootstrapSha256,
					row.vmPolicy?.bootstrapSha256,
				);
			}
		} else if (id.startsWith("office-image") && identity.officeId) {
			const row = observed.officeActivations.find((a) => a.officeId === identity.officeId);
			compare(id, "image", identity.imageSha256, row?.imageSha256);
			compare(id, "bootstrap", identity.bootstrapSha256, row?.bootstrapSha256);
			compare(id, "generation", identity.generation, row?.generation);
			if (identity.softwareRevision !== undefined)
				compare(id, "software revision", identity.softwareRevision, row?.softwareRevision);
		} else if (id.startsWith("secret-broker-") && identity.authority) {
			const row = observed.secretBrokerAuthorities.find((a) => a.profileId === identity.authority.profileId);
			compare(id, "authority key", identity.authority.keyId, row?.keyId);
			compare(id, "authority origin", identity.authority.serviceOrigin, row?.serviceOrigin);
		}
		// Any component that says what it enrolled: node releases (native), sign-in machines (login), office providers.
		for (const [kind, sha] of Object.entries(identity.enrollment?.policies ?? {}))
			enrolled(id, since, kind, identity.enrollment.providerId, sha);
		if (results.length === before) note(id, "-", "not observable from the backend");
	}
	return results;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a cut lane: the structured receipts every cut lane writes
// ---------------------------------------------------------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rel = (root, file) => relative(root, file).split("\\").join("/");
const newest = (dir, pattern) => {
	if (!existsSync(dir)) return null;
	// Numbers compare as numbers: release-11 is newer than release-9.
	const names = readdirSync(dir)
		.filter((name) => pattern.test(name))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	return names.length > 0 ? join(dir, names[names.length - 1]) : null;
};

/** Changes (set operations) for the parts a cut lane records in structured receipts: SQL, runtime bundle,
 * runner image with its Codex binary and guest provider host, node releases with their enrollment, exec host.
 * Parts the lane does not contain are left out, so the previous manifest's entries carry over. Coding, office,
 * brokers, gateway and web client are set with explicit operations (README). */
export function laneChanges(laneDir, root, cut) {
	const lane = resolve(laneDir);
	const operations = [];
	const record = (file) => ({ path: rel(root, file) });

	const activate = newest(join(lane, "sql/receipts"), /^activate-commit-\d+-result\.json$/);
	const packetFile = join(lane, "sql/generated/packet.json");
	if (activate) {
		const result = readJson(activate);
		if (!result.ok) throw new Error(`${activate}: activation did not commit`);
		const activation = result.result?.[0]?.activation;
		const packet = readJson(packetFile);
		const applied = readdirSync(join(lane, "sql/receipts"))
			.filter((name) => /^apply-\d{14}-commit-\d+-result\.json$/.test(name))
			.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
			.map((name) => join(lane, "sql/receipts", name));
		operations.push({
			op: "set",
			id: "runtime-bundle",
			title: "Runtime bundle (the runtime the backend accepts)",
			scope: "global",
			identity: {
				version: activation.version,
				sha256: activation.sha256,
				activationMigration: `${packet.activation[0]}_${packet.activation[1]}`,
			},
			live: { since: activation.activated_at, cut, records: [record(activate), record(packetFile)] },
		});
		operations.push({
			op: "set",
			id: "database-migrations",
			title: "Database migrations (last recorded in schema_migrations)",
			scope: "global",
			identity: {
				lastVersion: packet.activation[0],
				lastName: packet.activation[1],
				appliedThisCut: packet.migrations.map(([version, name]) => `${version}_${name}`),
			},
			live: { since: activation.activated_at, cut, records: [...applied.map(record), record(activate)] },
			notes: "The activation file is the last migration a cut records.",
		});
	}

	// The runner image, its Codex binary and its guest provider host went live when the first node switched to it.
	const applyTimes = ["01", "02"]
		.map((node) => join(lane, `agent/receipts/node${node}-apply.json`))
		.filter((file) => existsSync(file))
		.map((file) => readJson(file).at)
		.sort();
	const imageSince = applyTimes[0] ?? null;

	const provenanceFile = newest(join(lane, "image/signing"), /^image-provenance-.*\.json$/);
	const evidenceFile = join(lane, "image/signing/acceptance-evidence.json");
	if (provenanceFile) {
		const statement = readJson(provenanceFile).statement;
		const evidence = existsSync(evidenceFile) ? readJson(evidenceFile) : null;
		operations.push({
			op: "set",
			id: "runner-image",
			title: "Runner image (the agent machine image)",
			scope: "node-01, node-02, exec-host",
			identity: {
				fingerprint: statement.image.fingerprint,
				sourceCommit: statement.source.commit,
				guestPackageManifestSha256: statement.image.guestPackageManifestSha256,
				installedClosureSha256: evidence?.installedClosureSha256 ?? null,
				provenanceSha256: sha256(readFileSync(provenanceFile)),
			},
			live: {
				since: imageSince,
				cut,
				records: [record(provenanceFile), ...(evidence ? [record(evidenceFile)] : [])],
			},
		});
	}
	const artifactFile = join(lane, "guest/artifact.json");
	if (existsSync(artifactFile)) {
		const artifact = readJson(artifactFile);
		operations.push({
			op: "set",
			id: "codex-fence",
			title: "Codex binary with the result fence (in the runner image)",
			scope: "runner-image",
			identity: {
				sha256: artifact.artifact.sha256,
				codexVersion: artifact.source.version,
				codexCommit: artifact.source.commit,
				patchSha256: artifact.source.patchSha256,
			},
			live: { since: imageSince, cut, records: [record(artifactFile)] },
		});
	}
	const hostFile = join(lane, "guest/qorpera-native-provider-host.mjs");
	if (existsSync(hostFile)) {
		operations.push({
			op: "set",
			id: "guest-provider-host",
			title: "Guest provider host (in the runner image)",
			scope: "runner-image",
			identity: { sha256: sha256(readFileSync(hostFile)) },
			live: { since: imageSince, cut, records: [record(hostFile)] },
		});
	}

	const agentDir = join(lane, "agent");
	const releaseDir = existsSync(agentDir) ? newest(agentDir, /^release-\d+$/) : null;
	if (releaseDir) {
		const releaseFile = join(releaseDir, "release.json");
		const release = readJson(releaseFile);
		for (const node of ["01", "02"]) {
			const applyFile = join(agentDir, `receipts/node${node}-apply.json`);
			if (!existsSync(applyFile)) continue;
			const apply = readJson(applyFile);
			if (apply.exitCode !== 0) throw new Error(`${applyFile}: apply failed`);
			// The agent prints its state after the apply; the last state line is the one after the restart.
			const stateLine = apply.stdout
				.split("\n")
				.filter((line) => line.startsWith('{"current":'))
				.at(-1);
			if (!stateLine) throw new Error(`${applyFile}: no agent state line in the apply output`);
			const state = JSON.parse(stateLine);
			if (state.current !== release.revision)
				throw new Error(
					`${applyFile}: node is on release ${state.current}, the lane's newest release is ${release.revision}`,
				);
			const files = Object.fromEntries(release.files.map((file) => [file.name, file.sha256]));
			const buildFile = join(agentDir, `receipts/build-release-${release.revision}.json`);
			const build = existsSync(buildFile) ? readJson(buildFile) : null;
			const roles = {};
			for (const [role, info] of Object.entries(state.roles)) {
				const component = release.roles[role]?.component;
				// A role still on an older release runs the same program when the build says so against that release.
				const same = build?.changes?.[role]?.program === "same" && build.changes[role].against === info.release;
				roles[role] = {
					release: info.release,
					program: info.release === release.revision || same ? (files[component] ?? null) : null,
				};
			}
			// Agent machines (native) and sign-in machines (login) are enrolled separately and exercised by different
			// work, so each gets its own entry: a completed agent run proves nothing about signing in.
			const native = enrollmentFromLane(lane, node, "native");
			const login = enrollmentFromLane(lane, node, "login");
			const providerProgram = roles.provider?.program ?? null;
			operations.push({
				op: "set",
				id: `node-${node}-release`,
				title: `Node ${node} release (node agent: provider${roles.orchestrator ? " + orchestrator" : ""})`,
				scope: `node-${node}`,
				identity: {
					release: state.current,
					releaseJsonSha256: sha256(readFileSync(releaseFile)),
					sourceCommit: release.sourceCommit,
					roles,
					providerEnvSha256: sha256(canonicalJson(release.roles.provider?.env ?? {})),
					...(native ? { enrollment: native.identity } : {}),
				},
				live: {
					since: apply.at,
					cut,
					records: [
						record(releaseFile),
						...(build ? [record(buildFile)] : []),
						record(applyFile),
						...(native ? [record(native.file)] : []),
					],
				},
			});
			if (login)
				operations.push({
					op: "set",
					id: `node-${node}-login`,
					title: `Node ${node} sign-in machines (login gateway in the provider)`,
					scope: `node-${node}`,
					identity: { providerProgram, enrollment: login.identity },
					live: { since: apply.at, cut, records: [record(applyFile), record(login.file)] },
				});
		}
	}

	const inventoryFile = join(lane, "exec-host/receipts/inventory-replace.json");
	const rebuildFile = join(lane, "exec-host/receipts/rebuild-result.json");
	if (existsSync(rebuildFile)) {
		const rebuild = readJson(rebuildFile);
		const line = rebuild.stdout.split("\n").find((text) => text.startsWith("image="));
		const fields = Object.fromEntries((line ?? "").split(" ").map((pair) => pair.split("=")));
		if (rebuild.exitCode !== 0 || fields.service !== "active" || fields.healthz !== "200")
			throw new Error(`${rebuildFile}: exec host rebuild did not finish healthy`);
		const inventory = existsSync(inventoryFile) ? readJson(inventoryFile) : null;
		operations.push({
			op: "set",
			id: "exec-host",
			title: "Shared execution host (node 2 VM)",
			scope: "exec-host",
			identity: {
				imageFingerprint: fields.image,
				fenceSha256: fields.fence,
				sharedExecutionPackage: null,
				nodeId: inventory?.policy.nodeId ?? null,
				inventoryPolicySha256: inventory?.result[0].qorpera_replace_runtime_node_inventory.policySha256 ?? null,
			},
			live: {
				since: rebuild.at,
				cut,
				records: [record(rebuildFile), ...(inventory ? [record(inventoryFile)] : [])],
			},
		});
	}
	return { schema: CHANGES_SCHEMA, reason: `cut ${cut}`, writtenBy: "", operations };
}

/** The web client deploys itself: Cloudflare Pages builds every master commit, and every pull request head as a
 * preview. `checkRuns` is `gh api repos/Qorpera/Qorpera_Base/commits/<sha>/check-runs`; `compare` is
 * `gh api repos/Qorpera/Qorpera_Base/compare/master...<sha>`. The commit must be master's head (status identical), so
 * a preview deploy or an older master commit is refused; allowBehind accepts an older master commit when master's
 * newer commits did not deploy. */
export function webChanges(commit, checkRuns, compare, { allowBehind = false } = {}) {
	if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full 40-character commit");
	const onMaster = compare?.status === "identical" || (allowBehind && compare?.status === "behind");
	if (!onMaster) throw new Error(`the commit is not master's head (compare master...commit: ${compare?.status})`);
	const run = (checkRuns.check_runs ?? []).find((item) => item.name === "Cloudflare Pages");
	if (!run) throw new Error("no Cloudflare Pages check run for this commit");
	if (run.head_sha !== commit) throw new Error("the check run is for another commit");
	if (run.status !== "completed" || run.conclusion !== "success") throw new Error("the Pages deploy did not succeed");
	const deployment = /\/pages\/view\/[^/]+\/([0-9a-f-]{36})/.exec(run.details_url ?? "")?.[1] ?? null;
	return {
		schema: CHANGES_SCHEMA,
		reason: `web client ${commit.slice(0, 9)}`,
		writtenBy: "",
		operations: [
			{
				op: "set",
				id: "web-client",
				title: "Web client (app.qorpera.com, Cloudflare Pages from master)",
				scope: "global",
				identity: { commit, pagesDeployment: deployment },
				live: { since: run.completed_at, cut: "Pages deploy on merge to master", records: [{ url: run.html_url }] },
			},
		],
	};
}

function enrollmentFromLane(lane, node, kind) {
	const file = join(lane, `enroll/receipts/node${node}-enroll-${kind}-result.json`);
	if (!existsSync(file)) return null;
	const outcome = JSON.parse(readJson(file).stdout);
	if (!outcome.passed) throw new Error(`${file}: enrollment did not pass`);
	return {
		identity: { providerId: outcome.enroll.providerId, policies: { [kind]: outcome.enroll.policySha256 } },
		file,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------

function options(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
		out[argv[i].slice(2)] = argv[i + 1];
	}
	return out;
}

function writeAtomic(file, text) {
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
}

/** current.json must be byte-identical to the newest history file, and every history file must name the sha256 of
 * the one before it. This is what makes a hand edit visible: only `apply` writes both. */
export function checkHistory(dir, currentBytes) {
	const historyDir = join(dir, "history");
	if (!existsSync(historyDir)) return [`${historyDir} is missing`];
	const names = readdirSync(historyDir)
		.filter((name) => /^\d{4}-.*\.json$/.test(name))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	const problems = [];
	let previous = null;
	for (const name of names) {
		const bytes = readFileSync(join(historyDir, name));
		const manifest = JSON.parse(bytes);
		const expected = previous ? { sequence: previous.sequence, sha256: sha256(previous.bytes) } : null;
		if (canonicalJson(manifest.previous) !== canonicalJson(expected))
			problems.push(`history/${name}: previous does not name the file before it`);
		previous = { sequence: manifest.sequence, bytes };
	}
	if (!previous) problems.push("history is empty");
	else if (!previous.bytes.equals(currentBytes)) problems.push("current.json differs from the newest history file");
	return problems;
}

export function main(argv) {
	const [command, ...rest] = argv;
	const opts = options(rest);
	if (command === "apply") {
		const dir = resolve(opts.dir);
		const currentFile = join(dir, "current.json");
		const previousBytes = existsSync(currentFile) ? readFileSync(currentFile) : null;
		const previous = previousBytes ? JSON.parse(previousBytes) : null;
		const changes = readJson(opts.changes);
		const manifest = applyChanges(previous, changes, {
			root: opts.root ? resolve(opts.root) : undefined,
			now: opts.now ?? new Date().toISOString(),
			previousSha256: previousBytes ? sha256(previousBytes) : null,
		});
		mkdirSync(join(dir, "history"), { recursive: true });
		const text = `${JSON.stringify(manifest, null, "\t")}\n`;
		const slug = changes.reason
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48);
		const historyFile = join(dir, "history", `${String(manifest.sequence).padStart(4, "0")}-${slug}.json`);
		if (existsSync(historyFile)) throw new Error(`${historyFile} exists`);
		writeFileSync(historyFile, text, { flag: "wx" });
		writeAtomic(currentFile, text);
		writeAtomic(join(dir, "CURRENT.md"), renderMarkdown(manifest));
		const open = manifest.components.filter((c) => c.acceptance.state !== "accepted").map((c) => c.id);
		console.log(
			`manifest #${manifest.sequence} written (${basename(historyFile)}); not accepted at live identity: ${open.join(", ") || "none"}`,
		);
		return 0;
	}
	if (command === "lane") {
		const changes = laneChanges(opts.lane, resolve(opts.root), opts.cut ?? basename(resolve(opts.lane)));
		console.log(JSON.stringify(changes, null, "\t"));
		return 0;
	}
	if (command === "check") {
		const file = resolve(opts.manifest);
		const problems = checkManifest(readJson(file), { root: opts.root ? resolve(opts.root) : undefined });
		if (basename(file) === "current.json") problems.push(...checkHistory(dirname(file), readFileSync(file)));
		for (const problem of problems) console.error(problem);
		console.log(problems.length === 0 ? "manifest checks" : `${problems.length} problem(s)`);
		return problems.length === 0 ? 0 : 1;
	}
	if (command === "render") {
		process.stdout.write(renderMarkdown(readJson(opts.manifest)));
		return 0;
	}
	if (command === "drift") {
		const results = drift(readJson(opts.manifest), readJson(opts.observed));
		for (const r of results) {
			const detail = r.result === "DRIFT" ? `: manifest ${r.expected}, backend ${r.actual}` : "";
			console.log(`${r.result.padEnd(10)} ${r.id} ${r.field}${detail}`);
		}
		return results.some((r) => r.result === "DRIFT") ? 1 : 0;
	}
	if (command === "web") {
		const compare = readJson(opts.compare);
		const changes = webChanges(opts.commit, readJson(opts["check-runs"]), compare, {
			allowBehind: opts["allow-behind"] === "yes",
		});
		console.log(JSON.stringify(changes, null, "\t"));
		return 0;
	}
	console.error("usage: manifest.mjs apply|lane|check|render|drift|web (see the header of this file)");
	return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
