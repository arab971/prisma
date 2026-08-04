# worker-cross-request-batching

Regression test for [prisma#28732](https://github.com/prisma/prisma/issues/28732).

Exercises the DataLoader batch path under real workerd with concurrent requests
using a module-level singleton DataLoader (mirrors a module-level PrismaClient).
Pre-fix, some continuations are settled from a different request context, causing
workerd to emit:

    Warning: A promise was resolved or rejected from a different request context

and cancel the affected continuations (HTTP 500 "hung request" errors).

The fix (`queueMicrotask` + per-hash dispatch) eliminates the cross-context
settlement and all failures.
