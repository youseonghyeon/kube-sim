import { describe, expect, test } from "vitest";
import { deployment } from "../src/core/cluster";
import { runKubectl, table } from "../src/core/kubectl";
import { fmtAge } from "../src/core/units";
import { cluster, pods, web } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);

describe("kubectl get", () => {
  test("get pods: 칸 모양과 STATUS·RESTARTS", () => {
    const c = cluster();
    c.apply(web(2));
    c.runFor(1000);
    let out = k(c, "kubectl get pods").output.split("\n");
    expect(out[0]).toMatch(/^NAME\s{3,}READY   STATUS\s{3,}RESTARTS   AGE$/);
    expect(out.slice(1).every((l) => /\s0\/1\s+ContainerCreating\s+0\s+0s$/.test(l))).toBe(true);
    c.runToIdle();
    out = k(c, "get po -o wide").output.split("\n");
    expect(out[0]).toContain("IP");
    expect(out[0]).toContain("NOMINATED NODE");
    expect(out[1]).toMatch(/1\/1\s+Running\s+0\s+\d+s\s+10\.244\.\d\.\d+\s+worker-\d/);
  });

  test("get deploy / rs / nodes", () => {
    const c = cluster();
    c.apply(web(3));
    c.runToIdle();
    expect(k(c, "get deploy").output).toMatch(/^NAME\s+READY\s+UP-TO-DATE\s+AVAILABLE\s+AGE\nweb\s+3\/3\s+3\s+3\s+\d+s$/);
    expect(k(c, "get rs").output).toMatch(/web-\w+\s+3\s+3\s+3\s+\d+s$/);
    expect(k(c, "get nodes").output.split("\n")[1]).toMatch(/^worker-1\s+Ready\s+<none>\s+\d+s\s+v1\.31\.0$/);
    k(c, "cordon worker-1");
    expect(k(c, "get no").output.split("\n")[1]).toMatch(/Ready,SchedulingDisabled/);
  });

  test("get events 에 FailedScheduling 이 실제 문구로", () => {
    const c = cluster([{ name: "n1", cpu: 500 }]);
    c.apply(deployment("big", { replicas: 1, image: "nginx:1.27", cpu: 1000, memory: 64 }));
    c.runToIdle();
    const out = k(c, "get events").output;
    expect(out).toContain("Warning   FailedScheduling");
    expect(out).toContain("0/1 nodes are available: 1 Insufficient cpu.");
  });

  test("없는 것·모르는 것은 실제와 같은 오류", () => {
    const c = cluster();
    expect(k(c, "get pods").output).toBe("No resources found in default namespace.");
    expect(k(c, "get pdos")).toMatchObject({ ok: false, output: 'error: the server doesn\'t have a resource type "pdos"' });
    expect(k(c, "describe pod nope")).toMatchObject({ ok: false, output: 'Error from server (NotFound): pods "nope" not found' });
    expect(k(c, "frobnicate").output).toMatch(/^error: unknown command "frobnicate" for "kubectl"/);
  });
});

describe("kubectl 으로 바꾸기", () => {
  test("scale → ReplicaSet → Pod", () => {
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    expect(k(c, "kubectl scale deployment/web --replicas=4")).toMatchObject({ ok: true, output: "deployment.apps/web scaled", mutated: true });
    c.runToIdle();
    expect(pods(c)).toHaveLength(4);
    expect(c.trace.events.some((e) => e.kind === "user" && e.msg === "kubectl scale deployment/web --replicas=4")).toBe(true);
  });

  test("delete pod → 다시 생긴다", () => {
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    const name = pods(c)[0]!.metadata.name;
    expect(k(c, `delete pod ${name}`).output).toBe(`pod "${name}" deleted`);
    c.runToIdle();
    expect(pods(c)).toHaveLength(1);
    expect(pods(c)[0]!.metadata.name).not.toBe(name);
  });

  test("create deployment · set image · set resources", () => {
    const c = cluster();
    expect(k(c, "create deployment api --image=redis:7 --replicas=2").output).toBe("deployment.apps/api created");
    c.runToIdle();
    expect(pods(c)).toHaveLength(2);
    expect(k(c, "set image deployment/api api=redis:8").ok).toBe(true);
    // 없는 이미지의 pull 재시도는 끝없이 이어지므로(최대 300초 간격) runToIdle 대신 시간을 정해 돌린다
    c.runFor(5000);
    // 없는 이미지 → ImagePullBackOff 로 가는 중
    expect(k(c, "get pods").output).toMatch(/ErrImagePull|ImagePullBackOff/);
    expect(k(c, "set image deployment/api nope=redis:7").output).toBe('error: unable to find container named "nope"');
    expect(k(c, "set resources deployment/api --requests=cpu=3").ok).toBe(true);
    c.runFor(5000);
    expect(k(c, "get events").output).toContain("Insufficient cpu");
  });

  test("describe pod 에 Events 가 (xN over …) 로 모인다", () => {
    const c = cluster([{ name: "n1" }]);
    c.apply(deployment("crash", { replicas: 1, image: "example/worker:1.0", cpu: 100, memory: 64 }));
    c.runFor(120_000);
    const out = k(c, `describe pod ${pods(c)[0]!.metadata.name}`).output;
    expect(out).toContain("Controlled By:    ReplicaSet/crash-");
    expect(out).toMatch(/Last State:\s+Terminated/);
    expect(out).toMatch(/Exit Code:\s+1/);
    expect(out).toMatch(/Warning\s+BackOff\s+\d+s \(x\d+ over \d+m?\d*s\)\s+kubelet\s+Back-off restarting failed container crash/);
    expect(out).toMatch(/Normal\s+Scheduled\s+.*default-scheduler\s+Successfully assigned default\//);
  });
});

test("table: 칸 사이 3칸, 마지막 칸은 채우지 않음", () => {
  expect(table(["A", "BB"], [["xxxx", "y"]])).toBe("A      BB\nxxxx   y");
});

test("AGE 표기 (HumanDuration)", () => {
  expect([59_000, 119_000, 130_000, 600_000, 3 * 3600_000 + 300_000, 30 * 3600_000, 72 * 3600_000].map(fmtAge)).toEqual(["59s", "119s", "2m10s", "10m", "3h5m", "30h", "3d"]);
});
