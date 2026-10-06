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

// 3b) 예제 메뉴: 묶음별 열 + 검색
console.log("3b) 예제 메뉴 묶음·검색");
await page.click(".menu-btn");
check((await page.locator(".menu-group").count()) === 9, "예제 메뉴가 묶음 9개로 나뉜다", "examples.ts EXAMPLE_GROUPS / App.tsx ExampleMenu");
await page.screenshot({ path: `${OUT}/05b-example-menu.png` });
await page.keyboard.type("readiness");
const found = await page.locator(".example-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-example")));
check(found.length > 0 && found.includes("readiness") && !found.includes("basics"), `검색하면 맞는 예제만 남는다 (${found.join(",")})`, "App.tsx ExampleMenu 검색 필터");
await page.keyboard.press("Escape");
await page.click(".menu-btn");
await page.keyboard.type("없는말xyz");
check((await page.locator(".menu-empty").count()) === 1, "맞는 예제가 없으면 안내가 보인다", "App.tsx ExampleMenu menu-empty");
await page.keyboard.press("Escape");

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
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.startsWith("엔드포인트 ready 3"), "엔드포인트 ready 3");
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
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.startsWith("엔드포인트 ready 3"), "api 엔드포인트 ready 3 (준비 15초 뒤)", 40000);
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

// 12) Ingress: 바깥에서 curl 로 Host 에 따라 다른 Pod, 경로 점이 바깥 상자에서 출발
console.log("12) Ingress");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="ingress"]');
await page.selectOption(".transport .speed", "5");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 5, "Pod 5개 Running", 30000);
await waitFor(async () => (await page.locator(".ingress .svc-addr").first().textContent())?.includes("192.168.0.240"), "Ingress ADDRESS", 10000);
await page.waitForTimeout(600);
check((await page.locator('[data-outside="internet"]').count()) === 1, "바깥 클라이언트 상자", "Canvas 바깥 섹션");
await page.locator(".try", { hasText: "shop.example.com 으로" }).locator("button").click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${OUT}/17-ingress.png` });
const ingOut = await page.locator(".term-res").last().textContent();
check(ingOut?.includes("X-Forwarded-For: 192.168.0.1"), "Cluster 정책에서는 X-Forwarded-For 가 노드 IP", "request.ts viaService SNAT");
await page.locator(".try", { hasText: "클라이언트 IP 지키기" }).locator("button").click();
await page.waitForTimeout(800);
await page.locator(".try").filter({ has: page.locator(".try-title", { hasText: /^다시 shop 으로$/ }) }).locator("button").click(); // 설명문에도 같은 말이 있어 제목으로 정확히
await page.waitForTimeout(300);
check((await page.locator(".term-res").last().textContent())?.includes("X-Forwarded-For: 203.0.113.7"), "Local 로 바꾸면 X-Forwarded-For 가 클라이언트 IP", "externalTrafficPolicy Local");

// 13) Tailscale funnel
console.log("13) Tailscale");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="tailscale"]');
// "not ready 1" 도 "ready 1" 을 담고 있어 앞에서부터 본다
await waitFor(async () => (await page.locator('[data-service="net-sim"] .svc-eps').textContent().catch(() => ""))?.startsWith("엔드포인트 ready 1"), "net-sim readiness 통과 (10초 주기)", 40000);
await page.waitForTimeout(600); // 규칙 반영
await page.locator(".try", { hasText: "인터넷에서 접속" }).locator("button").click();
await page.waitForTimeout(2500);
check((await page.locator(".term-res").last().textContent())?.includes("<title>net-sim</title>"), "funnel → 프록시 → Service → net-sim 응답", "request.ts viaFunnel");
await page.screenshot({ path: `${OUT}/18-tailscale.png` });

// 14) GitOps: Argo CD selfHeal · CI 커밋 → (폴링 전엔 모름) → Refresh → 자동 sync
console.log("14) GitOps");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="gitops"]');
await page.selectOption(".transport .speed", "5");
const appBadge = () => page.locator('[data-app="net-sim"] .badge').first().textContent().catch(() => "");
await waitFor(async () => (await appBadge()) === "Synced", "Argo CD Synced", 30000);
check(true, "GitOps 상자: Application 이 Synced");
await page.locator(".try", { hasText: "kubectl 로 손대기" }).locator("button").click();
await waitFor(async () => (await appBadge()) === "OutOfSync", "kubectl 뒤 OutOfSync", 10000);
check(true, "kubectl 로 바꾸면 OutOfSync");
await waitFor(async () => (await appBadge()) === "Synced", "selfHeal 로 다시 Synced", 30000);
check(true, "selfHeal 이 되돌려 다시 Synced");
await page.locator(".try", { hasText: "CI: 새 이미지" }).locator("button").click();
await page.waitForTimeout(300);
check((await page.locator('[data-app="net-sim"]').textContent())?.includes("아직 모름"), "CI 커밋 뒤 Argo CD 는 아직 옛 리비전 (폴링 전)", "Canvas GitOpsLane / argocd.ts fetch");
await page.screenshot({ path: `${OUT}/19-gitops-behind.png` });
await page.locator(".try", { hasText: "기다리지 않고 Refresh" }).locator("button").click();
await waitFor(async () => !(await page.locator('[data-app="net-sim"]').textContent())?.includes("아직 모름"), "Refresh 뒤 새 리비전", 10000);
await page.locator('[data-app="net-sim"]').click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/20-gitops-app.png` });
check(true, "Refresh 하면 새 리비전을 보고 자동 sync");

