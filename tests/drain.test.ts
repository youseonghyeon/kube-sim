import { describe, expect, test } from "vitest";
import { deployment, pdb } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const readyWeb = (c: ReturnType<typeof cluster>) =>
  pods(c).filter((p) => p.metadata.labels.app === "web" && p.metadata.deletionTimestamp === undefined && p.status.conditions.find((x) => x.type === "Ready")?.status === "True").length;

function setup(minAvailable: number) {
  const c = cluster([{ name: "w1" }, { name: "w2" }, { name: "w3" }]);
  c.apply(deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 100, memory: 64, nodeSelector: undefined }));
  c.apply(pdb("web-pdb", { app: "web" }, { minAvailable }));
  c.runFor(15_000);
  return c;
}

describe("PodDisruptionBudget 와 kubectl drain", () => {
  test("disruption 컨트롤러가 허용 수를 계산한다 (get pdb)", () => {
    const c = setup(2);
    expect(k(c, "get pdb").output).toMatch(/^NAME\s+MIN AVAILABLE\s+MAX UNAVAILABLE\s+ALLOWED DISRUPTIONS\s+AGE\nweb-pdb\s+2\s+N\/A\s+1\s+\d+s$/);
  });

  test("drain: 한 노드의 Pod 를 PDB 를 지키며 내보내고 끝에 drained (Ready 는 2 밑으로 안 떨어짐)", () => {
    const c = setup(2);
    // 노드 하나에 Pod 두 개가 오도록 w3 를 먼저 비우고 다시 만든다
    k(c, "cordon w3");
    const onW3 = pods(c).find((p) => p.spec.nodeName === "w3");
    if (onW3) k(c, `delete pod ${onW3.metadata.name}`);
    c.runFor(15_000);
    k(c, "uncordon w3");
    const node = ["w1", "w2"].find((n) => pods(c).filter((p) => p.spec.nodeName === n && p.metadata.deletionTimestamp === undefined).length === 2)!;
    expect(node).toBeDefined();
    const r = k(c, `drain ${node} --ignore-daemonsets`);
    expect(r.ok).toBe(true);
    expect(r.drain!.lines[0]).toBe(`node/${node} cordoned`);
    let minReady = 3;
    for (let t = 0; t < 60_000 && !r.drain!.done; t += 100) {
      c.runFor(100);
      minReady = Math.min(minReady, readyWeb(c));
    }
    expect(r.drain!.done).toBe(true);
    expect(r.drain!.lines.at(-1)).toBe(`node/${node} drained`);
    // 두 번째 Pod 는 첫 번째의 대체 Pod 가 Ready 가 될 때까지 거절됐다가 5초 뒤 다시 시도
    expect(r.drain!.lines.some((l) => /^error when evicting pods\/"[\w-]+" -n "default" \(will retry after 5s\): Cannot evict pod as it would violate the pod's disruption budget\.$/.test(l))).toBe(true);
    expect(minReady).toBeGreaterThanOrEqual(2);
    expect(pods(c).filter((p) => p.spec.nodeName === node)).toHaveLength(0);
    c.runFor(15_000); // 마지막 대체 Pod 가 Ready 가 될 때까지
    expect(readyWeb(c)).toBe(3);
  });

  test("minAvailable 이 replicas 와 같으면 drain 이 끝나지 않는다 (10분 뒤 포기 — 축소판)", () => {
    const c = setup(3);
    const node = pods(c)[0]!.spec.nodeName!;
    const r = k(c, `drain ${node}`);
    c.runFor(700_000);
    expect(r.drain!.failed).toBe(true);
    expect(r.drain!.lines.filter((l) => l.includes("Cannot evict pod")).length).toBeGreaterThan(10);
    expect(pods(c).some((p) => p.spec.nodeName === node)).toBe(true);
  });

  test("kubectl create pdb · delete pdb", () => {
    const c = cluster([{ name: "w1" }]);
    expect(k(c, "create pdb x --selector=app=web --max-unavailable=1").output).toBe("poddisruptionbudget.policy/x created");
    expect(k(c, "create pdb y --selector=app=web").output).toBe("error: one of min-available or max-unavailable must be specified");
    expect(k(c, "delete pdb x").output).toBe('poddisruptionbudget.policy "x" deleted');
  });
});
