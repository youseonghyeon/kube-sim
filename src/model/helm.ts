// helm upgrade 흉내 (예제 "Helm 의 checksum/config"): values 의 설정으로 ConfigMap 을 다시 그리고,
// 차트가 checksum/config 를 다는 경우 Pod 템플릿 주석에 설정 내용의 해시를 넣는다 — 설정이 바뀌면 템플릿이 바뀌어 롤아웃된다.
import type { ConfigMapManifest, DeploymentManifest } from "../core/cluster";
import { stableJson, templateHash } from "../core/rng";
import type { ClusterDef, TryAction } from "./examples";

export const CHECKSUM_ANNOTATION = "checksum/config";

type HelmUpgrade = Extract<TryAction, { type: "helm-upgrade" }>;

export function helmUpgrade(def: ClusterDef, a: HelmUpgrade): ClusterDef {
  const next = structuredClone(def);
  const cm = next.manifests.find((m): m is ConfigMapManifest => m.kind === "ConfigMap" && m.metadata.name === a.configMap);
  const d = next.manifests.find((m): m is DeploymentManifest => m.kind === "Deployment" && m.metadata.name === a.deployment);
  if (!cm || !d) return def;
  cm.data = { ...a.data };
  const ann = { ...(d.spec.template.metadata.annotations ?? {}) };
  if (a.checksum) ann[CHECKSUM_ANNOTATION] = templateHash(stableJson(cm.data));
  else delete ann[CHECKSUM_ANNOTATION];
  if (Object.keys(ann).length) d.spec.template.metadata.annotations = ann;
  else delete d.spec.template.metadata.annotations;
  return next;
}

/** 지금 할 수 없으면 이유 */
export function helmUpgradeBlocked(def: ClusterDef, a: HelmUpgrade): string | undefined {
  const cm = def.manifests.find((m): m is ConfigMapManifest => m.kind === "ConfigMap" && m.metadata.name === a.configMap);
  const d = def.manifests.find((m): m is DeploymentManifest => m.kind === "Deployment" && m.metadata.name === a.deployment);
  if (!cm) return `ConfigMap ${a.configMap} 매니페스트가 없습니다`;
  if (!d) return `Deployment ${a.deployment} 매니페스트가 없습니다`;
  const same = stableJson(cm.data) === stableJson(a.data) && (d.spec.template.metadata.annotations?.[CHECKSUM_ANNOTATION] !== undefined) === a.checksum;
  return same ? "이미 그 값입니다" : undefined;
}
