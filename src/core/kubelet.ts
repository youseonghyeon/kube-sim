// kubelet: 노드마다 하나. 자기 노드에 바인딩된 Pod 를 watch 해서 샌드박스(IP) → 이미지 pull → 컨테이너 시작 → 크래시면 백오프 재시작 → 삭제면 SIGTERM·정리.
// 상태는 API 의 Pod status 로만 알린다 (다른 컴포넌트와 직접 이야기하지 않음).
// 축소판: 컨테이너는 Pod 마다 첫 번째 하나만 돌린다. probe 는 2단계, heartbeat·NotReady 는 1단계 후반.
// 자원(5a): 컨테이너 메모리 사용은 이미지 모양(workloads.ts memoryAt)대로 시간에 따라 늘고, limits.memory 를 넘으면 cgroup OOM, 노드 메모리를 넘으면
// 노드 OOM killer 가 oom_score 로 희생자를 고른다. CPU 는 원하는 만큼(limit 까지) 받고, 노드가 모자라면 requests 비율로 나눈다 — 덜 받은 만큼 응답이 느려진다.
// 축소판: kubelet 의 node-pressure eviction(memory.available)·시스템 예약·페이지 캐시는 없다. 노드 메모리는 컨테이너 사용 합만 센다.
import { refOf, type WatchEvent } from "./api/server";
import { limitOf, NODE_LEASE_NS, qosClass, type ConfigMap, type Container, type ContainerState, type Node, type Pod, type QosClass, type Secret } from "./api/types";
import { b64decode } from "./base64";
import { pvNode } from "./storage";
import type { TimerHandle } from "./clock";
import type { ComponentContext } from "./controllers/base";
import { setCondition } from "./scheduler";
import { fmtCpu, fmtMem } from "./units";
import { DEFAULT_CPU_M, DEFAULT_WORK_MS, imageSpec, memoryAt, type ImageSpec } from "./workloads";

/** 샌드박스(pause 컨테이너)·CNI 로 IP 받는 시간 */
export const SANDBOX_MS = 500;
/** 컨테이너 만들고 시작하는 시간 */
export const CREATE_MS = 300;
/** 레지스트리에 없는 이미지를 찾다 실패하기까지 */
export const PULL_FAIL_MS = 800;
/** 크래시·pull 실패 백오프: 10초부터 두 배, 최대 5분 (실제값) */
export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_MAX_MS = 300_000;
/** preStop 뒤 SIGTERM 에 주는 최소 시간 (kubelet minimumGracePeriodInSeconds = 2) */
export const MIN_SIGTERM_MS = 2000;
/** Lease 갱신 주기 (실제값: leaseDuration 40초의 1/4) */
export const HEARTBEAT_MS = 10_000;
export const LEASE_DURATION_S = 40;
/** 이만큼 잘 돌다 죽으면 백오프를 처음부터 */
export const BACKOFF_RESET_MS = 600_000;
/** ConfigMap·Secret 이 바뀐 뒤 마운트된 파일이 바뀌기까지 (실제: kubelet 동기화 주기 1분 + 캐시 — 1~2분 안팎. 축소판으로 1분 고정) */
export const VOLUME_SYNC_MS = 60_000;
/** env 를 못 만들 때(CreateContainerConfigError) 다시 시도하는 간격 */
export const CONFIG_RETRY_MS = 10_000;
/** volume 을 못 붙일 때(FailedMount) 다시 시도: 2초부터 두 배, 최대 2분 (실제 kubelet 의 durationBeforeRetry 와 비슷) */
export const MOUNT_RETRY_BASE_MS = 2_000;
export const MOUNT_RETRY_MAX_MS = 120_000;
/** env 이름 규칙 (v1.31 기본 — RelaxedEnvironmentVariableValidation 은 아직 꺼짐). envFrom 의 키가 어기면 건너뛴다 */
const ENV_NAME_RE = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
/** OOM 시각을 찾을 때 내다보는 범위 — 이보다 먼 OOM 은 그때 가서 다시 찾는다 */
const OOM_HORIZON_MS = 6 * 3600_000;

/** 컨테이너 하나의 CPU 형편 */
export interface CpuState {
  /** 앱이 원하는 CPU (millicore) */
  want: number;
  /** 실제로 받는 CPU */
  got: number;
  limit?: number;
  /** 덜 받는 이유: limit = cpu limit 에 막힘(throttling), node = 노드 CPU 가 모자라 requests 비율로 나눔 */
  reason?: "limit" | "node";
}

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

type Stage = "sandbox" | "mounting" | "pulling" | "pull-backoff" | "creating" | "config-error" | "running" | "crash-backoff" | "terminating";

