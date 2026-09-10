# 多阶段构建：先装依赖并打包前端，运行镜像只带服务端源码和前端产物。
FROM node:22-alpine AS build
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

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@12 --activate
WORKDIR /app
ENV NODE_ENV=production PORT=3000 SNAPSHOT_DIR=/data
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json ./
COPY --from=build /app/packages/engine packages/engine
COPY --from=build /app/packages/protocol packages/protocol
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --prod=false --filter @shengji/server... && pnpm store prune
EXPOSE 3000
VOLUME ["/data"]
CMD ["pnpm", "--filter", "@shengji/server", "start"]
