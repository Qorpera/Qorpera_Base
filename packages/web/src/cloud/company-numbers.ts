import {
	type CloudMemberDataAnswer,
	CloudMemberDataError,
	type CloudMemberDataQuestion,
	parseCloudMemberDataAnswer,
} from "@qorpera/cloud-client/cloud-member-data";
import { type Cloud, CloudRpcError } from "./client.ts";

/* The platform's own numbers of a company (company views step 3, migration 20260930767000, supabase/CLIENT-CONTRACT.md
 * "The company's numbers"): the questions of the reserved database `qorpera`, such as `qorpera/money-now`, asked with
 * the member's own token as a plain PostgREST call, so they work where the build names no member gateway too. The
 * answer has the data gateway's shape and is parsed as strictly as the gateway's; a refusal keeps the cloud's own
 * words (which are written for a page), as a refusal of the gateway does. */

/** One question's answer, as the member. */
export async function askCompanyNumbers(
	cloud: Cloud,
	environmentId: string,
	asked: CloudMemberDataQuestion,
): Promise<CloudMemberDataAnswer> {
	let value: unknown;
	try {
		value = await cloud.rpc("qorpera_member_company_numbers", {
			p_environment_id: environmentId,
			p_question: asked.question,
			p_params: asked.params,
		});
	} catch (error) {
		if (!(error instanceof CloudRpcError)) throw error;
		if (error.missing)
			throw new CloudMemberDataError("The company's numbers can't be asked on this cloud yet", error.status ?? null);
		const words = error.message.trim();
		throw new CloudMemberDataError(
			words.length > 0 && words.length <= 1000 && !/[\0-\x08\x0b-\x1f\x7f]/.test(words)
				? words
				: "The company's numbers refused the question",
			error.status ?? null,
		);
	}
	return parseCloudMemberDataAnswer(value);
}
