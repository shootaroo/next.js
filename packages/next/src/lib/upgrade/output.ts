import type { Writable } from 'stream'
import type { ChildProcess } from 'child_process'

// The CLI owns the menu; the workload owns its real TTY and Node buffers.
// Permanent release survives callbacks; temporary release corks again afterward.
let corked = false
let managed = false
let released = false
let outputLimitCheck: ReturnType<typeof setInterval> | null = null

// Nested callbacks borrow one terminal permission until every writer finishes.
let temporaryOutput: Promise<void> | null = null
let outputUsers = 0

// Worker output must keep flowing without waiting for a corked destination.
// These sets switch existing pipes and wake callbacks when output is released.
const workerReleases = new Set<() => void>()
const workerHolds = new Set<() => void>()
const releaseListeners = new Set<() => void>()
export function withUpgradeTemporaryOutput(child: ChildProcess) {
  // The caller hides the prompt before granting the terminal. A queued writer
  // may exit while another owns it; otherwise wait until the child's trailing
  // writes finish before allowing the prompt to resume.
  if (!child.connected) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const finish = (error: Error | null) => {
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onExit = () => finish(null)
    const onMessage = (message: {
      nextUpgradeOutputDone: boolean | undefined
    }) => {
      if (message?.nextUpgradeOutputDone) {
        finish(null)
      }
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
    // This release is temporary: the child will cork again after its callbacks
    // finish and acknowledge with nextUpgradeOutputDone before the menu resumes.
    child.send(
      { nextUpgradeContinue: true, nextUpgradeTemporary: true },
      (error: Error | null) => {
        if (error) {
          finish(error)
        }
      }
    )
  })
}
export function corkUpgradeOutput() {
  // Own one cork level only. Repeated requests must not require extra uncorks,
  // and a permanently released process must keep its output visible.
  if (corked || released) {
    return
  }

  corked = true
  process.stdout.cork()
  process.stderr.cork()

  // Check the existing Node buffers, including native and worker writes. Ask
  // the parent to close the menu before releasing logs; never print over it.
  outputLimitCheck = setInterval(() => {
    if (
      process.stdout.writableLength + process.stderr.writableLength <
      10 * 1024 * 1024
    ) {
      return
    }
    clearInterval(outputLimitCheck!)
    outputLimitCheck = null
    if (process.connected && process.send) {
      process.send({ nextUpgradeOutputLimit: true }, (error: Error | null) => {
        if (error) {
          uncorkUpgradeOutput()
          console.error('Could not release buffered workload output:', error)
        }
      })
    } else {
      uncorkUpgradeOutput()
    }
  }, 1000)
  // This is a coarse memory safeguard; it must not keep an otherwise idle
  // process alive. A burst can exceed the threshold between checks.
  outputLimitCheck.unref()

  // Existing worker pipes must keep reading while our destination is corked;
  // otherwise Node backpressure can pause the workers' actual work.
  for (const hold of workerHolds) {
    hold()
  }
}
export function handleUpgradeOutputMessages() {
  // Supervise config loading without holding its writes. Only the workload
  // entry point calls this; descendants must keep producing their own output.
  managed = true

  process.on(
    'message',
    (message: {
      nextUpgradeContinue: boolean | undefined
      nextUpgradeTemporary: boolean | undefined
    }) => {
      if (message?.nextUpgradeContinue) {
        // Skip releases permanently. A callback borrowing the terminal leaves
        // released false so it can cork again once its live writes are done.
        if (!message.nextUpgradeTemporary) {
          released = true
        }
        uncorkUpgradeOutput()
      }
    }
  )
  process.once('disconnect', () => {
    // Release even an exit already awaiting permission: the parent can no
    // longer acknowledge, and temporary writers must not capture output again.
    released = true
    uncorkUpgradeOutput()
    void flushUpgradeOutput()
      .then(() => process.exit(1))
      .catch((error) => {
        console.error('Could not flush workload output before exit:', error)
        process.exit(1)
      })
  })
}
export async function requestUpgradeOutput(temporary: boolean) {
  if (!corked) {
    return
  }

  // The parent must leave the menu before this child writes to the terminal.
  // A disconnected parent cannot acknowledge; favor visibility in that case.
  if (process.connected && process.send) {
    process.send(
      { nextUpgradeOutput: temporary ? 'temporary' : true },
      (error: Error | null) => {
        if (error) {
          uncorkUpgradeOutput()
          console.error(
            'Could not request the terminal for workload output:',
            error
          )
        }
      }
    )
    await waitForUpgradeOutput()
  } else {
    uncorkUpgradeOutput()
  }
}
export async function withUpgradeOutput<T>(write: () => Promise<T>) {
  if (!corked && !temporaryOutput) {
    return write()
  }

  // Config callbacks can await stdout write callbacks, which cannot finish
  // while corked. Borrow the terminal rather than stall those callbacks.
  // Nested calls share the same permission and keep the menu hidden until all
  // callbacks and their trailing writes finish.
  outputUsers++
  temporaryOutput ??= requestUpgradeOutput(true)
  try {
    await temporaryOutput
    return await write()
  } finally {
    try {
      await flushUpgradeOutput()
    } finally {
      if (--outputUsers === 0) {
        temporaryOutput = null
        if (process.connected && process.send) {
          if (!released) {
            corkUpgradeOutput()
          }
          process.send({ nextUpgradeOutputDone: true })
        }
      }
    }
  }
}
export function pipeWorkerOutput(
  source: NodeJS.ReadableStream,
  destination: Writable
) {
  if (!managed) {
    source.pipe(destination, { end: false })
    return
  }

  // A normal pipe pauses when the corked destination reaches its high-water
  // mark. Keep consuming workers while the terminal belongs to the prompt.
  const forward = (chunk: Buffer) => {
    destination.write(chunk)
  }
  let forwarding = false

  // Replace pipe() while holding output: write(false) must not pause the source
  // just because the destination buffers logs for a still-running workload.
  const hold = () => {
    if (forwarding) {
      return
    }
    forwarding = true
    source.unpipe(destination)
    source.on('data', forward)
    source.resume()
  }
  const cleanup = () => {
    source.off('data', forward)
    source.off('end', cleanup)
    source.off('close', cleanup)
    workerReleases.delete(release)
    workerHolds.delete(hold)
  }

  // Once output is live, restore pipe() and its usual backpressure. Pause while
  // switching listeners so a chunk is neither dropped nor forwarded twice.
  const release = () => {
    if (!forwarding) {
      return
    }
    forwarding = false
    source.pause()
    source.off('data', forward)
    if (source.readable) {
      source.pipe(destination, { end: false })
    }
  }

  // Register both transitions because a pipe may be created before corking or
  // during a temporary release. Remove its callbacks when the source finishes.
  workerReleases.add(release)
  workerHolds.add(hold)
  if (corked) {
    hold()
  } else {
    source.pipe(destination, { end: false })
  }
  source.once('end', cleanup)
  source.once('close', cleanup)
}
export function uncorkUpgradeOutput() {
  if (!corked) {
    return
  }

  // Switch listeners synchronously so every chunk uses exactly one forwarding
  // path, then release only the cork level owned by this feature.
  corked = false
  if (outputLimitCheck) {
    clearInterval(outputLimitCheck)
    outputLimitCheck = null
  }
  for (const release of workerReleases) {
    release()
  }

  // TODO: Separate stream buffers preserve each stream's order, but releasing
  // stdout first can show its later logs before earlier stderr errors. Consider
  // a shared ordered buffer if preserving cross-stream chronology is needed.
  process.stdout.uncork()
  process.stderr.uncork()

  // Release promises only after changing stream state, so resumed callbacks
  // can safely write immediately instead of waiting on another corked write.
  for (const release of releaseListeners) {
    release()
  }
  releaseListeners.clear()
}
export function waitForUpgradeOutput() {
  if (!corked) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    releaseListeners.add(resolve)
  })
}
export async function flushUpgradeOutput() {
  uncorkUpgradeOutput()

  // Uncork starts flushing; it does not mean the writes have finished. Empty
  // trailing writes act as barriers without closing the inherited streams.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) => {
          stream.write('', (error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
    )
  )
}
