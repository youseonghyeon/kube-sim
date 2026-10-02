// Deployment 컨트롤러: Pod 템플릿의 해시로 "지금 템플릿용 ReplicaSet"(새 RS)을 찾거나 만들고, 전략에 따라 새 RS 를 늘리고 옛 RS 를 줄인다.
// - RollingUpdate: 전체 Pod 수가 replicas + maxSurge 를 넘지 않게 새 RS 를 늘리고, available 이 replicas - maxUnavailable 밑으로 가지 않게 옛 RS 를 줄인다.
//   새 Pod 가 Ready(available)가 돼야 옛 Pod 를 더 줄일 수 있으므로, readiness 가 실패하면 롤아웃이 그 자리에서 멈춘다.
// - Recreate: 옛 RS 를 0 으로 줄이고, 옛 Pod 가 모두 사라진 뒤에 새 RS 를 늘린다.
// 리비전은 RS 의 deployment.kubernetes.io/revision 주석. 옛 템플릿으로 되돌리면(rollout undo) 그 RS 를 다시 쓰고 리비전을 올린다.
// 축소판: minReadySeconds·paused·비례 스케일링(proportional scaling) 없음.
import { refOf } from "../api/server";
import { controllerOf, type Deployment, type IntOrPercent, type ReplicaSet } from "../api/types";
import type { TimerHandle } from "../clock";
import { templateHash } from "../rng";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export const HASH_LABEL = "pod-template-hash";
export const REVISION = "deployment.kubernetes.io/revision";

/** 실제 ComputeHash(template, collisionCount) 처럼: 충돌 횟수가 있으면 해시에 섞는다 */
export function deploymentHash(d: Deployment): string {
  const n = d.status.collisionCount ?? 0;
  return templateHash(n ? { template: d.spec.template, collisionCount: n } : d.spec.template);
}

export function revisionOf(rs: { metadata: { annotations?: Record<string, string> } }): number {
  return Number(rs.metadata.annotations?.[REVISION] ?? 0) || 0;
}

/** "25%" → replicas 의 25% (maxSurge 는 올림, maxUnavailable 은 내림), 숫자는 그대로 */
export function resolveIntOrPercent(v: IntOrPercent | undefined, total: number, roundUp: boolean): number {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  const m = /^(\d+)%$/.exec(v.trim());
  if (!m) return Number(v) || 0;
  const x = (Number(m[1]) * total) / 100;
  return roundUp ? Math.ceil(x) : Math.floor(x);
}

/** 롤아웃이 끝났는가 (kubectl rollout status 가 성공이라고 말하는 조건) */
export function rolloutComplete(d: Deployment): boolean {
  const s = d.status;
  return s.observedGeneration >= d.metadata.generation && s.updatedReplicas === d.spec.replicas && s.replicas === d.spec.replicas && s.availableReplicas === d.spec.replicas;
}

export class DeploymentController extends Controller {
  /** Deployment 마다 진전 마감 확인 타이머 */
  private readonly deadlines = new Map<string, TimerHandle>();

