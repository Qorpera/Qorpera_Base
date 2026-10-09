import type { HostedArtifactIndex, HostedCompanySnapshot, HostedCompanySubstrateVersion } from "../hosted-primary.ts";

export interface ResolvedCompanySubstrateReference {
	version: HostedCompanySubstrateVersion;
	snapshot: HostedCompanySnapshot;
	artifactIndex?: HostedArtifactIndex;
}
