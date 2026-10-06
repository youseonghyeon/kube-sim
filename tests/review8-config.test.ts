// 리뷰 8: Ingress 폼 · ConfigMap/Secret(5b) 재현 테스트. 각 테스트는 실제 Kubernetes(·kubectl·셸) 동작을 기대값으로 둔다.
import { describe, expect, test } from "vitest";
import { ApiError } from "../src/core/api/server";
import { b64decode } from "../src/core/base64";
import { application, configMap, deployment, ingress, secret, service } from "../src/core/cluster";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { hostError } from "../src/model/ingressForm";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const live = (c: C, app: string) => pods(c).filter((p) => p.metadata.labels.app === app && p.metadata.deletionTimestamp === undefined);

describe("volume 파일 갱신", () => {
  // 실제 kubelet 은 Pod 의 volume 을 (컨테이너가 돌든 말든) 동기화 주기마다 맞춘다. 컨테이너를 만들 때도 지금의 volume 디렉터리를 그대로 bind 한다.
  test("컨테이너가 CreateContainerConfigError 로 기다리는 사이 바뀐 ConfigMap 은, 컨테이너가 뜬 뒤 파일에 반영돼야 한다", () => {
    const c = cluster();
    c.apply(configMap("files", { K: "old" }));
    c.apply(
      deployment("app", {
        replicas: 1,
        image: "nginx:1.27",
        cpu: 50,
        memory: 32,
        env: [{ name: "T", valueFrom: { secretKeyRef: { name: "later", key: "T" } } }],
        mounts: [{ name: "f", configMap: "files", mountPath: "/etc/config" }],
      }),
    );
    c.runFor(15_000);
    expect(kubectl(c, "kubectl get pods").output).toContain("CreateContainerConfigError");
    kubectl(c, `kubectl patch cm files -p '{"data":{"K":"new"}}'`);
    c.runFor(5_000);
    kubectl(c, "kubectl create secret generic later --from-literal=T=1");
    c.runFor(15_000);
    const pod = live(c, "app")[0]!.metadata.name;
    expect(kubectl(c, "kubectl get pods").output).toMatch(/1\/1\s+Running/);
    c.runFor(3 * 60_000); // 동기화 주기를 몇 번 지나도
    expect(kubectl(c, `kubectl exec ${pod} -- cat /etc/config/K`).output).toBe("new");
  });

  // 추측(실제 동작): subPath 는 "돌고 있는 컨테이너" 에 갱신되지 않을 뿐, 컨테이너를 새로 만들 때(크래시 재시작 포함) subPath 를 다시 풀어 bind 하므로 새 내용을 본다.
  test("subPath 파일은 크래시 재시작한 새 컨테이너에서 새 값 (추측)", () => {
    const c = cluster();
    c.apply(configMap("cfg", { K: "1" }));
    c.apply(deployment("w", { replicas: 1, image: "example/worker:1.0", cpu: 50, memory: 32, mounts: [{ name: "v", configMap: "cfg", mountPath: "/etc/k", subPath: "K" }] }));
    c.runFor(3_500);
    const p = live(c, "w")[0]!.metadata.name;
    expect(kubectl(c, `kubectl exec ${p} -- cat /etc/k`).output).toBe("1");
    kubectl(c, `kubectl patch cm cfg -p '{"data":{"K":"2"}}'`);
    c.runFor(2_000); // 크래시 → 바로 재시작 (같은 Pod)
    expect(live(c, "w")[0]!.metadata.name).toBe(p);
    expect(live(c, "w")[0]!.status.containerStatuses[0]!.restartCount).toBeGreaterThan(0);
    expect(kubectl(c, `kubectl exec ${p} -- cat /etc/k`).output).toBe("2");
  });
});