// 15) 자원: OOMKilled · 노드 실사용 선 · throttling
console.log("15) 자원 (requests/limits)");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="oom"]');
await page.selectOption(".transport .speed", "5");
const reportChip = page.locator('.node .pod[data-pod^="report-"]').first();
await waitFor(async () => (await reportChip.count()) === 1 && ((await reportChip.locator(".pod-restarts").count()) > 0), "report 재시작", 30000);
await reportChip.click();
await waitFor(async () => (await page.locator(".callout", { hasText: "OOMKilled (exit 137)" }).count()) === 1, "OOMKilled 안내", 10000);
check(true, "OOMKilled 뒤 Pod 인스펙터에 이유(limits.memory 에 닿음)가 보인다");
check((await page.locator(".insp-body h3", { hasText: "자원 · QoS Burstable" }).count()) === 1, "Pod 인스펙터에 자원 막대와 QoS", "Inspector PodResources");
check((await page.locator(".usage-tick.lim").count()) >= 1, "메모리 막대에 limits 눈금", "Inspector UsageBar");
await page.screenshot({ path: `${OUT}/21-oom.png` });
await page.locator(".tabs button", { hasText: "describe" }).click();
check((await page.locator(".insp-body .term").textContent())?.includes("OOMKilled"), "describe 에 Last State OOMKilled", "kubectl.ts describePod stateLines");

await page.click(".menu-btn");
await page.click('.menu-item[data-example="throttle"]');
await waitFor(async () => (await page.locator('.node .pod[data-pod^="thumbs-"] .pod-badge', { hasText: "throttled" }).count()) === 1, "throttled 배지", 30000);
check(true, "cpu limit 에 막힌 Pod 칩에 throttled 배지");
await page.locator('.node .pod[data-pod^="thumbs-"]').click();
await page.locator(".tabs button", { hasText: "개요" }).click();
await waitFor(async () => (await page.locator(".insp-body .note", { hasText: "CPU throttling" }).count()) === 1, "throttling 설명", 5000);
check(true, "인스펙터에 throttling 설명");
await page.locator(".insp-close").click();
await waitFor(async () => (await page.locator(".canvas").textContent())?.includes("엔드포인트 ready 1"), "thumbs 엔드포인트 ready", 20000);
await page.waitForTimeout(600); // kube-proxy 규칙 반영 1초 (5× 속도)
await page.locator(".try", { hasText: "요청 보내기" }).locator("button").click();
await page.waitForTimeout(300);
check((await page.locator(".drawer").textContent())?.includes("응답 450ms"), "curl 결과에 응답 450ms", "request.ts deliverToIp latency");
await page.screenshot({ path: `${OUT}/22-throttle.png` });
await page.locator(".tree-row", { hasText: "thumbs" }).first().click();
await page.locator(".tabs button", { hasText: "설정" }).click();
check((await page.locator(".field-label", { hasText: "limits.cpu" }).count()) === 1, "Deployment 설정에 limits 칸", "Inspector DeploymentSettings");

