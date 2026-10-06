// kubectl 흉내: 문자열 명령 → API 호출 + 실제와 같은 모양의 출력. 코어 API 위의 얇은 층이다.
// 축소판: default 네임스페이스만, 자주 쓰는 하위 명령·플래그만.
import { ApiError } from "./api/server";
import { CLUSTER_SCOPED, controllerOf, isNodeReady, NODE_LEASE_NS, podRequests, qosClass, SERVICE_NAME_LABEL, type Deployment, type IngressPath, type KEvent, type Kind, type Node, type Pod, type ServiceType, type NetworkPolicy, type NetworkPolicyPeer, type NetworkPolicyPort, type HorizontalPodAutoscaler } from "./api/types";
import { configMap, deployment, hpa as hpaManifest, ingress, pdb, secret, service, type Cluster } from "./cluster";
import { selectorText } from "./net/netpol";
import { pvNode } from "./storage";
import type { DrainJob } from "./drain";
import type { NetResult } from "./net/request";
import { deploymentHash, HASH_LABEL, revisionOf } from "./controllers/deployment";
import { nodeUsage } from "./scheduler";
import { fmtAge, fmtClock, fmtCpu, fmtMem, parseCpu, parseMem } from "./units";
import { b64bytes, isBase64 } from "./base64";
import { CONFIG_KEY_RE } from "./api/server";
import { toYaml } from "./yaml";

export interface KubectlResult {
  ok: boolean;
  output: string;
  /** 클러스터를 바꾸는 명령이었는지 (UI 가 다시 그린다) */
  mutated: boolean;
  /** kubectl exec 로 보낸 요청의 단계 (화면에서 경로를 그린다) */
  net?: NetResult;
  /** kubectl drain: 시간이 지나며 출력 줄이 늘어난다 */
  drain?: DrainJob;
}

export const KUBE_VERSION = "v1.31.0";

type Res = Kind | "Event" | "Endpoints" | "all";

const RESOURCE_ALIASES: Record<string, Res> = {
  hpa: "HorizontalPodAutoscaler",
  horizontalpodautoscaler: "HorizontalPodAutoscaler",
  horizontalpodautoscalers: "HorizontalPodAutoscaler",
  sts: "StatefulSet",
  statefulset: "StatefulSet",
  statefulsets: "StatefulSet",
  pvc: "PersistentVolumeClaim",
  persistentvolumeclaim: "PersistentVolumeClaim",
  persistentvolumeclaims: "PersistentVolumeClaim",
  pv: "PersistentVolume",
  persistentvolume: "PersistentVolume",
  persistentvolumes: "PersistentVolume",
  sc: "StorageClass",
  storageclass: "StorageClass",
  storageclasses: "StorageClass",
  netpol: "NetworkPolicy",
  networkpolicy: "NetworkPolicy",
  networkpolicies: "NetworkPolicy",
  cm: "ConfigMap",
  configmap: "ConfigMap",
  configmaps: "ConfigMap",
  secret: "Secret",
  secrets: "Secret",
  svc: "Service",
  service: "Service",
  services: "Service",
  ep: "Endpoints",
  endpoints: "Endpoints",
  app: "Application",
  application: "Application",
  applications: "Application",
  ing: "Ingress",
  ingress: "Ingress",
  ingresses: "Ingress",
  pdb: "PodDisruptionBudget",
  poddisruptionbudget: "PodDisruptionBudget",
  poddisruptionbudgets: "PodDisruptionBudget",
  endpointslice: "EndpointSlice",
  endpointslices: "EndpointSlice",
  po: "Pod",
  pod: "Pod",
  pods: "Pod",
  deploy: "Deployment",
  deployment: "Deployment",
  deployments: "Deployment",
  rs: "ReplicaSet",
  replicaset: "ReplicaSet",
  replicasets: "ReplicaSet",
  no: "Node",
  node: "Node",
  nodes: "Node",
  lease: "Lease",
  leases: "Lease",
  ev: "Event",
  event: "Event",
  events: "Event",
  all: "all",
};

const KIND_PREFIX: Record<Kind, string> = {
  Pod: "pod",
  Deployment: "deployment.apps",
  ReplicaSet: "replicaset.apps",
  Node: "node",
  Lease: "lease.coordination.k8s.io",
  Service: "service",
  EndpointSlice: "endpointslice.discovery.k8s.io",
  PodDisruptionBudget: "poddisruptionbudget.policy",
  Ingress: "ingress.networking.k8s.io",
  Application: "application.argoproj.io",
  ConfigMap: "configmap",
  Secret: "secret",
  NetworkPolicy: "networkpolicy.networking.k8s.io",
  StatefulSet: "statefulset.apps",
  HorizontalPodAutoscaler: "horizontalpodautoscaler.autoscaling",
  PersistentVolumeClaim: "persistentvolumeclaim",
  PersistentVolume: "persistentvolume",
  StorageClass: "storageclass.storage.k8s.io",
};
const KIND_PLURAL: Record<Kind, string> = {
  Pod: "pods",
  Deployment: "deployments.apps",
  ReplicaSet: "replicasets.apps",
  Node: "nodes",
  Lease: "leases.coordination.k8s.io",
  Service: "services",
  EndpointSlice: "endpointslices.discovery.k8s.io",
  PodDisruptionBudget: "poddisruptionbudgets.policy",
  Ingress: "ingresses.networking.k8s.io",
  Application: "applications.argoproj.io",
  ConfigMap: "configmaps",
  Secret: "secrets",
  NetworkPolicy: "networkpolicies.networking.k8s.io",
  StatefulSet: "statefulsets.apps",
  HorizontalPodAutoscaler: "horizontalpodautoscalers.autoscaling",
  PersistentVolumeClaim: "persistentvolumeclaims",
  PersistentVolume: "persistentvolumes",
  StorageClass: "storageclasses.storage.k8s.io",
};

export const KUBECTL_HELP = [
  "쓸 수 있는 명령 (축소판 — default 네임스페이스):",
  "  kubectl get pods [-o wide] | deploy | rs | svc | endpoints | endpointslices | nodes [-o wide] | events | all",
  "  kubectl describe pod|deploy|rs|svc|node <이름>",
  "  kubectl expose deployment <이름> --port=80 [--target-port=8080] [--type=NodePort]",
  "  kubectl exec <pod> -- curl http://<service>[:포트] | ping <주소> | nslookup <이름>",
  "  kubectl create deployment <이름> --image=<이미지> [--replicas=N]",
  "  kubectl scale deployment/<이름> --replicas=N",
  "  kubectl set image deployment/<이름> <컨테이너>=<이미지>",
  "  kubectl rollout status|history|undo|restart deployment/<이름>   (undo 는 --to-revision=N)",
  "  kubectl set resources deployment/<이름> --requests=cpu=500m,memory=256Mi [--limits=cpu=1,memory=512Mi]",
  "  kubectl top pods | nodes   (metrics-server — 실사용)",
  "  kubectl delete pod|deploy|rs|svc <이름>   (pod 는 --force --grace-period=0 로 강제)",
  "  kubectl cordon|uncordon <노드>",
  "  kubectl drain <노드> [--ignore-daemonsets]   (PodDisruptionBudget 을 지키며 내보냄)",
  "  kubectl create pdb <이름> --selector=app=web --min-available=2 | --max-unavailable=1",
  "  kubectl get pdb",
  "  kubectl get ingress · describe ingress <이름>",
  "  kubectl create ingress <이름> --class=nginx --rule=\"shop.example.com/*=web:80\"",
  "  kubectl patch svc <이름> -p '{\"spec\":{\"externalTrafficPolicy\":\"Local\"}}'   (type·externalTrafficPolicy 만)",
  "  curl http://<호스트·LoadBalancer IP·노드IP:NodePort>   (kubectl 없이 — 클러스터 밖에서 보냄)",
  "  kubectl get leases -n kube-node-lease   (kubelet heartbeat)",
  "  kubectl get <종류> <이름> -o yaml",
  "  kubectl autoscale deployment <이름> --cpu-percent=50 --min=1 --max=10 · get hpa · describe hpa <이름>",
  "  kubectl get sts · pvc · pv · sc · describe sts|pvc|pv <이름> · scale sts/<이름> --replicas=N · rollout status|restart sts/<이름> · delete pvc <이름>",
  "  kubectl get networkpolicy · describe networkpolicy <이름> · delete networkpolicy <이름>   (만들기는 화면·예제에서)",
  "  kubectl create configmap <이름> --from-literal=KEY=값 …  ·  kubectl create secret generic <이름> --from-literal=KEY=값 …",
  "  kubectl patch configmap <이름> -p '{\"data\":{\"KEY\":\"새 값\"}}'   (secret 은 stringData 로 평문을, data 로 base64 를)",
  "  kubectl exec <pod> -- env | cat <파일> | ls <디렉터리>   (컨테이너가 본 설정)",
  "  echo <base64> | base64 -d",
].join("\n");

export function runKubectl(cluster: Cluster, line: string): KubectlResult {
  const all = tokenize(line.trim());
  if (all[0] === "kubectl" || all[0] === "k") all.shift();
  if (!all.length) return fail("kubectl 다음에 명령을 쓰세요. 예: kubectl get pods\n\n" + KUBECTL_HELP);
  // `--` 뒤는 컨테이너 안에서 실행할 명령 (kubectl exec) — 플래그로 읽지 않는다
  const dd = all.indexOf("--");
  const args = dd >= 0 ? all.slice(0, dd) : all;
  const inner = dd >= 0 ? all.slice(dd + 1) : [];
  const { pos, flags } = parseFlags(args);
  const cmd = pos.shift()!;
  const ns = flags.get("n");
  const leaseNs = ns === NODE_LEASE_NS && cmd === "get" && /^leases?$/.test(pos[0] ?? "");
  const appNs = ns === "argocd" && cmd === "get" && /^(app|applications?)$/.test(pos[0] ?? "");
  if (ns !== undefined && ns !== "default" && !leaseNs && !appNs) {
    // 축소판: 네임스페이스는 default 하나. 다른 이름은 조용히 무시하지 않고 비어 있다고 답한다 (노드는 클러스터 범위라 그대로)
    if (cmd === "get" && !/^(no|node|nodes)$/.test(pos[0] ?? "")) return ok(`No resources found in ${ns} namespace.`);
    if (cmd !== "get") return fail(`error: 이 시뮬레이터에는 default 네임스페이스만 있습니다 (축소판). -n ${ns} 를 빼고 다시 하세요`);
  }
  try {
    switch (cmd) {
      case "get":
        return ok(get(cluster, pos, flags));
      case "describe":
        return ok(describe(cluster, pos));
      case "top":
        return ok(top(cluster, pos));
      case "create":
        return create(cluster, pos, flags, line, args);
      case "scale":
        return scale(cluster, pos, flags, line);
      case "set":
        return setCmd(cluster, pos, flags, line);
      case "delete":
        return del(cluster, pos, flags, line);
      case "cordon":
      case "uncordon":
        return cordon(cluster, cmd, pos, line);
      case "patch":
        return patchCmd(cluster, pos, flags, line);
      case "drain":
        return drainCmd(cluster, pos, line);
      case "rollout":
        return rollout(cluster, pos, flags, line);
      case "autoscale":
        return autoscale(cluster, pos, flags, line);
      case "expose":
        return expose(cluster, pos, flags, line);
      case "exec":
        return exec(cluster, pos, inner);
      case "help":
      case "--help":
      case "-h":
        return ok(KUBECTL_HELP);
      default:
        return fail(`error: unknown command "${cmd}" for "kubectl"\n\n${KUBECTL_HELP}`);
    }
  } catch (e) {
    if (e instanceof KubectlError) return fail(e.message);
    if (e instanceof ApiError) return fail(`Error from server (${e.reason}): ${e.message}`);
    throw e;
  }
}

class KubectlError extends Error {}

function ok(output: string, mutated = false): KubectlResult {
  return { ok: true, output, mutated };
}

function fail(output: string): KubectlResult {
  return { ok: false, output, mutated: false };
}

