// 利用料の金額の表示用の整形（画面と Node のテストの両方から読む）
export function formatYen(jpy) {
  if (!Number.isFinite(jpy) || jpy < 0) return "—";
  if (jpy === 0) return "0円";
  if (jpy < 0.01) return "0.01円未満";
  if (jpy < 10) return `${jpy.toFixed(2)}円`;
  if (jpy < 100) return `${jpy.toFixed(1)}円`;
  return `${Math.round(jpy).toLocaleString("ja-JP")}円`;
}

// period: { calls, pricedCalls, unpricedCalls, missingUsageCalls, usd, jpy }
export function formatPeriod(period) {
  if (!period.calls) return "0円";
  if (!period.pricedCalls) return "—"; // 単価の無いモデルだけ → 金額を出さない
  const amount = `約${formatYen(period.jpy)}`;
  return period.unpricedCalls ? `${amount}（単価未登録の${period.unpricedCalls}回を除く）` : amount;
}

// byProvider: { gemini, claude }（どちらも period）
export function formatBreakdown(byProvider) {
  if (!byProvider) return "";
  return `Gemini ${formatPeriod(byProvider.gemini)}・Claude ${formatPeriod(byProvider.claude)}`;
}

// daily: { answers: {used, limit}, speech: {used, limit}, yen: {used, limit}, reached: {...} }（サーバーの daily）。例「回答 12/300回・読み上げ 3/100回・約1.2円/50円」
export function formatDaily(daily) {
  const yen = formatYen(daily.yen.used);
  return `回答 ${daily.answers.used}/${daily.answers.limit}回・読み上げ ${daily.speech.used}/${daily.speech.limit}回・約${yen}/${daily.yen.limit}円`;
}
export function dailyReached(daily) {
  return Boolean(daily.reached && (daily.reached.answers || daily.reached.speech || daily.reached.yen));
}
