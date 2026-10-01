#!/usr/bin/env node

import { saveCpuProfile } from '../server/lib/cpu-profile'
import { existsSync } from 'fs'
import path from 'path'
import { Telemetry } from '../telemetry/storage'
import { italic } from '../lib/picocolors'
import { warn } from '../build/output/log'
import { getParsedNodeOptions, printAndExit } from '../server/lib/utils'
import isError from '../lib/is-error'
import { getProjectDir } from '../lib/get-project-dir'
import { enableMemoryDebuggingMode } from '../lib/memory/startup'
import { disableMemoryDebuggingMode } from '../lib/memory/shutdown'
import { Bundler, parseBundlerArgs } from '../lib/bundler'
import { parseBuildPathsInput } from '../lib/resolve-build-paths'
import { fork } from 'child_process'
import { constants } from 'os'
import { createInterface, type Interface } from 'readline'
import { Writable } from 'stream'
import type { UpgradeContext } from '../lib/upgrade/nudge'
import { withUpgradePromptHidden } from '../lib/upgrade/prompt'
import {
  uncork,
  forwardUpgradeInput,
  forwardUpgradeResize,
  handleUpgradeOutputMessages,
  isUpgradeOutputManaged,
  killUpgradeWork,
  restoreUpgradeEnvironment,
  signalUpgradeWork,
  waitForUpgradeOutput,
} from '../lib/upgrade/output'

export type NextBuildOptions = {
  analyze?: boolean
  experimentalAnalyze?: boolean
  debug?: boolean
  debugPrerender?: boolean
  profile?: boolean
  mangling: boolean
  turbo?: boolean
  turbopack?: boolean
  webpack?: boolean
  experimentalDebugMemoryUsage: boolean
  experimentalAppOnly?: boolean
  experimentalTurbo?: boolean
  experimentalBuildMode: 'default' | 'compile' | 'generate' | 'generate-env'
  experimentalUploadTrace?: string
  experimentalNextConfigStripTypes?: boolean
  debugBuildPaths?: string
  experimentalCpuProf?: boolean
  internalTrace?: string | boolean
}

const nextBuild = async (options: NextBuildOptions, directory?: string) => {
  // Validate CLI-only input before capturing output. Config still loads once,
  // in the work process, after the supervisor is ready to handle its failure.
  const dir = getProjectDir(directory)
  const bundler = parseBundlerArgs(options)
  if (!existsSync(dir)) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }
  if (
    (options.analyze || options.experimentalAnalyze) &&
    bundler !== Bundler.Turbopack
  ) {
    printAndExit('--analyze is only compatible with the Turbopack bundler.')
  }

  // Only interactive humans need a supervisor. Keep config, compilation and
  // their exception handlers out of the process that owns the upgrade menu.
  if (!isUpgradeOutputManaged()) {
    const { shouldPromptForUpgrade } = await import('../lib/upgrade/nudge.js')
    // Preloads already ran in this process. Forking would replay them and can
    // collide with ports or other resources they own; keep the ordinary build.
    const nodeOptions = getParsedNodeOptions()
    const hasPreload =
      nodeOptions.require !== undefined ||
      nodeOptions.r !== undefined ||
      nodeOptions.import !== undefined ||
      nodeOptions.loader !== undefined ||
      nodeOptions['experimental-loader'] !== undefined
    if (!hasPreload && (await shouldPromptForUpgrade())) {
      return runBuildChild(options, dir)
    }
  }

  process.title = `next-build (v${process.env.__NEXT_VERSION})`

  // Every handled signal saves the profile and drains held logs before exit.
  // Use the signal's usual status instead of repeating the same cleanup.
  const onSignal = async (signal: NodeJS.Signals) => {
    saveCpuProfile()
    await uncork()
    process.exit(128 + constants.signals[signal])
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  if (isUpgradeOutputManaged()) {
    process.on('SIGHUP', onSignal)
  }

  const {
    analyze,
    experimentalAnalyze,
    debug,
    debugPrerender,
    experimentalDebugMemoryUsage,
    profile,
    mangling,
    experimentalAppOnly,
    experimentalBuildMode,
    experimentalUploadTrace,
    debugBuildPaths,
  } = options

  let traceUploadUrl: string | undefined
  if (experimentalUploadTrace && !process.env.NEXT_TRACE_UPLOAD_DISABLED) {
    traceUploadUrl = experimentalUploadTrace
  }

  if (!mangling) {
    warn(
      `Mangling is disabled. ${italic('Note: This may affect performance and should only be used for debugging purposes.')}`
    )
  }

  if (profile) {
    warn(
      `Profiling is enabled. ${italic('Note: This may affect performance.')}`
    )
  }

  if (debugPrerender) {
    warn(
      `Prerendering is running in debug mode with NODE_ENV='development'. ${italic(
        'This will affect performance and should not be used for production.'
      )}`
    )
  }

  if (experimentalDebugMemoryUsage) {
    process.env.EXPERIMENTAL_DEBUG_MEMORY_USAGE = '1'
    enableMemoryDebuggingMode()
  }

  let debugBuildPathsPatterns: string[] | undefined

  if (debugBuildPaths) {
    const patterns = parseBuildPathsInput(debugBuildPaths)

    if (patterns.length > 0) {
      debugBuildPathsPatterns = patterns
    }
  }

  const enabledFeatures = Object.fromEntries(
    Object.entries({
      experimentalDebugMemoryUsage,
      experimentalBuildMode:
        experimentalBuildMode !== 'default' ? experimentalBuildMode : undefined,
      experimentalCpuProf: options.experimentalCpuProf,
    }).filter(([_, value]) => value !== undefined && value !== false)
  )

  const build = (require('../build') as typeof import('../build')).default

  return build(
    dir,
    analyze || experimentalAnalyze,
    profile,
    debug || Boolean(process.env.NEXT_DEBUG_BUILD),
    debugPrerender,
    !mangling,
    experimentalAppOnly,
    bundler,
    experimentalBuildMode,
    traceUploadUrl,
    debugBuildPathsPatterns,
    enabledFeatures
  )
    .catch(async (err) => {
      if (experimentalDebugMemoryUsage) {
        disableMemoryDebuggingMode()
      }
      console.error('')
      if (
        isError(err) &&
        (err.code === 'INVALID_RESOLVE_ALIAS' ||
          err.code === 'WEBPACK_ERRORS' ||
          err.code === 'BUILD_OPTIMIZATION_FAILED' ||
          err.code === 'NEXT_EXPORT_ERROR' ||
          err.code === 'NEXT_STATIC_GEN_BAILOUT' ||
          err.code === 'EDGE_RUNTIME_UNSUPPORTED_API')
      ) {
        console.error(`> ${err.message}`)
      } else {
        console.error('> Build error occurred')
        console.error(err)
      }
      await uncork()
      process.exit(1)
    })
    .finally(() => {
      if (experimentalDebugMemoryUsage) {
        disableMemoryDebuggingMode()
      }
    })
}

