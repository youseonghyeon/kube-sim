import { describe, expect, test } from "vitest";
import { deployment, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

function setup(preStop?: number) {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.apply(deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, preStop }));
  c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
  c.apply(service("web", { selector: { app: "web" }, port: 80 }));
  c.runFor(15_000);
  const client = pods(c).find((p) => p.metadata.labels.app === "client")!.metadata.name;
  const t = c.startTraffic(client, "http://web", 100);
  return { c, t };
}
const victim = (c: ReturnType<typeof cluster>) => pods(c).find((p) => p.metadata.labels.app === "web" && p.metadata.deletionTimestamp === undefined)!.metadata.name;

describe("종료 순서: 엔드포인트가 빠지기 전에 앱이 멈추면 요청이 실패한다", () => {
  test("preStop 이 없으면 Pod 하나를 지울 때 요청 일부가 실패 (SIGTERM 이 규칙 반영보다 빠름)", () => {
    const { c, t } = setup();
    c.runFor(2000);
    expect(t.fail).toBe(0);
    runKubectl(c, `delete pod ${victim(c)}`);
    c.runFor(5000);
    expect(t.fail).toBeGreaterThan(0);
    expect(t.samples.filter((s) => !s.ok).every((s) => /연결 거부|사라진|없음/.test(s.reason ?? ""))).toBe(true);
  });

  test("preStop sleep 5초면 실패가 없다 (그사이 모든 노드의 규칙에서 빠짐)", () => {
    const { c, t } = setup(5);
    c.runFor(2000);
    runKubectl(c, `delete pod ${victim(c)}`);
    c.runFor(15_000);
    expect(t.fail).toBe(0);
    expect(t.ok).toBeGreaterThan(100);
  });

  test("롤링 업데이트도 preStop 이 없으면 실패가 생기고, 있으면 없다", () => {
    const a = setup();
    runKubectl(a.c, "set image deployment/web web=nginx:1.28");
    a.c.runFor(40_000);
    expect(a.t.fail).toBeGreaterThan(0);
    const b = setup(5);
    runKubectl(b.c, "set image deployment/web web=nginx:1.28");
    b.c.runFor(60_000);
    expect(b.t.fail).toBe(0);
    expect(pods(b.c).filter((p) => p.metadata.labels.app === "web").every((p) => p.spec.containers[0]!.image === "nginx:1.28")).toBe(true);
  });

  test("preStop 이 유예 시간을 넘으면 SIGKILL", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, preStop: 40 }));
    c.runFor(10_000);
    const p = pods(c)[0]!.metadata.name;
    runKubectl(c, `delete pod ${p}`);
    c.runFor(29_000);
    expect(c.api.get("Pod", p)).toBeDefined();
    c.runFor(2000);
    expect(c.api.get("Pod", p)).toBeUndefined();
    expect(c.trace.events.some((e) => e.msg.includes("SIGKILL"))).toBe(true);
  });
});

describe("liveness probe", () => {
  test("앱이 멈추면 3번 연속 실패 뒤 컨테이너를 다시 띄우고, 재시작으로 낫는다", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("api", { replicas: 1, image: "example/api:1.1", cpu: 100, memory: 64, port: 8080, liveness: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 5 } }));
    c.runFor(20_000);
    const p = pods(c)[0]!;
    c.setPodHealth(p.metadata.name, false);
    c.runFor(20_000);
    const now = c.api.get("Pod", p.metadata.name)!;
    expect(now.status.containerStatuses[0]!.restartCount).toBe(1);
    expect(c.api.eventsFor(p.metadata.uid).some((e) => e.message === "Container api failed liveness probe, will be restarted")).toBe(true);
    expect(c.podSick(p.metadata.name)).toBe(false);
    c.runFor(60_000);
    expect(c.api.get("Pod", p.metadata.name)!.status.containerStatuses[0]!.restartCount).toBe(1);
  });

  test("liveness 포트가 틀리면 계속 죽였다 살린다 → CrashLoopBackOff", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("api", { replicas: 1, image: "example/api:1.1", cpu: 100, memory: 64, port: 8080, liveness: { httpGet: { path: "/healthz", port: 80 }, periodSeconds: 3 } }));
    c.runFor(120_000);
    expect(runKubectl(c, "get pods").output).toMatch(/CrashLoopBackOff|Running/);
    expect(pods(c)[0]!.status.containerStatuses[0]!.restartCount).toBeGreaterThanOrEqual(3);
    expect(c.api.eventsFor(pods(c)[0]!.metadata.uid).find((e) => e.reason === "Unhealthy")!.message).toMatch(/^Liveness probe failed: Get "http:\/\/10\.244\.\d\.\d+:80\/healthz": dial tcp .*connection refused$/);
  });
});
