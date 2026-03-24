# Ollama Integration

Run local models with [Ollama](https://ollama.com) by using a [LiteLLM](https://github.com/BerriAI/litellm) proxy to translate between Ollama's API and the Anthropic API format that the Claude Agent SDK expects.

> **Note:** Ollama models are not Claude models. The Claude Agent SDK is optimized for Anthropic models and may produce degraded results with other model families. Tool use, thinking, and multi-turn behavior may not work as expected.

## Prerequisites

- [Ollama](https://ollama.com) installed and running
- [LiteLLM](https://github.com/BerriAI/litellm) installed (`pip install litellm`)
- A model pulled in Ollama (e.g., `ollama pull llama3`)

## Setup

### 1. Start Ollama

```bash
ollama serve
```

### 2. Start LiteLLM as an Anthropic-compatible proxy

```bash
litellm --model ollama/llama3 --port 4000
```

This starts a proxy on `http://localhost:4000` that accepts Anthropic API requests and forwards them to Ollama.

For multiple models, create a `litellm_config.yaml`:

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: ollama/llama3
      api_base: http://localhost:11434
  - model_name: claude-haiku-4-5
    litellm_params:
      model: ollama/phi3
      api_base: http://localhost:11434
```

Then start LiteLLM with the config:

```bash
litellm --config litellm_config.yaml --port 4000
```

### 3. Configure Nomos

**Option A: Settings UI** (recommended)

1. Open the Settings UI: `nomos settings`
2. Go to **Assistant** → **API Provider**
3. Select **Ollama**
4. Enter the LiteLLM proxy URL (e.g., `http://localhost:4000`)
5. Click **Save**

**Option B: Environment variables**

```bash
# In .env
NOMOS_API_PROVIDER=ollama
ANTHROPIC_BASE_URL=http://localhost:4000
```

### 4. Verify

```bash
nomos chat
```

## Model selection

Set the model name to whatever your LiteLLM proxy expects. If you mapped model names in the LiteLLM config (as shown above), you can use the standard Claude model names:

```bash
NOMOS_MODEL=claude-sonnet-4-6
```

If using the simple `--model` flag, the model name is passed directly to LiteLLM:

```bash
NOMOS_MODEL=ollama/llama3
```

## Limitations

- **No thinking/reasoning blocks** — most local models don't support extended thinking
- **Tool use may be unreliable** — the Claude Agent SDK's tool calling protocol is optimized for Claude
- **No streaming guarantees** — some models may not support SSE streaming correctly through the proxy
- **No embeddings** — the memory system still uses Vertex AI for embeddings (requires Google Cloud credentials)

## Troubleshooting

**"Connection refused" errors:**
Make sure both Ollama (`ollama serve`) and LiteLLM (`litellm --model ... --port 4000`) are running.

**Model not found:**
Verify the model is pulled: `ollama list`. Pull if needed: `ollama pull llama3`.

**Garbled or broken tool responses:**
This is expected with non-Claude models. The SDK's tool protocol is Claude-specific. Try simpler prompts that don't require tool use.
