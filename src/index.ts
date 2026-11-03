import { Agent, CredentialSession, AtpSessionData, AppBskyRichtextFacet } from "@atproto/api";

/**
 * Welcome to Cloudflare Workers!
 *
 * This is a template for a Scheduled Worker: a Worker that can run on a
 * configurable interval:
 * https://developers.cloudflare.com/workers/platform/triggers/cron-triggers/
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	BSKY_IDENTIFIER: string;
	BSKY_PASSWORD: string;
	SLACK_WEBHOOK_URL: string;
	kv: KVNamespace;
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
	//
	// Example binding to a D1 Database. Learn more at https://developers.cloudflare.com/workers/platform/bindings/#d1-database-bindings
	// DB: D1Database
}

interface State {
	lastTimestamp?: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface LinkSpan {
	byteStart: number;
	byteEnd: number;
	uri: string;
}

interface LinkCard {
	uri: string;
	title?: string;
	description?: string;
	image?: string;
}

function asEmbedView(embed: any, viewType: string): any {
	return embed?.$type === viewType ? embed : undefined;
}

// Matches URLs possibly without scheme, except when preceded directly by word characters, @ (mentions) or / (paths).
const unfacetedUrlPattern = /(?<![\w@/])(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;
// Trailing punctuation to be excluded from link texts.
const trailingJunkPattern = /[.,;:!?"'…)\]》」』〉。、]+$/;

function truncate(text: string, maxLength: number, suffix = "..."): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

function shortenUrl(uri: string): string {
	// bsky-style abbreviation: `https://example.com/activities/1234` => `example.com/activities/1...`
	return truncate(uri.replace(/^https?:\/\//, "").replace(/\/+$/, ""), 40);
}

function escapeMrkdwn(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nonEmpty(text: string | undefined): string | undefined {
	return text?.trim() || undefined;
}

function collectLinkSpans(record: any): LinkSpan[] {
	const spans: LinkSpan[] = [];
	for (const facet of record.facets ?? []) {
		const start = facet?.index?.byteStart;
		const end = facet?.index?.byteEnd;
		if (typeof start !== "number" || typeof end !== "number" || end <= start) {
			continue;
		}
		const feature = (facet.features ?? []).find(AppBskyRichtextFacet.isLink);
		if (feature) {
			spans.push({byteStart: start, byteEnd: end, uri: feature.uri});
		}
	}
	return spans.sort((a, b) => a.byteStart - b.byteStart);
}

function linkifyText(text: string, spans: LinkSpan[]): {mrkdwn: string; links: string[]} {
	// Facet indices are UTF-8 byte offsets, so the text is processed by bytes.
	const encoded = textEncoder.encode(text);
	const parts: string[] = [];
	const links: string[] = [];
	const known = new Set<string>();
	const emitLink = (uri: string) => {
		if (!known.has(uri)) {
			known.add(uri);
			links.push(uri);
		}
		parts.push(`<${uri}|${escapeMrkdwn(shortenUrl(uri))}>`);
	};
	const emitText = (plain: string) => {
		let cursor = 0;
		for (const match of plain.matchAll(unfacetedUrlPattern)) {
			const raw = match[0];
			if (/\.\.\.$|…$/.test(raw)) {
				// A manually copied, already abbreviated URL; keep it as plain text instead of making a broken link.
				parts.push(escapeMrkdwn(plain.slice(cursor, match.index + raw.length)));
				cursor = match.index + raw.length;
				continue;
			}
			const uri = raw.replace(trailingJunkPattern, "");
			if (uri.length === 0) {
				continue;
			}
			parts.push(escapeMrkdwn(plain.slice(cursor, match.index)));
			emitLink(/^(https?:\/\/)/i.test(uri) ? uri : `https://${uri}`);
			cursor = match.index + uri.length;
		}
		parts.push(escapeMrkdwn(plain.slice(cursor)));
	};
	let cursor = 0;
	for (const {byteStart, byteEnd, uri} of spans) {
		if (byteStart < cursor || byteEnd > encoded.length) {
			continue;
		}
		emitText(textDecoder.decode(encoded.subarray(cursor, byteStart)));
		if (/\.\.\.$|…$/.test(uri)) {
			// The link target itself is abbreviated; keep the original text as-is.
			parts.push(escapeMrkdwn(textDecoder.decode(encoded.subarray(byteStart, byteEnd))));
		} else {
			emitLink(uri);
		}
		cursor = byteEnd;
	}
	emitText(textDecoder.decode(encoded.subarray(cursor)));
	return {mrkdwn: parts.join(""), links};
}

function absoluteUrl(candidate: string | undefined, base: string): string | undefined {
	if (!candidate) {
		return undefined;
	}
	try {
		const url = new URL(candidate, base);
		if (url.protocol === "http:") {
			url.protocol = "https:";
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

async function fetchOpenGraph(uri: string): Promise<Partial<LinkCard>> {
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), 6000);
	try {
		const res = await fetch(uri, {
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; bsky-slack-worker)",
				accept: "text/html,application/xhtml+xml,*/*;q=0.1",
			},
			signal: abort.signal,
		});
		if (!res.ok) {
			return {};
		}
		if (!/html/i.test(res.headers.get("content-type") ?? "")) {
			return {};
		}
		const og: Record<string, string> = {};
		await new HTMLRewriter().on("meta", {
			element: element => {
				const key = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
				const content = element.getAttribute("content");
				if (content && (key.startsWith("og:") || key.startsWith("twitter:"))) {
					og[key] ??= content;
				}
			},
		}).transform(res).text();
		return {
			title: nonEmpty(og["og:title"]),
			description: nonEmpty(og["og:description"]),
			image: absoluteUrl(og["og:image:secure_url"] ?? og["og:image"] ?? og["twitter:image"] ?? og["twitter:image:src"], uri),
		};
	} catch (err) {
		console.log(`open graph fetch failed: ${uri}: `, err);
		return {};
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchLinkCard(uri: string, embedExternal: any): Promise<LinkCard | undefined> {
	// The bsky external embed carries the OpenGraph data, including the bsky CDN thumbnail.
	const card: LinkCard = {
		uri,
		title: nonEmpty(embedExternal?.title),
		description: nonEmpty(embedExternal?.description),
		image: embedExternal?.thumb,
	};
	if (!card.title || !card.image) {
		const og = await fetchOpenGraph(uri);
		card.title ??= og.title;
		card.description ??= og.description;
		card.image ??= og.image;
	}
	if (card.title || card.description || card.image) {
		return card;
	}
	return undefined;
}

function addLinkCardBlocks(blocks: any[], card: LinkCard): void {
	if (card.title || card.description) {
		let text = "";
		if (card.title) {
			text += `<${card.uri}|*${escapeMrkdwn(card.title)}*>`;
		}
		if (card.description) {
			text += `\n${escapeMrkdwn(truncate(card.description.replace(/\s+/g, " ").trim(), 180, "…"))}`;
		}
		blocks.push({type: "section", text: {type: "mrkdwn", text}});
	}
	if (card.image) {
		blocks.push({type: "image", image_url: card.image, alt_text: card.title ?? card.uri});
	}
	let host: string | undefined;
	try {
		host = new URL(card.uri).host;
	} catch {}
	blocks.push({type: "context", elements: [{type: "plain_text", text: host ?? card.uri}]});
}

async function postToSlack(webhookUrl: string, blocks: any[]): Promise<void> {
	const submit = (payloadBlocks: any[]) =>
		fetch(webhookUrl, {
			method: "post",
			headers: {"Content-Type": "application/json"},
			// Disable the Slack automatic link previews. This worker provides its own preview cards.
			body: JSON.stringify({blocks: payloadBlocks, unfurl_links: false, unfurl_media: false}),
		});
	let res = await submit(blocks);
	if (!res.ok && blocks.some(block => block.type === "image")) {
		// The image URLs may be inaccessible for Slack; retry without image blocks.
		res = await submit(blocks.filter(block => block.type !== "image"));
	}
	if (!res.ok) {
		console.log(`submit to slack failed: ${res.status}: ${res.statusText}\n${await res.text()}`);
		throw new Error(`submit to slack failed: ${res.status}: ${res.statusText}`);
	}
}

export default {
	// The scheduled handler is invoked at the interval set in our wrangler.toml's
	// [[triggers]] configuration.
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const identifier = env.BSKY_IDENTIFIER;
		const password = env.BSKY_PASSWORD;
		const session = new CredentialSession(
			new URL("https://bsky.social"),
			undefined,
			(evt, sessionData) => {
				if ((evt == "create" || evt == "update") && sessionData) {
					env.kv.put(`bsky:session:${identifier}`, JSON.stringify(sessionData)).then(() => {
						console.log(`session persisted`);
					}, err => {
						console.log(`session persist failed: `, err);
					});
				}
			},
		);
		const bsky = new Agent(session);

		const savedSession = await env.kv.get<AtpSessionData>(`bsky:session:${identifier}`, "json");
		if (savedSession) {
			await session.resumeSession(savedSession).then(() => {
				console.log(`session resumed`);
			}, err => {
				console.log(`session resume failed: `, err);
			});
		}
		if (!session.hasSession) {
			await session.login({identifier, password});
			console.log(`session logged in`);
		}

		const state = await env.kv.get<State>(`state:${identifier}`, "json") ?? {};
		let lastTimestamp = state.lastTimestamp ?? 0;

		const res = await bsky.getAuthorFeed({actor: identifier});
		try {
			for (const {post} of res.data.feed.toReversed()) {
				const record = post.record as any;
				const postId = post.uri.split("/").at(-1);
				const timestamp = Date.parse(record.createdAt ?? post.indexedAt).valueOf();
				if (timestamp <= lastTimestamp) {
					continue;
				}

				const blocks = [];
				const contextElements: any[] = [];
				if (post.author.avatar) {
					contextElements.push({
						type: "image",
						image_url: post.author.avatar,
						alt_text: `${post.author.displayName ?? post.author.handle}'s avatar`,
					});
				}
				contextElements.push({
					type: "plain_text",
					text: post.author.displayName ?? post.author.handle,
				});
				blocks.push({
					type: "context",
					elements: contextElements,
				})
				const embed: any = post.embed ?? {};
				const embedMedia: any = embed.$type === "app.bsky.embed.recordWithMedia#view" ? embed.media : embed;
				const imagesEmbed = asEmbedView(embedMedia, "app.bsky.embed.images#view");
				const externalEmbed = asEmbedView(embedMedia, "app.bsky.embed.external#view");
				const message = linkifyText(record.text ?? "", collectLinkSpans(record));
				if (message.mrkdwn) {
					blocks.push({
						type: "section",
						text: {
							type: "mrkdwn",
							text: message.mrkdwn,
						}
					});
				}
				if (imagesEmbed) {
					for (const image of imagesEmbed.images) {
						blocks.push({
							type: "image",
							image_url: image.thumb,
							alt_text: image.alt || "",
						});
					}
				}
				const cardUri = externalEmbed?.external?.uri ?? message.links[0];
				if (cardUri) {
					const card = await fetchLinkCard(cardUri, externalEmbed?.external);
					if (card) {
						addLinkCardBlocks(blocks, card);
					}
				}
				blocks.push({
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: "Open in bsky.app",
							},
							value: post.uri,
							url: `https://bsky.app/profile/${identifier}/post/${postId}`,
							action_id: "button-action",
						},
					],
				});

				console.log("post: ", post);
				console.log("blocks: ", blocks);

				await postToSlack(env.SLACK_WEBHOOK_URL, blocks);
				console.log(`post submitted: ${post.uri}`);
				lastTimestamp = timestamp;
			}
		} finally {
			if (lastTimestamp > (state.lastTimestamp ?? 0)) {
				await env.kv.put(`state:${identifier}`, JSON.stringify({lastTimestamp}));
			}
		}
	},
};
