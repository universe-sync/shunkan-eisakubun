# speak25

毎日25分、日本語の問題文を見て声に出して英語にする練習アプリ。Cloudflare Workers（Hono）＋ Durable Object（SQLite）で動く。
このファイルは、このリポジトリで開発する人（や AI）向けの決まり。使い方・始め方は README.md。

## コマンド
- `npm test` ・ `npm run typecheck` ・ `npm run bench:audio`（録音1回分の CPU 時間の目安。外へは通信しない）
- `npm run dev`（画面を作り直してから `wrangler dev`。ずっと動き続ける）・`npm run build`（`wrangler deploy --dry-run` を含むが、アップロードはしない）
- `npm run deploy` は画面を作ってから本物の Cloudflare に上げる。流す前に、`wrangler.jsonc` の名前と登録済みの Secret を確かめる
- `npm run dev:trial`（お試しモードの手元の確認。8821）・`npm run deploy:trial`（お試し用の Worker `speak25-trial` へ。`wrangler.trial.jsonc`）
- **ロールバックで前の版に戻せない場合がある**：SQL のマイグレーション 003（人ごとの記録）が一度流れた Durable Object は、003 を知らない前の版のコードでは開けない（データベースの版がプログラムより新しい、として止まる）。003 が入る版を出した後は、戻すのではなく直して出し直す

## ポート
- `wrangler dev` は 8820（inspector は 9820）。`wrangler.jsonc` の `dev` で決めている。お試し用（`wrangler.trial.jsonc`）は 8821（inspector は 9821）

## 守ること
- パスは `src/server/path.ts` の `requestPath` の1か所で取る。**Hono は必ず `new Hono({ getPath: requestPath })`**（Worker の Hono も DO の Hono も）。門と道筋が同じパスを見るため
- ストアの関数（`src/server/instant/store.ts` ほか）は**同期**。check と write の間に `await` を挟まない（DO は同期のコードの途中に割り込まない）。例外は answer の「checkAnswerable → 外部 API → record（条件を確かめ直す）」の3段だけ
- API の処理は全部 DO の中。Worker は「守り・門・転送」だけ（Worker の CPU は1リクエスト10ms、DO は30秒）
- ASSETS・DO の応答は `new Response(r.body, r)` で写してから返す（ヘッダーを変えられない Response を返すと例外になる）
- テストから読む `src/server` のファイルは、標準の Web API と Hono・Anthropic SDK だけを使う。`cloudflare:workers` や `Fetcher`・`DurableObjectNamespace` の型は `worker.ts`・`env.ts`・`practice-do.ts`・`store/do-db.ts` だけ
- `src/server` は `src/client` を import しない。両方が読むのは `src/shared` だけ
- 読み上げの速さ（普通・ゆっくり）は端末ごとに localStorage（`speak25.speechSpeed`）で覚え、`/api/instant/speech` の `speed` で送る。サーバーの表には持たない。既定は普通
- 外向きの fetch は許可リスト（`ai/outbound.ts`：Gemini・Anthropic だけ）で包む
- ログに本文・書き起こし・cookie・キーを出さない（Claude と Gemini のエラーは状態と code だけ）
- **`.dev.vars`・`.env*` を読まない・写さない。** 値は各自が `.dev.vars`（git に入れない）か Cloudflare の Secret に入れる
- 公開するリポジトリなので、個人のパス・メールアドレス・アカウントや請求の情報・キーをファイルに書かない（`tests/publish.test.ts` が確かめる。手元だけの禁止語は git に入れない `tests/publish-forbidden.local.json` に書く）
- 表示名（仮）は `src/shared/app-info.js` と `index.html` の `<title>` の2か所。一致は `tests/config.test.ts` が確かめる

