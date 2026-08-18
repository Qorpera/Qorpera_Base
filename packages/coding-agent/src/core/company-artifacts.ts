import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const COMPANY_ARTIFACT_SCHEMA = "qorpera.artifact/v1" as const;

export const COMPANY_ARTIFACT_STATUSES = Object.freeze([
	"setting-up",
	"waiting-for-data",
	"partial",
	"validating",
	"operating",
] as const);
export type CompanyArtifactStatus = (typeof COMPANY_ARTIFACT_STATUSES)[number];

export const COMPANY_ARTIFACT_METRIC_STATUSES = Object.freeze(["unknown", "measured", "stale", "blocked"] as const);
export type CompanyArtifactMetricStatus = (typeof COMPANY_ARTIFACT_METRIC_STATUSES)[number];

export const COMPANY_ARTIFACT_METRIC_DIRECTIONS = Object.freeze([
	"higher-is-better",
	"lower-is-better",
	"target",
	"observe",
] as const);
export type CompanyArtifactMetricDirection = (typeof COMPANY_ARTIFACT_METRIC_DIRECTIONS)[number];

export const COMPANY_ARTIFACT_DATA_STATUSES = Object.freeze([
	"missing",
	"selected",
	"connected",
	"available",
	"declined",
] as const);
export type CompanyArtifactDataStatus = (typeof COMPANY_ARTIFACT_DATA_STATUSES)[number];

export const COMPANY_ARTIFACT_SOURCE_DECISIONS = Object.freeze(["authoritative", "supporting", "invalid"] as const);
export type CompanyArtifactSourceDecision = (typeof COMPANY_ARTIFACT_SOURCE_DECISIONS)[number];

export const COMPANY_ARTIFACT_SOURCE_ASSESSORS = Object.freeze(["agent", "worker", "lint"] as const);
export type CompanyArtifactSourceAssessor = (typeof COMPANY_ARTIFACT_SOURCE_ASSESSORS)[number];

export interface StarterArtifactMetric {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly direction: CompanyArtifactMetricDirection;
	readonly unit?: string;
	readonly target?: string | number;
}

export interface StarterArtifactDataNeed {
	readonly id: string;
	readonly label: string;
	readonly purpose: string;
	readonly connectorHints: readonly string[];
}

export interface StarterArtifactDefinition {
	readonly title: string;
	readonly purpose: string;
	readonly metrics: readonly StarterArtifactMetric[];
	readonly dataNeeds: readonly StarterArtifactDataNeed[];
}

export interface CompanyArtifactMetric extends StarterArtifactMetric {
	readonly status: CompanyArtifactMetricStatus;
	readonly statusReason?: string;
	readonly statusChangedAt?: string;
	readonly value?: string | number;
	readonly score?: number;
	readonly evidence: readonly string[];
	readonly observedAt?: string;
	readonly sourceRef?: string;
	readonly observations?: readonly CompanyArtifactMetricObservation[];
}

export interface CompanyArtifactMetricObservation {
	readonly at: string;
	readonly value: number;
	readonly sourceRef?: string;
	readonly evidence?: readonly string[];
}

export interface CompanyArtifactDataNeed extends StarterArtifactDataNeed {
	readonly status: CompanyArtifactDataStatus;
	readonly sourceRefs: readonly string[];
	readonly sourceAssessments: readonly CompanyArtifactSourceAssessment[];
	readonly connectionRequestId?: string;
}

export interface CompanyArtifactSourceAssessment {
	readonly sourceRef: string;
	readonly dataType: string;
	readonly decision: CompanyArtifactSourceDecision;
	readonly rationale: string;
	readonly metricIds: readonly string[];
	readonly evidence: readonly string[];
	readonly assessedAt: string;
	readonly assessedBy: CompanyArtifactSourceAssessor;
}

export interface CompanyArtifact {
	readonly schema: typeof COMPANY_ARTIFACT_SCHEMA;
	readonly id: string;
	readonly title: string;
	readonly purpose: string;
	readonly stewardAgentId: string;
	readonly accountableDepartmentId?: string;
	readonly status: CompanyArtifactStatus;
	readonly score?: number;
	readonly metrics: readonly CompanyArtifactMetric[];
	readonly dataNeeds: readonly CompanyArtifactDataNeed[];
	readonly starter?: { readonly templateId: string };
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CompanyArtifactRecord extends CompanyArtifact {
	readonly relativePath: string;
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const SAFE_ARTIFACT_ITEM_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_REFERENCES = 64;
const MAX_METRIC_OBSERVATIONS = 512;
const MAX_SOURCE_ASSESSMENTS = 256;

export interface CompanyArtifactMetricDefinitionUpdate {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly direction: CompanyArtifactMetricDirection;
	readonly unit?: string | null;
	readonly target?: string | number | null;
}

export interface CompanyArtifactDataNeedDefinitionUpdate {
	readonly id: string;
	readonly label: string;
	readonly purpose: string;
	readonly connectorHints: readonly string[];
}

export interface CompanyArtifactFounderUpdate {
	readonly expectedUpdatedAt: string;
	readonly title?: string;
	readonly purpose?: string;
	readonly accountableDepartmentId?: string | null;
	readonly metrics?: readonly CompanyArtifactMetricDefinitionUpdate[];
	readonly dataNeeds?: readonly CompanyArtifactDataNeedDefinitionUpdate[];
}

export type CompanyArtifactConnectionTransition = "suggested" | "selected" | "connected" | "failed" | "declined";

export interface CompanyArtifactMetricObservationUpdate {
	readonly id: string;
	readonly value: string | number;
	readonly score?: number;
	readonly evidence?: readonly string[];
}

export interface CompanyArtifactObservationUpdate {
	readonly dataNeedId: string;
	readonly sourceRef: string;
	readonly observedAt: string;
	readonly metrics: readonly CompanyArtifactMetricObservationUpdate[];
}

export interface CompanyArtifactSourceAssessmentUpdate {
	readonly dataNeedId: string;
	readonly sourceRef: string;
	readonly dataType: string;
	readonly decision: CompanyArtifactSourceDecision;
	readonly rationale: string;
	readonly metricIds: readonly string[];
	readonly evidence: readonly string[];
	readonly assessedAt: string;
}

export interface CompanyArtifactSourceIssueUpdate {
	readonly dataNeedId: string;
	readonly sourceRef: string;
	readonly occurredAt: string;
	readonly status: "stale" | "blocked";
	readonly reason: string;
	readonly metricIds: readonly string[];
}

function boundedString(value: unknown, label: string, max = 4000): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > max) throw new Error(`${label} must contain 1-${max} characters`);
	return trimmed;
}

