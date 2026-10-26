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

// お試しモードの文言
export const TRIAL = {
  nameTitle: "名前を入れてください",
  nameLabel: "名前（ニックネーム）",
  nameSubmit: "はじめる",
  nameSubmitting: "登録しています…",
  nameNotes: [
    "1〜20文字。大文字と小文字は区別しません。",
    "名前はこのブラウザの cookie と結び付きます。cookie を消したり別のブラウザで開いたりすると、同じ名前では入れません（別の名前で入り直すと、記録は最初からになります）。",
    "ほかの人が使っている名前は使えません。",
  ],
  network: "通信できませんでした。",
  error: "登録できませんでした。",
  changeName: "名前を変える",
  changeNameConfirm: (name: string): string => `名前を変えると、今の名前（${name}）の記録には戻れません（${name}は使用中のまま残ります）。新しい名前では最初からになります。変えますか？`,
  resetNote: "（今日のお試しの問題数と読み上げの回数は戻りません）",
  settingsFixed: "お試しでは1回10問です（今日の残りが10問より少ないときは残りの数）。",
  countLabel: "1回 10問",
  todayAnswers: (used: number, limit: number): string => `${used} / ${limit}`,
  adminTitle: "お試しの参加者（管理用）",
  adminLabel: "管理用の合言葉",
  adminSubmit: "一覧を見る",
  adminReload: "読み込み直す",
  adminLoading: "確かめています…",
  adminNetwork: "通信できませんでした。",
  adminError: "一覧を読み込めませんでした。",
  adminEmpty: "まだ参加者はいません。",
} as const;