  constructor(ctx: ComponentContext) {
    super("deployment-controller", ctx);
    ctx.api.watch("Deployment", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("ReplicaSet", (ev) => {
      const owner = controllerOf(ev.object.metadata);
      if (owner?.kind === "Deployment") this.enqueue(nsKey(ev.object.metadata.namespace, owner.name));
    });
    // Recreate 는 옛 Pod 가 다 사라지기를 기다리므로 Pod 삭제도 본다
    ctx.api.watch("Pod", (ev) => {
      if (ev.type !== "DELETED") return;
      const rsRef = controllerOf(ev.object.metadata);
      if (rsRef?.kind !== "ReplicaSet") return;
      const rs = ctx.api.get("ReplicaSet", rsRef.name, ev.object.metadata.namespace);
      const owner = rs && controllerOf(rs.metadata);
      if (owner?.kind === "Deployment") this.enqueue(nsKey(ev.object.metadata.namespace, owner.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const d = this.api.get("Deployment", name, ns);
    if (!d || d.metadata.deletionTimestamp !== undefined) {
      this.deadlines.get(key)?.cancel();
      this.deadlines.delete(key);
      return;
    }
    const hash = deploymentHash(d);
    const owned = this.ownedRS(d, ns);
    let newRS = owned.find((rs) => rs.metadata.labels[HASH_LABEL] === hash);
    const maxRev = Math.max(0, ...owned.map(revisionOf));
    const recreate = d.spec.strategy?.type === "Recreate";
    if (!newRS) {
      const taken = this.api.get("ReplicaSet", `${d.metadata.name}-${hash}`, ns);
      if (taken && controllerOf(taken.metadata)?.uid !== d.metadata.uid) {
        // 같은 이름의 ReplicaSet 이 아직 남아 있음 (예: 지운 Deployment 의 것을 가비지 컬렉터가 아직 안 지움) → collisionCount 를 올려 다른 해시로
        const count = (d.status.collisionCount ?? 0) + 1;
        this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} 새 ReplicaSet 이름 ${taken.metadata.name} 이(가) 다른 주인의 것으로 남아 있음 → collisionCount ${count} 로 해시를 바꿔 다시`, refOf(d));
        this.api.patch("Deployment", d.metadata.name, ns, this.name, (o) => {
          o.status.collisionCount = count;
        });
        return; // 바뀐 Deployment 의 watch 로 다시 깨어난다
      }
      const initial = recreate ? 0 : this.initialNewReplicas(d, owned);
      newRS = this.createReplicaSet(d, hash, initial, maxRev + 1);
      const firstTime = owned.length === 0;
      this.ctx.trace.add(
        this.name,
        "controller.reconcile",
        firstTime
          ? `${d.metadata.name} 템플릿 해시 ${hash} 의 ReplicaSet 이 없음 → ReplicaSet ${newRS.metadata.name} 생성 (replicas ${initial}, revision ${maxRev + 1})`
          : `${d.metadata.name} 템플릿이 바뀜 (해시 ${hash}) → 새 ReplicaSet ${newRS.metadata.name} 생성 (revision ${maxRev + 1}, 처음 replicas ${initial}) — ${recreate ? "Recreate: 옛 Pod 를 모두 지운 뒤 늘림" : "RollingUpdate 시작"}`,
        refOf(d),
      );
      if (initial > 0) this.api.recordEvent(d, "Normal", "ScalingReplicaSet", `Scaled up replica set ${newRS.metadata.name} from 0 to ${initial}`, this.name);
      this.setProgressing(d, ns, "NewReplicaSetCreated", `Created new replica set "${newRS.metadata.name}"`);
    } else if (revisionOf(newRS) < maxRev) {
      // 옛 템플릿으로 돌아옴 (rollout undo 등) → 그 RS 를 다시 쓰고 리비전을 맨 위로
      const rev = maxRev + 1;
      this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} 템플릿이 옛 ReplicaSet ${newRS.metadata.name} 와 같음 → 그 RS 를 다시 쓰고 revision ${revisionOf(newRS)} → ${rev}`, refOf(d));
      newRS = this.api.patch("ReplicaSet", newRS.metadata.name, ns, this.name, (o) => {
        o.metadata.annotations = { ...(o.metadata.annotations ?? {}), [REVISION]: String(rev) };
      })!;
    }
    const olds = this.ownedRS(d, ns).filter((rs) => rs.metadata.uid !== newRS!.metadata.uid);
    if (recreate) this.recreate(d, ns, newRS, olds);
    else this.rolling(d, ns, newRS, olds);
    this.cleanupHistory(d, ns, hash);
    this.updateStatus(d, ns, hash);
  }

  private ownedRS(d: Deployment, ns: string): ReplicaSet[] {
    return this.api
      .list("ReplicaSet", ns)
      .filter((rs) => controllerOf(rs.metadata)?.uid === d.metadata.uid)
      .sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp || (a.metadata.name < b.metadata.name ? -1 : 1));
  }

  /** 새 RS 의 첫 replicas: 처음 만드는 Deployment 면 replicas 전부, 롤아웃이면 maxSurge 가 허락하는 만큼 */
  private initialNewReplicas(d: Deployment, owned: ReplicaSet[]): number {
    if (!owned.some((rs) => rs.spec.replicas > 0)) return d.spec.replicas;
    const { maxSurge } = this.limits(d);
    const all = owned.reduce((n, rs) => n + rs.spec.replicas, 0);
    return Math.max(0, Math.min(d.spec.replicas + maxSurge - all, d.spec.replicas));
  }

  private limits(d: Deployment): { maxSurge: number; maxUnavailable: number } {
    const ru = d.spec.strategy?.rollingUpdate;
    const maxSurge = resolveIntOrPercent(ru?.maxSurge ?? "25%", d.spec.replicas, true);
    let maxUnavailable = resolveIntOrPercent(ru?.maxUnavailable ?? "25%", d.spec.replicas, false);
    // 둘 다 0 이면 아무것도 못 바꾼다 (실제는 검증 오류) → 하나는 허락
    if (maxSurge === 0 && maxUnavailable === 0) maxUnavailable = 1;
    return { maxSurge, maxUnavailable };
  }

  private rolling(d: Deployment, ns: string, newRS: ReplicaSet, olds: ReplicaSet[]): void {
    const want = d.spec.replicas;
    const { maxSurge, maxUnavailable } = this.limits(d);
    const notes: string[] = [];
    // 1) 새 RS 늘리기 (또는 replicas 가 줄었으면 줄이기)
    let all = newRS.spec.replicas + olds.reduce((n, rs) => n + rs.spec.replicas, 0);
    if (newRS.spec.replicas > want) {
      notes.push(`새 RS ${newRS.metadata.name} ${newRS.spec.replicas}→${want} (replicas 가 줄었음)`);
      newRS = this.scale(d, newRS, want);
    } else if (newRS.spec.replicas < want) {
      const up = Math.min(want + maxSurge - all, want - newRS.spec.replicas);
      if (up > 0) {
        notes.push(`새 RS ${newRS.metadata.name} ${newRS.spec.replicas}→${newRS.spec.replicas + up} (maxSurge ${maxSurge}: 전체 최대 ${want + maxSurge}개)`);
        newRS = this.scale(d, newRS, newRS.spec.replicas + up);
      }
    }
    all = newRS.spec.replicas + olds.reduce((n, rs) => n + rs.spec.replicas, 0);
    // 2) 옛 RS 줄이기: available 이 minAvailable 밑으로 가지 않게
    const minAvailable = want - maxUnavailable;
    const newUnavailable = Math.max(0, newRS.spec.replicas - newRS.status.availableReplicas);
    let budget = all - minAvailable - newUnavailable;
    const live = olds.filter((rs) => rs.spec.replicas > 0);
    if (budget > 0 && live.length) {
      // 먼저 옛 RS 의 아직 안 뜬(unavailable) Pod 부터 — 지워도 available 이 줄지 않는다
      for (const rs of live) {
        const unhealthy = Math.max(0, rs.spec.replicas - rs.status.availableReplicas);
        const cut = Math.min(unhealthy, budget, rs.spec.replicas);
        if (cut <= 0) continue;
        notes.push(`옛 RS ${rs.metadata.name} ${rs.spec.replicas}→${rs.spec.replicas - cut} (준비 안 된 Pod 먼저)`);
        Object.assign(rs, this.scale(d, rs, rs.spec.replicas - cut));
        budget -= cut;
      }
      const available = newRS.status.availableReplicas + olds.reduce((n, rs) => n + rs.status.availableReplicas, 0);
      let canCut = Math.min(budget, available - minAvailable);
      for (const rs of live) {
        if (canCut <= 0) break;
        const cut = Math.min(rs.spec.replicas, canCut);
        if (cut <= 0) continue;
        notes.push(`옛 RS ${rs.metadata.name} ${rs.spec.replicas}→${rs.spec.replicas - cut} (maxUnavailable ${maxUnavailable}: available 최소 ${minAvailable} 유지)`);
        this.scale(d, rs, rs.spec.replicas - cut);
        canCut -= cut;
      }
    }
    if (notes.length) this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} ${live.length ? "롤링 업데이트" : "맞추기"}: ${notes.join(" · ")}`, refOf(d));
  }

  private recreate(d: Deployment, ns: string, newRS: ReplicaSet, olds: ReplicaSet[]): void {
    const notes: string[] = [];
    for (const rs of olds) {
      if (rs.spec.replicas === 0) continue;
      notes.push(`옛 RS ${rs.metadata.name} ${rs.spec.replicas}→0`);
      this.scale(d, rs, 0);
    }
    const oldUids = new Set(olds.map((rs) => rs.metadata.uid));
    const oldPods = this.api.peekList("Pod", ns).filter((p) => {
      const ref = controllerOf(p.metadata);
      return !!ref && oldUids.has(ref.uid);
    }).length;
    if (oldPods > 0) {
      if (newRS.spec.replicas !== 0) {
        notes.push(`새 RS ${newRS.metadata.name} ${newRS.spec.replicas}→0`);
        this.scale(d, newRS, 0);
      }
      if (notes.length) this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} Recreate: ${notes.join(" · ")} — 옛 Pod ${oldPods}개가 다 사라질 때까지 새 Pod 를 만들지 않음`, refOf(d));
      return;
    }
    if (newRS.spec.replicas !== d.spec.replicas) {
      notes.push(`새 RS ${newRS.metadata.name} ${newRS.spec.replicas}→${d.spec.replicas}`);
      this.scale(d, newRS, d.spec.replicas);
    }
    if (notes.length) this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} ${olds.length ? "Recreate: 옛 Pod 가 모두 사라짐 → " : ""}${notes.join(" · ")}`, refOf(d));
  }

  /** revisionHistoryLimit 을 넘는 옛 RS (Pod 0개) 지우기 */
  private cleanupHistory(d: Deployment, ns: string, hash: string): void {
    const limit = d.spec.revisionHistoryLimit ?? 10;
    const idle = this.ownedRS(d, ns)
      .filter((rs) => rs.metadata.labels[HASH_LABEL] !== hash && rs.spec.replicas === 0 && rs.status.replicas === 0)
      .sort((a, b) => revisionOf(a) - revisionOf(b));
    for (const rs of idle.slice(0, Math.max(0, idle.length - limit))) {
      this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} 옛 ReplicaSet 이 revisionHistoryLimit ${limit} 을 넘음 → ${rs.metadata.name} (revision ${revisionOf(rs)}) 삭제`, refOf(rs));
      this.api.delete("ReplicaSet", rs.metadata.name, ns, this.name);
    }
  }

  private createReplicaSet(d: Deployment, hash: string, replicas: number, revision: number): ReplicaSet {
    const labels = { ...d.spec.template.metadata.labels, [HASH_LABEL]: hash };
    const tmplAnn = d.spec.template.metadata.annotations;
    return this.api.create<"ReplicaSet">(
      {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: `${d.metadata.name}-${hash}`,
          namespace: d.metadata.namespace,
          labels,
          annotations: { [REVISION]: String(revision) },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: d.metadata.name, uid: d.metadata.uid, controller: true }],
        },
        spec: {
          replicas,
          selector: { matchLabels: { ...d.spec.selector.matchLabels, [HASH_LABEL]: hash } },
          template: { metadata: { labels, ...(tmplAnn ? { annotations: { ...tmplAnn } } : {}) }, spec: structuredClone(d.spec.template.spec) },
        },
      },
      this.name,
    );
  }

  private scale(d: Deployment, rs: ReplicaSet, replicas: number): ReplicaSet {
    const from = rs.spec.replicas;
    const out = this.api.patch("ReplicaSet", rs.metadata.name, rs.metadata.namespace, this.name, (o) => {
      o.spec.replicas = replicas;
    })!;
    if (from !== replicas) this.api.recordEvent(d, "Normal", "ScalingReplicaSet", `Scaled ${replicas > from ? "up" : "down"} replica set ${rs.metadata.name} from ${from} to ${replicas}`, this.name);
    return out;
  }

  private setProgressing(d: Deployment, ns: string, reason: string, message: string): void {
    const now = this.now;
    this.api.patch("Deployment", d.metadata.name, ns, this.name, (o) => {
      setDeployCondition(o, "Progressing", "True", reason, message, now);
    });
  }

  private updateStatus(d: Deployment, ns: string, hash: string): void {
    const now = this.now;
    const key = nsKey(ns, d.metadata.name);
    const after = this.api.patch("Deployment", d.metadata.name, ns, this.name, (cur) => {
      const owned = this.api.list("ReplicaSet", ns).filter((rs) => controllerOf(rs.metadata)?.uid === cur.metadata.uid);
      const newRS = owned.find((rs) => rs.metadata.labels[HASH_LABEL] === hash);
      const sum = (f: (rs: ReplicaSet) => number) => owned.reduce((n, rs) => n + f(rs), 0);
      const prev = cur.status;
      const next = {
        replicas: sum((rs) => rs.status.replicas),
        updatedReplicas: newRS?.status.replicas ?? 0,
        readyReplicas: sum((rs) => rs.status.readyReplicas),
        availableReplicas: sum((rs) => rs.status.availableReplicas),
        unavailableReplicas: Math.max(0, cur.spec.replicas - sum((rs) => rs.status.availableReplicas)),
        observedGeneration: cur.metadata.generation,
        collisionCount: cur.status.collisionCount,
        conditions: [...(prev.conditions ?? [])],
      };
      const progressed =
        next.replicas !== prev.replicas || next.updatedReplicas !== prev.updatedReplicas || next.readyReplicas !== prev.readyReplicas || next.availableReplicas !== prev.availableReplicas;
      cur.status = next;
      if (newRS) cur.metadata.annotations = { ...(cur.metadata.annotations ?? {}), [REVISION]: newRS.metadata.annotations?.[REVISION] ?? "1" };
      const { maxUnavailable } = this.limits(cur);
      const minOk = next.availableReplicas >= cur.spec.replicas - (cur.spec.strategy?.type === "Recreate" ? 0 : maxUnavailable);
      setDeployCondition(cur, "Available", minOk ? "True" : "False", minOk ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable", minOk ? "Deployment has minimum availability." : "Deployment does not have minimum availability.", now);
      const rsName = newRS?.metadata.name ?? "";
      const prog = cur.status.conditions?.find((c) => c.type === "Progressing");
      if (rolloutComplete(cur)) setDeployCondition(cur, "Progressing", "True", "NewReplicaSetAvailable", `ReplicaSet "${rsName}" has successfully progressed.`, now, progressed || prog?.reason !== "NewReplicaSetAvailable");
      else if (progressed) setDeployCondition(cur, "Progressing", "True", "ReplicaSetUpdated", `ReplicaSet "${rsName}" is progressing.`, now, true);
      else if (prog && prog.reason !== "ProgressDeadlineExceeded" && now - (prog.lastUpdateTime ?? prog.lastTransitionTime) >= (cur.spec.progressDeadlineSeconds ?? 600) * 1000) {
        setDeployCondition(cur, "Progressing", "False", "ProgressDeadlineExceeded", `ReplicaSet "${rsName}" has timed out progressing.`, now);
        this.ctx.trace.add(this.name, "controller.reconcile", `${cur.metadata.name} 롤아웃이 ${cur.spec.progressDeadlineSeconds ?? 600}초 동안 진전 없음 → Progressing=False (ProgressDeadlineExceeded). 알릴 뿐 되돌리지는 않음 — rollout undo 는 사람 몫`, refOf(cur));
      }
    });
    // 진전 마감 확인: 롤아웃이 안 끝났으면 마지막 진전 + 마감 시각에 다시 본다 (일반 타이머 — 끝나거나 마감이 지나면 멈춘다)
    this.deadlines.get(key)?.cancel();
    this.deadlines.delete(key);
    if (!after || rolloutComplete(after)) return;
    const prog = after.status.conditions?.find((c) => c.type === "Progressing");
    if (!prog || prog.reason === "ProgressDeadlineExceeded") return;
    const due = (prog.lastUpdateTime ?? prog.lastTransitionTime) + (after.spec.progressDeadlineSeconds ?? 600) * 1000;
    this.deadlines.set(key, this.ctx.clock.after(Math.max(0, due - now), this.name, () => this.enqueue(key)));
  }
}

function setDeployCondition(d: Deployment, type: string, status: "True" | "False", reason: string, message: string, now: number, touched = false): void {
  const conds = (d.status.conditions ??= []);
  const cur = conds.find((c) => c.type === type);
  if (!cur) {
    conds.push({ type, status, reason, message, lastTransitionTime: now, lastUpdateTime: now });
    return;
  }
  if (cur.status !== status) cur.lastTransitionTime = now;
  if (cur.status !== status || cur.reason !== reason || touched) cur.lastUpdateTime = now;
  cur.status = status;
  cur.reason = reason;
  cur.message = message;
}

