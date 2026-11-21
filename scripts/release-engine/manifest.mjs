import { buildReleasePrepPlan } from "../release-prep-plan.mjs";

export const RELEASE_MANIFEST_SCHEMA = "qorpera.release-manifest/v1";
export const RELEASE_MODES = Object.freeze(["sql-only", "thin-runtime", "full-image"]);
export const IMAGE_COMPRESSIONS = Object.freeze(["zstd", "gzip", "none"]);

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MIGRATION_ID = /^\d{14}$/;
const MIGRATION_FILE = /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/;
const SQL_TEST_ID = /^\d{3,6}$/;
const NODE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const POST_CHECK_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const FN_SIG = /^[a-z0-9_.]+\([a-z0-9_., \[\]]*\)$/i;

const TOP_KEYS = [
	"schema",
	"version",
	"previousVersion",
	"previousBundleSha256",
	"baseCommit",
	"releaseCommit",
	"releasePrNumber",
	"mode",
	"armed",
	"nodeRelease",
	"migrations",
	"sqlTests",
	"watchPolicy",
	"image",
	"nodes",
	"components",
];

function assertCondition(ok, message) {
	if (!ok) throw new Error(message);
}

function assertStringMatch(value, pattern, message) {
	assertCondition(typeof value === "string" && pattern.test(value), message);
}

function assertExactKeys(obj, expected, label) {
	assertCondition(obj && typeof obj === "object" && !Array.isArray(obj), `${label}: must be an object`);
	const actual = Object.keys(obj).sort();
	const wanted = [...expected].sort();
	assertCondition(
		actual.length === wanted.length && actual.every((key, idx) => key === wanted[idx]),
		`${label}: keys must be exactly [${wanted.join(", ")}]`,
	);
}

