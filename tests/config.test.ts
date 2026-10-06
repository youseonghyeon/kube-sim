// 5b: ConfigMap·Secret 과 재시작 — 컨테이너가 설정을 언제 읽고, 바꾸면 무엇이 (안) 바뀌나.
import { describe, expect, test } from "vitest";
import { WATCH_DELAY_MS } from "../src/core/api/server";
import { application, configMap, deployment, secret } from "../src/core/cluster";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { runCommand } from "../src/model/commands";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const live = (c: C, app: string) => pods(c).filter((p) => p.metadata.labels.app === app && p.metadata.deletionTimestamp === undefined);
const traceOf = (c: C, kind: string, from = 0) => c.trace.events.slice(from).filter((e) => e.kind === kind);

/** env 로 GREETING, /etc/config 로 파일, /etc/app/greeting 으로 subPath 파일 */
function app(c: C, extra: Partial<Parameters<typeof deployment>[1]> = {}) {
  c.apply(configMap("app-config", { GREETING: "hello", MODE: "dev" }));
  c.apply(
    deployment("app", {
      replicas: 1,
      image: "example/config-app:1.0",
      cpu: 50,
      memory: 32,
      port: 8080,
      envFrom: [{ configMapRef: { name: "app-config" } }],
      mounts: [
        { name: "config", configMap: "app-config", mountPath: "/etc/config" },
        { name: "config", configMap: "app-config", mountPath: "/etc/app/greeting", subPath: "GREETING" },
      ],
      ...extra,
    }),
  );
  c.runFor(10_000);
  return live(c, "app")[0]!.metadata.name;
}

describe("env 는 시작할 때 한 번", () => {
  test("ConfigMap 을 바꿔도 돌고 있는 컨테이너의 env 는 그대로, 재시작(rollout restart)한 새 Pod 만 새 값", () => {
    const c = cluster();
    const pod = app(c);
    expect(kubectl(c, `kubectl exec ${pod} -- printenv GREETING`).output).toBe("hello");
    const from = c.trace.events.length;
    expect(kubectl(c, `kubectl patch configmap app-config -p '{"data":{"GREETING":"안녕"}}'`).output).toBe("configmap/app-config patched");
    c.runFor(120_000);
    expect(kubectl(c, `kubectl exec ${pod} -- printenv GREETING`).output).toBe("hello");
    expect(traceOf(c, "kubelet.config", from).some((e) => e.msg.includes(`env 로 읽는 ${pod} 의 값은 그대로`))).toBe(true);
    // Deployment 템플릿은 그대로 → 롤아웃이 일어나지 않는다
    expect(c.api.list("ReplicaSet")).toHaveLength(1);
    kubectl(c, "kubectl rollout restart deployment/app");
    c.runFor(60_000);
    const fresh = live(c, "app");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.metadata.name).not.toBe(pod);
    expect(kubectl(c, `kubectl exec ${fresh[0]!.metadata.name} -- printenv GREETING`).output).toBe("안녕");
  });

  test("컨테이너가 크래시로 재시작하면 env 를 다시 만든다 (같은 Pod 라도)", () => {
    const c = cluster();
    c.apply(configMap("cfg", { K: "1" }));
    c.apply(deployment("w", { replicas: 1, image: "example/worker:1.0", cpu: 50, memory: 32, envFrom: [{ configMapRef: { name: "cfg" } }] }));
    c.runFor(3_500); // 시작 직후
    const p = live(c, "w")[0]!.metadata.name;
    kubectl(c, `kubectl patch cm cfg -p '{"data":{"K":"2"}}'`);
    c.runFor(2_000); // 2초 뒤 크래시 → 바로 재시작
    expect(live(c, "w")[0]!.metadata.name).toBe(p);
    expect(kubectl(c, `kubectl exec ${p} -- printenv K`).output).toBe("2");
  });
});

