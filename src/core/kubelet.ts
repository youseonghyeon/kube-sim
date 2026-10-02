// kubelet: 노드마다 하나. 자기 노드에 바인딩된 Pod 를 watch 해서 샌드박스(IP) → 이미지 pull → 컨테이너 시작 → 크래시면 백오프 재시작 → 삭제면 SIGTERM·정리.
// 상태는 API 의 Pod status 로만 알린다 (다른 컴포넌트와 직접 이야기하지 않음).
// 축소판: 컨테이너는 Pod 마다 첫 번째 하나만 돌린다. probe 는 2단계, heartbeat·NotReady 는 1단계 후반.
import { refOf, type WatchEvent } from "./api/server";
import { NODE_LEASE_NS, type ContainerState, type Node, type Pod } from "./api/types";
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
/** Lease 갱신 주기 (실제값: leaseDuration 40초의 1/4) */
export const HEARTBEAT_MS = 10_000;
export const LEASE_DURATION_S = 40;
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
  /** readiness probe 주기 (배경 타이머) */
  probe?: TimerHandle;
  probeFailures: number;
  probeReady: boolean;
  /** 사용자가 "앱 고장" 으로 만든 상태 — /ready 와 요청에 503 */
  sick: boolean;
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
  /** 전원(kubelet 프로세스)이 켜져 있는지. 꺼지면 heartbeat 도, watch 도, 컨테이너도 멈춘다 */
  private powered = true;
  /** 꺼졌다 켜질 때마다 +1 — 꺼지기 전에 걸어 둔 타이머가 켜진 뒤에 발화하지 않게 */
  private epoch = 0;
  private heartbeat?: TimerHandle;

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
    const node = this.ctx.api.get("Node", def.name)!;
    // heartbeat: kube-node-lease 의 Lease 를 10초마다 갱신. Node 가 주인이라 Node 를 지우면 가비지 컬렉터가 함께 지운다
    const owner = [{ apiVersion: "v1", kind: "Node", name: def.name, uid: node.metadata.uid, controller: false }];
    if (this.ctx.api.get("Lease", def.name, NODE_LEASE_NS)) {
      // 같은 이름의 옛 노드 Lease 가 아직 남아 있음 (가비지 컬렉터가 지우기 전) → 새 노드가 이어받는다
      this.ctx.api.patch("Lease", def.name, NODE_LEASE_NS, this.actor, (l) => {
        l.metadata.ownerReferences = owner;
        l.spec.renewTime = this.ctx.clock.now;
      });
    } else {
      this.ctx.api.create<"Lease">(
        {
          apiVersion: "coordination.k8s.io/v1",
          kind: "Lease",
          metadata: { name: def.name, namespace: NODE_LEASE_NS, ownerReferences: owner },
          spec: { holderIdentity: def.name, leaseDurationSeconds: LEASE_DURATION_S, renewTime: this.ctx.clock.now },
        },
        this.actor,
      );
    }
    this.scheduleHeartbeat();
  }

  get isPowered(): boolean {
    return this.powered;
  }

  /** 배경 타이머: 시계를 스스로 움직이지 않는다 (끝없는 주기 동작) */
  private scheduleHeartbeat(): void {
    this.heartbeat?.cancel();
    this.heartbeat = this.ctx.clock.background(HEARTBEAT_MS, this.actor, () => {
      if (this.stopped || !this.powered) return;
      this.ctx.api.patch("Lease", this.def.name, NODE_LEASE_NS, this.actor, (l) => {
        l.spec.renewTime = this.ctx.clock.now;
      });
      this.scheduleHeartbeat();
    });
  }

  /** 노드 전원을 끈다 (또는 kubelet 이 죽음): heartbeat 가 끊기고, 돌던 컨테이너는 사라지지만 API 는 아직 모른다 */
  powerOff(): void {
    if (!this.powered || this.stopped) return;
    this.powered = false;
    this.epoch++;
    this.heartbeat?.cancel();
    for (const rt of this.pods.values()) {
      rt.timer?.cancel();
      rt.probe?.cancel();
    }
    const n = this.pods.size;
    this.pods.clear();
    this.pulls.clear();
    this.ctx.trace.add(
      this.actor,
      "node.power",
      `노드 ${this.def.name} 꺼짐 → Lease 갱신이 멈춤. 컨테이너 ${n}개도 멈췄지만 API 의 Pod 는 아직 Running 으로 남아 있음 (아무도 모름)`,
      { kind: "Node", name: this.def.name },
    );
  }

  /** 다시 켠다: Node 를 Ready 로 보고하고 Lease 를 갱신한 뒤, 이 노드에 바인딩된 Pod 를 다시 읽어 맞춘다 */
  powerOn(): void {
    if (this.powered || this.stopped) return;
    this.powered = true;
    this.epoch++;
    const now = this.ctx.clock.now;
    this.ctx.api.patch("Node", this.def.name, undefined, this.actor, (n) => {
      setCondition(n, "Ready", "True", now, "KubeletReady", "kubelet is posting ready status");
    });
    const reported = this.ctx.api.get("Node", this.def.name)?.status.capacity;
    if (reported && (reported.cpu !== this.def.cpu || reported.memory !== this.def.memory)) this.reportCapacity();
    this.ctx.api.patch("Lease", this.def.name, NODE_LEASE_NS, this.actor, (l) => {
      l.spec.renewTime = now;
    });
    this.scheduleHeartbeat();
    const mine = this.ctx.api.list("Pod").filter((p) => p.spec.nodeName === this.def.name);
    const gone = mine.filter((p) => p.metadata.deletionTimestamp !== undefined);
    const rerun = mine.filter((p) => p.metadata.deletionTimestamp === undefined);
    this.ctx.trace.add(
      this.actor,
      "node.power",
      `노드 ${this.def.name} 다시 켜짐 → Ready 보고·Lease 갱신, 이 노드의 Pod 다시 읽기: 지워지던 ${gone.length}개 정리, ${rerun.length}개 컨테이너 다시 시작`,
      { kind: "Node", name: this.def.name },
    );
    for (const p of gone) this.ctx.api.finalizePod(p.metadata.name, p.metadata.namespace, p.metadata.uid, this.actor);
    for (const p of rerun) {
      const cs = p.status.containerStatuses[0];
      // 한 번이라도 시작했던 컨테이너만 재시작으로 센다 (pull 중에 꺼졌으면 그대로)
      const everStarted = !!cs && (cs.restartCount > 0 || "running" in cs.state || "terminated" in cs.state || !!cs.lastState);
      this.admit(p, (cs?.restartCount ?? 0) + (everStarted ? 1 : 0));
    }
  }

  /** 노드 자원을 바꾼다 (실제로는 kubelet 을 새 설정으로 다시 띄우는 것) → Node status 갱신 → 스케줄러가 기다리던 Pod 를 다시 본다 */
  resize(cpu: number, memory: number): void {
    if (cpu === this.def.cpu && memory === this.def.memory) return;
    this.def.cpu = cpu;
    this.def.memory = memory;
    if (!this.powered) {
      this.ctx.trace.add(this.actor, "node.register", `노드 ${this.def.name} 자원 변경 — kubelet 이 꺼져 있어 API 에 보고하지 못함 (켜면 보고)`, { kind: "Node", name: this.def.name });
      return;
    }
    this.reportCapacity();
  }

  private reportCapacity(): void {
    const { cpu, memory } = this.def;
    this.ctx.api.patch("Node", this.def.name, undefined, this.actor, (n) => {
      n.status.capacity = { ...n.status.capacity, cpu, memory };
      n.status.allocatable = { ...n.status.allocatable, cpu, memory };
    });
    this.ctx.trace.add(this.actor, "node.register", `노드 ${this.def.name} 자원 변경 → cpu ${fmtCpu(cpu)} · memory ${fmtMem(memory)} 로 다시 보고 (축소판: 이미 올라간 Pod 는 넘쳐도 그대로)`, { kind: "Node", name: this.def.name });
  }

  /** 노드를 클러스터에서 뺄 때: 모든 타이머를 멈추고 더 이상 watch 하지 않는다 */
  stop(): void {
    this.stopped = true;
    this.heartbeat?.cancel();
    this.unwatch();
    for (const rt of this.pods.values()) {
      rt.timer?.cancel();
      rt.probe?.cancel();
    }
    this.pods.clear();
  }

  // ---------- watch ----------

  private onPod(ev: WatchEvent<"Pod">): void {
    const p = ev.object;
    if (this.stopped || !this.powered || p.spec.nodeName !== this.def.name) return;
    const rt = this.pods.get(p.metadata.uid);
    if (ev.type === "DELETED") {
      if (rt) {
        rt.timer?.cancel();
        rt.probe?.cancel();
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

  private admit(p: Pod, restarts = 0): void {
    const rt: PodRt = {
      uid: p.metadata.uid,
      name: p.metadata.name,
      ns: p.metadata.namespace ?? "default",
      ip: this.allocIp(),
      stage: "sandbox",
      restarts,
      crashBackoff: 0,
      pullBackoff: 0,
      probeFailures: 0,
      probeReady: false,
      sick: false,
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
        restartCount: restarts,
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
    const epoch = this.epoch;
    this.ctx.clock.after(spec.pullMs, this.actor, () => {
      if (this.stopped || epoch !== this.epoch) return;
      const cbs = this.pulls.get(image) ?? [];
      this.pulls.delete(image);
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
    const probe = c.readinessProbe;
    this.ctx.trace.add(
      this.actor,
      "kubelet.start",
      `${rt.name} 컨테이너 ${c.name} 시작 (${c.image}${rt.restarts ? `, ${rt.restarts}번째 재시작` : ""}) → Running · ${
        probe ? `readiness probe(GET :${probe.httpGet.port}${probe.httpGet.path}, ${probe.periodSeconds ?? 10}초마다)가 통과해야 Ready` : "readiness probe 없음 → 바로 Ready"
      }`,
      refOf(p),
    );
    rt.probeReady = !probe;
    rt.probeFailures = 0;
    this.patchPod(rt, (o) => {
      o.status.phase = "Running";
      const cs = o.status.containerStatuses[0];
      if (cs) {
        cs.state = { running: { startedAt: now } };
        cs.ready = !probe;
        cs.started = true;
        cs.restartCount = rt.restarts;
      }
      if (!probe) {
        setCondition(o, "ContainersReady", "True", now);
        setCondition(o, "Ready", "True", now);
      }
    });
    if (probe) this.scheduleProbe(rt, (probe.initialDelaySeconds ?? 0) * 1000 || (probe.periodSeconds ?? 10) * 1000);
    if (spec?.crashAfterMs !== undefined) rt.timer = this.ctx.clock.after(spec.crashAfterMs, this.actor, () => this.crash(rt, spec.exitCode ?? 1));
  }

  // ---------- readiness probe ----------

  /** 배경 타이머: 컨테이너가 도는 동안 끝없이 반복하는 주기 동작 */
  private scheduleProbe(rt: PodRt, delay: number): void {
    rt.probe?.cancel();
    const epoch = this.epoch;
    rt.probe = this.ctx.clock.background(delay, this.actor, () => {
      if (epoch !== this.epoch || rt.stage !== "running" || !this.pods.has(rt.uid)) return;
      this.runProbe(rt);
    });
  }

  private runProbe(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    const c = p.spec.containers[0]!;
    const probe = c.readinessProbe;
    if (!probe) return;
    const spec = imageSpec(c.image);
    const now = this.ctx.clock.now;
    const url = `http://${rt.ip}:${probe.httpGet.port}${probe.httpGet.path}`;
    let fail: string | undefined;
    if (spec?.port !== probe.httpGet.port) fail = `Get "${url}": dial tcp ${rt.ip}:${probe.httpGet.port}: connect: connection refused`;
    else if (rt.sick || now - (rt.startedAt ?? now) < (spec.warmupMs ?? 0)) fail = "HTTP probe failed with statuscode: 503";
    const threshold = probe.failureThreshold ?? 3;
    if (fail) {
      rt.probeFailures++;
      this.event(p, "Warning", "Unhealthy", `Readiness probe failed: ${fail}`);
      if (rt.probeReady && rt.probeFailures >= threshold) {
        rt.probeReady = false;
        this.ctx.trace.add(this.actor, "kubelet.probe", `${rt.name} readiness probe ${threshold}번 연속 실패 (${fail}) → Ready=False → EndpointSlice 에서 빠져 트래픽을 받지 않음 (컨테이너는 계속 Running)`, refOf(p));
        this.setReady(rt, false, now);
      } else if (!rt.probeReady && rt.probeFailures === 1) {
        this.ctx.trace.add(this.actor, "kubelet.probe", `${rt.name} readiness probe 실패 (${fail}) → 아직 Ready 아님`, refOf(p));
      }
    } else {
      rt.probeFailures = 0;
      if (!rt.probeReady) {
        rt.probeReady = true;
        this.ctx.trace.add(this.actor, "kubelet.probe", `${rt.name} readiness probe 통과 (GET ${probe.httpGet.path} → 200) → Ready=True → EndpointSlice 에 들어가 트래픽을 받기 시작`, refOf(p));
        this.setReady(rt, true, now);
      }
    }
    this.scheduleProbe(rt, (probe.periodSeconds ?? 10) * 1000);
  }

  private setReady(rt: PodRt, ready: boolean, now: number): void {
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs) cs.ready = ready;
      const why = ready ? undefined : `containers with unready status: [${names(o)}]`;
      setCondition(o, "ContainersReady", ready ? "True" : "False", now, ready ? undefined : "ContainersNotReady", why);
      setCondition(o, "Ready", ready ? "True" : "False", now, ready ? undefined : "ContainersNotReady", why);
    });
  }

  /** 앱 고장 흉내 (DB 연결이 끊긴 것처럼): readiness 와 요청이 503 */
  setSick(podUid: string, sick: boolean): boolean {
    const rt = this.pods.get(podUid);
    if (!rt) return false;
    rt.sick = sick;
    return true;
  }

  /** 요청 흉내가 묻는 것: 이 Pod 의 컨테이너가 지금 돌고 있는지, 고장인지 */
  appState(podUid: string): { running: boolean; sick: boolean; warm: boolean } | undefined {
    if (!this.powered) return undefined;
    const rt = this.pods.get(podUid);
    if (!rt) return undefined;
    const running = rt.stage === "running" || rt.stage === "terminating";
    const p = this.ctx.api.peekList("Pod").find((x) => x.metadata.uid === podUid);
    const warmup = p ? (imageSpec(p.spec.containers[0]!.image)?.warmupMs ?? 0) : 0;
    return { running, sick: rt.sick, warm: this.ctx.clock.now - (rt.startedAt ?? 0) >= warmup };
  }

  private crash(rt: PodRt, exitCode: number): void {
    const p = this.livePod(rt);
    if (!p) return;
    rt.probe?.cancel();
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
    rt.probe?.cancel();
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
