// 리뷰 11: 화면(src/app)·모델 결함 재현 (Playwright). scripts/ui-check.mjs 와 같은 틀 — Vite 를 5198 포트로 띄우고 .shots/review11/ 에 스크린샷.
// 실행: node scripts/review11-ui.mjs   (실패한 검사는 "문제/해결/참조" 세 줄로 찍는다)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";

const OUT = ".shots/review11";
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: "silent" });
await server.listen();
const URL = server.resolvedUrls.local[0];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

let failed = 0;
function check(cond, what, fix, ref) {
  if (cond) {
    console.log(`  ok  ${what}`);
    return;
  }
  failed++;
  console.log(`문제: ${what}`);
  console.log(`해결: ${fix}`);
  console.log(`참조: ${ref ?? "scripts/review11-ui.mjs"} · 스크린샷 ${OUT}/`);
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

const statusTexts = () => page.locator(".node .pod .pod-status").allTextContents();
async function waitFor(fn, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeout) throw new Error(`timeout: ${what}`);
    await page.waitForTimeout(100);
  }
}
const lastOut = () => page.locator(".term-res").last().textContent();
async function pickExample(id, speed = "5") {
  await page.click(".menu-btn");
  await page.click(`.menu-item[data-example="${id}"]`);
  await page.selectOption(".transport .speed", speed);
}

