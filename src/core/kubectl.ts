// kubectl 흉내: 문자열 명령 → API 호출 + 실제와 같은 모양의 출력. 코어 API 위의 얇은 층이다.
// 축소판: default 네임스페이스만, 자주 쓰는 하위 명령·플래그만.
import { ApiError } from "./api/server";
import { controllerOf, isNodeReady, isPodReady, podRequests, type KEvent, type Kind, type Node, type Pod } from "./api/types";
import { deployment, type Cluster } from "./cluster";
import { deploymentHash, HASH_LABEL } from "./controllers/deployment";
import { nodeUsage } from "./scheduler";
import { fmtAge, fmtClock, fmtCpu, fmtMem, parseCpu, parseMem } from "./units";

export interface KubectlResult {
  ok: boolean;
  output: string;
  /** 클러스터를 바꾸는 명령이었는지 (UI 가 다시 그린다) */
  mutated: boolean;
}

export const KUBE_VERSION = "v1.31.0";

const RESOURCE_ALIASES: Record<string, Kind | "Event" | "all"> = {
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
  ev: "Event",
  event: "Event",
  events: "Event",
  all: "all",
};

const KIND_PREFIX: Record<Kind, string> = { Pod: "pod", Deployment: "deployment.apps", ReplicaSet: "replicaset.apps", Node: "node" };
const KIND_PLURAL: Record<Kind, string> = { Pod: "pods", Deployment: "deployments.apps", ReplicaSet: "replicasets.apps", Node: "nodes" };

export const KUBECTL_HELP = [
  "쓸 수 있는 명령 (축소판 — default 네임스페이스):",
  "  kubectl get pods [-o wide] | deploy | rs | nodes [-o wide] | events | all",
  "  kubectl describe pod|deploy|rs|node <이름>",
  "  kubectl create deployment <이름> --image=<이미지> [--replicas=N]",
  "  kubectl scale deployment/<이름> --replicas=N",
  "  kubectl set image deployment/<이름> <컨테이너>=<이미지>",
  "  kubectl set resources deployment/<이름> --requests=cpu=500m,memory=256Mi",
  "  kubectl delete pod|deploy|rs <이름>   (pod 는 --force --grace-period=0 로 강제)",
  "  kubectl cordon|uncordon <노드>",
].join("\n");

export function runKubectl(cluster: Cluster, line: string): KubectlResult {
  const args = tokenize(line.trim());
  if (args[0] === "kubectl" || args[0] === "k") args.shift();
  if (!args.length) return fail("kubectl 다음에 명령을 쓰세요. 예: kubectl get pods\n\n" + KUBECTL_HELP);
  const { pos, flags } = parseFlags(args);
  const cmd = pos.shift()!;
  const ns = flags.get("n");
  if (ns !== undefined && ns !== "default") {
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
      case "create":
        return create(cluster, pos, flags, line);
      case "scale":
        return scale(cluster, pos, flags, line);
      case "set":
        return setCmd(cluster, pos, flags, line);
      case "delete":
        return del(cluster, pos, flags, line);
      case "cordon":
      case "uncordon":
        return cordon(cluster, cmd, pos, line);
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

function tokenize(s: string): string[] {
  return s.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

function parseFlags(args: string[]): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-o" || a === "-n") {
      flags.set(a.slice(1), args[++i] ?? "");
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (["replicas", "image", "requests", "grace-period"].includes(a.slice(2)) && args[i + 1] && !args[i + 1]!.startsWith("-")) flags.set(a.slice(2), args[++i]!);
      else flags.set(a.slice(2), "true");
    } else if (a.startsWith("-o")) flags.set("o", a.slice(2));
    else pos.push(a);
  }
  return { pos, flags };
}

/** "deployment/web" 또는 "deployment web" → [Kind, 이름들] */
function resourceArgs(pos: string[]): { kind: Kind | "Event" | "all"; names: string[] } {
  const first = pos[0];
  if (!first) throw new KubectlError("error: You must specify the type of resource to get. 예: kubectl get pods");
  if (first.includes("/")) {
    const [r, n] = first.split("/");
    return { kind: resolveKind(r!), names: [n!, ...pos.slice(1)] };
  }
  return { kind: resolveKind(first), names: pos.slice(1) };
}

function resolveKind(r: string): Kind | "Event" | "all" {
  const k = RESOURCE_ALIASES[r.toLowerCase()];
  if (!k) throw new KubectlError(`error: the server doesn't have a resource type "${r}"`);
  return k;
}

function needWorkload(kind: Kind | "Event" | "all", allowed: Kind[], verb: string): Kind {
  if (kind === "Event" || kind === "all" || !allowed.includes(kind)) throw new KubectlError(`error: ${verb} 는 ${allowed.map((k) => KIND_PLURAL[k]).join("·")} 에만 쓸 수 있습니다 (축소판)`);
  return kind;
}

// ---------- get ----------

function get(c: Cluster, pos: string[], flags: Map<string, string>): string {
  const { kind, names } = resourceArgs(pos);
  const wide = flags.get("o") === "wide";
  if (flags.has("o") && !wide) throw new KubectlError(`error: 출력 형식 "${flags.get("o")}" 는 아직 없습니다 (wide 만). YAML 은 인스펙터의 YAML 탭에서 보세요`);
  if (kind === "all") {
    const parts = [getPods(c, [], false, true), getDeploys(c, [], true), getRs(c, [], true)].filter(Boolean);
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
  }
}