/**
 * 셸처럼 나눈다: 공백으로 자르되 따옴표 안은 한 덩어리, 따옴표는 어디에 있든 벗긴다 (--from-literal=KEY='hello world').
 * 작은따옴표 안은 그대로, 큰따옴표 안은 \" 와 \\ 만 풀고, 따옴표 밖의 \ 는 다음 글자를 그대로.
 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;
      cur += s.slice(i + 1, stop);
      i = stop;
      has = true;
    } else if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) i++;
        cur += s[i];
        i++;
      }
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function parseFlags(args: string[]): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "-n" || a === "-p" || a === "-l") {
      flags.set(a.slice(1), args[++i] ?? "");
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (["replicas", "image", "requests", "limits", "min", "max", "cpu-percent", "grace-period", "port", "target-port", "type", "name", "to-revision", "selector", "min-available", "max-unavailable"].includes(a.slice(2)) && args[i + 1] && !args[i + 1]!.startsWith("-")) flags.set(a.slice(2), args[++i]!);
      else flags.set(a.slice(2), "true");
    } else if (a.startsWith("-o")) flags.set("o", a.slice(2));
    else pos.push(a);
  }
  return { pos, flags };
}

/** "deployment/web" 또는 "deployment web" → [Kind, 이름들] */
function resourceArgs(pos: string[]): { kind: Res; names: string[] } {
  const first = pos[0];
  if (!first) throw new KubectlError("error: You must specify the type of resource to get. 예: kubectl get pods");
  if (first.includes("/")) {
    const [r, n] = first.split("/");
    return { kind: resolveKind(r!), names: [n!, ...pos.slice(1)] };
  }
  return { kind: resolveKind(first), names: pos.slice(1) };
}

function resolveKind(r: string): Res {
  const k = RESOURCE_ALIASES[r.toLowerCase()];
  if (!k) throw new KubectlError(`error: the server doesn't have a resource type "${r}"`);
  return k;
}

function needWorkload(kind: Res, allowed: Kind[], verb: string): Kind {
  if (kind === "Event" || kind === "all" || kind === "Endpoints" || !allowed.includes(kind)) throw new KubectlError(`error: ${verb} 는 ${allowed.map((k) => KIND_PLURAL[k]).join("·")} 에만 쓸 수 있습니다 (축소판)`);
  return kind;
}

// ---------- get ----------

/** get 의 -l / --selector (k=v,k!=v,k — 같음·다름·있음) — pick 이 목록을 거른다 */
let labelSelector: ((labels: Record<string, string>) => boolean) | undefined;

function parseLabelSelector(s: string): (labels: Record<string, string>) => boolean {
  const reqs = s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([\w./-]+)\s*(!=|==|=)?\s*([\w./-]*)$/.exec(x);
    if (!m) throw new KubectlError(`error: unable to parse requirement: "${x}" (예: -l app=web)`);
    return { key: m[1]!, op: m[2], value: m[3] ?? "" };
  });
  return (labels) => reqs.every((r) => (r.op === "!=" ? labels[r.key] !== r.value : r.op ? labels[r.key] === r.value : r.key in labels));
}

function get(c: Cluster, pos: string[], flags: Map<string, string>): string {
  const sel = flags.get("l") ?? flags.get("selector");
  labelSelector = sel !== undefined ? parseLabelSelector(sel) : undefined;
  try {
    return getInner(c, pos, flags);
  } finally {
    labelSelector = undefined;
  }
}

function getInner(c: Cluster, pos: string[], flags: Map<string, string>): string {
  const { kind, names } = resourceArgs(pos);
  const wide = flags.get("o") === "wide";
  if (flags.get("o") === "yaml") return getYaml(c, kind, names);
  if (flags.has("o") && !wide) throw new KubectlError(`error: 출력 형식 "${flags.get("o")}" 는 아직 없습니다 (wide · yaml 만)`);
  if (kind === "all") {
    const stss = pick(c, "StatefulSet", c.api.list("StatefulSet", "default"), []);
    const stsTable = stss.length ? table(["NAME", "READY", "AGE"], stss.map((s) => [`statefulset.apps/${s.metadata.name}`, `${s.status.readyReplicas}/${s.spec.replicas}`, fmtAge(c.now - s.metadata.creationTimestamp)])) : "";
    const hs = pick(c, "HorizontalPodAutoscaler", c.api.list("HorizontalPodAutoscaler", "default"), []);
    const hpaTable = hs.length
      ? table(
          ["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"],
          hs.map((h) => [`horizontalpodautoscaler.autoscaling/${h.metadata.name}`, `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, hpaTargets(h), String(h.spec.minReplicas ?? 1), String(h.spec.maxReplicas), String(h.status.currentReplicas), fmtAge(c.now - h.metadata.creationTimestamp)]),
        )
      : "";
    const parts = [getPods(c, [], false, true), getServices(c, [], true), getDeploys(c, [], true), getRs(c, [], true), stsTable, hpaTable].filter(Boolean);
    return parts.join("\n\n") || "No resources found in default namespace.";
  }
  switch (kind) {
    case "Pod":
      return getPods(c, names, wide, false) || "No resources found in default namespace.";
    case "Deployment":
      return getDeploys(c, names, false) || "No resources found in default namespace.";
    case "ReplicaSet":
      return getRs(c, names, false) || "No resources found in default namespace.";
    case "Node":
      return getNodes(c, names, wide) || "No resources found";
    case "Event":
      return getEvents(c) || "No resources found in default namespace.";
    case "Service":
      return getServices(c, names, false) || "No resources found in default namespace.";
    case "Endpoints":
      return getEndpoints(c, names) || "No resources found in default namespace.";
    case "EndpointSlice":
      return getSlices(c, names) || "No resources found in default namespace.";
    case "PodDisruptionBudget":
      return getPdbs(c, names) || "No resources found in default namespace.";
    case "Ingress":
      return getIngresses(c, names) || "No resources found in default namespace.";
    case "Application": {
      if (flags.get("n") !== "argocd") return "No resources found in default namespace. (Argo CD Application 은 -n argocd)";
      const apps = pick(c, "Application", c.api.list("Application", "argocd"), names);
      if (!apps.length) return "No resources found in argocd namespace.";
      return table(["NAME", "SYNC STATUS", "HEALTH STATUS"], apps.map((a) => [a.metadata.name, a.status.sync.status, a.status.health.status]));
    }
    case "Lease":
      if (flags.get("n") !== NODE_LEASE_NS) return "No resources found in default namespace. (노드 Lease 는 -n kube-node-lease)";
      return getLeases(c, names) || `No resources found in ${NODE_LEASE_NS} namespace.`;
    case "ConfigMap": {
      const cms = pick(c, "ConfigMap", c.api.list("ConfigMap", "default"), names);
      return cms.length ? table(["NAME", "DATA", "AGE"], cms.map((m) => [m.metadata.name, String(Object.keys(m.data).length), fmtAge(c.now - m.metadata.creationTimestamp)])) : "No resources found in default namespace.";
    }
    case "HorizontalPodAutoscaler": {
      const hs = pick(c, "HorizontalPodAutoscaler", c.api.list("HorizontalPodAutoscaler", "default"), names);
      return hs.length
        ? table(
            ["NAME", "REFERENCE", "TARGETS", "MINPODS", "MAXPODS", "REPLICAS", "AGE"],
            hs.map((h) => [h.metadata.name, `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, hpaTargets(h), String(h.spec.minReplicas ?? 1), String(h.spec.maxReplicas), String(h.status.currentReplicas), fmtAge(c.now - h.metadata.creationTimestamp)]),
          )
        : "No resources found in default namespace.";
    }
    case "StatefulSet": {
      const ss = pick(c, "StatefulSet", c.api.list("StatefulSet", "default"), names);
      return ss.length ? table(["NAME", "READY", "AGE"], ss.map((s) => [s.metadata.name, `${s.status.readyReplicas}/${s.spec.replicas}`, fmtAge(c.now - s.metadata.creationTimestamp)])) : "No resources found in default namespace.";
    }
    case "PersistentVolumeClaim": {
      const ps = pick(c, "PersistentVolumeClaim", c.api.list("PersistentVolumeClaim", "default"), names);
      return ps.length
        ? table(
            ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE"],
            ps.map((p) => [p.metadata.name, p.status.phase, p.spec.volumeName ?? "", p.status.capacity ? fmtMem(p.status.capacity.storage) : "", p.status.phase === "Bound" ? accessModes(p.spec.accessModes) : "", p.spec.storageClassName ?? "", "<unset>", fmtAge(c.now - p.metadata.creationTimestamp)]),
          )
        : "No resources found in default namespace.";
    }
    case "PersistentVolume": {
      const ps = pick(c, "PersistentVolume", c.api.list("PersistentVolume"), names);
      return ps.length
        ? table(
            ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "REASON", "AGE"],
            ps.map((p) => [p.metadata.name, fmtMem(p.spec.capacity.storage), accessModes(p.spec.accessModes), p.spec.persistentVolumeReclaimPolicy, p.metadata.deletionTimestamp !== undefined ? "Terminating" : p.status.phase, p.spec.claimRef ? `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}` : "", p.spec.storageClassName, "<unset>", "", fmtAge(c.now - p.metadata.creationTimestamp)]),
          )
        : "No resources found";
    }
    case "StorageClass": {
      const ss = pick(c, "StorageClass", c.api.list("StorageClass"), names);
      return ss.length
        ? table(
            ["NAME", "PROVISIONER", "RECLAIMPOLICY", "VOLUMEBINDINGMODE", "ALLOWVOLUMEEXPANSION", "AGE"],
            ss.map((s) => [`${s.metadata.name}${s.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? " (default)" : ""}`, s.provisioner, s.reclaimPolicy, s.volumeBindingMode, "false", fmtAge(c.now - s.metadata.creationTimestamp)]),
          )
        : "No resources found";
    }
    case "NetworkPolicy": {
      const nps = pick(c, "NetworkPolicy", c.api.list("NetworkPolicy", "default"), names);
      return nps.length ? table(["NAME", "POD-SELECTOR", "AGE"], nps.map((n) => [n.metadata.name, selectorText(n.spec.podSelector), fmtAge(c.now - n.metadata.creationTimestamp)])) : "No resources found in default namespace.";
    }
    case "Secret": {
      const ss = pick(c, "Secret", c.api.list("Secret", "default"), names);
      return ss.length ? table(["NAME", "TYPE", "DATA", "AGE"], ss.map((m) => [m.metadata.name, m.type, String(Object.keys(m.data).length), fmtAge(c.now - m.metadata.creationTimestamp)])) : "No resources found in default namespace.";
    }
  }
}

/** kubectl get <종류> <이름> -o yaml — 저장된 그대로 (Secret 의 data 는 base64) */
function getYaml(c: Cluster, kind: Res, names: string[]): string {
  if (kind === "Event" || kind === "Endpoints" || kind === "all") throw new KubectlError(`error: -o yaml 은 오브젝트 하나에만 됩니다. 예: kubectl get configmap app-config -o yaml`);
  if (!names.length) throw new KubectlError(`error: 이름을 함께 쓰세요. 예: kubectl get ${kind.toLowerCase()} <이름> -o yaml`);
  const ns = kind === "Application" ? "argocd" : kind === "Lease" ? NODE_LEASE_NS : "default";
  return names
    .map((n) => {
      const o = c.api.get(kind, n, ns);
      if (!o) throw new ApiError("NotFound", `${KIND_PLURAL[kind]} "${n}" not found`);
      return toYaml(o);
    })
    .join("\n---\n");
}

function pick<T extends { metadata: { name: string; labels?: Record<string, string> } }>(c: Cluster, kind: Kind, items: T[], names: string[]): T[] {
  if (labelSelector) {
    const sel = labelSelector;
    items = items.filter((o) => sel(o.metadata.labels ?? {}));
  }
  if (!names.length) return items;
  return names.map((n) => {
    const found = items.find((o) => o.metadata.name === n);
    if (!found) throw new ApiError("NotFound", `${KIND_PLURAL[kind]} "${n}" not found`);
    return found;
  });
}

function getPods(c: Cluster, names: string[], wide: boolean, prefixed: boolean): string {
  const pods = pick(c, "Pod", c.api.list("Pod", "default"), names);
  if (!pods.length) return "";
  const head = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
  if (wide) head.push("IP", "NODE", "NOMINATED NODE", "READINESS GATES");
  const rows = pods.map((p) => {
    const row = [`${prefixed ? "pod/" : ""}${p.metadata.name}`, podReadyText(p), podStatusText(p), podRestartsText(p, c.now), fmtAge(c.now - p.metadata.creationTimestamp)];
    if (wide) row.push(p.status.podIP ?? "<none>", p.spec.nodeName ?? "<none>", "<none>", "<none>");
    return row;
  });
  return table(head, rows);
}

