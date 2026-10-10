// Runs Claude Code headless in the open repository and streams what it is doing
// to the window. One run at a time: starting another stops the first.
//
// Events sent to the renderer, each tagged with the runId generate() was given:
//   status  { runId, text }                  a line of progress
//   done    { runId, text, summary }         the answer, and a one-line footer
//   error   { runId, message }               it failed, or was cancelled
import { permissionArgs, runClaude } from '../lib/claude.js'
import { DEFAULT_PROMPT } from './plugin.js'

// What the extra arguments defaulted to before the allowed tools had a setting
// of their own. Saving the settings froze it into many a settings file, where
// it would now repeat the allowed tools — and break opencode, which has no such
// flag — so it reads as empty.
const LEGACY_EXTRA_ARGS = '--allowedTools "Bash(git:*)" Read Grep Glob'

export default function activate(ctx) {
  let current = null // { cancel } of the run under way

  const stop = () => {
    current?.cancel()
    current = null
  }

  // The renderer names the run, so that it knows which branch every event is
  // about before the first one can arrive.
  ctx.handle('generate', (runId) => {
    const { root } = ctx.getRepo()
    if (!root) throw new Error('No repository is open.')
    const settings = ctx.getSettings()
    const executable = settings.executable.trim()
    const prompt = settings.prompt.trim() || DEFAULT_PROMPT
    if (!executable) throw new Error('Set the Claude executable in Settings first.')
    const extraArgs = settings.extraArgs.trim() === LEGACY_EXTRA_ARGS ? '' : settings.extraArgs

    stop()
    const emit = (channel, payload) => ctx.send(channel, { runId, ...payload })

    const run = runClaude({
      executable,
      extraArgs: `${permissionArgs(executable, settings.allowedTools)} ${extraArgs}`,
      prompt,
      cwd: root,
      onStatus: (text) => emit('status', { text })
    })
    current = run
    run.result.then(
      ({ text, summary }) => emit('done', { text, summary }),
      (err) => emit('error', { message: err.message })
    ).finally(() => {
      if (current === run) current = null
    })
  })

  ctx.handle('cancel', stop)
  ctx.on('quit', stop)
}
