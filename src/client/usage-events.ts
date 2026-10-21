// Gemini・Claude を呼んだ後に利用料の帯を読み直してもらうための合図
export const USAGE_CHANGED_EVENT = "app:usage-changed";
export function notifyUsageChanged(): void { window.dispatchEvent(new Event(USAGE_CHANGED_EVENT)); }
