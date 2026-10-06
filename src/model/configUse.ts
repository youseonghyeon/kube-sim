// ConfigMap·Secret 을 누가 어떻게 쓰나 (인스펙터의 "쓰는 곳") — env 와 volume 은 바뀔 때 반영되는 방식이 달라 나눠 보인다.
import type { Container, Pod, PodSpec } from "../core/api/types";

export type ConfigKind = "ConfigMap" | "Secret";

export interface ConfigUse {
  /** env 로 읽음 (envFrom 또는 valueFrom — 시작할 때 한 번) */
  env: string[];
  /** 파일로 마운트 (잠시 뒤 갱신) */
  volume: string[];
  /** subPath 로 파일 하나 (갱신 안 됨) */
  subPath: string[];
}

/** 컨테이너 하나가 이 ConfigMap·Secret 을 쓰는 방식. 쓰지 않으면 undefined */
export function configUse(spec: PodSpec, kind: ConfigKind, name: string): ConfigUse | undefined {
  const out: ConfigUse = { env: [], volume: [], subPath: [] };
  const c: Container | undefined = spec.containers[0];
  if (!c) return undefined;
  for (const f of c.envFrom ?? []) if ((kind === "ConfigMap" ? f.configMapRef?.name : f.secretRef?.name) === name) out.env.push("envFrom (모든 키)");
  for (const e of c.env ?? []) {
    const ref = kind === "ConfigMap" ? e.valueFrom?.configMapKeyRef : e.valueFrom?.secretKeyRef;
    if (ref?.name === name) out.env.push(`${e.name} ← ${ref.key}`);
  }
  const vols = new Set((spec.volumes ?? []).filter((v) => (kind === "ConfigMap" ? v.configMap?.name : v.secret?.secretName) === name).map((v) => v.name));
  for (const m of c.volumeMounts ?? []) {
    if (!vols.has(m.name)) continue;
    if (m.subPath) out.subPath.push(`${m.mountPath} (${m.subPath})`);
    else out.volume.push(m.mountPath);
  }
  return out.env.length || out.volume.length || out.subPath.length ? out : undefined;
}

export function configUsers(pods: Pod[], kind: ConfigKind, name: string): { pod: Pod; use: ConfigUse }[] {
  return pods.flatMap((pod) => {
    const use = configUse(pod.spec, kind, name);
    return use ? [{ pod, use }] : [];
  });
}
