import { startServer } from './server.ts';

const port = Number(process.env.PORT ?? 3000);
const snapshotDir = process.env.SNAPSHOT_DIR ?? '.data';
const running = await startServer({ port, snapshotDir }) as Awaited<ReturnType<typeof startServer>> & { staticDir: string | null };
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void running.close().then(() => process.exit(0)); });
}
console.log(`服务端已启动 http://localhost:${running.port}  ws://localhost:${running.port}/ws  静态文件：${running.staticDir ?? '未构建'}`);