function optionalBoundedString(value: unknown, label: string, max = 4000): string | undefined {
	if (value === undefined) return undefined;
	return boundedString(value, label, max);
}

function artifactItemId(value: unknown, label: string, max: 128 | 256): string {
	const id = boundedString(value, label, max);
	if (!SAFE_ARTIFACT_ITEM_ID.test(id)) throw new Error(`${label} is invalid`);
	return id;
}

function isoTimestamp(value: unknown, label: string): string {
	const timestamp = boundedString(value, label, 64);
	if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
	return timestamp;
}

function score(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		throw new Error(`${label} must be a number from 0 to 100`);
	}
	return value;
}

function stringArray(value: unknown, label: string, maxItems = 64): readonly string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be an array`);
	return Object.freeze(value.map((entry, index) => boundedString(entry, `${label}[${index}]`, 1000)));
}

function recentUniqueReferences(existing: readonly string[], additions: readonly string[]): readonly string[] {
	const added = new Set(additions);
	return [...existing.filter((entry) => !added.has(entry)), ...added].slice(-MAX_ARTIFACT_REFERENCES);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} must be one of ${values.join(", ")}`);
	}
	return value as T;
}

function metricObservations(
	value: unknown,
	metricIndex: number,
): readonly CompanyArtifactMetricObservation[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_METRIC_OBSERVATIONS) {
		throw new Error(`metrics[${metricIndex}].observations must be an array`);
	}
	const observations = value.map((entry, observationIndex) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`metrics[${metricIndex}].observations[${observationIndex}] must be an object`);
		}
		const input = entry as Record<string, unknown>;
		if (
			Object.keys(input).some((key) => !["at", "value", "sourceRef", "evidence"].includes(key)) ||
			typeof input.value !== "number" ||
			!Number.isFinite(input.value)
		) {
			throw new Error(`metrics[${metricIndex}].observations[${observationIndex}] is invalid`);
		}
		const sourceRef = optionalBoundedString(
			input.sourceRef,
			`metrics[${metricIndex}].observations[${observationIndex}].sourceRef`,
			1000,
		);
		const evidence =
			input.evidence === undefined
				? undefined
				: stringArray(input.evidence, `metrics[${metricIndex}].observations[${observationIndex}].evidence`);
		return Object.freeze({
			at: isoTimestamp(input.at, `metrics[${metricIndex}].observations[${observationIndex}].at`),
			value: input.value,
			...(sourceRef ? { sourceRef } : {}),
			...(evidence ? { evidence } : {}),
		});
	});
	for (let index = 1; index < observations.length; index += 1) {
		if (Date.parse(observations[index - 1].at) >= Date.parse(observations[index].at)) {
			throw new Error(`metrics[${metricIndex}].observations must be strictly chronological`);
		}
	}
	return Object.freeze(observations);
}

