// API 서버 흉내: 오브젝트 저장소(etcd 대신 Map) + watch + 낙관적 동시성 + 이벤트 + ownerReference 가비지 컬렉션.
// 모든 컴포넌트(컨트롤러·스케줄러·kubelet)는 서로 직접 부르지 않고 여기에 쓰고, watch 로 깨어난다.
import type { Clock } from "../clock";
import { stableJson } from "../rng";
import { b64encode } from "../base64";
import { fmtCpu, fmtMem } from "../units";
import { inCidr } from "../net/netpol";
import type { Trace } from "../trace";
import { CLUSTER_SCOPED, type Container, type Deployment, type KEvent, type KObject, type Kind, type ObjectMeta, type ObjectOf, type Pod, type PodDisruptionBudget, type Service } from "./types";

export type WatchType = "ADDED" | "MODIFIED" | "DELETED";

export interface WatchEvent<K extends Kind = Kind> {
  type: WatchType;
  object: ObjectOf<K>;
}

export type ApiErrorReason = "NotFound" | "AlreadyExists" | "Conflict" | "Invalid" | "TooManyRequests" | "InternalError";

export class ApiError extends Error {
  constructor(
    readonly reason: ApiErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * watch 전달 지연(ms). 학습용 값 — 실제는 수 ms 이지만, 1배속 화면에서 "쓰기 → 다른 컴포넌트가 알아챔" 의 순서가 보이도록 늘렸다 (축소판).
 * 0 이어도 전달은 항상 이벤트 큐를 거친다 (콜백을 동기로 부르면 재진입 사고가 난다 — net-sim LESSONS 4h·4k).
 */
export const WATCH_DELAY_MS = 100;

/** 만들 때 채우는 메타데이터 외의 부분 */
export type Draft<K extends Kind> = Omit<ObjectOf<K>, "metadata" | "status"> & {
  metadata: Pick<ObjectMeta, "name"> & Partial<Pick<ObjectMeta, "namespace" | "labels" | "annotations" | "ownerReferences">>;
  status?: ObjectOf<K>["status"];
};

interface Watcher {
  kind: Kind;
  fn: (ev: WatchEvent) => void;
}

const clone = <T>(v: T): T => structuredClone(v);

export function objKey(kind: Kind, name: string, namespace?: string): string {
  return CLUSTER_SCOPED.has(kind) ? `${kind}/${name}` : `${kind}/${namespace ?? "default"}/${name}`;
}

export function refOf(o: KObject): { kind: Kind; namespace?: string; name: string } {
  return { kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name };
}

/** 이름은 DNS subdomain 규칙 (Pod·Deployment·ReplicaSet·Node): 소문자·숫자·'-'·'.', 253자 이하 */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export class ApiServer {
  private readonly store = new Map<string, KObject>();
  private rv = 0;
  private uidSeq = 0;
  private readonly watchers: Watcher[] = [];
  /** kubectl get events */
  readonly events: KEvent[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly trace: Trace,
    private readonly watchDelay = WATCH_DELAY_MS,
  ) {}

  get resourceVersion(): number {
    return this.rv;
  }

  // ---------- 읽기 (항상 복사본) ----------

  get<K extends Kind>(kind: K, name: string, namespace?: string): ObjectOf<K> | undefined {
    const o = this.store.get(objKey(kind, name, namespace));
    return o ? (clone(o) as ObjectOf<K>) : undefined;
  }

  list<K extends Kind>(kind: K, namespace?: string): ObjectOf<K>[] {
    const out: ObjectOf<K>[] = [];
    for (const o of this.store.values()) {
      if (o.kind !== kind) continue;
      if (namespace !== undefined && (o.metadata.namespace ?? "default") !== namespace) continue;
      out.push(clone(o) as ObjectOf<K>);
    }
    return out.sort((a, b) => cmp(a.metadata.namespace ?? "", b.metadata.namespace ?? "") || cmp(a.metadata.name, b.metadata.name));
  }

  /**
   * 복사 없이 저장된 오브젝트를 그대로 본다 — 읽기 전용 (고치면 저장소가 바뀐다).
   * 컴포넌트 안의 반복 조회(스케줄러가 Pod 하나마다 전체 Pod 를 훑는 것 등)가 복사로 느려지지 않게 쓴다. 고칠 것은 get/patch 로.
   */
  peekList<K extends Kind>(kind: K, namespace?: string): readonly ObjectOf<K>[] {
    const out: ObjectOf<K>[] = [];
    for (const o of this.store.values()) {
      if (o.kind !== kind) continue;
      if (namespace !== undefined && (o.metadata.namespace ?? "default") !== namespace) continue;
      out.push(o as ObjectOf<K>);
    }
    return out;
  }

  // ---------- 쓰기 ----------

  create<K extends Kind>(draft: Draft<K>, actor: string): ObjectOf<K> {
    const kind = draft.kind as K;
    const name = draft.metadata.name;
    if (!NAME_RE.test(name) || name.length > 253)
      throw new ApiError("Invalid", `${kind} "${name}" is invalid: metadata.name: 소문자·숫자·'-'·'.' 만, 253자 이하여야 합니다 (RFC 1123 subdomain)`);
    const namespace = CLUSTER_SCOPED.has(kind) ? undefined : (draft.metadata.namespace ?? "default");
    const key = objKey(kind, name, namespace);
    if (this.store.has(key)) throw new ApiError("AlreadyExists", `${lower(kind)} "${name}" already exists`);
    const obj = clone(draft) as unknown as ObjectOf<K>;
    obj.metadata = {
      name,
      namespace,
      uid: this.newUid(),
      resourceVersion: ++this.rv,
      generation: 1,
      creationTimestamp: this.clock.now,
      labels: { ...(draft.metadata.labels ?? {}) },
      ...(draft.metadata.annotations ? { annotations: { ...draft.metadata.annotations } } : {}),
      ownerReferences: clone(draft.metadata.ownerReferences ?? []),
    };
    if (obj.kind === "Deployment") defaultDeployment(obj as Deployment);
    resourceDefaults(obj);
    secretData(obj);
    if (!obj.status) obj.status = emptyStatus(kind) as ObjectOf<K>["status"];
    if (obj.kind === "Pod") addDefaultTolerations(obj as Pod);
    if (obj.kind === "Service") this.allocateServiceAddresses(obj as Service);
    this.store.set(key, obj);
    this.trace.add("kube-apiserver", "api.create", `${actor} 의 요청 → ${kind} ${name} 저장 (resourceVersion ${obj.metadata.resourceVersion})`, refOf(obj));
    this.notify("ADDED", obj);
    return clone(obj);
  }

  /**
   * 낙관적 동시성: obj.metadata.resourceVersion 이 저장된 것과 다르면 Conflict.
   * 내용이 같으면 아무것도 쓰지 않는다(resourceVersion 도 그대로) — 상태 갱신이 watch 로 서로를 끝없이 깨우지 않게.
   * spec 이 바뀌면 generation +1.
   */
  update<K extends Kind>(obj: ObjectOf<K>, actor: string): ObjectOf<K> {
    const key = objKey(obj.kind, obj.metadata.name, obj.metadata.namespace);
    const cur = this.store.get(key) as ObjectOf<K> | undefined;
    if (!cur) throw new ApiError("NotFound", `${lower(obj.kind)} "${obj.metadata.name}" not found`);
    if (cur.metadata.uid !== obj.metadata.uid) throw new ApiError("Conflict", `${lower(obj.kind)} "${obj.metadata.name}": uid 가 다릅니다 (지워지고 다시 만들어짐)`);
    if (cur.metadata.resourceVersion !== obj.metadata.resourceVersion) {
      this.trace.add("kube-apiserver", "api.conflict", `${actor} 의 ${obj.kind} ${obj.metadata.name} 쓰기 거절 — 읽은 resourceVersion ${obj.metadata.resourceVersion} ≠ 지금 ${cur.metadata.resourceVersion} (Conflict, 다시 읽고 재시도해야 함)`, refOf(cur));
      throw new ApiError("Conflict", `Operation cannot be fulfilled on ${lower(obj.kind)} "${obj.metadata.name}": the object has been modified; please apply your changes to the latest version and try again`);
    }
    const next = clone(obj);
    // 사용자가 바꿀 수 없는 메타데이터는 저장된 값을 지킨다
    next.metadata.uid = cur.metadata.uid;
    next.metadata.creationTimestamp = cur.metadata.creationTimestamp;
    next.metadata.deletionTimestamp = cur.metadata.deletionTimestamp;
    next.metadata.deletionGracePeriodSeconds = cur.metadata.deletionGracePeriodSeconds;
    next.metadata.generation = cur.metadata.generation;
    if (next.kind === "Service") this.allocateServiceAddresses(next as Service, cur as Service);
    if (next.kind === "Deployment") defaultDeployment(next as Deployment);
    resourceDefaults(next);
    secretData(next);
    if (stableJson(next) === stableJson(cur)) return clone(cur);
    const specChanged = stableJson(next.spec) !== stableJson(cur.spec);
    if (specChanged && obj.kind !== "Lease") next.metadata.generation = cur.metadata.generation + 1;
    next.metadata.resourceVersion = ++this.rv;
    this.store.set(key, next);
    const what = obj.kind === "Lease" ? "heartbeat 갱신 (renewTime)" : specChanged ? `spec 변경 (generation ${next.metadata.generation})` : stableJson(next.status) !== stableJson(cur.status) ? "status 갱신" : "metadata 변경";
    this.trace.add("kube-apiserver", "api.update", `${actor} 의 요청 → ${obj.kind} ${obj.metadata.name} ${what} (resourceVersion ${next.metadata.resourceVersion})`, refOf(next));
    this.notify("MODIFIED", next);
    return clone(next);
  }

  /** 읽고 → 고치고 → 쓰기. Conflict 면 다시 읽어 최대 5번 시도 (client-go RetryOnConflict 처럼) */
  patch<K extends Kind>(kind: K, name: string, namespace: string | undefined, actor: string, mutate: (o: ObjectOf<K>) => void): ObjectOf<K> | undefined {
    for (let i = 0; i < 5; i++) {
      const o = this.get(kind, name, namespace);
      if (!o) return undefined;
      mutate(o);
      try {
        return this.update(o, actor);
      } catch (e) {
        if (!(e instanceof ApiError) || e.reason !== "Conflict") throw e;
      }
    }
    throw new ApiError("Conflict", `${kind} ${name}: 5번 연속 Conflict`);
  }

  /**
   * 지우기. 노드에 올라간 Pod 는 바로 사라지지 않고 deletionTimestamp 만 찍힌다(Terminating) —
   * kubelet 이 컨테이너를 멈춘 뒤 마지막으로 지운다. gracePeriodSeconds 0 은 강제 삭제.
   */
  delete(kind: Kind, name: string, namespace: string | undefined, actor: string, opts: { gracePeriodSeconds?: number } = {}): boolean {
    const key = objKey(kind, name, namespace);
    const cur = this.store.get(key);
    if (!cur) throw new ApiError("NotFound", `${lower(kind)} "${name}" not found`);
    if (cur.kind === "Pod" && cur.spec.nodeName && opts.gracePeriodSeconds !== 0) {
      if (cur.metadata.deletionTimestamp !== undefined) return false;
      const next = clone(cur);
      next.metadata.deletionTimestamp = this.clock.now;
      next.metadata.deletionGracePeriodSeconds = opts.gracePeriodSeconds ?? cur.spec.terminationGracePeriodSeconds;
      next.metadata.resourceVersion = ++this.rv;
      this.store.set(key, next);
      this.trace.add(
        "kube-apiserver",
        "api.update",
        `${actor} 의 삭제 요청 → Pod ${name} 에 deletionTimestamp 표시 (Terminating, 유예 ${next.metadata.deletionGracePeriodSeconds}초 — kubelet 이 컨테이너를 멈추면 사라짐)`,
        refOf(next),
      );
      this.notify("MODIFIED", next);
      return true;
    }
    this.remove(cur, actor);
    return true;
  }

  /** 저장소에서 완전히 지우고 DELETED 를 알린다. 이 오브젝트를 주인으로 둔 것들은 가비지 컬렉터가 지운다 */
  private remove(cur: KObject, actor: string): void {
    this.store.delete(objKey(cur.kind, cur.metadata.name, cur.metadata.namespace));
    const gone = clone(cur);
    gone.metadata.resourceVersion = ++this.rv;
    this.trace.add("kube-apiserver", "api.delete", `${actor} 의 요청 → ${cur.kind} ${cur.metadata.name} 삭제`, refOf(cur));
    this.notify("DELETED", gone);
    const uid = cur.metadata.uid;
    // 가비지 컬렉터는 별도 컨트롤러다 → 큐를 거쳐 나중에 (지금 지운 것의 DELETED 를 먼저 다른 컴포넌트가 보도록)
    this.clock.after(this.watchDelay, "garbage-collector", () => this.collectDependents(uid, cur));
  }

  /**
   * Eviction API (kubectl drain 이 쓰는 것): 그 Pod 를 고르는 PodDisruptionBudget 이 중단을 허락할 때만 지운다.
   * 허락하지 않으면 429 TooManyRequests. 허락하면 PDB 의 disruptionsAllowed 를 하나 줄이고 Pod 를 지운다(유예 시간 있음).
   */
  evict(name: string, namespace: string | undefined, actor: string): void {
    const p = this.store.get(objKey("Pod", name, namespace)) as Pod | undefined;
    if (!p) throw new ApiError("NotFound", `pods "${name}" not found`);
    if (p.metadata.deletionTimestamp !== undefined) return;
    // 아직 안 뜬(Pending)·끝난 Pod 는 PDB 를 보지 않는다 (canIgnorePDB)
    if (p.status.phase === "Pending" || p.status.phase === "Succeeded" || p.status.phase === "Failed") {
      this.delete("Pod", name, namespace, actor);
      return;
    }
    const ns = p.metadata.namespace ?? "default";
    const budgets = [...this.store.values()].filter(
      (o): o is PodDisruptionBudget =>
        o.kind === "PodDisruptionBudget" && (o.metadata.namespace ?? "default") === ns && Object.entries(o.spec.selector.matchLabels).every(([k, v]) => p.metadata.labels[k] === v),
    );
    if (budgets.length > 1) throw new ApiError("InternalError", "This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.");
    const b = budgets[0];
    if (b) {
      const ready = p.status.conditions.some((c) => c.type === "Ready" && c.status === "True");
      // 준비 안 된 Pod 는 예산이 건강할 때 지울 수 있다 (unhealthyPodEvictionPolicy: IfHealthyBudget)
      const ok = ready ? b.status.disruptionsAllowed > 0 : b.status.currentHealthy >= b.status.desiredHealthy;
      if (!ok) {
        this.trace.add("kube-apiserver", "api.conflict", `${actor} 의 eviction 요청 → Pod ${name} 거절: PodDisruptionBudget ${b.metadata.name} 이 허락하지 않음 (Ready ${b.status.currentHealthy} · 최소 ${b.status.desiredHealthy} · 허용 ${b.status.disruptionsAllowed})`, refOf(p));
        throw new ApiError("TooManyRequests", "Cannot evict pod as it would violate the pod's disruption budget.");
      }
      if (ready) {
        const next = clone(b);
        next.status.disruptionsAllowed -= 1;
        next.status.currentHealthy -= 1;
        next.metadata.resourceVersion = ++this.rv;
        this.store.set(objKey(b.kind, b.metadata.name, b.metadata.namespace), next);
        this.notify("MODIFIED", next);
      }
    }
    this.delete("Pod", name, namespace, actor);
  }

  /** kubelet 이 컨테이너를 다 멈춘 Pod 를 마지막으로 지울 때 */
  finalizePod(name: string, namespace: string | undefined, uid: string, actor: string): void {
    const cur = this.store.get(objKey("Pod", name, namespace));
    if (!cur || cur.metadata.uid !== uid) return;
    this.remove(cur, actor);
  }

  private collectDependents(ownerUid: string, owner: KObject): void {
    for (const o of [...this.store.values()]) {
      if (!o.metadata.ownerReferences.some((r) => r.uid === ownerUid)) continue;
      if (o.metadata.deletionTimestamp !== undefined) continue;
      this.trace.add("garbage-collector", "gc.delete", `${o.kind} ${o.metadata.name} 의 주인 ${owner.kind} ${owner.metadata.name} 이(가) 사라짐 → ${o.kind} ${o.metadata.name} 삭제 (ownerReferences, background)`, refOf(o));
      this.delete(o.kind, o.metadata.name, o.metadata.namespace, "garbage-collector");
    }
  }

  // ---------- Service 주소 (API 서버가 정한다) ----------

  /**
   * ClusterIP 는 10.96.0.0/12 에서 (10.96.0.1 = kubernetes, 10.96.0.10 = kube-dns 는 비워 둠), NodePort 는 30000-32767.
   * 만들 때와 바꿀 때 모두 부른다: clusterIP 는 바꿀 수 없고(immutable), 지정한 nodePort 는 범위·중복을 검사하고, 비어 있으면 새로 정한다.
   */
  private allocateServiceAddresses(svc: Service, prev?: Service): void {
    const name = svc.metadata.name;
    const used = new Set<string>(["10.96.0.1", "10.96.0.10"]);
    const usedPorts = new Set<number>();
    for (const o of this.store.values()) {
      if (o.kind !== "Service" || o.metadata.uid === svc.metadata.uid || (o.metadata.name === name && (o.metadata.namespace ?? "default") === (svc.metadata.namespace ?? "default"))) continue;
      if (o.spec.clusterIP && o.spec.clusterIP !== "None") used.add(o.spec.clusterIP);
      for (const p of o.spec.ports) if (p.nodePort) usedPorts.add(p.nodePort);
    }
    if (prev?.spec.clusterIP) {
      if (svc.spec.clusterIP && svc.spec.clusterIP !== prev.spec.clusterIP)
        throw new ApiError("Invalid", `Service "${name}" is invalid: spec.clusterIP: Invalid value: "${svc.spec.clusterIP}": field is immutable`);
      svc.spec.clusterIP = prev.spec.clusterIP;
    } else if (svc.spec.clusterIP === "None" && svc.spec.type !== "ClusterIP") {
      throw new ApiError("Invalid", `Service "${name}" is invalid: spec.clusterIPs[0]: Invalid value: "None": may not be set to 'None' for ${svc.spec.type} services`);
    } else if (svc.spec.clusterIP && used.has(svc.spec.clusterIP)) {
      throw new ApiError("Invalid", `Service "${name}" is invalid: spec.clusterIP: Invalid value: "${svc.spec.clusterIP}": provided IP is already allocated`);
    }
    if (!svc.spec.clusterIP) {
      for (let i = 0; ; i++) {
        const host = 100 + ((stableHash(name) + i) % 150);
        const ip = `10.96.${Math.floor(i / 150)}.${host}`;
        if (!used.has(ip)) {
          svc.spec.clusterIP = ip;
          break;
        }
      }
    }
    // externalTrafficPolicy 는 바깥에서 들어오는 Service 에만 (기본 Cluster).
    // ClusterIP 로 바꿀 때 옛 값을 그대로 들고 오면 조용히 지우고(실제 dropTypeDependentFields), 새로 적었으면 거절
    if (svc.spec.type === "ClusterIP") {
      const carried = prev && prev.spec.type !== "ClusterIP" && svc.spec.externalTrafficPolicy === prev.spec.externalTrafficPolicy;
      if (svc.spec.externalTrafficPolicy && !carried)
        throw new ApiError("Invalid", `Service "${name}" is invalid: spec.externalTrafficPolicy: Invalid value: "${svc.spec.externalTrafficPolicy}": may only be set for externally-accessible services`);
      delete svc.spec.externalTrafficPolicy;
    } else svc.spec.externalTrafficPolicy ??= "Cluster";
    svc.spec.ports.forEach((p, i) => {
      if (svc.spec.type === "ClusterIP") {
        delete p.nodePort;
        return;
      }
      if (p.nodePort !== undefined) {
        if (!Number.isInteger(p.nodePort) || p.nodePort < 30000 || p.nodePort > 32767)
          throw new ApiError("Invalid", `Service "${name}" is invalid: spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
        if (usedPorts.has(p.nodePort)) throw new ApiError("Invalid", `Service "${name}" is invalid: spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is already allocated`);
        usedPorts.add(p.nodePort);
        return;
      }
      for (let j = 0; ; j++) {
        const port = 30000 + ((stableHash(`${name}/${p.port}`) + j) % 2768);
        if (!usedPorts.has(port)) {
          p.nodePort = port;
          usedPorts.add(port);
          break;
        }
      }
    });
  }

  // ---------- watch ----------

  watch<K extends Kind>(kind: K, fn: (ev: WatchEvent<K>) => void): () => void {
    // 종류별 구독을 한 목록에 담는다 — notify 가 kind 로 거르므로 이 변환은 안전하다
    const w: Watcher = { kind, fn: fn as unknown as (ev: WatchEvent) => void };
    this.watchers.push(w);
    return () => {
      const i = this.watchers.indexOf(w);
      if (i >= 0) this.watchers.splice(i, 1);
    };
  }

  private notify(type: WatchType, obj: KObject): void {
    // 복사본 하나를 모든 구독자가 같이 본다 — watch 이벤트의 object 는 읽기 전용 (고칠 것은 get 으로 새로 읽는다).
    // 구독자마다 복사하면 Pod 수십 개를 한꺼번에 만들 때 복사가 구독자 수만큼 늘어 긴 프레임이 생겼다
    const ev = { type, object: clone(obj) } as WatchEvent;
    for (const w of this.watchers) {
      if (w.kind !== obj.kind) continue;
      // 전달 전에 구독을 끊으면 받지 않는다
      this.clock.after(this.watchDelay, "watch", () => {
        if (this.watchers.includes(w)) w.fn(ev);
      });
    }
  }

  // ---------- 이벤트 (kubectl get events) ----------

  recordEvent(obj: KObject, type: "Normal" | "Warning", reason: string, message: string, source: string): void {
    const key = `${obj.metadata.uid}|${reason}|${message}`;
    const t = this.clock.now;
    const same = this.events.find((e) => e.key === key);
    if (same) {
      same.count++;
      same.lastTimestamp = t;
      // 최근 것이 끝에 오게
      this.events.splice(this.events.indexOf(same), 1);
      this.events.push(same);
      return;
    }
    this.events.push({
      key,
      type,
      reason,
      message,
      source,
      involvedObject: { kind: obj.kind, namespace: obj.metadata.namespace, name: obj.metadata.name, uid: obj.metadata.uid },
      count: 1,
      firstTimestamp: t,
      lastTimestamp: t,
    });
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }

  eventsFor(uid: string): KEvent[] {
    return this.events.filter((e) => e.involvedObject.uid === uid);
  }

  private newUid(): string {
    const n = (++this.uidSeq).toString(16).padStart(12, "0");
    return `0000a1b2-c3d4-4e5f-8a9b-${n}`;
  }
}

/** API 서버의 기본값 채우기 (Deployment): 전략 RollingUpdate 25%/25%, progressDeadlineSeconds 600, revisionHistoryLimit 10 */
/**
 * 컨테이너 resources 의 기본값과 검사: limits 만 적고 requests 를 비우면 Pod 에서 requests = limits,
 * requests 가 limits 보다 크면 Invalid (Pod·ReplicaSet·Deployment 템플릿 모두, 실제 API 서버와 같은 문구).
 */
function resourceDefaults(o: KObject): void {
  let containers: Container[] | undefined;
  let path = "spec.containers";
  if (o.kind === "Pod") containers = o.spec.containers;
  else if (o.kind === "Deployment" || o.kind === "ReplicaSet") {
    containers = o.spec.template.spec.containers;
    path = "spec.template.spec.containers";
  }
  if (!containers) return;
  containers.forEach((c, i) => {
    // 기본값은 Pod 에만 (실제 SetDefaults_Pod) — 템플릿은 적은 그대로 두어, limits 를 바꾸면 새 Pod 가 새 limits 로 채워진다
    if (o.kind === "Pod") defaultContainerResources(c);
    const r = c.resources.requests;
    const l = c.resources.limits;
    if (!l) return;
    if (l.cpu !== undefined && r.cpu > l.cpu)
      throw new ApiError("Invalid", `${o.kind} "${o.metadata.name}" is invalid: ${path}[${i}].resources.requests: Invalid value: "${fmtCpu(r.cpu)}": must be less than or equal to cpu limit of ${fmtCpu(l.cpu)}`);
    if (l.memory !== undefined && r.memory > l.memory)
      throw new ApiError("Invalid", `${o.kind} "${o.metadata.name}" is invalid: ${path}[${i}].resources.requests: Invalid value: "${fmtMem(r.memory)}": must be less than or equal to memory limit of ${fmtMem(l.memory)}`);
  });
}

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/;

function validCidr(s: string): boolean {
  const m = CIDR_RE.exec(s);
  return !!m && [m[1], m[2], m[3], m[4]].every((x) => Number(x) <= 255);
}

function cidrBits(s: string): number {
  return Number(s.split("/")[1]);
}

/** ConfigMap·Secret 의 키 규칙 (파일 이름이 되므로 / 같은 것은 안 된다) */
export const CONFIG_KEY_RE = /^[-._a-zA-Z0-9]+$/;

/**
 * Secret 의 stringData(평문)는 저장하지 않고 data(base64)에 합친다 — 실제 API 서버와 같음 (같은 키면 stringData 가 이김).
 * ConfigMap·Secret 의 키 검사, Ingress 의 "규칙이나 기본 backend 중 하나는 있어야" 검사도 여기서.
 */
function secretData(o: KObject): void {
  if (o.kind === "Ingress" && !o.spec.rules?.length && !o.spec.defaultBackend)
    throw new ApiError("Invalid", `Ingress.networking.k8s.io "${o.metadata.name}" is invalid: spec: Invalid value: "": either \`defaultBackend\` or \`rules\` must be specified`);
  if (o.kind === "NetworkPolicy") {
    // policyTypes 를 비우면: Ingress 는 늘, egress 규칙이 있으면 Egress 도 (실제 기본값)
    if (!o.spec.policyTypes?.length) o.spec.policyTypes = o.spec.egress?.length ? ["Ingress", "Egress"] : ["Ingress"];
    // 포트의 protocol 을 비우면 TCP (실제 기본값)
    for (const r of [...(o.spec.ingress ?? []), ...(o.spec.egress ?? [])]) for (const p of r.ports ?? []) p.protocol ??= "TCP";
    const peers = [...(o.spec.ingress ?? []).flatMap((r) => r.from ?? []), ...(o.spec.egress ?? []).flatMap((r) => r.to ?? [])];
    for (const p of peers) {
      if (!p.ipBlock && !p.podSelector && !p.namespaceSelector) throw new ApiError("Invalid", `NetworkPolicy.networking.k8s.io "${o.metadata.name}" is invalid: spec: Required value: must specify a peer`);
      const cidrs = p.ipBlock ? [p.ipBlock.cidr, ...(p.ipBlock.except ?? [])] : [];
      for (const cidr of cidrs) if (!validCidr(cidr)) throw new ApiError("Invalid", `NetworkPolicy.networking.k8s.io "${o.metadata.name}" is invalid: ipBlock.cidr: Invalid value: "${cidr}": must be a valid CIDR value, (e.g. 10.9.8.0/24 or 2001:db8::/64)`);
      for (const ex of p.ipBlock?.except ?? [])
        if (!(cidrBits(ex) > cidrBits(p.ipBlock!.cidr) && inCidr(ex.split("/")[0]!, p.ipBlock!.cidr)))
          throw new ApiError("Invalid", `NetworkPolicy.networking.k8s.io "${o.metadata.name}" is invalid: ipBlock.except: Invalid value: "${ex}": must be a strict subset of \`cidr\``);
      if (p.ipBlock && (p.podSelector || p.namespaceSelector)) throw new ApiError("Invalid", `NetworkPolicy.networking.k8s.io "${o.metadata.name}" is invalid: may not specify more than 1 peer type (ipBlock 은 podSelector·namespaceSelector 와 같은 항목에 쓸 수 없습니다)`);
    }
    return;
  }
  if (o.kind !== "ConfigMap" && o.kind !== "Secret") return;
  if (o.kind === "ConfigMap") o.data ??= {};
  else {
    o.type ??= "Opaque";
    o.data = { ...(o.data ?? {}) };
    for (const [k, v] of Object.entries(o.stringData ?? {})) o.data[k] = b64encode(v);
    delete o.stringData;
  }
  for (const k of Object.keys(o.data))
    if (!CONFIG_KEY_RE.test(k))
      throw new ApiError("Invalid", `${o.kind} "${o.metadata.name}" is invalid: data[${k}]: Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
}

/** limits 만 적고 requests 를 비우면(0) requests = limits — API 서버가 Pod 에만 채우는 기본값 (템플릿에는 채우지 않으므로 Argo CD·드리프트 비교는 보정이 필요 없다) */
function defaultContainerResources(c: Container): void {
  const r = c.resources.requests;
  const l = c.resources.limits;
  if (!l) return;
  if (l.cpu !== undefined && !r.cpu) r.cpu = l.cpu;
  if (l.memory !== undefined && !r.memory) r.memory = l.memory;
}

function defaultDeployment(d: Deployment): void {
  d.spec.strategy ??= { type: "RollingUpdate" };
  if (d.spec.strategy.type === "RollingUpdate") d.spec.strategy.rollingUpdate ??= { maxSurge: "25%", maxUnavailable: "25%" };
  else delete d.spec.strategy.rollingUpdate;
  d.spec.progressDeadlineSeconds ??= 600;
  d.spec.revisionHistoryLimit ??= 10;
}

/** 어드미션 플러그인 DefaultTolerationSeconds: 노드가 not-ready·unreachable 이 돼도 300초는 버티도록 toleration 을 붙인다 */
export const DEFAULT_TOLERATION_SECONDS = 300;
function addDefaultTolerations(p: Pod): void {
  const tols = (p.spec.tolerations ??= []);
  for (const key of ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"]) {
    if (tols.some((t) => t.key === key && (!t.effect || t.effect === "NoExecute"))) continue;
    tols.push({ key, operator: "Exists", effect: "NoExecute", tolerationSeconds: DEFAULT_TOLERATION_SECONDS });
  }
}

function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function emptyStatus(kind: Kind): unknown {
  switch (kind) {
    case "Pod":
      return { phase: "Pending", conditions: [], containerStatuses: [] };
    case "ReplicaSet":
      return { replicas: 0, readyReplicas: 0, availableReplicas: 0, observedGeneration: 0 };
    case "Deployment":
      return { replicas: 0, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0, observedGeneration: 0 };
    case "Node":
      return { capacity: { cpu: 0, memory: 0, pods: 0 }, allocatable: { cpu: 0, memory: 0, pods: 0 }, conditions: [], addresses: [], images: [] };
    case "PodDisruptionBudget":
      return { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0, observedGeneration: 0 };
    case "Ingress":
      return { loadBalancer: {} };
    case "Application":
      return { sync: { status: "Unknown" }, health: { status: "Unknown" }, resources: [], history: [] };
    case "Lease":
    case "Service":
    case "EndpointSlice":
    case "ConfigMap":
    case "Secret":
    case "NetworkPolicy":
    case "StorageClass":
      return {};
    case "PersistentVolumeClaim":
      return { phase: "Pending" };
    case "PersistentVolume":
      return { phase: "Available" };
    case "StatefulSet":
      return { replicas: 0, readyReplicas: 0, availableReplicas: 0, currentReplicas: 0, updatedReplicas: 0, observedGeneration: 0 };
  }
}

function lower(kind: Kind): string {
  if (kind === "ReplicaSet") return "replicasets.apps";
  if (kind === "Deployment") return "deployments.apps";
  if (kind === "Lease") return "leases.coordination.k8s.io";
  if (kind === "EndpointSlice") return "endpointslices.discovery.k8s.io";
  if (kind === "PodDisruptionBudget") return "poddisruptionbudgets.policy";
  if (kind === "Ingress") return "ingresses.networking.k8s.io";
  if (kind === "Application") return "applications.argoproj.io";
  return `${kind.toLowerCase()}s`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