describe("kubectl create configmap|secret", () => {
  // 쿠버네티스 문서의 예: kubectl create secret generic db-user-pass --from-literal=username=admin --from-literal=password='S!B\*d$zDsb='
  // 셸은 작은따옴표를 벗기고 안의 글자(\ 포함)를 그대로 넘긴다.
  test("--from-literal=KEY='값' 의 따옴표는 셸이 벗긴다 (공식 문서 예)", () => {
    const c = cluster();
    expect(kubectl(c, "kubectl create secret generic db-user-pass --from-literal=username=admin --from-literal=password='S!B\\*d$zDsb='").ok).toBe(true);
    expect(kubectl(c, `kubectl create configmap greet --from-literal=GREETING='hello world'`).ok).toBe(true);
    const s = c.api.get("Secret", "db-user-pass")!;
    expect(b64decode(s.data.password!)).toBe("S!B\\*d$zDsb=");
    expect(c.api.get("ConfigMap", "greet")!.data).toEqual({ GREETING: "hello world" });
  });

  // 축소판이라 --from-file·--from-env-file 을 못 하는 것은 괜찮지만, 조용히 빈 ConfigMap 을 만들면 "왜 env 가 비었지" 를 엉뚱하게 배운다
  test("모르는 출처 플래그(--from-file)를 조용히 무시하고 빈 ConfigMap 을 만들지 않는다", () => {
    const c = cluster();
    const r = kubectl(c, "kubectl create configmap cfg --from-file=app.properties");
    expect(r.ok).toBe(false);
    expect(c.api.get("ConfigMap", "cfg")).toBeUndefined();
  });

  test("같은 키를 두 번 주면 kubectl 이 거절한다 (나중 값으로 덮지 않음)", () => {
    const c = cluster();
    const r = kubectl(c, "kubectl create configmap cfg --from-literal=A=1 --from-literal=A=2");
    expect(r.ok).toBe(false);
    expect(r.output).toContain('cannot add key "A", another key by that name already exists');
    expect(c.api.get("ConfigMap", "cfg")).toBeUndefined();
  });

  test("키 이름은 [-._a-zA-Z0-9]+ — 'a/b' 는 거절 (아니면 /etc/config/a/b 같은 없는 디렉터리가 생김)", () => {
    const c = cluster();
    const r = kubectl(c, "kubectl create configmap cfg --from-literal=a/b=1");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("a valid config key must consist of alphanumeric characters, '-', '_' or '.'");
  });
});

describe("apply 는 3-way merge (last-applied)", () => {
  // 실제 kubectl apply: last-applied 에 없던 키(kubectl patch 로 더한 것)는 매니페스트에 없어도 지우지 않는다. last-applied 에 있었는데 빠진 키만 지운다.
  // 이 저장소의 Deployment apply 도 그렇게 한다 (defSync.ts: "라이브에서 kubectl 로 바꾼 값은 매니페스트에 있는 필드만 덮인다").
  test("kubectl patch 로 더한 키는, 매니페스트의 다른 키를 고쳐 다시 apply 해도 남는다", () => {
    const c = cluster();
    c.apply(configMap("cfg", { A: "1", B: "1" }));
    kubectl(c, `kubectl patch cm cfg -p '{"data":{"C":"hand"}}'`);
    c.apply(configMap("cfg", { A: "2" })); // B 는 last-applied 에 있었으니 지워지고, C 는 남아야 한다
    expect(c.api.get("ConfigMap", "cfg")!.data).toEqual({ A: "2", C: "hand" });
  });
});

