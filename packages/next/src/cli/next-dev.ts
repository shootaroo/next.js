#!/usr/bin/env node

import '../server/lib/cpu-profile'
import { saveCpuProfile } from '../server/lib/cpu-profile'
import type { StartServerOptions } from '../server/lib/start-server'
import {
  RESTART_EXIT_CODE,
  getNodeDebugType,
  getParsedDebugAddress,
  getMaxOldSpaceSize,
  printAndExit,
  formatNodeOptions,
  formatDebugAddress,
  getParsedNodeOptions,
  type DebugAddress,
} from '../server/lib/utils'
import * as Log from '../build/output/log'
import { getProjectDir } from '../lib/get-project-dir'
import { ensureProfilesDir } from '../lib/profiles-dir'
import path from 'path'
import { traceGlobals } from '../trace/shared'
import { Telemetry } from '../telemetry/storage'
import { findPagesDir } from '../lib/find-pages-dir'
import { fileExists, FileType } from '../lib/file-exists'
import { getNpxCommand } from '../lib/helpers/get-npx-command'
import { createSelfSignedCertificate } from '../lib/mkcert'
import type { SelfSignedCertificate } from '../lib/mkcert'
import uploadTrace from '../trace/upload-trace'
import { initialEnv } from '@next/env'
import { fork } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { UpgradeContext } from '../lib/upgrade/nudge'
import { withUpgradePromptHidden } from '../lib/upgrade/prompt'
import {
  forwardUpgradeResize,
  killUpgradeWork,
  signalUpgradeWork,
  withUpgradeTemporaryOutput,
} from '../lib/upgrade/output'
import {
  getReservedPortExplanation,
  isPortIsReserved,
} from '../lib/helpers/get-reserved-port'
import { getCacheDirectory } from '../lib/helpers/get-cache-directory'
import { getGitBranch } from '../lib/helpers/git'
import os from 'os'
import fs from 'node:fs'
import { clearTimeout } from 'timers'
import { trace, initializeTraceState, exportTraceState } from '../trace'
import { traceId } from '../trace/shared'
import { Bundler, parseBundlerArgs } from '../lib/bundler'

export type NextDevOptions = {
  disableSourceMaps: boolean
  // Commander is not putting `--inspect` through the arg parser
  inspect?: DebugAddress | true
  turbo?: boolean
  turbopack?: boolean
  webpack?: boolean
  port: number
  hostname?: string
  experimentalHttps?: boolean
  experimentalHttpsKey?: string
  experimentalHttpsCert?: string
  experimentalHttpsCa?: string
  experimentalUploadTrace?: string
  experimentalNextConfigStripTypes?: boolean
  experimentalCpuProf?: boolean
  serverFastRefresh?: boolean
  internalTrace?: string | boolean
}

type PortSource = 'cli' | 'default' | 'env'

let dir: string
let child: undefined | ChildProcess
// distDir is received from the child process via IPC, used for telemetry and trace.
let distDir: string | undefined
let isTurbopack: boolean
let traceUploadUrl: string
let sessionStopHandled = false
let upgradeController: AbortController | null = null
let upgradeOffered = false
let upgradeInProgress = false
let interruption: NodeJS.Signals | null = null

// Skip gives output back without giving up process ownership. Keep the menu
// state separate so later restarts and signals still clean up managed workers.
let outputHeld = false
let managedDev = false

// The server can exit before the user chooses. Retain its result while the
// parent keeps the choice alive, then exit with that result if the user skips.
let upgradeTask: Promise<void> | null = null
let workExitCode: number | null = null
let devSpanAttrs: { 'rage-restart': boolean; 'missing-next-dir': boolean } = {
  'rage-restart': false,
  'missing-next-dir': false,
}
const sessionStarted = Date.now()
const sessionSpan = trace('next-dev')

// If the user restarts the dev server within this window we count it as a "rage restart".
const RAGE_RESTART_THRESHOLD_MS = 90_000

