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
  forwardUpgradeResize,
  handleUpgradeOutputMessages,
  isUpgradeOutputManaged,
  killUpgradeWork,
  restoreUpgradeEnvironment,
  signalUpgradeWork,
  waitForUpgradeOutput,
  withUpgradeTemporaryOutput,
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
  const onTerminate = async () => {
    saveCpuProfile()
    await uncork()
    process.exit(143)
  }
  const onInterrupt = async () => {
    saveCpuProfile()
    await uncork()
    process.exit(130)
  }
  const onHangup = async () => {
    saveCpuProfile()
    await uncork()
    process.exit(129)
  }
  process.on('SIGTERM', onTerminate)
  process.on('SIGINT', onInterrupt)
  if (isUpgradeOutputManaged()) {
    process.on('SIGHUP', onHangup)
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
  let context: UpgradeContext | null = null
  let upgradeEnvironment: Record<string, string | null> | null = null
  let offer: Promise<void> | null = null
  let stopped = false
  let complete = false
  let released = false
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
      if (inputWasFlowing === true) {
        process.stdin.resume()
      } else {
        process.stdin.pause()
      }
    }
  }

  // Stdio remains the real terminal. Only control and config cross IPC; output
  // stays in the work child's own corked streams, including after completion.
  // Reuse the original entry and arguments before preloads run, as well as cwd.
  // bin/next dispatches the private worker without repeating CLI initialization.
  const worker = fork(process.argv[1], process.argv.slice(2), {
    stdio: 'inherit',
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
  const stopBuildChild = (forceKill: boolean) => {
    stopping ??= (async () => {
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
      const timeout = setTimeout(() => killUpgradeWork(worker), 5_000)
      try {
        await exited
        killUpgradeWork(worker)
      } finally {
        clearTimeout(timeout)
      }
    })()
    return stopping
  }
  const revealFailure = () => {
    revealing ??= withUpgradePromptHidden(async () => {
      release()
      const timeout = setTimeout(() => killUpgradeWork(worker), 5_000)
      try {
        const code = await exited
        killUpgradeWork(worker)
        if (workError) {
          console.error(workError)
        } else if (code !== 0) {
          console.error(
            `Build stopped (${worker.signalCode ?? `exit ${code}`}).`
          )
        }
      } finally {
        clearTimeout(timeout)
      }
    })
    return revealing
  }

  const onSignal = (signal: NodeJS.Signals) => {
    stopSpinnerInput()
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
    } else if (message.nextUpgradeContext && !context) {
      context = message.nextUpgradeContext
      upgradeEnvironment = message.nextUpgradeEnvironment ?? null
      const upgradeContext = context!
      offer = (async () => {
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
        }
      })()
    } else if (message.nextUpgradeOutputLimit) {
      // Buffer pressure skips the choice, not the build. Restore the prompt
      // before granting output and keep waiting for the existing workload.
      controller.abort()
      void withUpgradePromptHidden(async () => release()).catch((error) => {
        console.error(error)
        onSignal('SIGTERM')
      })
    } else if (message.nextUpgradeOutput === 'temporary') {
      void withUpgradePromptHidden(() =>
        withUpgradeTemporaryOutput(worker)
      ).catch((error) => {
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
    if (!stopping && !released) {
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

// Tests can enter the worker directly; the CLI dispatch uses the same function
// while preserving the original invocation for preloads and user config.
if (
  require.main === module &&
  process.env.NEXT_PRIVATE_UPGRADE_BUILD_WORKER === '1' &&
  process.send
) {
  startBuildWorker()
}

export { nextBuild, saveCpuProfile }
