/**
 * Claude (Anthropic API) for small helper tasks: fill a product from a photo or a description,
 * and read a spreadsheet with any column names. The key lives only in the ANTHROPIC_API_KEY
 * environment variable; without it these features are simply off. Each business has a daily cap.
 */
import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { Db } from '../db/client.js';
import { aiUsage } from '../db/schema.js';
import { AppError } from './errors.js';

export const AI_MODEL = 'claude-haiku-5-5';
/** Calls per business per day, per feature: plenty for a person, a ceiling for a runaway script. */
export const AI_DAILY_LIMIT: Record<AiFeature, number> = { product: 150, import: 30 };
export type AiFeature = 'product' | 'import';

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let aiFetch: typeof fetch = (...a) => fetch(...a);
/** Tests swap the network call. */
export const setAiFetch = (fn: typeof fetch | null) => {
  aiFetch = fn ?? ((...a) => fetch(...a));
};

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const today = () => DateTime.now().setZone('America/Mexico_City').toISODate()!;

/** Counts the call before making it; refuses once the business hits the day's cap. */
async function takeQuota(db: Db, tenantId: string, feature: AiFeature) {
  const res = await db.execute<{ calls: number }>(sql`
    insert into ai_usage (tenant_id, day, feature, calls) values (${tenantId}, ${today()}, ${feature}, 1)
    on conflict (tenant_id, day, feature) do update set calls = ai_usage.calls + 1
    returning calls`);
  if (Number(res.rows[0]?.calls ?? 0) > AI_DAILY_LIMIT[feature]) throw new AppError(429, 'ai_limit', 'Daily AI limit reached');
}

async function addTokens(db: Db, tenantId: string, feature: AiFeature, input: number, output: number) {
  await db
    .update(aiUsage)
    .set({ inputTokens: sql`${aiUsage.inputTokens} + ${input}`, outputTokens: sql`${aiUsage.outputTokens} + ${output}` })
    .where(sql`${aiUsage.tenantId} = ${tenantId} and ${aiUsage.day} = ${today()} and ${aiUsage.feature} = ${feature}`);
}

/** The first JSON object in the model's answer. */
export function firstJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AppError(502, 'ai_bad_answer', 'The AI answer could not be read');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AppError(502, 'ai_bad_answer', 'The AI answer could not be read');
  }
}

/** One question to Claude that must come back as a JSON object. */
export async function askJson(db: Db, tenantId: string, feature: AiFeature, o: { system: string; content: Block[]; maxTokens?: number }): Promise<unknown> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new AppError(422, 'ai_off', 'AI is not configured');
  await takeQuota(db, tenantId, feature);
  let r: Response;
  try {
    r = await aiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: o.maxTokens ?? 800, system: o.system, messages: [{ role: 'user', content: o.content }] }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new AppError(502, 'ai_unavailable', 'The AI service did not answer');
  }
  if (!r.ok) {
    // Never echo the provider's body (it may describe the account); the status is enough
    console.error(`[ai] ${feature}: HTTP ${r.status}`);
    throw new AppError(502, 'ai_unavailable', 'The AI service did not answer');
  }
  const j = (await r.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await addTokens(db, tenantId, feature, j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0).catch(() => {});
  const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return firstJson(text);
}
