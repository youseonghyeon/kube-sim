// 리뷰 3 (2026-10-02, Service 네트워킹)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { Cluster, deployment, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { DefSync } from "../src/model/defSync";
import { cluster, pods } from "./helpers";

const k = (c: Cluster, line: string) => runKubectl(c, line);

function webWithService(replicas = 3) {
  const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
  c.apply(deployment("web", { replicas, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
  c.apply(service("web", { selector: { app: "web" }, port: 80 }));
  c.runFor(10_000);
  return c;
}

describe("Service 주소 할당 (API 서버)", () => {
  // 기대: type 을 ClusterIP → NodePort 로 바꾸면 API 서버가 30000-32767 에서 nodePort 를 할당한다.
  // 실제: allocateServiceAddresses 는 create 에서만 불리고, apply 는 옛 nodePort(없음)만 이어받아 nodePort 가 비어 있다.
  //       → get svc 는 "NodePort ... 80/TCP", kube-proxy 에 KUBE-NODEPORTS 규칙 없음, 바깥에서 들어올 길이 없다.
  // 왜 중요: 매니페스트 편집기에서 type 만 바꾸는 것이 가장 흔한 NodePort 실습 경로다 (DefSync 도 같은 apply 를 탄다).
  test("ClusterIP → NodePort 로 apply 하면 nodePort 가 할당된다", () => {
    const c = webWithService();
    c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort" }));
    c.runFor(1000);
    const np = c.api.get("Service", "web")!.spec.ports[0]!.nodePort;
    expect(np).toBeGreaterThanOrEqual(30000);
    expect(np).toBeLessThanOrEqual(32767);
    expect(c.kubeProxies.get("worker-1")!.currentRules[0]!.nodePort).toBe(np);
  });

  test("DefSync: 매니페스트의 type 을 NodePort 로 바꾸면 nodePort 가 생긴다", () => {
    const s = new DefSync();
    const nodes = [{ name: "worker-1", cpu: 2000, memory: 4096 }];
    const dep = deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 });
    s.reset({ nodes, manifests: [dep, service("web", { selector: { app: "web" }, port: 80 })] }, "test");
    s.cluster.runFor(10_000);
    s.sync({ nodes, manifests: [dep, service("web", { selector: { app: "web" }, port: 80, type: "NodePort" })] });
    s.cluster.runFor(1000);
    expect(s.cluster.api.get("Service", "web")!.spec.ports[0]!.nodePort).toBeGreaterThanOrEqual(30000);
  });

  // 같은 원인: NodePort Service 의 port 를 80 → 8080 으로 바꾸면 port 로 옛 nodePort 를 찾지 못해 nodePort 가 사라진다 (새로 할당도 안 됨).
  test("NodePort Service 의 port 를 바꿔도 nodePort 가 남는다(또는 새로 할당된다)", () => {
    const c = webWithService();
    c.apply(service("np", { selector: { app: "web" }, port: 80, type: "NodePort" }));
    c.apply(service("np", { selector: { app: "web" }, port: 8080, targetPort: 80, type: "NodePort" }));
    expect(c.api.get("Service", "np")!.spec.ports[0]!.nodePort).toBeGreaterThanOrEqual(30000);
  });

  // 기대: 이미 쓰는 nodePort 나 범위 밖 nodePort 를 지정하면 Invalid
  //   (실제: `spec.ports[0].nodePort: Invalid value: 30080: provided port is already allocated`,
  //          `... provided port is not in the valid range. The range of valid ports is 30000-32767`).
  // 실제: 지정한 nodePort 는 검사 없이 그대로 저장 → 두 Service 가 같은 30080 을 갖고, 80 같은 포트도 받는다.
  //       simulateNodePort 는 첫 규칙만 찾으므로 둘째 Service 로는 바깥에서 영영 못 들어간다.
  test("이미 할당된 nodePort 를 지정하면 거절된다", () => {
    const c = webWithService();
    c.apply(service("a", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 30080 }));
    expect(() => c.apply(service("b", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 30080 }))).toThrow(/already allocated/);
  });

  test("범위(30000-32767) 밖 nodePort 를 지정하면 거절된다", () => {
    const c = webWithService();
    expect(() => c.apply(service("d", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 80 }))).toThrow(/valid range/);
  });

  // 기대: spec.clusterIP 는 바꿀 수 없다 (실제: `spec.clusterIP: Invalid value: "...": field is immutable`).
  // 실제: apply 가 매니페스트의 clusterIP 를 그대로 쓰고 update 는 검사하지 않아, 다른 Service(web) 의 ClusterIP 까지 받아들인다
  //       → 두 Service 가 같은 ClusterIP. kube-proxy 규칙·DNS 가 서로 엉킨다.
  test("다른 Service 의 ClusterIP 로 바꾸는 apply 는 거절된다", () => {
    const c = webWithService();
    c.apply(service("other", { selector: { app: "x" }, port: 80 }));
    const webIp = c.api.get("Service", "web")!.spec.clusterIP!;
    const m = service("other", { selector: { app: "x" }, port: 80 });
    m.spec.clusterIP = webIp;
    expect(() => c.apply(m)).toThrow();
    expect(c.api.get("Service", "other")!.spec.clusterIP).not.toBe(webIp);
  });
});