async function runBuildChild(
  options: NextBuildOptions,
  directory: string
): Promise<never> {
  const { nudgeUpgrade, runUpgrade } = await import('../lib/upgrade/nudge.js')
  const controller = new AbortController()
  // Retain the offer Promise after it settles so duplicate context messages
  // cannot open another menu or start another upgrade.
  let offer: Promise<void> | null = null
  let stopped = false
  let complete = false
  let released = false

  // Fatal logs can be released while the menu still owns input. Track the
  // actual input handoff separately so spinner cleanup preserves its pipe.
  let inputForwarded = false

  let upgradeResult: string | number | null = null
  let stopping: Promise<void> | null = null
  let revealing: Promise<void> | null = null
  let workError: Error | null = null
  let interruption: NodeJS.Signals | null = null

  let spinnerUsers = 0
  let spinnerInput: Interface | null = null
  const inputWasRaw = process.stdin.isRaw
  const inputWasFlowing = process.stdin.readableFlowing

  // The foreground supervisor owns input while child spinners are active.
  // Discard typing without echo, and keep Ctrl+C on the group shutdown path.
  const stopSpinnerInput = () => {
    if (spinnerInput) {
      spinnerInput.close()
      spinnerInput = null
      process.stdin.setRawMode(inputWasRaw)

      // readline.close() pauses stdin. After Skip it must keep feeding the
      // worker, even when no spinner is left to read from the terminal.
      if (inputWasFlowing === true || inputForwarded) {
        process.stdin.resume()
      } else {
        process.stdin.pause()
      }
    }
  }

  // Keep stdout/stderr as real TTYs and cork output in the child. Pipe stdin
  // separately so plugins cannot steal menu arrows or Enter. After Skip the
  // parent forwards input, but child stdin stays non-TTY and has no raw mode.
  // Reuse the original entry and arguments before preloads run, as well as cwd.
  // bin/next dispatches the private worker without repeating CLI initialization.
  const worker = fork(process.argv[1], process.argv.slice(2), {
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      // This is the main build. The compiler-worker marker suppresses warnings
      // that must still be emitted here, so give supervision its own marker.
      NEXT_PRIVATE_UPGRADE_BUILD_WORKER: '1',
      NEXT_PRIVATE_UPGRADE_PROCESS_GROUP: '1',
      __NEXT_PRIVATE_CPU_PROFILE: process.env.NEXT_CPU_PROF
        ? 'build-worker'
        : undefined,
    },
  })
  forwardUpgradeResize(worker)
  const exited = new Promise<number>((resolve) => {
    worker.once('close', (code, signal) => {
      stopped = true
      inputForwarded = false
      stopSpinnerInput()
      resolve(
        code !== null && code >= 0
          ? code
          : signal
            ? 128 + constants.signals[signal]
            : 1
      )
    })
  })
  const release = () => {
    released = true
    if (worker.connected) {
      worker.send({ nextUpgradeContinue: true })
    }
  }

  // Interrupts and fatal errors both allow held logs to flush before close.
  // Bound that wait, then stop any descendants left after the worker exits.
  const waitForBuildExit = async () => {
    const timeout = setTimeout(() => killUpgradeWork(worker), 5_000)
    try {
      const code = await exited
      killUpgradeWork(worker)
      return code
    } finally {
      clearTimeout(timeout)
    }
  }

  const stopBuildChild = (forceKill: boolean) => {
    stopping ??= (async () => {
      // Stop reading input into this build before shutdown or agent handoff.
      // Worker close also unpipes its destination when work ends on its own.
      inputForwarded = false
      if (worker.stdin) {
        process.stdin.unpipe(worker.stdin)
      }

      // Upgrade discards this build and its logs. Confirm termination without
      // releasing output or waiting for resource cleanup before the handoff.
      if (forceKill) {
        killUpgradeWork(worker)
        await exited
        return
      }

      // Let prompt cancellation restore the screen before cleanup can print.
      await new Promise<void>(setImmediate)
      release()
      if (!stopped && !complete) {
        signalUpgradeWork(
          worker,
          interruption === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
        )
      }
      await waitForBuildExit()
    })()
    return stopping
  }
  const revealFailure = () => {
    revealing ??= withUpgradePromptHidden(async () => {
      release()
      const code = await waitForBuildExit()
      if (workError) {
        console.error(workError)
      } else if (code !== 0) {
        console.error(`Build stopped (${worker.signalCode ?? `exit ${code}`}).`)
      }
    })
    return revealing
  }

  const onSignal = (signal: NodeJS.Signals) => {
    stopSpinnerInput()
    // A second interrupt is the escape from slow cleanup. Upgrade can also
    // start stopping, so require a previous interrupt before taking this path.
    if (interruption && stopping) {
      killUpgradeWork(worker)
      return
    }
    interruption ??= signal
    controller.abort()
    void stopBuildChild(false)
      .then(() => {
        saveCpuProfile()
        process.exit(128 + constants.signals[signal])
      })
      .catch((error) => {
        console.error(error)
        process.exit(1)
      })
  }
  const onExit = () => {
    stopSpinnerInput()
    killUpgradeWork(worker)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  if (process.platform !== 'win32') {
    process.on('SIGQUIT', onSignal)
  }
  process.once('exit', onExit)

  // An IPC send error can precede the actual exit. Keep supervising the child
  // until close, revealing the error without cancelling the pending choice.
  worker.on('error', (error) => {
    workError = error
    void revealFailure().catch((failure) => {
      console.error(failure)
      onSignal('SIGTERM')
    })
  })
  worker.on('message', (message: any) => {
    if (message.nextBuildReady) {
      worker.send({ nextBuildOptions: options, directory })
    } else if (
      message.nextBuildSpinner === 1 ||
      message.nextBuildSpinner === -1
    ) {
      spinnerUsers += message.nextBuildSpinner
      if (spinnerUsers === 0) {
        stopSpinnerInput()
      } else if (!spinnerInput && released && !stopping && !stopped) {
        spinnerInput = createInterface({
          input: process.stdin,
          output: new Writable({
            write(_chunk, _encoding, callback) {
              callback()
            },
          }),
          terminal: true,
        })
        spinnerInput.on('SIGINT', () => onSignal('SIGINT'))
      }
    } else if (message.nextBuildComplete) {
      complete = true
    } else if (message.nextUpgradeContext && offer === null) {
      // Only this offer uses the config snapshot, so keep it in its closure
      // rather than adding another pair of supervisor-wide state variables.
      const upgradeContext = message.nextUpgradeContext as UpgradeContext
      const upgradeEnvironment: Record<string, string | null> | null =
        message.nextUpgradeEnvironment ?? null
      offer = (async () => {
        // Config and .env load in the build child. Restore only telemetry flags
        // before creating the parent's recorder; restore the rest at handoff.
        restoreUpgradeEnvironment(
          Object.fromEntries(
            Object.entries(upgradeEnvironment ?? {}).filter(
              ([key]) =>
                key === 'NEXT_TELEMETRY_DISABLED' ||
                key === 'NEXT_TELEMETRY_DEBUG'
            )
          )
        )

        // Record the parent's visible choice and pass its ID to the upgrade.
        // Child compilation must not create a second human nudge.
        const telemetry = new Telemetry({
          distDir: path.join(directory, upgradeContext.distDir),
          skipNotify: true,
        })
        let nudgeId: string | null = null
        let action
        try {
          action = await nudgeUpgrade(
            directory,
            upgradeContext,
            'build',
            controller.signal,
            null,
            {
              telemetry,
              onNudgeId(id) {
                nudgeId = id
              },
            }
          )
        } catch (error) {
          warn(`Could not offer the upgrade: ${String(error)}`)
        } finally {
          // Policy events can be recorded without showing a menu, including
          // failed assessments. Finish this recorder before the offer settles.
          await telemetry.flush()
        }
        if (controller.signal.aborted) {
          return
        }
        if (action === 'interrupt') {
          onSignal('SIGINT')
          return
        }
        if (action === 'update' && upgradeContext.experimental.agentUpgrade) {
          await stopBuildChild(true)
          if (!controller.signal.aborted) {
            // The existing upgrade command owns signals during its handoff.
            process.off('SIGINT', onSignal)
            process.off('SIGTERM', onSignal)
            process.off('SIGHUP', onSignal)
            if (process.platform !== 'win32') {
              process.off('SIGQUIT', onSignal)
            }
            restoreUpgradeEnvironment(upgradeEnvironment)
            upgradeResult = await runUpgrade(
              directory,
              upgradeContext.experimental.agentUpgrade,
              nudgeId
            )
          }
        } else {
          release()

          // Output can be released earlier to reveal an error while retaining
          // the menu. Forward input only when this choice has actually ended.
          if (!stopped) {
            inputForwarded = true
            forwardUpgradeInput(worker)
          }
        }
      })()
    } else if (message.nextUpgradeSkip) {
      // A safeguard may already be queued when Upgrade kills the build. Once
      // shutdown starts, it must not abort the committed upgrade handoff.
      if (stopping) {
        return
      }

      // Memory pressure or the hold time limit skips the choice, not
      // the build. Close the menu before releasing logs; work keeps running.
      controller.abort()
      void withUpgradePromptHidden(async () => release())
        .then(async () => {
          // Menu cancellation restores stdin before it can serve the build.
          // Never reconnect a worker already shutting down or closed.
          await new Promise<void>(setImmediate)
          if (!stopping && !stopped) {
            inputForwarded = true
            forwardUpgradeInput(worker)
          }
        })
        .catch((error) => {
          console.error(error)
          onSignal('SIGTERM')
        })
    } else if (message.nextUpgradeOutput) {
      void revealFailure().catch((error) => {
        console.error(error)
        onSignal('SIGTERM')
      })
    }
  })

  try {
    const code = await exited
    // A reveal may already have released logs. Finish its diagnostic before
    // exiting, even when config failed before supplying an upgrade context.
    if (!stopping && (!released || revealing)) {
      await revealFailure()
    }
    await offer
    // bin/next unconditionally exits zero when nextBuild resolves. The
    // supervisor owns the actual work/upgrade result and exits deliberately.
    saveCpuProfile()
    return process.exit(
      interruption
        ? 128 + constants.signals[interruption]
        : (upgradeResult ?? code)
    )
  } finally {
    controller.abort()
    stopSpinnerInput()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    if (process.platform !== 'win32') {
      process.off('SIGQUIT', onSignal)
    }
    process.off('exit', onExit)
    killUpgradeWork(worker)
  }
}

// Supervision is installed before importing build. The normal CLI has already
// parsed options in the parent; only those options arrive through this channel.
export function startBuildWorker() {
  // Consume the entry marker so a plugin's forked CLI is not mistaken for this
  // worker. Output management is process-local after the handshake is installed.
  handleUpgradeOutputMessages()
  delete process.env.NEXT_PRIVATE_UPGRADE_BUILD_WORKER
  process.on(
    'message',
    async (message: {
      nextBuildOptions: NextBuildOptions | undefined
      directory: string
    }) => {
      if (!message.nextBuildOptions) {
        return
      }
      try {
        await nextBuild(message.nextBuildOptions, message.directory)
        process.send?.({ nextBuildComplete: true })
        await waitForUpgradeOutput()
        saveCpuProfile()
        await uncork()
        process.exit(0)
      } catch (error) {
        console.error(error)
        await uncork()
        process.exit(1)
      }
    }
  )
  process.send!({ nextBuildReady: true })
}

export { nextBuild, saveCpuProfile }
