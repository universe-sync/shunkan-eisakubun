// 画面の固定の文言
export const keyWarning = (names: string[]): string =>
  `APIキーが足りません：${names.join("、")}。Cloudflare のダッシュボード（Workers & Pages → このアプリ → Settings → Variables and Secrets）に Secret として登録してください（手元の wrangler dev では .dev.vars に書きます）。`;

// ログインの文言（ログインの応答 → 画面の表示は lib/login-result.ts）
// 「記録をリセット」を押したときの確かめ（1人用・お試しとも）。お試しでは今日の数が戻らないことも添える
export const resetConfirm = (trial: boolean): string =>
  `瞬間英作文の記録をすべてリセットします。回答の履歴・クリアした問題・平均点が消え、元に戻せません。${trial ? "今日のお試しの問題数と読み上げの回数は戻りません。" : ""}リセットしますか？`;

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
    "登録すると6桁の「引き継ぎ番号」が出ます。スマホと PC など別の端末でも使うときは、名前とこの番号を入れると同じ記録で続けられます。",
    "ほかの人が使っている名前は使えません。",
  ],
  codeLabel: "引き継ぎ番号（6桁）",
  codeHint: "初めての名前なら、番号の欄は空のままで進めてください。",
  // ボタンでは2行に分けて出す（括弧は2行目）
  codeToggle: "登録済みの名前で入る",
  codeToggleSub: "（引き継ぎ番号を入れる）",
  codeBadNumber: "引き継ぎ番号は6桁の数字です。",
  registered: (name: string): string => `${name}さんで登録しました`,
  codeHeading: "引き継ぎ番号",
  registeredNote: "スマホや PC など別の端末でも使うときは、合言葉のあと、この名前と番号を入れます。番号はあとで右上の「引き継ぎ番号を見る」でも見られます。",
  registeredStart: "はじめる",
  network: "通信できませんでした。",
  error: "登録できませんでした。",
  showCode: "引き継ぎ番号を見る",
  codeDialogTitle: "引き継ぎ番号",
  codeOf: (name: string): string => `${name}さんの引き継ぎ番号`,
  codeLoading: "読み込んでいます…",
  codeLoadError: "番号を読み込めませんでした。閉じてもう一度開いてください。",
  // 番号の画面の説明（2026-10-28 オーナーの文。2段落目の「ただし、」はオーナーの指示で外した）
  codeUse: "このアプリは複数の端末で利用可能です。ただし、新しい端末では合言葉を入れた後、同じ名前とここに示されている引き継ぎ番号を入力する必要があります。",
  codeNoSimul: "複数の端末で同時に回答することはできません。",
  leaveDevice: "この端末から抜ける",
  leaveConfirm: "この端末から抜けます。記録は残り、名前と引き継ぎ番号でまた入れます。抜けますか？",
  close: "閉じる",
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
  adminCode: "引き継ぎ番号",
  adminEmpty: "まだ参加者はいません。",
} as const;