describe("kubectl (Service)", () => {
  // 기대: 도움말이 `kubectl delete pod|deploy|rs|svc <이름>` 을 안내하므로 `kubectl delete svc web` → service "web" deleted.
  // 실제: del() 의 허용 목록이 Pod·Deployment·ReplicaSet 뿐이라 "delete 는 pods·deployments.apps·replicasets.apps 에만" 오류.
  // 왜 중요: Service 를 지우고 다시 만들어 ClusterIP·EndpointSlice GC 를 보는 실습이 kubectl 로 막힌다.
  test("kubectl delete svc 가 된다 (도움말에 있음)", () => {
    const c = webWithService();
    const r = k(c, "delete svc web");
    expect(r.output).toBe('service "web" deleted');
    expect(c.api.get("Service", "web")).toBeUndefined();
  });

  // 기대: 실제 kubectl expose 는 --target-port 를 안 주면 targetPort = --port 다
  //       (kubectl expose.go: "If --target-port or --container-port haven't been specified, this should be the same as Port").
  // 실제: 컨테이너의 containerPort(8080)를 몰래 targetPort 로 써서, 실제 클러스터에서 가장 흔한 실수(포트 80 으로 보내 연결 거부)가 여기서는 성공한다.
  test("expose 는 --target-port 가 없으면 targetPort = --port", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("api", { replicas: 1, image: "example/api:1.0", cpu: 100, memory: 64, port: 8080 }));
    c.runFor(1000);
    k(c, "expose deployment api --port=80");
    expect(c.api.get("Service", "api")!.spec.ports[0]!.targetPort).toBe(80);
  });

  // 기대: `curl http://web -m 5` (옵션이 URL 뒤에 옴) 는 web 으로 보낸다.
  // 실제: exec 가 "-로 시작하지 않는 마지막 인자" 를 대상으로 골라 "5" 를 호스트로 본다 → curl: (6) Could not resolve host: 5.
  test("exec: URL 뒤에 오는 옵션 값(-m 5)을 대상으로 착각하지 않는다", () => {
    const c = webWithService();
    const r = k(c, `exec ${pods(c)[0]!.metadata.name} -- curl http://web -m 5`);
    expect(r.ok, r.output).toBe(true);
  });

  // 기대: busybox `nslookup web 10.96.0.10` 은 둘째 인자를 DNS 서버로 쓰고 web 을 푼다.
  // 실제: 마지막 인자(10.96.0.10)를 대상으로 골라 역방향 조회 NXDOMAIN.
  test("exec: nslookup <이름> <서버> 는 이름을 푼다", () => {
    const c = webWithService();
    const r = k(c, `exec ${pods(c)[0]!.metadata.name} -- nslookup web 10.96.0.10`);
    expect(r.output).toContain("Name:\tweb.default.svc.cluster.local");
  });

  // 기대: wget 으로 실행했으면 wget 의 출력(busybox: `wget: bad address 'nope'`)이 나온다.
  // 실제: wget 을 curl 로 바꿔 돌려 `curl: (6) Could not resolve host: nope` — 학습자가 친 명령과 다른 도구의 문구.
  test("exec: wget 의 실패 문구는 curl 문구가 아니다", () => {
    const c = webWithService();
    const r = k(c, `exec ${pods(c)[0]!.metadata.name} -- wget -qO- http://nope`);
    expect(r.output).not.toMatch(/^curl:/);
  });
});

