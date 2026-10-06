// 컨테이너 안 앱 흉내: 이미지마다 크기(pull 시간)·시작 시간·크래시 조건·SIGTERM 반응.
// 레지스트리에 없는 이미지는 pull 이 실패한다 (ErrImagePull → ImagePullBackOff).
// 자원 사용 모양(메모리·CPU)도 여기서 정한다 — kubelet 이 cgroup OOM·throttling 을, kubectl top 이 실사용을 이것으로 계산한다.

export interface ImageSpec {
  /** 레지스트리에서 받는 데 걸리는 시간(ms) — 학습용으로 줄인 값 */
  pullMs: number;
  sizeMB: number;
  /** 컨테이너 시작 후 앱이 크래시하는 시각(ms). 없으면 계속 돈다 */
  crashAfterMs?: number;
  /** 크래시할 때의 종료 코드 */
  exitCode?: number;
  /** SIGTERM 을 받고 끝나는 데 걸리는 시간(ms). 유예 시간보다 길면 SIGKILL */
  termMs: number;
  /** 앱이 듣는 포트 (없으면 아무 포트도 열지 않음) */
  port?: number;
  /** HTTP 응답 본문 (curl 로 받으면 보이는 것) */
  body?: string;
  /** 시작 후 이만큼 지나야 readiness 가 통과 (앱 준비 시간) */
  warmupMs?: number;
  /**
   * 특별한 앱: ingress-nginx = Host·경로로 Ingress 규칙을 찾아 Pod 로 프록시, tailscale-proxy = Tailscale 오퍼레이터의 프록시(TLS 종료 → Service),
   * echo = 받은 요청의 출발지 IP 를 그대로 돌려줌 (whoami), config = 자기 env 와 마운트된 파일을 보여 줌 (설정 실험용),
   * kv = 요청마다 방문 수를 하나 늘려 /data 에 적는 작은 DB (PVC 가 있으면 노드 디스크에, 없으면 컨테이너 안에 — 데이터가 남는지 보는 용도)
   */
  role?: "ingress-nginx" | "tailscale-proxy" | "echo" | "config" | "kv";
  /** 메모리 사용(MiB): 시작 후 memRampMs 동안 0 에서 memMi 까지 오른다 (기본 20, 램프 1초) */
  memMi?: number;
  memRampMs?: number;
  /** 메모리 누수: 시작 후 1분마다 이만큼 더 쓴다 (MiB) */
  leakMiPerMin?: number;
  /** 앱이 꾸준히 원하는 CPU (millicore, 기본 5) */
  cpuM?: number;
  /** 요청 하나(probe 포함)를 처리하는 CPU 시간 (ms, 원하는 CPU 를 다 받을 때). CPU 를 덜 받으면 그만큼 늘어난다 (기본 2) */
  workMs?: number;
  description: string;
}

export const DEFAULT_MEM_MI = 20;
export const DEFAULT_MEM_RAMP_MS = 1000;
export const DEFAULT_CPU_M = 5;
export const DEFAULT_WORK_MS = 2;

/** 시작 후 elapsed(ms) 지난 컨테이너의 메모리 사용(MiB) — 시간에 대해 줄지 않는다 (OOM 시각을 이분 탐색으로 찾는다) */
export function memoryAt(spec: ImageSpec | undefined, elapsed: number): number {
  const base = spec?.memMi ?? DEFAULT_MEM_MI;
  const ramp = spec?.memRampMs ?? DEFAULT_MEM_RAMP_MS;
  const e = Math.max(0, elapsed);
  return base * Math.min(1, ramp > 0 ? e / ramp : 1) + ((spec?.leakMiPerMin ?? 0) * e) / 60_000;
}

