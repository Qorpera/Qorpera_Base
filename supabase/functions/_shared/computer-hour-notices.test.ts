import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildComputerHourEmail,
	ComputerHourEmailSendError,
	type ComputerHourNoticeJob,
	computerHourNoticeIdempotencyKey,
	deliverComputerHourNoticeBatch,
	hoursText,
	parseComputerHourNoticeClaim,
} from "./computer-hour-notices.ts";

const NOTICE = "71300000-0000-4000-8000-0000000000b1";
/** The readable notices of a claim; a claim that is not a list throws. */
const jobsOf = (value: unknown): ComputerHourNoticeJob[] => {
	const claim = parseComputerHourNoticeClaim(value);
	if (claim.rejected.length) throw new Error(claim.rejected[0]!.message);
	return claim.jobs;
};
const LEASE = "71300000-0000-4000-8000-0000000000a1";
const APP = "https://app.qorpera.com/";

const wire = (kind: string, details: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
	noticeId: NOTICE,
	kind,
	recipientEmail: "Founder@Example.test",
	details,
	attemptCount: 1,
	leaseId: LEASE,
	...overrides,
});
const low = { companyName: "Nordlys ApS", leftSeconds: 3500, month: "2026-10", hoursSeconds: 18000 };
const summary = {
	periodStart: "2026-09-10T00:00:00Z",
	periodEnd: "2026-10-10T00:00:00Z",
	grantedSeconds: 286 * 3600,
	companies: [
		{ companyName: "Nordlys ApS", seconds: 36_000 },
		{ companyName: "Havn", seconds: 1_800 },
	],
};

