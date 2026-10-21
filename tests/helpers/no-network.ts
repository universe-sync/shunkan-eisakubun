// global の fetch を、呼ばれたら例外を投げるものに差し替える。外へ取りに行くテストを作らないための見張り。
// node --test はファイルごとに別のプロセスなので、各テストファイルの最初で呼ぶ。
export function forbidNetwork(): void {
  globalThis.fetch = (() => {
    throw new Error("テストが外へ取りに行こうとしました");
  }) as typeof fetch;
}