function metric(value: unknown, index: number): CompanyArtifactMetric {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`metrics[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const metricValue = input.value;
	const unit = optionalBoundedString(input.unit, `metrics[${index}].unit`, 80);
	const metricScore = score(input.score, `metrics[${index}].score`);
	const observations = metricObservations(input.observations, index);
	const statusReason = optionalBoundedString(input.statusReason, `metrics[${index}].statusReason`, 1000);
	const sourceRef = optionalBoundedString(input.sourceRef, `metrics[${index}].sourceRef`, 1000);
	if (metricValue !== undefined && typeof metricValue !== "string" && typeof metricValue !== "number") {
		throw new Error(`metrics[${index}].value must be a string or number`);
	}
	return Object.freeze({
		id: artifactItemId(input.id, `metrics[${index}].id`, 128),
		label: boundedString(input.label, `metrics[${index}].label`, 160),
		description: boundedString(input.description, `metrics[${index}].description`, 1000),
		direction: oneOf(input.direction, COMPANY_ARTIFACT_METRIC_DIRECTIONS, `metrics[${index}].direction`),
		...(unit ? { unit } : {}),
		...(typeof input.target === "string" || typeof input.target === "number" ? { target: input.target } : {}),
		status: oneOf(input.status, COMPANY_ARTIFACT_METRIC_STATUSES, `metrics[${index}].status`),
		...(statusReason ? { statusReason } : {}),
		...(input.statusChangedAt !== undefined
			? { statusChangedAt: isoTimestamp(input.statusChangedAt, `metrics[${index}].statusChangedAt`) }
			: {}),
		...(metricValue !== undefined ? { value: metricValue } : {}),
		...(metricScore !== undefined ? { score: metricScore } : {}),
		evidence: stringArray(input.evidence, `metrics[${index}].evidence`),
		...(input.observedAt !== undefined
			? { observedAt: isoTimestamp(input.observedAt, `metrics[${index}].observedAt`) }
			: {}),
		...(sourceRef ? { sourceRef } : {}),
		...(observations ? { observations } : {}),
	});
}

function sourceAssessment(
	value: unknown,
	dataNeedIndex: number,
	assessmentIndex: number,
): CompanyArtifactSourceAssessment {
	const label = `dataNeeds[${dataNeedIndex}].sourceAssessments[${assessmentIndex}]`;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const input = value as Record<string, unknown>;
	const metricIds = stringArray(input.metricIds, `${label}.metricIds`);
	if (metricIds.length === 0 || new Set(metricIds).size !== metricIds.length) {
		throw new Error(`${label}.metricIds must contain unique metric ids`);
	}
	const evidence = stringArray(input.evidence, `${label}.evidence`);
	if (evidence.length === 0) throw new Error(`${label}.evidence must identify the assessment basis`);
	return Object.freeze({
		sourceRef: boundedString(input.sourceRef, `${label}.sourceRef`, 1000),
		dataType: boundedString(input.dataType, `${label}.dataType`, 160),
		decision: oneOf(input.decision, COMPANY_ARTIFACT_SOURCE_DECISIONS, `${label}.decision`),
		rationale: boundedString(input.rationale, `${label}.rationale`, 1000),
		metricIds,
		evidence,
		assessedAt: isoTimestamp(input.assessedAt, `${label}.assessedAt`),
		assessedBy: oneOf(input.assessedBy, COMPANY_ARTIFACT_SOURCE_ASSESSORS, `${label}.assessedBy`),
	});
}

function dataNeed(value: unknown, index: number): CompanyArtifactDataNeed {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`dataNeeds[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const assessmentsValue = input.sourceAssessments ?? [];
	if (!Array.isArray(assessmentsValue) || assessmentsValue.length > MAX_SOURCE_ASSESSMENTS) {
		throw new Error(`dataNeeds[${index}].sourceAssessments must be an array`);
	}
	return Object.freeze({
		id: artifactItemId(input.id, `dataNeeds[${index}].id`, 128),
		label: boundedString(input.label, `dataNeeds[${index}].label`, 160),
		purpose: boundedString(input.purpose, `dataNeeds[${index}].purpose`, 1000),
		connectorHints: stringArray(input.connectorHints, `dataNeeds[${index}].connectorHints`, 16),
		status: oneOf(input.status, COMPANY_ARTIFACT_DATA_STATUSES, `dataNeeds[${index}].status`),
		sourceRefs: stringArray(input.sourceRefs, `dataNeeds[${index}].sourceRefs`),
		sourceAssessments: Object.freeze(
			assessmentsValue.map((entry, assessmentIndex) => sourceAssessment(entry, index, assessmentIndex)),
		),
		...(input.connectionRequestId !== undefined
			? {
					connectionRequestId: (() => {
						const id = boundedString(input.connectionRequestId, `dataNeeds[${index}].connectionRequestId`, 64);
						if (!UUID_PATTERN.test(id)) {
							throw new Error(`dataNeeds[${index}].connectionRequestId must be a UUID`);
						}
						return id;
					})(),
				}
			: {}),
	});
}

function parseArtifact(value: unknown, relativePath: string): CompanyArtifactRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact must be an object");
	const input = value as Record<string, unknown>;
	if (input.schema !== COMPANY_ARTIFACT_SCHEMA) throw new Error(`unsupported artifact schema in ${relativePath}`);
	if (!Array.isArray(input.metrics) || input.metrics.length > 64) throw new Error("metrics must be an array");
	if (!Array.isArray(input.dataNeeds) || input.dataNeeds.length > 64) throw new Error("dataNeeds must be an array");
	const metrics = input.metrics.map(metric);
	const dataNeeds = input.dataNeeds.map(dataNeed);
	if (new Set(metrics.map((entry) => entry.id)).size !== metrics.length) throw new Error("metric ids must be unique");
	if (new Set(dataNeeds.map((entry) => entry.id)).size !== dataNeeds.length) {
		throw new Error("data-need ids must be unique");
	}
	const starter = input.starter;
	const parsedStarter =
		starter && typeof starter === "object" && !Array.isArray(starter)
			? { templateId: boundedString((starter as Record<string, unknown>).templateId, "starter.templateId", 128) }
			: undefined;
	const accountableDepartmentId = optionalBoundedString(input.accountableDepartmentId, "accountableDepartmentId", 128);
	const artifactScore = score(input.score, "score");
	return Object.freeze({
		schema: COMPANY_ARTIFACT_SCHEMA,
		id: artifactItemId(input.id, "id", 256),
		title: boundedString(input.title, "title", 200),
		purpose: boundedString(input.purpose, "purpose", 2000),
		stewardAgentId: boundedString(input.stewardAgentId, "stewardAgentId", 128),
		...(accountableDepartmentId ? { accountableDepartmentId } : {}),
		status: oneOf(input.status, COMPANY_ARTIFACT_STATUSES, "status"),
		...(artifactScore !== undefined ? { score: artifactScore } : {}),
		metrics: Object.freeze(metrics),
		dataNeeds: Object.freeze(dataNeeds),
		...(parsedStarter ? { starter: Object.freeze(parsedStarter) } : {}),
		createdAt: isoTimestamp(input.createdAt, "createdAt"),
		updatedAt: isoTimestamp(input.updatedAt, "updatedAt"),
		relativePath,
	});
}

function agentsRoot(root: string): string {
	return resolve(root, "agents");
}

function artifactRoot(root: string, stewardAgentId: string): string {
	assertSafeSegment(stewardAgentId, "stewardAgentId");
	return resolve(agentsRoot(root), stewardAgentId, "artifacts");
}

function normalizedPhysicalPath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertPhysicalDirectory(path: string, label: string): void {
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		normalizedPhysicalPath(realpathSync(path)) !== normalizedPhysicalPath(path)
	) {
		throw new Error(`${label} must be a physical directory`);
	}
}

function assertSafeSegment(value: string, label: string): void {
	if (!SAFE_SEGMENT.test(value)) throw new Error(`${label} is not a safe path segment`);
}

function portableRelativePath(root: string, path: string): string {
	return relative(resolve(root), resolve(path)).split(sep).join("/");
}

