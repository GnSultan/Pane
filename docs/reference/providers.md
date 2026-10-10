# Model providers

Pane supports multiple model providers. You can mix and match — different threads can use different models from different providers.

## Supported providers

| Provider | Models | Key prefix | Sign up |
|---|---|---|---|
| **Anthropic** | Claude (Opus, Sonnet, Haiku) | `sk-ant-...` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Google Gemini** | Gemini (Pro, Flash, Ultra) | `AI...` | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **OpenRouter** | 200+ models from all providers | `sk-or-...` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **DeepSeek** | DeepSeek Chat, Coder, Reasoner | `sk-...` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **Xiaomi MiMo** | MiMo models | `sk-...` | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/) |
| **Kimi (Moonshot)** | Kimi models | `sk-...` | [platform.moonshot.cn](https://platform.moonshot.cn/) |
| **Z.ai (GLM)** | GLM models | `sk-...` | [z.ai](https://z.ai/manage-apikey/apikey-list) |

## Search & embeddings

| Provider | Purpose | Key prefix | Sign up |
|---|---|---|---|
| **Tavily** | Web search | `tvly-...` | [tavily.com](https://tavily.com/#api) |
| **Jina AI** | Embeddings | `jina_...` | [jina.ai](https://jina.ai/embeddings/) |

## Power combo

Pane supports a two-model setup: a thinking model plans and verifies, an execution model builds. Configure this in **Profile → Power Combo**.

For example: Claude Opus plans, Claude Haiku builds. Or Gemini Flash plans, DeepSeek builds. Any pair works.

## Bring your own keys

All API keys are stored locally in `~/.pane/settings.json`. Pane never proxies your requests through a third-party service — calls go directly from your machine to the provider's API. The exception is if you use Pane Cloud for sync/backup, which is a separate, optional service.