function getDeploys(c: Cluster, names: string[], prefixed: boolean): string {
  const ds = pick(c, "Deployment", c.api.list("Deployment", "default"), names);
  if (!ds.length) return "";
  return table(
    ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"],
    ds.map((d) => [
      `${prefixed ? "deployment.apps/" : ""}${d.metadata.name}`,
      `${d.status.readyReplicas}/${d.spec.replicas}`,
      String(d.status.updatedReplicas),
      String(d.status.availableReplicas),
      fmtAge(c.now - d.metadata.creationTimestamp),
    ]),
  );
}

function getRs(c: Cluster, names: string[], prefixed: boolean): string {
  const rss = pick(c, "ReplicaSet", c.api.list("ReplicaSet", "default"), names);
  if (!rss.length) return "";
  return table(
    ["NAME", "DESIRED", "CURRENT", "READY", "AGE"],
    rss.map((r) => [`${prefixed ? "replicaset.apps/" : ""}${r.metadata.name}`, String(r.spec.replicas), String(r.status.replicas), String(r.status.readyReplicas), fmtAge(c.now - r.metadata.creationTimestamp)]),
  );
}

function getNodes(c: Cluster, names: string[], wide: boolean): string {
  const nodes = pick(c, "Node", c.api.list("Node"), names);
  if (!nodes.length) return "";
  const head = ["NAME", "STATUS", "ROLES", "AGE", "VERSION"];
  if (wide) head.push("INTERNAL-IP", "POD-CIDR");
  return table(
    head,
    nodes.map((n) => {
      const row = [n.metadata.name, nodeStatusText(n), "<none>", fmtAge(c.now - n.metadata.creationTimestamp), KUBE_VERSION];
      if (wide) row.push(n.status.addresses.find((a) => a.type === "InternalIP")?.address ?? "<none>", n.spec.podCIDR);
      return row;
    }),
  );
}

function getServices(c: Cluster, names: string[], prefixed: boolean): string {
  const ss = pick(c, "Service", c.api.list("Service", "default"), names);
  if (!ss.length) return "";
  return table(
    ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"],
    ss.map((s) => [
      `${prefixed ? "service/" : ""}${s.metadata.name}`,
      s.spec.type,
      s.spec.clusterIP ?? "<none>",
      s.spec.type === "LoadBalancer" ? (s.status.loadBalancer?.ingress?.[0]?.ip ?? "<pending>") : "<none>",
      s.spec.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`).join(","),
      fmtAge(c.now - s.metadata.creationTimestamp),
    ]),
  );
}

/** 주소 목록을 kubectl 처럼 3개까지 + N more... */
function fewAddrs(addrs: string[]): string {
  if (!addrs.length) return "<none>";
  return addrs.length > 3 ? `${addrs.slice(0, 3).join(",")} + ${addrs.length - 3} more...` : addrs.join(",");
}

function slicesOf(c: Cluster, svc: string) {
  return c.api.list("EndpointSlice", "default").filter((s) => s.metadata.labels[SERVICE_NAME_LABEL] === svc);
}

/** Endpoints(옛 API)는 EndpointSlice 에서 ready 인 것만 모아 보여 준다 (축소판: 따로 저장하지 않음) */
function getEndpoints(c: Cluster, names: string[]): string {
  const ss = pick(c, "Service", c.api.list("Service", "default"), names);
  if (!ss.length) return "";
  return table(
    ["NAME", "ENDPOINTS", "AGE"],
    ss.map((s) => [s.metadata.name, fewAddrs(readyAddrs(c, s.metadata.name)), fmtAge(c.now - s.metadata.creationTimestamp)]),
  );
}

function readyAddrs(c: Cluster, svc: string): string[] {
  return slicesOf(c, svc).flatMap((sl) => sl.endpoints.filter((e) => e.conditions.ready).flatMap((e) => sl.ports.map((p) => `${e.addresses[0]}:${p.port}`)));
}

function getSlices(c: Cluster, names: string[]): string {
  const ss = pick(c, "EndpointSlice", c.api.list("EndpointSlice", "default"), names);
  if (!ss.length) return "";
  return table(
    ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"],
    ss.map((s) => [s.metadata.name, s.addressType, s.ports.map((p) => p.port).join(",") || "<unset>", fewAddrs(s.endpoints.map((e) => e.addresses[0]!)), fmtAge(c.now - s.metadata.creationTimestamp)]),
  );
}

function getIngresses(c: Cluster, names: string[]): string {
  const is = pick(c, "Ingress", c.api.list("Ingress", "default"), names);
  if (!is.length) return "";
  return table(
    ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"],
    is.map((i) => [
      i.metadata.name,
      i.spec.ingressClassName ?? "<none>",
      [...new Set((i.spec.rules ?? []).map((r) => r.host ?? "*"))].join(",") || "*",
      i.status.loadBalancer.ingress?.map((a) => a.ip ?? a.hostname).join(",") ?? "",
      i.spec.tls?.length ? "80, 443" : "80",
      fmtAge(c.now - i.metadata.creationTimestamp),
    ]),
  );
}

function getPdbs(c: Cluster, names: string[]): string {
  const bs = pick(c, "PodDisruptionBudget", c.api.list("PodDisruptionBudget", "default"), names);
  if (!bs.length) return "";
  return table(
    ["NAME", "MIN AVAILABLE", "MAX UNAVAILABLE", "ALLOWED DISRUPTIONS", "AGE"],
    bs.map((b) => [b.metadata.name, b.spec.minAvailable !== undefined ? String(b.spec.minAvailable) : "N/A", b.spec.maxUnavailable !== undefined ? String(b.spec.maxUnavailable) : "N/A", String(b.status.disruptionsAllowed), fmtAge(c.now - b.metadata.creationTimestamp)]),
  );
}

function getLeases(c: Cluster, names: string[]): string {
  const ls = pick(c, "Lease", c.api.list("Lease", NODE_LEASE_NS), names);
  if (!ls.length) return "";
  return table(
    ["NAME", "HOLDER", "AGE", "RENEWED"],
    ls.map((l) => [l.metadata.name, l.spec.holderIdentity, fmtAge(c.now - l.metadata.creationTimestamp), `${fmtAge(c.now - l.spec.renewTime)} ago`]),
  );
}

function getEvents(c: Cluster): string {
  const evs = [...c.api.events].filter((e) => (e.involvedObject.namespace ?? "default") === "default" || e.involvedObject.kind === "Node").sort((a, b) => a.lastTimestamp - b.lastTimestamp);
  if (!evs.length) return "";
  return table(
    ["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"],
    evs.map((e) => [fmtAge(c.now - e.lastTimestamp), e.type, e.reason, `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`, e.message]),
  );
}

// ---------- describe ----------

function describe(c: Cluster, pos: string[]): string {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Pod", "Deployment", "ReplicaSet", "Node", "Service", "Ingress", "ConfigMap", "Secret", "NetworkPolicy", "StatefulSet", "PersistentVolumeClaim", "PersistentVolume", "HorizontalPodAutoscaler"], "describe");
  const name = names[0];
  if (!name) throw new KubectlError(`error: 이름을 함께 쓰세요. 예: kubectl describe ${k.toLowerCase()} <이름>`);
  const o = c.api.get(k, name, CLUSTER_SCOPED.has(k) ? undefined : "default");
  if (!o) throw new ApiError("NotFound", `${KIND_PLURAL[k]} "${name}" not found`);
  switch (o.kind) {
    case "HorizontalPodAutoscaler": {
      const goal = o.spec.metrics[0]?.resource.target.averageUtilization;
      const cur = o.status.currentMetrics?.[0]?.resource.current;
      return (
        kv([
          ["Name", o.metadata.name],
          ["Namespace", "default"],
          ["Labels", labelsText(o.metadata.labels)],
          ["Annotations", "<none>"],
          ["CreationTimestamp", fmtClock(o.metadata.creationTimestamp)],
          ["Reference", `${o.spec.scaleTargetRef.kind}/${o.spec.scaleTargetRef.name}`],
          ["Metrics", "( current / target )"],
          ["  resource cpu on pods  (as a percentage of request)", `${cur ? `${cur.averageUtilization}% (${fmtCpu(cur.averageValue)})` : "<unknown>"} / ${goal}%`],
          ["Min replicas", String(o.spec.minReplicas ?? 1)],
          ["Max replicas", String(o.spec.maxReplicas)],
          [`${o.spec.scaleTargetRef.kind} pods`, `${o.status.currentReplicas} current / ${o.status.desiredReplicas} desired`],
        ]) +
        "\nConditions:\n" +
        table(["  Type", "Status", "Reason", "Message"], [["  ----", "------", "------", "-------"], ...o.status.conditions.map((x) => [`  ${x.type}`, x.status, x.reason ?? "", x.message ?? ""])]) +
        eventsBlock(c, o.metadata.uid)
      );
    }
    case "StatefulSet": {
      const pods = c.api.list("Pod", "default").filter((p) => controllerOf(p.metadata)?.uid === o.metadata.uid);
      const running = pods.filter((p) => p.status.phase === "Running").length;
      return (
        kv([
          ["Name", o.metadata.name],
          ["Namespace", "default"],
          ["CreationTimestamp", fmtClock(o.metadata.creationTimestamp)],
          ["Selector", Object.entries(o.spec.selector.matchLabels).map(([a, b]) => `${a}=${b}`).join(",")],
          ["Labels", labelsText(o.metadata.labels)],
          ["Replicas", `${o.spec.replicas} desired | ${o.status.replicas} total`],
          ["Update Strategy", o.spec.updateStrategy?.type ?? "RollingUpdate"],
          ["Pods Status", `${running} Running / ${pods.length - running} Waiting / 0 Succeeded / 0 Failed`],
          ["Pod Template", ""],
          ...templateLines(o.spec.template.spec.containers[0]),
          ["Volume Claims", ""],
          ...(o.spec.volumeClaimTemplates ?? []).flatMap((t) => [
            ["  Name", t.metadata.name] as [string, string],
            ["  StorageClass", t.spec.storageClassName ?? "local-path"] as [string, string],
            ["  Capacity", fmtMem(t.spec.resources.requests.storage)] as [string, string],
            ["  Access Modes", accessModes(t.spec.accessModes)] as [string, string],
          ]),
        ]) + eventsBlock(c, o.metadata.uid)
      );
    }
    case "PersistentVolumeClaim": {
      const users = c.api.list("Pod", "default").filter((p) => (p.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === o.metadata.name));
      return (
        kv([
          ["Name", o.metadata.name],
          ["Namespace", "default"],
          ["StorageClass", o.spec.storageClassName ?? ""],
          ["Status", o.status.phase],
          ["Volume", o.spec.volumeName ?? ""],
          ["Labels", labelsText(o.metadata.labels)],
          ["Annotations", Object.entries(o.metadata.annotations ?? {}).filter(([k2]) => k2 !== "kubectl.kubernetes.io/last-applied-configuration").map(([a, b]) => `${a}: ${b}`).join("\n               ") || "<none>"],
          ["Capacity", o.status.capacity ? fmtMem(o.status.capacity.storage) : ""],
          ["Access Modes", o.status.phase === "Bound" ? accessModes(o.spec.accessModes) : ""],
          ["VolumeMode", "Filesystem"],
          ["Used By", users.map((p) => p.metadata.name).join("\n               ") || "<none>"],
        ]) + eventsBlock(c, o.metadata.uid)
      );
    }
    case "PersistentVolume": {
      const node = pvNode(o);
      return (
        kv([
          ["Name", o.metadata.name],
          ["Labels", labelsText(o.metadata.labels)],
          ["StorageClass", o.spec.storageClassName],
          ["Status", o.status.phase],
          ["Claim", o.spec.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : ""],
          ["Reclaim Policy", o.spec.persistentVolumeReclaimPolicy],
          ["Access Modes", accessModes(o.spec.accessModes)],
          ["VolumeMode", "Filesystem"],
          ["Capacity", fmtMem(o.spec.capacity.storage)],
          ["Node Affinity", ""],
          ["  Required Terms", ""],
          ["    Term 0", node ? `kubernetes.io/hostname in [${node}]` : "<none>"],
          ["Source", ""],
          ["    Type", "HostPath (bare host directory volume)"],
          ["    Path", o.spec.hostPath.path],
        ]) + eventsBlock(c, o.metadata.uid)
      );
    }
    case "NetworkPolicy":
      return describeNetpol(c, o);
    case "ConfigMap":
      // 실제 출력처럼 키마다 "KEY:\n----\n값"
      return (
        kv([["Name", o.metadata.name], ["Namespace", "default"], ["Labels", labelsText(o.metadata.labels)], ["Annotations", "<none>"]]) +
        "\n\nData\n====\n" +
        Object.entries(o.data).map(([key, v]) => `${key}:\n----\n${v}\n`).join("\n") +
        "\nBinaryData\n====\n" +
        eventsBlock(c, o.metadata.uid)
      );
    case "Secret":
      // 실제 출력은 값을 보이지 않고 바이트 수만 (그래도 get -o yaml 의 base64 를 풀면 다 보인다)
      return (
        kv([["Name", o.metadata.name], ["Namespace", "default"], ["Labels", labelsText(o.metadata.labels)], ["Annotations", "<none>"]]) +
        `\n\nType:  ${o.type}\n\nData\n====\n` +
        Object.entries(o.data).map(([key, v]) => `${key}:  ${b64bytes(v)} bytes`).join("\n") +
        eventsBlock(c, o.metadata.uid)
      );
    case "Pod":
      return describePod(c, o);
    case "Node":
      return describeNode(c, o);
    case "Deployment": {
      const rss = c.api.list("ReplicaSet", "default").filter((r) => controllerOf(r.metadata)?.uid === o.metadata.uid);
      // NewReplicaSet = 지금 템플릿 해시의 것 (replicas 와 상관없이)
      const hash = deploymentHash(o);
      const cur = rss.find((r) => r.metadata.labels[HASH_LABEL] === hash);
      const s = o.status;
      return kv([
        ["Name", o.metadata.name],
        ["Namespace", "default"],
        ["CreationTimestamp", fmtClock(o.metadata.creationTimestamp)],
        ["Labels", labelsText(o.metadata.labels)],
        ["Selector", Object.entries(o.spec.selector.matchLabels).map(([a, b]) => `${a}=${b}`).join(",")],
        ["Replicas", `${o.spec.replicas} desired | ${s.updatedReplicas} updated | ${s.replicas} total | ${s.availableReplicas} available | ${s.unavailableReplicas ?? 0} unavailable`],
        ["StrategyType", o.spec.strategy?.type ?? "RollingUpdate"],
        ["MinReadySeconds", "0"],
        ...(o.spec.strategy?.type === "Recreate"
          ? []
          : ([["RollingUpdateStrategy", `${o.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%"} max unavailable, ${o.spec.strategy?.rollingUpdate?.maxSurge ?? "25%"} max surge`]] as [string, string][])),
        ["Pod Template", ""],
        ...templateLines(o.spec.template.spec.containers[0]),
      ]) +
        "\nConditions:\n" +
        table(["  Type", "Status", "Reason"], [["  ----", "------", "------"], ...(s.conditions ?? []).map((x) => [`  ${x.type}`, x.status, x.reason ?? ""])]) +
        "\n" +
        kv([
          ["OldReplicaSets", rss.filter((r) => r !== cur && (r.spec.replicas > 0 || r.status.replicas > 0)).map((r) => `${r.metadata.name} (${r.status.replicas}/${r.spec.replicas} replicas created)`).join(", ") || "<none>"],
          ["NewReplicaSet", cur ? `${cur.metadata.name} (${cur.status.replicas}/${cur.spec.replicas} replicas created)` : "<none>"],
        ]) +
        eventsBlock(c, o.metadata.uid);
    }
    case "Lease":
      throw new KubectlError("error: describe lease 는 아직 없습니다 — kubectl get leases -n kube-node-lease");
    case "EndpointSlice":
      throw new KubectlError("error: describe endpointslice 는 아직 없습니다 — kubectl get endpointslices");
    case "PodDisruptionBudget":
      throw new KubectlError("error: describe pdb 는 아직 없습니다 — kubectl get pdb");
    case "Application":
      throw new KubectlError("error: Application 은 argocd app get <이름> 으로 보세요");
    case "Service": {
      const lines: [string, string][] = [
        ["Name", o.metadata.name],
        ["Namespace", "default"],
        ["Labels", labelsText(o.metadata.labels)],
        ["Selector", Object.entries(o.spec.selector).map(([a, b]) => `${a}=${b}`).join(",") || "<none>"],
        ["Type", o.spec.type],
        ["IP", o.spec.clusterIP ?? "None"],
      ];
      if (o.spec.type === "LoadBalancer") lines.push(["LoadBalancer Ingress", o.status.loadBalancer?.ingress?.[0]?.ip ?? "<pending>"]);
      for (const p of o.spec.ports) {
        lines.push(["Port", `${p.name ?? "<unset>"}  ${p.port}/${p.protocol}`], ["TargetPort", `${p.targetPort}/${p.protocol}`]);
        if (p.nodePort) lines.push(["NodePort", `${p.name ?? "<unset>"}  ${p.nodePort}/${p.protocol}`]);
        lines.push(["Endpoints", readyAddrs(c, o.metadata.name).join(",") || "<none>"]);
      }
      if (o.spec.externalTrafficPolicy) lines.push(["External Traffic Policy", o.spec.externalTrafficPolicy]);
      return kv(lines) + eventsBlock(c, o.metadata.uid);
    }
    case "Ingress": {
      const backendText = (b: { service: { name: string; port: { number: number } } }) => {
        const svc = c.api.get("Service", b.service.name, "default");
        const eps = svc ? readyAddrs(c, svc.metadata.name) : [];
        return `${b.service.name}:${b.service.port.number} (${svc ? eps.join(",") || "<none>" : `<error: services "${b.service.name}" not found>`})`;
      };
      const rows: string[][] = [["  Host", "Path", "Backends"], ["  ----", "----", "--------"]];
      for (const r of o.spec.rules ?? []) {
        rows.push([`  ${r.host ?? "*"}`, "", ""]);
        for (const p of r.http.paths) rows.push(["", p.path, backendText(p.backend)]);
      }
      if (!o.spec.rules?.length) rows.push(["  *", "*", o.spec.defaultBackend ? backendText(o.spec.defaultBackend) : "<default>"]);
      const ann = Object.entries(o.metadata.annotations ?? {}).map(([k2, v]) => `${k2}: ${v}`);
      return (
        kv([
          ["Name", o.metadata.name],
          ["Labels", labelsText(o.metadata.labels)],
          ["Namespace", "default"],
          ["Address", o.status.loadBalancer.ingress?.map((a) => a.ip ?? a.hostname).join(",") ?? ""],
          ["Ingress Class", o.spec.ingressClassName ?? "<none>"],
          ["Default backend", o.spec.defaultBackend ? backendText(o.spec.defaultBackend) : "<default>"],
          ...(o.spec.tls?.length ? ([["TLS", ""], ["  SNI routes", o.spec.tls.flatMap((t) => t.hosts).join(",")]] as [string, string][]) : []),
          ["Rules", ""],
        ]) +
        "\n" +
        table(rows[0]!, rows.slice(1)) +
        "\n" +
        kv([["Annotations", ann.join("\n                  ") || "<none>"]]) +
        eventsBlock(c, o.metadata.uid)
      );
    }
    case "ReplicaSet": {
      const pods = c.api.list("Pod", "default").filter((p) => controllerOf(p.metadata)?.uid === o.metadata.uid);
      const running = pods.filter((p) => p.status.phase === "Running").length;
      const waiting = pods.filter((p) => p.status.phase === "Pending").length;
      const owner = controllerOf(o.metadata);
      return kv([
        ["Name", o.metadata.name],
        ["Namespace", "default"],
        ["Selector", Object.entries(o.spec.selector.matchLabels).map(([a, b]) => `${a}=${b}`).join(",")],
        ["Labels", labelsText(o.metadata.labels)],
        ["Controlled By", owner ? `${owner.kind}/${owner.name}` : "<none>"],
        ["Replicas", `${o.status.replicas} current / ${o.spec.replicas} desired`],
        ["Pods Status", `${running} Running / ${waiting} Waiting / 0 Succeeded / 0 Failed`],
        ["Pod Template", ""],
        ...templateLines(o.spec.template.spec.containers[0]),
      ]) + eventsBlock(c, o.metadata.uid);
    }
    default:
      throw new KubectlError(`error: describe ${k.toLowerCase()} 는 아직 없습니다 (축소판)`);
  }
}

