// 5d: StatefulSet + PVC(local-path) — 고정 이름·순서·자기 디스크, 노드에 묶인 디스크, headless DNS.
import { describe, expect, test } from "vitest";
import { deployment, service, statefulSet } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const traceOf = (c: C, kind: string, from = 0) => c.trace.events.slice(from).filter((e) => e.kind === kind);
const pod = (c: C, name: string) => c.api.get("Pod", name);

function db(c: C, replicas = 3) {
  c.apply(service("db", { selector: { app: "db" }, port: 8080, headless: true }));
  c.apply(statefulSet("db", { replicas, image: "example/kv:1.0", cpu: 100, memory: 64, port: 8080, storage: [{ name: "data", mountPath: "/data", size: 1024 }] }));
  c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
}
const client = (c: C) => pods(c).find((p) => p.metadata.labels.app === "client")!.metadata.name;
const curl = (c: C, target: string) => c.requestFromPod(client(c), "curl", target);
const visits = (c: C, host: string) => /visits=(\d+)/.exec(curl(c, `http://${host}:8080`).output)?.[1];

describe("StatefulSet: 고정 이름·순서·자기 디스크", () => {
  test("OrderedReady: db-0 이 Running·Ready 가 된 뒤에야 db-1 — Pod 마다 PVC, 고른 노드에 PV 를 만들어 묶는다", () => {
    const c = cluster();
    db(c);
    c.runFor(60_000);
    expect(pods(c).filter((p) => p.metadata.labels.app === "db").map((p) => p.metadata.name)).toEqual(["db-0", "db-1", "db-2"]);
    const created = traceOf(c, "controller.reconcile").filter((e) => e.actor === "statefulset-controller" && e.msg.includes(" 생성 ("));
    expect(created.map((e) => /→ (db-\d) 생성/.exec(e.msg)?.[1])).toEqual(["db-0", "db-1", "db-2"]);
    const ready0 = traceOf(c, "kubelet.start").find((e) => e.msg.startsWith("db-0 "))!;
    expect(created[1]!.t).toBeGreaterThan(ready0.t); // db-0 이 뜬 뒤
    expect(created[0]!.msg).toContain("PVC data-db-0 생성");
    for (const i of [0, 1, 2]) {
      const pvc = c.api.get("PersistentVolumeClaim", `data-db-${i}`)!;
      expect(pvc.status.phase).toBe("Bound");
      const pv = c.api.get("PersistentVolume", pvc.spec.volumeName!)!;
      expect(pv.spec.nodeAffinity!.required.nodeSelectorTerms[0]!.matchExpressions[0]!.values).toEqual([pod(c, `db-${i}`)!.spec.nodeName]);
    }
    expect(c.api.events.some((e) => e.reason === "WaitForFirstConsumer" && e.message === "waiting for first consumer to be created before binding")).toBe(true);
    expect(kubectl(c, "kubectl get sts").output).toMatch(/db\s+3\/3\s+/);
    expect(kubectl(c, "kubectl get pvc").output).toMatch(/data-db-0\s+Bound\s+pvc-\S+\s+1Gi\s+RWO\s+local-path\s+<unset>/);
    expect(kubectl(c, "kubectl get sc").output).toMatch(/local-path \(default\)\s+rancher\.io\/local-path\s+Delete\s+WaitForFirstConsumer\s+false/);
  });

  test("지운 Pod 는 같은 이름·같은 PVC 로 돌아와 데이터가 남는다", () => {
    const c = cluster();
    db(c);
    c.runFor(60_000);
    expect(visits(c, "db-1.db")).toBe("1");
    expect(visits(c, "db-1.db")).toBe("2");
    const uid = pod(c, "db-1")!.metadata.uid;
    kubectl(c, "kubectl delete pod db-1");
    c.runFor(30_000);
    expect(pod(c, "db-1")!.metadata.uid).not.toBe(uid);
    expect(visits(c, "db-1.db")).toBe("3");
    expect(visits(c, "db-0.db")).toBe("1"); // db-0 은 자기 디스크
  });

  test("줄이면 큰 번호부터, PVC 는 남고 다시 늘리면 그 데이터로", () => {
    const c = cluster();
    db(c);
    c.runFor(60_000);
    visits(c, "db-2.db");
    visits(c, "db-2.db");
    const from = c.trace.events.length;
    kubectl(c, "kubectl scale sts/db --replicas=1");
    c.runFor(30_000);
    const gone = traceOf(c, "controller.reconcile", from).filter((e) => e.msg.includes("부터 지움")).map((e) => /번호 (db-\d)/.exec(e.msg)?.[1]);
    expect(gone).toEqual(["db-2", "db-1"]);
    expect(c.api.list("PersistentVolumeClaim")).toHaveLength(3);
    kubectl(c, "kubectl scale statefulset db --replicas=3");
    c.runFor(60_000);
    expect(visits(c, "db-2.db")).toBe("3");
  });

  test("rollout restart: 큰 번호부터 하나씩 (db-2 → db-1 → db-0)", () => {
    const c = cluster();
    db(c);
    c.runFor(60_000);
    const from = c.trace.events.length;
    expect(kubectl(c, "kubectl rollout restart sts/db").output).toBe("statefulset.apps/db restarted");
    c.runFor(120_000);
    const order = traceOf(c, "controller.reconcile", from).filter((e) => e.msg.includes("템플릿이 바뀜")).map((e) => /: (db-\d) 을/.exec(e.msg)?.[1]);
    expect(order).toEqual(["db-2", "db-1", "db-0"]);
    expect(kubectl(c, "kubectl rollout status sts/db").output).toMatch(/^statefulset rolling update complete 3 pods at revision db-/);
  });
});