describe("요청 흉내 출력", () => {
  // 기대: 클러스터 밖에서 노드IP:NodePort(30123)로 접속했으니 실패 문구도 그 포트: "Failed to connect to 192.168.0.11 port 30123".
  // 실제: viaService 가 rule.port(Service 포트 80)를 찍어 "port 80" — 학습자는 80 으로 접속한 줄 안다.
  //       같은 이유로 NodePort 경로의 시간 초과·거부(deliverToIp 의 shownPort=rule.port)도 80 을 찍는다.
  test("NodePort 로 들어온 요청의 실패 문구는 nodePort 를 보여 준다", () => {
    const c = webWithService();
    c.apply(service("api", { selector: { app: "api" }, port: 80, type: "NodePort", nodePort: 30123 }));
    c.runFor(1000);
    const r = c.requestNodePort("worker-1", 30123);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("port 30123");
  });

  // 기대: curl 은 사용자가 URL 에 쓴 호스트를 찍는다: `curl: (28) Failed to connect to web port 8080 after …`
  //       (search 도메인을 붙이는 것은 libc 리졸버 일이라 curl 은 모른다. busybox ping 도 `PING web (10.96.x.x)`).
  // 실제: shownHost = a.fqdn 이라 `web.default.svc.cluster.local` 을 찍는다 — 실제 출력과 다르다
  //       (tests/network.test.ts 가 이 FQDN 문구를 고정하고 있으니 함께 고쳐야 함).
  test("curl·ping 출력은 사용자가 쓴 이름(web)을 보여 준다", () => {
    const c = webWithService();
    const from = pods(c)[0]!.metadata.name;
    expect(k(c, `exec ${from} -- curl http://web:8080`).output).toMatch(/^curl: \(28\) Failed to connect to web port 8080 /);
    expect(k(c, `exec ${from} -- ping web`).output.split("\n")[0]).toMatch(/^PING web \(10\.96\./);
  });

  // 기대: redis:7 은 "HTTP 아님"(workloads.ts) 이므로 curl http://redis:6379 는 HTTP 응답을 받지 못한다
  //       (실제 curl 8: `curl: (1) Received HTTP/0.9 when not allowed` 또는 (52) Empty reply).
  // 실제: 포트만 맞으면 body 가 없어도 "OK" 로 HTTP 200 성공 처리.
  test("HTTP 가 아닌 앱(redis)에 curl 하면 성공하지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("redis", { replicas: 1, image: "redis:7", cpu: 100, memory: 64, port: 6379 }));
    c.apply(service("redis", { selector: { app: "redis" }, port: 6379 }));
    c.runFor(10_000);
    const r = k(c, `exec ${pods(c)[0]!.metadata.name} -- curl http://redis:6379`);
    expect(r.ok).toBe(false);
  });

  // 기대: externalTrafficPolicy: Cluster(기본) 의 NodePort 는 같은 노드의 Pod 로 가도 출발지를 노드 IP 로 SNAT 한다
  //       (kube-proxy KUBE-EXT-* 체인이 무조건 KUBE-MARK-MASQ. k8s 문서 "Using Source IP": NodePort 는 기본으로 source NAT).
  // 실제: 다른 노드로 갈 때만 SNAT 문구를 붙인다 → "같은 노드 Pod 면 클라이언트 IP 가 보존된다" 로 잘못 배운다 (예제 service 의 설명도 같다).
  test("NodePort(Cluster 정책)는 같은 노드 Pod 로 가도 SNAT 단계가 보인다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 30080 }));
    c.runFor(10_000);
    const r = c.requestNodePort("worker-1", 30080);
    expect(r.ok).toBe(true);
    expect(r.steps.some((s) => s.text.includes("SNAT"))).toBe(true);
  });
});

describe("kube-proxy 규칙 출력", () => {
  // 기대: "has no endpoints" REJECT 는 filter 테이블 규칙이다 (kube-proxy proxier.go 가 filterRules 에 씀; REJECT 타깃은 nat 테이블에서 쓸 수 없다).
  //       인스펙터는 이 출력을 "nat 테이블 (iptables-save -t nat | grep KUBE)" 로 보여 준다.
  // 실제: *nat 블록 안에 `-A KUBE-SERVICES ... -j REJECT` 를 찍는다.
  test("iptables-save -t nat 에는 REJECT 규칙이 없다", () => {
    const c = webWithService();
    c.apply(service("api", { selector: { app: "api" }, port: 80 }));
    c.runFor(1000);
    const nat = c.kubeProxies.get("worker-1")!.iptablesSave();
    const natBlock = nat.slice(nat.indexOf("*nat"), nat.indexOf("COMMIT", nat.indexOf("*nat")));
    expect(natBlock).not.toContain("-j REJECT");
  });
});

describe("EndpointSlice 컨트롤러", () => {
  // 기대: Pod 의 레이블이 바뀌어 셀렉터에서 벗어나면 그 Service 의 엔드포인트에서 빠진다
  //       (실제 컨트롤러는 Pod update 때 옛 레이블·새 레이블 양쪽에 맞는 Service 를 모두 큐에 넣는다).
  // 실제: watch 이벤트의 새 Pod 레이블에 맞는 Service 만 큐에 넣어, 옛 Service(web)는 다시 계산되지 않고 그 Pod 로 계속 트래픽을 보낸다.
  // 지금은 kubectl label 이 없어 API 로만 재현된다 (심각도 낮음) — 나중에 label·디버깅 실습(Pod 를 Service 에서 빼기)을 넣으면 바로 드러난다.
  test("Pod 레이블을 바꾸면 옛 Service 엔드포인트에서 빠진다", () => {
    const c = webWithService();
    const p = pods(c)[0]!;
    c.api.patch("Pod", p.metadata.name, "default", "user", (o) => {
      o.metadata.labels = { app: "debug" };
    });
    c.runFor(5000);
    const names = c.api.list("EndpointSlice")[0]!.endpoints.map((e) => e.targetRef.name);
    expect(names).not.toContain(p.metadata.name);
  });
});
