# OpenRouter Integration

Use Anthropic models (Claude Opus, Sonnet, Haiku) via [OpenRouter](https://openrouter.ai) instead of a direct Anthropic API key. OpenRouter provides a unified API gateway with usage tracking, rate limiting, and billing across multiple providers.

## Setup

### 1. Get an OpenRouter API key

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Go to [openrouter.ai/keys](https://openrouter.ai/keys) and create an API key
3. Add credits to your account

### 2. Configure Nomos

**Option A: Settings UI** (recommended)

1. Open the Settings UI: `nomos settings`
2. Go to **Assistant** → **API Provider**
3. Select **OpenRouter**
4. Enter your OpenRouter API key
5. Click **Save**

**Option B: Environment variables**

```bash
# In .env or your shell profile
NOMOS_API_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
```

**Option C: CLI config**

```bash
nomos config set apiProvider openrouter
# The API key should be set via .env or Settings UI (encrypted storage)
```

### 3. Verify

```bash
nomos chat
```

The agent should respond normally. You can verify traffic on the [OpenRouter Activity Dashboard](https://openrouter.ai/activity).

## How it works

When `apiProvider` is set to `openrouter`, Nomos automatically:

1. Sets `ANTHROPIC_BASE_URL` to `https://openrouter.ai/api/v1`
2. Uses your OpenRouter API key as the Anthropic API key for SDK authentication
3. All SDK calls (including team mode workers) route through OpenRouter

OpenRouter's API is Anthropic-compatible, so no model name changes are needed — `claude-sonnet-4-6`, `claude-opus-4-6`, and `claude-haiku-4-5` all work as-is.

## Model routing

Smart model routing works with OpenRouter. Configure tiers as usual:

```bash
NOMOS_SMART_ROUTING=true
NOMOS_MODEL_SIMPLE=claude-haiku-4-5
NOMOS_MODEL_MODERATE=claude-sonnet-4-6
NOMOS_MODEL_COMPLEX=claude-opus-4-6
```

## Notes

- OpenRouter with Nomos is only guaranteed to work with **Anthropic first-party models** (Claude family). Non-Anthropic models may not be compatible with the Claude Agent SDK.
- Your Anthropic API key is stored separately from the OpenRouter key, so you can switch providers without losing either key.
- Source code prompts are not logged by OpenRouter unless you opt in to prompt logging in your [account settings](https://openrouter.ai/settings/privacy).
