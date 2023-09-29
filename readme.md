bsky-slack-worker
=================

bsky-slack-worker reads bluesky posts and submit them to slack, on Cloudflare workers.

# Usage

- Update `kv_namespaces[0].id` and `vars.BSKY_IDENTIFIER` in wrangler.toml, according to your environment
- `npm i && npx wrangler deploy`