function readArtifactFile(root: string, path: string, stewardAgentId?: string): CompanyArtifactRecord {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("artifact path must be a regular file");
	if (stat.size > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds the 1 MiB limit");
	const record = parseArtifact(JSON.parse(readFileSync(path, "utf-8")) as unknown, portableRelativePath(root, path));
	if (stewardAgentId && record.stewardAgentId !== stewardAgentId) {
		throw new Error(`artifact steward does not match its directory: ${record.relativePath}`);
	}
	return record;
}

function artifactDocument(record: CompanyArtifactRecord): CompanyArtifact {
	return {
		schema: record.schema,
		id: record.id,
		title: record.title,
		purpose: record.purpose,
		stewardAgentId: record.stewardAgentId,
		...(record.accountableDepartmentId ? { accountableDepartmentId: record.accountableDepartmentId } : {}),
		status: record.status,
		...(record.score !== undefined ? { score: record.score } : {}),
		metrics: record.metrics.map((entry) => ({
			...entry,
			evidence: [...entry.evidence],
			...(entry.observations
				? {
						observations: entry.observations.map((observation) => ({
							...observation,
							...(observation.evidence ? { evidence: [...observation.evidence] } : {}),
						})),
					}
				: {}),
		})),
		dataNeeds: record.dataNeeds.map((entry) => ({
			...entry,
			connectorHints: [...entry.connectorHints],
			sourceRefs: [...entry.sourceRefs],
			sourceAssessments: entry.sourceAssessments.map((assessment) => ({
				...assessment,
				metricIds: [...assessment.metricIds],
				evidence: [...assessment.evidence],
			})),
		})),
		...(record.starter ? { starter: { ...record.starter } } : {}),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function writeArtifactDocument(root: string, relativePath: string, artifact: CompanyArtifact): CompanyArtifactRecord {
	const rootDirectory = artifactRoot(root, artifact.stewardAgentId);
	assertPhysicalDirectory(rootDirectory, "agent artifacts directory");
	const path = resolve(root, relativePath);
	const rel = relative(rootDirectory, path);
	if (
		!rel ||
		rel.startsWith("..") ||
		normalizedPhysicalPath(resolve(rootDirectory, rel)) !== normalizedPhysicalPath(path)
	) {
		throw new Error("artifact write path escaped the agent artifacts directory");
	}
	assertPhysicalDirectory(dirname(path), "agent artifacts directory");
	const current = lstatSync(path);
	if (!current.isFile() || current.isSymbolicLink()) throw new Error("artifact path must be a regular file");
	parseArtifact(artifact, relativePath);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	return readArtifactFile(root, path, artifact.stewardAgentId);
}

function companyArtifactById(root: string, id: string): CompanyArtifactRecord {
	const matches = readCompanyArtifacts(root).filter((artifact) => artifact.id === id);
	if (matches.length !== 1)
		throw new Error(matches.length ? `Artifact id is ambiguous: ${id}` : `Unknown artifact: ${id}`);
	return matches[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function metricDefinitionUpdate(value: unknown, index: number): CompanyArtifactMetricDefinitionUpdate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["id", "label", "description", "direction", "unit", "target"]))
	) {
		throw new Error(`metrics[${index}] is invalid`);
	}
	const id = boundedString(value.id, `metrics[${index}].id`, 128);
	if (!SAFE_ARTIFACT_ITEM_ID.test(id)) throw new Error(`metrics[${index}].id is invalid`);
	const unit = value.unit === null ? null : optionalBoundedString(value.unit, `metrics[${index}].unit`, 80);
	if (
		value.target !== undefined &&
		value.target !== null &&
		typeof value.target !== "string" &&
		typeof value.target !== "number"
	) {
		throw new Error(`metrics[${index}].target is invalid`);
	}
	return {
		id,
		label: boundedString(value.label, `metrics[${index}].label`, 160),
		description: boundedString(value.description, `metrics[${index}].description`, 1000),
		direction: oneOf(value.direction, COMPANY_ARTIFACT_METRIC_DIRECTIONS, `metrics[${index}].direction`),
		...(unit !== undefined ? { unit } : {}),
		...(value.target !== undefined ? { target: value.target as string | number | null } : {}),
	};
}

function dataNeedDefinitionUpdate(value: unknown, index: number): CompanyArtifactDataNeedDefinitionUpdate {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["id", "label", "purpose", "connectorHints"]))) {
		throw new Error(`dataNeeds[${index}] is invalid`);
	}
	const id = boundedString(value.id, `dataNeeds[${index}].id`, 128);
	if (!SAFE_ARTIFACT_ITEM_ID.test(id)) throw new Error(`dataNeeds[${index}].id is invalid`);
	return {
		id,
		label: boundedString(value.label, `dataNeeds[${index}].label`, 160),
		purpose: boundedString(value.purpose, `dataNeeds[${index}].purpose`, 1000),
		connectorHints: stringArray(value.connectorHints, `dataNeeds[${index}].connectorHints`, 16),
	};
}

function founderUpdate(value: unknown): CompanyArtifactFounderUpdate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(
			value,
			new Set(["expectedUpdatedAt", "title", "purpose", "accountableDepartmentId", "metrics", "dataNeeds"]),
		)
	) {
		throw new Error("artifact update is invalid");
	}
	const metrics =
		value.metrics === undefined
			? undefined
			: Array.isArray(value.metrics)
				? value.metrics.map(metricDefinitionUpdate)
				: undefined;
	const dataNeeds =
		value.dataNeeds === undefined
			? undefined
			: Array.isArray(value.dataNeeds)
				? value.dataNeeds.map(dataNeedDefinitionUpdate)
				: undefined;
	if (
		(value.metrics !== undefined && !metrics) ||
		(metrics?.length ?? 0) > 64 ||
		(value.dataNeeds !== undefined && !dataNeeds) ||
		(dataNeeds?.length ?? 0) > 64
	) {
		throw new Error("artifact update is invalid");
	}
	if (metrics && new Set(metrics.map((entry) => entry.id)).size !== metrics.length)
		throw new Error("metric ids must be unique");
	if (dataNeeds && new Set(dataNeeds.map((entry) => entry.id)).size !== dataNeeds.length)
		throw new Error("data-need ids must be unique");
	const accountableDepartmentId =
		value.accountableDepartmentId === null
			? null
			: optionalBoundedString(value.accountableDepartmentId, "accountableDepartmentId", 128);
	return {
		expectedUpdatedAt: isoTimestamp(value.expectedUpdatedAt, "expectedUpdatedAt"),
		...(value.title !== undefined ? { title: boundedString(value.title, "title", 200) } : {}),
		...(value.purpose !== undefined ? { purpose: boundedString(value.purpose, "purpose", 2000) } : {}),
		...(accountableDepartmentId !== undefined ? { accountableDepartmentId } : {}),
		...(metrics ? { metrics } : {}),
		...(dataNeeds ? { dataNeeds } : {}),
	};
}

