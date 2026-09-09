import type { CompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";

export interface ComputerViewer {
	close(): Promise<void>;
}
export interface ComputerViewerOptions {
	binding: CompanyComputerScreenBinding;
	title: string;
	canControl: boolean;
	privateSignIn?: boolean;
	requestConnection(input: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "control";
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView>;
	releaseConnection(input: { connectionId: string }): Promise<void>;
	onClosed(): void;
}

/** The bundled renderer receives an authenticated channel, never a ticket URL. */
export function openComputerViewer(options: ComputerViewerOptions): ComputerViewer {
	const renderer = (
		window as unknown as { qorperaScreenViewer?: { open(options: ComputerViewerOptions): ComputerViewer } }
	).qorperaScreenViewer;
	if (!renderer) throw new Error("Screen viewing is unavailable.");
	return renderer.open(options);
}
