// 성능 측정: 프로덕션 빌드로 예제마다 6초 동안 프레임 간격·긴 프레임을 잰다 (CPU 4배 감속 — 느린 노트북 흉내).
// 큰 구성(노드 8대, Pod 60개)을 kubectl 로 만들어 가장 무거운 경우도 잰다.
// 실행: npm run perf-check   ·   --headed (실제 창)   ·   --throttle 1 (감속 없이)
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, preview } from "vite";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const ti = args.indexOf("--throttle");
const throttle = ti >= 0 ? Number(args[ti + 1]) : 4;
const WINDOW_MS = 6000;
/** 이 이상이면 실패 (감속 기준). 60fps 한 프레임 16.7ms, 두 프레임 33ms */
const BUDGET = { p95: 34, longFrames: 3 };
// 예제 목록은 코드에서 읽는다 (손으로 적으면 새 예제가 빠진다)
const dev = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const EXAMPLES = [...(await dev.ssrLoadModule("/src/model/examples.ts")).EXAMPLES.map((e) => e.id), "stress"];
await dev.close();

const outDir = mkdtempSync(join(tmpdir(), "kube-sim-perf-"));
await build({ logLevel: "silent", build: { outDir, emptyOutDir: true } });
const server = await preview({ logLevel: "silent", preview: { port: 5198, strictPort: true }, build: { outDir } });
const URL = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: !headed });

async function measure(id) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click(".menu-btn");
  await page.click(`.menu-item[data-example="${id === "stress" ? "nodes" : id}"]`);
  if (id === "stress") {
    // 노드 5대 더 + Pod 60개 (Deployment 3개)
    for (let i = 0; i < 5; i++) await page.click('.side-head:has-text("노드") .icon-btn');
    await page.click(".drawer .tabs button:has-text('kubectl')");
    for (const [n, r] of [["a", 20], ["b", 20], ["c", 14]]) {
      await page.fill(".term-in input", `create deployment ${n} --image=nginx:1.27 --replicas=${r}`);
      await page.press(".term-in input", "Enter");
    }
    await page.click(".drawer .tabs button:has-text('로그')");
  }
  await page.selectOption(".transport .speed", "2");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const r = await page.evaluate(
    (windowMs) =>
      new Promise((res) => {
        const gaps = [];
        let last = performance.now();
        const t0 = last;
        const f = (t) => {
          gaps.push(t - last);
          last = t;
          if (t - t0 < windowMs) requestAnimationFrame(f);
          else res({ gaps, wall: t - t0 });
        };
        requestAnimationFrame(f);
      }),
    WINDOW_MS,
  );
  const pods = await page.locator(".pod").count();
  await page.close();
  const s = [...r.gaps].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    example: id,
    pods,
    fps: (r.gaps.length / (r.wall / 1000)).toFixed(0),
    p50: q(0.5).toFixed(1),
    p95: q(0.95).toFixed(1),
    max: s.at(-1).toFixed(0),
    longFrames: r.gaps.filter((g) => g > 50).length,
    errors: errors.length,
  };
}

console.log(`perf-check: ${headed ? "headed" : "headless"}, CPU ${throttle}x 감속, 구간 ${WINDOW_MS / 1000}s`);
const rows = [];
for (const id of EXAMPLES) rows.push(await measure(id));
console.table(rows);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
rmSync(outDir, { recursive: true, force: true });

const bad = rows.filter((r) => r.errors > 0 || (throttle >= 4 && (Number(r.p95) > BUDGET.p95 || r.longFrames > BUDGET.longFrames)));
if (bad.length) {
  console.log(`문제: 예산 초과 — ${bad.map((r) => `${r.example}(p95 ${r.p95}ms, 긴 프레임 ${r.longFrames}, 오류 ${r.errors})`).join(", ")}`);
  console.log("해결: 매 프레임 도는 코드(Canvas 의 buildView·recentFlashes, Drawer 의 LogView, sim.ts frame)부터 확인하세요. buildView 는 simVersion 이 바뀔 때만 다시 계산해야 합니다");
  console.log("참조: scripts/perf-check.mjs 의 BUDGET, docs/LESSONS.md");
  process.exit(1);
}
console.log("OK: 모든 예제가 예산 안 (p95 ≤ 34ms, 50ms 넘는 프레임 ≤ 3)");
