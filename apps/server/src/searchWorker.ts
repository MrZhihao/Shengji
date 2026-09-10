/** 搜索工作线程：收到一批种子就跑采样，回传各候选的累计收益。 */
import { parentPort } from 'node:worker_threads';
import { runSearchBatch, type SearchBatchJob } from '@shengji/engine';

interface Request { readonly id: number; readonly job: SearchBatchJob }

parentPort?.on('message', (req: Request) => {
  try {
    const result = runSearchBatch(req.job);
    parentPort?.postMessage({ id: req.id, result });
  } catch (err) {
    parentPort?.postMessage({ id: req.id, error: (err as Error).message });
  }
});
