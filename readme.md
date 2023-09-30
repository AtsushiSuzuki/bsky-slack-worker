bsky-slack-worker
=================

bsky-slack-worker reads bluesky posts and submit them to slack, on Cloudflare workers.

# Requirements
- Node.js
- git
- your Bluesky, Slack and Cloudflare account

# Usage
- Clone this repository
  `git clone https://github.com/AtsushiSuzuki/bsky-slack-worker.git && cd bsky-slack-worker`
- `npm i`
- Put your Bluesky password ([App password](https://bsky.app/settings/app-passwords) is recommended) to Cloudflare worker secrets
  `npx wrangler secret put BSKY_PASSWORD`
- [Create Slack Incoming Webhook](https://api.slack.com/messaging/webhooks) and put to Cloudflare worker secrets
  `npx wrangler secret put SLACK_WEBHOOK_URL`
- Update `kv_namespaces[0].id` and `vars.BSKY_IDENTIFIER` in wrangler.toml, according to your environment
- `npx wrangler deploy`