function describePod(c: Cluster, p: Pod): string {
  const owner = controllerOf(p.metadata);
  const node = p.spec.nodeName ? c.api.get("Node", p.spec.nodeName) : undefined;
  const lines: [string, string][] = [
    ["Name", p.metadata.name],
    ["Namespace", p.metadata.namespace ?? "default"],
    ["Node", p.spec.nodeName ? `${p.spec.nodeName}/${node?.status.addresses[0]?.address ?? ""}` : "<none>"],
    ["Start Time", p.status.startTime !== undefined ? `${fmtClock(p.status.startTime)} (시뮬레이션 시각)` : "<unset>"],
    ["Labels", labelsText(p.metadata.labels)],
    ["Status", p.metadata.deletionTimestamp !== undefined ? "Terminating" : p.status.phase],
  ];
  if (p.metadata.deletionTimestamp !== undefined) lines.push(["Termination Grace Period", `${p.metadata.deletionGracePeriodSeconds ?? 30}s`]);
  lines.push(["IP", p.status.podIP ?? ""], ["Controlled By", owner ? `${owner.kind}/${owner.name}` : "<none>"], ["Containers", ""]);
  let out = kv(lines);
  for (const ct of p.spec.containers) {
    const cs = p.status.containerStatuses.find((s) => s.name === ct.name);
    const sub: [string, string][] = [["Image", ct.image]];
    if (cs) {
      sub.push(...stateLines("State", cs.state));
      if (cs.lastState) sub.push(...stateLines("Last State", cs.lastState));
      sub.push(["Ready", cs.ready ? "True" : "False"], ["Restart Count", String(cs.restartCount)]);
    } else sub.push(["State", "Waiting"], ["Ready", "False"], ["Restart Count", "0"]);
    const lim = ct.resources.limits;
    if (lim && (lim.cpu !== undefined || lim.memory !== undefined))
      sub.push(["Limits", ""], ...(lim.cpu !== undefined ? [["  cpu", fmtCpu(lim.cpu)] as [string, string]] : []), ...(lim.memory !== undefined ? [["  memory", fmtMem(lim.memory)] as [string, string]] : []));
    const rq = ct.resources.requests;
    if (rq.cpu || rq.memory) sub.push(["Requests", ""], ...(rq.cpu ? [["  cpu", fmtCpu(rq.cpu)] as [string, string]] : []), ...(rq.memory ? [["  memory", fmtMem(rq.memory)] as [string, string]] : []));
    out += `\n  ${ct.name}:\n` + kv(sub, 4);
  }
  out += "\nConditions:\n" + table(["  Type", "Status"], ["PodScheduled", "Initialized", "ContainersReady", "Ready"].flatMap((t) => {
    const cond = p.status.conditions.find((x) => x.type === t);
    return cond ? [[`  ${t}`, cond.status]] : [];
  }));
  const tols = (p.spec.tolerations ?? []).map((t) => `${t.key}${t.effect ? `:${t.effect}` : ""} op=${t.operator ?? "Equal"}${t.value ? ` value=${t.value}` : ""}${t.tolerationSeconds !== undefined ? ` for ${t.tolerationSeconds}s` : ""}`);
  out += `\nQoS Class:        ${qosClass(p.spec)}`;
  out += `\nNode-Selectors:   ${p.spec.nodeSelector ? labelsText(p.spec.nodeSelector) : "<none>"}`;
  out += `\nTolerations:      ${tols.join("\n                  ") || "<none>"}`;
  return out + eventsBlock(c, p.metadata.uid);
}

