import {
	type CompanyKnowledgeCollection,
	type CompanyKnowledgeRetentionPolicy,
	CompanyKnowledgeSession,
	type CompanyMemoryIndex,
	CompanyMemoryService,
	type CompanySkillContext,
	CompanySkillService,
	type PlatformSkillBundle,
} from "@qorpera/company";
import { type CloudCompanyPathGateway, parseCloudCompanyPath } from "./cloud-company-path-gateway.ts";

/**
 * Cloud host integration point. Uses the same admitted gateway, canonical
 * collection/source fence, path parser and durable run events as native work.
 * This factory registers no tools and does not compose context or grant access.
 * The context owner must call the services' assertContext/assertCatalog hooks
 * before reuse, replay and compaction, and allocate the actual delivery budget.
 */
export function createCloudCompanyKnowledge(options: {
	gateway: CloudCompanyPathGateway;
	runtimeBundleVersion: string;
	/** Exact human-registered path resources. Each operation verifies these in SQL. */
	collections: readonly CompanyKnowledgeCollection[];
	retentionPolicy?: CompanyKnowledgeRetentionPolicy;
	readConcurrency?: number;
	index?: CompanyMemoryIndex;
	platform?: PlatformSkillBundle;
	fitsSkillContext: (context: Readonly<CompanySkillContext>) => boolean;
}) {
	const gateway = options.gateway;
	const identity = gateway.identity;
	const session = new CompanyKnowledgeSession({
		run: {
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			runId: identity.runId,
			runtimeBundleVersion: options.runtimeBundleVersion,
		},
		gateway,
		parsePath: parseCloudCompanyPath,
		collections: options.collections,
		retentionPolicy: options.retentionPolicy,
		readConcurrency: options.readConcurrency,
	});
	return Object.freeze({
		session,
		memory: new CompanyMemoryService(session, options.index),
		skills: new CompanySkillService({
			session,
			platform: options.platform,
			fitsContext: options.fitsSkillContext,
			recordLoad: (record, signal) => gateway.recordSkillLoad(record, signal),
			assertRecordedLoad: (record, signal) => gateway.assertRecordedSkillLoad(record, signal),
		}),
	});
}
