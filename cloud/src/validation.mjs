import { z } from 'zod';
const textPart = z.object({ type: z.literal('text'), text: z.string().max(200000) }).strict();
const message = z.object({
  role: z.enum(['system','developer','user','assistant','tool','function']),
  content: z.union([z.string().max(200000), z.array(textPart).max(100), z.null()]),
  name: z.string().max(128).optional(), tool_call_id: z.string().max(200).optional(),
  tool_calls: z.array(z.object({ id: z.string().max(200), type: z.literal('function'), function: z.object({ name: z.string().max(128), arguments: z.string().max(200000) }).strict() }).strict()).max(100).optional(),
}).strict();
export const chatSchema = z.object({
  model: z.string().min(1).max(200).default('auto'), messages: z.array(message).min(1).max(200),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().min(1).max(4096).optional(),
  max_completion_tokens: z.number().int().min(1).max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(), top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).optional(),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().max(128), description: z.string().max(2000).optional(), parameters: z.record(z.string(),z.unknown()).optional(), strict: z.boolean().optional() }).strict() }).strict()).max(64).optional(),
  tool_choice: z.union([z.enum(['none','auto','required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string().max(128) }).strict() }).strict()]).optional(),
  parallel_tool_calls: z.boolean().optional(), seed: z.number().int().optional(),
  presence_penalty: z.number().min(-2).max(2).optional(), frequency_penalty: z.number().min(-2).max(2).optional(),
  response_format: z.object({ type: z.enum(['text','json_object','json_schema']), json_schema: z.record(z.string(),z.unknown()).optional() }).strict().optional(),
  reasoning_effort: z.enum(['none','minimal','low','medium','high']).optional(),
  stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
  n: z.literal(1).optional(), user: z.string().max(128).optional(),
}).strict().refine(x => !(x.max_tokens && x.max_completion_tokens), 'Use only one output token limit');
export const providerSchema = z.object({
  platform: z.enum(['groq','cerebras','google','nvidia','mistral','openrouter','huggingface','cohere','cloudflare','zhipu','llmtr']),
  label: z.string().trim().min(1).max(80), key: z.string().trim().min(8).max(4096),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  free_confirmed: z.literal(true), priority: z.number().int().min(1).max(1000).default(100),
  rpm: z.number().int().min(1).max(10000).default(10), rpd: z.number().int().min(1).max(1000000).default(100),
  tpm: z.number().int().min(1).max(10000000).default(10000), tpd: z.number().int().min(1).max(100000000).default(100000),
  concurrency: z.number().int().min(1).max(10).default(1),
}).strict();
export function tokenReservation(body) {
  // Deliberately conservative for text: UTF-8 bytes bound typical tokenizer count.
  // Include tools and per-message overhead; no hidden image-token assumptions.
  return Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools || [] }), 'utf8') + body.messages.length * 32 + (body.max_tokens || body.max_completion_tokens || 1024);
}
export class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', retryAfter) { super(message); this.status = status; this.type = type; this.retryAfter = retryAfter; }
}
export async function readJson(req, limit = 1024 * 1024) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use Content-Type: application/json');
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request exceeds 1 MiB');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Request exceeds 1 MiB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
