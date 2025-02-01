import { Hono } from 'hono';
import puppeteer from "@cloudflare/puppeteer";

type Bindings = {
	BROWSER: Fetcher;
	KV: KVNamespace;
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

app.get('/oembed/:url{.+}', async (c) => {
	const url = c.req.param('url');
	const oembed = await getOembed(url);

	if (oembed) {
		return c.json(oembed);
	} else {
		return c.json({ error: 'No oEmbed available.' }, 400);
	}
});

app.get('/png/:url{.+}', async (c) => {
	const url = c.req.param('url'); //TODO: Validate URL

	// Check our KV cache to see if we already have a result for this file
	const cacheKey = `png-${btoa(url)}`;
	const cache = c.env.KV;
	const cachedResult = await cache.get(cacheKey, {type: 'arrayBuffer'});
	if (cachedResult) {
		c.header('Content-Type', 'image/png');
		// TODO: Ideally we'd get this cache ttl from the KV metadata
		c.header('Cache-Control', 'public, max-age=14400');
		c.header('X-Debug-Cache-Control', 'public, max-age=14400');
		return c.body(cachedResult);
	}

	// Get oEmbed data
	const oembed = await getOembed(url);

	switch (oembed?.type) {
		case 'rich':
			const browser = await puppeteer.launch(c.env.BROWSER);
			const page = await browser.newPage();
			await page.setViewport({width: 600, height: 600});
			await page.setBypassCSP(true);
			await page.setContent(oembed.html);
			await page.waitForNetworkIdle({
				idleTime: 1000
			});
			await new Promise(r=>setTimeout(r, 1000));
			//return c.body(await page.content());

			const target = (await page.$('body div')) || page;

			const img = await target.screenshot({
				// If we were able to find a selector, no need to apply fullPage.
				// Otherwise, capture as much as possible.
				fullPage: target === page,
				captureBeyondViewport: true
			});
			const ttl = oembed['cache_age']??14400;
			const cfTtl = (ttl/1000)>60 ? (ttl/1000) : 60; // Minimum TTL of a KV key is 60 seconds

			// Cache the result in KV
			await cache.put(cacheKey, img, {expirationTtl: cfTtl});

			c.header('Content-Type', 'image/png');
			c.header('Cache-Control', `public, max-age=${ttl}`);
			c.header('X-Debug-Cache-Control', `public, max-age=${ttl}`);
			return c.body(img);
			break;

		case 'photo':
			if (oembed.url) return c.redirect(oembed.url);
			return c.json({ error: 'Invalid oEmbed - no url provided for type photo' }, 400);
			break;

		case 'video':
		case 'link':
		default:
			// TODO: Fallback to generating an opengraph image if possible?
			return c.json({ error: 'No oEmbed available.' }, 400);
	}
});

export default app satisfies ExportedHandler<Env>;
