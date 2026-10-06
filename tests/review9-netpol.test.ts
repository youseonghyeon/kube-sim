// 리뷰 9 (2026-10-06, NetworkPolicy 5c)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { application, deployment, networkPolicy, service, type Manifest } from "../src/core/cluster";
import { POLL_MS } from "../src/core/gitops/argocd";
import { runKubectl } from "../src/core/kubectl";
import { exampleById } from "../src/model/examples";
import { netpolRows, setNetpolRows } from "../src/model/netpolForm";
import { buildView } from "../src/model/view";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const live = (c: C, app: string) => pods(c).filter((p) => p.metadata.labels.app === app && p.metadata.deletionTimestamp === undefined);
const pin = (n: string) => ({ "kubernetes.io/hostname": n });

/** web 은 worker-2 에, client 는 worker-1 에. web 은 NodePort 30080 */
function nodePortSetup() {
  const c = cluster();
  c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, port: 80, nodeSelector: pin("worker-2") }));
  c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 30080 }));
  c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32, nodeSelector: pin("worker-1") }));
  c.runFor(15_000);
  return c;
}
const nodeIp = (c: C, n: string) => c.api.get("Node", n)!.status.addresses.find((a) => a.type === "InternalIP")!.address;

describe("요청 경로", () => {
  // 실제: Pod → 다른 노드IP:NodePort 는 출발 노드에서 DNAT 되지 않는다 (KUBE-NODEPORTS 는 --dst-type LOCAL 에만).
  //   그래서 출발 노드의 egress 정책이 보는 목적지는 노드IP:30080 하나뿐 — 노드 대역만 연 egress 로 지나간다.
  //   sim 도 DNAT 를 받는 노드(iptables@worker-2)에서 한다고 그리면서, 그 뒤 deliverToIp 에서 egress 를 Pod IP:80 으로 한 번 더 검사한다.
  test("Pod → 다른 노드 IP:NodePort — egress 는 노드IP:NodePort 로 한 번만 본다 (DNAT 뒤 Pod IP 로 다시 보지 않음)", () => {
    const c = nodePortSetup();
    c.apply(networkPolicy("client-to-nodes", { podSelector: { matchLabels: { app: "client" } }, policyTypes: ["Egress"], egress: [{ to: [{ ipBlock: { cidr: "192.168.0.0/24" } }] }] }));
    const r = c.requestFromPod(live(c, "client")[0]!.metadata.name, "curl", `http://${nodeIp(c, "worker-2")}:30080`);
    expect(r.steps.map((s) => s.text).join("\n")).not.toContain("egress(나가는 쪽)");
    expect(r.ok).toBe(true);
  });

  // sim 스스로 Cluster 정책 NodePort 는 출발지를 노드 IP 로 SNAT 한다고 그린다 (앱이 본 출발지 = 노드 IP).
  // 그런데 정책 판단은 src.pod 가 남아 있어 client Pod 의 이름표로 podSelector 를 맞춘다 → 실제(SNAT 뒤 출발지는 노드 IP)와 다르게 허용.
  test("Pod → 자기 노드 IP:NodePort → 다른 노드의 web: SNAT 뒤라 web 의 ingress 는 client 를 podSelector 로 알아보지 못한다", () => {
    const c = nodePortSetup();
    c.apply(networkPolicy("web-from-client", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "client" } } }] }] }));
    const r = c.requestFromPod(live(c, "client")[0]!.metadata.name, "curl", `http://${nodeIp(c, "worker-1")}:30080`);
    // 앱이 본 출발지가 노드 IP 라면 (sim 이 그렇게 말한다) …
    if (r.ok) expect(r.seenSource).toBe(nodeIp(c, "worker-1"));
    // … podSelector app=client 규칙에는 맞지 않아야 한다 (DROP → 시간 초과)
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Connection timed out");
  });
});

