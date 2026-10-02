// 편집 중인 정의를 살아 있는 클러스터에 동기화하고, 시뮬레이션 시계를 화면 프레임마다 돌린다.
// 순수 로직은 defSync.ts(동기화) · simClock.ts(시계) 에 있고, 여기는 신호와 rAF 만 다룬다.
import { effect, signal } from "@preact/signals";
import type { DeploymentManifest } from "../core/cluster";
import { runKubectl, type KubectlResult } from "../core/kubectl";
import type { NetResult } from "../core/net/request";
import { DefSync } from "./defSync";
import { exampleById, type TryAction } from "./examples";
import { advanceClock, EVENT_BURST_LIMIT } from "./simClock";
import { buildView, type ClusterView } from "./view";
import { clusterDef, exampleId } from "./store";

/** 보관하는 트레이스 상한 (넘으면 오래된 것부터) */
const TRACE_CAP = 20_000;

export const simTime = signal(0);
export const running = signal(true);
export const speed = signal(1);
/** 클러스터 상태가 바뀔 때마다 증가 → 화면이 다시 읽는다 */
export const simVersion = signal(0);
/** 사용자에게 보여 줄 알림 (폭주 정지, 내부 오류) */
export const simNotice = signal<string | null>(null);

export interface KubectlEntry {
  id: number;
  t: number;
  command: string;
  result: KubectlResult;
}
export const kubectlHistory = signal<KubectlEntry[]>([]);

/** 방금 보낸 요청 (캔버스가 경로를 점으로 그린다) */
export interface RequestView {
  id: number;
  /** 출발: Pod 이름, 또는 클러스터 밖이면 노드 이름 */
  fromPod?: string;
  fromOutside?: string;
  net: NetResult;
}
export const lastRequest = signal<RequestView | null>(null);

class SimController {
  private readonly syncer = new DefSync();
  private lastFrame = 0;
  private entrySeq = 0;

  get cluster() {
    return this.syncer.cluster;
  }

  constructor() {
    this.syncer.reset(clusterDef.peek(), this.startMessage());
    effect(() => {
      if (this.syncer.sync(clusterDef.value)) this.bump();
    });
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(this.frame);
  }

  private startMessage(): string {
    const ex = exampleId.peek() ? exampleById(exampleId.peek()!) : undefined;
    return ex ? `예제 불러오기: ${ex.title}` : "저장된 구성으로 시작";
  }

  /** 시계·로그를 0 으로 되돌리고 지금 정의로 처음부터 */
  reset(): void {
    this.syncer.reset(clusterDef.peek(), this.startMessage());
    simTime.value = 0;
    kubectlHistory.value = [];
    lastRequest.value = null;
    simNotice.value = null;
    this.bump();
  }

  private readonly frame = (ts: number): void => {
    const dt = this.lastFrame ? Math.min(100, ts - this.lastFrame) : 0;
    this.lastFrame = ts;
    if (running.value) {
      try {
        const r = advanceClock(this.cluster.clock, dt, speed.peek());
        if (r) {
          if (r.burst) {
            running.value = false;
            simNotice.value = `이벤트가 폭주해 일시정지했습니다 (한 프레임에 ${EVENT_BURST_LIMIT}개 초과). 컨트롤러가 서로를 계속 고치는 구성인지 로그를 확인하세요`;
          }
          simTime.value = r.time;
          if (r.changed) this.bump();
        }
      } catch (e) {
        this.fail(e);
      }
    }
    requestAnimationFrame(this.frame);
  };

  private fail(e: unknown): void {
    console.error("simulation error", e);
    running.value = false;
    simNotice.value = `시뮬레이션 내부 오류로 일시정지했습니다: ${e instanceof Error ? e.message : String(e)}`;
  }

  /** 일시정지 상태에서 이벤트 하나 */
  step(): void {
    if (!this.cluster.clock.stepAny()) return;
    simTime.value = this.cluster.now;
    this.bump();
  }

  /** 시간 흘려보내기: 그 사이의 일(백오프 끝, 재시작)을 한꺼번에 처리 */
  fastForward(ms: number): void {
    try {
      this.cluster.runFor(ms, EVENT_BURST_LIMIT * 25);
    } catch (e) {
      this.fail(e);
    }
    simTime.value = this.cluster.now;
    this.bump();
  }

  kubectl(command: string): KubectlResult {
    let result: KubectlResult;
    try {
      result = runKubectl(this.cluster, command);
    } catch (e) {
      result = { ok: false, output: `내부 오류: ${e instanceof Error ? e.message : String(e)}`, mutated: false };
    }
    const entry: KubectlEntry = { id: ++this.entrySeq, t: this.cluster.now, command: command.trim(), result };
    kubectlHistory.value = [...kubectlHistory.peek(), entry].slice(-200);
    if (result.net) lastRequest.value = { id: entry.id, fromPod: /exec\s+(\S+)/.exec(command)?.[1], net: result.net };
    if (result.mutated) this.bump();
    return result;
  }

