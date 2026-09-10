# 多阶段构建：build 阶段装依赖并打包前端；运行镜像直接带走整棵已安装好的工作区，避免运行时再解析依赖。
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@12 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @shengji/web build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SNAPSHOT_DIR=/data
COPY --from=build /app /app
EXPOSE 3000
VOLUME ["/data"]
# 直接用 tsx 启动，避免每次冷启动都去下载 pnpm
CMD ["node_modules/.bin/tsx", "apps/server/src/index.ts"]
