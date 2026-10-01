// The CLI owns the menu. This process keeps its inherited terminal and holds
// its own stdout/stderr writes until the parent says the menu has closed.
let corked = false
let released = false
let outputLimitCheck: ReturnType<typeof setInterval> | null = null
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
}

export function handleUpgradeOutputMessages() {
  // Listen before config loads, but leave its output live. router-server corks
  // only after config and custom routes finish, so their write callbacks work.
  process.on(
    'message',
    (message: { nextUpgradeContinue: boolean | undefined }) => {
      if (message?.nextUpgradeContinue) {
        released = true
        uncorkUpgradeOutput()
      }
    }
  )

  // A missing parent cannot grant permission to print. Release held logs before
  // exiting rather than leave a worker running without its supervising CLI.
  process.once('disconnect', () => {
    released = true
    void flushUpgradeOutput()
      .then(() => process.exit(1))
      .catch((error) => {
        console.error('Could not flush workload output before exit:', error)
        process.exit(1)
      })
  })
}
export function uncorkUpgradeOutput() {
  if (!corked) {
    return
  }

  // Release only our cork level; keep the inherited terminal streams open.
  corked = false
  if (outputLimitCheck) {
    clearInterval(outputLimitCheck)
    outputLimitCheck = null
  }

  // TODO: Separate stream buffers preserve each stream's order, but releasing
  // stdout first can show its later logs before earlier stderr errors. Consider
  // a shared ordered buffer if preserving cross-stream chronology is needed.
  process.stdout.uncork()
  process.stderr.uncork()
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
