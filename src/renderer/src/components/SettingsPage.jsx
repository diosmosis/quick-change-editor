import React, { useEffect, useMemo, useRef, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'

const api = window.api

function Field({ setting, value, onChange, disabled }) {
  const id = `setting-${setting.key}`
  if (setting.type === 'boolean') {
    return (
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        {setting.label}
      </label>
    )
  }
  return (
    <>
      <label className="settings-label" htmlFor={id}>
        {setting.label}
      </label>
      {setting.type === 'text' ? (
        <textarea
          id={id}
          className="settings-input"
          rows={setting.rows ?? 4}
          value={value ?? ''}
          placeholder={setting.placeholder}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      ) : (
        <input
          id={id}
          className="settings-input"
          type={setting.type === 'number' ? 'number' : 'text'}
          value={value ?? ''}
          placeholder={setting.placeholder}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          spellCheck={false}
        />
      )}
    </>
  )
}

function nameOf(manifest) {
  return manifest.name ?? manifest.id
}

/**
 * Every plugin's settings, one plugin at a time: a list down the left — with a
 * filter, since it's meant to hold more than a handful — and the chosen one's
 * fields on the right, drawn from its manifest.
 *
 * A page over the editor rather than in place of it: the editor stays mounted
 * underneath, so open tabs and their unsaved edits are exactly where they were
 * on the way back. Nothing is written until Save, which saves every plugin with
 * changes; leaving with some unsaved asks first. Escape goes back.
 */
export default function SettingsPage({ plugins, onBack, onError }) {
  // Both undefined while loading; then { [pluginId]: { key: value } }. `saved`
  // is what's on disk, to tell which plugins have been changed here.
  const [values, setValues] = useState(undefined)
  const [saved, setSaved] = useState(undefined)
  const [selected, setSelected] = useState(plugins[0]?.manifest.id ?? null)
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const pageRef = useRef(null)

  useEffect(() => {
    pageRef.current?.focus()
    api.plugins.getSettings().then(
      (all) => {
        setValues(all)
        setSaved(all)
      },
      (err) => {
        onError(err)
        onBack()
      }
    )
  }, [onBack, onError])

  const changed = useMemo(() => {
    if (!values || !saved) return new Set()
    return new Set(
      Object.keys(values).filter((id) => JSON.stringify(values[id]) !== JSON.stringify(saved[id]))
    )
  }, [values, saved])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return plugins
    return plugins.filter(({ manifest }) =>
      [nameOf(manifest), manifest.id, manifest.description ?? ''].some((text) =>
        text.toLowerCase().includes(needle)
      )
    )
  }, [plugins, filter])

  const plugin = plugins.find(({ manifest }) => manifest.id === selected)?.manifest ?? null

  const change = (id, key, value) => {
    setValues((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))
  }

  // Resolves to whether everything saved. What does is kept as saved even if a
  // later plugin fails, so a retry only has the failures left to do.
  const save = async () => {
    setSaving(true)
    try {
      for (const id of changed) {
        const stored = await api.plugins.setSettings(id, values[id])
        // The stored values are the declared types (a number field's text comes
        // back a number), so they replace the edited ones too.
        setSaved((prev) => ({ ...prev, [id]: stored }))
        setValues((prev) => ({ ...prev, [id]: stored }))
      }
      return true
    } catch (err) {
      onError(err)
      return false
    } finally {
      setSaving(false)
    }
  }

  const leave = () => {
    if (saving) return
    if (changed.size > 0) setConfirmLeave(true)
    else onBack()
  }

  return (
    <>
      <div
        ref={pageRef}
        className="settings-page"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !confirmLeave) leave()
          if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (changed.size > 0 && !saving) save()
          }
        }}
      >
        <header className="settings-header">
          <button className="button settings-back" onClick={leave} disabled={saving} title="Back to the editor (Escape)">
            ← Back
          </button>
          <h1>Settings</h1>
          <span className="settings-header-spacer" />
          {changed.size > 0 && (
            <span className="settings-unsaved">
              {changed.size === 1
                ? 'Unsaved changes'
                : `Unsaved changes in ${changed.size} plugins`}
            </span>
          )}
          <button
            className="button primary"
            onClick={save}
            disabled={saving || changed.size === 0}
            title="Ctrl+S"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Plugins">
            <input
              className="filter-input"
              type="search"
              placeholder="Filter plugins"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible.length > 0) setSelected(visible[0].manifest.id)
                if (event.key === 'Escape' && filter) {
                  event.stopPropagation()
                  setFilter('')
                }
              }}
            />
            <div className="settings-nav-list">
              {visible.length === 0 && (
                <p className="empty">{plugins.length === 0 ? 'No plugins are installed.' : 'No plugin matches the filter.'}</p>
              )}
              {visible.map(({ manifest }) => (
                <button
                  key={manifest.id}
                  className={`settings-nav-item ${manifest.id === selected ? 'active' : ''}`}
                  onClick={() => setSelected(manifest.id)}
                  title={manifest.description}
                >
                  <span className="settings-nav-name">{nameOf(manifest)}</span>
                  {changed.has(manifest.id) && <span className="dirty-dot" title="Unsaved changes" />}
                </button>
              ))}
            </div>
          </nav>

          <section className="settings-pane">
            {plugin && (
              <div className="settings-pane-inner" key={plugin.id}>
                <h2>{nameOf(plugin)}</h2>
                {plugin.description && <p className="settings-description">{plugin.description}</p>}
                {(plugin.settings ?? []).length === 0 && (
                  <p className="settings-description">This plugin has nothing to configure.</p>
                )}
                {values &&
                  (plugin.settings ?? []).map((setting) => (
                    <div key={setting.key} className="settings-field">
                      <Field
                        setting={setting}
                        value={values[plugin.id]?.[setting.key]}
                        onChange={(value) => change(plugin.id, setting.key, value)}
                        disabled={saving}
                      />
                      {setting.description && <p className="settings-hint">{setting.description}</p>}
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {confirmLeave && (
        <ConfirmDialog
          title="Unsaved settings"
          message={
            changed.size === 1
              ? `${nameOf(plugins.find(({ manifest }) => changed.has(manifest.id)).manifest)} has unsaved changes.`
              : `${changed.size} plugins have unsaved changes.`
          }
          confirmLabel="Save and go back"
          extraLabel="Discard"
          onCancel={() => {
            setConfirmLeave(false)
            pageRef.current?.focus()
          }}
          onExtra={onBack}
          onConfirm={async () => {
            setConfirmLeave(false)
            if (await save()) onBack()
          }}
        />
      )}
    </>
  )
}
