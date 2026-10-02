// kubelet: 노드마다 하나. 자기 노드에 바인딩된 Pod 를 watch 해서 샌드박스(IP) → 이미지 pull → 컨테이너 시작 → 크래시면 백오프 재시작 → 삭제면 SIGTERM·정리.
// 상태는 API 의 Pod status 로만 알린다 (다른 컴포넌트와 직접 이야기하지 않음).
// 축소판: 컨테이너는 Pod 마다 첫 번째 하나만 돌린다. probe 는 2단계, heartbeat·NotReady 는 1단계 후반.
import { refOf, type WatchEvent } from "./api/server";
import type { ContainerState, Node, Pod } from "./api/types";
import type { TimerHandle } from "./clock";
import type { ComponentContext } from "./controllers/base";
import { setCondition } from "./scheduler";
import { fmtCpu, fmtMem } from "./units";
import { imageSpec } from "./workloads";

/** 샌드박스(pause 컨테이너)·CNI 로 IP 받는 시간 */
export const SANDBOX_MS = 500;
/** 컨테이너 만들고 시작하는 시간 */
export const CREATE_MS = 300;
/** 레지스트리에 없는 이미지를 찾다 실패하기까지 */
export const PULL_FAIL_MS = 800;
/** 크래시·pull 실패 백오프: 10초부터 두 배, 최대 5분 (실제값) */
export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_MAX_MS = 300_000;
/** 이만큼 잘 돌다 죽으면 백오프를 처음부터 */
export const BACKOFF_RESET_MS = 600_000;

export interface NodeDef {
  name: string;
  /** millicore */
  cpu: number;
  /** MiB */
  memory: number;
  maxPods?: number;
  labels?: Record<string, string>;
  /** 미리 받아 둔 이미지 */
  images?: string[];
}

type Stage = "sandbox" | "pulling" | "pull-backoff" | "creating" | "running" | "crash-backoff" | "terminating";

interface PodRt {
  uid: string;
  name: string;
  ns: string;
  ip: string;
  stage: Stage;
  timer?: TimerHandle;
  restarts: number;
  /** 다음 크래시 재시작 대기(ms). 0 이면 바로 (첫 재시작) */
  crashBackoff: number;
  pullBackoff: number;
  startedAt?: number;
}

export class Kubelet {
  readonly actor: string;
  readonly podCIDR: string;
  readonly ip: string;
  private readonly pods = new Map<string, PodRt>();
  /** 받는 중인 이미지 → 끝나면 부를 것들 (같은 이미지는 한 번만 받는다) */
  private readonly pulls = new Map<string, (() => void)[]>();
  private nextIp = 2;
  private readonly unwatch: () => void;
  private stopped = false;

  readonly def: NodeDef;

  constructor(
    private readonly ctx: ComponentContext,
    def: NodeDef,
    index: number,
  ) {
    this.def = { ...def };
    this.actor = `kubelet@${def.name}`;
    this.podCIDR = `10.244.${index}.0/24`;
    this.ip = `192.168.0.${10 + index}`;
    this.unwatch = ctx.api.watch("Pod", (ev) => this.onPod(ev));
  }

  get nodeName(): string {
    return this.def.name;
  }

  /** 노드 오브젝트를 API 에 올린다 (kubelet 의 자기 등록) */
  register(): void {
    const { def } = this;
    const maxPods = def.maxPods ?? 110;
    this.ctx.api.create<"Node">(
      {
        apiVersion: "v1",
        kind: "Node",
        metadata: { name: def.name, labels: { "kubernetes.io/hostname": def.name, "kubernetes.io/os": "linux", ...(def.labels ?? {}) } },
        spec: { podCIDR: this.podCIDR },
        status: {
          capacity: { cpu: def.cpu, memory: def.memory, pods: maxPods },
          allocatable: { cpu: def.cpu, memory: def.memory, pods: maxPods },
          conditions: [{ type: "Ready", status: "True", reason: "KubeletReady", message: "kubelet is posting ready status", lastTransitionTime: this.ctx.clock.now }],
          addresses: [
            { type: "InternalIP", address: this.ip },
            { type: "Hostname", address: def.name },
          ],
          images: [...(def.images ?? [])],
        },
      },
      this.actor,
    );
    this.ctx.trace.add(this.actor, "node.register", `노드 ${def.name} 등록 (cpu ${fmtCpu(def.cpu)} · memory ${fmtMem(def.memory)} · PodCIDR ${this.podCIDR}) → Ready`, { kind: "Node", name: def.name });
  }