describe("volume 은 잠시 뒤 파일이 바뀐다 (subPath 는 영영 안 바뀜)", () => {
  test("1분 뒤 /etc/config/GREETING 만 바뀌고, 앱의 응답도 파일 쪽만 바뀐다", () => {
    const c = cluster();
    const pod = app(c);
    expect(kubectl(c, `kubectl exec ${pod} -- ls /etc/config`).output).toBe("GREETING\nMODE");
    kubectl(c, `kubectl patch configmap app-config -p '{"data":{"GREETING":"안녕"}}'`);
    const t0 = c.now;
    c.runFor(59_000);
    expect(kubectl(c, `kubectl exec ${pod} -- cat /etc/config/GREETING`).output).toBe("hello");
    c.runFor(2_000);
    expect(kubectl(c, `kubectl exec ${pod} -- cat /etc/config/GREETING`).output).toBe("안녕");
    expect(kubectl(c, `kubectl exec ${pod} -- cat /etc/app/greeting`).output).toBe("hello"); // subPath
    const upd = traceOf(c, "kubelet.config").find((e) => e.msg.includes("파일 갱신"))!;
    expect(upd.t - t0).toBe(60_000 + WATCH_DELAY_MS); // watch 로 변경을 알기까지 + kubelet 동기화 주기
    expect(upd.msg).toContain("subPath 파일 /etc/app/greeting 은 바뀌지 않음");
    const client = c.requestFromPod(pod, "curl", `http://${live(c, "app")[0]!.status.podIP}:8080`);
    expect(client.output).toContain("env  GREETING=hello");
    expect(client.output).toContain("file /etc/config/GREETING = 안녕");
  });
});

describe("없는 ConfigMap·Secret·키", () => {
  test("env: CreateContainerConfigError (실제 문구) → 만들어 주면 10초 안에 뜬다", () => {
    const c = cluster();
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, envFrom: [{ configMapRef: { name: "app-config" } }] }));
    c.runFor(15_000);
    expect(kubectl(c, "kubectl get pods").output).toContain("CreateContainerConfigError");
    expect(c.api.events.some((e) => e.reason === "Failed" && e.message === 'Error: configmap "app-config" not found')).toBe(true);
    kubectl(c, "kubectl create configmap app-config --from-literal=GREETING=hi --from-literal=MODE=prod");
    c.runFor(10_000);
    expect(kubectl(c, "kubectl get pods").output).toMatch(/1\/1\s+Running/);
    expect(kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- env`).output).toMatch(/GREETING=hi\nMODE=prod/);
  });

  test("없는 키: couldn't find key …", () => {
    const c = cluster();
    c.apply(configMap("cfg", { A: "1" }));
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, env: [{ name: "B", valueFrom: { configMapKeyRef: { name: "cfg", key: "B" } } }] }));
    c.runFor(15_000);
    const cs = live(c, "app")[0]!.status.containerStatuses[0]!;
    expect(cs.state).toEqual({ waiting: { reason: "CreateContainerConfigError", message: "couldn't find key B in ConfigMap default/cfg" } });
  });

  test("volume: ContainerCreating 에 머물며 FailedMount (이미지 pull 도 안 함) → 만들어 주면 뜬다", () => {
    const c = cluster();
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, mounts: [{ name: "tls", secret: "web-tls", mountPath: "/etc/tls" }] }));
    c.runFor(30_000);
    expect(kubectl(c, "kubectl get pods").output).toMatch(/0\/1\s+ContainerCreating/);
    expect(c.api.events.some((e) => e.reason === "FailedMount" && e.message === 'MountVolume.SetUp failed for volume "tls" : secret "web-tls" not found')).toBe(true);
    expect(traceOf(c, "kubelet.pull")).toHaveLength(0);
    kubectl(c, "kubectl create secret generic web-tls --from-literal=tls.crt=CERT");
    c.runFor(40_000);
    expect(kubectl(c, "kubectl get pods").output).toMatch(/1\/1\s+Running/);
    expect(kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- cat /etc/tls/tls.crt`).output).toBe("CERT");
  });
});

