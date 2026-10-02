// 트레이스: 시뮬레이션에서 일어난 일의 한 줄 기록. 새 종류는 여기에 먼저 등록한다.
// 문구는 "무엇을 보고 → 어떤 결정 → 결과" 가 한 줄에 드러나게 쓴다.

export type TraceKind =
  /** 사용자가 한 일 (예제 불러오기, kubectl, 인스펙터 편집) */
  | "user"
  /** API 서버에 오브젝트가 생기거나 바뀌거나 사라짐 */
  | "api.create"
  | "api.update"
  | "api.delete"
  /** 쓰기 충돌 (resourceVersion 이 달라 거절) */
  | "api.conflict"
  /** 컨트롤러가 원하는 상태와 지금 상태를 비교해 결정 */
  | "controller.reconcile"
  /** 컨트롤러가 실패해 백오프 뒤 다시 시도 */
  | "controller.retry"
  /** 가비지 컬렉터: 주인(ownerReference)이 사라진 오브젝트를 지움 */
  | "gc.delete"
  | "scheduler.bind"
  | "scheduler.fail"
  /** kubelet: Pod 샌드박스·IP 준비 */
  | "kubelet.sandbox"
  | "kubelet.pull"
  | "kubelet.pull.fail"
  | "kubelet.start"
  | "kubelet.exit"
  | "kubelet.backoff"
  | "kubelet.kill"
  | "kubelet.removed"
  /** readiness probe 결과로 Ready 가 바뀜 */
  | "kubelet.probe"
  | "node.register"
  /** kubelet 이 꺼지거나 다시 켜짐 (사용자 동작) */
  | "node.power"
  /** node-lifecycle-controller: Lease 가 끊겨 NotReady·taint, 또는 되살아남 */
  | "node.notready"
  | "node.ready"
  /** taint-eviction-controller: NoExecute taint 를 못 견디는 Pod 를 지움 */
  | "node.evict"
  /** kube-proxy 가 노드의 iptables 규칙을 다시 씀 */
  | "net.rules"
  /** 요청 한 번의 단계: DNS → DNAT(규칙) → 노드 간 경로 → 앱 응답 / 실패 */
  | "net.request"
  | "net.dns"
  | "net.dnat"
  | "net.route"
  | "net.response"
  | "net.fail";

export interface ObjRef {
  kind: string;
  namespace?: string;
  name: string;
}

export interface TraceEvent {
  seq: number;
  /** 시뮬레이션 시각(ms) */
  t: number;
  /** 실제 컴포넌트 이름 (kube-scheduler, replicaset-controller, kubelet@node-1 …) */
  actor: string;
  kind: TraceKind;
  msg: string;
  /** 이 기록이 주로 가리키는 오브젝트 (로그에서 고르면 화면에서 선택) */
  ref?: ObjRef;
}

export class Trace {
  readonly events: TraceEvent[] = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  add(actor: string, kind: TraceKind, msg: string, ref?: ObjRef): TraceEvent {
    const e: TraceEvent = { seq: this.seq++, t: this.now(), actor, kind, msg, ref };
    this.events.push(e);
    return e;
  }

  kinds(from = 0): TraceKind[] {
    return this.events.slice(from).map((e) => e.kind);
  }
}
