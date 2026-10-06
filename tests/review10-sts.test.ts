// 리뷰 10: StatefulSet + PVC(local-path) 결함 재현 테스트. 모두 지금 코드에서 실패해야 한다 (고친 뒤 통과).
import { describe, expect, test } from "vitest";
import { deployment, service, statefulSet } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const sts = (replicas = 3, extra: { podManagementPolicy?: "OrderedReady" | "Parallel" } = {}) =>
  statefulSet("db", { replicas, image: "example/kv:1.0", cpu: 100, memory: 64, port: 8080, storage: [{ name: "data", mountPath: "/data", size: 1024 }], ...extra });
function db(c: C, replicas = 3, extra: { podManagementPolicy?: "OrderedReady" | "Parallel" } = {}, headless = true) {
  c.apply(service("db", { selector: { app: "db" }, port: 8080, headless }));
  c.apply(sts(replicas, extra));
  c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
}
const client = (c: C) => pods(c).find((p) => p.metadata.labels.app === "client")!.metadata.name;
const curl = (c: C, target: string) => c.requestFromPod(client(c), "curl", target);
const dbPods = (c: C) => pods(c).filter((p) => p.metadata.labels.app === "db");
const terminating = (c: C) => dbPods(c).filter((p) => p.metadata.deletionTimestamp !== undefined).map((p) => p.metadata.name);

describe("StatefulSet 컨트롤러", () => {
  test("Parallel: 줄일 때 기다리지 않고 한꺼번에 지운다 (실제: Parallel 은 terminate all Pods in parallel)", () => {
    const c = cluster();
    db(c, 3, { podManagementPolicy: "Parallel" });
    c.runFor(60_000);
    kubectl(c, "kubectl scale sts/db --replicas=0");
    c.runFor(300); // kv 는 SIGTERM 뒤 500ms 에 끝남 — 아직 모두 Terminating 이어야 한다
    expect(terminating(c).sort()).toEqual(["db-0", "db-1", "db-2"]);
  });

  test("OrderedReady: 축소와 템플릿 변경이 함께 와도 한 번에 Pod 하나만 지운다 (실제: 축소가 먼저, monotonic 이면 한 번에 하나)", () => {
    const c = cluster();
    db(c, 3);
    c.runFor(60_000);
    const m = sts(1);
    m.spec.template.metadata.annotations = { note: "v2" };
    c.apply(m);
    c.runFor(300);
    // 지금 코드: 2) 축소가 db-2 를 지우고 같은 reconcile 의 3) 롤링이 db-0 도 지운다 → 둘이 동시에 Terminating
    expect(terminating(c)).toEqual(["db-2"]);
  });

  test("kubectl apply 는 rollout restart 가 붙인 restartedAt 을 지키고 (3-way) 다시 롤링하지 않는다 — Deployment 와 같게", () => {
    const c = cluster();
    db(c, 2);
    c.runFor(60_000);
    kubectl(c, "kubectl rollout restart sts/db");
    c.runFor(120_000);
    const from = c.trace.events.length;
    c.apply(sts(3)); // 화면에서 replicas + 를 누른 것과 같다 (DefSync → apply)
    c.runFor(120_000);
    expect(c.api.get("StatefulSet", "db")!.spec.template.metadata.annotations?.["kubectl.kubernetes.io/restartedAt"]).toBeDefined();
    expect(c.trace.events.slice(from).filter((e) => e.msg.includes("템플릿이 바뀜"))).toHaveLength(0);
  });
});