/** kubectl describe networkpolicy — 실제 출력 모양 (허용 규칙을 방향별로) */
function describeNetpol(c: Cluster, o: NetworkPolicy): string {
  const peers = (list: NetworkPolicyPeer[] | undefined, label: string) => {
    if (!list?.length) return [`    ${label}: <any> (traffic not restricted by ${label === "From" ? "source" : "destination"})`];
    // 실제 출력처럼 상대마다 "From:"(To:) 머리를 따로
    return list.flatMap((p) => [
      `    ${label}:`,
      ...(p.ipBlock
        ? [`      IPBlock:`, `        CIDR: ${p.ipBlock.cidr}`, `        Except: ${(p.ipBlock.except ?? []).join(", ")}`]
        : [...(p.namespaceSelector ? [`      NamespaceSelector: ${selectorText(p.namespaceSelector)}`] : []), ...(p.podSelector ? [`      PodSelector: ${selectorText(p.podSelector)}`] : [])]),
    ]);
  };
  const ports = (ps: NetworkPolicyPort[] | undefined) => (ps?.length ? ps.map((p) => `    To Port: ${p.port ?? "<any>"}/${p.protocol ?? "TCP"}`) : ["    To Port: <any> (traffic allowed to all ports)"]);
  const types = o.spec.policyTypes ?? ["Ingress"];
  const block = (dir: "ingress" | "egress") => {
    const on = types.includes(dir === "ingress" ? "Ingress" : "Egress");
    if (!on) return [`  Not affecting ${dir} traffic`];
    const rules = (dir === "ingress" ? o.spec.ingress : o.spec.egress) ?? [];
    if (!rules.length) return [`  Allowing ${dir} traffic:`, `    <none> (Selected pods are isolated for ${dir} connectivity)`];
    return [
      `  Allowing ${dir} traffic:`,
      ...rules.flatMap((r, i) => [...(i ? ["    ----------"] : []), ...ports(r.ports), ...peers("from" in r ? r.from : (r as { to?: NetworkPolicyPeer[] }).to, dir === "ingress" ? "From" : "To")]),
    ];
  };
  const sel = Object.keys(o.spec.podSelector.matchLabels ?? {}).length ? selectorText(o.spec.podSelector) : "<none> (Allowing the specific traffic to all pods in this namespace)";
  return [
    kv([["Name", o.metadata.name], ["Namespace", "default"], ["Created on", fmtClock(o.metadata.creationTimestamp)], ["Labels", labelsText(o.metadata.labels)], ["Annotations", "<none>"]]),
    "Spec:",
    `  PodSelector:     ${sel}`,
    ...block("ingress"),
    ...block("egress"),
    `  Policy Types: ${types.join(", ")}`,
  ].join("\n");
}

/** describe node 의 Limits 칸: limits 가 없는 컨테이너는 0 으로 센다 (실제 출력과 같음) */
function podLimits(p: Pod): { cpu: number; memory: number } {
  let cpu = 0;
  let memory = 0;
  for (const ct of p.spec.containers) {
    cpu += ct.resources.limits?.cpu ?? 0;
    memory += ct.resources.limits?.memory ?? 0;
  }
  return { cpu, memory };
}

// ---------- top (metrics-server) ----------

function top(c: Cluster, pos: string[]): string {
  const what = (pos[0] ?? "").toLowerCase();
  const names = pos.slice(1);
  if (/^(po|pod|pods)$/.test(what)) {
    const pods = c.api.list("Pod", "default").filter((p) => names.length === 0 || names.includes(p.metadata.name));
    for (const n of names) if (!pods.some((p) => p.metadata.name === n)) throw new ApiError("NotFound", `pods "${n}" not found`);
    const rows = pods.flatMap((p) => {
      const m = c.podMetrics(p);
      return m ? [[p.metadata.name, `${m.cpu}m`, `${m.memory}Mi`]] : [];
    });
    if (!rows.length) {
      if (names.length) throw new KubectlError(`error: Metrics not available for pod default/${names[0]}, age: ${fmtAge(c.now - pods[0]!.metadata.creationTimestamp)} (컨테이너가 돌고 있지 않음)`);
      return "No resources found in default namespace.";
    }
    return table(["NAME", "CPU(cores)", "MEMORY(bytes)"], rows);
  }
  if (/^(no|node|nodes)$/.test(what)) {
    const nodes = c.api.list("Node").filter((n) => names.length === 0 || names.includes(n.metadata.name));
    for (const n of names) if (!nodes.some((x) => x.metadata.name === n)) throw new ApiError("NotFound", `nodes "${n}" not found`);
    const pods = c.api.list("Pod");
    return table(
      ["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"],
      nodes.map((n) => {
        if (!c.nodePowered(n.metadata.name)) return [n.metadata.name, "<unknown>", "<unknown>", "<unknown>", "<unknown>"];
        let cpu = 0;
        let mem = 0;
        for (const p of pods) {
          if (p.spec.nodeName !== n.metadata.name) continue;
          const m = c.podMetrics(p);
          if (m) {
            cpu += m.cpu;
            mem += m.memory;
          }
        }
        const a = n.status.allocatable;
        return [n.metadata.name, `${cpu}m`, `${Math.floor((cpu * 100) / a.cpu)}%`, `${mem}Mi`, `${Math.floor((mem * 100) / a.memory)}%`];
      }),
    );
  }
  throw new KubectlError(`error: kubectl top pods 또는 kubectl top nodes 로 쓰세요 (metrics-server 가 모은 실사용 — requests 와 다릅니다)`);
}

function describeNode(c: Cluster, n: Node): string {
  const pods = c.api.list("Pod").filter((p) => p.spec.nodeName === n.metadata.name);
  const usage = nodeUsage(pods, n.metadata.name);
  const a = n.status.allocatable;
  const pct = (u: number, t: number) => `${t ? Math.round((u / t) * 100) : 0}%`;
  let out = kv([
    ["Name", n.metadata.name],
    ["Roles", "<none>"],
    ["Labels", labelsText(n.metadata.labels)],
    ["CreationTimestamp", fmtClock(n.metadata.creationTimestamp)],
    ["Taints", nodeTaints(n).join("\n                  ") || "<none>"],
    ["Unschedulable", n.spec.unschedulable ? "true" : "false"],
  ]);
  out += "\nConditions:\n" + table(["  Type", "Status", "Reason", "Message"], n.status.conditions.map((x) => [`  ${x.type}`, x.status, x.reason ?? "", x.message ?? ""]));
  out += "\nAddresses:\n" + n.status.addresses.map((x) => `  ${x.type}:  ${x.address}`).join("\n");
  out += `\nCapacity:\n  cpu:     ${fmtCpu(n.status.capacity.cpu)}\n  memory:  ${fmtMem(n.status.capacity.memory)}\n  pods:    ${n.status.capacity.pods}`;
  out += `\nAllocatable:\n  cpu:     ${fmtCpu(a.cpu)}\n  memory:  ${fmtMem(a.memory)}\n  pods:    ${a.pods}`;
  out += `\nPodCIDR:                      ${n.spec.podCIDR}`;
  out += `\nNon-terminated Pods:          (${pods.length} in total)\n`;
  out += pods.length
    ? table(
        ["  Namespace", "Name", "CPU Requests", "CPU Limits", "Memory Requests", "Memory Limits", "Age"],
        pods.map((p) => {
          const r = podRequests(p.spec);
          const l = podLimits(p);
          return [
            `  ${p.metadata.namespace ?? "default"}`,
            p.metadata.name,
            `${fmtCpu(r.cpu)} (${pct(r.cpu, a.cpu)})`,
            `${fmtCpu(l.cpu)} (${pct(l.cpu, a.cpu)})`,
            `${fmtMem(r.memory)} (${pct(r.memory, a.memory)})`,
            `${fmtMem(l.memory)} (${pct(l.memory, a.memory)})`,
            fmtAge(c.now - p.metadata.creationTimestamp),
          ];
        }),
      )
    : "  (없음)";
  const lims = pods.reduce((n, p) => {
    const l = podLimits(p);
    return { cpu: n.cpu + l.cpu, memory: n.memory + l.memory };
  }, { cpu: 0, memory: 0 });
  out += "\nAllocated resources:\n  (Total limits may be over 100 percent, i.e., overcommitted.)\n" + table(["  Resource", "Requests", "Limits"], [
    ["  cpu", `${fmtCpu(usage.requested.cpu)} (${pct(usage.requested.cpu, a.cpu)})`, `${fmtCpu(lims.cpu)} (${pct(lims.cpu, a.cpu)})`],
    ["  memory", `${fmtMem(usage.requested.memory)} (${pct(usage.requested.memory, a.memory)})`, `${fmtMem(lims.memory)} (${pct(lims.memory, a.memory)})`],
  ]);
  return out + eventsBlock(c, n.metadata.uid);
}

/** describe node 의 Taints: spec.taints + cordon 이면 unschedulable (실제로는 컨트롤러가 taint 로 붙인다) */
function nodeTaints(n: Node): string[] {
  const out = (n.spec.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`);
  if (n.spec.unschedulable && !out.some((t) => t.startsWith("node.kubernetes.io/unschedulable"))) out.push("node.kubernetes.io/unschedulable:NoSchedule");
  return out.sort();
}

function stateLines(label: string, s: Pod["status"]["containerStatuses"][number]["state"]): [string, string][] {
  if ("running" in s) return [[label, "Running"], ["  Started", `${fmtClock(s.running.startedAt)}`]];
  if ("waiting" in s) return [[label, "Waiting"], ["  Reason", s.waiting.reason]];
  return [
    [label, "Terminated"],
    ["  Reason", s.terminated.reason],
    ["  Exit Code", String(s.terminated.exitCode)],
    ["  Finished", fmtClock(s.terminated.finishedAt)],
  ];
}

function templateLines(ct: Pod["spec"]["containers"][number] | undefined): [string, string][] {
  if (!ct) return [];
  return [
    [`  ${ct.name}`, ""],
    ["    Image", ct.image],
    ["    Requests", `cpu ${fmtCpu(ct.resources.requests.cpu)}, memory ${fmtMem(ct.resources.requests.memory)}`],
    ...(ct.resources.limits && (ct.resources.limits.cpu !== undefined || ct.resources.limits.memory !== undefined)
      ? [["    Limits", [ct.resources.limits.cpu !== undefined ? `cpu ${fmtCpu(ct.resources.limits.cpu)}` : "", ct.resources.limits.memory !== undefined ? `memory ${fmtMem(ct.resources.limits.memory)}` : ""].filter(Boolean).join(", ")] as [string, string]]
      : []),
  ];
}

function eventsBlock(c: Cluster, uid: string): string {
  const evs = c.api.eventsFor(uid);
  if (!evs.length) return "\nEvents:            <none>";
  return (
    "\nEvents:\n" +
    table(
      ["  Type", "Reason", "Age", "From", "Message"],
      [["  ----", "------", "----", "----", "-------"], ...evs.map((e) => [`  ${e.type}`, e.reason, eventAge(c, e), eventSource(e.source), e.message])],
    )
  );
}

function eventAge(c: Cluster, e: KEvent): string {
  const last = fmtAge(c.now - e.lastTimestamp);
  return e.count > 1 ? `${last} (x${e.count} over ${fmtAge(c.now - e.firstTimestamp)})` : last;
}

/** 이벤트 From 칸: 실제 출력처럼 */
export function eventSource(source: string): string {
  if (source === "kube-scheduler") return "default-scheduler";
  if (source.startsWith("kubelet@")) return "kubelet";
  return source;
}

// ---------- 바꾸는 명령 ----------

function create(c: Cluster, pos: string[], flags: Map<string, string>, line: string, raw: string[] = []): KubectlResult {
  if (pos[0] === "ingress" || pos[0] === "ing") return createIngress(c, pos[1], raw, line);
  if (pos[0] === "configmap" || pos[0] === "cm") return createConfig(c, "ConfigMap", pos[1], raw, line);
  if (pos[0] === "secret") {
    if (pos[1] !== "generic") throw new KubectlError(`error: kubectl create secret generic <이름> --from-literal=KEY=값 처럼 쓰세요 (generic 만 — 축소판)`);
    return createConfig(c, "Secret", pos[2], raw, line);
  }
  if (pos[0] === "pdb" || pos[0] === "poddisruptionbudget") {
    const name = pos[1];
    const sel = flags.get("selector");
    if (!name || !sel) throw new KubectlError("error: 이름과 --selector 가 필요합니다. 예: kubectl create pdb web-pdb --selector=app=web --min-available=2");
    const matchLabels: Record<string, string> = {};
    for (const part of sel.split(",")) {
      const [k2, v] = part.split("=");
      if (!k2 || v === undefined) throw new KubectlError(`error: --selector 를 읽지 못했습니다 ("${sel}") — app=web 처럼`);
      matchLabels[k2] = v;
    }
    const intOrPct = (v: string | undefined) => (v === undefined ? undefined : /^\d+%$/.test(v) ? v : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
    const minA = intOrPct(flags.get("min-available"));
    const maxU = intOrPct(flags.get("max-unavailable"));
    if (Number.isNaN(minA) || Number.isNaN(maxU)) throw new KubectlError("error: --min-available·--max-unavailable 은 0 이상 정수나 25% 같은 퍼센트여야 합니다");
    if ((minA === undefined) === (maxU === undefined)) throw new KubectlError("error: one of min-available or max-unavailable must be specified");
    if (c.api.get("PodDisruptionBudget", name, "default")) throw new ApiError("AlreadyExists", `poddisruptionbudgets.policy "${name}" already exists`);
    userTrace(c, line);
    c.apply(pdb(name, matchLabels, minA !== undefined ? { minAvailable: minA } : { maxUnavailable: maxU }), "kubectl");
    return ok(`poddisruptionbudget.policy/${name} created`, true);
  }
  if (pos[0] !== "deployment" && pos[0] !== "deploy") throw new KubectlError(`error: create 는 deployment 만 됩니다 (축소판). 예: kubectl create deployment web --image=nginx:1.27`);
  const name = pos[1];
  const image = flags.get("image");
  if (!name || !image) throw new KubectlError("error: 이름과 --image 가 필요합니다. 예: kubectl create deployment web --image=nginx:1.27 --replicas=2");
  const replicas = flags.has("replicas") ? parseReplicas(flags.get("replicas")!) : 1;
  if (c.api.get("Deployment", name, "default")) throw new ApiError("AlreadyExists", `deployments.apps "${name}" already exists`);
  userTrace(c, line);
  c.apply(deployment(name, { replicas, image, cpu: 100, memory: 128 }), "kubectl");
  return ok(`deployment.apps/${name} created`, true);
}

/** kubectl create configmap|secret generic <이름> --from-literal=KEY=값 (여러 번) */
function createConfig(c: Cluster, kind: "ConfigMap" | "Secret", name: string | undefined, args: string[], line: string): KubectlResult {
  const cmd = kind === "ConfigMap" ? "configmap" : "secret generic";
  if (!name || name.startsWith("-")) throw new KubectlError(`error: 이름이 필요합니다. 예: kubectl create ${cmd} app-config --from-literal=GREETING=hello`);
  const data: Record<string, string> = {};
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    const lit = /^--from-literal=(.*)$/.exec(a)?.[1];
    if (lit === undefined) {
      const flag = a.split("=")[0]!;
      if (flag === "--from-file" || flag === "--from-env-file") throw new KubectlError(`error: ${flag} 는 이 시뮬레이터에 파일이 없어 쓸 수 없습니다 (축소판) — --from-literal=KEY=값 으로 쓰세요`);
      throw new KubectlError(`error: unknown flag: ${flag}`);
    }
    const eq = lit.indexOf("=");
    if (eq <= 0) throw new KubectlError(`error: --from-literal 은 KEY=값 이어야 합니다 (받은 값 "${lit}")`);
    const key = lit.slice(0, eq);
    if (!CONFIG_KEY_RE.test(key))
      throw new KubectlError(`error: "${key}" is not a valid key name for a ${kind}: a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
    if (key in data) throw new KubectlError(`error: cannot add key "${key}", another key by that name already exists in Data for ${kind} "${name}"`);
    data[key] = lit.slice(eq + 1);
  }
  if (c.api.get(kind, name, "default")) throw new ApiError("AlreadyExists", `${KIND_PLURAL[kind]} "${name}" already exists`);
  userTrace(c, line);
  c.apply(kind === "ConfigMap" ? configMap(name, data) : secret(name, data), "kubectl");
  return ok(`${KIND_PREFIX[kind]}/${name} created`, true);
}

