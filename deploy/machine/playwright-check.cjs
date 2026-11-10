// The image build runs this in a login shell from an empty folder: the installed Playwright is found without an
// install, starts its own Chromium headless as root, draws a page with 3D (WebGL) and takes a picture of it.
const { chromium } = require("playwright");
(async () => {
	const browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto("data:text/html,<title>playwright-ok</title><h1>Qorpera machine</h1>");
	const title = await page.title();
	const webgl = await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl")));
	const picture = await page.screenshot();
	await browser.close();
	if (title !== "playwright-ok" || picture.length < 1000) throw new Error(`Playwright page differs: ${title}, ${picture.length} bytes`);
	console.log(`playwright ok: ${chromium.executablePath()}, webgl ${webgl ? "yes" : "no"}, picture ${picture.length} bytes`);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
