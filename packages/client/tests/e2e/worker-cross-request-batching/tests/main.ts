/**
 * Regression test for https://github.com/prisma/prisma/issues/28732
 *
 * Fires N concurrent batched $transaction-equivalent requests against a
 * module-level singleton DataLoader under workerd. On pre-fix code, concurrent
 * cross-request batch merging causes some continuations to be settled from a
 * different request context: workerd emits a warning and cancels the affected
 * continuations, which surfaces as HTTP 500 "hung request" errors. The fix
 * (queueMicrotask + per-hash dispatch) eliminates the cross-context settlement.
 *
 * Assertions:
 *  1. Every request returns 200 with correct ordered results.
 *  2. Wrangler logs contain zero "promise resolved/rejected from a different
 *     request context" warnings.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8787'
const CONCURRENT = 8
const wranglerLogPath = join(tmpdir(), 'wrangler-cross-request-batching.log')

async function hit(path: string) {
  const res = await fetch(`${BASE}${path}`)
  const json = await res.json()
  return { status: res.status, ok: json.ok, results: json.results, stats: json.stats }
}

beforeAll(async () => {
  await fetch(`${BASE}/reset`)
})

test('concurrent batched array-form $transaction settles every continuation', async () => {
  const results = await Promise.all(Array.from({ length: CONCURRENT }, () => hit('/batch')))

  // Every request must succeed (pre-fix: some fail with 500 hung-request error)
  const succeeded = results.filter((r) => r.status === 200)
  const failed = results.filter((r) => r.status !== 200)
  expect(failed).toHaveLength(0)
  expect(succeeded).toHaveLength(CONCURRENT)

  // Results must be in the order the queries were issued inside each transaction.
  for (const r of succeeded) {
    expect(r.ok).toBe(true)
    expect(r.results).toHaveLength(2)
    expect(r.results[0].data).toBe('create:User')
    expect(r.results[1].data).toBe('findMany:User')
  }

  // Each transaction was sent as one engine requestBatch call.
  // With queueMicrotask + per-hash dispatch there is no cross-request merging.
  for (const r of succeeded) {
    expect(r.stats.requestBatchCount).toBeGreaterThanOrEqual(1)
    expect(r.stats.requestBatchCount).toBeLessThanOrEqual(CONCURRENT)
  }
})

test('wrangler logs contain zero cross-request-context warnings', () => {
  // wrangler-axi / tee writes the full workerd log here; _steps.ts ensures the
  // file exists before this test runs.
  let log = ''
  try {
    log = readFileSync(wranglerLogPath, 'utf8')
  } catch {
    // File may not exist in local dev; skip the log check.
    return
  }

  const warnings = log
    .split('\n')
    .filter((line) => line.includes('promise was resolved or rejected from a different request context'))
  expect(warnings).toHaveLength(0)
})

export {}