function scale(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Deployment", "ReplicaSet", "StatefulSet"], "scale");
  const name = names[0];
  if (!name) throw new KubectlError("error: 이름이 필요합니다. 예: kubectl scale deployment/web --replicas=5");
  if (!flags.has("replicas")) throw new KubectlError("error: --replicas=COUNT 가 필요합니다");
  const replicas = parseReplicas(flags.get("replicas")!);
  if (!c.api.get(k, name, "default")) throw new ApiError("NotFound", `${KIND_PLURAL[k]} "${name}" not found`);
  userTrace(c, line);
  c.api.patch(k, name, "default", "kubectl", (o) => {
    (o.spec as { replicas: number }).replicas = replicas;
  });
  return ok(`${KIND_PREFIX[k]}/${name} scaled`, true);
}

function setCmd(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const what = pos.shift();
  if (what !== "image" && what !== "resources") throw new KubectlError("error: set image 또는 set resources 만 됩니다 (축소판)");
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Deployment"], `set ${what}`);
  const name = names[0];
  if (!name) throw new KubectlError(`error: 이름이 필요합니다. 예: kubectl set ${what} deployment/web ...`);
  const d = c.api.get(k, name, "default");
  if (!d || d.kind !== "Deployment") throw new ApiError("NotFound", `deployments.apps "${name}" not found`);
  if (what === "image") {
    const pairs = names.slice(1).map((s) => s.split("="));
    if (!pairs.length || pairs.some((p) => p.length !== 2)) throw new KubectlError("error: <컨테이너>=<이미지> 가 필요합니다. 예: kubectl set image deployment/web web=nginx:1.28");
    for (const [ct] of pairs) if (!d.spec.template.spec.containers.some((x) => x.name === ct)) throw new KubectlError(`error: unable to find container named "${ct}"`);
    userTrace(c, line);
    c.api.patch("Deployment", name, "default", "kubectl", (o) => {
      for (const [ct, img] of pairs) o.spec.template.spec.containers.find((x) => x.name === ct)!.image = img!;
    });
    return ok(`deployment.apps/${name} image updated`, true);
  }
  const req = flags.get("requests");
  const lim = flags.get("limits");
  if (!req && !lim) throw new KubectlError("error: --requests=cpu=500m,memory=256Mi 또는 --limits=cpu=1,memory=512Mi 처럼 쓰세요");
  const parseRes = (flag: string, v: string | undefined) => {
    const out: { cpu?: number; memory?: number } = {};
    if (!v) return out;
    for (const part of v.split(",")) {
      const [key, val] = part.split("=");
      if (key === "cpu") out.cpu = parseCpu(val ?? "");
      else if (key === "memory") out.memory = parseMem(val ?? "");
      else throw new KubectlError(`error: --${flag}: 알 수 없는 자원 "${key}" (cpu, memory)`);
      if ((key === "cpu" && out.cpu === undefined) || (key === "memory" && out.memory === undefined)) throw new KubectlError(`error: --${flag}: "${part}" 를 읽지 못했습니다 (cpu=500m · memory=256Mi 처럼)`);
    }
    return out;
  };
  const r = parseRes("requests", req);
  const l = parseRes("limits", lim);
  userTrace(c, line);
  c.api.patch("Deployment", name, "default", "kubectl", (o) => {
    for (const ct of o.spec.template.spec.containers) {
      if (r.cpu !== undefined) ct.resources.requests.cpu = r.cpu;
      if (r.memory !== undefined) ct.resources.requests.memory = r.memory;
      if (l.cpu !== undefined || l.memory !== undefined) ct.resources.limits = { ...ct.resources.limits, ...l };
    }
  });
  return ok(`deployment.apps/${name} resource requirements updated`, true);
}

function del(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Pod", "Deployment", "ReplicaSet", "Service", "PodDisruptionBudget", "Ingress", "ConfigMap", "Secret", "NetworkPolicy", "StatefulSet", "PersistentVolumeClaim", "PersistentVolume", "HorizontalPodAutoscaler"], "delete");
  if (!names.length) throw new KubectlError(`error: 지울 이름이 필요합니다. 예: kubectl delete ${k.toLowerCase()} <이름>`);
  for (const n of names) if (!c.api.get(k, n, "default")) throw new ApiError("NotFound", `${KIND_PLURAL[k]} "${n}" not found`);
  userTrace(c, line);
  // 실제 kubectl 처럼: --force 만 주면 유예 0, --grace-period=0 만 주면 1(즉시 아님), 그 외는 준 값 또는 Pod 의 기본값
  const forceFlag = flags.get("force") === "true";
  let grace: number | undefined;
  if (flags.has("grace-period")) {
    const g = Number(flags.get("grace-period"));
    if (!Number.isInteger(g) || g < 0) throw new KubectlError(`error: --grace-period 는 0 이상 정수여야 합니다 (받은 값 "${flags.get("grace-period")}")`);
    grace = g;
  }
  if (forceFlag && grace === undefined) grace = 0;
  if (grace === 0 && !forceFlag) grace = 1;
  const force = grace === 0;
  const out: string[] = [];
  if (force) out.push("Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.");
  for (const n of names) {
    c.api.delete(k, n, "default", "kubectl", grace !== undefined ? { gracePeriodSeconds: grace } : {});
    out.push(`${KIND_PREFIX[k]} "${n}" ${force ? "force deleted" : "deleted"}`);
  }
  return ok(out.join("\n"), true);
}

function cordon(c: Cluster, cmd: "cordon" | "uncordon", pos: string[], line: string): KubectlResult {
  const name = pos[0];
  if (!name) throw new KubectlError(`error: USAGE: ${cmd} NODE`);
  const n = c.api.get("Node", name);
  if (!n) throw new ApiError("NotFound", `nodes "${name}" not found`);
  const want = cmd === "cordon";
  if (!!n.spec.unschedulable === want) return ok(`node/${name} already ${cmd}ed`);
  userTrace(c, line);
  c.api.patch("Node", name, undefined, "kubectl", (o) => {
    if (want) o.spec.unschedulable = true;
    else delete o.spec.unschedulable;
  });
  return ok(`node/${name} ${cmd}ed`, true);
}

/** kubectl patch svc <이름> -p '<JSON merge patch>' — Service 의 spec.type · spec.externalTrafficPolicy 만 (축소판) */
/** kubectl patch configmap|secret <이름> -p '{"data":{...}}' — data 의 키를 합친다 (null 이면 지움). secret 은 stringData(평문)도 받는다 */
function patchConfig(c: Cluster, kind: "ConfigMap" | "Secret", name: string | undefined, flags: Map<string, string>, line: string): KubectlResult {
  if (!name) throw new KubectlError(`error: 이름이 필요합니다. 예: kubectl patch ${KIND_PREFIX[kind]} app-config -p '{"data":{"GREETING":"hi"}}'`);
  const raw = flags.get("p") ?? flags.get("patch");
  if (!raw) throw new KubectlError("error: must specify -p to patch");
  let body: { data?: Record<string, string | null>; stringData?: Record<string, string> };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new KubectlError(`error: unable to parse "${raw}": 올바른 JSON 이 아닙니다 (작은따옴표로 감싸세요)`);
  }
  for (const key of Object.keys(body)) if (key !== "data" && (kind === "ConfigMap" || key !== "stringData")) throw new KubectlError(`error: patch 는 ${kind === "ConfigMap" ? "data" : "data · stringData"} 만 됩니다 (축소판). 받은 키 "${key}"`);
  const cur = c.api.get(kind, name, "default");
  if (!cur) throw new ApiError("NotFound", `${KIND_PLURAL[kind]} "${name}" not found`);
  if (kind === "Secret")
    for (const [k, v] of Object.entries(body.data ?? {}))
      if (v !== null && !isBase64(v)) throw new ApiError("Invalid", `Secret "${name}" is invalid: data[${k}]: Invalid value: "${v}": illegal base64 data (평문은 stringData 로 주세요)`);
  userTrace(c, line);
  const rv = cur.metadata.resourceVersion;
  const out = c.api.patch(kind, name, "default", "kubectl", (o) => {
    for (const [k, v] of Object.entries(body.data ?? {})) {
      if (v === null) delete o.data[k];
      else o.data[k] = v;
    }
    if (o.kind === "Secret" && body.stringData) o.stringData = { ...body.stringData };
  });
  return ok(`${KIND_PREFIX[kind]}/${name} ${out && out.metadata.resourceVersion !== rv ? "patched" : "patched (no change)"}`, true);
}

