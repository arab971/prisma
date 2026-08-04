import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $ } from 'zx'

import { executeSteps } from '../_utils/executeSteps'
import { waitForWranglerReady } from '../_utils/wrangler'

const wranglerLogPath = join(tmpdir(), 'wrangler-cross-request-batching.log')

void executeSteps({
  setup: async () => {
    await $`pnpm install`
  },
  test: async () => {
    // Clear the log before each run
    writeFileSync(wranglerLogPath, '')

    // Start wrangler and tee its output to a file so we can assert no
    // cross-request-context warnings after the test finishes.
    const wranglerProcess =
      $`pnpm wrangler dev --ip 127.0.0.1 --port 8787 src/worker.ts 2>&1 | tee ${wranglerLogPath}`.nothrow()

    try {
      await waitForWranglerReady(wranglerProcess)

      // Small delay for workerd to be fully ready
      await new Promise((r) => setTimeout(r, 500))

      // Run the jest tests that exercise the concurrent batch path
      await $`pnpm exec jest --verbose`
    } finally {
      // SIGINT the process group (wrangler + tee)
      await wranglerProcess.kill('SIGINT')
      try {
        await wranglerProcess
      } catch {
        // expected – SIGINT causes a non-zero exit
      }
    }
  },
  finish: async () => {
    await $`echo "done"`
  },
})
