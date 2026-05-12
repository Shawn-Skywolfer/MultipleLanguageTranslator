# Provider configuration reference

Use OpenAI-compatible Chat Completions providers. Requests are sent to:

```text
POST {base_url}/chat/completions
```

## Known provider defaults

| Provider | Base URL | Default model | Notes |
| --- | --- | --- | --- |
| AIHubMix | `https://aihubmix.com/v1` | `gpt-5.4` | Existing project default. Refresh `/models` where available. |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` | Use Bearer auth and Chat Completions-compatible request bodies. |
| Kimi Code | `https://api.kimi.com/coding/v1` | `kimi-for-coding` | If a user provides `https://api.kimi.com/coding`, append `/v1` before adding `/chat/completions`. |

## Troubleshooting

- `401` or `403`: check API key, account permissions, model access, and whether the key was copied with quotes or a `Bearer` prefix.
- `404`: check Base URL and model ID. For Kimi Code, ensure the Base URL includes `/v1`.
- `unsupported parameter`: retry without `temperature`; retry by switching between `max_tokens` and `max_completion_tokens`.
- `Failed to fetch` or CORS in a browser app: the Provider may not allow direct browser calls. Use a server-side proxy or run the CLI from a trusted local/server environment.
- Network proxy failures are environment issues; do not treat them as provider incompatibility without testing from a normal network.

## Secret handling

Never commit API keys. Prefer environment variables:

```bash
export BIGMODEL_API_KEY='...'
export KIMI_API_KEY='...'
```

Then pass `--api-key-env BIGMODEL_API_KEY` or `--api-key-env KIMI_API_KEY` to the CLI.
