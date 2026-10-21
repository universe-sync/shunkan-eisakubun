// パスの読み方を 1 か所に置く。門・isApiPath・Hono の道筋が同じパスを見るために、
// Worker の Hono と DO の Hono の両方の getPath にこれを渡す。
// Hono 標準の getPath は生の URL の文字列を使い、%2e は . に戻すが .. を取り除かない。
// new URL() は .. や %2e%2e を正規化するので、それと食い違うと門を抜けられてしまう。
export function requestPath(req: Request): string {
  return new URL(req.url).pathname;
}
