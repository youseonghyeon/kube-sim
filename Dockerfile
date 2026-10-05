# syntax=docker/dockerfile:1
# 정적 SPA: vite build 결과(dist/)를 nginx(비특권, 8080)로 서빙한다.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
# 타입 검사와 테스트는 CI 게이트에서 먼저 돈다. 여기서는 번들만 만든다.
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
