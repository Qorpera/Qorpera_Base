import {
	CLOUD_VOICE_NAMES,
	type CloudVoiceCall,
	CloudVoiceChannel,
	CloudVoiceUnavailable,
	cloudVoiceOpenInput,
	cloudVoiceUsage,
	cloudVoiceUsageFull,
	isCloudVoiceName,
} from "@qorpera/runtime/cloud-voice-channel";
import { describe, expect, it, vi } from "vitest";

const OFFER = "v=0\r\nPRIVATE_OFFER_SDP\r\n";

describe("CloudVoiceChannel", () => {
	it("refuses a call while no run's lane is attached, and after it is detached", async () => {
		const channel = new CloudVoiceChannel();
		const signal = new AbortController().signal;
		await expect(channel.open({ offerSdp: OFFER }, signal)).rejects.toBeInstanceOf(CloudVoiceUnavailable);
		const call: CloudVoiceCall = {
			answerSdp: "v=0\r\nANSWER\r\n",
			speak: async () => ({ transcript: "" }),
			close: async () => undefined,
		};
		const lane = vi.fn(async () => call);
		channel.attach(lane);
		await expect(channel.open({ offerSdp: OFFER, voice: "cove" }, signal)).resolves.toBe(call);
		expect(lane).toHaveBeenCalledWith({ offerSdp: OFFER, voice: "cove" }, signal);
		channel.attach(undefined);
		await expect(channel.open({ offerSdp: OFFER }, signal)).rejects.toBeInstanceOf(CloudVoiceUnavailable);
		expect(lane).toHaveBeenCalledOnce();
		expect(channel.stopMs).toBeUndefined();
		expect(new CloudVoiceChannel({ stopMs: 200 }).stopMs).toBe(200);
	});
});

describe("cloudVoiceOpenInput", () => {
	it("takes an offer and, optionally, one of the allowed voices", () => {
		expect(cloudVoiceOpenInput({ offerSdp: OFFER })).toEqual({ offerSdp: OFFER });
		for (const voice of CLOUD_VOICE_NAMES)
			expect(cloudVoiceOpenInput({ offerSdp: OFFER, voice })).toEqual({ offerSdp: OFFER, voice });
		expect(CLOUD_VOICE_NAMES).toEqual([
			"juniper",
			"maple",
			"spruce",
			"ember",
			"vale",
			"breeze",
			"arbor",
			"sol",
			"cove",
		]);
	});

	it("refuses an unknown voice, and an offer that is empty or too large, without repeating either", () => {
		expect(() => cloudVoiceOpenInput({ offerSdp: OFFER, voice: "PRIVATE_VOICE" })).toThrow(/^Invalid voice name$/);
		expect(isCloudVoiceName("Cove")).toBe(false);
		expect(() => cloudVoiceOpenInput({ offerSdp: " \r\n" })).toThrow(/^Invalid voice offer$/);
		expect(() => cloudVoiceOpenInput({ offerSdp: "x".repeat(64 * 1024 + 1) })).toThrow(/^Invalid voice offer$/);
		expect(() => cloudVoiceOpenInput({ offerSdp: 7 as never })).toThrow(/^Invalid voice offer$/);
	});
});

describe("cloudVoiceUsage", () => {
	const reset = Date.parse("2026-11-24T13:22:00Z") / 1000;

	it("reads each window's use and reset, and never makes a missing reading full or empty", () => {
		expect(
			cloudVoiceUsage({
				ordinaryUsageAllowed: true,
				accountId: "PRIVATE_ACCOUNT",
				rateLimits: {
					planType: "prolite",
					primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: null },
					secondary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: reset },
				},
			}),
		).toEqual({
			allowed: true,
			windows: [
				{ usedPercent: 41, windowMinutes: 300 },
				{ usedPercent: 99, resetAt: "2026-11-24T13:22:00.000Z", windowMinutes: 10080 },
			],
		});
		expect(cloudVoiceUsage({ rateLimits: { primary: null, secondary: null } })).toBeUndefined();
		expect(cloudVoiceUsage({ rateLimits: { primary: { usedPercent: "100" } } })).toBeUndefined();
		expect(cloudVoiceUsage({})).toBeUndefined();
		expect(cloudVoiceUsage(null)).toBeUndefined();
		expect(cloudVoiceUsage({ rateLimits: { primary: { usedPercent: 140 } } })).toEqual({
			windows: [{ usedPercent: 100 }],
		});
	});

	it("says a login is at its limit when a window is full or ordinary use is not allowed, with the reset when known", () => {
		expect(cloudVoiceUsageFull(undefined)).toBeUndefined();
		expect(cloudVoiceUsageFull({ windows: [{ usedPercent: 99 }] })).toBeUndefined();
		expect(cloudVoiceUsageFull({ allowed: true, windows: [] })).toBeUndefined();
		expect(cloudVoiceUsageFull({ allowed: false, windows: [{ usedPercent: 12 }] })).toEqual({});
		expect(
			cloudVoiceUsageFull({
				windows: [
					{ usedPercent: 100, resetAt: "2026-11-18T19:00:00.000Z" },
					{ usedPercent: 100, resetAt: "2026-11-24T13:22:00.000Z" },
					{ usedPercent: 3, resetAt: "2026-12-01T00:00:00.000Z" },
				],
			}),
		).toEqual({ resetAt: "2026-11-24T13:22:00.000Z" });
		expect(
			cloudVoiceUsageFull({
				windows: [{ usedPercent: 100, resetAt: "2026-11-24T13:22:00.000Z" }, { usedPercent: 100 }],
			}),
		).toEqual({});
	});

	it("reads through the lane's reader only while a lane is attached", async () => {
		const channel = new CloudVoiceChannel();
		const signal = new AbortController().signal;
		const usage = { windows: [{ usedPercent: 84 }] };
		const reader = vi.fn(async () => usage);
		const lane = vi.fn(async () => {
			throw new Error("unused");
		});
		await expect(channel.usage(signal)).resolves.toBeUndefined();
		channel.attach(lane, reader);
		await expect(channel.usage(signal)).resolves.toBe(usage);
		channel.attach(undefined, reader);
		await expect(channel.usage(signal)).resolves.toBeUndefined();
		expect(reader).toHaveBeenCalledOnce();
	});
});
