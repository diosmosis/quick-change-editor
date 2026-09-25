import React, { useCallback, useEffect, useRef, useState } from 'react'
import './style.css'

// An IPC rejection arrives as "Error invoking remote method 'x': Error: ...".
function message(error) {
  const text = error?.message || String(error)
  const match = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/.exec(text)
  return match ? match[1] : text
}

// A description belongs to a branch of a repository. Coming back to one that
// already has an answer shows it, edits and all, rather than asking again.
function keyOf(repo) {
  return `${repo.root}\n${repo.branch ?? ''}`
}

let runCounter = 0

function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="prd-elapsed">{Math.max(0, Math.round((now - since) / 1000))}s</span>
}

function Log({ lines }) {
  const ref = useRef(null)
  // Pinned to the bottom, like a terminal, so the latest step is the one seen.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  if (lines.length === 0) return <div className="prd-log prd-log-empty">Waiting for Claude…</div>
  return (
    <ol ref={ref} className="prd-log">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ol>
  )
}

function PrDescription({ host, repo }) {
  const { Modal, ConfirmDialog, CommandOutput } = host.ui
  // key → { runId, phase: 'running' | 'done' | 'error', log, text, summary,
  //         error, startedAt }
  const [entries, setEntries] = useState(() => new Map())
  // The branch the dialog is showing, or null while it's closed.
  const [openKey, setOpenKey] = useState(null)
  // A prompt waiting on the user's go-ahead, since every one spends tokens:
  // { key, reason: 'first' | 'retry' | 'regenerate' }, or null.
  const [pending, setPending] = useState(null)
  const [copied, setCopied] = useState(false)
  const textRef = useRef(null)
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const update = useCallback((key, fn) => {
    setEntries((prev) => {
      const next = new Map(prev)
      next.set(key, fn(prev.get(key)))
      return next
    })
  }, [])

  // Runs are told apart by an id made here, so every event can be matched to
  // the branch it belongs to — and those of a run since replaced ignored.
  const updateRun = useCallback((runId, fn) => {
    setEntries((prev) => {
      for (const [key, entry] of prev) {
        if (entry.runId !== runId) continue
        const next = new Map(prev)
        next.set(key, fn(entry))
        return next
      }
      return prev
    })
  }, [])

  // The text of a previous answer stays in the entry through a regeneration, so
  // one that fails or is cancelled falls back to it instead of losing it.
  const start = useCallback(
    async (key) => {
      const runId = `${Date.now()}-${++runCounter}`
      update(key, (entry) => ({
        text: '',
        summary: '',
        ...entry,
        runId,
        phase: 'running',
        log: [],
        error: null,
        startedAt: Date.now()
      }))
      try {
        await host.invoke('generate', runId)
      } catch (err) {
        updateRun(runId, (entry) => ({
          ...entry,
          phase: entry.text ? 'done' : 'error',
          error: message(err)
        }))
      }
    },
    [host, update, updateRun]
  )

  useEffect(() => {
    const unsubscribe = [
      host.subscribe('status', ({ runId, text }) =>
        updateRun(runId, (entry) => ({ ...entry, log: [...entry.log, text] }))
      ),
      host.subscribe('done', ({ runId, text, summary }) =>
        updateRun(runId, (entry) => ({ ...entry, phase: 'done', text, summary, error: null }))
      ),
      host.subscribe('error', ({ runId, message: error }) =>
        updateRun(runId, (entry) => ({ ...entry, phase: entry.text ? 'done' : 'error', error }))
      )
    ]
    return () => unsubscribe.forEach((fn) => fn())
  }, [host, updateRun])

  useEffect(
    () =>
      host.on('open', (target) => {
        if (!target?.root) return
        const key = keyOf(target)
        setCopied(false)
        // A branch with an answer (or a run under way) just shows it; nothing
        // is sent. One without asks before the first prompt goes out, and the
        // dialog only opens once there is something to put in it.
        if (entriesRef.current.has(key)) setOpenKey(key)
        else setPending({ key, reason: 'first' })
      }),
    [host]
  )

  const confirmSend = () => {
    const { key } = pending
    setPending(null)
    setOpenKey(key)
    start(key)
  }

  const confirmation = pending && (
    <ConfirmDialog
      title={
        pending.reason === 'regenerate'
          ? 'Regenerate the description?'
          : 'Ask Claude for a PR description?'
      }
      message={
        pending.reason === 'regenerate'
          ? 'This starts a new Claude session, which uses more tokens. Your edits are replaced by the new answer.'
          : `This starts a Claude session in ${pending.key.split('\n')[0]} to describe ` +
            `${pending.key.split('\n')[1] || 'the current branch'}, which uses tokens.`
      }
      confirmLabel={pending.reason === 'regenerate' ? 'Regenerate' : 'Send prompt'}
      onCancel={() => setPending(null)}
      onConfirm={confirmSend}
    />
  )

  const entry = openKey ? entries.get(openKey) : null
  if (!openKey || !entry) return confirmation || null

  const close = () => {
    setOpenKey(null)
    setPending(null)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.text)
      setCopied(true)
    } catch {
      // Selected instead, so Ctrl+C is one keypress away.
      textRef.current?.select()
    }
  }

  const branch = openKey.split('\n')[1]
  const running = entry.phase === 'running'

  return (
    <>
      <Modal label="Pull request description" className="prd-modal" onClose={close}>
        <h2 className="prd-title">
          Pull request description
          {branch && <span className="prd-branch">for {branch}</span>}
          {/* The dialog follows the branch it was opened for; say so if the
              window has since moved on. */}
          {openKey !== keyOf(repo) && <span className="prd-stale">not the current branch</span>}
        </h2>

        {running ? (
          <>
            <p className="prd-running">
              <span className="prd-spinner" /> Claude is working on it… <Elapsed since={entry.startedAt} />
            </p>
            <Log lines={entry.log} />
          </>
        ) : (
          <>
            {entry.error && (
              <p className="prd-error" role="alert">
                {entry.error}
                {entry.phase === 'done' && ' The previous answer is below.'}
              </p>
            )}
            {entry.phase === 'done' && (
              <textarea
                ref={textRef}
                className="prd-text"
                value={entry.text}
                onChange={(event) => {
                  const text = event.target.value
                  setCopied(false)
                  update(openKey, (current) => ({ ...current, text }))
                }}
                spellCheck
                autoFocus
              />
            )}
            <div className="prd-meta">
              {entry.summary && <span>{entry.summary}</span>}
              <CommandOutput
                key={entry.runId}
                output={entry.log.join('\n')}
                label="Session log"
                initiallyOpen={entry.phase === 'error'}
              />
            </div>
          </>
        )}

        <div className="modal-actions">
          {running ? (
            <button className="button" onClick={() => host.invoke('cancel')}>
              Cancel run
            </button>
          ) : entry.phase === 'error' ? (
            <button className="button" onClick={() => setPending({ key: openKey, reason: 'retry' })}>
              Try again…
            </button>
          ) : (
            <button className="button" onClick={() => setPending({ key: openKey, reason: 'regenerate' })}>
              Regenerate…
            </button>
          )}
          <span className="prd-actions-spacer" />
          {entry.phase === 'done' && !running && (
            <button className="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          <button className="button primary" onClick={close}>
            Close
          </button>
        </div>
      </Modal>

      {confirmation}
    </>
  )
}

export default function setup(host) {
  host.addCommand({
    id: 'open',
    label: 'PR description',
    title: 'Draft a pull request title and description for this branch with Claude',
    shortcut: 'Ctrl+Shift+D',
    run: ({ repo }) => host.emit('open', repo)
  })
  host.addOverlay(function PrDescriptionOverlay(props) {
    return <PrDescription host={host} {...props} />
  })
}