export function validateReleaseManifest(manifest) {
	assertExactKeys(manifest, TOP_KEYS, "manifest");
	assertCondition(manifest.schema === RELEASE_MANIFEST_SCHEMA, `schema must be ${RELEASE_MANIFEST_SCHEMA}`);
	assertCondition(RELEASE_MODES.includes(manifest.mode), `mode must be one of ${RELEASE_MODES.join(", ")}`);
	assertCondition(typeof manifest.armed === "boolean", "armed must be a boolean");
	assertCondition(Number.isSafeInteger(manifest.version) && manifest.version >= 1, "version must be a positive integer");
	assertCondition(
		Number.isSafeInteger(manifest.previousVersion) && manifest.previousVersion >= 0,
		"previousVersion must be a non-negative integer",
	);
	if (manifest.mode === "sql-only") {
		assertCondition(
			manifest.version === manifest.previousVersion,
			"sql-only mode must keep previousVersion equal to version (no bundle bump)",
		);
	} else {
		assertCondition(manifest.version === manifest.previousVersion + 1, "version must equal previousVersion + 1");
	}
	assertStringMatch(manifest.previousBundleSha256, HEX_64, "previousBundleSha256 must be 64 hex chars");
	assertStringMatch(manifest.baseCommit, HEX_40, "baseCommit must be 40 hex chars");
	assertCondition(
		manifest.releaseCommit === null || (typeof manifest.releaseCommit === "string" && HEX_40.test(manifest.releaseCommit)),
		"releaseCommit must be 40 hex chars or null",
	);
	assertCondition(
		manifest.releasePrNumber === null ||
			(Number.isSafeInteger(manifest.releasePrNumber) && manifest.releasePrNumber >= 1),
		"releasePrNumber must be a positive integer or null",
	);
	if (manifest.mode === "sql-only") {
		assertCondition(manifest.releaseCommit === null, "sql-only mode must have releaseCommit = null");
		assertCondition(manifest.releasePrNumber === null, "sql-only mode must have releasePrNumber = null");
	} else if (manifest.armed) {
		assertCondition(manifest.releaseCommit !== null, `${manifest.mode} requires releaseCommit when armed`);
		assertCondition(manifest.releasePrNumber !== null, `${manifest.mode} requires releasePrNumber when armed`);
	}

	assertExactKeys(manifest.nodeRelease, ["revision", "previousRevision", "required"], "nodeRelease");
	assertCondition(typeof manifest.nodeRelease.required === "boolean", "nodeRelease.required must be boolean");
	assertCondition(
		Number.isSafeInteger(manifest.nodeRelease.previousRevision) && manifest.nodeRelease.previousRevision >= 0,
		"nodeRelease.previousRevision must be a non-negative integer",
	);
	assertCondition(
		Number.isSafeInteger(manifest.nodeRelease.revision) && manifest.nodeRelease.revision >= 0,
		"nodeRelease.revision must be a non-negative integer",
	);
	if (manifest.mode === "sql-only") {
		assertCondition(!manifest.nodeRelease.required, "sql-only mode cannot require a node release");
		assertCondition(
			manifest.nodeRelease.revision === manifest.nodeRelease.previousRevision,
			"sql-only mode must keep nodeRelease.revision equal to previousRevision",
		);
	} else {
		assertCondition(manifest.nodeRelease.required, `${manifest.mode} must require a node release`);
		assertCondition(
			manifest.nodeRelease.revision === manifest.nodeRelease.previousRevision + 1,
			"nodeRelease.revision must equal previousRevision + 1",
		);
	}

	assertCondition(Array.isArray(manifest.migrations), "migrations must be an array");
	if (manifest.mode === "sql-only") {
		assertCondition(manifest.migrations.length > 0, "sql-only mode requires at least one migration");
	}
	const seenIds = new Set();
	for (const migration of manifest.migrations) {
		assertExactKeys(migration, ["id", "file", "anchors", "postChecks"], "migration");
		assertStringMatch(migration.id, MIGRATION_ID, `invalid migration id: ${migration.id}`);
		assertCondition(!seenIds.has(migration.id), `duplicate migration id: ${migration.id}`);
		seenIds.add(migration.id);
		assertStringMatch(migration.file, MIGRATION_FILE, `invalid migration file: ${migration.file}`);
		assertCondition(
			migration.file.startsWith(`supabase/migrations/${migration.id}_`),
			`migration file '${migration.file}' does not match migration id '${migration.id}'`,
		);
		assertCondition(Array.isArray(migration.anchors), "migration.anchors must be an array");
		for (const anchor of migration.anchors) {
			assertExactKeys(anchor, ["functionSignature", "snippet", "expectedCount"], "anchor");
			assertStringMatch(anchor.functionSignature, FN_SIG, `invalid functionSignature: ${anchor.functionSignature}`);
			assertCondition(typeof anchor.snippet === "string" && anchor.snippet.length > 0, "anchor.snippet must be non-empty");
			assertCondition(
				Number.isSafeInteger(anchor.expectedCount) && anchor.expectedCount >= 0 && anchor.expectedCount <= 20,
				"anchor.expectedCount must be an integer 0..20",
			);
		}
		assertCondition(Array.isArray(migration.postChecks), "migration.postChecks must be an array");
		const seenChecks = new Set();
		for (const check of migration.postChecks) {
			assertExactKeys(check, ["name", "sql", "expected"], "postCheck");
			assertStringMatch(check.name, POST_CHECK_NAME, `invalid postCheck name: ${check.name}`);
			assertCondition(!seenChecks.has(check.name), `duplicate postCheck name: ${check.name}`);
			seenChecks.add(check.name);
			assertCondition(typeof check.sql === "string" && check.sql.trim().length > 0, "postCheck.sql must be non-empty");
		}
	}

	assertCondition(Array.isArray(manifest.sqlTests), "sqlTests must be an array");
	const seenSqlTests = new Set();
	for (const sqlTest of manifest.sqlTests) {
		assertStringMatch(sqlTest, SQL_TEST_ID, `invalid sqlTest: ${sqlTest}`);
		assertCondition(!seenSqlTests.has(sqlTest), `duplicate sqlTest: ${sqlTest}`);
		seenSqlTests.add(sqlTest);
	}

	assertExactKeys(
		manifest.watchPolicy,
		["homeWatchMinutes", "claudeWatchMinutes", "smokeMinutes", "pollSeconds", "earlyExitOnCompletedRuns"],
		"watchPolicy",
	);
	for (const key of ["homeWatchMinutes", "claudeWatchMinutes", "smokeMinutes"]) {
		const value = manifest.watchPolicy[key];
		assertCondition(Number.isSafeInteger(value) && value >= 0 && value <= 60, `watchPolicy.${key} must be 0..60`);
	}
	assertCondition(
		Number.isSafeInteger(manifest.watchPolicy.pollSeconds) &&
			manifest.watchPolicy.pollSeconds >= 5 &&
			manifest.watchPolicy.pollSeconds <= 300,
		"watchPolicy.pollSeconds must be 5..300",
	);
	assertCondition(
		Number.isSafeInteger(manifest.watchPolicy.earlyExitOnCompletedRuns) &&
			manifest.watchPolicy.earlyExitOnCompletedRuns >= 0 &&
			manifest.watchPolicy.earlyExitOnCompletedRuns <= 50,
		"watchPolicy.earlyExitOnCompletedRuns must be 0..50",
	);

	assertExactKeys(manifest.image, ["compression", "rebuildRequired"], "image");
	assertCondition(IMAGE_COMPRESSIONS.includes(manifest.image.compression), "image.compression must be zstd, gzip, or none");
	assertCondition(typeof manifest.image.rebuildRequired === "boolean", "image.rebuildRequired must be boolean");
	if (manifest.mode === "full-image") {
		assertCondition(manifest.image.rebuildRequired, "full-image must have image.rebuildRequired = true");
	} else {
		assertCondition(!manifest.image.rebuildRequired, `${manifest.mode} must have image.rebuildRequired = false`);
	}

	assertExactKeys(manifest.nodes, ["nodeA", "nodeB", "slotsLive", "slotsNew", "wakeLive", "wakeOn"], "nodes");
	assertStringMatch(manifest.nodes.nodeA, NODE_NAME, "invalid nodes.nodeA");
	assertStringMatch(manifest.nodes.nodeB, NODE_NAME, "invalid nodes.nodeB");
	assertCondition(manifest.nodes.nodeA !== manifest.nodes.nodeB, "nodes.nodeA and nodes.nodeB must differ");
	assertCondition(
		Number.isSafeInteger(manifest.nodes.slotsLive) && manifest.nodes.slotsLive >= 1 && manifest.nodes.slotsLive <= 64,
		"nodes.slotsLive must be 1..64",
	);
	assertCondition(
		Number.isSafeInteger(manifest.nodes.slotsNew) && manifest.nodes.slotsNew >= 1 && manifest.nodes.slotsNew <= 64,
		"nodes.slotsNew must be 1..64",
	);
	assertCondition(
		Number.isSafeInteger(manifest.nodes.wakeLive) && manifest.nodes.wakeLive >= 0 && manifest.nodes.wakeLive <= 10,
		"nodes.wakeLive must be 0..10",
	);
	assertCondition(typeof manifest.nodes.wakeOn === "boolean", "nodes.wakeOn must be boolean");

	assertExactKeys(
		manifest.components,
		["vaultChanged", "executorChanged", "sharedExecutionChanged"],
		"components",
	);
	for (const key of ["vaultChanged", "executorChanged", "sharedExecutionChanged"]) {
		assertCondition(typeof manifest.components[key] === "boolean", `components.${key} must be boolean`);
	}
	return manifest;
}