  /** 노드 자원을 바꾼다 (실제로는 kubelet 을 새 설정으로 다시 띄우는 것) → Node status 갱신 → 스케줄러가 기다리던 Pod 를 다시 본다 */
  resize(cpu: number, memory: number): void {
    if (cpu === this.def.cpu && memory === this.def.memory) return;
    this.def.cpu = cpu;
    this.def.memory = memory;
    this.ctx.api.patch("Node", this.def.name, undefined, this.actor, (n) => {
      n.status.capacity = { ...n.status.capacity, cpu, memory };
      n.status.allocatable = { ...n.status.allocatable, cpu, memory };
    });
    this.ctx.trace.add(this.actor, "node.register", `노드 ${this.def.name} 자원 변경 → cpu ${fmtCpu(cpu)} · memory ${fmtMem(memory)} 로 다시 보고 (축소판: 이미 올라간 Pod 는 넘쳐도 그대로)`, { kind: "Node", name: this.def.name });
  }

  /** 노드를 클러스터에서 뺄 때: 모든 타이머를 멈추고 더 이상 watch 하지 않는다 */
  stop(): void {
    this.stopped = true;
    this.unwatch();
    for (const rt of this.pods.values()) rt.timer?.cancel();
    this.pods.clear();
  }

  // ---------- watch ----------

  private onPod(ev: WatchEvent<"Pod">): void {
    const p = ev.object;
    if (this.stopped || p.spec.nodeName !== this.def.name) return;
    const rt = this.pods.get(p.metadata.uid);
    if (ev.type === "DELETED") {
      if (rt) {
        rt.timer?.cancel();
        this.pods.delete(p.metadata.uid);
      }
      return;
    }
    if (p.metadata.deletionTimestamp !== undefined) {
      if (rt) {
        if (rt.stage !== "terminating") this.terminate(rt, p);
      } else if (this.ctx.api.get("Pod", p.metadata.name, p.metadata.namespace)?.metadata.uid === p.metadata.uid) {
        // 시작도 하기 전에 지워진 Pod: 멈출 컨테이너가 없으니 바로 정리
        this.ctx.api.finalizePod(p.metadata.name, p.metadata.namespace, p.metadata.uid, this.actor);
      }
      return;
    }
    if (!rt) this.admit(p);
  }

  // ---------- 수명주기 ----------

