import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// 画面は dist/client に出す（wrangler の assets.directory）。Vite の開発サーバーは使わない（門が Worker にあるため、wrangler dev の 8820 で見る）
export default defineConfig({ plugins: [react()], build: { outDir: "dist/client", emptyOutDir: true } });