function observationUpdate(value: unknown): CompanyArtifactObservationUpdate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["dataNeedId", "sourceRef", "observedAt", "metrics"])) ||
		!Array.isArray(value.metrics) ||
		value.metrics.length === 0 ||
		value.metrics.length > 64
	) {
		throw new Error("artifact observation is invalid");
	}
	const metrics = value.metrics.map((entry, index) => {
		if (!isRecord(entry) || !hasOnlyKeys(entry, new Set(["id", "value", "score", "evidence"]))) {
			throw new Error(`metrics[${index}] observation is invalid`);
		}
		const id = artifactItemId(entry.id, `metrics[${index}].id`, 128);
		const metricValue = entry.value;
		if (
			(typeof metricValue !== "number" || !Number.isFinite(metricValue)) &&
			(typeof metricValue !== "string" || !metricValue.trim() || metricValue.length > 2000)
		) {
			throw new Error(`metrics[${index}].value must be a finite number or non-empty string`);
		}
		const metricScore = score(entry.score, `metrics[${index}].score`);
		const evidence =
			entry.evidence === undefined ? undefined : stringArray(entry.evidence, `metrics[${index}].evidence`);
		return {
			id,
			value: typeof metricValue === "string" ? metricValue.trim() : metricValue,
			...(metricScore !== undefined ? { score: metricScore } : {}),
			...(evidence ? { evidence } : {}),
		};
	});
	if (new Set(metrics.map((entry) => entry.id)).size !== metrics.length) {
		throw new Error("observed metric ids must be unique");
	}
	return {
		dataNeedId: artifactItemId(value.dataNeedId, "dataNeedId", 128),
		sourceRef: boundedString(value.sourceRef, "sourceRef", 1000),
		observedAt: isoTimestamp(value.observedAt, "observedAt"),
		metrics,
	};
}

function sourceAssessmentUpdate(value: unknown): CompanyArtifactSourceAssessmentUpdate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(
			value,
			new Set([
				"dataNeedId",
				"sourceRef",
				"dataType",
				"decision",
				"rationale",
				"metricIds",
				"evidence",
				"assessedAt",
			]),
		) ||
		!Array.isArray(value.metricIds) ||
		value.metricIds.length === 0 ||
		value.metricIds.length > 64 ||
		!Array.isArray(value.evidence) ||
		value.evidence.length === 0
	) {
		throw new Error("artifact source assessment is invalid");
	}
	const metricIds = value.metricIds.map((id, index) => artifactItemId(id, `metricIds[${index}]`, 128));
	if (new Set(metricIds).size !== metricIds.length) {
		throw new Error("artifact source assessment metric ids must be unique");
	}
	return {
		dataNeedId: artifactItemId(value.dataNeedId, "dataNeedId", 128),
		sourceRef: boundedString(value.sourceRef, "sourceRef", 1000),
		dataType: boundedString(value.dataType, "dataType", 160),
		decision: oneOf(value.decision, COMPANY_ARTIFACT_SOURCE_DECISIONS, "decision"),
		rationale: boundedString(value.rationale, "rationale", 1000),
		metricIds,
		evidence: stringArray(value.evidence, "evidence"),
		assessedAt: isoTimestamp(value.assessedAt, "assessedAt"),
	};
}

function sourceIssueUpdate(value: unknown): CompanyArtifactSourceIssueUpdate {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["dataNeedId", "sourceRef", "occurredAt", "status", "reason", "metricIds"])) ||
		!Array.isArray(value.metricIds) ||
		value.metricIds.length === 0 ||
		value.metricIds.length > 64
	) {
		throw new Error("artifact source issue is invalid");
	}
	const metricIds = value.metricIds.map((id, index) => artifactItemId(id, `metricIds[${index}]`, 128));
	if (new Set(metricIds).size !== metricIds.length) throw new Error("artifact source issue metric ids must be unique");
	return {
		dataNeedId: artifactItemId(value.dataNeedId, "dataNeedId", 128),
		sourceRef: boundedString(value.sourceRef, "sourceRef", 1000),
		occurredAt: isoTimestamp(value.occurredAt, "occurredAt"),
		status: oneOf(value.status, ["stale", "blocked"] as const, "status"),
		reason: boundedString(value.reason, "reason", 1000),
		metricIds,
	};
}

/** Apply a founder-authored definition edit without overwriting concurrent agent observations. */
export function updateCompanyArtifact(root: string, id: string, updateValue: unknown): CompanyArtifactRecord {
	const idValue = boundedString(id, "artifact id", 256);
	const update = founderUpdate(updateValue);
	const current = companyArtifactById(root, idValue);
	if (current.updatedAt !== update.expectedUpdatedAt)
		throw new Error("Artifact changed while it was being edited; reload and retry");
	const existingMetrics = new Map(current.metrics.map((entry) => [entry.id, entry]));
	const existingNeeds = new Map(current.dataNeeds.map((entry) => [entry.id, entry]));
	const metrics: CompanyArtifactMetric[] | undefined = update.metrics?.map((definition) => {
		const existing = existingMetrics.get(definition.id);
		const unit = definition.unit === null ? undefined : (definition.unit ?? existing?.unit);
		const target = definition.target === null ? undefined : (definition.target ?? existing?.target);
		return {
			id: definition.id,
			label: definition.label,
			description: definition.description,
			direction: definition.direction,
			...(unit !== undefined ? { unit } : {}),
			...(target !== undefined ? { target } : {}),
			status: existing?.status ?? "unknown",
			...(existing?.statusReason ? { statusReason: existing.statusReason } : {}),
			...(existing?.statusChangedAt ? { statusChangedAt: existing.statusChangedAt } : {}),
			...(existing?.value !== undefined ? { value: existing.value } : {}),
			...(existing?.score !== undefined ? { score: existing.score } : {}),
			evidence: [...(existing?.evidence ?? [])],
			...(existing?.observedAt ? { observedAt: existing.observedAt } : {}),
			...(existing?.sourceRef ? { sourceRef: existing.sourceRef } : {}),
			...(existing?.observations
				? { observations: existing.observations.map((observation) => ({ ...observation })) }
				: {}),
		};
	});
	const dataNeeds: CompanyArtifactDataNeed[] | undefined = update.dataNeeds?.map((definition) => {
		const existing = existingNeeds.get(definition.id);
		return {
			...definition,
			status: existing?.status ?? "missing",
			sourceRefs: [...(existing?.sourceRefs ?? [])],
			sourceAssessments: (existing?.sourceAssessments ?? []).map((assessment) => ({
				...assessment,
				metricIds: [...assessment.metricIds],
				evidence: [...assessment.evidence],
			})),
			...(existing?.connectionRequestId ? { connectionRequestId: existing.connectionRequestId } : {}),
		};
	});
	const hasUnresolvedData = (dataNeeds ?? current.dataNeeds).some(
		(need) => need.status === "missing" || need.status === "selected",
	);
	const next: CompanyArtifact = {
		...artifactDocument(current),
		...(update.title ? { title: update.title } : {}),
		...(update.purpose ? { purpose: update.purpose } : {}),
		...(update.accountableDepartmentId === null
			? { accountableDepartmentId: undefined }
			: update.accountableDepartmentId
				? { accountableDepartmentId: update.accountableDepartmentId }
				: {}),
		...(metrics ? { metrics } : {}),
		...(dataNeeds ? { dataNeeds } : {}),
		...(hasUnresolvedData ? { status: "waiting-for-data" } : {}),
		updatedAt: new Date().toISOString(),
	};
	if (next.accountableDepartmentId === undefined)
		delete (next as { accountableDepartmentId?: string }).accountableDepartmentId;
	return writeArtifactDocument(root, current.relativePath, next);
}