  private admit(p: Pod): void {
    const rt: PodRt = {
      uid: p.metadata.uid,
      name: p.metadata.name,
      ns: p.metadata.namespace ?? "default",
      ip: this.allocIp(),
      stage: "sandbox",
      restarts: 0,
      crashBackoff: 0,
      pullBackoff: 0,
    };
    this.pods.set(rt.uid, rt);
    const now = this.ctx.clock.now;
    this.ctx.trace.add(this.actor, "kubelet.sandbox", `${rt.name} 이(가) 이 노드에 바인딩됨 → 샌드박스 생성, CNI 가 PodCIDR ${this.podCIDR} 에서 IP ${rt.ip} 할당`, refOf(p));
    this.patchPod(rt, (o) => {
      o.status.phase = "Pending";
      o.status.hostIP = this.ip;
      o.status.startTime = now;
      setCondition(o, "Initialized", "True", now);
      setCondition(o, "Ready", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
      setCondition(o, "ContainersReady", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
      o.status.containerStatuses = o.spec.containers.map((c) => ({
        name: c.name,
        image: c.image,
        ready: false,
        started: false,
        restartCount: 0,
        state: { waiting: { reason: "ContainerCreating" } },
      }));
    });
    rt.timer = this.ctx.clock.after(SANDBOX_MS, this.actor, () => {
      this.patchPod(rt, (o) => {
        o.status.podIP = rt.ip;
      });
      this.pull(rt);
    });
  }

  private pull(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    const c = p.spec.containers[0]!;
    const image = c.image;
    const node = this.ctx.api.get("Node", this.def.name);
    rt.stage = "pulling";
    if (node?.status.images.includes(image)) {
      this.event(p, "Normal", "Pulled", `Container image "${image}" already present on machine`);
      rt.timer = this.ctx.clock.after(CREATE_MS, this.actor, () => this.start(rt));
      return;
    }
    const spec = imageSpec(image);
    this.event(p, "Normal", "Pulling", `Pulling image "${image}"`);
    if (!spec) {
      this.ctx.trace.add(this.actor, "kubelet.pull", `${rt.name} 이미지 ${image} 가 노드에 없음 → 레지스트리에서 받기 시작`, refOf(p));
      rt.timer = this.ctx.clock.after(PULL_FAIL_MS, this.actor, () => this.pullFailed(rt, image));
      return;
    }
    const waiting = this.pulls.get(image);
    this.ctx.trace.add(
      this.actor,
      "kubelet.pull",
      waiting ? `${rt.name} 이미지 ${image} 를 이미 받는 중 → 끝나기를 기다림` : `${rt.name} 이미지 ${image} 가 노드에 없음 → 레지스트리에서 받기 시작 (${spec.sizeMB}MB, 약 ${spec.pullMs / 1000}초)`,
      refOf(p),
    );
    const startedAt = this.ctx.clock.now;
    const done = () => {
      if (rt.stage !== "pulling" || !this.pods.has(rt.uid)) return;
      const live = this.livePod(rt);
      if (!live) return;
      const took = ((this.ctx.clock.now - startedAt) / 1000).toFixed(1).replace(/\.0$/, "");
      this.event(live, "Normal", "Pulled", `Successfully pulled image "${image}" in ${took}s. Image size: ${spec.sizeMB * 1_000_000} bytes.`);
      rt.timer = this.ctx.clock.after(CREATE_MS, this.actor, () => this.start(rt));
    };
    if (waiting) {
      waiting.push(done);
      return;
    }
    this.pulls.set(image, [done]);
    this.ctx.clock.after(spec.pullMs, this.actor, () => {
      const cbs = this.pulls.get(image) ?? [];
      this.pulls.delete(image);
      if (this.stopped) return;
      this.ctx.api.patch("Node", this.def.name, undefined, this.actor, (n: Node) => {
        if (!n.status.images.includes(image)) n.status.images.push(image);
      });
      for (const cb of cbs) cb();
    });
  }

  private pullFailed(rt: PodRt, image: string): void {
    const p = this.livePod(rt);
    if (!p) return;
    rt.stage = "pull-backoff";
    const delay = rt.pullBackoff || BACKOFF_BASE_MS;
    rt.pullBackoff = Math.min(delay * 2, BACKOFF_MAX_MS);
    this.event(p, "Warning", "Failed", `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to pull and unpack image "${fullRef(image)}": not found`);
    this.event(p, "Warning", "Failed", "Error: ErrImagePull");
    this.ctx.trace.add(this.actor, "kubelet.pull.fail", `${rt.name} 레지스트리에 ${image} 없음 (NotFound) → ErrImagePull → ${delay / 1000}초 백오프 뒤 다시 받기 (ImagePullBackOff)`, refOf(p));
    this.setWaiting(rt, "ErrImagePull", `rpc error: code = NotFound desc = failed to pull and unpack image "${fullRef(image)}": not found`);
    rt.timer = this.ctx.clock.after(1000, this.actor, () => {
      const live = this.livePod(rt);
      if (!live) return;
      this.event(live, "Normal", "BackOff", `Back-off pulling image "${image}"`);
      this.event(live, "Warning", "Failed", "Error: ImagePullBackOff");
      this.setWaiting(rt, "ImagePullBackOff", `Back-off pulling image "${image}"`);
      rt.timer = this.ctx.clock.after(delay - 1000, this.actor, () => this.pull(rt));
    });
  }

  private start(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    const c = p.spec.containers[0]!;
    const spec = imageSpec(c.image);
    const now = this.ctx.clock.now;
    rt.stage = "running";
    rt.startedAt = now;
    this.event(p, "Normal", "Created", `Created container: ${c.name}`);
    this.event(p, "Normal", "Started", `Started container ${c.name}`);
    this.ctx.trace.add(
      this.actor,
      "kubelet.start",
      `${rt.name} 컨테이너 ${c.name} 시작 (${c.image}${rt.restarts ? `, ${rt.restarts}번째 재시작` : ""}) → Running · readiness probe 없음 → 바로 Ready`,
      refOf(p),
    );
    this.patchPod(rt, (o) => {
      o.status.phase = "Running";
      const cs = o.status.containerStatuses[0];
      if (cs) {
        cs.state = { running: { startedAt: now } };
        cs.ready = true;
        cs.started = true;
        cs.restartCount = rt.restarts;
      }
      setCondition(o, "ContainersReady", "True", now);
      setCondition(o, "Ready", "True", now);
    });
    if (spec?.crashAfterMs !== undefined) rt.timer = this.ctx.clock.after(spec.crashAfterMs, this.actor, () => this.crash(rt, spec.exitCode ?? 1));
  }

  private crash(rt: PodRt, exitCode: number): void {
    const p = this.livePod(rt);
    if (!p) return;
    const c = p.spec.containers[0]!;
    const now = this.ctx.clock.now;
    const ran = now - (rt.startedAt ?? now);
    if (ran >= BACKOFF_RESET_MS) rt.crashBackoff = 0;
    const delay = rt.crashBackoff;
    rt.crashBackoff = delay === 0 ? BACKOFF_BASE_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
    rt.stage = "crash-backoff";
    const terminated: ContainerState = { terminated: { reason: "Error", exitCode, startedAt: rt.startedAt, finishedAt: now } };
    this.ctx.trace.add(
      this.actor,
      "kubelet.exit",
      `${rt.name} 컨테이너 ${c.name} 종료 (exit ${exitCode}, ${(ran / 1000).toFixed(1)}초 실행) → restartPolicy Always → ${delay === 0 ? "바로 재시작 (첫 재시작은 백오프 없음)" : `${delay / 1000}초 백오프 뒤 재시작`}`,
      refOf(p),
    );
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs) {
        cs.state = terminated;
        cs.ready = false;
        cs.started = false;
      }
      setCondition(o, "ContainersReady", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
      setCondition(o, "Ready", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
    });
    if (delay === 0) {
      rt.timer = this.ctx.clock.after(CREATE_MS, this.actor, () => this.restart(rt));
      return;
    }
    rt.timer = this.ctx.clock.after(500, this.actor, () => {
      const live = this.livePod(rt);
      if (!live) return;
      const ns = rt.ns;
      this.event(live, "Warning", "BackOff", `Back-off restarting failed container ${c.name} in pod ${rt.name}_${ns}(${rt.uid})`);
      this.ctx.trace.add(this.actor, "kubelet.backoff", `${rt.name} CrashLoopBackOff — ${delay / 1000}초 기다린 뒤 재시작 (다음 백오프 ${rt.crashBackoff / 1000}초, 최대 ${BACKOFF_MAX_MS / 1000}초)`, refOf(live));
      this.patchPod(rt, (o) => {
        const cs = o.status.containerStatuses[0];
        if (!cs) return;
        cs.lastState = terminated;
        cs.state = { waiting: { reason: "CrashLoopBackOff", message: `back-off ${fmtBackoff(delay)} restarting failed container=${c.name} pod=${rt.name}_${ns}(${rt.uid})` } };
      });
      rt.timer = this.ctx.clock.after(delay - 500, this.actor, () => this.restart(rt));
    });
  }

  private restart(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    rt.restarts++;
    this.event(p, "Normal", "Pulled", `Container image "${p.spec.containers[0]!.image}" already present on machine`);
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs && "terminated" in cs.state) cs.lastState = cs.state;
    });
    this.start(rt);
  }

  private terminate(rt: PodRt, p: Pod): void {
    rt.timer?.cancel();
    const wasRunning = rt.stage === "running";
    rt.stage = "terminating";
    const c = p.spec.containers[0]!;
    const grace = (p.metadata.deletionGracePeriodSeconds ?? p.spec.terminationGracePeriodSeconds) * 1000;
    if (!wasRunning) {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 삭제 요청 — 돌고 있는 컨테이너 없음 → 바로 정리`, refOf(p));
      rt.timer = this.ctx.clock.after(100, this.actor, () => this.finish(rt, 0));
      return;
    }
    this.event(p, "Normal", "Killing", `Stopping container ${c.name}`);
    const termMs = imageSpec(c.image)?.termMs ?? 300;
    if (termMs <= grace) {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 삭제 요청 → 컨테이너 ${c.name} 에 SIGTERM → 앱이 ${termMs / 1000}초 만에 종료 (유예 ${grace / 1000}초 안)`, refOf(p));
      rt.timer = this.ctx.clock.after(termMs, this.actor, () => this.finish(rt, 0));
    } else {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 삭제 요청 → SIGTERM → 유예 ${grace / 1000}초 안에 안 끝남 → SIGKILL`, refOf(p));
      rt.timer = this.ctx.clock.after(grace, this.actor, () => this.finish(rt, 137));
    }
  }

  private finish(rt: PodRt, exitCode: number): void {
    const now = this.ctx.clock.now;
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs) {
        cs.state = { terminated: { reason: exitCode === 0 ? "Completed" : "Error", exitCode, startedAt: rt.startedAt, finishedAt: now } };
        cs.ready = false;
        cs.started = false;
      }
      setCondition(o, "ContainersReady", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
      setCondition(o, "Ready", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
    });
    this.ctx.trace.add(this.actor, "kubelet.removed", `${rt.name} 컨테이너 정리 끝 → API 에서 Pod 최종 삭제, IP ${rt.ip} 반납`, { kind: "Pod", namespace: rt.ns, name: rt.name });
    this.pods.delete(rt.uid);
    this.ctx.api.finalizePod(rt.name, rt.ns, rt.uid, this.actor);
  }

  // ---------- 도우미 ----------

  /** 아직 같은 uid 로 살아 있고 지워지는 중이 아닌 Pod */
  private livePod(rt: PodRt): Pod | undefined {
    if (!this.pods.has(rt.uid) || rt.stage === "terminating") return undefined;
    const p = this.ctx.api.get("Pod", rt.name, rt.ns);
    if (!p || p.metadata.uid !== rt.uid || p.metadata.deletionTimestamp !== undefined) return undefined;
    return p;
  }

  private patchPod(rt: PodRt, mutate: (p: Pod) => void): void {
    const p = this.ctx.api.get("Pod", rt.name, rt.ns);
    if (!p || p.metadata.uid !== rt.uid) return;
    this.ctx.api.patch("Pod", rt.name, rt.ns, this.actor, mutate);
  }

  private setWaiting(rt: PodRt, reason: string, message: string): void {
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs) cs.state = { waiting: { reason, message } };
    });
  }

  private event(p: Pod, type: "Normal" | "Warning", reason: string, message: string): void {
    this.ctx.api.recordEvent(p, type, reason, message, this.actor);
  }

  private allocIp(): string {
    const used = new Set([...this.pods.values()].map((r) => r.ip));
    for (let i = 0; i < 253; i++) {
      const n = this.nextIp;
      this.nextIp = n >= 254 ? 2 : n + 1;
      const ip = this.podCIDR.replace(/\.0\/24$/, `.${n}`);
      if (!used.has(ip)) return ip;
    }
    throw new Error(`${this.def.name}: PodCIDR ${this.podCIDR} 에 남은 IP 가 없습니다`);
  }
}

function names(p: Pod): string {
  return p.spec.containers.map((c) => c.name).join(" ");
}

function fullRef(image: string): string {
  const [first] = image.split("/");
  if (image.includes("/") && first && (first.includes(".") || first.includes(":"))) return image;
  return image.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}

/** 실제 kubelet 메시지 모양: 10s · 20s · 40s · 1m20s · 2m40s · 5m0s */
function fmtBackoff(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
