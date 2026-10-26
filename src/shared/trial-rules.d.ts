export const NAME_MAX_CHARS: 20;
export const TRIAL_SESSION_SIZE: 10;
export const NAME_RULE_MESSAGE: string;
export const NAME_TAKEN_MESSAGE: string;
export function normalizeDisplayName(input: unknown): string | null;
export function nameKey(display: string): string;
export function isNameKey(value: unknown): value is string;