describe("headless Service DNS", () => {
  test("이름 하나에 ready Pod IP 여럿, Pod 마다 <이름>.<svc> — kube-proxy 를 거치지 않는다", () => {
    const c = cluster();
    db(c);
    c.runFor(60_000);
    const ns = c.requestFromPod(client(c), "nslookup", "db").output;
    expect(ns.match(/Address: 10\.244\./g)).toHaveLength(3);
    const r = curl(c, "http://db-0.db:8080");
    expect(r.servedBy).toBe("db-0");
    expect(r.steps[0]!.text).toContain("headless Service(clusterIP: None)");
    expect(r.steps.some((s) => s.kind === "dnat")).toBe(false);
    expect(kubectl(c, "kubectl get svc db").output).toMatch(/db\s+ClusterIP\s+None/);
    expect(() => c.apply(service("bad", { selector: { app: "db" }, port: 80, type: "NodePort", headless: true }))).toThrow("may not be set to 'None' for NodePort services");
  });
});

describe("local-path 디스크는 노드에 묶인다", () => {
  test("노드가 죽으면: Terminating 에 멈춤(같은 이름이라 대신할 Pod 없음) → --force 로 지워도 디스크가 그 노드에 있어 Pending → 노드가 돌아오면 그 데이터로", () => {
    const c = cluster();
    db(c, 1);
    c.runFor(60_000);
    const node = pod(c, "db-0")!.spec.nodeName!;
    const other = node === "worker-1" ? "worker-2" : "worker-1";
    visits(c, "db-0.db");
    c.setNodePower(node, false);
    c.runFor(7 * 60_000);
    expect(pod(c, "db-0")!.metadata.deletionTimestamp).toBeDefined(); // eviction 됐지만 kubelet 이 없어 정리 못 함
    expect(traceOf(c, "controller.reconcile").some((e) => e.msg.includes("db-0 의 옛 Pod 가 아직 지워지는 중") || e.msg.includes("db-0 이(가) 지워지는 중"))).toBe(true);
    kubectl(c, "kubectl delete pod db-0 --force --grace-period=0");
    c.runFor(30_000);
    const p = pod(c, "db-0")!;
    expect(p.spec.nodeName).toBeUndefined();
    const fs = c.api.events.filter((e) => e.reason === "FailedScheduling" && e.involvedObject.uid === p.metadata.uid).at(-1)!;
    expect(fs.message).toContain("1 node(s) had volume node affinity conflict");
    expect(fs.message).toContain(other === "worker-2" ? "1 node(s) had untolerated taint" : "untolerated taint");
    c.setNodePower(node, true);
    c.runFor(60_000);
    expect(pod(c, "db-0")!.spec.nodeName).toBe(node);
    expect(visits(c, "db-0.db")).toBe("2");
  });
});

