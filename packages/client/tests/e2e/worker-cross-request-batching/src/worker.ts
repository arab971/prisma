/**
 * Regression test for https://github.com/prisma/prisma/issues/28732.
 *
 * Validates that batching with a module-level singleton DataLoader on workerd
 * does not settle promises from a different request context. The root cause was
 * `process.nextTick` (polyfilled as `setTimeout` in the workerd build) which can
 * fire after the creating request completed, producing the warning:
 *
 *   "Warning: A promise was resolved or rejected from a different request
 *    context than the one it was created in"
 *
 * and canceled continuations (hung requests).
 */
import { DataLoader } from '@prisma/client/runtime/client'

// ---------- Types matching the prisma RequestHandler DataLoader wiring ----------

type Query = { action: string; modelName: string }
type Tx = { kind: 'batch'; id: string; index: number }
type RequestParams = {
  action: string
  modelName: string
  transaction?: Tx
  index?: number
}

// ---------- Mock engine: async I/O boundary that exercises the batch path ----------

let requestBatchCount = 0
let requestCount = 0
let maxBatchSize = 0

function mockIo(value: unknown): Promise<unknown> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 20))
}

async function engineRequest(query: Query): Promise<{ data: string }> {
  requestCount++
  await mockIo(null)
  return { data: `${query.action}:${query.modelName}` }
}

async function engineRequestBatch(queries: Query[]): Promise<{ data: string }[]> {
  requestBatchCount++
  maxBatchSize = Math.max(maxBatchSize, queries.length)
  await mockIo(null)
  return queries.map((q) => ({ data: `${q.action}:${q.modelName}` }))
}

// ---------- Module-level singleton DataLoader (mirrors prisma's module-level PrismaClient) ----------

const dataloader = new DataLoader<RequestParams>({
  batchLoader: (requests) => engineRequestBatch(requests.map((r) => ({ action: r.action, modelName: r.modelName }))),
  singleLoader: (request) => engineRequest({ action: request.action, modelName: request.modelName }),
  batchBy: (request) => {
    if (request.transaction) {
      return `transaction-${request.transaction.id}`
    }
    return `${request.action}:${request.modelName}`
  },
  batchOrder(requestA, requestB) {
    if (requestA.transaction?.kind === 'batch' && requestB.transaction?.kind === 'batch') {
      return requestA.transaction.index - requestB.transaction.index
    }
    return 0
  },
})

let txCounter = 0

function batchTransaction(queries: Query[]): Promise<{ data: string }[]> {
  const tx: Tx = { kind: 'batch', id: `tx-${++txCounter}`, index: 0 }
  return Promise.all(
    queries.map((q, index) =>
      dataloader.request({ action: q.action, modelName: q.modelName, transaction: { ...tx, index } }),
    ),
  )
}

// ---------- Worker ----------

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/batch') {
      const results = await batchTransaction([
        { action: 'create', modelName: 'User' },
        { action: 'findMany', modelName: 'User' },
      ])
      return Response.json({
        ok: true,
        results,
        stats: { requestBatchCount, requestCount, maxBatchSize },
      })
    }

    if (url.pathname === '/reset') {
      requestBatchCount = 0
      requestCount = 0
      maxBatchSize = 0
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  },
}