export const IMAGES: Record<string, ImageSpec> = {
  "nginx:1.27": { memMi: 12, cpuM: 2, pullMs: 3000, sizeMB: 72, termMs: 300, port: 80, body: "<title>Welcome to nginx!</title>", description: "웹 서버 (포트 80). 잘 뜨고 SIGTERM 에 바로 끝납니다" },
  "nginx:1.28": { memMi: 12, cpuM: 2, pullMs: 3000, sizeMB: 73, termMs: 300, port: 80, body: "<title>Welcome to nginx!</title> (1.28)", description: "웹 서버 새 버전 (포트 80)" },
  "ghcr.io/youseonghyeon/net-sim:latest": { memMi: 10, cpuM: 1, pullMs: 4000, sizeMB: 25, termMs: 300, port: 8080, body: "<title>net-sim</title>", description: "정적 사이트 (nginx-unprivileged 위 net-sim, 포트 8080)" },
  "registry.k8s.io/ingress-nginx/controller:v1.11.2": {
    memMi: 120,
    cpuM: 20,
    pullMs: 4000,
    sizeMB: 110,
    termMs: 300,
    port: 80,
    body: "",
    role: "ingress-nginx",
    description: "ingress-nginx 컨트롤러: Ingress 규칙(Host·경로)대로 Pod 로 프록시 (포트 80)",
  },
  "tailscale/tailscale:v1.76.6": { memMi: 40, cpuM: 5, pullMs: 3000, sizeMB: 90, termMs: 300, port: 443, body: "", role: "tailscale-proxy", description: "Tailscale 오퍼레이터의 Ingress 프록시: tailnet 기기로 붙어 TLS 를 끝내고 Service 로 보냄" },
  "traefik/whoami:v1.10": { memMi: 6, cpuM: 1, pullMs: 1500, sizeMB: 7, termMs: 100, port: 80, body: "", role: "echo", description: "받은 요청의 출발지 IP·헤더를 그대로 보여 줌 (출발지 IP 보존 실험용)" },
  "redis:7": { memMi: 30, cpuM: 10, pullMs: 2500, sizeMB: 45, termMs: 500, port: 6379, description: "인메모리 DB (포트 6379, HTTP 아님)" },
  "example/api:1.0": {
    memMi: 90,
    cpuM: 20,
    pullMs: 2500,
    sizeMB: 40,
    termMs: 300,
    port: 8080,
    body: '{"status":"ok"}',
    warmupMs: 15_000,
    description: "API 서버 (포트 8080). 시작 후 15초 동안 캐시를 데우느라 /ready 가 503 — readiness probe 연습용",
  },
  "example/api:1.1": { memMi: 90, cpuM: 20, pullMs: 2500, sizeMB: 41, termMs: 300, port: 8080, body: '{"status":"ok","version":"1.1"}', warmupMs: 5_000, description: "API 새 버전 (포트 8080). 준비 시간 5초" },
  "example/api:2.0": {
    memMi: 90,
    cpuM: 20,
    pullMs: 2500,
    sizeMB: 42,
    termMs: 300,
    port: 8080,
    body: '{"status":"ok","version":"2.0"}',
    warmupMs: Number.POSITIVE_INFINITY,
    description: "API 망가진 새 버전: 설정 오류로 /ready 가 계속 503 — 롤아웃이 멈추는 것을 보는 용도",
  },
  "curlimages/curl:8.10.1": { memMi: 4, cpuM: 1, pullMs: 1500, sizeMB: 12, termMs: 100, description: "클라이언트: sleep 으로 떠 있다가 kubectl exec 로 curl 을 보냅니다" },
  "example/worker:1.0": {
    memMi: 15,
    pullMs: 2000,
    sizeMB: 30,
    crashAfterMs: 2000,
    exitCode: 1,
    termMs: 100,
    description: "시작 2초 뒤 설정 파일을 못 찾아 exit 1 — CrashLoopBackOff 연습용",
  },
  "example/worker:1.1": { pullMs: 2000, sizeMB: 30, termMs: 100, description: "설정 파일 문제를 고친 버전" },
  "example/report:1.0": {
    pullMs: 2500,
    sizeMB: 180,
    termMs: 500,
    port: 8080,
    body: '{"report":"ok"}',
    memMi: 320,
    memRampMs: 6000,
    cpuM: 100,
    workMs: 20,
    description: "리포트 API (JVM 흉내, 포트 8080). 시작하며 6초에 걸쳐 힙을 320Mi 까지 잡습니다 — limits.memory 가 그보다 작으면 OOMKilled",
  },
  "example/leaky:1.0": {
    pullMs: 2000,
    sizeMB: 40,
    termMs: 300,
    port: 8080,
    body: '{"status":"ok"}',
    memMi: 80,
    memRampMs: 3000,
    leakMiPerMin: 150,
    cpuM: 20,
    description: "메모리 누수가 있는 API (포트 8080). 80Mi 로 뜬 뒤 1분에 150Mi 씩 늘어납니다 — limits 가 없으면 노드 메모리를 다 먹습니다",
  },
  "example/leaky:1.1": { pullMs: 2000, sizeMB: 40, termMs: 300, port: 8080, body: '{"status":"ok","version":"1.1"}', memMi: 80, memRampMs: 3000, cpuM: 20, description: "누수를 고친 버전 (80Mi 에서 멈춤)" },
  "example/config-app:1.0": {
    pullMs: 1500,
    sizeMB: 20,
    termMs: 200,
    port: 8080,
    body: "",
    role: "config",
    memMi: 20,
    description: "설정을 보여 주는 앱 (포트 8080): env 는 시작할 때 읽은 값, /etc/config 아래 파일은 요청마다 다시 읽은 값을 돌려줍니다",
  },
  "example/kv:1.0": {
    pullMs: 2000,
    sizeMB: 30,
    termMs: 500,
    port: 8080,
    body: "",
    role: "kv",
    memMi: 40,
    warmupMs: 3_000,
    description: "방문 수를 세는 작은 DB (포트 8080): 요청마다 visits 를 하나 늘려 /data 에 적습니다. PVC 를 붙이면 Pod 가 바뀌어도 남고, 없으면 컨테이너가 바뀔 때 사라집니다",
  },
  "example/thumbs:1.0": {
    pullMs: 2000,
    sizeMB: 60,
    termMs: 300,
    port: 8080,
    body: '{"thumbnail":"ok"}',
    memMi: 60,
    cpuM: 600,
    workMs: 150,
    description: "썸네일 API (포트 8080). 이미지를 줄이느라 CPU 를 600m 쯤 계속 원하고, 요청 하나에 CPU 150ms 가 듭니다 — cpu limit 이 낮으면 느려집니다",
  },
};

export function imageSpec(image: string): ImageSpec | undefined {
  // net-sim 은 CI 가 커밋 SHA 로 태그를 단다 → 어떤 태그든 같은 앱
  if (image.startsWith("ghcr.io/youseonghyeon/net-sim:")) return IMAGES["ghcr.io/youseonghyeon/net-sim:latest"];
  return IMAGES[image];
}

export const IMAGE_NAMES = Object.keys(IMAGES);