function patchCmd(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  needWorkload(kind, ["Service", "ConfigMap", "Secret"], "patch");
  if (kind === "ConfigMap" || kind === "Secret") return patchConfig(c, kind, names[0], flags, line);
  const name = names[0];
  if (!name) throw new KubectlError("error: 이름이 필요합니다. 예: kubectl patch svc web -p '{\"spec\":{\"externalTrafficPolicy\":\"Local\"}}'");
  const raw = flags.get("p") ?? flags.get("patch");
  if (!raw) throw new KubectlError("error: must specify -p to patch");
  let body: { spec?: Record<string, unknown> };
  try {
    body = JSON.parse(raw) as { spec?: Record<string, unknown> };
  } catch {
    throw new KubectlError(`error: unable to parse "${raw}": 올바른 JSON 이 아닙니다 (작은따옴표로 감싸세요)`);
  }
  const spec = body.spec ?? {};
  for (const key of Object.keys(spec)) if (key !== "type" && key !== "externalTrafficPolicy") throw new KubectlError(`error: patch 는 spec.type · spec.externalTrafficPolicy 만 됩니다 (축소판). 받은 키 "${key}"`);
  if (spec.type !== undefined && !["ClusterIP", "NodePort", "LoadBalancer"].includes(String(spec.type))) throw new ApiError("Invalid", `Service "${name}" is invalid: spec.type: Unsupported value: "${String(spec.type)}"`);
  if (spec.externalTrafficPolicy !== undefined && !["Cluster", "Local"].includes(String(spec.externalTrafficPolicy)))
    throw new ApiError("Invalid", `Service "${name}" is invalid: spec.externalTrafficPolicy: Unsupported value: "${String(spec.externalTrafficPolicy)}": supported values: "Cluster", "Local"`);
  const cur = c.api.get("Service", name, "default");
  if (!cur) throw new ApiError("NotFound", `services "${name}" not found`);
  const nextType = (spec.type as ServiceType | undefined) ?? cur.spec.type;
  if (spec.externalTrafficPolicy !== undefined && nextType === "ClusterIP") throw new ApiError("Invalid", `Service "${name}" is invalid: spec.externalTrafficPolicy: Invalid value: "${String(spec.externalTrafficPolicy)}": may only be set for externally-accessible services`);
  userTrace(c, line);
  const rv = cur.metadata.resourceVersion;
  const out = c.api.patch("Service", name, "default", "kubectl", (o) => {
    if (spec.type !== undefined) o.spec.type = spec.type as ServiceType;
    if (spec.externalTrafficPolicy !== undefined) o.spec.externalTrafficPolicy = spec.externalTrafficPolicy as "Cluster" | "Local";
  });
  return ok(`service/${name} ${out && out.metadata.resourceVersion !== rv ? "patched" : "patched (no change)"}`, true);
}

/** kubectl create ingress <이름> --class=nginx --rule="host/path=svc:port" (여러 번) [--default-backend=svc:port] */
function createIngress(c: Cluster, name: string | undefined, args: string[], line: string): KubectlResult {
  if (!name) throw new KubectlError('error: 이름이 필요합니다. 예: kubectl create ingress shop --class=nginx --rule="shop.example.com/*=web:80"');
  const val = (flag: string) => args.flatMap((a, i) => (a.startsWith(`--${flag}=`) ? [a.slice(flag.length + 3)] : a === `--${flag}` && args[i + 1] ? [args[i + 1]!] : []));
  const rules = new Map<string, IngressPath[]>();
  for (const r of val("rule")) {
    const m = /^([^/=]*)(\/[^=]*)=([a-z0-9-]+):(\d+)$/.exec(r);
    if (!m) throw new KubectlError(`error: --rule "${r}" 를 읽지 못했습니다 — host/path=service:port (경로 끝 * 은 Prefix). 예: shop.example.com/*=web:80`);
    const prefix = m[2]!.endsWith("*");
    const path = prefix ? m[2]!.slice(0, -1).replace(/(.)\/$/, "$1") || "/" : m[2]!;
    const list = rules.get(m[1]!) ?? [];
    list.push({ path, pathType: prefix ? "Prefix" : "Exact", backend: { service: { name: m[3]!, port: { number: Number(m[4]) } } } });
    rules.set(m[1]!, list);
  }
  const def = val("default-backend")[0];
  const dm = def ? /^([a-z0-9-]+):(\d+)$/.exec(def) : null;
  if (def && !dm) throw new KubectlError(`error: --default-backend "${def}" 는 service:port 여야 합니다`);
  if (!rules.size && !dm) throw new KubectlError("error: --rule 이나 --default-backend 가 하나는 있어야 합니다");
  if (c.api.get("Ingress", name, "default")) throw new ApiError("AlreadyExists", `ingresses.networking.k8s.io "${name}" already exists`);
  userTrace(c, line);
  c.apply(
    ingress(name, {
      className: val("class")[0],
      rules: [...rules].map(([host, paths]) => ({ ...(host ? { host } : {}), http: { paths } })),
      ...(dm ? { defaultBackend: { service: { name: dm[1]!, port: { number: Number(dm[2]) } } } } : {}),
    }),
    "kubectl",
  );
  return ok(`ingress.networking.k8s.io/${name} created`, true);
}

function drainCmd(c: Cluster, pos: string[], line: string): KubectlResult {
  const node = pos[0];
  if (!node) throw new KubectlError("error: USAGE: drain NODE [--ignore-daemonsets]");
  if (!c.api.get("Node", node)) throw new ApiError("NotFound", `nodes "${node}" not found`);
  userTrace(c, line);
  const job = c.drain(node);
  return { ok: true, output: job.lines.join("\n"), mutated: true, drain: job };
}

/** 실제 kubectl rollout status 의 한 줄 (축소판: 끝날 때까지 기다리지 않고 지금 상태만) */
export function rolloutStatusLine(d: Deployment): { done: boolean; text: string } {
  const n = d.metadata.name;
  const s = d.status;
  const prog = s.conditions?.find((x) => x.type === "Progressing");
  // 실제 kubectl 처럼 새 spec 이 관찰됐는지 먼저 본다
  if (s.observedGeneration < d.metadata.generation) return { done: false, text: "Waiting for deployment spec update to be observed..." };
  if (prog?.reason === "ProgressDeadlineExceeded") return { done: true, text: `error: deployment "${n}" exceeded its progress deadline` };
  if (s.updatedReplicas < d.spec.replicas) return { done: false, text: `Waiting for deployment "${n}" rollout to finish: ${s.updatedReplicas} out of ${d.spec.replicas} new replicas have been updated...` };
  if (s.replicas > s.updatedReplicas) return { done: false, text: `Waiting for deployment "${n}" rollout to finish: ${s.replicas - s.updatedReplicas} old replicas are pending termination...` };
  if (s.availableReplicas < s.updatedReplicas) return { done: false, text: `Waiting for deployment "${n}" rollout to finish: ${s.availableReplicas} of ${s.updatedReplicas} updated replicas are available...` };
  return { done: true, text: `deployment "${n}" successfully rolled out` };
}

