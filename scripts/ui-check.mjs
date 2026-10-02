// 브라우저 스모크 테스트: 예제 로드 → Pod 가 Running 이 됨 → Pod 지우기 → 다시 생김 → kubectl → 예제 바꾸기 → 다크 테마.
// 실행: npm run ui-check   (스크린샷은 .shots/ 에 저장. Vite 를 5199 포트로 직접 띄운다 — 사용자의 5173 은 건드리지 않음)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";

const OUT = ".shots";
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: "silent" });
await server.listen();
const URL = server.resolvedUrls.local[0];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

let failed = false;
function check(cond, what, fix) {
  if (cond) {
    console.log(`  ok  ${what}`);
    return;
  }
  failed = true;
  console.log(`문제: ${what}`);
  console.log(`해결: ${fix}`);
  console.log(`참조: scripts/ui-check.mjs, .shots/`);
}

async function done(code) {
  await browser.close();
  await server.close();
  process.exit(code);
}

process.on("unhandledRejection", async (e) => {
  console.log("CRASH:", e?.message?.split("\n")[0]);
  console.log("ERRORS:", errors.length ? errors : "none");
  await page.screenshot({ path: `${OUT}/crash.png` }).catch(() => {});
  await done(1);
});

const pods = () => page.locator(".node .pod");
const statusTexts = () => page.locator(".node .pod .pod-status").allTextContents();
async function waitFor(fn, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout: ${what}`);
    await page.waitForTimeout(100);
  }
}

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => (document.documentElement.dataset.theme = "light"));

// 1) 기본 예제: 처음엔 ContainerCreating → 곧 Running 3개
console.log("1) 기본 예제");
await page.selectOption(".transport .speed", "2");
await waitFor(async () => (await pods().count()) === 3, "Pod 3개가 노드에 나타남");
await page.screenshot({ path: `${OUT}/01-creating.png` });
const early = await statusTexts();
check(early.some((s) => s === "ContainerCreating"), `처음에는 ContainerCreating 이 보인다 (${early.join(", ")})`, "kubelet 의 SANDBOX_MS·pull 시간, 화면 시계(simClock)가 점프하지 않는지 확인");
await waitFor(async () => (await statusTexts()).every((s) => s === "Running") && (await pods().count()) === 3, "3개 모두 Running");
check(true, "3개 모두 Running");
check((await page.locator(".cp-comp").count()) === 3, "컨트롤 플레인 구성 요소 3개", "Canvas ControlPlane");
check((await page.locator(".try").count()) >= 3, "예제의 '해 볼 것' 이 인스펙터에 보인다", "Inspector ExamplePanel");
await page.screenshot({ path: `${OUT}/02-running.png` });

// 2) Pod 고르기 → 지우기 → 다시 생김
console.log("2) Pod 지우기");
const first = pods().first();
const victim = (await first.getAttribute("data-pod")) ?? "";
await first.click();
check((await page.locator(".insp-name").first().textContent())?.includes(victim), "Pod 를 누르면 인스펙터에 그 Pod", "PodChip onClick → selection");
await page.locator(".actions .btn", { hasText: "Pod 지우기" }).click();
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/03-terminating.png` });
await waitFor(async () => {
  const names = await pods().evaluateAll((els) => els.map((e) => e.getAttribute("data-pod")));
  return names.length === 3 && !names.includes(victim) && (await statusTexts()).every((s) => s === "Running");
}, "지운 Pod 대신 새 Pod 가 Running");
check(true, "지운 Pod 대신 새 Pod 가 생겨 Running");
const kubectlOut = await page.locator(".term-res").last().textContent();
check(kubectlOut?.includes(`pod "${victim}" deleted`), "kubectl 창에 delete 결과가 실제 문구로", "Inspector runAndShow → sim.kubectl");
await page.screenshot({ path: `${OUT}/04-recreated.png` });

// 3) kubectl 직접 입력: scale
console.log("3) kubectl scale");
await page.fill(".term-in input", "scale deployment/web --replicas=5");
await page.press(".term-in input", "Enter");
await waitFor(async () => (await pods().count()) === 5 && (await statusTexts()).every((s) => s === "Running"), "Pod 5개 Running");
check(true, "scale 5 → Pod 5개 Running");
await page.locator(".tree-row", { hasText: "web" }).first().click();
check((await page.locator(".callout", { hasText: "라이브가 매니페스트와 다릅니다" }).count()) === 1, "kubectl 로 바꾼 replicas 가 드리프트로 보인다", "Inspector DriftNote / DefSync.drift");
await page.screenshot({ path: `${OUT}/05-scaled-drift.png` });

// 4) 예제 바꾸기: Pending
console.log("4) Pending 예제");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="pending"]');
await waitFor(async () => (await page.locator(".lane .pod").count()) === 1, "스케줄 대기 칸에 Pod 1개");
check(true, "자리가 모자라면 스케줄 대기 칸에 Pod 가 남는다");
await page.locator(".lane .pod").first().click();
const why = await page.locator(".callout.warn").first().textContent();
check(why?.includes("0/3 nodes are available: 3 Insufficient cpu."), "Pending Pod 를 고르면 FailedScheduling 문구가 보인다", "scheduler.ts failedSchedulingMessage / PodOverview");
await page.screenshot({ path: `${OUT}/06-pending.png` });

// 5) CrashLoopBackOff + 다크 테마
console.log("5) CrashLoopBackOff, 다크");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="crashloop"]');
await page.selectOption(".transport .speed", "10");
await waitFor(async () => (await statusTexts()).includes("CrashLoopBackOff"), "CrashLoopBackOff 가 보임", 30000);
check(true, "크래시하는 앱이 CrashLoopBackOff 로 보인다");
await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
await page.click(".drawer .tabs button:has-text('로그')");
await page.screenshot({ path: `${OUT}/07-crashloop-dark.png` });

check(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(" | ")}` : ""}`, "콘솔 오류의 스택을 보고 고치세요");
console.log(failed ? "ui-check 실패" : "ui-check 통과 — 스크린샷: .shots/");
await done(failed ? 1 : 0);
