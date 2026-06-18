// Generic warm browser-page pool. Hands out up to `max` reusable pages, booting
// lazily and REUSING warm ones so we never pay the cold Chromium start per
// request (the thing that made fetches slow). acquire() returns { page, release }
// and waits in FIFO order when all `max` pages are busy — so a handful of users
// run in parallel instead of queuing behind a single global lock. Idle pages
// close after `idleMs` to give memory back. Each platform gets its own pool, so
// concurrent fetches never collide on a shared page.

export function createPagePool({ name, max = 2, boot, idleMs = 10 * 60 * 1000 }) {
  const freeHandles = []   // warm, idle: { page, browser }
  const waiters = []       // queued acquire() resolvers, FIFO
  let total = 0            // booted handles (idle + in use)
  let idleTimer = null

  function armIdle() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(closeIdle, idleMs)
    if (idleTimer && idleTimer.unref) idleTimer.unref()
  }
  async function closeIdle() {
    while (freeHandles.length) {
      const h = freeHandles.pop()
      total--
      try { await h.browser?.close() } catch {}
    }
  }

  function lend(h) {
    let done = false
    return {
      page: h.page,
      // Return the page to the pool. Pass broken=true to discard it (closed,
      // crashed, or left in a bad state) so the next caller gets a fresh one.
      release(broken = false) {
        if (done) return
        done = true
        if (broken || !h.page || h.page.isClosed()) {
          total--
          try { h.browser?.close() } catch {}
        } else {
          freeHandles.push(h)
          armIdle()
        }
        const w = waiters.shift()
        if (w) acquire().then(w.resolve, w.reject)
      },
    }
  }

  async function acquire() {
    // 1) reuse a warm page
    while (freeHandles.length) {
      const h = freeHandles.pop()
      if (h.page && !h.page.isClosed()) return lend(h)
      total--
      try { await h.browser?.close() } catch {}
    }
    // 2) boot a new one if under the cap
    if (total < max) {
      total++
      try {
        const h = await boot()
        return lend(h)
      } catch (e) {
        total--
        throw e
      }
    }
    // 3) all busy → wait for a release (FIFO)
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  }

  return {
    acquire,
    stats: () => ({ name, max, total, free: freeHandles.length, waiting: waiters.length }),
    async drain() { waiters.length = 0; await closeIdle() },
  }
}
