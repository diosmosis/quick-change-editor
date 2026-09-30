// Runs Claude Code headless and reports what it is doing as it goes. Shared by
// the plugins that talk to Claude; not a plugin itself (there is no plugin.js
// here, so the loader passes this directory by).
import { spawn } from 'node:child_process'
import { basename } from 'node:path'

// What an interactive bash with no terminal says before it does anything else.
const SHELL_NOISE = /^bash: (cannot set terminal process group\b.*|no job control in this shell)$/

// How much of stderr is kept for the error message when a run fails.
const MAX_STDERR_CHARS = 4000

function firstLine(text, max = 160) {
  const line = String(text).trim().split('\n')[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// A tool call as one line: the tool, and the argument that says what it's for.
function describeToolUse({ name, input = {} }) {
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description
  return detail ? `${name}: ${firstLine(detail, 140)}` : name
}

// Turns one line of stream-json into progress, or the final answer. A line that
// isn't JSON is passed on as progress as it stands — a wrapper script may print
// its own, and it's better seen than dropped.
function interpret(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return { status: [line] }
  }
  const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
  switch (event.type) {
    case 'system':
      return event.subtype === 'init'
        ? { sessionId, status: [`Session started${event.model ? ` (${event.model})` : ''}`] }
        : { sessionId }
    case 'assistant': {
      const status = []
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') status.push(describeToolUse(block))
        else if (block.type === 'text' && block.text.trim()) status.push(firstLine(block.text))
      }
      return { sessionId, status }
    }
    case 'result':
      return { sessionId, result: event }
    default:
      return { sessionId }
  }
}

function summarize(result) {
  const parts = []
  if (result.duration_ms) parts.push(`${Math.round(result.duration_ms / 1000)}s`)
  if (result.num_turns) parts.push(`${result.num_turns} turn${result.num_turns === 1 ? '' : 's'}`)
  if (typeof result.total_cost_usd === 'number') parts.push(`$${result.total_cost_usd.toFixed(2)}`)
  return parts.join(' · ')
}

// Whether the executable is claudebox, which runs Claude in a container.
export function isClaudebox(executable) {
  return basename(executable.trim()) === 'claudebox'
}

// Starts `<executable> -p <prompt> --output-format stream-json --verbose
// <extraArgs>` in `cwd`, calling onStatus(text) for every line of progress,
// and onSession(id) whenever Claude says which session it is in — which it does
// before the answer, so a run that fails or is cancelled still reports it.
//
// Returns { result, cancel }. `result` resolves to { text, summary, sessionId }
// — sessionId being the session Claude said it was working in, or null if it
// never said — and rejects with an Error whose message is fit to show, which
// for cancel() is "Cancelled.".
export function runClaude({
  executable,
  extraArgs = '',
  prompt,
  cwd,
  onStatus = () => {},
  onSession = () => {}
}) {
  // Through a login shell for the same reason hooks are (see gitInShell in
  // src/main/git.js): from the desktop menu PATH has none of what ~/.bashrc
  // adds. The executable and prompt arrive as positional parameters, so only
  // the extra arguments — typed by the user to be shell words — are parsed.
  const script = `exec "$0" -p "$1" --output-format stream-json --verbose ${extraArgs}`
  //
  // In a process group of its own, so that cancelling reaches everything under
  // it: a wrapper script (claudebox, say) is a bash waiting on a child, and
  // bash puts off a SIGTERM until that child has finished.
  const child = spawn('bash', ['-ilc', script, executable, prompt], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })

  let cancelled = false
  let buffered = ''
  let final = null
  let sessionId = null
  let rawOutput = ''
  let stderr = ''

  const onLine = (line) => {
    if (!line.trim() || SHELL_NOISE.test(line)) return
    const { status = [], result, sessionId: said } = interpret(line)
    if (said && said !== sessionId) {
      sessionId = said
      onSession(said)
    }
    if (result) final = result
    else if (!line.startsWith('{')) rawOutput += `${line}\n`
    for (const text of status) onStatus(text)
  }

  const result = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop()
      lines.forEach(onLine)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS)
      for (const line of chunk.split('\n')) {
        if (line.trim() && !SHELL_NOISE.test(line)) onStatus(line)
      }
    })

    // 'error' and 'close' can both fire; the promise settles on the first.
    child.on('error', (err) =>
      reject(new Error(`Could not start bash to run ${executable}: ${err.message}`))
    )
    child.on('close', (code) => {
      if (buffered) onLine(buffered)
      if (cancelled) return reject(new Error('Cancelled.'))
      if (final && !final.is_error && typeof final.result === 'string') {
        return resolve({ text: final.result.trim(), summary: summarize(final), sessionId })
      }
      if (final) return reject(new Error(final.result || `Claude stopped: ${final.subtype}`))
      // No result event at all: an executable that doesn't speak stream-json.
      // If it succeeded, whatever it printed is the answer.
      if (code === 0 && rawOutput.trim()) {
        return resolve({ text: rawOutput.trim(), summary: '', sessionId })
      }
      const said = stderr.split('\n').filter((line) => !SHELL_NOISE.test(line)).join('\n').trim()
      reject(new Error(said || `${executable} exited with code ${code} and no answer.`))
    })
  })

  const cancel = () => {
    cancelled = true
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // Already gone, or never started (no pid).
      child.kill('SIGTERM')
    }
  }

  return { result, cancel }
}