/** 컨테이너가 본 설정: env 는 시작할 때 만든 것, 파일은 kubelet 이 마지막으로 맞춰 둔 것 */
export interface ContainerConfig {
  env: [string, string][];
  /** 경로 → 내용 */
  files: Map<string, string>;
  /** 마운트한 디렉터리 (subPath 가 아닌 것) */
  dirs: Set<string>;
}

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
  /** liveness probe 주기 (배경 타이머) */
  live?: TimerHandle;
  liveFailures: number;
  /** SIGTERM 을 받아 새 연결을 받지 않음 (nginx 의 SIGTERM 은 빠른 종료) */
  sigterm: boolean;
  probeFailures: number;
  probeReady: boolean;
  /** 사용자가 "앱 고장" 으로 만든 상태 — /ready 와 요청에 503 */
  sick: boolean;
  /** 컨테이너 프로세스가 있는지 (메모리를 쓰고 CPU 를 원함). 시작 ~ 종료·크래시 */
  alive: boolean;
  /** 이 Pod 의 컨테이너 (Pod spec 은 바뀌지 않으므로 받을 때 한 번 읽어 둔다) */
  ct: Container;
  image?: ImageSpec;
  qos: QosClass;
  /** 지워지는 중에 죽은 컨테이너의 종료 (정리할 때 그대로 남긴다) */
  lastExit?: { exitCode: number; reason: string };
  /** Pod 의 volumes (ConfigMap·Secret) — 받을 때 한 번 읽어 둔다 */
  volumes: NonNullable<Pod["spec"]["volumes"]>;
  /** 시작할 때 만든 env */
  env: [string, string][];
  /** 마운트한 파일들 (경로 → 내용) */
  files: Map<string, string>;
  mountBackoff: number;
  /** volume 이 붙었는지 (그 뒤로는 컨테이너 상태와 상관없이 동기화한다) */
  mounted: boolean;
  /** volume 이름 → kubelet 이 마지막으로 맞춘 ConfigMap·Secret 내용 (Pod 단위) */
  volData: Map<string, Record<string, string>>;
  /** 바뀐 ConfigMap·Secret 을 파일에 반영할 예약 */
  volumeSync?: TimerHandle;
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
  /** 다음 OOM(cgroup 또는 노드) 시각의 감시 — 배경 타이머 */
  private oomWatch?: TimerHandle;
  /** cpuAlloc 결과 — 도는 컨테이너가 바뀌거나 노드 CPU 가 바뀔 때만 다시 계산 (화면이 Pod 마다 물어도 한 번) */
  private cpuCache?: Map<string, number>;

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
    const offs = [
      ctx.api.watch("Pod", (ev) => this.onPod(ev)),
      ctx.api.watch("ConfigMap", (ev) => this.onConfig("ConfigMap", ev.object.metadata.name, ev.type)),
      ctx.api.watch("Secret", (ev) => this.onConfig("Secret", ev.object.metadata.name, ev.type)),
    ];
    this.unwatch = () => offs.forEach((f) => f());
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
    this.oomWatch?.cancel();
    for (const rt of this.pods.values()) {
      rt.timer?.cancel();
      this.stopProbes(rt);
    }
    const n = this.pods.size;
    this.pods.clear();
    this.cpuCache = undefined;
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
    this.cpuCache = undefined;
    if (!this.powered) {
      this.ctx.trace.add(this.actor, "node.register", `노드 ${this.def.name} 자원 변경 — kubelet 이 꺼져 있어 API 에 보고하지 못함 (켜면 보고)`, { kind: "Node", name: this.def.name });
      return;
    }
    this.reportCapacity();
    this.rearmOom();
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
    this.oomWatch?.cancel();
    this.unwatch();
    for (const rt of this.pods.values()) {
      rt.timer?.cancel();
      this.stopProbes(rt);
    }
    this.pods.clear();
    this.cpuCache = undefined;
  }

  // ---------- watch ----------

  private onPod(ev: WatchEvent<"Pod">): void {
    const p = ev.object;
    if (this.stopped || !this.powered || p.spec.nodeName !== this.def.name) return;
    const rt = this.pods.get(p.metadata.uid);
    if (ev.type === "DELETED") {
      if (rt) {
        rt.timer?.cancel();
        this.stopProbes(rt);
        this.pods.delete(p.metadata.uid);
        this.cpuCache = undefined;
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
    const ct = p.spec.containers[0]!;
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
      liveFailures: 0,
      sigterm: false,
      alive: false,
      ct,
      image: imageSpec(ct.image),
      qos: qosClass(p.spec),
      volumes: structuredClone(p.spec.volumes ?? []),
      env: [],
      files: new Map(),
      mountBackoff: 0,
      mounted: false,
      volData: new Map(),
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
      this.mount(rt);
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
    // env 는 컨테이너를 만들 때 지금의 ConfigMap·Secret 에서 한 번 만든다 (이후 바뀌어도 이 컨테이너는 모름)
    const env = this.resolveEnv(c);
    if ("error" in env) {
      rt.stage = "config-error";
      this.event(p, "Warning", "Failed", `Error: ${env.error}`);
      this.ctx.trace.add(this.actor, "kubelet.config", `${rt.name} 컨테이너 ${c.name} 의 env 를 만들 수 없음 (${env.error}) → CreateContainerConfigError, ${CONFIG_RETRY_MS / 1000}초 뒤 다시 (만들어 주면 뜬다)`, refOf(p));
      this.setWaiting(rt, "CreateContainerConfigError", env.error);
      rt.timer = this.ctx.clock.after(CONFIG_RETRY_MS, this.actor, () => this.start(rt));
      return;
    }
    rt.env = env.env;
    for (const msg of env.skipped) this.event(p, "Warning", "InvalidEnvironmentVariableNames", msg);
    rt.stage = "running";
    rt.startedAt = now;
    rt.alive = true;
    this.cpuCache = undefined;
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
    const live = c.livenessProbe;
    rt.liveFailures = 0;
    if (live) this.scheduleLiveness(rt, (live.initialDelaySeconds ?? 0) * 1000 || (live.periodSeconds ?? 10) * 1000);
    if (spec?.crashAfterMs !== undefined) rt.timer = this.ctx.clock.after(spec.crashAfterMs, this.actor, () => this.crash(rt, spec.exitCode ?? 1));
    this.rearmOom();
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
    else if (this.latencyMs(rt) > (probe.timeoutSeconds ?? 1) * 1000) fail = probeTimeout(url);
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

  /** liveness: 앱이 살아 있는가 (준비 시간과는 상관없이 /healthz 는 답한다). 연속 실패면 컨테이너를 죽이고 다시 띄운다 */
  private scheduleLiveness(rt: PodRt, delay: number): void {
    rt.live?.cancel();
    const epoch = this.epoch;
    rt.live = this.ctx.clock.background(delay, this.actor, () => {
      if (epoch !== this.epoch || rt.stage !== "running" || !this.pods.has(rt.uid)) return;
      this.runLiveness(rt);
    });
  }

  private runLiveness(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    const c = p.spec.containers[0]!;
    const probe = c.livenessProbe;
    if (!probe) return;
    const spec = imageSpec(c.image);
    const url = `http://${rt.ip}:${probe.httpGet.port}${probe.httpGet.path}`;
    let fail: string | undefined;
    if (spec?.port !== probe.httpGet.port) fail = `Get "${url}": dial tcp ${rt.ip}:${probe.httpGet.port}: connect: connection refused`;
    else if (rt.sick) fail = "HTTP probe failed with statuscode: 503";
    else if (this.latencyMs(rt) > (probe.timeoutSeconds ?? 1) * 1000) fail = probeTimeout(url);
    const threshold = probe.failureThreshold ?? 3;
    if (!fail) {
      rt.liveFailures = 0;
      this.scheduleLiveness(rt, (probe.periodSeconds ?? 10) * 1000);
      return;
    }
    rt.liveFailures++;
    this.event(p, "Warning", "Unhealthy", `Liveness probe failed: ${fail}`);
    if (rt.liveFailures < threshold) {
      this.scheduleLiveness(rt, (probe.periodSeconds ?? 10) * 1000);
      return;
    }
    this.event(p, "Normal", "Killing", `Container ${c.name} failed liveness probe, will be restarted`);
    const slow = fail.includes("context deadline exceeded");
    const cpu = slow ? this.cpuState(rt.uid) : undefined;
    this.ctx.trace.add(
      this.actor,
      "kubelet.probe",
      slow
        ? `${rt.name} liveness probe ${threshold}번 연속 시간 초과 (응답 ${Math.round(this.latencyMs(rt))}ms > timeoutSeconds ${probe.timeoutSeconds ?? 1}초 — CPU 를 ${cpu?.got ?? 0}m 만 받음${cpu?.reason === "limit" ? ", cpu limit 에 막힘" : ""}) → 컨테이너를 죽이고 다시 띄움 (CPU 가 모자란 것이라 재시작해도 낫지 않음)`
        : `${rt.name} liveness probe ${threshold}번 연속 실패 (${fail}) → 컨테이너를 죽이고 다시 띄움 (재시작하면 풀리는 고장이면 이것으로 낫는다)`,
      refOf(p),
    );
    this.crash(rt, 137);
  }

  private stopProbes(rt: PodRt): void {
    rt.probe?.cancel();
    rt.live?.cancel();
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
  appState(podUid: string): { running: boolean; sick: boolean; warm: boolean; latencyMs: number; workMs: number; cpu: CpuState } | undefined {
    if (!this.powered) return undefined;
    const rt = this.pods.get(podUid);
    if (!rt) return undefined;
    // 지워지는 중이라도 SIGTERM 전(preStop 중)에는 계속 요청을 받는다
    const running = rt.stage === "running" || (rt.stage === "terminating" && !rt.sigterm);
    const p = this.ctx.api.peekList("Pod").find((x) => x.metadata.uid === podUid);
    const warmup = p ? (imageSpec(p.spec.containers[0]!.image)?.warmupMs ?? 0) : 0;
    return { running, sick: rt.sick, warm: this.ctx.clock.now - (rt.startedAt ?? 0) >= warmup, latencyMs: this.latencyMs(rt), workMs: rt.image?.workMs ?? DEFAULT_WORK_MS, cpu: this.cpuState(podUid) };
  }

  private crash(rt: PodRt, exitCode: number, reason = "Error"): void {
    const p = this.livePod(rt);
    if (!p) {
      // API 에서는 이미 지워지는 중인데 watch 가 아직 오지 않은 사이에 프로세스가 죽음: 재시작하지 않고 종료 상태만 남긴다 (곧 terminate 가 정리)
      if (rt.stage === "running" && this.pods.has(rt.uid)) {
        rt.timer?.cancel();
        this.stopProbes(rt);
        rt.alive = false;
        this.cpuCache = undefined;
        rt.stage = "crash-backoff";
        rt.lastExit = { exitCode, reason };
        const now = this.ctx.clock.now;
        this.patchPod(rt, (o) => {
          const cs = o.status.containerStatuses[0];
          if (cs) {
            cs.state = { terminated: { reason, exitCode, startedAt: rt.startedAt, finishedAt: now } };
            cs.ready = false;
            cs.started = false;
          }
        });
        this.rearmOom();
      }
      return;
    }
    this.stopProbes(rt);
    rt.alive = false;
    this.cpuCache = undefined;
    const c = p.spec.containers[0]!;
    const now = this.ctx.clock.now;
    const ran = now - (rt.startedAt ?? now);
    if (ran >= BACKOFF_RESET_MS) rt.crashBackoff = 0;
    const delay = rt.crashBackoff;
    rt.crashBackoff = delay === 0 ? BACKOFF_BASE_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
    rt.stage = "crash-backoff";
    const terminated: ContainerState = { terminated: { reason, exitCode, startedAt: rt.startedAt, finishedAt: now } };
    this.ctx.trace.add(
      this.actor,
      "kubelet.exit",
      `${rt.name} 컨테이너 ${c.name} 종료 (${reason === "Error" ? "" : `${reason} · `}exit ${exitCode}, ${(ran / 1000).toFixed(1)}초 실행) → restartPolicy Always → ${delay === 0 ? "바로 재시작 (첫 재시작은 백오프 없음)" : `${delay / 1000}초 백오프 뒤 재시작`}`,
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
      this.rearmOom();
      return;
    }
    this.rearmOom();
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
    rt.sick = false; // 새 프로세스 — 멈춰 있던 앱은 재시작으로 풀린다
    // 새 컨테이너를 만드는 Pod 동기화: volume 내용을 지금의 ConfigMap·Secret 으로 다시 맞추고, subPath 도 다시 bind. env 는 start 에서 새로 만든다
    this.refreshVolumes(rt);
    rt.files = this.deriveFiles(rt, true);
    this.event(p, "Normal", "Pulled", `Container image "${p.spec.containers[0]!.image}" already present on machine`);
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs && "terminated" in cs.state) cs.lastState = cs.state;
    });
    this.start(rt);
  }

  private terminate(rt: PodRt, p: Pod): void {
    rt.timer?.cancel();
    this.stopProbes(rt);
    rt.volumeSync?.cancel();
    const wasRunning = rt.stage === "running" && rt.alive;
    rt.stage = "terminating";
    const c = p.spec.containers[0]!;
    const grace = (p.metadata.deletionGracePeriodSeconds ?? p.spec.terminationGracePeriodSeconds) * 1000;
    if (!wasRunning) {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 삭제 요청 — 돌고 있는 컨테이너 없음 → 바로 정리`, refOf(p));
      const last = rt.lastExit;
      rt.timer = this.ctx.clock.after(100, this.actor, () => (last ? this.finish(rt, last.exitCode, last.reason) : this.finish(rt, 0)));
      return;
    }
    this.event(p, "Normal", "Killing", `Stopping container ${c.name}`);
    const preStopMs = Math.max(0, (c.lifecycle?.preStop?.sleep.seconds ?? 0) * 1000);
    if (preStopMs > 0) {
      if (preStopMs >= grace) {
        // preStop 은 유예 시간에서 끊기고, SIGTERM 에는 최소 2초를 준다 (kubelet minimumGracePeriodInSeconds)
        this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 삭제 요청 → preStop sleep ${preStopMs / 1000}초가 유예 ${grace / 1000}초를 넘음 → ${grace / 1000}초에 끊고 SIGTERM (최소 2초 더 줌)`, refOf(p));
        rt.timer = this.ctx.clock.after(grace, this.actor, () => this.sigterm(rt, c.name, c.image, MIN_SIGTERM_MS));
        return;
      }
      this.ctx.trace.add(
        this.actor,
        "kubelet.kill",
        `${rt.name} 삭제 요청 → preStop sleep ${preStopMs / 1000}초 — 그동안 앱은 계속 요청을 받고, 그사이 엔드포인트가 빠져 모든 노드의 규칙이 바뀐다`,
        refOf(p),
      );
      rt.timer = this.ctx.clock.after(preStopMs, this.actor, () => this.sigterm(rt, c.name, c.image, Math.max(MIN_SIGTERM_MS, grace - preStopMs)));
      return;
    }
    this.sigterm(rt, c.name, c.image, grace);
  }

  /** SIGTERM: 앱이 새 연결을 받지 않고 termMs 뒤 끝난다. 남은 유예 안에 안 끝나면 SIGKILL */
  private sigterm(rt: PodRt, container: string, image: string, remaining: number): void {
    rt.sigterm = true;
    const termMs = imageSpec(image)?.termMs ?? 300;
    const ref = { kind: "Pod", namespace: rt.ns, name: rt.name };
    if (termMs <= remaining) {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} 컨테이너 ${container} 에 SIGTERM → 앱이 새 연결을 받지 않고 ${termMs / 1000}초 만에 종료 (남은 유예 ${remaining / 1000}초 안)`, ref);
      rt.timer = this.ctx.clock.after(termMs, this.actor, () => this.finish(rt, 0));
    } else {
      this.ctx.trace.add(this.actor, "kubelet.kill", `${rt.name} SIGTERM → 남은 유예 ${remaining / 1000}초 안에 안 끝남 → SIGKILL`, ref);
      rt.timer = this.ctx.clock.after(remaining, this.actor, () => this.finish(rt, 137));
    }
  }

  private finish(rt: PodRt, exitCode: number, reason = exitCode === 0 ? "Completed" : "Error"): void {
    const now = this.ctx.clock.now;
    rt.alive = false;
    this.cpuCache = undefined;
    this.patchPod(rt, (o) => {
      const cs = o.status.containerStatuses[0];
      if (cs) {
        cs.state = { terminated: { reason, exitCode, startedAt: rt.startedAt, finishedAt: now } };
        cs.ready = false;
        cs.started = false;
      }
      setCondition(o, "ContainersReady", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
      setCondition(o, "Ready", "False", now, "ContainersNotReady", `containers with unready status: [${names(o)}]`);
    });
    this.ctx.trace.add(this.actor, "kubelet.removed", `${rt.name} 컨테이너 정리 끝 → API 에서 Pod 최종 삭제, IP ${rt.ip} 반납`, { kind: "Pod", namespace: rt.ns, name: rt.name });
    this.pods.delete(rt.uid);
    this.ctx.api.finalizePod(rt.name, rt.ns, rt.uid, this.actor);
    this.rearmOom();
  }

  // ---------- 설정: ConfigMap·Secret (5b) ----------

  private readConfig(kind: "ConfigMap" | "Secret", name: string, ns: string): Record<string, string> | undefined {
    const o = this.ctx.api.peekList(kind, ns).find((x) => x.metadata.name === name) as ConfigMap | Secret | undefined;
    if (!o) return undefined;
    if (o.kind === "ConfigMap") return o.data;
    return Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, b64decode(v) ?? ""]));
  }

  /** env·envFrom → [이름, 값]. 없는 ConfigMap·Secret·키면 kubelet 의 실제 문구로 오류. env 이름이 될 수 없는 envFrom 키는 건너뛰고 알린다 */
  private resolveEnv(c: Container, ns = "default"): { env: [string, string][]; skipped: string[] } | { error: string } {
    const out = new Map<string, string>();
    const skipped: string[] = [];
    for (const f of c.envFrom ?? []) {
      const kind = f.configMapRef ? "ConfigMap" : "Secret";
      const name = f.configMapRef?.name ?? f.secretRef?.name ?? "";
      const data = this.readConfig(kind, name, ns);
      if (!data) return { error: `${kind.toLowerCase()} "${name}" not found` };
      const bad: string[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (ENV_NAME_RE.test(k)) out.set(k, v);
        else bad.push(k);
      }
      if (bad.length) skipped.push(`Keys [${bad.join(", ")}] from the EnvFrom ${kind === "ConfigMap" ? "configMap" : "secret"} ${ns}/${name} were skipped since they are considered invalid environment variable names.`);
    }
    for (const e of c.env ?? []) {
      const ref = e.valueFrom?.configMapKeyRef ?? e.valueFrom?.secretKeyRef;
      if (!ref) {
        out.set(e.name, e.value ?? "");
        continue;
      }
      const kind = e.valueFrom?.configMapKeyRef ? "ConfigMap" : "Secret";
      const data = this.readConfig(kind, ref.name, ns);
      if (!data) return { error: `${kind.toLowerCase()} "${ref.name}" not found` };
      if (!(ref.key in data)) return { error: `couldn't find key ${ref.key} in ${kind} ${ns}/${ref.name}` };
      out.set(e.name, data[ref.key]!);
    }
    return { env: [...out], skipped };
  }

  /** 마운트에 쓰이는 ConfigMap·Secret volume 들 */
  private configVolumes(rt: PodRt): { v: NonNullable<Pod["spec"]["volumes"]>[number]; kind: "ConfigMap" | "Secret"; name: string }[] {
    const used = new Set((rt.ct.volumeMounts ?? []).map((m) => m.name));
    return rt.volumes.filter((v) => used.has(v.name) && (v.configMap || v.secret)).map((v) => ({ v, kind: v.configMap ? "ConfigMap" : "Secret", name: v.configMap?.name ?? v.secret?.secretName ?? "" }));
  }

  /**
   * volume 내용(Pod 단위, kubelet 이 맞춰 둔 것) → 컨테이너가 보는 파일. 디렉터리 마운트는 늘 volume 내용대로,
   * subPath 는 컨테이너를 만들 때(withSubPath)만 그때의 volume 내용으로 — 돌고 있는 동안은 갱신되지 않는다.
   */
  private deriveFiles(rt: PodRt, withSubPath: boolean): Map<string, string> {
    const files = new Map<string, string>();
    for (const m of rt.ct.volumeMounts ?? []) {
      const data = rt.volData.get(m.name);
      if (!data) continue;
      if (m.subPath) {
        const keep = withSubPath ? data[m.subPath] : rt.files.get(m.mountPath);
        if (keep !== undefined) files.set(m.mountPath, keep);
        continue;
      }
      for (const [k, val] of Object.entries(data)) files.set(`${m.mountPath}/${k}`, val);
    }
    return files;
  }

  /** 이 Pod 의 ConfigMap·Secret volume 내용을 지금 것으로 (그 사이 다른 것도 바뀌었을 수 있으니 모두. 지워졌으면 옛 내용 그대로) */
  private refreshVolumes(rt: PodRt): void {
    for (const { v, kind, name } of this.configVolumes(rt)) {
      const data = this.readConfig(kind, name, rt.ns);
      if (data) rt.volData.set(v.name, { ...data });
    }
  }

  /** 샌드박스 다음: ConfigMap·Secret volume 을 붙인다. 없으면 FailedMount 로 ContainerCreating 에 머물며 다시 시도 */
  private mount(rt: PodRt): void {
    const p = this.livePod(rt);
    if (!p) return;
    rt.stage = "mounting";
    const fail = (volume: string, error: string) => {
      const delay = rt.mountBackoff || MOUNT_RETRY_BASE_MS;
      rt.mountBackoff = Math.min(delay * 2, MOUNT_RETRY_MAX_MS);
      this.event(p, "Warning", "FailedMount", `MountVolume.SetUp failed for volume "${volume}" : ${error}`);
      this.ctx.trace.add(this.actor, "kubelet.config", `${rt.name} volume ${volume} 를 붙일 수 없음 (${error}) → 컨테이너를 만들지 않고 ContainerCreating 에 머묾, ${delay / 1000}초 뒤 다시`, refOf(p));
      rt.timer = this.ctx.clock.after(delay, this.actor, () => this.mount(rt));
    };
    // PVC volume: 디스크(PV)가 이 노드에 묶여 있어야 붙일 수 있다 (local-path 는 스케줄러가 맞춰 보낸다)
    for (const v of rt.volumes) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const pvc = this.ctx.api.peekList("PersistentVolumeClaim", rt.ns).find((c) => c.metadata.name === claim);
      if (!pvc) return fail(v.name, `persistentvolumeclaim "${claim}" not found`);
      if (pvc.status.phase !== "Bound") return fail(v.name, `PVC ${claim} 가 아직 PV 에 묶이지 않음 (Unable to attach or mount volumes: unmounted volumes=[${v.name}]: timed out waiting for the condition)`);
      const pv = this.ctx.api.peekList("PersistentVolume").find((x) => x.metadata.name === pvc.spec.volumeName);
      const node = pv ? pvNode(pv) : undefined;
      if (node && node !== this.def.name) return fail(v.name, `volume node affinity conflict — PV ${pv!.metadata.name} 은 ${node} 의 디스크`);
    }
    const vol = new Map<string, Record<string, string>>();
    for (const { v, kind, name } of this.configVolumes(rt)) {
      const data = this.readConfig(kind, name, rt.ns);
      if (!data) return fail(v.name, `${kind.toLowerCase()} "${name}" not found`);
      vol.set(v.name, { ...data });
    }
    for (const m of rt.ct.volumeMounts ?? []) {
      const data = vol.get(m.name);
      const v = rt.volumes.find((x) => x.name === m.name);
      if (m.subPath && data && !(m.subPath in data)) return fail(m.name, `couldn't find key ${m.subPath} in ${v?.configMap ? "ConfigMap" : "Secret"} ${rt.ns}/${v?.configMap?.name ?? v?.secret?.secretName}`);
    }
    rt.volData = vol;
    rt.files = this.deriveFiles(rt, true);
    rt.mounted = true;
    rt.mountBackoff = 0;
    this.pull(rt);
  }

  /**
   * ConfigMap·Secret 이 바뀜: 그것을 volume 으로 붙인 Pod 는 (컨테이너가 돌든 아니든) 동기화 주기 뒤 volume 내용을 바꾸고,
   * env 로 읽는 돌고 있는 컨테이너는 그대로 (시작할 때 읽음).
   */
  private onConfig(kind: "ConfigMap" | "Secret", name: string, type: string): void {
    if (this.stopped || !this.powered) return;
    const refers = (v: NonNullable<Pod["spec"]["volumes"]>[number]) => (kind === "ConfigMap" ? v.configMap?.name : v.secret?.secretName) === name;
    const envUses = (rt: PodRt) =>
      (rt.ct.envFrom ?? []).some((f) => (kind === "ConfigMap" ? f.configMapRef?.name : f.secretRef?.name) === name) ||
      (rt.ct.env ?? []).some((e) => (kind === "ConfigMap" ? e.valueFrom?.configMapKeyRef?.name : e.valueFrom?.secretKeyRef?.name) === name);
    const envOnly: string[] = [];
    for (const rt of this.pods.values()) {
      if (rt.alive && envUses(rt) && type !== "DELETED") envOnly.push(rt.name);
      if (!rt.mounted || type === "DELETED" || rt.volumeSync || !this.configVolumes(rt).some(({ v }) => refers(v))) continue;
      const epoch = this.epoch;
      rt.volumeSync = this.ctx.clock.after(VOLUME_SYNC_MS, this.actor, () => {
        rt.volumeSync = undefined;
        if (epoch !== this.epoch || !this.pods.has(rt.uid) || rt.stage === "terminating") return;
        this.refreshVolumes(rt);
        const before = rt.files;
        rt.files = this.deriveFiles(rt, false);
        const changed = [...rt.files].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
        const gone = [...before.keys()].filter((k) => !rt.files.has(k));
        if (!changed.length && !gone.length) return;
        const frozen = (rt.ct.volumeMounts ?? []).filter((m) => m.subPath).map((m) => m.mountPath);
        this.ctx.trace.add(
          this.actor,
          "kubelet.config",
          `${rt.name} 이 마운트한 ${kind} ${name} 이 바뀜 → (kubelet 동기화 주기) 파일 갱신: ${[...changed, ...gone.map((g) => `${g} (지움)`)].join(", ")}${rt.alive ? " — 앱이 파일을 다시 읽어야 반영" : " — 컨테이너가 뜨면 이 내용을 본다"}${frozen.length ? ` · subPath 파일 ${frozen.join(", ")} 은 바뀌지 않음 (컨테이너를 새로 만들 때만)` : ""}`,
          { kind: "Pod", namespace: rt.ns, name: rt.name },
        );
      });
    }
    if (envOnly.length)
      this.ctx.trace.add(this.actor, "kubelet.config", `${kind} ${name} 이 바뀜 — env 로 읽는 ${envOnly.join(", ")} 의 값은 그대로 (env 는 컨테이너가 시작할 때 한 번 만든다 → 재시작해야 반영)`, { kind, namespace: "default", name });
  }

  /** kubectl exec -- env · cat 이 보는 것 */
  containerConfig(podUid: string): ContainerConfig | undefined {
    if (!this.powered) return undefined;
    const rt = this.pods.get(podUid);
    if (!rt?.alive) return undefined;
    const dirs = new Set((rt.ct.volumeMounts ?? []).filter((m) => !m.subPath && rt.volumes.some((v) => v.name === m.name && (v.configMap || v.secret))).map((m) => m.mountPath.replace(/\/+$/, "")));
    return { env: [...rt.env], files: new Map(rt.files), dirs };
  }

  // ---------- 자원: 메모리·CPU ----------

  /** 지금 이 컨테이너가 쓰는 메모리 (MiB). 프로세스가 없으면 0 */
  private memOf(rt: PodRt, at = this.ctx.clock.now): number {
    return rt.alive ? memoryAt(rt.image, at - (rt.startedAt ?? at)) : 0;
  }

  private alive(): PodRt[] {
    return [...this.pods.values()].filter((r) => r.alive);
  }

  /**
   * 노드 CPU 나누기: 컨테이너마다 원하는 만큼(cpu limit 까지) 준다. 합이 노드 CPU 를 넘으면
   * requests 비율(cpu.shares, 최소 2m)로 나눈다 — 덜 원하는 쪽은 원하는 만큼만 받고 남는 몫은 다시 나눈다.
   */
  private cpuAlloc(): Map<string, number> {
    if (this.cpuCache) return this.cpuCache;
    const out = this.computeCpuAlloc();
    this.cpuCache = out;
    return out;
  }

  private computeCpuAlloc(): Map<string, number> {
    const rts = this.alive();
    const out = new Map<string, number>();
    const capOf = (r: PodRt) => Math.min(r.image?.cpuM ?? DEFAULT_CPU_M, limitOf(r.ct, "cpu") ?? Number.POSITIVE_INFINITY);
    const total = rts.reduce((n, r) => n + capOf(r), 0);
    if (total <= this.def.cpu) {
      for (const r of rts) out.set(r.uid, capOf(r));
      return out;
    }
    let left = this.def.cpu;
    let open = rts;
    while (open.length) {
      const weight = open.reduce((n, r) => n + Math.max(2, r.ct.resources.requests.cpu), 0);
      const satisfied = open.filter((r) => capOf(r) <= (left * Math.max(2, r.ct.resources.requests.cpu)) / weight);
      if (!satisfied.length) {
        for (const r of open) out.set(r.uid, (left * Math.max(2, r.ct.resources.requests.cpu)) / weight);
        break;
      }
      for (const r of satisfied) {
        out.set(r.uid, capOf(r));
        left -= capOf(r);
      }
      open = open.filter((r) => !satisfied.includes(r));
    }
    return out;
  }

  /** 이 Pod 컨테이너가 원하는 CPU 와 받는 CPU. 컨테이너가 없으면 0/0 */
  cpuState(podUid: string): CpuState {
    const rt = this.pods.get(podUid);
    if (!rt?.alive) return { want: 0, got: 0, limit: rt ? limitOf(rt.ct, "cpu") : undefined };
    const want = rt.image?.cpuM ?? DEFAULT_CPU_M;
    const limit = limitOf(rt.ct, "cpu");
    const got = Math.round(this.cpuAlloc().get(podUid) ?? want);
    const reason = got >= want ? undefined : limit !== undefined && got >= limit ? "limit" : "node";
    return { want, got, limit, reason };
  }

  /** 요청 하나의 응답 시간 (ms): 원하는 CPU 를 다 받으면 workMs, 덜 받으면 그 비율만큼 늘어난다 (CFS 쿼터를 기다림) */
  private latencyMs(rt: PodRt): number {
    const work = rt.image?.workMs ?? DEFAULT_WORK_MS;
    if (!rt.alive) return work;
    const want = rt.image?.cpuM ?? DEFAULT_CPU_M;
    // 반올림 전 몫으로 (0m 로 보여도 아주 조금은 받는다). 노드 CPU 가 0 이어도 끝이 있게 1m 를 바닥으로
    const got = Math.max(1, this.cpuAlloc().get(rt.uid) ?? want);
    return got >= want ? work : (work * want) / got;
  }

  /** metrics-server 가 읽어 가는 실사용 (kubectl top). 컨테이너가 없으면 undefined */
  usage(podUid: string): { cpu: number; memory: number } | undefined {
    if (!this.powered) return undefined;
    const rt = this.pods.get(podUid);
    if (!rt?.alive) return undefined;
    return { cpu: this.cpuState(podUid).got, memory: Math.floor(this.memOf(rt)) };
  }

  /** 다음 OOM 시각을 찾아 감시를 다시 건다: 컨테이너가 limits.memory 를 넘는 때, 또는 노드 메모리 합이 노드 메모리를 넘는 때 중 이른 것 */
  private rearmOom(): void {
    this.oomWatch?.cancel();
    this.oomWatch = undefined;
    if (this.stopped || !this.powered) return;
    const rts = this.alive();
    if (!rts.length) return;
    const now = this.ctx.clock.now;
    let when = Number.POSITIVE_INFINITY;
    for (const r of rts) {
      const lim = limitOf(r.ct, "memory");
      if (lim !== undefined) when = Math.min(when, firstAbove((t) => this.memOf(r, t), lim, now, now + OOM_HORIZON_MS));
    }
    when = Math.min(when, firstAbove((t) => rts.reduce((n, r) => n + this.memOf(r, t), 0), this.def.memory, now, now + OOM_HORIZON_MS));
    if (when === Number.POSITIVE_INFINITY) {
      // 먼 미래: 범위 끝에서 다시 찾는다
      this.oomWatch = this.ctx.clock.background(OOM_HORIZON_MS, this.actor, () => this.rearmOom());
      return;
    }
    this.oomWatch = this.ctx.clock.background(when - now, this.actor, () => this.checkOom());
  }

  private checkOom(): void {
    if (this.stopped || !this.powered) return;
    for (const r of this.alive()) {
      const lim = limitOf(r.ct, "memory");
      if (lim !== undefined && this.memOf(r) > lim) this.oomKill(r, `메모리 사용이 limits.memory ${fmtMem(lim)} 에 닿음 (더 할당할 수 없음) → 커널의 cgroup OOM killer 가 컨테이너 프로세스를 죽임 (SIGKILL)`);
    }
    const rts = this.alive();
    const total = rts.reduce((n, r) => n + this.memOf(r), 0);
    if (rts.length && total > this.def.memory) this.nodeOom(rts);
    this.rearmOom();
  }

  /**
   * 노드 메모리가 넘침 → 커널 OOM killer 가 oom_score 가 가장 큰 프로세스를 죽인다.
   * oom_score ≈ 사용량/노드 메모리 × 1000 + oom_score_adj (kubelet 이 QoS 로 정함: Guaranteed -997, BestEffort 1000, Burstable 1000 - 1000×requests/노드 메모리 를 3~999 로)
   */
  private nodeOom(rts: PodRt[]): void {
    const cap = this.def.memory;
    const scored = rts
      .map((r) => {
        const adj = r.qos === "Guaranteed" ? -997 : r.qos === "BestEffort" ? 1000 : Math.min(999, Math.max(3, 1000 - Math.floor((1000 * r.ct.resources.requests.memory) / cap)));
        return { r, score: Math.floor((this.memOf(r) * 1000) / cap) + adj };
      })
      .sort((a, b) => b.score - a.score || this.memOf(b.r) - this.memOf(a.r) || (a.r.name < b.r.name ? -1 : 1));
    const victim = scored[0]!.r;
    const node = this.ctx.api.get("Node", this.def.name);
    if (node) this.ctx.api.recordEvent(node, "Warning", "SystemOOM", `System OOM encountered, victim process: ${victim.ct.name}, pid: ${pidOf(victim.uid)}`, this.actor);
    this.oomKill(
      victim,
      `노드 ${this.def.name} 의 컨테이너 메모리 사용 합이 노드 메모리 ${fmtMem(cap)} 에 닿음 (overcommit — limits 가 없거나 limits 합이 노드보다 큼) → 노드의 커널 OOM killer 가 oom_score 가 가장 큰 프로세스를 고름 [${scored
        .map((x) => `${x.r.name} ${x.score} (${x.r.qos}, ${Math.round(this.memOf(x.r))}Mi)`)
        .join(" · ")}]`,
    );
  }

  private oomKill(rt: PodRt, why: string): void {
    if (!rt.alive) return;
    const ref = { kind: "Pod", namespace: rt.ns, name: rt.name };
    this.ctx.trace.add(this.actor, "kubelet.oom", `${rt.name} ${why} → OOMKilled · exit 137`, ref);
    if (rt.stage === "terminating") {
      rt.timer?.cancel();
      this.finish(rt, 137, "OOMKilled");
      return;
    }
    rt.timer?.cancel();
    this.crash(rt, 137, "OOMKilled");
    // API 의 Pod 가 이미 사라지는 중이라 crash 가 아무것도 못 했어도 프로세스는 죽었다 (감시가 같은 시각에 되풀이되지 않게)
    rt.alive = false;
    this.cpuCache = undefined;
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

/** f 가 시간에 대해 줄지 않을 때, f(t) > limit 이 되는 첫 시각 (ms 단위). 범위 안에 없으면 +∞ */
function firstAbove(f: (t: number) => number, limit: number, from: number, to: number): number {
  if (f(from) > limit) return from;
  if (f(to) <= limit) return Number.POSITIVE_INFINITY;
  let lo = from;
  let hi = to;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (f(mid) > limit) hi = mid;
    else lo = mid;
  }
  return hi;
}

function probeTimeout(url: string): string {
  return `Get "${url}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`;
}

/** 이벤트 문구용 프로세스 번호 (uid 로 정해지는 가짜) */
function pidOf(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return 1000 + (h % 30000);
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