export function createReleaseManifest({
	previousVersion,
	previousBundleSha256,
	baseCommit,
	releaseCommit = null,
	releasePrNumber = null,
	previousNodeReleaseRevision,
	classification,
	thinRuntimeEnabled = true,
	nodes = { nodeA: "node01", nodeB: "node02", slotsLive: 12, slotsNew: 12, wakeLive: 2, wakeOn: true },
}) {
	const plan = buildReleasePrepPlan(classification, { thinRuntimeEnabled });
	const version = plan.needsBundleBump ? previousVersion + 1 : previousVersion;
	const nodeRevision = plan.needsNodeRelease ? previousNodeReleaseRevision + 1 : previousNodeReleaseRevision;
	const migrations = plan.migrations.map((file) => {
		const id = /^supabase\/migrations\/(\d{14})_/.exec(file)?.[1] ?? "";
		return {
			id,
			file,
			anchors: [],
			postChecks: [],
		};
	});
	const manifest = {
		schema: RELEASE_MANIFEST_SCHEMA,
		version,
		previousVersion,
		previousBundleSha256,
		baseCommit,
		releaseCommit: plan.mode === "sql-only" ? null : releaseCommit,
		releasePrNumber: plan.mode === "sql-only" ? null : releasePrNumber,
		mode: plan.mode,
		armed: false,
		nodeRelease: {
			revision: nodeRevision,
			previousRevision: previousNodeReleaseRevision,
			required: plan.needsNodeRelease,
		},
		migrations,
		sqlTests: [...plan.sqlTests],
		watchPolicy: plan.watchPolicy,
		image: {
			compression: plan.imageCompression,
			rebuildRequired: plan.needsBaseImageRebuild,
		},
		nodes,
		components: {
			vaultChanged: plan.changedComponents.vault,
			executorChanged: plan.changedComponents.executor,
			sharedExecutionChanged: plan.changedComponents.sharedExecution,
		},
	};
	return validateReleaseManifest(manifest);
}