function pick<T extends { metadata: { name: string } }>(c: Cluster, kind: Kind, items: T[], names: string[]): T[] {
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
  const k = needWorkload(kind, ["Pod", "Deployment", "ReplicaSet", "Node"], "describe");
  const name = names[0];
  if (!name) throw new KubectlError(`error: 이름을 함께 쓰세요. 예: kubectl describe ${k.toLowerCase()} <이름>`);
  const o = c.api.get(k, name, "default");
  if (!o) throw new ApiError("NotFound", `${KIND_PLURAL[k]} "${name}" not found`);
  switch (o.kind) {
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
        ["Replicas", `${o.spec.replicas} desired | ${s.updatedReplicas} updated | ${s.replicas} total | ${s.availableReplicas} available | ${Math.max(0, s.replicas - s.availableReplicas)} unavailable`],
        ["StrategyType", "Recreate (축소판 — 롤링 업데이트는 3단계)"],
        ["Pod Template", ""],
        ...templateLines(o.spec.template.spec.containers[0]),
        ["OldReplicaSets", rss.filter((r) => r !== cur).map((r) => `${r.metadata.name} (${r.status.replicas}/${r.spec.replicas} replicas created)`).join(", ") || "<none>"],
        ["NewReplicaSet", cur ? `${cur.metadata.name} (${cur.status.replicas}/${cur.spec.replicas} replicas created)` : "<none>"],
      ]) + eventsBlock(c, o.metadata.uid);
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
    sub.push(["Requests", ""], ["  cpu", fmtCpu(ct.resources.requests.cpu)], ["  memory", fmtMem(ct.resources.requests.memory)]);
    out += `\n  ${ct.name}:\n` + kv(sub, 4);
  }
  out += "\nConditions:\n" + table(["  Type", "Status"], ["PodScheduled", "Initialized", "ContainersReady", "Ready"].flatMap((t) => {
    const cond = p.status.conditions.find((x) => x.type === t);
    return cond ? [[`  ${t}`, cond.status]] : [];
  }));
  const reqs = podRequests(p.spec);
  out += `\nQoS Class:        Burstable (requests 만 있음 — cpu ${fmtCpu(reqs.cpu)}, memory ${fmtMem(reqs.memory)})`;
  if (p.spec.nodeSelector) out += `\nNode-Selectors:   ${labelsText(p.spec.nodeSelector)}`;
  return out + eventsBlock(c, p.metadata.uid);
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
    ["Taints", (n.spec.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`).join(", ") || (n.spec.unschedulable ? "node.kubernetes.io/unschedulable:NoSchedule" : "<none>")],
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
        ["  Namespace", "Name", "CPU Requests", "Memory Requests", "Age"],
        pods.map((p) => {
          const r = podRequests(p.spec);
          return [`  ${p.metadata.namespace ?? "default"}`, p.metadata.name, `${fmtCpu(r.cpu)} (${pct(r.cpu, a.cpu)})`, `${fmtMem(r.memory)} (${pct(r.memory, a.memory)})`, fmtAge(c.now - p.metadata.creationTimestamp)];
        }),
      )
    : "  (없음)";
  out += "\nAllocated resources:\n" + table(["  Resource", "Requests"], [
    ["  cpu", `${fmtCpu(usage.requested.cpu)} (${pct(usage.requested.cpu, a.cpu)})`],
    ["  memory", `${fmtMem(usage.requested.memory)} (${pct(usage.requested.memory, a.memory)})`],
  ]);
  return out + eventsBlock(c, n.metadata.uid);
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

function create(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
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

function scale(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Deployment", "ReplicaSet"], "scale");
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
  if (!req) throw new KubectlError("error: --requests=cpu=500m,memory=256Mi 처럼 쓰세요");
  let cpu: number | undefined;
  let mem: number | undefined;
  for (const part of req.split(",")) {
    const [key, val] = part.split("=");
    if (key === "cpu") cpu = parseCpu(val ?? "");
    else if (key === "memory") mem = parseMem(val ?? "");
    else throw new KubectlError(`error: 알 수 없는 자원 "${key}" (cpu, memory)`);
    if ((key === "cpu" && cpu === undefined) || (key === "memory" && mem === undefined)) throw new KubectlError(`error: "${part}" 를 읽지 못했습니다 (cpu=500m · memory=256Mi 처럼)`);
  }
  userTrace(c, line);
  c.api.patch("Deployment", name, "default", "kubectl", (o) => {
    for (const ct of o.spec.template.spec.containers) {
      if (cpu !== undefined) ct.resources.requests.cpu = cpu;
      if (mem !== undefined) ct.resources.requests.memory = mem;
    }
  });
  return ok(`deployment.apps/${name} resource requirements updated`, true);
}

function del(c: Cluster, pos: string[], flags: Map<string, string>, line: string): KubectlResult {
  const { kind, names } = resourceArgs(pos);
  const k = needWorkload(kind, ["Pod", "Deployment", "ReplicaSet"], "delete");
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
  return rows.map(([k, v]) => (v === "" ? `${pad}${k}:` : `${pad}${(k + ":").padEnd(18)}${v}`)).join("\n");
}

