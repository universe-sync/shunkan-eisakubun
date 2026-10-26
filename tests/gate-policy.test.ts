import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_PASSWORD_CHARS, clientKey, cookieSecure, gateExempt, gatePassword, isConfigured, isLoopbackHost } from "../src/server/gate/policy";
import { forbidNetwork } from "./helpers/no-network";

forbidNetwork();

test("gateExempt：門の外にするパスは決めたものだけ", () => {
  const yes: Array<[string, string]> = [
    ["GET", "/login"], ["HEAD", "/login"], ["POST", "/login"], ["POST", "/logout"],
    ["GET", "/assets/index-AbC_12.js"], ["HEAD", "/assets/index-AbC.css"],
    ["GET", "/icon.svg"], ["HEAD", "/icon.svg"], ["GET", "/icon-32.png"], ["GET", "/apple-touch-icon.png"],
  ];
  for (const [m, p] of yes) assert.equal(gateExempt(m, p), true, `${m} ${p}`);
  const no: Array<[string, string]> = [
    ["GET", "/assets/..%2Findex.html"], ["GET", "/assets/a/b.js"], ["GET", "/assets/"], ["GET", "/"],
    ["GET", "/index.html"], ["GET", "/api/health"], ["POST", "/api/x"], ["GET", "/login/"], ["GET", "/login/x"],
    ["DELETE", "/login"], ["GET", "/logout"], ["POST", "/assets/x.js"], ["GET", "/assets/..%2Fapi%2Fhealth"], ["GET", "/assets/.hidden"],
    ["GET", "/icon-999.png"], ["GET", "/ICON.SVG"], ["POST", "/icon.svg"], ["GET", "/icon.svg/"], ["GET", "/%69con.svg"], ["DELETE", "/apple-touch-icon.png"],
    ["GET", "/favicon.ico"],
  ];
  for (const [m, p] of no) assert.equal(gateExempt(m, p), false, `${m} ${p}`);
});

test("isLoopbackHost・cookieSecure", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(cookieSecure(new URL("http://localhost:8820/")), false);
  assert.equal(cookieSecure(new URL("http://127.0.0.1:8820/")), false);
  assert.equal(cookieSecure(new URL("http://[::1]:8820/")), false);
  assert.equal(cookieSecure(new URL("https://speak25.example.workers.dev/")), true);
  assert.equal(cookieSecure(new URL("http://example.com/")), true);
  assert.equal(cookieSecure(new URL("https://localhost/")), true);
});

test("clientKey：ヘッダーの値・無いとき local・65 字は local", () => {
  assert.equal(clientKey(new Request("http://x/", { headers: { "CF-Connecting-IP": " 203.0.113.9 " } })), "203.0.113.9");
  assert.equal(clientKey(new Request("http://x/")), "local");
  assert.equal(clientKey(new Request("http://x/", { headers: { "CF-Connecting-IP": "a".repeat(65) } })), "local");
  assert.equal(clientKey(new Request("http://x/", { headers: { "CF-Connecting-IP": "a".repeat(64) } })), "a".repeat(64));
});

test("isConfigured：10字（コードポイント）の境目。前後の空白を除いて数える。COOKIE_SECRET は見ない", () => {
  assert.equal(MIN_PASSWORD_CHARS, 10);
  assert.equal(isConfigured({ GATE_PASSWORD: "x".repeat(10) }), true);
  assert.equal(isConfigured({ GATE_PASSWORD: "x".repeat(9) }), false);
  assert.equal(isConfigured({ GATE_PASSWORD: ` ${"x".repeat(9)} ` }), false); // 前後の空白を除くと9字
  assert.equal(isConfigured({ GATE_PASSWORD: ` ${"x".repeat(10)}\n` }), true);
  assert.equal(isConfigured({ GATE_PASSWORD: "   " }), false);
  assert.equal(isConfigured({ GATE_PASSWORD: "" }), false);
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured({ GATE_PASSWORD: "あ".repeat(10) }), true);
  assert.equal(isConfigured({ GATE_PASSWORD: "😀".repeat(10) }), true);  // コードポイントで数える（UTF-16 では20）
  assert.equal(isConfigured({ GATE_PASSWORD: "😀".repeat(9) }), false);
});

test("isConfigured：256字（UTF-16）を超えるとログインできないので門も閉じる", () => {
  assert.equal(isConfigured({ GATE_PASSWORD: "x".repeat(256) }), true);
  assert.equal(isConfigured({ GATE_PASSWORD: "x".repeat(257) }), false);
  assert.equal(isConfigured({ GATE_PASSWORD: ` ${"x".repeat(256)}\n` }), true); // trim 後で数える
  assert.equal(isConfigured({ GATE_PASSWORD: "😀".repeat(128) }), true);  // UTF-16 で 256
  assert.equal(isConfigured({ GATE_PASSWORD: "😀".repeat(129) }), false); // UTF-16 で 258
});

test("gatePassword：前後の空白を除く", () => {
  assert.equal(gatePassword({ GATE_PASSWORD: "  abc\n" }), "abc");
  assert.equal(gatePassword({}), "");
});