describe("kubectl 출력", () => {
  // 실제 kubectl (describe.go printNetworkPolicySpecIngressFrom): 상대(peer)마다 "From:" 줄을 따로 찍는다.
  // 문서 예 (kubectl describe networkpolicy test-network-policy): From: IPBlock … / From: NamespaceSelector … / From: PodSelector …
  test("describe networkpolicy: 상대가 여럿이면 'From:' 을 상대마다", () => {
    const c = cluster();
    c.apply(networkPolicy("multi", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ ipBlock: { cidr: "172.17.0.0/16", except: ["172.17.1.0/24"] } }, { podSelector: { matchLabels: { role: "frontend" } } }], ports: [{ port: 6379 }] }] }));
    expect(runKubectl(c, "kubectl describe networkpolicy multi").output).toContain(
      "  Allowing ingress traffic:\n    To Port: 6379/TCP\n    From:\n      IPBlock:\n        CIDR: 172.17.0.0/16\n        Except: 172.17.1.0/24\n    From:\n      PodSelector: role=frontend\n",
    );
  });

  // 실제: metav1.FormatLabelSelector → labels.Selector.String() 은 키 순으로 정렬한다.
  test("get netpol 의 POD-SELECTOR 는 키 순 (app=…,tier=…)", () => {
    const c = cluster();
    c.apply(networkPolicy("two", { podSelector: { matchLabels: { tier: "be", app: "web" } } }));
    expect(runKubectl(c, "kubectl get netpol").output).toMatch(/two\s+app=web,tier=be\s/);
  });

  // ingress: [{}] (어디서든·모든 포트 허용 — 화면 폼의 '어디든' + 빈 포트가 만드는 모양) 을 YAML 로 보면 "- {}" 여야 한다
  test("get netpol -o yaml: 빈 규칙은 '- {}' ([object Object] 아님)", () => {
    const c = cluster();
    c.apply(networkPolicy("allow-all", { podSelector: {}, ingress: [{}] }));
    const y = runKubectl(c, "kubectl get networkpolicy allow-all -o yaml").output;
    expect(y).not.toContain("[object Object]");
    expect(y).toMatch(/ingress:\n\s*- \{\}/);
  });
});

describe("API 검사 (실제 validation)", () => {
  test("상대가 비어 있으면({}) 거절 — must specify a peer", () => {
    const c = cluster();
    expect(() => c.apply(networkPolicy("empty-peer", { podSelector: {}, ingress: [{ from: [{}] }] }))).toThrow();
  });
  test("CIDR 옥텟이 255 를 넘으면 거절", () => {
    const c = cluster();
    expect(() => c.apply(networkPolicy("bad-octet", { podSelector: {}, ingress: [{ from: [{ ipBlock: { cidr: "300.0.0.0/8" } }] }] }))).toThrow("must be a valid CIDR value");
  });
  test("except 는 cidr 안이어야 한다 — must be a strict subset of `cidr`", () => {
    const c = cluster();
    expect(() => c.apply(networkPolicy("bad-except", { podSelector: {}, ingress: [{ from: [{ ipBlock: { cidr: "10.0.0.0/24", except: ["192.168.0.0/24"] } }] }] }))).toThrow("strict subset");
  });
});

describe("인스펙터 폼 (netpolForm)", () => {
  // '그대로 둠(other)' 줄도 방향 select 는 보인다 (Inspector.tsx NetpolSettings). 방향만 바꾸면 raw 의 from 이 egress 규칙에 그대로 들어가
  // egress 규칙에 to 가 없어 "어디로든" 이 된다 (그리고 실제 API 는 egress 규칙의 from 필드를 모른다).
  test("여러 상대 ingress 규칙의 방향을 egress 로 바꾸면 상대가 to 로 옮겨진다 (어디로든 허용이 되지 않음)", () => {
    const spec = { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "a" } } }, { podSelector: { matchLabels: { app: "b" } } }] }] } as Parameters<typeof netpolRows>[0];
    const rows = netpolRows(spec);
    expect(rows[0]!.peer).toBe("other");
    const next = structuredClone(spec);
    setNetpolRows(next, [{ ...rows[0]!, dir: "egress" }]);
    const rule = next.egress![0]! as Record<string, unknown>;
    expect(rule.from).toBeUndefined();
    expect(rule.to).toEqual([{ podSelector: { matchLabels: { app: "a" } } }, { podSelector: { matchLabels: { app: "b" } } }]);
  });
});

