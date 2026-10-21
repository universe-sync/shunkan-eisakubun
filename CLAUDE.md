# speak25

毎日25分、日本語の問題文を見て声に出して英語にする練習アプリ。Cloudflare Workers（Hono）＋ Durable Object（SQLite）で動く。
このファイルは、このリポジトリで開発する人（や AI）向けの決まり。使い方・始め方は README.md。

## コマンド
- `npm test` ・ `npm run typecheck` ・ `npm run bench:audio`（録音1回分の CPU 時間の目安。外へは通信しない）
- `npm run dev`（画面を作り直してから `wrangler dev`。ずっと動き続ける）・`npm run build`（`wrangler deploy --dry-run` を含むが、アップロードはしない）
- `npm run deploy` は画面を作ってから本物の Cloudflare に上げる。流す前に、`wrangler.jsonc` の名前と登録済みの Secret を確かめる

## ポート
- `wrangler dev` は 8820（inspector は 9820）。`wrangler.jsonc` の `dev` で決めている

## 守ること
- パスは `src/server/path.ts` の `requestPath` の1か所で取る。**Hono は必ず `new Hono({ getPath: requestPath })`**（Worker の Hono も DO の Hono も）。門と道筋が同じパスを見るため
- ストアの関数（`src/server/instant/store.ts` ほか）は**同期**。check と write の間に `await` を挟まない（DO は同期のコードの途中に割り込まない）。例外は answer の「checkAnswerable → 外部 API → record（条件を確かめ直す）」の3段だけ
- API の処理は全部 DO の中。Worker は「守り・門・転送」だけ（Worker の CPU は1リクエスト10ms、DO は30秒）
- ASSETS・DO の応答は `new Response(r.body, r)` で写してから返す（ヘッダーを変えられない Response を返すと例外になる）
- テストから読む `src/server` のファイルは、標準の Web API と Hono・Anthropic SDK だけを使う。`cloudflare:workers` や `Fetcher`・`DurableObjectNamespace` の型は `worker.ts`・`env.ts`・`practice-do.ts`・`store/do-db.ts` だけ
- `src/server` は `src/client` を import しない。両方が読むのは `src/shared` だけ
- 外向きの fetch は許可リスト（`ai/outbound.ts`：Gemini・Anthropic だけ）で包む
- ログに本文・書き起こし・cookie・キーを出さない（Claude と Gemini のエラーは状態と code だけ）
- **`.dev.vars`・`.env*` を読まない・写さない。** 値は各自が `.dev.vars`（git に入れない）か Cloudflare の Secret に入れる
- 公開するリポジトリなので、個人のパス・メールアドレス・アカウントや請求の情報・キーをファイルに書かない（`tests/publish.test.ts` が確かめる。手元だけの禁止語は git に入れない `tests/publish-forbidden.local.json` に書く）
- 表示名（仮）は `src/shared/app-info.js` と `index.html` の `<title>` の2か所。一致は `tests/config.test.ts` が確かめる

## 門と守り
- 合言葉だけでログインする（ユーザー名は無い）。`GATE_PASSWORD`（前後の空白を除いて16字以上）が無い・短いと門は閉じたまま（POST /login と /api と更新系は 503、ページは 302 /login）
- 門の外のパスは `src/server/gate/policy.ts` の `gateExempt` だけ（拒否が既定）。**門の外のパスが届く先は ASSETS とログイン・ログアウトの処理だけ。DO へ渡すのは門を通った `/api/*` だけ**。パスは `requestPath`（デコードしない）で判断する
- cookie は `app_gate`（180日・HttpOnly・Secure・SameSite=Lax）。署名の鍵は `COOKIE_SECRET`（32字以上）があればそれ、無ければ合言葉から導く（`resolveCookieSecret`）。合言葉を変えると全員の cookie が無効になる
- 更新系（GET・HEAD・OPTIONS 以外のすべて）には `X-App: 1` が要る。画面からの呼び出しは `src/client/api.ts` の `apiFetch` / `request` を通す（自動で付く）
- 未認証のときは本文を読まない。門で止まった要求の本文は誰も読まない（門 → 本文の上限 → 道筋の順）
- 合言葉の失敗は DO の中で数える（10分・IP ごと5回・全体30回）。1日の上限と IP ごとの頻度制限（音声を送る回答＝40回/分、読み上げ＝30回/分）も DO の表で数え、値は `wrangler.jsonc` の `vars`（秘密は vars に書かない）
- 外部 API の上限・残高切れ・キーの誤りを受けた提供元は、DO のメモリの中で10分呼ばない（`guard/provider-block.ts`）
- テストの tsconfig（`tsconfig.node.json`）は `strictNullChecks` が無い。`src/server` の戻り値は判別つきの共用体にせず `{ ok: boolean; … ?: … }` の形にする
