import { z } from 'zod';
export const CONSENT_VERSION = '2026-10-01';
const short = (max: number) => z.string().trim().min(1).max(max);
const date = z.iso.date();
const historyEntry = z.object({
  id: short(100), date, summary: short(800), themes: z.array(short(80)).max(3),
}).strict();
export const interpretationInput = z.object({
  requestId: z.uuid(),
  dream: z.object({
    id: short(100), text: short(8000), date,
    mood: z.enum(['Peaceful', 'Curious', 'Anxious', 'Sad', 'Confused']).optional(),
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
const theme = z.object({ name: short(80), detail: short(600), icon: z.enum(['moon', 'eye', 'water', 'house', 'threads', 'sparkle']) }).strict();
export const interpretationResult = z.object({
  title: short(120), summary: short(800), themes: z.array(theme).max(3),
  meaning: short(2400), question: short(400), connectionId: short(100).nullable(),
  safety: z.enum(['reflection', 'support']),
}).strict();
export const weeklyResult = z.object({
  title: short(120), summary: short(2400), question: short(400),
  sourceIds: z.array(short(100)).min(3).max(20),
}).strict();
export type InterpretationInput = z.infer<typeof interpretationInput>;
export type WeeklyInput = z.infer<typeof weeklyInput>;
export type Kind = 'interpretation' | 'weekly';
export function validateResult(kind: Kind, raw: unknown, input: InterpretationInput | WeeklyInput) {
  if (kind === 'interpretation') {
    const result = interpretationResult.parse(raw);
    const data = input as InterpretationInput;
    if (result.connectionId !== null && !data.history.some(e => e.id === result.connectionId)) throw new Error('Unknown history reference');
    return { ...result, sourceText: data.dream.text };
  }
  const result = weeklyResult.parse(raw);
  const ids = (input as WeeklyInput).entries.map(e => e.id);
  if (new Set(result.sourceIds).size !== result.sourceIds.length || result.sourceIds.length !== ids.length || result.sourceIds.some(id => !ids.includes(id))) throw new Error('Unknown or missing summary source');
  return result;
}
