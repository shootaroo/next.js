import { exitWithUpgradeOutput } from './upgrade/output'

// Errors use the same streams as normal logs and may still be corked. Let the
// parent restore the terminal before flushing them and exiting the work process.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err)
  void exitWithUpgradeOutput(1)
})

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err)
  void exitWithUpgradeOutput(1)
})