  /** 예제 "해 볼 것" 의 kubectl 아닌 동작. 지금 할 수 없으면 이유를, 했으면 undefined */
  runAction(a: TryAction): string | undefined {
    const why = this.actionBlocked(a);
    if (why) return why;
    const c = this.cluster;
    if (a.type === "power") this.setNodePower(a.node, a.on);
    else if (a.type === "sick") {
      c.setPodHealth(this.actionPod(a.deployment)!, a.healthy);
      this.bump();
    } else this.curlNodePort(a.node, c.api.get("Service", a.service, "default")!.spec.ports[0]!.nodePort!);
    return undefined;
  }

  actionBlocked(a: TryAction): string | undefined {
    const c = this.cluster;
    if (a.type === "power") {
      if (!c.kubelets.has(a.node)) return `노드 ${a.node} 이(가) 없습니다`;
      return c.nodePowered(a.node) === a.on ? (a.on ? "이미 켜져 있습니다" : "이미 꺼져 있습니다") : undefined;
    }
    if (a.type === "sick") {
      const pod = this.actionPod(a.deployment);
      if (!pod) return `${a.deployment} 의 Pod 가 아직 돌고 있지 않습니다`;
      return c.podSick(pod) === !a.healthy ? (a.healthy ? "고장 난 Pod 가 없습니다" : "이미 고장 냈습니다") : undefined;
    }
    const svc = c.api.get("Service", a.service, "default");
    if (!svc?.spec.ports[0]?.nodePort) return `NodePort Service ${a.service} 가 아직 없습니다 (앞 단계를 먼저)`;
    return c.kubelets.has(a.node) ? undefined : `노드 ${a.node} 이(가) 없습니다`;
  }

  /** sick 동작의 대상: 그 Deployment 의 Pod 중 컨테이너가 도는 첫 번째 (이름순) */
  private actionPod(deployment: string): string | undefined {
    return this.cluster.api
      .list("Pod", "default")
      .find((p) => p.metadata.labels.app === deployment && p.metadata.deletionTimestamp === undefined && p.status.containerStatuses[0] && "running" in p.status.containerStatuses[0].state)?.metadata.name;
  }

  /** 화면 밖 동작 뒤 다시 그리기 */
  touch(): void {
    this.bump();
  }

  /** 클러스터 밖에서 노드IP:NodePort 로 curl (인스펙터 버튼) */
  curlNodePort(node: string, port: number): void {
    const c = this.cluster;
    const ip = c.api.get("Node", node)?.status.addresses[0]?.address ?? node;
    const r = c.requestNodePort(node, port);
    const entry: KubectlEntry = { id: ++this.entrySeq, t: c.now, command: `(클러스터 밖에서) curl http://${ip}:${port}`, result: { ok: r.ok, output: r.output, mutated: true, net: r } };
    kubectlHistory.value = [...kubectlHistory.peek(), entry].slice(-200);
    lastRequest.value = { id: entry.id, fromOutside: node, net: r };
    this.bump();
  }

  setNodePower(name: string, on: boolean): void {
    this.cluster.setNodePower(name, on);
    this.bump();
  }

  drift(name: string): string[] {
    const m = clusterDef.peek().manifests.find((x): x is DeploymentManifest => x.kind === "Deployment" && x.metadata.name === name);
    return m ? this.syncer.drift(m) : [];
  }

  /** 매니페스트를 다시 적용해 kubectl 로 바꾼 것을 되돌린다 */
  reapply(name: string): void {
    this.syncer.forget("Deployment", name);
    if (this.syncer.sync(clusterDef.peek())) this.bump();
  }

  clearLog(): void {
    this.cluster.trace.events.length = 0;
    this.bump();
  }

  private bump(): void {
    const ev = this.cluster.trace.events;
    if (ev.length > TRACE_CAP) ev.splice(0, ev.length - TRACE_CAP + 500);
    simVersion.value = simVersion.peek() + 1;
  }
}

export const sim = new SimController();

let viewCache: { cluster: unknown; version: number; view: ClusterView } | undefined;
/** 화면 모양 — 같은 버전이면 캔버스·왼쪽 목록이 한 번 만든 것을 같이 쓴다 */
export function currentView(): ClusterView {
  const version = simVersion.value;
  const cluster = sim.cluster;
  if (!viewCache || viewCache.version !== version || viewCache.cluster !== cluster) viewCache = { cluster, version, view: buildView(cluster) };
  return viewCache.view;
}

export function togglePlay(): void {
  running.value = !running.value;
}
