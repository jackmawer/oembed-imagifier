import { Hono } from 'hono';
import puppeteer from "@cloudflare/puppeteer";

type Bindings = {
	BROWSER: Fetcher;
};

class OEmbedLinkHandler {
	oembedUrl: string | null;

	constructor() {
	  	this.oembedUrl = null
	}

	element(element) {
	  	const rel = element.getAttribute('rel')
	  	const type = element.getAttribute('type')

	  	if (rel === 'alternate' && type === 'application/json+oembed') {
			this.oembedUrl = element.getAttribute('href')
	  	}
	}
  }

async function getOembed(url: string): Promise<object | null> {
	const res = await fetch(url);
	const handler = new OEmbedLinkHandler();

	// Create a new HTMLRewriter and apply the handler to all <link> elements
	const rewriter = new HTMLRewriter()
		.on('link', handler)
		.transform(res);

	// Consume the response to trigger the HTMLRewriter
	const body = await rewriter.text();

	if (handler.oembedUrl) {
		const oembedReq = await fetch(handler.oembedUrl);
		const oembedData = await oembedReq.json();
		return oembedData;
	}

	return null;
}

const app = new Hono<{Bindings: Bindings}>();

app.get('/', (c) => c.json({ message: 'Hello, World!' }));

app.get('/png/:url{.+}', async (c) => {
	// Get oEmbed data
	const url = c.req.param('url');
	const oembed = await getOembed(url);

	if (oembed?.type === 'rich') {
		const browser = await puppeteer.launch(c.env.BROWSER);
		const page = await browser.newPage();
		await page.setViewport({width: 600, height: 600});
		await page.setBypassCSP(true);
		await page.goto(`data:text/html,${oembed.html}`);
		await page.waitForNetworkIdle({
			idleTime: 1000
		});
		await new Promise(r=>setTimeout(r, 1000));
		let img = await page.screenshot({
			fullPage: true,
			captureBeyondViewport: true
		});

		c.header('Content-Type', 'image/png');
		return c.body(img);
	} else {
		return c.json({ error: 'No oEmbed available.' }, 400);
	}
});

export default app satisfies ExportedHandler<Env>;