/** Link a kernel-observed connector lifecycle to one owned data need. */
export function transitionCompanyArtifactConnection(
	root: string,
	staffAgentId: string,
	artifactId: string,
	dataNeedId: string,
	connectionRequestId: string,
	transition: CompanyArtifactConnectionTransition,
): CompanyArtifactRecord {
	if (!UUID_PATTERN.test(connectionRequestId)) throw new Error("connection request id is invalid");
	const current = companyArtifactById(root, boundedString(artifactId, "artifact id", 256));
	if (current.stewardAgentId !== staffAgentId) throw new Error("artifact is not owned by this staff member");
	const needId = boundedString(dataNeedId, "data need id", 128);
	let matched = false;
	const dataNeeds = current.dataNeeds.map((need) => {
		if (need.id !== needId) return need;
		matched = true;
		if (transition === "suggested") return { ...need, status: "missing" as const, connectionRequestId };
		if (transition === "selected") return { ...need, status: "selected" as const, connectionRequestId };
		if (transition === "connected") {
			return {
				...need,
				status: "connected" as const,
				connectionRequestId,
				sourceRefs: [...new Set([...need.sourceRefs, `connection-request:${connectionRequestId}`])],
			};
		}
		return {
			...need,
			status: transition === "declined" ? ("declined" as const) : ("missing" as const),
			connectionRequestId,
		};
	});
	if (!matched) throw new Error(`Unknown data need: ${dataNeedId}`);
	const next: CompanyArtifact = {
		...artifactDocument(current),
		status: transition === "connected" ? "validating" : "waiting-for-data",
		dataNeeds,
		updatedAt: new Date().toISOString(),
	};
	return writeArtifactDocument(root, current.relativePath, next);
}

function latestSourceAssessment(
	dataNeeds: readonly CompanyArtifactDataNeed[],
	sourceRef: string,
	metricId: string,
): CompanyArtifactSourceAssessment | undefined {
	let latest: CompanyArtifactSourceAssessment | undefined;
	for (const need of dataNeeds) {
		for (const assessment of need.sourceAssessments) {
			if (assessment.sourceRef !== sourceRef || !assessment.metricIds.includes(metricId)) continue;
			if (!latest || Date.parse(assessment.assessedAt) >= Date.parse(latest.assessedAt)) latest = assessment;
		}
	}
	return latest;
}

function currentMetricSourceRef(metric: CompanyArtifactMetric): string | undefined {
	if (metric.sourceRef) return metric.sourceRef;
	if (!metric.observedAt) return undefined;
	return metric.observations?.find((observation) => observation.at === metric.observedAt)?.sourceRef;
}

function measuredArtifactScore(metrics: readonly CompanyArtifactMetric[]): number | undefined {
	const scores = metrics.flatMap((metric) =>
		metric.status === "measured" && metric.score !== undefined ? [metric.score] : [],
	);
	return scores.length > 0 ? scores.reduce((total, value) => total + value, 0) / scores.length : undefined;
}

function artifactStatus(
	metrics: readonly CompanyArtifactMetric[],
	dataNeeds: readonly CompanyArtifactDataNeed[],
): CompanyArtifactStatus {
	if (dataNeeds.length > 0 && dataNeeds.every((need) => need.status === "available" || need.status === "declined")) {
		return "operating";
	}
	if (metrics.some((metric) => metric.value !== undefined)) return "partial";
	if (dataNeeds.some((need) => need.status === "connected")) return "validating";
	if (dataNeeds.length > 0) return "waiting-for-data";
	return "setting-up";
}

/** Record a bounded, source-and-datatype-specific authority decision. A
 * connector is never authoritative by itself. Non-authoritative decisions
 * retract only values currently attributed to that source. */
