// 画面から API を呼ぶ小さな道具。更新系（GET・HEAD 以外）には X-App: 1 の印を付ける（段2の Worker が確かめる）
export class RequestError extends Error {
  status: number; reason?: string; transcript?: string; providerReason?: string;
  constructor(message: string, status: number, reason?: string, transcript?: string, providerReason?: string) {
    super(message); this.name = "RequestError"; this.status = status; this.reason = reason; this.transcript = transcript; this.providerReason = providerReason;
  }
}

export const UNAUTHORIZED_MESSAGE = "ログインの期限が切れました。ページを再読み込みして、合言葉を入れ直してください。";

export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") headers.set("X-App", "1");
  return fetch(url, { ...init, headers });
}

export async function request<T>(url: string, body?: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const response = await apiFetch(url, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 401) throw new RequestError(UNAUTHORIZED_MESSAGE, 401, "unauthorized");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(data.error || "処理に失敗しました。", response.status, typeof data.reason === "string" ? data.reason : undefined, typeof data.transcript === "string" && data.transcript ? data.transcript : undefined, typeof data.providerReason === "string" ? data.providerReason : undefined);
  return data;
}
