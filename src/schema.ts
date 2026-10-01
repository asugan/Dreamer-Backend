import { z } from 'zod';
import { THEME_NAMES } from './themes.ts';
export const CONSENT_VERSION = '2026-10-01-evidence-v1';
const short = (max: number) => z.string().trim().min(1).max(max);
const date = z.iso.date();
const mood = z.enum(['Peaceful', 'Curious', 'Anxious', 'Sad', 'Confused']);
const historyEntry = z.object({
  id: short(100), date, summary: short(800), themes: z.array(z.enum(THEME_NAMES)).max(3),
  themeDetails: z.array(short(200)).max(3), mood: mood.optional(),
  context: z.string().max(300),
}).strict();
export const interpretationInput = z.object({
  requestId: z.uuid(),
  dream: z.object({
    id: short(100), text: short(8000), date,
    mood: mood.optional(),
    context: z.string().trim().max(1000).default(''),
  }).strict(),
  history: z.array(historyEntry).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  const ids = value.history.map(e => e.id);
  if (new Set(ids).size !== ids.length || ids.includes(value.dream.id)) ctx.addIssue({ code: 'custom', message: 'History IDs must be unique and exclude current dream' });
});
export const weeklyInput = z.object({
  requestId: z.uuid(), entries: z.array(historyEntry).min(3).max(20),
}).strict().superRefine((value, ctx) => {
  const dates = value.entries.map(e => Date.parse(e.date));
  if (new Set(value.entries.map(e => e.id)).size !== value.entries.length || Math.max(...dates) - Math.min(...dates) >= 7 * 86400000)
    ctx.addIssue({ code: 'custom', message: 'Use unique interpreted entries within seven days' });
});
const theme = z.object({ name: z.enum(THEME_NAMES), detail: short(600), icon: z.enum(['moon', 'eye', 'water', 'house', 'threads', 'sparkle']) }).strict();
const connection = z.object({
  currentEvidence: z.string().trim().min(8).max(300), pastEvidence: z.string().trim().min(8).max(300), sharedDetail: short(600),
  difference: short(600).nullable(),
}).strict();
export const interpretationResult = z.object({
  title: short(120), summary: short(800), themes: z.array(theme).max(3).refine(items => new Set(items.map(t => t.name)).size === items.length),
  meaning: short(2400), question: short(400), connectionId: short(100).nullable(),
  safety: z.enum(['reflection', 'support']), connection: connection.nullable(),
}).strict();
const insight = z.object({
  kind: z.enum(['repeat', 'difference']), theme: z.enum(THEME_NAMES).nullable(), detail: short(800),
  evidence: z.array(z.object({ entryId: short(100), quote: short(300) }).strict()).min(2).max(5),
}).strict();
export const weeklyResult = z.object({
  title: short(120), summary: short(2400), question: short(400),
  sourceIds: z.array(short(100)).min(3).max(20),
  insights: z.array(insight).max(3),
}).strict();
export type InterpretationInput = z.infer<typeof interpretationInput>;
export type WeeklyInput = z.infer<typeof weeklyInput>;
export type Kind = 'interpretation' | 'weekly';
export function validateResult(kind: Kind, raw: unknown, input: InterpretationInput | WeeklyInput) {
  if (kind === 'interpretation') {
    const result = interpretationResult.parse(raw);
    const data = input as InterpretationInput;
    if (result.connectionId !== null && !data.history.some(e => e.id === result.connectionId)) throw new Error('Unknown history reference');
    const past = data.history.find(e => e.id === result.connectionId);
    if ((result.connectionId === null) !== (result.connection === null)) throw new Error('Connection needs evidence');
    if (result.safety === 'support' && (result.connectionId || result.themes.length)) throw new Error('Unsafe support structure');
    if (result.connection && (!past ||
        ![data.dream.text, data.dream.context].some(text => text.includes(result.connection!.currentEvidence)) ||
        !historyEvidence(past).some(text => text.includes(result.connection!.pastEvidence)))) {
      // An unverified optional link must not discard the otherwise valid reflection.
      result.connectionId = null;
      result.connection = null;
    }
    return { ...result, sourceText: data.dream.text, sourceContext: data.dream.context,
      sourceMood: data.dream.mood ?? null, sourceDate: data.dream.date };
  }
  const result = weeklyResult.parse(raw);
  const ids = (input as WeeklyInput).entries.map(e => e.id);
  if (new Set(result.sourceIds).size !== result.sourceIds.length || result.sourceIds.length !== ids.length || result.sourceIds.some(id => !ids.includes(id))) throw new Error('Unknown or missing summary source');
  const entries = (input as WeeklyInput).entries;
  for (const item of result.insights) {
    const evidenceIds = item.evidence.map(e => e.entryId);
    if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('Duplicate insight sources');
    const sources = item.evidence.map(e => {
      const source = entries.find(entry => entry.id === e.entryId);
      if (!source || !historyEvidence(source).some(text => text.includes(e.quote))) throw new Error('Unsupported weekly evidence');
      return source;
    });
    if (item.kind === 'repeat' && (!item.theme || !sources.every(e => e.themes.includes(item.theme!)))) throw new Error('Unsupported recurring theme');
    if (item.kind === 'difference' && item.theme !== null) throw new Error('Difference must not assert a recurring theme');
  }
  return result;
}
function historyEvidence(e: z.infer<typeof historyEntry>) {
  return [e.summary, e.context, ...e.themeDetails, ...(e.mood ? [e.mood] : [])];
}