function rollout(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const sub = pos.shift();
  if (!sub || !["status", "history", "undo", "restart"].includes(sub)) throw new KubectlError("error: rollout 다음에 status · history · undo · restart 중 하나를 쓰세요 (축소판). 예: kubectl rollout status deployment/web");
  const { kind, names } = resourceArgs(pos);
  needWorkload(kind, ["Deployment", "StatefulSet"], `rollout ${sub}`);
  const name = names[0];
  if (kind === "StatefulSet") return rolloutSts(c, sub, name, line);
  if (!name) throw new KubectlError(`error: 이름이 필요합니다. 예: kubectl rollout ${sub} deployment/web`);
  const d = c.api.get("Deployment", name, "default");
  if (!d) throw new ApiError("NotFound", `deployments.apps "${name}" not found`);
  const rss = c.api
    .list("ReplicaSet", "default")
    .filter((r) => controllerOf(r.metadata)?.uid === d.metadata.uid)
    .sort((a, b) => revisionOf(a) - revisionOf(b));
  switch (sub) {
    case "status": {
      const st = rolloutStatusLine(d);
      return { ok: !st.text.startsWith("error"), output: st.done ? st.text : `${st.text}\n(축소판: 실제 kubectl 은 끝날 때까지 기다리며 줄을 더 찍습니다 — 다시 실행해 보세요)`, mutated: false };
    }
    case "history":
      return ok(`deployment.apps/${name} \n${table(["REVISION", "CHANGE-CAUSE"], rss.map((r) => [String(revisionOf(r)), r.metadata.annotations?.["kubernetes.io/change-cause"] ?? "<none>"]))}`);
    case "undo": {
      const cur = Math.max(0, ...rss.map(revisionOf));
      const toRev = flags.has("to-revision") ? Number(flags.get("to-revision")) : undefined;
      const target = toRev !== undefined && toRev !== 0 ? rss.find((r) => revisionOf(r) === toRev) : [...rss].reverse().find((r) => revisionOf(r) < cur);
      if (!target) throw new KubectlError(toRev ? `error: unable to find specified revision ${toRev} in history` : `error: no rollout history found for deployment "${name}"`);
      if (revisionOf(target) === cur) return ok(`deployment.apps/${name} skipped rollback (current template already matches revision ${cur})`);
      userTrace(c, line);
      c.api.patch("Deployment", name, "default", "kubectl", (o) => {
        const labels = { ...target.spec.template.metadata.labels };
        delete labels[HASH_LABEL];
        o.spec.template = { metadata: { labels, ...(target.spec.template.metadata.annotations ? { annotations: { ...target.spec.template.metadata.annotations } } : {}) }, spec: structuredClone(target.spec.template.spec) };
      });
      return ok(`deployment.apps/${name} rolled back`, true);
    }
    default: {
      userTrace(c, line);
      c.api.patch("Deployment", name, "default", "kubectl", (o) => {
        o.spec.template.metadata.annotations = { ...(o.spec.template.metadata.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": `sim-${fmtClock(c.now)}` };
      });
      return ok(`deployment.apps/${name} restarted`, true);
    }
  }
}

/** rollout status|restart statefulset — 큰 번호부터 하나씩 새 리비전으로 */
function rolloutSts(c: Cluster, sub: string, name: string | undefined, line: string): KubectlResult {
  if (!name) throw new KubectlError(`error: 이름이 필요합니다. 예: kubectl rollout ${sub} statefulset/db`);
  const s = c.api.get("StatefulSet", name, "default");
  if (!s) throw new ApiError("NotFound", `statefulsets.apps "${name}" not found`);
  if (sub === "restart") {
    userTrace(c, line);
    c.api.patch("StatefulSet", name, "default", "kubectl", (o) => {
      o.spec.template.metadata.annotations = { ...(o.spec.template.metadata.annotations ?? {}), "kubectl.kubernetes.io/restartedAt": `sim-${fmtClock(c.now)}` };
    });
    return ok(`statefulset.apps/${name} restarted`, true);
  }
  if (sub !== "status") throw new KubectlError(`error: statefulset 은 rollout status · restart 만 됩니다 (축소판)`);
  // 실제 kubectl 의 StatefulSet status viewer 순서
  const st = s.status;
  const again = "\n(축소판: 실제 kubectl 은 끝날 때까지 기다리며 줄을 더 찍습니다 — 다시 실행해 보세요)";
  if (!st.observedGeneration || s.metadata.generation > st.observedGeneration) return { ok: true, output: `Waiting for statefulset spec update to be observed...${again}`, mutated: false };
  if (st.readyReplicas < s.spec.replicas) return { ok: true, output: `Waiting for ${s.spec.replicas - st.readyReplicas} pods to be ready...${again}`, mutated: false };
  if (st.updateRevision !== st.currentRevision) return { ok: true, output: `waiting for statefulset rolling update to complete ${st.updatedReplicas} pods at revision ${st.updateRevision}...${again}`, mutated: false };
  return ok(`statefulset rolling update complete ${st.currentReplicas} pods at revision ${st.currentRevision}...`);
}

/** kubectl get hpa 의 TARGETS: "cpu: 120%/50%" (사용량을 모르면 <unknown>) */
export function hpaTargets(h: HorizontalPodAutoscaler): string {
  const cur = h.status.currentMetrics?.[0]?.resource.current.averageUtilization;
  return `cpu: ${cur === undefined ? "<unknown>" : `${cur}%`}/${h.spec.metrics[0]?.resource.target.averageUtilization ?? "?"}%`;
}

/** kubectl autoscale deployment|statefulset <이름> --cpu-percent=50 --min=1 --max=10 */
function autoscale(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Deployment", "StatefulSet"], "autoscale");
  const name = names[0];
  if (!name) throw new KubectlError("error: 이름이 필요합니다. 예: kubectl autoscale deployment web --cpu-percent=50 --min=1 --max=10");
  if (!c.api.get(k, name, "default")) throw new ApiError("NotFound", `${KIND_PLURAL[k]} "${name}" not found`);
  const num = (f: string) => (flags.has(f) ? Number(flags.get(f)) : undefined);
  const max = num("max");
  const min = num("min") ?? 1;
  const cpu = num("cpu-percent") ?? 80;
  if (max === undefined || !Number.isInteger(max) || max < 1) throw new KubectlError("error: --max=MAXPODS is required (1 이상 정수)");
  if (!Number.isInteger(min) || min < 1 || min > max) throw new KubectlError(`error: --min 은 1 이상이고 --max 이하여야 합니다 (받은 값 min ${min} · max ${max})`);
  if (!Number.isInteger(cpu) || cpu < 1) throw new KubectlError("error: --cpu-percent 는 1 이상 정수");
  const hname = flags.get("name") ?? name;
  if (c.api.get("HorizontalPodAutoscaler", hname, "default")) throw new ApiError("AlreadyExists", `horizontalpodautoscalers.autoscaling "${hname}" already exists`);
  userTrace(c, line);
  c.apply(hpaManifest(hname, { target: name, kind: k as "Deployment" | "StatefulSet", min, max, cpuPercent: cpu }), "kubectl");
  return ok(`horizontalpodautoscaler.autoscaling/${hname} autoscaled`, true);
}

function accessModes(m: string[]): string {
  return m.map((x) => ({ ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" })[x] ?? x).join(",");
}

function expose(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Deployment"], "expose");
  const name = names[0];
  if (!name) throw new KubectlError("error: 이름이 필요합니다. 예: kubectl expose deployment web --port=80");
  const d = c.api.get(k, name, "default");
  if (!d || d.kind !== "Deployment") throw new ApiError("NotFound", `deployments.apps "${name}" not found`);
  const port = Number(flags.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new KubectlError("error: couldn't find port via --port flag or introspection — --port=80 처럼 쓰세요");
  // 실제 kubectl 처럼 --target-port 를 안 주면 targetPort = --port (컨테이너 포트와 다르면 연결 거부 — 흔한 실수)
  const targetPort = flags.has("target-port") ? Number(flags.get("target-port")) : port;
  if (!Number.isInteger(targetPort) || targetPort < 1) throw new KubectlError(`error: --target-port 를 읽지 못했습니다 ("${flags.get("target-port")}")`);
  const type = (flags.get("type") ?? "ClusterIP") as ServiceType;
  if (type !== "ClusterIP" && type !== "NodePort" && type !== "LoadBalancer") throw new KubectlError(`error: --type 은 ClusterIP · NodePort · LoadBalancer (축소판). 받은 값 "${type}"`);
  const svcName = flags.get("name") ?? name;
  if (c.api.get("Service", svcName, "default")) throw new ApiError("AlreadyExists", `services "${svcName}" already exists`);
  userTrace(c, line);
  c.apply(service(svcName, { selector: d.spec.selector.matchLabels, port, targetPort, type }), "kubectl");
  return ok(`service/${svcName} exposed`, true);
}

/** kubectl exec <pod> -- curl|wget|ping|nslookup <대상> */
function exec(c: Cluster, pos: string[], inner: string[]): KubectlResult {
  const podName = pos.filter((p) => !p.startsWith("-"))[0];
  if (!podName) throw new KubectlError("error: Pod 이름이 필요합니다. 예: kubectl exec web-xxx -- curl http://web");
  const p = c.api.get("Pod", podName, "default");
  if (!p) throw new ApiError("NotFound", `pods "${podName}" not found`);
  if (!inner.length) throw new KubectlError("error: you must specify at least one command for the container — 예: kubectl exec <pod> -- curl http://web");
  const ct = p.spec.containers[0]!;
  if (p.spec.nodeName && !c.nodePowered(p.spec.nodeName)) {
    const ip = c.api.get("Node", p.spec.nodeName)?.status.addresses[0]?.address;
    return fail(`Error from server: error dialing backend: dial tcp ${ip}:10250: i/o timeout (노드 ${p.spec.nodeName} 의 kubelet 이 응답하지 않음)`);
  }
  const cs = p.status.containerStatuses[0];
  if (!cs || !("running" in cs.state)) return fail(`error: unable to upgrade connection: container not found ("${ct.name}")`);
  const [tool0, ...rest] = inner;
  if (tool0 === "env" || tool0 === "printenv" || tool0 === "cat" || tool0 === "ls") return execConfig(c, p, tool0, rest);
  const target = firstOperand(tool0 ?? "", rest);
  const tool = tool0 === "wget" ? "curl" : tool0;
  if (tool !== "curl" && tool !== "ping" && tool !== "nslookup")
    return fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${tool0}": executable file not found in $PATH: unknown\n(이 시뮬레이터의 컨테이너에는 curl·wget·ping·nslookup·env·cat·ls 만 있습니다 — 축소판)`);
  if (!target) return fail(`${tool}: 대상이 필요합니다. 예: kubectl exec ${podName} -- ${tool} ${tool === "curl" ? "http://web" : "web"}`);
  c.trace.add("user", "user", `kubectl exec ${podName} -- ${inner.join(" ")}`, { kind: "Pod", namespace: "default", name: podName });
  const r = c.requestFromPod(podName, tool, target);
  return { ok: r.ok, output: tool0 === "wget" ? wgetOutput(r) : r.output, mutated: true, net: r };
}

/** 컨테이너가 본 설정: env 는 시작할 때 읽은 그대로, 파일은 kubelet 이 마지막으로 맞춰 둔 내용 */
function execConfig(c: Cluster, p: Pod, tool: string, args: string[]): KubectlResult {
  const view = c.containerConfig(p);
  if (!view) return fail(`error: unable to upgrade connection: container not found ("${p.spec.containers[0]!.name}")`);
  if (tool === "env" || tool === "printenv") {
    const all: [string, string][] = [["PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], ["HOSTNAME", p.metadata.name], ...view.env, ["KUBERNETES_SERVICE_HOST", "10.96.0.1"], ["KUBERNETES_SERVICE_PORT", "443"], ["HOME", "/root"]];
    if (tool === "printenv" && args[0]) {
      const hit = all.filter(([k]) => k === args[0]);
      // 없는 변수면 printenv 가 exit 1 — kubectl 은 그 종료 코드를 알린다
      return hit.length ? ok(hit.map(([, v]) => v).join("\n")) : fail("command terminated with exit code 1");
    }
    return ok(all.map(([k, v]) => `${k}=${v}`).join("\n"));
  }
  const path = args.find((a) => !a.startsWith("-"));
  if (!path) return fail(`${tool}: 경로가 필요합니다. 예: kubectl exec ${p.metadata.name} -- ${tool} ${tool === "ls" ? "/etc/config" : "/etc/config/GREETING"}`);
  const clean = path.replace(/\/+$/, "");
  if (tool === "cat") {
    const f = view.files.get(clean);
    if (f !== undefined) return ok(f);
    return fail(view.dirs.has(clean) ? `cat: read error: Is a directory` : `cat: can't open '${path}': No such file or directory`);
  }
  if (view.dirs.has(clean)) return ok([...view.files.keys()].filter((f) => f.startsWith(`${clean}/`)).map((f) => f.slice(clean.length + 1)).sort().join("\n"));
  if (view.files.has(clean)) return ok(path);
  return fail(`ls: ${path}: No such file or directory`);
}

/** 값을 받는 옵션 (그 뒤 인자는 대상이 아니다) */
const VALUE_OPTS: Record<string, string[]> = {
  curl: ["-m", "--max-time", "--connect-timeout", "-o", "--output", "-H", "--header", "-X", "--request", "-d", "--data", "-w", "--write-out", "-u", "--user", "-A", "--user-agent", "-e", "--referer"],
  wget: ["-O", "-T", "--timeout", "-U", "--user-agent", "--header"],
  ping: ["-c", "-W", "-w", "-i", "-s", "-t"],
  nslookup: [],
};

/** 도구의 첫 피연산자 (옵션과 그 값을 건너뛴다) — nslookup <이름> [서버] 의 이름, curl <url> -m 5 의 url */
function firstOperand(tool: string, args: string[]): string | undefined {
  const takes = VALUE_OPTS[tool] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (takes.includes(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** kubectl 없이 친 "curl …" 의 대상 URL (값을 받는 옵션은 건너뛴다). curl 로 시작하지 않으면 undefined */
export function curlTarget(line: string): string | undefined {
  const args = tokenize(line.trim());
  if (args[0] !== "curl") return undefined;
  return firstOperand("curl", args.slice(1)) ?? "";
}

/** busybox wget 의 문구 */
function wgetOutput(r: NetResult): string {
  const f = r.failure;
  if (!f) return r.output;
  switch (f.kind) {
    case "dns":
      return `wget: bad address '${f.host}'`;
    case "refused":
      return `wget: can't connect to remote host (${f.ip ?? f.host}): Connection refused`;
    case "timeout":
      return "wget: download timed out";
    case "http": {
      const reason: Record<number, string> = { 404: "Not Found", 502: "Bad Gateway", 503: "Service Unavailable" };
      const code = r.httpStatus ?? 503;
      return `wget: server returned error: HTTP/1.1 ${code} ${reason[code] ?? ""}`.trimEnd();
    }
    case "nohttp":
      return "wget: error getting response: Connection reset by peer";
  }
}

function parseReplicas(s: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new KubectlError(`error: --replicas 는 0~50 사이 정수여야 합니다 (받은 값 "${s}")`);
  return n;
}

function userTrace(c: Cluster, line: string): void {
  const cmd = line.trim().replace(/^(kubectl|k)\s+/, "");
  c.trace.add("user", "user", `kubectl ${cmd}`);
}

// ---------- 표시 도우미 (UI 도 쓴다) ----------

/** kubectl get pods 의 STATUS 칸 (kubectl printPod 의 축소판) */
export function podStatusText(p: Pod): string {
  if (p.metadata.deletionTimestamp !== undefined) return "Terminating";
  let reason: string = p.status.phase;
  for (const cs of p.status.containerStatuses) {
    if ("waiting" in cs.state && cs.state.waiting.reason) reason = cs.state.waiting.reason;
    else if ("terminated" in cs.state) reason = cs.state.terminated.reason || `ExitCode:${cs.state.terminated.exitCode}`;
  }
  return reason;
}

export function podReadyText(p: Pod): string {
  const total = p.spec.containers.length;
  const ready = p.status.containerStatuses.filter((s) => s.ready && "running" in s.state).length;
  return `${ready}/${total}`;
}

export function podRestartsText(p: Pod, now: number): string {
  let n = 0;
  let last: number | undefined;
  for (const cs of p.status.containerStatuses) {
    n += cs.restartCount;
    const ls = cs.lastState;
    if (cs.restartCount > 0 && ls && "terminated" in ls) last = Math.max(last ?? 0, ls.terminated.finishedAt);
  }
  return n > 0 && last !== undefined ? `${n} (${fmtAge(now - last)} ago)` : String(n);
}

export function nodeStatusText(n: Node): string {
  const s = isNodeReady(n) ? "Ready" : n.status.conditions.some((x) => x.type === "Ready") ? "NotReady" : "Unknown";
  return n.spec.unschedulable ? `${s},SchedulingDisabled` : s;
}

export function labelsText(l: Record<string, string>): string {
  const e = Object.entries(l);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join("\n                  ") : "<none>";
}

/** 칸 사이 3칸 (kubectl tabwriter 와 같음) */
export function table(head: string[], rows: string[][]): string {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  return all.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(w[i]! + 3))).join("").trimEnd()).join("\n");
}

function kv(rows: [string, string][], indent = 0): string {
  const pad = " ".repeat(indent);
  return rows.map(([k, v]) => (v === "" ? `${pad}${k}:` : `${pad}${(k + ":").padEnd(Math.max(18, k.length + 2))}${v}`)).join("\n");
}

