// The explainer kit's caption reader (deploy/first-node/RUNTIME-INTERFACE-APPS.md §3a): run on a company machine, it
// opens an explainer's page as a member's browser would and prints the captions the video speaks, each with the name
// of its voice clip. The engine decides what a caption is (a read of scenes.js can only guess), so the captions are
// taken from the running video. The runtime holds this file's text (cloud-app-kit-explainer-voice.generated.ts,
// written by scripts/generate-app-kits.mjs) and runs it on the machine; change it here, then run that script.
//
//   node voice-captions.cjs /company/apps/<name>/index.html
//
// It prints one line, `QORPERA-VOICE {"captions":[{"text":"…","hash":"3f0a9c1e"}]}`, or with `"problem"` when the
// page says something is wrong with the video (a scenes.js that stops halfway leaves some captions behind: they are
// not the video's) or has no started video.
const { chromium } = require(process.env.QORPERA_PLAYWRIGHT || "playwright");

(async () => {
	const [index] = process.argv.slice(2);
	if (!index || !index.startsWith("/")) throw new Error("give the page's absolute path");
	const browser = await chromium.launch(process.env.QORPERA_VOICE_CHANNEL ? { channel: process.env.QORPERA_VOICE_CHANNEL } : {});
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
		await page.goto(`file://${index}`, { waitUntil: "load", timeout: 30000 });
		const read = await page.evaluate(() => {
			// What the page says is wrong comes first: a video that failed may still hold the captions it got to.
			const failed = document.querySelector(".vp-fail");
			if (failed) return { problem: failed.textContent };
			// The page's video, or the one a scenes.js made for itself.
			const video = typeof V === "undefined" ? null : V;
			if (!video || !Array.isArray(video.segments) || typeof captionHash !== "function")
				return { problem: "The page has no started video." };
			return { captions: video.segments.map((segment) => ({ text: segment.text, hash: captionHash(segment.text) })) };
		});
		console.log(`QORPERA-VOICE ${JSON.stringify(read)}`);
	} finally {
		await browser.close();
	}
})().catch((error) => {
	console.log(`QORPERA-VOICE ${JSON.stringify({ problem: String(error && error.message ? error.message : error).slice(0, 300) })}`);
	process.exit(1);
});