// Shape of a single project entry in the dev-state.json file.
// All fields are optional so older entries without gitBranch are still valid.
type DevStateEntry = {
  stopTime?: number
  distDirPath?: string
  gitBranch?: string
}

// Single shared file for all projects — keyed by project directory path.
const DEV_STATE_FILE = path.join(
  getCacheDirectory('nextjs-nodejs'),
  'dev-state.json'
)

const shouldWaitForChildExit =
  process.env.__NEXT_DEV_WAIT_FOR_TURBOPACK_SHUTDOWN === '1'

const handleSessionStop = async (
  signal: NodeJS.Signals | number | null,
  exit = true
) => {
  if (sessionStopHandled) {
    return
  }
  sessionStopHandled = true
  const interruptedUpgrade = upgradeInProgress
  upgradeController?.abort()

  // Upgrade discards the workload and its held output. Normal shutdown still
  // restores the menu before releasing logs and allowing graceful cleanup.
  const forceKill = signal === 'SIGKILL'
  const wasHeld = outputHeld
  outputHeld = false
  if (!forceKill) {
    // Aborting the menu schedules its screen restoration. Let that run before
    // telling the child to print buffered logs into the normal terminal.
    await new Promise<void>(setImmediate)
    if (child?.connected) {
      child.send({ nextUpgradeContinue: true })
    }
  }
  if (signal != null && child?.pid) {
    if (managedDev && forceKill) {
      killUpgradeWork(child)
    } else if (managedDev && (signal === 'SIGINT' || signal === 'SIGTERM')) {
      signalUpgradeWork(child, signal)
    } else {
      child.kill(signal)
    }
  }

  // Capture the child's exit code if it has already exited and caused the
  // session stop (via the 'exit' event), otherwise assume success (0).
  const exitCode = workExitCode ?? child?.exitCode ?? 0

  if (
    signal != null &&
    child?.pid &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    let exitTimeout: NodeJS.Timeout | undefined
    if (!forceKill && !shouldWaitForChildExit) {
      // Managed native cleanup still drains after Skip or when no reminder is
      // offered. Preserve the explicit timeout override and the ordinary default.
      const childExitTimeout = parseInt(
        process.env.NEXT_EXIT_TIMEOUT_MS ?? (managedDev ? '5000' : '100'),
        10
      )
      exitTimeout = setTimeout(() => {
        if (child) {
          if (managedDev) {
            killUpgradeWork(child)
          } else {
            child.kill('SIGKILL')
          }
        }
      }, childExitTimeout)
    }
    // An IPC error does not mean the process has exited. Keep waiting for
    // closure so the fallback still owns any live descendants.
    await new Promise<void>((resolve) => child!.once('close', () => resolve()))
    if (exitTimeout) {
      clearTimeout(exitTimeout)
    }
  }

  if (managedDev && child) {
    killUpgradeWork(child)
  }
  sessionSpan.stop()

  try {
    const { eventCliSessionStopped } =
      require('../telemetry/events/session-stopped') as typeof import('../telemetry/events/session-stopped')

    let pagesDir: boolean = !!traceGlobals.get('pagesDir')
    let appDir: boolean = !!traceGlobals.get('appDir')

    if (
      typeof traceGlobals.get('pagesDir') === 'undefined' ||
      typeof traceGlobals.get('appDir') === 'undefined'
    ) {
      const pagesResult = findPagesDir(dir)
      appDir = !!pagesResult.appDir
      pagesDir = !!pagesResult.pagesDir
    }

    const telemetry =
      (traceGlobals.get('telemetry') as InstanceType<
        typeof import('../telemetry/storage').Telemetry
      >) ||
      new Telemetry({
        distDir: path.join(dir, distDir || '.next'),
      })

    telemetry.record(
      eventCliSessionStopped({
        cliCommand: 'dev',
        turboFlag: isTurbopack,
        durationMilliseconds: Date.now() - sessionStarted,
        pagesDir,
        appDir,
      }),
      true
    )
    telemetry.flushDetached({ mode: 'dev', dir, distDir: null, events: null })
  } catch (_) {
    // errors here aren't actionable so don't add
    // noise to the output
  }

  if (traceUploadUrl && distDir) {
    uploadTrace({
      traceUploadUrl,
      mode: 'dev',
      projectDir: dir,
      distDir,
      isTurboSession: isTurbopack,
    })

    writeDevState()
  }

  // Save CPU profile if it was enabled (before exiting)
  saveCpuProfile()

  // ensure we re-enable the terminal cursor before exiting
  // the program, or the cursor could remain hidden
  process.stdout.write('\x1B[?25h')
  process.stdout.write('\n')
  if (exit) {
    process.exit(
      interruption &&
        (wasHeld ||
          interruption === 'SIGHUP' ||
          interruption === 'SIGQUIT' ||
          interruptedUpgrade)
        ? 128 + os.constants.signals[interruption]
        : exitCode
    )
  }
}

