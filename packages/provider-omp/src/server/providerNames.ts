// omp's CLI JSON names providers only by id; these are the ids omp ships logins for.
const OMP_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai": "Azure OpenAI",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  deepseek: "DeepSeek",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  mistral: "Mistral",
  ollama: "Ollama",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  xai: "xAI",
  zai: "Z.ai",
};

/** A heading for an omp provider id; unknown ids, such as custom providers, read as themselves. */
export function ompProviderName(providerId: string): string {
  return OMP_PROVIDER_NAMES[providerId] ?? providerId;
}