// ---------- 1) 손상된 저장 정의로 시작 → 화면이 떠야 한다 ----------
console.log("1) 손상된 localStorage 정의");
await page.goto(URL);
await page.evaluate(() => {
  localStorage.clear();
  // 옛 버전·손으로 고친 매니페스트: resources 가 없는 Deployment (isDef 는 nodes 만 검사한다)
  localStorage.setItem(
    "kube-sim.def.v1",
    JSON.stringify({
      exampleId: null,
      def: {
        nodes: [{ name: "worker-1", cpu: 2000, memory: 4096 }],
        manifests: [{ kind: "Deployment", metadata: { name: "old" }, spec: { replicas: 1, selector: { matchLabels: { app: "old" } }, template: { metadata: { labels: { app: "old" } }, spec: { containers: [{ name: "old", image: "nginx:1.27" }] } } } }],
      },
    }),
  );
});
errors.length = 0;
await page.reload();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/01-corrupt-def.png` });
check(
  (await page.locator(".app .topbar").count()) === 1 && !errors.some((e) => e.includes("pageerror")),
  `깨진 매니페스트가 저장돼 있어도 화면이 뜬다 (오류: ${errors[0] ?? "없음"})`,
  "store.ts isDef 가 매니페스트 모양도 검사하거나, DefSync.sync 가 apply 의 TypeError 도 잡아 '매니페스트 적용 실패' 로 남기고 넘어가게. 지금은 SimController 생성자에서 터져 빈 화면 + 새로고침해도 복구 안 됨",
  "src/model/store.ts isDef · src/model/defSync.ts sync · src/model/sim.ts constructor",
);

// 정상 상태로 되돌리기
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => (document.documentElement.dataset.theme = "light"));

// ---------- 2) kubectl 창에 echo … | base64 -d 를 직접 치면 ----------
console.log("2) kubectl 창 입력 접두사");
await pickExample("config-missing", "5");
await page.locator(".drawer-head [role=tab]", { hasText: "kubectl" }).click();
await page.fill(".term-in input", "echo czNjcjN0IQ== | base64 -d");
await page.press(".term-in input", "Enter");
await page.waitForTimeout(200);
check(
  (await lastOut())?.trim() === "s3cr3t!",
  `예제 '해 볼 것' 에 적힌 대로 'echo czNjcjN0IQ== | base64 -d' 를 kubectl 창에 치면 s3cr3t! 가 나온다 (실제: ${(await lastOut())?.split("\n")[0]})`,
  "Drawer.tsx KubectlView run(): /^(kubectl|k|curl|argocd|git)/ 에 echo 도 넣거나 commandKind() 로 판단한 뒤 kubectl 접두사를 붙인다",
  "src/app/Drawer.tsx run()",
);

// ArrowUp 으로 불러온 curl 명령은 "(클러스터 밖에서) " 가 붙어 다시 실행되지 않는다
await pickExample("source-ip", "5");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 1, "who Running");
await page.waitForTimeout(800);
await page.locator(".drawer-head [role=tab]", { hasText: "kubectl" }).click();
await page.fill(".term-in input", "curl http://192.168.0.240/");
await page.press(".term-in input", "Enter");
await page.waitForTimeout(300);
const firstCurl = await lastOut();
await page.press(".term-in input", "ArrowUp");
const recalled = await page.inputValue(".term-in input");
await page.press(".term-in input", "Enter");
await page.waitForTimeout(300);
const second = await lastOut();
await page.screenshot({ path: `${OUT}/02-history-recall.png` });
check(
  !second?.includes("unknown command") && (second?.includes("RemoteAddr") || second?.includes("Hostname")),
  `↑ 로 불러온 curl 명령을 다시 실행해도 같은 결과 (불러온 글: "${recalled}" · 결과: ${second?.split("\n")[0]})`,
  "KubectlView: 기록에는 사용자가 친 원문(command)을 따로 저장하거나 ↑ 에서 '(클러스터 밖에서) ' 접두사를 벗긴다",
  "src/app/Drawer.tsx KubectlView onKeyDown / src/model/sim.ts kubectl() entry.command",
);
check(firstCurl?.includes("RemoteAddr"), "(전제) 처음 친 curl 은 된다", "-", "-");

// ---------- 3) readiness: 인스펙터로 두 번째 Pod 를 고장 내면 해 볼 것의 '고치기' 가 비활성 ----------
console.log("3) sick 동작 대상 불일치");
await pickExample("readiness", "10");
await waitFor(async () => (await page.locator(".svc .svc-eps").textContent())?.startsWith("엔드포인트 ready 3"), "api ready 3", 40000);
const apiPods = page.locator('.node .pod[data-pod^="api-"]');
await apiPods.nth(1).click();
await page.locator(".actions .btn", { hasText: "앱 고장 내기" }).click();
await page.waitForTimeout(200);
await page.locator(".insp-close").click();
await page.waitForTimeout(200);
const healBtn = page.locator(".try", { hasText: "고치기" }).locator("button");
const healDisabled = await healBtn.isDisabled();
const healTitle = await healBtn.getAttribute("title");
await page.screenshot({ path: `${OUT}/03-sick-mismatch.png` });
check(!healDisabled, `두 번째 api Pod 를 고장 낸 뒤 해 볼 것 '고치기' 단추가 켜져 있다 (지금: disabled=${healDisabled}, title="${healTitle}")`, "sim.ts actionPod: healthy=true 면 고장 난 Pod 중 첫째를, healthy=false 면 멀쩡한 Pod 중 첫째를 고른다", "src/model/sim.ts actionBlocked/actionPod");

// ---------- 4) StatefulSet 설정의 이미지 자동완성 목록 ----------
console.log("4) StatefulSet 설정 datalist");
await pickExample("sts-basics", "5");
await page.locator('[data-tree="statefulset/db"]').click();
await page.locator(".tabs button", { hasText: "설정" }).click();
await page.waitForTimeout(100);
const listId = await page.locator(".insp-body input[list]").first().getAttribute("list");
const hasList = await page.evaluate((id) => !!document.getElementById(id), listId ?? "");
check(hasList, `StatefulSet 이미지 칸의 datalist(#${listId}) 가 문서에 있다 (Deployment 설정 안에서만 그려져 여기서는 없음)`, "datalist 를 Inspector 루트(또는 StsSettings 안)에도 그린다", "src/app/Inspector.tsx DeploymentSettings/StsSettings");

// ---------- 5) 1280×800 다크 테마: 가로 넘침·대비 ----------
console.log("5) 다크 테마 1280×800");
await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
const overflowReport = [];
for (const id of ["gitops", "hpa-basics", "sts-basics", "netpol-egress", "ingress"]) {
  await pickExample(id, "10");
  await page.waitForTimeout(2500);
  await page.locator(".insp-close").click().catch(() => {});
  await page.screenshot({ path: `${OUT}/05-dark-${id}.png` });
  const over = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".sidebar, .sidebar .tree-row, .inspector, .inspector .rows, .cp-comp, .svc, .app-box, .git-box, .ingress, .try, .drawer")) {
      if (el.scrollWidth > el.clientWidth + 2) out.push(`${el.className.split(" ")[0]} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return out;
  });
  if (over.length) overflowReport.push(`${id}: ${[...new Set(over)].slice(0, 5).join(", ")}`);
}
check(overflowReport.length === 0, `1280×800 에서 목록·인스펙터·상자에 가로 넘침이 없다${overflowReport.length ? ` (${overflowReport.join(" | ")})` : ""}`, "넘치는 요소에 min-width:0 / overflow-wrap 을 준다", "src/app/styles.css");

// --ink-3 (.muted · .side-empty · .tree-kind · .tree-count · .menu-group-label …) 의 대비 — 11~12px 보조 글자가 많이 쓴다
const tokenContrast = () =>
  page.evaluate(() => {
    const lum = (c) => {
      const m = c.match(/\d+/g).map(Number);
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
    };
    // 토큰 값을 실제로 칠해 rgb 로 읽는다
    const probe = document.createElement("span");
    probe.className = "muted";
    probe.textContent = "x";
    document.querySelector(".sidebar").appendChild(probe);
    const fg = getComputedStyle(probe).color;
    const bg = getComputedStyle(document.querySelector(".sidebar")).backgroundColor;
    const size = getComputedStyle(document.querySelector(".side-empty, .tree-kind, .tree-count") ?? probe).fontSize;
    probe.remove();
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { fg, bg, size, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100 };
  });
const contrast = await tokenContrast();
check(contrast.ratio >= 4.5, `다크 테마 보조 글자(.muted/--ink-3) 대비 ≥ 4.5:1 (지금 ${contrast.ratio}:1, ${contrast.fg} on ${contrast.bg}, ${contrast.size})`, "--ink-3 를 다크 #8b93a1 안팎, 라이트 #7a818d 안팎으로 올리거나 .muted·.tree-kind 를 --ink-2 로", "src/app/styles.css :root[data-theme=dark] --ink-3 / .muted / .tree-kind / .side-empty");
await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
await page.waitForTimeout(100);
const contrastLight = await tokenContrast();
check(contrastLight.ratio >= 4.5, `라이트 테마 보조 글자(--ink-3) 대비 ≥ 4.5:1 (지금 ${contrastLight.ratio}:1, ${contrastLight.fg} on ${contrastLight.bg}, ${contrastLight.size})`, "위와 같음", "src/app/styles.css :root --ink-3");

// ---------- 6) 선택이 지워진 오브젝트를 가리킬 때 / 예제 전환 뒤 패널 / 첫 화면에 노드가 보이나 ----------
console.log("6) 선택·예제 전환·첫 화면");
await pickExample("basics", "5");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 3, "web Running");
await page.locator(".insp-close").click().catch(() => {});
await page.evaluate(() => document.querySelector(".canvas")?.scrollTo(0, 0));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/06-first-screen-1280x800.png` });
const nodeVisible = await page.evaluate(() => {
  const canvas = document.querySelector(".canvas").getBoundingClientRect();
  const node = document.querySelector(".node")?.getBoundingClientRect();
  return node ? Math.round(Math.min(node.bottom, canvas.bottom) - node.top) : -1;
});
check(nodeVisible >= 80, `1280×800 기본 패널 크기에서 첫 화면(스크롤 전)에 노드 상자가 보인다 (보이는 높이 ${nodeVisible}px)`, "컨트롤 플레인이 2열로 접히는 폭에서는 상자 높이를 줄이거나(cp-last 한 줄), 서랍 기본 높이를 창 높이에 비례하게", "src/app/styles.css .cp-row / src/model/store.ts DRAWER_DEFAULT");
await page.locator(".node .pod").first().click();
await page.locator(".tabs button", { hasText: "설정" }).count(); // Pod 에는 설정 탭 없음
await page.locator(".tabs button", { hasText: "YAML" }).click();
await pickExample("pending", "5");
await page.waitForTimeout(300);
check((await page.locator(".insp-kind").first().textContent()) === "예제", "예제를 바꾸면 인스펙터가 예제 안내로 돌아온다", "store.loadExample selection=null", "src/model/store.ts");
// 지워진 Pod 를 가리키는 선택
await pickExample("basics", "5");
await waitFor(async () => (await statusTexts()).filter((s) => s === "Running").length === 3, "web Running");
await page.locator(".node .pod").first().click();
await page.locator(".tabs button", { hasText: "개요" }).click(); // 인스펙터는 마지막 탭(YAML)을 기억한다
await page.locator(".actions .btn", { hasText: "Pod 지우기" }).click();
await waitFor(async () => (await page.locator(".insp-body .note", { hasText: "지금 API 서버에 없습니다" }).count()) === 1 || (await page.locator(".insp-kind").first().textContent()) === "예제", "지워진 뒤 안내", 15000);
check(true, "지운 Pod 를 고른 채면 '없습니다' 안내 (크래시 없음)", "-", "-");

console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
console.log("page errors:", errors.length ? errors : "none");
await done(failed ? 1 : 0);