describe("kubectl get -o yaml 의 따옴표", () => {
  // 값 "a:" 를 따옴표 없이 쓰면 `K: a:` 가 되어 YAML 로 읽히지 않는다 (mapping values are not allowed here). "-" 단독도 시퀀스 표시로 읽힌다.
  test("':' 로 끝나는 값과 '-' 하나뿐인 값은 따옴표로 감싼다", () => {
    const c = cluster();
    c.apply(configMap("cfg", { A: "a:", B: "-" }));
    const y = kubectl(c, "kubectl get cm cfg -o yaml").output;
    expect(y).toMatch(/\n\s+A: ["']a:["']/);
    expect(y).toMatch(/\n\s+B: ["']-["']/);
  });

  // 키 "true" 를 따옴표 없이 쓰면 YAML 1.1 에서 불리언 키가 된다 (kubectl 은 "true": 로 씀). ConfigMap 키로는 올바른 이름이다
  test("불리언·숫자처럼 읽히는 키는 따옴표로 감싼다", () => {
    const c = cluster();
    c.apply(configMap("cfg", { true: "x", "8080": "y" }));
    const y = kubectl(c, "kubectl get cm cfg -o yaml").output;
    expect(y).toMatch(/\n\s+["']true["']: x/);
    // 값 "y" 도 YAML 1.1(go-yaml v2)에서는 불리언이라 따옴표가 붙는다
    expect(y).toMatch(/\n\s+["']8080["']: "y"/);
  });
});

describe("Ingress 검증", () => {
  // 실제 API: spec: Invalid value: ...: either `defaultBackend` or `rules` must be specified
  test("rules 도 defaultBackend 도 없는 Ingress 는 API 서버가 거절한다 (폼에서 마지막 규칙을 지우고 기본 backend 를 '없음' 으로 하면 생김)", () => {
    const c = cluster();
    c.apply(service("web", { selector: { app: "web" }, port: 80 }));
    let err: unknown;
    try {
      c.apply(ingress("empty", { className: "nginx" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as Error).message)).toContain("either `defaultBackend` or `rules` must be specified");
  });

  // 실제 API: RFC 1123 서브도메인 — 레이블 하나는 63자 이하
  test("hostError: 63자를 넘는 레이블은 오류", () => {
    expect(hostError(`${"a".repeat(64)}.example.com`)).toBeDefined();
  });
});

describe("kubectl exec 의 종료 코드", () => {
  // 실제: printenv 가 없는 변수에 exit 1 → kubectl 이 stderr 로 "command terminated with exit code 1"
  test("printenv 없는 변수: command terminated with exit code 1", () => {
    const c = cluster();
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32 }));
    c.runFor(10_000);
    const r = kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- printenv NOPE`);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("command terminated with exit code 1");
  });
});

describe("Secret data 는 바이트 (UTF-8 이 아니어도 됨)", () => {
  // 실제 API: data 는 []byte — 올바른 base64 면 어떤 바이트든 받는다. "/w==" (0xFF) 는 올바른 base64
  test("UTF-8 이 아닌 바이트의 base64 를 'illegal base64' 로 거절하지 않는다", () => {
    const c = cluster();
    c.apply(secret("bin", { a: "x" }));
    const r = kubectl(c, `kubectl patch secret bin -p '{"data":{"blob":"/w=="}}'`);
    expect(r.output).not.toContain("illegal base64");
    expect(r.ok).toBe(true);
    expect(kubectl(c, "kubectl describe secret bin").output).toContain("blob:  1 bytes");
  });
});

describe("envFrom 의 키가 env 이름으로 쓸 수 없으면 건너뛴다 (v1.31)", () => {
  // 실제(v1.31, KUBE_VERSION): IsEnvVarName = [-._a-zA-Z][-._a-zA-Z0-9]* — 숫자로 시작하는 키는 건너뛰고 InvalidEnvironmentVariableNames 이벤트
  test("'1BAD' 키는 env 에 들어가지 않는다", () => {
    const c = cluster();
    c.apply(configMap("cfg", { GOOD: "1", "1BAD": "2" }));
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, envFrom: [{ configMapRef: { name: "cfg" } }] }));
    c.runFor(10_000);
    const env = kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- env`).output;
    expect(env).toContain("GOOD=1");
    expect(env).not.toContain("1BAD=2");
    expect(c.api.events.some((e) => e.reason === "InvalidEnvironmentVariableNames")).toBe(true);
  });
});

// ---- 결함이 아님을 확인한 것 (회귀 방지용으로 남김) ----
describe("확인: 결함 아님", () => {
  test("env 우선순위: envFrom 뒤 것이 앞 것을, env 가 envFrom 을 이긴다", () => {
    const c = cluster();
    c.apply(configMap("a", { K: "a", ONLY_A: "1" }));
    c.apply(secret("b", { K: "b" }));
    c.apply(
      deployment("app", {
        replicas: 1,
        image: "nginx:1.27",
        cpu: 50,
        memory: 32,
        envFrom: [{ configMapRef: { name: "a" } }, { secretRef: { name: "b" } }],
        env: [{ name: "ONLY_A", value: "env" }],
      }),
    );
    c.runFor(10_000);
    const p = live(c, "app")[0]!.metadata.name;
    expect(kubectl(c, `kubectl exec ${p} -- printenv K`).output).toBe("b");
    expect(kubectl(c, `kubectl exec ${p} -- printenv ONLY_A`).output).toBe("env");
  });

  test("ConfigMap 을 지웠다 다시 만들면 1분 뒤 파일이 새 내용, 지운 사이에는 옛 파일 그대로", () => {
    const c = cluster();
    c.apply(configMap("cfg", { K: "1" }));
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, mounts: [{ name: "v", configMap: "cfg", mountPath: "/etc/config" }] }));
    c.runFor(10_000);
    const p = live(c, "app")[0]!.metadata.name;
    kubectl(c, "kubectl delete cm cfg");
    c.runFor(70_000);
    expect(kubectl(c, `kubectl exec ${p} -- cat /etc/config/K`).output).toBe("1");
    kubectl(c, "kubectl create cm cfg --from-literal=K=2 --from-literal=N=3");
    c.runFor(65_000);
    expect(kubectl(c, `kubectl exec ${p} -- ls /etc/config`).output).toBe("K\nN");
    expect(kubectl(c, `kubectl exec ${p} -- cat /etc/config/K`).output).toBe("2");
  });

  test("Pod 를 지우면 FailedMount·CreateContainerConfigError 재시도가 멈춘다 (runToIdle 이 끝남)", () => {
    const c = cluster();
    c.apply(deployment("a", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, mounts: [{ name: "v", configMap: "none", mountPath: "/x" }] }));
    c.apply(deployment("b", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, envFrom: [{ secretRef: { name: "none" } }] }));
    c.runFor(30_000);
    kubectl(c, "kubectl delete deployment a b");
    c.runToIdle();
    expect(pods(c)).toHaveLength(0);
  });

  test("Secret 파일은 풀린 평문, UTF-8 describe 바이트 수, 빈 값·true·': ' 값의 -o yaml", () => {
    const c = cluster();
    c.apply(secret("s", { pw: "안녕" }));
    c.apply(configMap("cfg", { E: "", T: "true", C: "a: b", H: "#x" }));
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, mounts: [{ name: "s", secret: "s", mountPath: "/etc/s" }] }));
    c.runFor(10_000);
    expect(kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- cat /etc/s/pw`).output).toBe("안녕");
    expect(kubectl(c, "kubectl describe secret s").output).toContain("pw:  6 bytes");
    const y = kubectl(c, "kubectl get cm cfg -o yaml").output;
    expect(y).toContain('E: ""');
    expect(y).toContain('T: "true"');
    expect(y).toContain('C: "a: b"');
    expect(y).toContain('H: "#x"');
  });

  test("Git 에서 키를 지우면 OutOfSync → selfHeal 이 라이브에서도 지운다, prune 이 ConfigMap 을 지운다", () => {
    const REPO = "https://github.com/example/app.git";
    const c = cluster();
    c.gitCommit(REPO, { "deploy/a.yaml": configMap("cfg", { A: "1", B: "2" }), "deploy/b.yaml": configMap("gone", { X: "1" }) }, "first");
    c.apply(application("app", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(20_000);
    expect(c.api.get("ConfigMap", "cfg")!.data).toEqual({ A: "1", B: "2" });
    c.gitCommit(REPO, { "deploy/a.yaml": configMap("cfg", { A: "1" }) }, "drop B and gone");
    runArgocd(c, "argocd app get app --refresh");
    c.runFor(30_000);
    expect(c.api.get("ConfigMap", "cfg")!.data).toEqual({ A: "1" });
    expect(c.api.get("ConfigMap", "gone")).toBeUndefined();
    expect(c.api.get("Application", "app", "argocd")!.status.sync.status).toBe("Synced");
  });
});