describe("computer hour notices", () => {
	it("reads the claimed notices and refuses anything else", () => {
		const [job] = jobsOf([wire("running_low", low)]);
		assert.deepEqual(job, {
			noticeId: NOTICE,
			recipientEmail: "founder@example.test",
			attemptCount: 1,
			leaseId: LEASE,
			kind: "running_low",
			details: { companyName: "Nordlys ApS", leftSeconds: 3500 },
		});
		assert.equal(jobsOf([wire("out_of_hours", { companyName: "Havn", leftSeconds: -600 })])[0]?.kind,
			"out_of_hours");
		assert.equal(jobsOf([wire("monthly_summary", summary)])[0]?.kind, "monthly_summary");
		assert.throws(() => jobsOf([wire("gift", low)]), /kind/);
		assert.throws(() => jobsOf([wire("running_low", low, { recipientEmail: "nobody" })]), /email/);
		assert.throws(() => jobsOf([wire("running_low", { companyName: "", leftSeconds: 1 })]), /company/);
		assert.throws(() => jobsOf([wire("monthly_summary", { ...summary, companies: [] })]), /companies/);
		// Without a readable lease it cannot even be failed: left to its lease and the attempt limit.
		assert.deepEqual(parseComputerHourNoticeClaim([wire("running_low", low, { leaseId: "x" })]), { jobs: [], rejected: [] });
		assert.throws(() => jobsOf({}), /list/);
	});

	it("sets aside a notice it cannot read, so the rest of the batch still goes", () => {
		const longName = `${"😀".repeat(60)}${"x".repeat(60)}`;
		const claim = parseComputerHourNoticeClaim([
			wire("running_low", { ...low, companyName: longName }),
			wire("gift", low, { noticeId: "71300000-0000-4000-8000-0000000000b2" }),
			wire("running_low", low, { noticeId: "not-an-id" }),
			wire("out_of_hours", { companyName: "Havn", leftSeconds: -60 }, { noticeId: "71300000-0000-4000-8000-0000000000b4" }),
		]);
		// 120 characters in the database can be more UTF-16 units in JavaScript.
		assert.deepEqual(
			claim.jobs.map((job) => job.noticeId),
			[NOTICE, "71300000-0000-4000-8000-0000000000b4"],
		);
		assert.deepEqual(claim.rejected, [
			{ noticeId: "71300000-0000-4000-8000-0000000000b2", leaseId: LEASE, message: "Invalid notice kind" },
		]);
		assert.throws(() => parseComputerHourNoticeClaim({}), /list/);
	});

	it("writes each email in plain words, with the company's name escaped and a link to Plan & usage", () => {
		const [running] = jobsOf([wire("running_low", { ...low, companyName: "<Nordlys> & Co" })]);
		const email = buildComputerHourEmail(running!, APP);
		assert.equal(email.subject, "<Nordlys> & Co is running low on computer hours");
		assert.match(email.text, /has 1 hour of computer time left/);
		assert.match(email.text, /Plan & usage: https:\/\/app\.qorpera\.com\/#\/account/);
		assert.ok(email.html.includes("&lt;Nordlys&gt; &amp; Co"));
		assert.ok(!email.html.includes("<Nordlys>"));
		const [out] = jobsOf([wire("out_of_hours", { companyName: "Havn", leftSeconds: -600 })]);
		assert.equal(buildComputerHourEmail(out!, APP).subject, "Havn is out of computer hours");
		const [month] = jobsOf([wire("monthly_summary", summary)]);
		const monthly = buildComputerHourEmail(month!, APP);
		assert.equal(monthly.subject, "Your plan used 10.5 hours of 286 hours");
		assert.match(monthly.text, /from 10 September 2026 to 10 October 2026/);
		assert.match(monthly.text, /- Nordlys ApS: 10 hours\n- Havn: 0.5 hours/);
		assert.throws(() => buildComputerHourEmail(running!, "http://app.qorpera.com/"), /HTTPS/);
		assert.equal(hoursText(3600), "1 hour");
		assert.equal(hoursText(60), "less than 0.1 hours");
		assert.equal(hoursText(0), "0 hours");
		assert.match(email.text, /as a founder of <Nordlys> & Co\./);
		assert.match(monthly.text, /because your plan paid for these companies' computer hours/);
		assert.equal(hoursText(-600), "0 hours");
		assert.equal(computerHourNoticeIdempotencyKey(NOTICE), `qorpera-computer-hour-notice/${NOTICE}`);
	});

	it("sends each notice once, records failures for retry or for good, and leaves a lost completion leased", async () => {
		const jobs = jobsOf([
			wire("running_low", low, { noticeId: "71300000-0000-4000-8000-0000000000b1" }),
			wire("running_low", low, { noticeId: "71300000-0000-4000-8000-0000000000b2" }),
			wire("running_low", low, { noticeId: "71300000-0000-4000-8000-0000000000b3" }),
			wire("running_low", low, { noticeId: "71300000-0000-4000-8000-0000000000b4" }),
		]);
		const keys: string[] = [];
		const done: string[] = [];
		const failed: [string, string, boolean][] = [];
		const result = await deliverComputerHourNoticeBatch(
			jobs,
			APP,
			{
				async send(job: ComputerHourNoticeJob, _email, key) {
					keys.push(key);
					if (job.noticeId.endsWith("b2")) throw new ComputerHourEmailSendError("Resend 503", true);
					if (job.noticeId.endsWith("b3")) throw new ComputerHourEmailSendError("Invalid recipient", false);
					return { messageId: `re_${job.noticeId.slice(-2)}` };
				},
			},
			{
				async complete(job, messageId) {
					if (job.noticeId.endsWith("b4")) throw new Error("database away");
					done.push(`${job.noticeId.slice(-2)}:${messageId}`);
				},
				async fail(job, message, retryable) {
					failed.push([job.noticeId.slice(-2), message, retryable]);
				},
			},
		);
		assert.deepEqual(result, { claimed: 4, delivered: 1, retrying: 1, failed: 1, completionPending: 1 });
		assert.deepEqual(done, ["b1:re_b1"]);
		assert.deepEqual(failed, [
			["b2", "Resend 503", true],
			["b3", "Invalid recipient", false],
		]);
		assert.equal(keys[0], "qorpera-computer-hour-notice/71300000-0000-4000-8000-0000000000b1");
	});
});
