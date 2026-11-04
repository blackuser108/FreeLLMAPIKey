// Real transports reused from the original FreeLLMAPI source, including Gemini
// conversion, SSE parsing, tool repairs, sampling policy and Retry-After parsing.
import { OpenAICompatProvider } from '../../server/src/providers/openai-compat.ts';
import { GoogleProvider } from '../../server/src/providers/google.ts';
import { CohereProvider } from '../../server/src/providers/cohere.ts';
import { CloudflareProvider } from '../../server/src/providers/cloudflare.ts';
import { ZhipuProvider } from '../../server/src/providers/zhipu.ts';
import { LlmtrProvider } from '../../server/src/providers/llmtr.ts';
import { installLogRedaction } from '../../server/src/lib/log-redaction.ts';
installLogRedaction();

const definitions = {
  groq: ['Groq', 'https://api.groq.com/openai/v1'],
  cerebras: ['Cerebras', 'https://api.cerebras.ai/v1'],
  nvidia: ['NVIDIA NIM', 'https://integrate.api.nvidia.com/v1'],
  mistral: ['Mistral', 'https://api.mistral.ai/v1'],
  openrouter: ['OpenRouter', 'https://openrouter.ai/api/v1'],
  huggingface: ['Hugging Face', 'https://router.huggingface.co/v1'],
};
export function providerFor(platform) {
  if (platform === 'google') return new GoogleProvider();
  if (platform === 'cohere') return new CohereProvider();
  if (platform === 'cloudflare') return new CloudflareProvider();
  if (platform === 'zhipu') return new ZhipuProvider();
  if (platform === 'llmtr') return new LlmtrProvider();
  const entry = definitions[platform];
  if (!entry) throw new Error('Unsupported provider');
  return new OpenAICompatProvider({ platform, name: entry[0], baseUrl: entry[1], timeoutMs: 60000, forceSingleToolCall: platform === 'nvidia' });
}
export { OpenAICompatProvider };
export { catalogFor, discoverCloudModels } from './discovery.mjs';
