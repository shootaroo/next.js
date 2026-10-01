import type { Writable } from 'stream'
import { spawnSync, type ChildProcess } from 'child_process'

// The parent owns the menu; the work process keeps its real TTY and buffers
// writes in its own stdout/stderr. IPC carries permission to print, not logs.
// These flags are separate: supervision survives Skip, corking can be temporary,
// and a permanent release prevents later callbacks from holding output again.
let corked = false
let managed = false
let released = false
let outputLimitCheck: ReturnType<typeof setInterval> | null = null

// Several callbacks may need live output at once. Share one permission request
// and return the terminal to the menu only after the last callback finishes.
let temporaryOutput: Promise<void> | null = null
let outputUsers = 0

// Worker pipes switch between normal forwarding and consuming held output.
// Separate listeners wake callers waiting for the child's streams to uncork.
const workerReleases = new Set<() => void>()
const workerHolds = new Set<() => void>()
const releaseListeners = new Set<() => void>()

// A controlled exit stops owned resources and flushes once, even if multiple
// errors or signals ask to exit. Upgrade instead force-kills from the parent.
const cleanups = new Set<() => Promise<unknown>>()
let stopping: Promise<void> | null = null
let exiting: Promise<never> | null = null

// Keep retired children from receiving more signals through stale callbacks.
const killedWork = new WeakSet<ChildProcess>()

export function signalUpgradeWork(
  child: ChildProcess,
  signal: 'SIGINT' | 'SIGTERM'
) {
  if (!child.pid || killedWork.has(child)) {
    return
  }

  // The detached POSIX group no longer receives terminal interrupts. Give
  // plugins and subprocesses the same cleanup opportunity as their owner.
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  } else if (child.connected) {
    // Windows OS signals bypass JavaScript cleanup; ask the owner over IPC.
    child.send({ nextUpgradeStop: signal })
  } else {
    child.kill(signal)
  }
}

export function forwardUpgradeResize(child: ChildProcess) {
  if (process.platform === 'win32' || !child.pid) {
    return
  }

  // Detached workloads inherit the TTY but do not receive its foreground
  // signals. Notify the whole group so workers also refresh their dimensions.
  const pid = child.pid
  const onResize = () => {
    if (killedWork.has(child)) {
      return
    }
    try {
      process.kill(-pid, 'SIGWINCH')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  process.on('SIGWINCH', onResize)

  // Each replacement owns its listener; closure removes it before handoff or
  // restart, including when spawning the workload fails.
  child.once('close', () => process.off('SIGWINCH', onResize))
}

export function killUpgradeWork(child: ChildProcess) {
  if (!child.pid || killedWork.has(child)) {
    return
  }
  // Managed workloads get their own process group; never signal the caller's
  // shell. This also reaches descendants when their owner cannot run cleanup.
  if (process.platform === 'win32') {
    // TODO: Descendants may survive after the root exits and interfere with an
    // upgrade. Investigate reliable Windows process-tree ownership; taskkill
    // cannot reliably clean up the tree once its root has exited.
    if (child.exitCode === null && child.signalCode === null) {
      const result = spawnSync(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { stdio: 'ignore' }
      )
      if (result.error) {
        throw result.error
      }
      if (result.status !== 0) {
        throw new Error(
          `Could not stop workload tree (taskkill ${result.status}).`
        )
      }
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  killedWork.add(child)
}

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
  // and a process that is released or exiting must keep its output visible.
  if (corked || released || stopping || exiting) {
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
      nextUpgradeStop: 'SIGINT' | 'SIGTERM' | undefined
    }) => {
      if (message?.nextUpgradeContinue) {
        // Skip releases permanently. A callback borrowing the terminal leaves
        // released false so it can cork again once its live writes are done.
        if (!message.nextUpgradeTemporary) {
          released = true
        }
        uncorkUpgradeOutput()
      }
      if (message?.nextUpgradeStop) {
        // Windows signals terminate Node without running JS cleanup. IPC
        // invokes the same handlers on every platform, including before the
        // workload has installed its own signal listeners.
        const signal = message.nextUpgradeStop
        if (!process.emit(signal, signal)) {
          void exitWithUpgradeOutput(signal === 'SIGINT' ? 130 : 143)
        }
      }
    }
  )
  process.once('disconnect', () => {
    // Release even an exit already awaiting permission: the parent can no
    // longer acknowledge, and temporary writers must not capture output again.
    released = true
    uncorkUpgradeOutput()
    void exitWithUpgradeOutput(1)
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
          if (!released && !stopping) {
            corkUpgradeOutput()
          }
          process.send({ nextUpgradeOutputDone: true })
        }
      }
    }
  }
}

export function registerUpgradeCleanup(cleanup: () => Promise<unknown>) {
  // Register long-lived workers/native resources for ordinary or fatal exits.
  // Owners remove their registration when they finish so cleanup runs once.
  if (managed) {
    cleanups.add(cleanup)
  }
  return () => cleanups.delete(cleanup)
}

export function stopUpgradeWork() {
  stopping ??= (async () => {
    // Resources can finish initializing during shutdown. Drain those too, and
    // report each cleanup error without abandoning the other owned resources.
    while (cleanups.size) {
      const pending = [...cleanups]
      cleanups.clear()
      const results = await Promise.allSettled(
        pending.map((cleanup) => cleanup())
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(
            'Could not stop an upgrade workload resource:',
            result.reason
          )
        }
      }
    }
  })()
  return stopping
}

export function exitWithUpgradeOutput(code: number): Promise<never> {
  // A direct process.exit() would lose child-local buffered errors. Wait for
  // the parent to hide the menu, stop resources, and finish writing before exit.
  exiting ??= (async () => {
    if (managed) {
      try {
        await requestUpgradeOutput(false)
        await stopUpgradeWork()
        await flushUpgradeOutput()
      } catch (error) {
        uncorkUpgradeOutput()
        console.error('Could not flush workload output before exit:', error)
      }
    }
    process.exit(code)
  })()
  return exiting
}

export function throwUpgradeError(message: string): never {
  if (!managed) {
    process.exit(1)
  }

  // Synchronous config validators cannot await a flush. Start the controlled
  // exit and throw to stop their caller; catching the error must not cancel
  // that exit or let a formerly fatal validation silently continue.
  void exitWithUpgradeOutput(1)
  throw new Error(message)
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