export function assessCompanyArtifactSource(
	root: string,
	staffAgentId: string,
	artifactId: string,
	updateValue: unknown,
	assessedBy: CompanyArtifactSourceAssessor,
	now = new Date(),
): CompanyArtifactRecord {
	const update = sourceAssessmentUpdate(updateValue);
	const assessor = oneOf(assessedBy, COMPANY_ARTIFACT_SOURCE_ASSESSORS, "assessedBy");
	const current = companyArtifactById(root, boundedString(artifactId, "artifact id", 256));
	if (current.stewardAgentId !== staffAgentId) throw new Error("artifact is not owned by this staff member");
	const dataNeed = current.dataNeeds.find((need) => need.id === update.dataNeedId);
	if (!dataNeed) throw new Error(`Unknown data need: ${update.dataNeedId}`);
	for (const metricId of update.metricIds) {
		if (!current.metrics.some((metric) => metric.id === metricId)) throw new Error(`Unknown metric: ${metricId}`);
		const existing = latestSourceAssessment([dataNeed], update.sourceRef, metricId);
		if (existing && Date.parse(update.assessedAt) < Date.parse(existing.assessedAt)) {
			throw new Error(`Source assessment is older than the current decision for metric: ${metricId}`);
		}
	}
	const assessment: CompanyArtifactSourceAssessment = {
		...update,
		metricIds: [...update.metricIds],
		evidence: [...update.evidence],
		assessedBy: assessor,
	};
	const supersededMetricIds = new Set(update.metricIds);
	const dataNeeds = current.dataNeeds.map((need) =>
		need.id === update.dataNeedId
			? {
					...need,
					status: need.status === "available" ? ("available" as const) : ("connected" as const),
					sourceRefs: recentUniqueReferences(need.sourceRefs, [update.sourceRef]),
					sourceAssessments: [
						...need.sourceAssessments.flatMap((existing) => {
							if (existing.sourceRef !== update.sourceRef || existing.dataType !== update.dataType) {
								return [existing];
							}
							const remainingMetricIds = existing.metricIds.filter((id) => !supersededMetricIds.has(id));
							return remainingMetricIds.length > 0 ? [{ ...existing, metricIds: remainingMetricIds }] : [];
						}),
						assessment,
					]
						.sort((left, right) => Date.parse(left.assessedAt) - Date.parse(right.assessedAt))
						.slice(-MAX_SOURCE_ASSESSMENTS),
				}
			: need,
	);
	const affectedMetricIds = new Set(update.metricIds);
	const metrics = current.metrics.map((metric): CompanyArtifactMetric => {
		if (
			!affectedMetricIds.has(metric.id) ||
			update.decision === "authoritative" ||
			currentMetricSourceRef(metric) !== update.sourceRef
		) {
			return metric;
		}
		const observations = (metric.observations ?? []).filter((observation) => {
			if (!observation.sourceRef || observation.sourceRef === update.sourceRef) return false;
			return latestSourceAssessment(dataNeeds, observation.sourceRef, metric.id)?.decision === "authoritative";
		});
		const replacement = observations.at(-1);
		if (replacement?.sourceRef) {
			const restored: CompanyArtifactMetric = {
				...metric,
				status: "measured",
				value: replacement.value,
				evidence: recentUniqueReferences([replacement.sourceRef], replacement.evidence ?? []),
				observedAt: replacement.at,
				sourceRef: replacement.sourceRef,
				observations,
			};
			delete (restored as { score?: number }).score;
			delete (restored as { statusReason?: string }).statusReason;
			delete (restored as { statusChangedAt?: string }).statusChangedAt;
			return restored;
		}
		const retracted: CompanyArtifactMetric = {
			...metric,
			status: update.decision === "invalid" ? "blocked" : "unknown",
			statusReason: update.rationale,
			statusChangedAt: update.assessedAt,
			evidence: [],
		};
		delete (retracted as { value?: string | number }).value;
		delete (retracted as { score?: number }).score;
		delete (retracted as { observedAt?: string }).observedAt;
		delete (retracted as { sourceRef?: string }).sourceRef;
		delete (retracted as { observations?: readonly CompanyArtifactMetricObservation[] }).observations;
		return retracted;
	});
	const normalizedDataNeeds = dataNeeds.map((need) => {
		if (need.id !== update.dataNeedId || update.decision === "authoritative") return need;
		const hasAuthoritativeValue = metrics.some((metric) => {
			const sourceRef = currentMetricSourceRef(metric);
			return (
				metric.status === "measured" &&
				sourceRef !== undefined &&
				latestSourceAssessment([need], sourceRef, metric.id)?.decision === "authoritative"
			);
		});
		return { ...need, status: hasAuthoritativeValue ? ("available" as const) : ("connected" as const) };
	});
	const artifactScore = measuredArtifactScore(metrics);
	const next: CompanyArtifact = {
		...artifactDocument(current),
		status: artifactStatus(metrics, normalizedDataNeeds),
		...(artifactScore !== undefined ? { score: artifactScore } : {}),
		metrics,
		dataNeeds: normalizedDataNeeds,
		updatedAt: now.toISOString(),
	};
	if (artifactScore === undefined) delete (next as { score?: number }).score;
	return writeArtifactDocument(root, current.relativePath, next);
}

/** Commit values read from one real source into an agent-owned artifact.
 * Connection setup alone never calls this: the source reference and measured
 * values are the acceptance evidence that moves a data need to available. */
export function recordCompanyArtifactObservation(
	root: string,
	staffAgentId: string,
	artifactId: string,
	updateValue: unknown,
	now = new Date(),
): CompanyArtifactRecord {
	const update = observationUpdate(updateValue);
	const current = companyArtifactById(root, boundedString(artifactId, "artifact id", 256));
	if (current.stewardAgentId !== staffAgentId) throw new Error("artifact is not owned by this staff member");
	const dataNeed = current.dataNeeds.find((need) => need.id === update.dataNeedId);
	if (!dataNeed) throw new Error(`Unknown data need: ${update.dataNeedId}`);
	const observedMetrics = new Map(update.metrics.map((entry) => [entry.id, entry]));
	for (const metricId of observedMetrics.keys()) {
		if (!current.metrics.some((metric) => metric.id === metricId)) throw new Error(`Unknown metric: ${metricId}`);
		const assessment = latestSourceAssessment([dataNeed], update.sourceRef, metricId);
		if (assessment?.decision !== "authoritative") {
			throw new Error(
				assessment
					? `Source is ${assessment.decision}, not authoritative for metric: ${metricId}`
					: `Source has no authority assessment for metric: ${metricId}`,
			);
		}
	}
	const metrics = current.metrics.map((metric) => {
		const observation = observedMetrics.get(metric.id);
		if (!observation) return metric;
		const evidence = recentUniqueReferences(metric.evidence, [update.sourceRef, ...(observation.evidence ?? [])]);
		const history =
			typeof observation.value === "number"
				? [
						...(metric.observations ?? []).filter((entry) => entry.at !== update.observedAt),
						{
							at: update.observedAt,
							value: observation.value,
							sourceRef: update.sourceRef,
							...(observation.evidence ? { evidence: [...observation.evidence] } : {}),
						},
					]
						.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
						.slice(-MAX_METRIC_OBSERVATIONS)
				: metric.observations;
		const isLatest = !metric.observedAt || Date.parse(update.observedAt) >= Date.parse(metric.observedAt);
		const measured: CompanyArtifactMetric = {
			...metric,
			status: "measured" as const,
			...(isLatest ? { value: observation.value } : {}),
			...(isLatest && observation.score !== undefined ? { score: observation.score } : {}),
			evidence,
			...(isLatest ? { observedAt: update.observedAt } : {}),
			...(isLatest ? { sourceRef: update.sourceRef } : {}),
			...(history ? { observations: history } : {}),
		};
		delete (measured as { statusReason?: string }).statusReason;
		delete (measured as { statusChangedAt?: string }).statusChangedAt;
		return measured;
	});
	const dataNeeds = current.dataNeeds.map((need) =>
		need.id === update.dataNeedId
			? {
					...need,
					status: "available" as const,
					sourceRefs: recentUniqueReferences(need.sourceRefs, [update.sourceRef]),
				}
			: need,
	);
	const artifactScore = measuredArtifactScore(metrics);
	const allUsable = dataNeeds.every((need) => need.status === "available" || need.status === "declined");
	const next: CompanyArtifact = {
		...artifactDocument(current),
		status: allUsable ? "operating" : "partial",
		...(artifactScore !== undefined ? { score: artifactScore } : {}),
		metrics,
		dataNeeds,
		updatedAt: now.toISOString(),
	};
	if (artifactScore === undefined) delete (next as { score?: number }).score;
	return writeArtifactDocument(root, current.relativePath, next);
}

