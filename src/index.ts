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
						console.log(`session persist failed: ${err}`);
					});
				}
			},
		});

		const savedSession = await env.kv.get<AtpSessionData>(`bsky:session:${identifier}`, "json");
		if (savedSession) {
			await bsky.resumeSession(savedSession).then(() => {
				console.log(`session resumed`);
			}, err => {
				console.log(`session resume failed: ${err}`);
			});
		}
		if (!bsky.hasSession) {
			await bsky.login({identifier, password});
		}

		const state = await env.kv.get<State>(`state:${identifier}`, "json") || {};
		let lastTimestamp = state?.lastTimestamp || 0;

		const res = await bsky.getAuthorFeed({actor: identifier});
		try {
			for (const {post} of res.data.feed.reverse()) {
				const postId = post.uri.split("/").reverse()[0];
				const timestamp = Date.parse((post.record as any)?.createdAt || post.indexedAt).valueOf();
				if (timestamp <= lastTimestamp) {
					continue;
				}

				await fetch(env.SLACK_WEBHOOK_URL, {
					method: "post",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({
						blocks: [
							{
								type: "section",
								text: {
									type: "plain_text",
									text: (post.record as any)?.text,
									emoji: true,
								},
								accessory: {
									type: "button",
									text: {
										type: "plain_text",
										text: "Open in bsky.app",
										emoji: true,
									},
									value: post.uri,
									url: `https://bsky.app/profile/${identifier}/post/${postId}`,
									action_id: "button-action",
								},
							},
						],
					}),
				}).then(res => {
					if (!res.ok) {
						throw new Error(`post to slack failed: ${res.status}: ${res.statusText}`);
					}
				});
				lastTimestamp = timestamp;
			}
		} finally {
			if (lastTimestamp > (state?.lastTimestamp || 0)) {
				await env.kv.put(`state:${identifier}`, JSON.stringify({lastTimestamp}));
			}
		}
	},
};