await page.click(".menu-btn");
await page.click('.menu-item[data-example="node-oom"]');
await waitFor(async () => (await page.locator('.node .pod[data-pod^="leaky-"] .pod-status').textContent().catch(() => "")) === "Running", "leaky Running", 30000);
await page.locator("button", { hasText: "+1분" }).click();
await page.locator("button", { hasText: "+1분" }).click();
await page.waitForTimeout(400);
const useW = await page.locator(".node .res-use").nth(1).evaluate((e) => parseFloat(e.style.width));
check(useW > 25, `2분 뒤 노드 memory 실사용 선이 requests 와 따로 차오른다 (${useW.toFixed(0)}%)`, "view.ts NodeView.memory.actual / Canvas ResBar");
await page.locator(".tree-row", { hasText: "worker-1" }).first().click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/23-node-usage.png` });

// 15b) Ingress 를 화면에서 만들고 고치기
console.log("15b) Ingress 만들기");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="service"]');
await page.locator('button[aria-label="Ingress 추가"]').click();
await waitFor(async () => (await page.locator('[data-tree="ingress/web"]').count()) === 1, "Ingress web 이 목록에", 5000);
check(true, "+ Ingress 로 Service web 을 가리키는 Ingress 가 생긴다");
await page.locator(".tabs button", { hasText: "설정" }).click();
check((await page.locator(".insp-body select.input").first().inputValue()) === "tailscale", "ingress-nginx 가 없으면 tailscale 클래스로 만든다", "ingressForm.ts newIngress");
await page.locator(".insp-body select.input").first().selectOption("nginx");
await waitFor(async () => (await page.locator(".callout", { hasText: "ingress-nginx 컨트롤러가 없습니다" }).count()) === 1, "컨트롤러 없음 안내", 5000);
check(true, "nginx 로 바꾸면 컨트롤러가 없다는 안내와 설치 단추");
await page.locator("button", { hasText: "규칙 더하기" }).click();
check((await page.locator(".rule-row").count()) === 1, "규칙 더하기로 규칙 줄이 생긴다", "Inspector IngressSettings");
await page.locator(".rule-row .input").first().fill("Bad_Host");
await page.locator(".rule-row .input").first().press("Enter");
check((await page.locator(".rule-row .field-err").count()) === 1, "잘못된 Host 는 확정하지 않고 이유를 보인다", "ingressForm.ts hostError");
await page.locator(".rule-row .input").first().fill("web.example.com");
await page.locator(".rule-row .input").first().press("Enter");
await page.screenshot({ path: `${OUT}/23b-ingress-settings.png` });
await page.locator("button", { hasText: "ingress-nginx 설치" }).click();
await page.selectOption(".transport .speed", "10");
await waitFor(async () => ((await page.locator('[data-tree="service/ingress-nginx-controller"]').count()) === 1), "컨트롤러 Service", 5000);
await page.locator(".tabs button", { hasText: "개요" }).click();
await waitFor(async () => (await page.locator(".insp-body .rows").textContent())?.includes("192.168.0.240"), "Ingress ADDRESS", 30000);
check(true, "ingress-nginx 를 설치하면 Ingress 에 LoadBalancer IP 가 붙는다");
await waitFor(async () => (await page.locator('[data-tree="service/ingress-nginx-controller"] .tree-count').textContent()) === "1", "컨트롤러 엔드포인트 ready", 30000);
await page.waitForTimeout(300); // kube-proxy 규칙 반영 1초 (10× 속도)
await page.locator("button", { hasText: "바깥에서 curl http://web.example.com/" }).click();
await page.waitForTimeout(300);
check((await page.locator(".drawer").textContent())?.includes("Welcome to nginx"), "만든 Ingress 로 바깥에서 web 까지 닿는다", "ingress.ts / request.ts viaIngressNginx");
await page.screenshot({ path: `${OUT}/23c-ingress-created.png` });

// 15c) 설정: ConfigMap·Secret
console.log("15c) ConfigMap·Secret");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="config-env"]');
await page.selectOption(".transport .speed", "5");
await waitFor(async () => (await page.locator('.node .pod[data-pod^="app-"] .pod-status').textContent().catch(() => "")) === "Running", "app Running", 30000);
await waitFor(async () => (await page.locator('[data-tree="service/app"] .tree-count').textContent()) === "1", "app 엔드포인트", 20000);
await page.waitForTimeout(400);
await page.locator(".try", { hasText: "설정 보기" }).first().locator("button").click();
await page.waitForTimeout(300);
check((await page.locator(".drawer").textContent())?.includes("env  GREETING=hello"), "설정 앱이 env·파일 값을 보여 준다", "request.ts configBody / kubelet containerConfig");
await page.locator('[data-tree="configmap/app-config"]').click();
await page.locator(".tabs button", { hasText: "개요" }).click();
check((await page.locator(".config-users").first().textContent())?.includes("subPath"), "ConfigMap 개요에 쓰는 곳(env·파일·subPath)", "Inspector ConfigOverview / configUse.ts");
await page.locator(".tabs button", { hasText: "설정" }).click();
const gIn = page.locator('.kv-row[data-key="GREETING"] input');
await gIn.click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("안녕");
await page.keyboard.press("Enter");
await waitFor(async () => (await page.evaluate(() => document.querySelector('.kv-row[data-key="GREETING"] input')?.value)) === "안녕", "매니페스트에 반영", 5000);
await page.locator('.node .pod[data-pod^="app-"]').first().click();
await page.locator(".tabs button", { hasText: "개요" }).click();
await page.waitForTimeout(200);
check((await page.locator(".insp-body .small-term").textContent())?.includes("GREETING=hello"), "ConfigMap 을 바꿔도 돌고 있는 Pod 의 env 는 그대로 보인다", "Inspector PodConfig");
await page.screenshot({ path: `${OUT}/23d-config-pod.png` });

await page.click(".menu-btn");
await page.click('.menu-item[data-example="config-missing"]');
await waitFor(async () => (await statusTexts()).includes("CreateContainerConfigError"), "CreateContainerConfigError", 30000);
check((await statusTexts()).includes("ContainerCreating"), "없는 ConfigMap(env)·Secret(volume): CreateContainerConfigError 와 ContainerCreating", "kubelet.ts start/mount");
await page.locator('[data-tree="secret/db"]').click();
check((await page.locator(".kv-list").textContent())?.includes("••••••"), "Secret 값은 기본으로 가린다", "Inspector ConfigOverview");
await page.locator("button", { hasText: "값 보기" }).click();
check((await page.locator(".kv-list").textContent())?.includes("s3cr3t!"), "값 보기로 base64 를 풀어 보인다", "Inspector ConfigOverview b64decode");
await page.screenshot({ path: `${OUT}/23e-secret.png` });

// 16) 패널 크기: 인스펙터 폭·서랍 높이 끌기, 접기·펴기, 저장
console.log("16) 패널 크기");
await page.click(".menu-btn");
await page.click('.menu-item[data-example="basics"]');
const inspW = () => page.locator(".inspector-frame").evaluate((e) => e.getBoundingClientRect().width);
const drawerH = () => page.locator(".drawer").evaluate((e) => e.getBoundingClientRect().height);
const dragBy = async (sel, dx, dy) => {
  const b = await page.locator(sel).boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
};
const w0 = await inspW();
await dragBy(".inspector-resize", -200, 0);
const w1 = await inspW();
check(Math.abs(w1 - (w0 + 200)) <= 2, `인스펙터 왼쪽 가장자리를 끌면 폭이 바뀐다 (${Math.round(w0)} → ${Math.round(w1)})`, "Inspector.tsx Inspector onMove / store setInspectorWidth");
if (!(await page.locator(".drawer.open").count())) await page.locator(".drawer-toggle").click();
const h0 = await drawerH();
await dragBy(".drawer-resize", 0, -150);
const h1 = await drawerH();
check(Math.abs(h1 - (h0 + 150)) <= 2, `서랍 위쪽 가장자리를 끌면 높이가 바뀐다 (${Math.round(h0)} → ${Math.round(h1)})`, "Drawer.tsx onMove / store setDrawerHeight");
await dragBy(".drawer-resize", 0, -2000);
const top = await page.locator(".drawer").evaluate((e) => e.getBoundingClientRect().top);
check(top >= 44 && top <= 48, `끝까지 올려도 상단바 아래에서 멈춘다 (top ${Math.round(top)})`, "store drawerMaxHeight");
const onTop = await page.evaluate(() => {
  const t = document.querySelector(".drawer-toggle").getBoundingClientRect();
  return document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2)?.closest(".drawer-toggle, .inspector-tools")?.className ?? "";
});
check(onTop.includes("drawer-toggle"), "끝까지 올린 서랍의 접기 단추를 인스펙터 도구가 가리지 않는다", "styles.css .inspector-frame isolation/overflow");
await page.screenshot({ path: `${OUT}/24-panels-resized.png` });
await page.reload();
await page.evaluate(() => document.fonts.ready);
check(Math.abs((await inspW()) - w1) <= 2, "새로고침해도 인스펙터 폭이 남는다", "store UiPrefs inspectorWidth");
await page.locator(".drawer-resize").dblclick();
check(Math.abs((await drawerH()) - (36 + 260)) <= 2, "서랍 손잡이를 두 번 누르면 기본 높이", "store toggleDrawerMax");
await page.keyboard.press("ControlOrMeta+Backslash");
check((await page.locator(".inspector-frame.collapsed").count()) === 1 && (await inspW()) <= 41, "⌘\\ 로 인스펙터를 접으면 레일만 남는다", "App.tsx onKey Backslash / Inspector collapsed");
await page.screenshot({ path: `${OUT}/25-inspector-collapsed.png` });
await page.locator(".inspector-frame.collapsed .icon-btn").click();
check(Math.abs((await inspW()) - w1) <= 2, "레일 단추로 펴면 접기 전 폭으로", "Inspector collapsed button");
await dragBy(".inspector-resize", 2000, 0);
check((await page.locator(".inspector-frame.collapsed").count()) === 1, "오른쪽 끝까지 끌면 접힌다", "Inspector onMove INSPECTOR_MIN - 70");
await page.locator(".inspector-frame.collapsed .icon-btn").click();
await page.locator(".inspector-tools .icon-btn").first().click();
check(Math.abs((await inspW()) - 340) <= 2 || Math.abs((await inspW()) - 560) <= 2, "넓게 단추로 보통/넓게를 오간다", "store toggleInspectorWide");
await dragBy(".drawer-resize", 0, 2000);
check((await page.locator(".drawer.open").count()) === 0, "서랍을 아래 끝까지 끌면 접힌다", "Drawer onMove DRAWER_MIN - 70");
await page.locator(".drawer-toggle").click();
await page.evaluate(() => localStorage.clear());

check(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(" | ")}` : ""}`, "콘솔 오류의 스택을 보고 고치세요");
console.log(failed ? "ui-check 실패" : "ui-check 통과 — 스크린샷: .shots/");
await done(failed ? 1 : 0);
