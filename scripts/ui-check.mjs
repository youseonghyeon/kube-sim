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
check((await page.locator(".cp-comp").count()) === 4, "컨트롤 플레인 구성 요소 4개 (apiserver·scheduler·controller-manager·CoreDNS)", "Canvas ControlPlane / view.ts CONTROL_PLANE");
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

// 6) 노드 하나 죽이기: 끄기 → (40초) NotReady → (300초) eviction → 다른 노드에 다시
console.log("6) 노드 죽이기");
await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
await page.click(".menu-btn");
await page.click('.menu-item[data-example="node-down"]');
await page.selectOption(".transport .speed", "30");
await waitFor(async () => (await statusTexts()).length === 6 && (await statusTexts()).every((s) => s === "Running"), "Pod 6개 Running");
await page.locator(".try", { hasText: "worker-2 끄기" }).locator("button").click();
const story = () => page.locator('[data-node="worker-2"] .node-story').textContent().catch(() => "");
await waitFor(async () => (await story())?.startsWith("꺼짐"), "꺼짐 안내");
check(true, "끄면 노드 상자에 '꺼짐 — … 뒤 NotReady' 안내");
await page.screenshot({ path: `${OUT}/08-node-off.png` });
await waitFor(async () => (await story())?.startsWith("NotReady"), "NotReady", 30000);
check(true, "40초 뒤 NotReady + eviction 까지 남은 시간");
await page.locator('[data-node="worker-2"] .node-head').click();
await page.screenshot({ path: `${OUT}/09-node-notready.png` });
await waitFor(async () => (await page.locator('[data-node="worker-2"] .pod .pod-status').allTextContents()).every((s) => s === "Terminating"), "eviction 뒤 Terminating", 40000);
await waitFor(async () => (await page.locator('.node:not([data-node="worker-2"]) .pod .pod-status').allTextContents()).filter((s) => s === "Running").length === 6, "다른 노드에 6개 Running", 20000);
check(true, "300초 뒤 eviction → 꺼진 노드의 Pod 는 Terminating 에 멈추고 다른 노드에 6개 Running");
await page.screenshot({ path: `${OUT}/10-node-evicted.png` });

// 7) Service: client 에서 curl → 경로(DNS → DNAT → 경로 → 응답), Service 를 고르면 엔드포인트로 선
console.log("7) Service 와 요청 경로");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="service"]');
await page.selectOption(".transport .speed", "5");
await waitFor(async () => (await statusTexts()).length === 4 && (await statusTexts()).every((s) => s === "Running"), "Pod 4개 Running");
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.includes("ready 3"), "엔드포인트 ready 3");
check(true, "Service 상자에 엔드포인트 ready 3");
await page.waitForTimeout(600); // kube-proxy 규칙 반영(시뮬레이션 1초 = 5배속에서 0.2초)을 기다림 — EndpointSlice 가 ready 여도 규칙은 조금 늦다
await page.locator(".try", { hasText: "client 에서 curl" }).locator("button").click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/11-request-path.png` });
const steps = await page.locator(".term-entry").last().locator(".net-step .net-kind").allTextContents();
check(steps.join(",") === "DNS,DNAT,경로,응답", `요청 단계가 kubectl 창에 보인다 (${steps.join(" → ")})`, "Drawer net-steps / core net/request.ts");
check((await page.locator(".term-res").last().textContent())?.includes("Welcome to nginx"), "curl 응답 본문이 보인다", "request.ts deliverToIp");
check((await page.locator(".overlay .req-dot").count()) === 1, "캔버스에 요청 점이 움직인다", "Overlay RequestPath");
await page.locator(".svc").first().click();
await page.waitForTimeout(200);
check((await page.locator(".overlay .ep-link").count()) === 3, "Service 를 고르면 엔드포인트 3개로 선", "Overlay links");
await page.screenshot({ path: `${OUT}/12-service-selected.png` });

// 8) readiness: 고장 낸 Pod 는 엔드포인트에서 빠진다
console.log("8) readiness");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="readiness"]');
await page.selectOption(".transport .speed", "10");
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.includes("ready 3"), "api 엔드포인트 ready 3 (준비 15초 뒤)", 40000);
check(true, "준비 시간이 지나 ready 3");
await page.locator(".try", { hasText: "고장 내기" }).locator("button").click();
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.includes("not ready 1"), "고장 낸 Pod 가 not ready", 40000);
check(true, "앱을 고장 내면 probe 실패 뒤 엔드포인트 not ready 1");
await page.locator(".svc").first().click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/13-readiness.png` });