describe("볼륨 없는 Deployment 와 PVC 삭제", () => {
  test("Deployment(볼륨 없음): Pod 가 바뀌면 처음부터 · 컨테이너 재시작도", () => {
    const c = cluster();
    c.apply(deployment("kv", { replicas: 1, image: "example/kv:1.0", cpu: 50, memory: 64, port: 8080 }));
    c.apply(service("kv", { selector: { app: "kv" }, port: 8080 }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.runFor(20_000);
    expect(/visits=(\d+)/.exec(curl(c, "http://kv:8080").output)?.[1]).toBe("1");
    expect(curl(c, "http://kv:8080").output).toContain("visits=2\n저장: 컨테이너 안");
    kubectl(c, `kubectl delete pod ${pods(c).find((p) => p.metadata.labels.app === "kv")!.metadata.name}`);
    c.runFor(30_000);
    expect(curl(c, "http://kv:8080").output).toContain("visits=1");
  });

  test("PVC 를 지우면 PV 와 데이터도 (reclaimPolicy Delete) — 다시 늘리면 새 디스크", () => {
    const c = cluster();
    db(c, 2);
    c.runFor(60_000);
    visits(c, "db-1.db");
    kubectl(c, "kubectl scale sts/db --replicas=1");
    c.runFor(20_000);
    const pv = c.api.get("PersistentVolumeClaim", "data-db-1")!.spec.volumeName!;
    expect(kubectl(c, "kubectl delete pvc data-db-1").ok).toBe(true);
    c.runFor(1_000);
    expect(c.api.get("PersistentVolume", pv)).toBeUndefined();
    expect(c.volumeData.has(pv)).toBe(false);
    kubectl(c, "kubectl scale sts/db --replicas=2");
    c.runFor(60_000);
    expect(visits(c, "db-1.db")).toBe("1");
  });

  test("없는 PVC 를 쓰는 Pod: FailedScheduling persistentvolumeclaim not found", () => {
    const c = cluster();
    const m = deployment("x", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32 });
    m.spec.template.spec.volumes = [{ name: "d", persistentVolumeClaim: { claimName: "nope" } }];
    c.apply(m);
    c.runFor(10_000);
    expect(c.api.events.some((e) => e.reason === "FailedScheduling" && e.message === '0/2 nodes are available: persistentvolumeclaim "nope" not found.')).toBe(true);
  });
});

describe("예제 '상태 있는 앱' 이 학습 포인트를 실제로 보여 준다", () => {
  const load = async (id: string) => {
    const { DefSync } = await import("../src/model/defSync");
    const { exampleById } = await import("../src/model/examples");
    const s = new DefSync();
    s.reset(exampleById(id)!.build(), id);
    s.cluster.runFor(60_000);
    return s.cluster;
  };

  test("sts-node-down: db-0 은 worker-1 · 끄면 Terminating 멈춤 → --force → volume node affinity conflict → 켜면 데이터 그대로", async () => {
    const c = await load("sts-node-down");
    expect(pod(c, "db-0")!.spec.nodeName).toBe("worker-1");
    expect(visits(c, "db-0.db")).toBe("1");
    c.setNodePower("worker-1", false);
    c.runFor(7 * 60_000);
    expect(kubectl(c, "kubectl get pods").output).toMatch(/db-0\s+1\/1\s+Terminating/);
    expect(kubectl(c, "kubectl delete pod db-0 --force --grace-period=0").ok).toBe(true);
    c.runFor(20_000);
    expect(kubectl(c, "kubectl describe pod db-0").output).toContain("1 node(s) had volume node affinity conflict");
    c.setNodePower("worker-1", true);
    c.runFor(60_000);
    expect(visits(c, "db-0.db")).toBe("2");
  });

  test("deployment-db: Pod 를 지우면 visits 가 처음부터", async () => {
    const c = await load("deployment-db");
    const kv = () => /visits=(\d+)/.exec(c.requestFromPod(client(c), "curl", "http://kv:8080").output)?.[1];
    expect(kv()).toBe("1");
    expect(kv()).toBe("2");
    kubectl(c, `kubectl delete pod ${pods(c).find((p) => p.metadata.labels.app === "kv")!.metadata.name}`);
    c.runFor(30_000);
    expect(kv()).toBe("1");
  });
});
