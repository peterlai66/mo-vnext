import { defineConfig } from "vitest/config";

/** Node pool：僅跑不依賴 @cloudflare/vitest-pool-workers 的 API 單元測試 */
export default defineConfig({
	test: {
		pool: "forks",
		include: ["test/api/**/*.spec.ts"],
	},
});