// 9) 롤링 업데이트: 부하를 보내며 이미지 바꾸기 → r1·r2 가 섞였다가 r2 만, 실패 0 (preStop 있음)
console.log("9) 롤링 업데이트");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="rolling"]');
await page.selectOption(".transport .speed", "2");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 5, "Pod 5개 Running");
await page.locator(".try", { hasText: "부하 보내기" }).locator("button").click();
await waitFor(async () => (await page.locator(".traffic .tick").count()) > 10, "부하 막대에 칸이 쌓임");
check(true, "부하 막대가 보인다");
await page.locator(".traffic-actions button", { hasText: "0 으로" }).click(); // 막 뜬 Pod 의 규칙 반영 전 실패는 세지 않는다
await page.locator(".try", { hasText: "이미지 바꾸기" }).locator("button").click();
await waitFor(async () => (await page.locator(".pod-rev.new").count()) > 0, "롤아웃 중 r2 표시", 20000);
await page.screenshot({ path: `${OUT}/14-rolling.png` });
check(true, "롤아웃 중 Pod 칩에 리비전(r1·r2)");
await waitFor(async () => (await page.locator(".pod-rev").count()) === 0 && (await statusTexts()).filter((s) => s === "Running").length === 5, "롤아웃 끝", 60000);
const failText = await page.locator(".traffic-count").nth(1).textContent();
check(failText === "실패 0", `preStop 이 있는 롤링 업데이트는 요청 실패 0 (${failText})`, "kubelet preStop / RULE_SYNC_MS / Deployment rolling");

// 10) 종료 경합: preStop 없이 Pod 를 지우면 실패가 생긴다
console.log("10) 종료 경합");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="graceful"]');
await page.selectOption(".transport .speed", "2");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 4, "Pod 4개 Running");
await page.locator(".try", { hasText: "부하 보내기" }).locator("button").click();
await page.waitForTimeout(800);
await page.locator(".try", { hasText: "Pod 하나 지우기" }).first().locator("button").click();
await waitFor(async () => (await page.locator(".traffic-count.bad").count()) === 1, "부하 실패가 생김", 15000);
check(true, "preStop 없이 Pod 를 지우면 부하 막대에 실패");
await page.screenshot({ path: `${OUT}/15-graceful-fail.png` });

// 11) drain + PDB
console.log("11) drain");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="drain"]');
await page.selectOption(".transport .speed", "5");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 3, "Pod 3개 Running");
await page.waitForTimeout(500);
await page.locator(".try", { hasText: "worker-1 비우기" }).locator("button").click();
await waitFor(async () => (await page.locator(".term-res").last().textContent())?.includes("node/worker-1 drained"), "drained", 40000);
const drainOut = await page.locator(".term-res").last().textContent();
check(drainOut?.includes("Cannot evict pod as it would violate the pod's disruption budget."), "drain 출력에 PDB 거절과 재시도가 보인다", "core/drain.ts");
await page.screenshot({ path: `${OUT}/16-drain.png` });

check(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(" | ")}` : ""}`, "콘솔 오류의 스택을 보고 고치세요");
console.log(failed ? "ui-check 실패" : "ui-check 통과 — 스크린샷: .shots/");
await done(failed ? 1 : 0);