const onInterrupt = () => {
  interruption = 'SIGINT'
  void handleSessionStop('SIGINT')
}
const onTerminate = () => {
  interruption = 'SIGTERM'
  void handleSessionStop('SIGTERM')
}
const onHangup = () => {
  interruption = 'SIGHUP'
  void handleSessionStop('SIGTERM')
}

// A catchable quit must retire the detached workload as well as the CLI. Let
// the child flush via its normal termination handler, then retain status 131.
const onQuit = () => {
  interruption = 'SIGQUIT'
  void handleSessionStop('SIGTERM')
}
process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)

// exit event must be synchronous
process.on('exit', () => {
  if (managedDev && child) {
    killUpgradeWork(child)
  } else {
    child?.kill('SIGKILL')
  }
  // Catch aggressive kills (e.g. OOM, unhandled exception) that bypass handleSessionStop.
  // SIGKILL of the parent cannot be caught; for all other exits this ensures state is written.
  if (!sessionStopHandled) {
    writeDevState()
  }
})

const nextDev = async (
  options: NextDevOptions,
  portSource: PortSource,
  directory?: string
) => {
  // Note: parseBundlerArgs can only decide on Turbopack or webpack.
  // Rspack can be configured via next.config.js but next.config.js is not loaded in the main process, only in the child process.
  isTurbopack = parseBundlerArgs(options) === Bundler.Turbopack

  dir = getProjectDir(process.env.NEXT_PRIVATE_DEV_DIR || directory)

  const { shouldPromptForUpgrade, runUpgrade, nudgeUpgrade } = await import(
    '../lib/upgrade/nudge.js'
  )
  // The CLI inspect option only enables the debugger in the child, so it is
  // not part of the parent's Node options checked by the shared prompt gate.
  const humanUpgrade = !options.inspect && (await shouldPromptForUpgrade())
  managedDev = humanUpgrade
  outputHeld = humanUpgrade

  // The server can become ready before its assessment supplies a context.
  // Keep parent preflight output behind that decision without delaying work.
  let receivedUpgradeContext: (() => void) | null = null
  const pendingUpgradeContext = humanUpgrade
    ? new Promise<void>((resolve) => {
        receivedUpgradeContext = resolve
      })
    : null

  if (managedDev) {
    // The isolated workload also needs cleanup if the terminal closes before
    // config arrives or after Skip has returned ownership to the child.
    process.on('SIGHUP', onHangup)
    process.on('SIGQUIT', onQuit)
  }
  const allowedUpgradeRetries = new Set<string>()
  async function offerUpgrade(
    context: UpgradeContext,
    initialAssessment: Parameters<typeof nudgeUpgrade>[4]
  ) {
    // Buffer pressure may have skipped the choice while assessment was pending.
    // Do not reopen a menu after that permanent release.
    if (!outputHeld) {
      return
    }
    upgradeOffered = true
    upgradeInProgress = true
    const controller = new AbortController()
    upgradeController = controller

    // Correlate the parent's rendered menu with the upgrade launched after Update.
    const telemetry = new Telemetry({
      distDir: path.join(dir, context.distDir),
      skipNotify: true,
    })

    let nudgeId: string | null = null
    let action

    try {
      action = await nudgeUpgrade(
        dir,
        context,
        'dev',
        controller.signal,
        initialAssessment,
        {
          telemetry,
          onNudgeId(id) {
            nudgeId = id
          },
        }
      )
    } catch (error) {
      Log.warn(`Could not offer the upgrade: ${String(error)}`)
    } finally {
      upgradeController = null
    }
    if (controller.signal.aborted || sessionStopHandled) {
      upgradeInProgress = false
      return
    }
    if (action === 'interrupt') {
      onInterrupt()
      return
    }
    if (action === 'update' && context.experimental.agentUpgrade) {
      // The menu has already closed. Discard held output and confirm that the
      // workload is dead before the upgrade can change files or start work.
      await handleSessionStop('SIGKILL', false)
      if (interruption) {
        process.exit(128 + os.constants.signals[interruption])
      }
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      process.off('SIGHUP', onHangup)
      process.off('SIGQUIT', onQuit)
      process.exit(
        await runUpgrade(dir, context.experimental.agentUpgrade, nudgeId)
      )
    }
    upgradeInProgress = false
    outputHeld = false

    // The menu has finished restoring the terminal before this message allows
    // the child to uncork. Dev keeps serving; Skip does not restart the server.
    if (child?.connected) {
      child.send({ nextUpgradeContinue: true })
    }
    if (workExitCode !== null) {
      await handleSessionStop(null)
    }
  }

  // Check if pages dir exists and warn if not
  if (!(await fileExists(dir, FileType.Directory))) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  if (options.experimentalCpuProf) {
    Log.info(
      `CPU profiling enabled. Profile will be saved to .next-profiles/ on exit (Ctrl+C).`
    )
  }

  async function preflight(skipOnReboot: boolean) {
    const { getPackageVersion, getDependencies } = (await Promise.resolve(
      require('../lib/get-package-version') as typeof import('../lib/get-package-version')
    )) as typeof import('../lib/get-package-version')

    const [sassVersion, nodeSassVersion] = await Promise.all([
      getPackageVersion({ cwd: dir, name: 'sass' }),
      getPackageVersion({ cwd: dir, name: 'node-sass' }),
    ])
    if (sassVersion && nodeSassVersion) {
      Log.warn(
        'Your project has both `sass` and `node-sass` installed as dependencies, but should only use one or the other. ' +
          'Please remove the `node-sass` dependency from your project. ' +
          ' Read more: https://nextjs.org/docs/messages/duplicate-sass'
      )
    }

    if (!skipOnReboot) {
      const { dependencies, devDependencies } = await getDependencies({
        cwd: dir,
      })

      // Warn if @next/font is installed as a dependency. Ignore `workspace:*` to not warn in the Next.js monorepo.
      if (
        dependencies['@next/font'] ||
        (devDependencies['@next/font'] &&
          devDependencies['@next/font'] !== 'workspace:*')
      ) {
        const command = getNpxCommand(dir)
        Log.warn(
          'Your project has `@next/font` installed as a dependency, please use the built-in `next/font` instead. ' +
            'The `@next/font` package will be removed in Next.js 14. ' +
            `You can migrate by running \`${command} @next/codemod@latest built-in-next-font .\`. Read more: https://nextjs.org/docs/messages/built-in-next-font`
        )
      }
    }
  }

  let port = options.port

  if (isPortIsReserved(port)) {
    printAndExit(getReservedPortExplanation(port), 1)
  }

  // If neither --port nor PORT were specified, it's okay to retry new ports.
  const allowRetry = portSource === 'default'

  // We do not set a default host value here to prevent breaking
  // some set-ups that rely on listening on other interfaces
  const host = options.hostname

  if (
    options.experimentalUploadTrace &&
    !process.env.NEXT_TRACE_UPLOAD_DISABLED
  ) {
    traceUploadUrl = options.experimentalUploadTrace
  }

  if (traceUploadUrl) {
    let isRageRestart = false
    let distDirCleared = false
    try {
      if (fs.existsSync(DEV_STATE_FILE)) {
        const allState = JSON.parse(
          fs.readFileSync(DEV_STATE_FILE, 'utf8')
        ) as Record<string, DevStateEntry>
        const state = allState[dir]
        if (
          state?.stopTime &&
          Date.now() - state.stopTime < RAGE_RESTART_THRESHOLD_MS
        ) {
          // Only flag as a rage restart if the git branch hasn't changed. If
          // either the stored or current branch is unknown, skip the comparison
          // and fall back to time-only detection.
          const storedBranch = state.gitBranch
          const currentBranch = getGitBranch(dir)
          const branchChanged =
            storedBranch && currentBranch && storedBranch !== currentBranch
          if (!branchChanged) {
            isRageRestart = true
          }
        }
        if (state?.distDirPath && !fs.existsSync(state.distDirPath)) {
          distDirCleared = true
        }
      }
    } catch {
      // Corrupt file — leave both flags false
    }
    devSpanAttrs = {
      'rage-restart': isRageRestart,
      'missing-next-dir': distDirCleared,
    }
  }

  const enabledFeatures = Object.fromEntries(
    Object.entries({
      serverFastRefreshDisabled: options.serverFastRefresh === false,
      experimentalCpuProf: options.experimentalCpuProf,
    }).filter(([_, value]) => value)
  )

  for (const [key, value] of Object.entries(enabledFeatures)) {
    sessionSpan.setAttribute(`feature.${key}`, value)
  }

  initializeTraceState({
    ...exportTraceState(),
    defaultParentSpanId: sessionSpan.getId(),
  })

  const devServerOptions: StartServerOptions = {
    dir,
    port,
    allowRetry,
    isDev: true,
    hostname: host,
    serverFastRefresh: options.serverFastRefresh,
  }

  const startServerPath = require.resolve('../server/lib/start-server')

  async function startServer(startServerOptions: StartServerOptions) {
    return new Promise<void>((resolve) => {
      let resolved = false
      const defaultEnv = (initialEnv || process.env) as typeof process.env

      const nodeOptions = getParsedNodeOptions()

      let maxOldSpaceSize: string | number | undefined = getMaxOldSpaceSize()
      if (!maxOldSpaceSize && !process.env.NEXT_DISABLE_MEM_OVERRIDE) {
        const totalMem = os.totalmem()
        const totalMemInMB = Math.floor(totalMem / 1024 / 1024)
        maxOldSpaceSize = Math.floor(totalMemInMB * 0.5).toString()

        nodeOptions['max-old-space-size'] = maxOldSpaceSize

        // Ensure the max_old_space_size is not also set.
        delete nodeOptions['max_old_space_size']
      }

      if (options.disableSourceMaps) {
        delete nodeOptions['enable-source-maps']
      } else {
        nodeOptions['enable-source-maps'] = true
      }

      const nodeDebugType = getNodeDebugType(nodeOptions)
      const originalAddress =
        nodeDebugType === undefined ? undefined : nodeOptions[nodeDebugType]
      delete nodeOptions.inspect
      delete nodeOptions['inspect-brk']
      delete nodeOptions['inspect_brk']
      if (nodeDebugType !== undefined) {
        const address = getParsedDebugAddress(originalAddress)
        address.port = address.port === 0 ? 0 : address.port + 1
        nodeOptions[nodeDebugType] = formatDebugAddress(address)
      } else if (options.inspect) {
        const address: DebugAddress =
          options.inspect === true
            ? getParsedDebugAddress(true)
            : options.inspect
        nodeOptions.inspect = formatDebugAddress(address)
      }

      const { nodeOptions: formattedNodeOptions, execArgv } =
        formatNodeOptions(nodeOptions)

      // Preserve the real terminal instead of relaying logs through the parent.
      // A separate POSIX group lets Upgrade kill this server and its descendants
      // without killing the CLI that must launch the upgrade next.
      child = fork(startServerPath, {
        stdio: 'inherit',
        detached: managedDev && process.platform !== 'win32',
        execArgv,
        env: {
          ...defaultEnv,
          ...(isTurbopack ? { TURBOPACK: process.env.TURBOPACK } : undefined),
          __NEXT_DEV_SERVER: '1',
          NEXT_PRIVATE_START_TIME: process.env.NEXT_PRIVATE_START_TIME,
          NEXT_PRIVATE_WORKER: '1',
          NEXT_PRIVATE_UPGRADE_PROMPT: outputHeld ? '1' : undefined,
          NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES: Array.from(
            allowedUpgradeRetries
          ).join(','),
          NEXT_PRIVATE_UPGRADE_PROCESS_GROUP: managedDev ? '1' : undefined,
          NEXT_PRIVATE_TRACE_ID: traceId,
          NEXT_PRIVATE_ENABLED_FEATURES: JSON.stringify(enabledFeatures),
          NEXT_PRIVATE_DEV_SPAN_ATTRS: JSON.stringify(devSpanAttrs),
          NODE_EXTRA_CA_CERTS: startServerOptions.selfSignedCertificate
            ? startServerOptions.selfSignedCertificate.rootCA
            : defaultEnv.NODE_EXTRA_CA_CERTS,
          NODE_OPTIONS: formattedNodeOptions,
          // There is a node.js bug on MacOS which causes closing file watchers to be really slow.
          // This limits the number of watchers x mitigate the issue.
          // https://github.com/nodejs/node/issues/29949
          WATCHPACK_WATCHER_LIMIT:
            os.platform() === 'darwin' ? '20' : undefined,
          // Enable CPU profiling if requested
          ...(options.experimentalCpuProf
            ? {
                NEXT_CPU_PROF: '1',
                NEXT_CPU_PROF_DIR: ensureProfilesDir(dir),
                __NEXT_PRIVATE_CPU_PROFILE: 'dev-server',
              }
            : undefined),
          ...(process.env.NEXT_TURBOPACK_TRACING
            ? { NEXT_TURBOPACK_TRACING: process.env.NEXT_TURBOPACK_TRACING }
            : undefined),
        },
      })
      // Capture this particular worker: a restart will replace the global child,
      // but old IPC/close callbacks must still refer to the worker they belong to.
      const worker = child
      if (managedDev) {
        forwardUpgradeResize(worker)
      }
      let workerError: Error | null = null
      let revealing: Promise<void> | null = null
      const exited = new Promise<void>((done) => {
        worker.once('close', () => done())
      })

      // Spawn failure also emits close; IPC send errors may occur while work
      // is still alive. Neither error may tear down the independent choice.
      const revealWorkerExit = () => {
        revealing ??= withUpgradePromptHidden(async () => {
          if (worker.connected) {
            worker.send({ nextUpgradeContinue: true })
          }
          const timeout = setTimeout(() => killUpgradeWork(worker), 5_000)
          try {
            await exited
            killUpgradeWork(worker)
          } finally {
            clearTimeout(timeout)
          }
          if (workerError) {
            Log.error(workerError)
          } else if (
            worker.signalCode ||
            (worker.exitCode && worker.exitCode !== RESTART_EXIT_CODE)
          ) {
            Log.error(
              `Dev server stopped (${worker.signalCode ?? `exit ${worker.exitCode}`}).`
            )
          }
        })
        return revealing
      }
      worker.on('error', (error) => {
        workerError = error
        if (!managedDev) {
          console.error(error)
          void handleSessionStop('SIGTERM')
          return
        }
        void revealWorkerExit().catch((failure) => {
          console.error(failure)
          void handleSessionStop('SIGTERM')
        })
      })

      // Context starts the independent choice; output requests temporarily lend
      // the terminal to the child. Ready messages continue normal dev startup.
      // None of these waits should stop the server while the user is deciding.
      worker.on('message', (msg: any) => {
        if (msg && typeof msg === 'object') {
          if (
            typeof msg.nextUpgradeRetryAllowed === 'string' &&
            /^[a-f0-9]{64}$/.test(msg.nextUpgradeRetryAllowed)
          ) {
            allowedUpgradeRetries.add(msg.nextUpgradeRetryAllowed)
          } else if (msg.nextUpgradeContext) {
            const context = msg.nextUpgradeContext as UpgradeContext
            distDir = context.distDir
            if (upgradeOffered) {
              return
            }
            const initialAssessment =
              msg.nextUpgradeAssessment !== undefined
                ? Promise.resolve(msg.nextUpgradeAssessment)
                : null
            upgradeTask = offerUpgrade(context, initialAssessment).catch(
              async (error) => {
                console.error(error)
                await handleSessionStop('SIGTERM', false)
                process.exit(1)
              }
            )
            receivedUpgradeContext?.()
          } else if (msg.nextUpgradeOutputLimit) {
            // Skip the pending choice without stopping the server. Future
            // replacement workers also start with their terminal released.
            outputHeld = false
            upgradeController?.abort()
            void withUpgradePromptHidden(async () => {
              if (worker.connected) {
                worker.send({ nextUpgradeContinue: true })
              }
            }).catch((error) => {
              console.error(error)
              void handleSessionStop('SIGTERM')
            })
          } else if (msg.nextUpgradeOutput) {
            // Awaited config writes borrow the terminal and then return it.
            // A fatal exit instead flushes and closes the worker before showing
            // the still-pending choice again, so logs cannot overwrite it.
            const reveal =
              msg.nextUpgradeOutput === 'temporary'
                ? withUpgradePromptHidden(() =>
                    withUpgradeTemporaryOutput(worker)
                  )
                : revealWorkerExit()
            void reveal.catch((error) => {
              console.error(error)
              void handleSessionStop('SIGTERM')
            })
          } else if (msg.nextWorkerReady) {
            if (outputHeld && upgradeOffered) {
              // A replacement child loads config with live output. Hide the
              // existing choice until it has corked and reported its context.
              void withUpgradePromptHidden(
                () =>
                  new Promise<void>((done) => {
                    const finish = () => {
                      worker.off('message', onContext)
                      worker.off('close', finish)
                      done()
                    }
                    const onContext = (message: any) => {
                      if (message?.nextUpgradeContext) {
                        finish()
                      }
                    }
                    worker.on('message', onContext)
                    worker.once('close', finish)
                    worker.send({ nextWorkerOptions: startServerOptions })
                  })
              ).catch((error) => {
                console.error(error)
                void handleSessionStop('SIGTERM')
              })
            } else {
              worker.send({ nextWorkerOptions: startServerOptions })
            }
          } else if (msg.nextServerReady && !resolved) {
            if (msg.port) {
              // Store the used port in case a random one was selected, so that
              // it can be re-used on automatic dev server restarts.
              port = parseInt(msg.port, 10)
            }
            if (msg.distDir) {
              // Store the distDir from the child process for telemetry and trace uploads.
              distDir = msg.distDir
            }

            resolved = true
            resolve()
          }
        }
      })

      // Close belongs to the workload, not automatically to the CLI session.
      // Restart replaces the worker; a failure during a choice leaves the parent
      // available to upgrade or exit after Skip.
      worker.on('close', async (code, signal) => {
        if (sessionStopHandled) {
          return
        }
        if (outputHeld) {
          await revealWorkerExit()
        }
        if (code === RESTART_EXIT_CODE) {
          // Skip releases output, not ownership. Retire the old process group
          // before replacing the only reference to it with the new worker.
          if (managedDev) {
            killUpgradeWork(worker)
          }

          // Starting the dev server will overwrite the `.next/trace` file, so we
          // must upload the existing contents before restarting the server to
          // preserve the metrics.
          if (traceUploadUrl && distDir) {
            uploadTrace({
              traceUploadUrl,
              mode: 'dev',
              projectDir: dir,
              distDir,
              isTurboSession: isTurbopack,
              sync: true,
            })
          }

          // Reset the start time so "Ready in X" reflects the restart
          // duration, not time since the original process started.
          process.env.NEXT_PRIVATE_START_TIME = Date.now().toString()

          return startServer({ ...startServerOptions, port })
        }
        workExitCode = code ?? (signal ? 128 + os.constants.signals[signal] : 1)
        if (upgradeInProgress) {
          // Work and the human decision have separate lifetimes. A failed
          // server must not cancel an assessment, prompt, or subsequent upgrade.
          return
        }
        // Call handler (e.g. upload telemetry). Don't try to send a signal to
        // the child, as it has already exited.
        await handleSessionStop(/* signal */ null)
      })
    })
  }

  const runDevServer = async (reboot: boolean) => {
    try {
      if (!!options.experimentalHttps) {
        Log.warn(
          'Self-signed certificates are currently an experimental feature, use with caution.'
        )

        let certificate: SelfSignedCertificate | undefined

        const key = options.experimentalHttpsKey
        const cert = options.experimentalHttpsCert
        const rootCA = options.experimentalHttpsCa

        if (key && cert) {
          certificate = {
            key: path.resolve(key),
            cert: path.resolve(cert),
            rootCA: rootCA ? path.resolve(rootCA) : undefined,
          }
        } else {
          certificate = await createSelfSignedCertificate(host)
        }

        await startServer({
          ...devServerOptions,
          selfSignedCertificate: certificate,
        })
      } else {
        await startServer(devServerOptions)
      }

      await pendingUpgradeContext
      await upgradeTask
      await preflight(reboot)
    } catch (err) {
      console.error(err)
      process.exit(1)
    }
  }

  await runDevServer(false)
}