describe("예제 동작 apply (sim)", () => {
  // netpol-basics 의 단계 "deny-web 지우기"(kubectl delete) 뒤 카드의 apply 를 다시 누르면:
  // 막히지도 않고(라이브가 없으니) 로그에 'kubectl apply -f deny-web.yaml' 이 찍히지만, 매니페스트 내용이 같아 DefSync 가 건너뛰어 다시 만들지 않는다.
  test("kubectl delete 뒤 같은 apply 동작을 다시 하면 라이브에 다시 생긴다 (kubectl apply -f 처럼)", async () => {
    const { sim } = await import("../src/model/sim");
    const { clusterDef, exampleId } = await import("../src/model/store");
    const ex = exampleById("netpol-basics")!;
    exampleId.value = ex.id;
    clusterDef.value = ex.build();
    sim.reset();
    sim.cluster.runFor(15_000);
    const apply = ex.tries.find((t) => t.action?.type === "apply")!.action!;
    expect(sim.runAction(apply)).toBeUndefined();
    sim.cluster.runFor(1000);
    expect(sim.cluster.api.get("NetworkPolicy", "deny-web")).toBeDefined();
    expect(sim.kubectl("kubectl delete networkpolicy deny-web").ok).toBe(true);
    expect(sim.cluster.api.get("NetworkPolicy", "deny-web")).toBeUndefined();
    const why = sim.runAction(apply);
    sim.cluster.runFor(1000);
    // 다시 만들거나, 못 한다면 그 이유를 돌려줘야 한다 — 지금은 undefined(했다)인데 라이브에 없다
    if (why === undefined) expect(sim.cluster.api.get("NetworkPolicy", "deny-web")).toBeDefined();
  });
});

describe("Argo CD", () => {
  // Git 에서 ingress 규칙을 통째로 지우면 (= 들어오는 것 모두 차단) 라이브는 여전히 옛 허용 규칙으로 열려 있는데 Synced 로 보인다.
  // diffFields 가 "Git 에 적힌 필드만" 비교해 사라진 ingress 를 보지 못한다. (실제 Argo CD 는 last-applied 기준 3-way 로 OutOfSync, sync 하면 지운다)
  test("Git 에서 ingress 를 지운 리비전 → 자동 sync 뒤 라이브에도 ingress 가 없다 (또는 OutOfSync)", () => {
    const REPO = "https://github.com/youseonghyeon/net-sim.git";
    const base: Record<string, Manifest> = { "deploy/deployment.yaml": deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:aaa111", cpu: 10, memory: 16, port: 8080 }) };
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.gitCommit(REPO, { ...base, "deploy/netpol.yaml": networkPolicy("net-sim", { podSelector: { matchLabels: { app: "net-sim" } }, ingress: [{ ports: [{ port: 8080 }] }] }) }, "open 8080");
    c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(15_000);
    expect(c.api.get("NetworkPolicy", "net-sim")!.spec.ingress).toHaveLength(1);
    c.gitCommit(REPO, { ...base, "deploy/netpol.yaml": networkPolicy("net-sim", { podSelector: { matchLabels: { app: "net-sim" } } }) }, "deny all ingress");
    c.runFor(POLL_MS + 15_000);
    const app = c.api.get("Application", "net-sim", "argocd")!;
    const ing = c.api.get("NetworkPolicy", "net-sim")!.spec.ingress;
    expect(app.status.sync.status === "OutOfSync" || ing === undefined || ing.length === 0).toBe(true);
    expect(ing ?? []).toHaveLength(0);
  });
});

describe("buildView (peekList 로 바꾼 뒤)", () => {
  // 전에는 api.list (이름순) — 이제 저장소 삽입 순서라, 지웠다 다시 만든 Deployment·Node 는 목록 끝으로 가고 색(colorIndex)도 바뀐다.
  test("Deployment·Node 순서는 이름순 (만든 순서·다시 만든 것과 상관없이)", () => {
    const c = cluster();
    c.apply(deployment("zeta", { replicas: 1, image: "nginx:1.27", cpu: 10, memory: 16 }));
    c.apply(deployment("alpha", { replicas: 1, image: "nginx:1.27", cpu: 10, memory: 16 }));
    c.runFor(5000);
    c.removeNode("worker-1");
    c.addNode({ name: "worker-1", cpu: 2000, memory: 4096 });
    c.runFor(5000);
    const v = buildView(c);
    expect(v.deployments.map((d) => d.name)).toEqual(["alpha", "zeta"]);
    expect(v.nodes.map((n) => n.name)).toEqual(["worker-1", "worker-2"]);
  });
});
