import { Cluster, deployment } from "../src/core/cluster";
import type { NodeDef } from "../src/core/kubelet";
import { podStatusText } from "../src/core/kubectl";
import type { TraceKind } from "../src/core/trace";

export function cluster(nodes: (Partial<NodeDef> & { name: string })[] = [{ name: "worker-1" }, { name: "worker-2" }]): Cluster {
  const c = new Cluster();
  for (const n of nodes) c.addNode({ cpu: 2000, memory: 4096, ...n });
  c.runToIdle();
  return c;
}

export function web(replicas = 3, image = "nginx:1.27", cpu = 250, memory = 128) {
  return deployment("web", { replicas, image, cpu, memory });
}

/** api.* 를 뺀 트레이스 종류 (컴포넌트의 결정만) */
export function decisions(c: Cluster, from = 0): TraceKind[] {
  return c.trace.kinds(from).filter((k) => !k.startsWith("api."));
}

export function pods(c: Cluster) {
  return c.api.list("Pod", "default");
}

export function statuses(c: Cluster): string[] {
  return pods(c).map(podStatusText);
}
