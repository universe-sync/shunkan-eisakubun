import { useEffect, useRef, useState } from "react";
import { USAGE_CHANGED_EVENT } from "./usage-events.js";
import { dailyReached, formatBreakdown, formatDaily, formatPeriod, type DailyUsage, type UsageBreakdown, type UsagePeriod } from "./lib/usage-format.js";

type Usage = { today: UsagePeriod & { date: string; byProvider?: UsageBreakdown }; total: UsagePeriod & { since: string | null; byProvider?: UsageBreakdown }; usdJpy: number; pricing: { sources: { gemini: string; claude: string }; checkedOn: string }; daily?: DailyUsage };

// 画面の一番上に、このアプリが使った API（Gemini・Claude）の利用料の目安（今日・累計）を出す
export default function UsageBar() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false); // 内訳と注記は［内訳を見る］で開く（2026-10-21 利用者の依頼）
  const mounted = useRef(true);
  const loading = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    mounted.current = true;
    // 同時には1つしか読まない。読み込み中にもう一度頼まれたら、終わった後に1回だけ読み直す
    const load = async () => {
      if (loading.current) { again.current = true; return; }
      loading.current = true;
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "failed");
        if (mounted.current) { setUsage(data as Usage); setFailed(false); }
      } catch { if (mounted.current) setFailed(true); }
      finally {
        loading.current = false;
        if (again.current && mounted.current) { again.current = false; void load(); }
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void load(); }; // 日付が変わったときのため
    void load();
    window.addEventListener(USAGE_CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", onVisible);
    return () => { mounted.current = false; window.removeEventListener(USAGE_CHANGED_EVENT, load); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const stale = failed && usage ? <span className="usage-note">（最新の値を読み込めませんでした）</span> : null;
  if (!usage) return <aside className="usage-bar" aria-label="API 利用料の目安"><span className="usage-title">API 利用料の目安</span><span>{failed ? "読み込めませんでした" : "読み込み中"}</span></aside>;
  return <aside className="usage-bar" aria-label="API 利用料の目安">
    <div className="usage-main">
      <span className="usage-title">API 利用料の目安</span>
      <span className="usage-figure"><span className="usage-label">今日</span><strong>{formatPeriod(usage.today)}</strong></span>
      <span className="usage-figure"><span className="usage-label">累計</span><strong>{formatPeriod(usage.total)}</strong></span>
      {usage.daily && <span className="usage-figure"><span className="usage-label">今日の上限</span><strong>{formatDaily(usage.daily)}</strong>{dailyReached(usage.daily) && <span className="usage-limit-reached">（上限に達しました）</span>}</span>}
      <button type="button" className="quiet usage-toggle" aria-expanded={detailOpen} aria-controls="usage-detail" onClick={() => setDetailOpen((open) => !open)}>{detailOpen ? "内訳を閉じる" : "内訳を見る"}</button>{stale}
    </div>
    <div id="usage-detail" className="usage-detail" hidden={!detailOpen}>
      <p><span className="usage-label">今日の内訳</span>{formatBreakdown(usage.today.byProvider)}</p>
      <p><span className="usage-label">累計の内訳</span>{formatBreakdown(usage.total.byProvider)}</p>
      {usage.daily && <p className="usage-note">上限は日本時間の0時に戻ります。値は Cloudflare の Variables（DAILY_ANSWER_LIMIT・DAILY_YEN_LIMIT・DAILY_SPEECH_LIMIT）で変えられます。</p>}
      <p className="usage-note">このアプリの分だけの概算です{usage.total.since ? `（累計は${usage.total.since}から）` : ""}。前払い残高とは別です。Google と Anthropic の料金表（{usage.pricing.checkedOn} 確認）と 1ドル={usage.usdJpy}円で計算しています。Gemini の請求（前払い残高・支出の上限）は Google AI Studio で、Claude の残高と請求は Claude Console で確認してください。同じキーをほかのアプリでも使っているときは、その分はここに入りません。</p>
    </div>
  </aside>;
}
