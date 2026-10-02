// 컨테이너 안 앱 흉내: 이미지마다 크기(pull 시간)·시작 시간·크래시 조건·SIGTERM 반응.
// 레지스트리에 없는 이미지는 pull 이 실패한다 (ErrImagePull → ImagePullBackOff).

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
  description: string;
}

export const IMAGES: Record<string, ImageSpec> = {
  "nginx:1.27": { pullMs: 3000, sizeMB: 72, termMs: 300, description: "웹 서버. 잘 뜨고 SIGTERM 에 바로 끝납니다" },
  "nginx:1.28": { pullMs: 3000, sizeMB: 73, termMs: 300, description: "웹 서버 새 버전" },
  "ghcr.io/youseonghyeon/net-sim:latest": { pullMs: 4000, sizeMB: 25, termMs: 300, description: "정적 사이트 (nginx 위 net-sim)" },
  "redis:7": { pullMs: 2500, sizeMB: 45, termMs: 500, description: "인메모리 DB" },
  "example/worker:1.0": {
    pullMs: 2000,
    sizeMB: 30,
    crashAfterMs: 2000,
    exitCode: 1,
    termMs: 100,
    description: "시작 2초 뒤 설정 파일을 못 찾아 exit 1 — CrashLoopBackOff 연습용",
  },
  "example/worker:1.1": { pullMs: 2000, sizeMB: 30, termMs: 100, description: "설정 파일 문제를 고친 버전" },
};

export function imageSpec(image: string): ImageSpec | undefined {
  return IMAGES[image];
}

export const IMAGE_NAMES = Object.keys(IMAGES);
