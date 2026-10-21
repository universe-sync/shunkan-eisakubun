// 画面の固定の文言
export const keyWarning = (names: string[]): string =>
  `APIキーが足りません：${names.join("、")}。Cloudflare のダッシュボード（Workers & Pages → このアプリ → Settings → Variables and Secrets）に Secret として登録してください（手元の wrangler dev では .dev.vars に書きます）。`;

// ログインの文言（ログインの応答 → 画面の表示は lib/login-result.ts）
export const LOGIN = {
  label: "合言葉",
  submit: "入る",
  submitting: "確かめています…",
  wrong: "合言葉が違います。",
  limited: (minutes: number): string => `間違いが続いたため、約${minutes}分は入れません。`,
  network: "通信できませんでした。",
  error: "ログインできませんでした。",
  logout: "ログアウト",
} as const;