describe("kubectl rollout status statefulset", () => {
  test("restart 직후(컨트롤러가 아직 못 봄): Waiting for statefulset spec update to be observed... — 'complete' 가 아니다", () => {
    const c = cluster();
    db(c, 2);
    c.runFor(60_000);
    kubectl(c, "kubectl rollout restart sts/db");
    const out = kubectl(c, "kubectl rollout status sts/db").output;
    expect(out).not.toMatch(/rolling update complete/);
    expect(out).toMatch(/^Waiting for statefulset spec update to be observed\.\.\./);
  });

  test("템플릿 변경 없이 줄이는 중에는 'waiting for statefulset rolling update' 가 아니다 (currentRevision == updateRevision)", () => {
    const c = cluster();
    db(c, 3);
    c.runFor(60_000);
    kubectl(c, "kubectl scale sts/db --replicas=1");
    c.runFor(200);
    expect(c.api.get("StatefulSet", "db")!.status.currentRevision).toBe(c.api.get("StatefulSet", "db")!.status.updateRevision);
    expect(kubectl(c, "kubectl rollout status sts/db").output).not.toMatch(/waiting for statefulset rolling update to complete/);
  });
});

describe("headless DNS", () => {
  test("<pod>.<svc> 레코드는 headless Service 일 때만 (serviceName 이 일반 ClusterIP Service 면 NXDOMAIN)", () => {
    const c = cluster();
    db(c, 2, {}, false); // serviceName 이 가리키는 db 가 headless 가 아님 — 흔한 실수
    c.runFor(60_000);
    const r = c.requestFromPod(client(c), "nslookup", "db-0.db");
    expect(r.ok).toBe(false);
  });
});

describe("스토리지", () => {
  test("kubectl delete pv (Bound): pv-protection 으로 PVC 가 있는 동안 PV 는 남고(Terminating) 데이터도 그대로", () => {
    const c = cluster();
    db(c, 1);
    c.runFor(60_000);
    const pv = c.api.get("PersistentVolumeClaim", "data-db-0")!.spec.volumeName!;
    expect(curl(c, "http://db-0.db:8080").output).toContain("visits=1");
    kubectl(c, `kubectl delete pv ${pv}`);
    c.runFor(5_000);
    // 지금 코드: PV 가 바로 사라지고 PVC 는 없는 PV 에 Bound 로 남으며, volumeData 는 고아로 남고 앱은 "컨테이너 안 (볼륨 없음)" 으로 바뀌어 visits=1 부터 다시
    expect(c.api.get("PersistentVolume", pv)).toBeDefined();
    const out = curl(c, "http://db-0.db:8080").output;
    expect(out).not.toContain("볼륨 없음");
    expect(out).toContain("visits=2");
  });

  test("kube-scheduler: Insufficient cpu 로 Pending 인 Pod 는 PVC·PV 이벤트로 다시 시도하지 않는다 (막은 플러그인이 등록한 이벤트만)", () => {
    const c = cluster();
    c.apply(deployment("big", { replicas: 1, image: "nginx:1.27", cpu: 5000, memory: 32 }));
    c.runFor(5_000);
    const big = pods(c).find((p) => p.metadata.labels.app === "big")!.metadata.name;
    const from = c.trace.events.length;
    db(c, 3);
    c.runFor(60_000);
    // 지금 코드: PVC 생김·selected-node·Bound·PV 생김마다 retryUnschedulable → big 이 9번 다시 실패 (트레이스 소음)
    expect(c.trace.events.slice(from).filter((e) => e.kind === "scheduler.fail" && e.msg.startsWith(big))).toHaveLength(0);
  });
});

describe("kubectl 출력", () => {
  test("kubectl get all 에 statefulset.apps 가 나온다", () => {
    const c = cluster();
    db(c, 1);
    c.runFor(30_000);
    expect(kubectl(c, "kubectl get all").output).toMatch(/statefulset\.apps\/db\s+1\/1/);
  });

  test("-o yaml 의 storage 는 수량 표기 (1Gi) — 1024 는 바이트로 읽힌다", () => {
    const c = cluster();
    db(c, 1);
    c.runFor(30_000);
    const pvc = kubectl(c, "kubectl get pvc data-db-0 -o yaml").output;
    expect(pvc).toContain("storage: 1Gi");
    expect(pvc).not.toContain('storage: "1024"');
    expect(kubectl(c, "kubectl get sts db -o yaml").output).toContain("storage: 1Gi");
  });
});
