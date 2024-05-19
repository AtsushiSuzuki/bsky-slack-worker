import { BskyAgent, AtpSessionData } from "@atproto/api";

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

export default {
	// The scheduled handler is invoked at the interval set in our wrangler.toml's
	// [[triggers]] configuration.
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const identifier = env.BSKY_IDENTIFIER;
		const password = env.BSKY_PASSWORD;
		const bsky = new BskyAgent({
			service: "https://bsky.social",
			persistSession(evt, session) {
				if ((evt == "create" || evt == "update") && session) {
					env.kv.put(`bsky:session:${identifier}`, JSON.stringify(session)).then(() => {
						console.log(`session persisted`);
					}, err => {
						console.log(`session persist failed: `, err);
					});
				}
			},
		});

		const savedSession = await env.kv.get<AtpSessionData>(`bsky:session:${identifier}`, "json");
		if (savedSession) {
			await bsky.resumeSession(savedSession).then(() => {
				console.log(`session resumed`);
			}, err => {
				console.log(`session resume failed: `, err);
			});
		}
		if (!bsky.hasSession) {
			await bsky.login({identifier, password});
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
				if (record.text) {
					blocks.push({
						type: "section",
						text: {
							type: "plain_text",
							text: record.text,
							emoji: true,
						}
					});
				}
				if (post.embed && post.embed.$type === "app.bsky.images#view") {
					const images = post.embed.images as any[];
					for (const image of images) {
						blocks.push({
							type: "image",
							image_url: image.thumb,
							alt_text: image.alt || "",
						});
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

				await fetch(env.SLACK_WEBHOOK_URL, {
					method: "post",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({blocks}),
				}).then(async res => {
					if (!res.ok) {
						console.log(`submit to slack failed: ${res.status}: ${res.statusText}\n${await res.text()}`);
						throw new Error(`submit to slack failed: ${res.status}: ${res.statusText}`);
					}
					console.log(`post submitted: ${post.uri}`);
				});
				lastTimestamp = timestamp;
			}
		} finally {
			if (lastTimestamp > (state.lastTimestamp ?? 0)) {
				await env.kv.put(`state:${identifier}`, JSON.stringify({lastTimestamp}));
			}
		}
	},
};
