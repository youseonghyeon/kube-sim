import { describe, expect, test } from "vitest";
import { deployment, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { iptablesProbability } from "../src/core/net/kubeproxy";
import { resolve } from "../src/core/net/request";
import { cluster, pods } from "./helpers";

function webWithService(replicas = 3) {
  const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
  c.apply(deployment("web", { replicas, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
  c.apply(service("web", { selector: { app: "web" }, port: 80 }));
  c.runFor(10_000);
  return c;
}
const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);

describe("Service · EndpointSlice · kube-proxy", () => {
  test("ClusterIP 를 받고, EndpointSlice 에 ready Pod IP 가 모인다", () => {
    const c = webWithService();
    const svc = c.api.get("Service", "web")!;
    expect(svc.spec.clusterIP).toMatch(/^10\.96\.0\.\d+$/);
    const slice = c.api.list("EndpointSlice")[0]!;
    expect(slice.metadata.labels["kubernetes.io/service-name"]).toBe("web");
    expect(slice.endpoints.map((e) => e.addresses[0]).sort()).toEqual(pods(c).map((p) => p.status.podIP).sort());
    expect(slice.endpoints.every((e) => e.conditions.ready)).toBe(true);
    expect(k(c, "get svc").output).toMatch(new RegExp(`^NAME\\s+TYPE\\s+CLUSTER-IP\\s+EXTERNAL-IP\\s+PORT\\(S\\)\\s+AGE\\nweb\\s+ClusterIP\\s+${svc.spec.clusterIP!.replace(/\./g, "\\.")}\\s+<none>\\s+80/TCP\\s+\\d+s$`));
    expect(k(c, "get endpoints web").output.split("\n")[1]).toMatch(/^web\s+10\.244\.\d\.\d+:80,10\.244\.\d\.\d+:80,10\.244\.\d\.\d+:80\s+\d+s$/);
  });

  test("노드마다 kube-proxy 가 같은 규칙을 쓴다 (iptables-save 모양, 확률 1/3 · 1/2)", () => {
    const c = webWithService();
    const a = c.kubeProxies.get("worker-1")!.iptablesSave();
    const b = c.kubeProxies.get("worker-2")!.iptablesSave();
    expect(a).toBe(b);
    expect(a).toMatch(/-A KUBE-SERVICES -d 10\.96\.0\.\d+\/32 -p tcp -m comment --comment "default\/web cluster IP" -m tcp --dport 80 -j KUBE-SVC-[A-Z2-7]{16}/);
    expect(a).toContain("--probability 0.33333333349");
    expect(a).toContain("--probability 0.50000000000");
    expect(a.match(/-j DNAT --to-destination 10\.244\.\d\.\d+:80/g)).toHaveLength(3);
    expect(iptablesProbability(1 / 4)).toBe("0.25000000000");
  });

  test("curl http://web: DNS → DNAT → 경로 → 200, 여러 번 보내면 여러 Pod 가 받는다", () => {
    const c = webWithService();
    const from = pods(c)[0]!.metadata.name;
    const served = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const r = k(c, `exec ${from} -- curl http://web`);
      expect(r.ok, r.output).toBe(true);
      expect(r.net!.steps.map((s) => s.kind)).toEqual(["dns", "dnat", "route", "response"]);
      served.add(r.net!.servedBy!);
    }
    expect(served.size).toBe(3);
    expect(c.trace.events.some((e) => e.kind === "net.dnat")).toBe(true);
  });

  test("ndots:5 — 짧은 이름은 search 도메인부터 붙여 본다", () => {
    const c = webWithService();
    expect(resolve(c, "web").tried).toEqual(["web.default.svc.cluster.local"]);
    const r = resolve(c, "web.default");
    expect(r.tried).toEqual(["web.default.default.svc.cluster.local", "web.default.svc.cluster.local"]);
    expect(r.ip).toBe(c.api.get("Service", "web")!.spec.clusterIP);
    expect(resolve(c, "nope").ip).toBeUndefined();
  });

  test("ClusterIP 로 ping 은 안 되고, Pod IP 로는 된다", () => {
    const c = webWithService();
    const [a, b] = pods(c);
    const r1 = k(c, `exec ${a!.metadata.name} -- ping web`);
    expect(r1.ok).toBe(false);
    expect(r1.output).toContain("100% packet loss");
    const r2 = k(c, `exec ${a!.metadata.name} -- ping ${b!.status.podIP}`);
    expect(r2.ok).toBe(true);
    expect(r2.output).toContain("0% packet loss");
  });

  test("없는 이름 → Could not resolve host, 없는 포트 → 시간 초과, targetPort 가 틀리면 → 연결 거부", () => {
    const c = webWithService();
    const from = pods(c)[0]!.metadata.name;
    expect(k(c, `exec ${from} -- curl http://wbe`).output).toBe("curl: (6) Could not resolve host: wbe");
    expect(k(c, `exec ${from} -- curl http://web:8080`).output).toMatch(/^curl: \(28\) Failed to connect to web port 8080/);
    c.apply(service("web", { selector: { app: "web" }, port: 80, targetPort: 8080 }));
    c.runFor(2000);
    const r = k(c, `exec ${from} -- curl http://web`);
    expect(r.output).toMatch(/^curl: \(7\) Failed to connect/);
    expect(r.net!.steps.at(-1)!.text).toContain("앱은 포트 80 에서 듣는데 8080 로 옴");
  });

  test("selector 에 맞는 Pod 가 없으면 has no endpoints REJECT → 연결 거부", () => {
    const c = webWithService();
    c.apply(service("api", { selector: { app: "api" }, port: 80 }));
    c.runFor(2000);
    expect(c.kubeProxies.get("worker-1")!.iptablesSave()).toContain('"default/api has no endpoints"');
    const r = k(c, `exec ${pods(c)[0]!.metadata.name} -- curl http://api`);
    expect(r.output).toMatch(/^curl: \(7\)/);
  });

  test("Pod 가 지워지면 EndpointSlice 에서 빠지고 규칙이 바뀐다 (새 Pod 가 ready 가 되면 들어간다)", () => {
    const c = webWithService();
    const victim = pods(c)[0]!;
    k(c, `delete pod ${victim.metadata.name}`);
    c.runFor(250); // watch(0.1초) 뒤 EndpointSlice 갱신 — nginx 는 SIGTERM 0.3초 뒤 끝나므로 아직 Terminating
    const slice = c.api.list("EndpointSlice")[0]!;
    const e = slice.endpoints.find((x) => x.targetRef.name === victim.metadata.name);
    expect(e?.conditions).toMatchObject({ ready: false, terminating: true });
    // 규칙은 RULE_SYNC_MS(1초) 뒤에 바뀐다 — 그 전에는 아직 옛 규칙
    expect(c.kubeProxies.get("worker-1")!.currentRules[0]!.seps.map((s) => s.pod)).toContain(victim.metadata.name);
    c.runFor(1000);
    expect(c.kubeProxies.get("worker-1")!.currentRules[0]!.seps.map((s) => s.pod)).not.toContain(victim.metadata.name);
    c.runFor(10_000);
    expect(c.kubeProxies.get("worker-1")!.currentRules[0]!.seps).toHaveLength(3);
  });

  test("expose 와 NodePort: 바깥에서 아무 노드의 NodePort 로 들어와 다른 노드의 Pod 로 갈 수 있다", () => {
    const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.runFor(10_000);
    expect(k(c, "expose deployment web --port=80 --type=NodePort").output).toBe("service/web exposed");
    c.runFor(2000);
    const svc = c.api.get("Service", "web")!;
    const np = svc.spec.ports[0]!.nodePort!;
    expect(np).toBeGreaterThanOrEqual(30000);
    expect(np).toBeLessThanOrEqual(32767);
    expect(k(c, "get svc web").output).toContain(`80:${np}/TCP`);
    const other = pods(c)[0]!.spec.nodeName === "worker-1" ? "worker-2" : "worker-1";
    const r = c.requestNodePort(other, np);
    expect(r.ok).toBe(true);
    expect(r.steps.some((s) => s.kind === "route" && s.actor.startsWith("flannel"))).toBe(true); // 다른 노드의 Pod 로
    expect(r.steps.find((s) => s.kind === "dnat")!.text).toContain("SNAT"); // Cluster 정책은 어디로 가든 SNAT
  });

  test("노드가 꺼진 뒤 NotReady 전까지는 엔드포인트가 남아 그 Pod 로 간 요청이 시간 초과", () => {
    const c = webWithService(2);
    const onW2 = pods(c).find((p) => p.spec.nodeName === "worker-2")!;
    const from = pods(c).find((p) => p.spec.nodeName === "worker-1")!.metadata.name;
    c.setNodePower("worker-2", false);
    c.runFor(5000);
    const outcomes = Array.from({ length: 10 }, () => k(c, `exec ${from} -- curl http://web`));
    expect(outcomes.some((r) => r.output.includes("(28)"))).toBe(true);
    expect(outcomes.some((r) => r.ok)).toBe(true);
    // NotReady 가 되면 Pod Ready=False → 엔드포인트에서 빠짐 → 요청이 모두 성공
    c.runFor(50_000);
    expect(c.api.list("EndpointSlice")[0]!.endpoints.find((e) => e.targetRef.name === onW2.metadata.name)!.conditions.ready).toBe(false);
    expect(Array.from({ length: 10 }, () => k(c, `exec ${from} -- curl http://web`)).every((r) => r.ok)).toBe(true);
  });
});

describe("readiness probe", () => {
  test("준비 시간 동안은 Running 이어도 Ready 가 아니고 트래픽을 받지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("api", { replicas: 1, image: "example/api:1.0", cpu: 100, memory: 64, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 5 } }));
    c.apply(service("api", { selector: { app: "api" }, port: 80, targetPort: 8080 }));
    c.runFor(10_000); // 시작 ~3.4초, 첫 probe 는 그 5초 뒤
    const p = pods(c)[0]!;
    expect(k(c, "get pods").output.split("\n")[1]).toMatch(/0\/1\s+Running/);
    expect(c.api.list("EndpointSlice")[0]!.endpoints[0]!.conditions.ready).toBe(false);
    expect(c.api.eventsFor(p.metadata.uid).find((e) => e.reason === "Unhealthy")!.message).toBe("Readiness probe failed: HTTP probe failed with statuscode: 503");
    c.runFor(20_000);
    expect(k(c, "get pods").output.split("\n")[1]).toMatch(/1\/1\s+Running/);
    expect(c.api.list("EndpointSlice")[0]!.endpoints[0]!.conditions.ready).toBe(true);
  });

  test("앱이 고장 나면 3번 연속 실패 뒤 Ready=False → 엔드포인트에서 빠지고, 고치면 돌아온다", () => {
    const c = webWithService(2);
    // web 에 readiness probe 추가
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, readiness: { httpGet: { path: "/", port: 80 }, periodSeconds: 10 } }));
    c.runFor(30_000);
    const [a, b] = pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
    expect(c.setPodHealth(a!.metadata.name, false)).toBe(true);
    c.runFor(15_000);
    expect(c.api.get("Pod", a!.metadata.name)!.status.conditions.find((x) => x.type === "Ready")!.status).toBe("True"); // 10초 주기라 15초 안에는 많아야 2번 실패
    c.runFor(20_000);
    expect(c.api.get("Pod", a!.metadata.name)!.status.conditions.find((x) => x.type === "Ready")!.status).toBe("False");
    c.runFor(1000);
    const served = new Set(Array.from({ length: 8 }, () => k(c, `exec ${b!.metadata.name} -- curl http://web`).net!.servedBy));
    expect([...served]).toEqual([b!.metadata.name]);
    c.setPodHealth(a!.metadata.name, true);
    c.runFor(15_000);
    expect(c.api.get("Pod", a!.metadata.name)!.status.conditions.find((x) => x.type === "Ready")!.status).toBe("True");
  });
});

describe("kubectl exec 오류", () => {
  test("돌지 않는 컨테이너·꺼진 노드·없는 도구", () => {
    const c = webWithService(1);
    const p = pods(c)[0]!.metadata.name;
    expect(k(c, `exec ${p} -- bash`).output).toMatch(/executable file not found in \$PATH/);
    expect(k(c, `exec ${p}`).output).toMatch(/you must specify at least one command/);
    c.setNodePower(pods(c)[0]!.spec.nodeName!, false);
    expect(k(c, `exec ${p} -- curl http://web`).output).toMatch(/^Error from server: error dialing backend/);
  });
});