/** Preserve the last valid values while recording that their source is no
 * longer current or cannot currently be read. A later real observation clears
 * the issue for the measures it refreshes. */
export function reportCompanyArtifactSourceIssue(
	root: string,
	staffAgentId: string,
	artifactId: string,
	updateValue: unknown,
	now = new Date(),
): CompanyArtifactRecord {
	const update = sourceIssueUpdate(updateValue);
	const current = companyArtifactById(root, boundedString(artifactId, "artifact id", 256));
	if (current.stewardAgentId !== staffAgentId) throw new Error("artifact is not owned by this staff member");
	if (!current.dataNeeds.some((need) => need.id === update.dataNeedId)) {
		throw new Error(`Unknown data need: ${update.dataNeedId}`);
	}
	const affectedMetricIds = new Set(update.metricIds);
	for (const metricId of affectedMetricIds) {
		if (!current.metrics.some((metric) => metric.id === metricId)) throw new Error(`Unknown metric: ${metricId}`);
	}
	const metrics = current.metrics.map(
		(metric): CompanyArtifactMetric =>
			affectedMetricIds.has(metric.id)
				? {
						...metric,
						status: update.status,
						statusReason: update.reason,
						statusChangedAt: update.occurredAt,
						evidence: recentUniqueReferences(metric.evidence, [update.sourceRef]),
					}
				: metric,
	);
	const dataNeeds = current.dataNeeds.map((need) =>
		need.id === update.dataNeedId
			? {
					...need,
					status: "connected" as const,
					sourceRefs: recentUniqueReferences(need.sourceRefs, [update.sourceRef]),
				}
			: need,
	);
	const scoredMetrics = metrics.flatMap((metric) =>
		metric.status === "measured" && metric.score !== undefined ? [metric.score] : [],
	);
	const next: CompanyArtifact = {
		...artifactDocument(current),
		status: metrics.some((metric) => metric.value !== undefined) ? "partial" : "waiting-for-data",
		...(scoredMetrics.length > 0
			? { score: scoredMetrics.reduce((total, value) => total + value, 0) / scoredMetrics.length }
			: {}),
		metrics,
		dataNeeds,
		updatedAt: now.toISOString(),
	};
	if (scoredMetrics.length === 0) delete (next as { score?: number }).score;
	return writeArtifactDocument(root, current.relativePath, next);
}

/** Read every valid, ordinary artifact file. Malformed files are skipped instead of breaking the company shell. */
export function readCompanyArtifacts(root: string): readonly CompanyArtifactRecord[] {
	const directory = agentsRoot(root);
	if (!existsSync(directory)) return Object.freeze([]);
	try {
		assertPhysicalDirectory(directory, "agents directory");
	} catch {
		return Object.freeze([]);
	}
	const records: CompanyArtifactRecord[] = [];
	for (const stewardEntry of readdirSync(directory, { withFileTypes: true })) {
		if (!stewardEntry.isDirectory() || stewardEntry.isSymbolicLink() || !SAFE_SEGMENT.test(stewardEntry.name))
			continue;
		const stewardDirectory = join(directory, stewardEntry.name);
		const artifactDirectory = join(stewardDirectory, "artifacts");
		if (!existsSync(artifactDirectory)) continue;
		try {
			assertPhysicalDirectory(stewardDirectory, "agent directory");
			assertPhysicalDirectory(artifactDirectory, "agent artifacts directory");
		} catch {
			continue;
		}
		for (const artifactEntry of readdirSync(artifactDirectory, { withFileTypes: true })) {
			if (!artifactEntry.isFile() || artifactEntry.isSymbolicLink() || !artifactEntry.name.endsWith(".json"))
				continue;
			try {
				records.push(readArtifactFile(root, join(artifactDirectory, artifactEntry.name), stewardEntry.name));
			} catch {
				// An agent may be midway through editing one ordinary company file. Other artifacts remain available.
			}
		}
	}
	records.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
	return Object.freeze(records);
}

/** Materialize one suggested agent's adaptable starting artifact without overwriting later agent changes. */
export function createStarterCompanyArtifact(
	root: string,
	staffAgentId: string,
	templateId: string,
	definition: StarterArtifactDefinition,
	now = new Date(),
): CompanyArtifactRecord {
	assertSafeSegment(staffAgentId, "staffAgentId");
	assertSafeSegment(templateId, "templateId");
	const rootDirectory = agentsRoot(root);
	if (!existsSync(rootDirectory)) mkdirSync(rootDirectory);
	assertPhysicalDirectory(rootDirectory, "agents directory");
	const agentDirectory = join(rootDirectory, staffAgentId);
	if (!existsSync(agentDirectory)) mkdirSync(agentDirectory);
	assertPhysicalDirectory(agentDirectory, "agent directory");
	const directory = artifactRoot(root, staffAgentId);
	if (!existsSync(directory)) mkdirSync(directory);
	assertPhysicalDirectory(directory, "agent artifacts directory");
	const path = join(directory, `starter-${templateId}.json`);
	if (existsSync(path)) return readArtifactFile(root, path, staffAgentId);
	const timestamp = now.toISOString();
	const artifact: CompanyArtifact = {
		schema: COMPANY_ARTIFACT_SCHEMA,
		id: `${staffAgentId}-${templateId}`,
		title: definition.title,
		purpose: definition.purpose,
		stewardAgentId: staffAgentId,
		status: definition.dataNeeds.length > 0 ? "waiting-for-data" : "setting-up",
		metrics: definition.metrics.map((entry) => ({ ...entry, status: "unknown", evidence: [] })),
		dataNeeds: definition.dataNeeds.map((entry) => ({
			...entry,
			status: "missing",
			sourceRefs: [],
			sourceAssessments: [],
		})),
		starter: { templateId },
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	parseArtifact(artifact, portableRelativePath(root, path));
	writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return readArtifactFile(root, path, staffAgentId);
}