function writeDevState(): void {
  if (!traceUploadUrl || !dir) return
  try {
    fs.mkdirSync(path.dirname(DEV_STATE_FILE), { recursive: true })

    let state: Record<string, DevStateEntry> = {}
    try {
      state = JSON.parse(fs.readFileSync(DEV_STATE_FILE, 'utf8'))
    } catch {
      // File missing or corrupt — start with empty state
    }

    // Eagerly remove entries that are stale (older than threshold) or invalid
    // (future timestamps from clock skew or corruption).
    const now = Date.now()
    const cutoff = now - RAGE_RESTART_THRESHOLD_MS
    for (const key of Object.keys(state)) {
      const t = state[key]?.stopTime
      if (!t || t < cutoff || t > now) {
        delete state[key]
      }
    }

    // Update current project
    const gitBranch = getGitBranch(dir)
    state[dir] = {
      stopTime: Date.now(),
      distDirPath: path.join(dir, distDir ?? '.next'),
      ...(gitBranch ? { gitBranch } : {}),
    }

    const { sync: writeFileAtomicSync } =
      require('next/dist/compiled/write-file-atomic') as typeof import('next/dist/compiled/write-file-atomic')
    writeFileAtomicSync(DEV_STATE_FILE, JSON.stringify(state))
  } catch {
    // Best effort — don't interfere with shutdown
  }
}

export { nextDev }
