import { emitKeypressEvents, type Key } from 'readline'
import { PassThrough } from 'stream'
import cliSelect from 'next/dist/compiled/cli-select'
import { bold, cyan } from '../picocolors'

export type UpgradeAction = 'update' | 'skip' | 'dismiss' | 'interrupt'

// The CLI can ask an active menu to leave the screen before child logs print.
// Serialize those requests so two writers cannot independently redraw the menu.
let revealOutput: ((write: () => Promise<void>) => Promise<void>) | null = null
let showInline = false
let outputPending: Promise<void> | null = null

export async function withUpgradePromptHidden(write: () => Promise<void>) {
  // Failures can arrive during assessment, before a prompt exists. Keep their
  // diagnostics visible when that pending assessment eventually opens a menu.
  const previous = outputPending
  // The callback receives permission only after the active menu has hidden
  // itself. Before a menu exists, write on the normal screen and keep those logs.
  const pending = (async () => {
    if (previous) {
      await previous
    }
    if (revealOutput) {
      await revealOutput(write)
    } else {
      showInline = true
      await write()
    }
  })()
  outputPending = pending
  try {
    await pending
  } finally {
    if (outputPending === pending) {
      outputPending = null
    }
  }
}

export async function promptUpgrade({
  message,
  signal,
  canUpdate,
  onShown,
}: {
  message: string
  signal: AbortSignal
  canUpdate: boolean
  onShown: (() => void) | null
}): Promise<UpgradeAction> {
  if (outputPending) {
    await outputPending
  }
  if (signal.aborted) {
    return 'skip'
  }
  const input = process.stdin
  const terminal = process.stdout
  const values = {
    ...(canUpdate ? { update: 'Upgrade now' } : {}),
    skip: 'Skip',
    dismiss: 'Skip until next version',
  }
  const labels = Object.values(values)
  const heading = `${message}\n\n`
  const wasRaw = input.isRaw ?? false
  const wasFlowing = input.readableFlowing

  // Isolate cancellation from other consumers of stdin. cli-select can close
  // this stream without changing the real terminal's original raw/flow state.
  const keys = Object.assign(new PassThrough(), { setRawMode() {} })
  let interrupted = false
  let cancelled = false
  let resized = false
  let selectedIndex = 0
  let shown = false
  let inline = showInline
  showInline = false
  let pendingOutput: (() => Promise<void>) | null = null
  let stopReveal: (() => void) | null = null
  const waitForInterruption = () =>
    new Promise<void>((resolve) => {
      stopReveal = resolve
    })
  const output = {
    write(text: string) {
      if (inline && text.includes('\x1b[2K')) {
        // cli-select assumes one terminal row per choice. Only erase choice
        // rows, including wrapping, so failure logs above them stay intact.
        const width = terminal.columns || 80
        const rows = labels.reduce(
          (count, label) => count + Math.ceil((label.length + 4) / width),
          0
        )
        terminal.write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ''}\x1b[J`)
        return true
      }
      return terminal.write(text)
    },
  }
  const renderValue = (value: string, selected: boolean) => {
    if (!inline && value === labels[0]) {
      // We own this screen. Redraw from the top instead of relying on
      // cli-select's one-row-per-choice cursor movement when choices wrap.
      terminal.write(`\x1b[H\x1b[2J${heading}`)
    }
    // Count the first visible menu once, including one shown below fatal logs.
    // Resizing or reopening the choices must not record another nudge.
    if (value === labels[0] && !shown) {
      shown = true
      onShown?.()
    }
    if (selected) {
      selectedIndex = labels.indexOf(value)
    }
    return selected ? cyan(bold(value)) : value
  }
  const cancel = () => {
    cancelled = true
    stopReveal?.()
    keys.emit('keypress', '', { name: 'escape' })
  }
  const onKey = (text: string, key: Key) => {
    if (key?.ctrl && key.name === 'c') {
      interrupted = true
      stopReveal?.()
    }
    if (key?.name === 'escape') {
      cancelled = true
      stopReveal?.()
    }
    keys.emit('keypress', text, key)
  }
  const onResize = () => {
    resized = true
    // A terminal write can emit resize while cli-select is still opening.
    // Wait until its selection callback is installed before cancelling it.
    queueMicrotask(() => {
      if (resized && !restored) {
        keys.emit('keypress', '', { name: 'escape' })
      }
    })
  }
  let restored = false
  // Return input mode, cursor and the original screen exactly once. This also
  // runs on cancellation and process exit, before any held logs are released.
  const restore = () => {
    if (restored) {
      return
    }
    restored = true
    input.removeListener('keypress', onKey)
    terminal.removeListener('resize', onResize)
    signal.removeEventListener('abort', cancel)
    process.removeListener('exit', restore)
    revealOutput = null
    keys.destroy()
    try {
      input.setRawMode(wasRaw)
    } finally {
      if (wasFlowing !== true) {
        input.pause()
      }
      terminal.write(inline ? '\x1b[?25h' : '\x1b[?1049l\x1b[?25h')
    }
  }
  // CLI signal handlers may exit synchronously, before the promise settles.
  process.once('exit', restore)
  try {
    // Keep startup output on the normal screen while the menu owns the terminal.
    terminal.write(inline ? heading : '\x1b[?1049h')
    emitKeypressEvents(input)
    input.on('keypress', onKey)
    terminal.on('resize', onResize)
    signal.addEventListener('abort', cancel, { once: true })
    input.setRawMode(true)
    input.resume()
    // Escape closes the current cli-select instance, but pendingOutput tells
    // the catch below to run the writer and reopen the choice instead of Skip.
    revealOutput = (write) =>
      new Promise<void>((resolve, reject) => {
        pendingOutput = async () => {
          try {
            await write()
            resolve()
          } catch (error) {
            reject(error)
            throw error
          }
        }
        keys.emit('keypress', '', { name: 'escape' })
      })
    // Recreate cli-select after a resize or failure output, retaining the
    // selected choice. Only a user decision or cancellation ends this loop.
    while (true) {
      resized = false
      const selection = cliSelect({
        values,
        defaultValue: selectedIndex,
        selected: cyan('❯'),
        unselected: ' ',
        indentation: 2,
        cleanup: true,
        // cli-select types inputStream as a WriteStream, but only consumes
        // keypress events and the raw-mode methods supplied by this proxy.
        inputStream: keys as unknown as NodeJS.WriteStream,
        outputStream: output as NodeJS.WriteStream,
        valueRenderer: renderValue,
      })
      if (signal.aborted || cancelled) {
        cancel()
      }
      // Another failure or worker restart can request output while a reveal
      // is redrawing. Deliver that request to the new selection too.
      if (pendingOutput) {
        keys.emit('keypress', '', { name: 'escape' })
      }
      try {
        const { id } = await selection
        return signal.aborted || cancelled ? 'skip' : (id as UpgradeAction)
      } catch (error) {
        // cli-select rejects without a reason for Escape / Ctrl+C.
        if (error) {
          throw error
        }
        const write = pendingOutput as (() => Promise<void>) | null
        if (write) {
          pendingOutput = null
          if (!inline) {
            terminal.write('\x1b[?1049l\x1b[?25h')
            inline = true
          }
          // Producers must stop before the choices return. No workload output
          // is allowed to share a live menu with its keyboard interaction.
          await Promise.race([write(), waitForInterruption()])
          stopReveal = null
          if (signal.aborted || cancelled || interrupted) {
            return interrupted ? 'interrupt' : 'skip'
          }
          // A Node child can reset the shared terminal mode while exiting,
          // even though this parent still owns the pending selection. Toggle
          // it because libuv caches the mode separately in each process.
          input.setRawMode(false)
          input.setRawMode(true)
          input.resume()
          terminal.write(heading)
          continue
        }
        if (!resized || signal.aborted || cancelled || interrupted) {
          return interrupted ? 'interrupt' : 'skip'
        }
      }
    }
  } finally {
    restore()
  }
}
