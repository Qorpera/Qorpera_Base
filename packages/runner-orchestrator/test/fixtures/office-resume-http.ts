import { officeVmOperationHttpFixture } from "./office-vm-operation-http.ts";
/** Synthetic VM reboot behind actual Unix HTTP and provider journals. */
export function officeResumeHttpFixture(root: string, boot: () => void) {
	const fixture = officeVmOperationHttpFixture(root, "start", "acacacac-acac-4cac-8cac-acacacacacac", boot);
	return { handle: fixture.handle, counts: () => ({ starts: fixture.counts().posts, polls: fixture.counts().polls }) };
}
