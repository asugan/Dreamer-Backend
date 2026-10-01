// Keep this vocabulary aligned with Dreamer/src/lib/themes.ts.
export const THEME_NAMES = ["Calm", "Anxiety", "Belonging", "Familiarity", "Change", "Control", "Connection", "Loss", "Exploration", "Conflict", "Freedom", "Responsibility"] as const;
export type ThemeName = typeof THEME_NAMES[number];
