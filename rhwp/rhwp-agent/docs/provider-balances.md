# Remote provider balances

The 사용량 cards read account data on the hub; no browser secrets or local token estimates are used for these values. Manual refresh bypasses the cache; automatic reads cache Grok/OpenCode for 60 seconds and OpenRouter for five minutes. Errors retain only previously fetched data for the same credential identity, marked stale/error.

- **OpenRouter:** reuses Pi's stored key. `GET /api/v1/key` returns a key's configured credit allowance; unrestricted keys use `GET /api/v1/credits`. The card distinguishes key allowance from account credits. Missing fields and authorization failures never become a zero balance.
- **Grok:** reads the CLI's local OAuth credential without refreshing or rewriting it, then calls `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`. Shows returned prepaid credits and subscription usage. Expired credentials require login through connection settings. For API billing, optionally set `XAI_MANAGEMENT_API_KEY` and `XAI_TEAM_ID` on the hub; normal inference keys do not grant billing access.
- **OpenCode:** uses the stored OpenCode Go/Zen key (or app-managed `OPENCODE_API_KEY`) to query `GET https://opencode.ai/zen/go/v1/usage`. Shows the returned short-term, weekly, and monthly windows. There is no public API-key endpoint for the Zen wallet; accounts without Go display an unavailable state. Third-party providers configured inside OpenCode do not share a single OpenCode wallet.

No charges, top-ups, or model inference requests are made by these readers. Remote endpoints are fixed and redirects are rejected. Credential files and responses are bounded, requests time out, simultaneous reads coalesce, and identity changes discard in-flight results.

Sources:
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits
- https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs
- https://docs.x.ai/developers/rest-api-reference/management/billing
- https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts
- https://github.com/anomalyco/opencode/issues/44189