describe("Secret 은 base64 (암호화 아님)", () => {
  test("stringData 로 만들면 data 에 base64 로 저장되고, describe 는 바이트 수만, -o yaml 은 base64, base64 -d 로 풀린다", () => {
    const c = cluster();
    c.apply(secret("db", { password: "s3cr3t!" }));
    c.apply(deployment("app", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, env: [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db", key: "password" } } }] }));
    c.runFor(10_000);
    const s = c.api.get("Secret", "db")!;
    expect(s.data).toEqual({ password: "czNjcjN0IQ==" });
    expect(s).not.toHaveProperty("stringData");
    expect(kubectl(c, "kubectl get secrets").output).toMatch(/db\s+Opaque\s+1/);
    expect(kubectl(c, "kubectl describe secret db").output).toContain("password:  7 bytes");
    expect(kubectl(c, "kubectl get secret db -o yaml").output).toContain("password: czNjcjN0IQ==");
    expect(runCommand(c, "echo czNjcjN0IQ== | base64 -d").output).toBe("s3cr3t!");
    expect(runCommand(c, "echo '!!' | base64 -d").ok).toBe(false);
    expect(kubectl(c, `kubectl exec ${live(c, "app")[0]!.metadata.name} -- printenv DB_PASSWORD`).output).toBe("s3cr3t!");
    // data 로 patch 할 때 base64 가 아니면 API 서버가 거절
    expect(kubectl(c, `kubectl patch secret db -p '{"data":{"password":"plain!"}}'`).output).toContain("illegal base64 data");
    expect(kubectl(c, `kubectl patch secret db -p '{"stringData":{"password":"new"}}'`).ok).toBe(true);
    expect(c.api.get("Secret", "db")!.data.password).toBe("bmV3");
  });
});

describe("kubectl 흉내", () => {
  test("create · get · describe · patch(null 로 키 지우기) · delete configmap", () => {
    const c = cluster();
    expect(kubectl(c, "kubectl create configmap cfg --from-literal=A=1 --from-literal=B=x=y").output).toBe("configmap/cfg created");
    expect(c.api.get("ConfigMap", "cfg")!.data).toEqual({ A: "1", B: "x=y" });
    expect(kubectl(c, "kubectl create cm cfg --from-literal=A=1").output).toContain("AlreadyExists");
    expect(kubectl(c, "kubectl get cm").output).toMatch(/cfg\s+2\s+/);
    expect(kubectl(c, "kubectl describe configmap cfg").output).toContain("Data\n====\nA:\n----\n1\n");
    kubectl(c, `kubectl patch cm cfg -p '{"data":{"A":null,"C":"3"}}'`);
    expect(c.api.get("ConfigMap", "cfg")!.data).toEqual({ B: "x=y", C: "3" });
    expect(kubectl(c, "kubectl delete configmap cfg").ok).toBe(true);
    expect(kubectl(c, "kubectl get cm cfg").output).toContain('configmaps "cfg" not found');
  });
});

describe("GitOps: Helm values → ConfigMap 이 sync 돼도 Pod 는 그대로 (checksum 주석이 있어야 롤아웃)", () => {
  const REPO = "https://github.com/example/app.git";
  const files = (greeting: string, checksum: boolean) => ({
    "deploy/configmap.yaml": configMap("app-config", { GREETING: greeting }),
    "deploy/secret.yaml": secret("app-secret", { TOKEN: "t0ken" }),
    "deploy/deployment.yaml": deployment("app", {
      replicas: 1,
      image: "example/config-app:1.0",
      cpu: 50,
      memory: 32,
      port: 8080,
      envFrom: [{ configMapRef: { name: "app-config" } }, { secretRef: { name: "app-secret" } }],
      ...(checksum ? { podAnnotations: { "checksum/config": greeting === "hello" ? "a1" : "b2" } } : {}),
    }),
  });
  const setup = (checksum: boolean) => {
    const c = cluster();
    c.gitCommit(REPO, files("hello", checksum), "first");
    c.apply(application("app", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(20_000);
    return c;
  };
  const sync = (c: C) => {
    runArgocd(c, "argocd app get app --refresh");
    c.runFor(30_000);
  };

  test("checksum 없이: ConfigMap 만 바뀌고 Synced, Pod·ReplicaSet 은 그대로 → env 는 옛 값", () => {
    const c = setup(false);
    expect(c.api.get("Application", "app", "argocd")!.status.sync.status).toBe("Synced");
    const pod = live(c, "app")[0]!.metadata.name;
    c.gitCommit(REPO, files("안녕", false), "values: greeting");
    sync(c);
    expect(c.api.get("ConfigMap", "app-config")!.data.GREETING).toBe("안녕");
    expect(c.api.get("Application", "app", "argocd")!.status.sync.status).toBe("Synced");
    expect(live(c, "app")[0]!.metadata.name).toBe(pod);
    expect(c.api.list("ReplicaSet")).toHaveLength(1);
    expect(kubectl(c, `kubectl exec ${pod} -- printenv GREETING`).output).toBe("hello");
    expect(kubectl(c, `kubectl exec ${pod} -- printenv TOKEN`).output).toBe("t0ken");
  });

  test("checksum/config 주석이 바뀌면 템플릿 해시가 바뀌어 롤링 업데이트 → 새 Pod 가 새 값", () => {
    const c = setup(true);
    c.gitCommit(REPO, files("안녕", true), "values: greeting");
    sync(c);
    const pods2 = live(c, "app");
    expect(c.api.list("ReplicaSet")).toHaveLength(2);
    expect(kubectl(c, `kubectl exec ${pods2[0]!.metadata.name} -- printenv GREETING`).output).toBe("안녕");
  });

  test("Git 의 Secret(stringData) 과 라이브(data base64)를 같다고 본다 — selfHeal 이 끝없이 돌지 않음", () => {
    const c = setup(false);
    const n = c.trace.events.filter((e) => e.kind === "gitops.sync").length;
    c.runFor(10 * 60_000);
    expect(c.trace.events.filter((e) => e.kind === "gitops.sync").length).toBe(n);
    kubectl(c, `kubectl patch cm app-config -p '{"data":{"GREETING":"hand-edit"}}'`);
    c.runFor(1_000);
    expect(c.api.get("Application", "app", "argocd")!.status.sync.status).toBe("OutOfSync");
    c.runFor(10_000);
    expect(c.api.get("ConfigMap", "app-config")!.data.GREETING).toBe("hello"); // selfHeal 이 되돌림
  });
});

describe("예제 '설정' 묶음이 학습 포인트를 실제로 보여 준다", () => {
  const load = async (id: string) => {
    const { DefSync } = await import("../src/model/defSync");
    const { exampleById } = await import("../src/model/examples");
    const s = new DefSync();
    const def = exampleById(id)!.build();
    s.reset(def, id);
    s.cluster.runFor(15_000);
    return { s, def, c: s.cluster };
  };
  const curl = (c: C) => c.requestFromPod(live(c, "client")[0]!.metadata.name, "curl", "http://app").output;

  test("config-env: patch 직후 그대로 → 1분 뒤 파일만 → 재시작하면 env 도", async () => {
    const { c } = await load("config-env");
    expect(curl(c)).toMatch(/env {2}GREETING=hello[\s\S]*file \/etc\/config\/GREETING = hello[\s\S]*file \/etc\/app\/greeting = hello/);
    kubectl(c, `kubectl patch configmap app-config -p '{"data":{"GREETING":"안녕"}}'`);
    c.runFor(1_000);
    expect(curl(c)).not.toContain("안녕");
    c.runFor(60_000);
    const out = curl(c);
    expect(out).toContain("env  GREETING=hello");
    expect(out).toContain("file /etc/config/GREETING = 안녕");
    expect(out).toContain("file /etc/app/greeting = hello");
    kubectl(c, "kubectl rollout restart deployment/app");
    c.runFor(60_000);
    expect(curl(c)).toMatch(/env {2}GREETING=안녕[\s\S]*file \/etc\/app\/greeting = 안녕/);
  });

  test("config-checksum: checksum 없으면 롤아웃 없음, 있으면 롤아웃 · 값이 다시 바뀌면 또 롤아웃", async () => {
    const { helmUpgrade, helmUpgradeBlocked } = await import("../src/model/helm");
    const { s, c, def: first } = await load("config-checksum");
    let def = first;
    const step = (data: Record<string, string>, checksum: boolean) => {
      const a = { type: "helm-upgrade" as const, configMap: "app-config", deployment: "app", data, checksum };
      expect(helmUpgradeBlocked(def, a)).toBeUndefined();
      def = helmUpgrade(def, a);
      s.sync(def);
      c.runFor(60_000);
    };
    step({ GREETING: "안녕" }, false);
    expect(c.api.list("ReplicaSet").filter((r) => r.metadata.labels.app === "app")).toHaveLength(1);
    expect(curl(c)).toContain("env  GREETING=hello");
    step({ GREETING: "안녕" }, true);
    expect(c.api.list("ReplicaSet").filter((r) => r.metadata.labels.app === "app")).toHaveLength(2);
    expect(curl(c)).toContain("env  GREETING=안녕");
    expect(helmUpgradeBlocked(def, { type: "helm-upgrade", configMap: "app-config", deployment: "app", data: { GREETING: "안녕" }, checksum: true })).toBe("이미 그 값입니다");
    step({ GREETING: "반가워" }, true);
    expect(c.api.list("ReplicaSet").filter((r) => r.metadata.labels.app === "app")).toHaveLength(3);
    expect(curl(c)).toContain("env  GREETING=반가워");
  });

  test("config-missing: 둘 다 멈춰 있다가, 만들어 주면 2분 안에 둘 다 Running", async () => {
    const { c } = await load("config-missing");
    const out = kubectl(c, "kubectl get pods").output;
    expect(out).toMatch(/api-\S+\s+0\/1\s+CreateContainerConfigError/);
    expect(out).toMatch(/web-\S+\s+0\/1\s+ContainerCreating/);
    kubectl(c, "kubectl create configmap app-config --from-literal=GREETING=hello");
    kubectl(c, "kubectl create secret generic web-tls --from-literal=tls.crt=CERT --from-literal=tls.key=KEY");
    c.runFor(120_000);
    expect(kubectl(c, "kubectl get pods").output).not.toMatch(/CreateContainerConfigError|ContainerCreating/);
    expect(kubectl(c, `kubectl exec ${live(c, "api")[0]!.metadata.name} -- printenv DB_PASSWORD`).output).toBe("s3cr3t!");
  });
});