## 門と守り
- 合言葉だけでログインする（ユーザー名は無い）。`GATE_PASSWORD`（前後の空白を除いて10字以上）が無い・短いと門は閉じたまま（POST /login と /api と更新系は 503、ページは 302 /login）
- 門の外のパスは `src/server/gate/policy.ts` の `gateExempt` だけ（拒否が既定）。**門の外のパスが届く先は ASSETS とログイン・ログアウトの処理だけ。DO へ渡すのは門を通った `/api/*` だけ**。パスは `requestPath`（デコードしない）で判断する
- cookie は `app_gate`（180日・HttpOnly・Secure・SameSite=Lax）。署名の鍵は `COOKIE_SECRET`（32字以上）があればそれ、無ければ合言葉から導く（`resolveCookieSecret`）。合言葉を変えると全員の cookie が無効になる
- 更新系（GET・HEAD・OPTIONS 以外のすべて）には `X-App: 1` が要る。画面からの呼び出しは `src/client/api.ts` の `apiFetch` / `request` を通す（自動で付く）
- 未認証のときは本文を読まない。門で止まった要求の本文は誰も読まない（門 → 本文の上限 → 道筋の順）
- 合言葉の失敗は DO の中で数える（10分・IP ごと5回・全体30回）。1日の上限と IP ごとの頻度制限（音声を送る回答＝40回/分、読み上げ＝30回/分）も DO の表で数え、値は `wrangler.jsonc` の `vars`（秘密は vars に書かない）
- 外部 API の上限・残高切れ・キーの誤りを受けた提供元は、DO のメモリの中で10分呼ばない（`guard/provider-block.ts`）
- テストの tsconfig（`tsconfig.node.json`）は `strictNullChecks` が無い。`src/server` の戻り値は判別つきの共用体にせず `{ ok: boolean; … ?: … }` の形にする

## お試しモード（複数人）
- `TRIAL_MODE` が `"1"` のときだけ有効（`wrangler.trial.jsonc`）。**1人用（`TRIAL_MODE` なし）の応答・DB の中身・画面は、今までと同じに保つ**（`tests/worker-trial.test.ts`・`tests/trial-api.test.ts` が固定している）。自分の Worker に `TRIAL_MODE` を入れない
- `/api/instant/start` の成功応答にも、お試しでは `trial` を含める
- 記録は `user_key` で分ける。1人用は空の文字、お試しは名前の鍵（小文字・NFC）。`store.ts`・`settings.ts` は作るときに userKey を束ね、`instant_` の表を読み書きする SQL には必ず `user_key = ?` を入れる。お試しで空の文字に届く道を作らない
- 名前の cookie は `app_user`（署名つき）。クライアントが送った `X-User-Key` は Worker が必ず捨て、検証した鍵を base64url にして付け直す。DO はそれだけを信じる
- 名前の登録は `POST /trial/name`（重複は 409）。管理用の一覧は `POST /trial/admin/participants`（Secret `TRIAL_ADMIN_TOKEN`・32字以上。失敗はメンバーの合言葉の失敗と同じ枠で数える）と画面 `/trial/admin`
- 上限：1人1日の回答 `TRIAL_QUESTIONS_PER_DAY`・読み上げ `TRIAL_SPEECH_PER_DAY`・終了日 `TRIAL_ENDS_ON`（その日を含む。日本時間）。全員の合計の上限は `DAILY_*`。日付はすべて `jstDate`
- お試しの Worker には `COOKIE_SECRET` を必ず入れる（合言葉を変えても名前の cookie が消えない）
- 引き継ぎ番号は `linkCode`（`COOKIE_SECRET` と名前の鍵の HMAC の6桁、`gate/user-token.ts`）。DB に持たない。`POST /trial/name` の `code` が合えば `resume` で同じ名前に入れる。失敗は別の鍵 `code:`＋IP で数え（`loginAttempt` の `clearOnOk=false`＝合っても消さない）、全体の30回だけ合言葉と共有する。`COOKIE_SECRET` を変えると全員の番号が変わる
- 画面は戻ったとき（visible・pageshow・focus 15秒以上・操作60秒以上）に status と settings を読み直す（`refreshStatus`。録音中・採点待ち・リセット中は読まない）。ポーリングはしない。判断は `client/lib/refresh-policy.ts`
- 一時停止中の［再開］は先に status を読み、別の端末で出題が進んでいれば（`sessionProgressed`）区間を送らずに待機へ戻す（`returnToIdle`）。戻ったときの読み直しでも同じ。読めなければ今までどおり再開する（サーバーが 409 で守る）
