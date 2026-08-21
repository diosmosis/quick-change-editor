// Tiny JSON-file settings store in the app's userData directory. Holds the
// last repository opened (so the app comes back where it was) and the recent
// list behind the repository picker.
import fs from 'node:fs'
import path from 'node:path'

const MAX_RECENT = 10

export class Store {
  constructor(app) {
    this.file = path.join(app.getPath('userData'), 'settings.json')
    this.data = this._read()
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback
  }

  set(patch) {
    this.data = { ...this.data, ...patch }
    this._write()
    return this.data
  }

  rememberRepo(root) {
    const recent = [root, ...this.get('recentRepos', []).filter((r) => r !== root)]
    this.set({ repo: root, recentRepos: recent.slice(0, MAX_RECENT) })
  }

  // Drops repositories that have since been moved or deleted, so the picker
  // never offers a path that can't be opened.
  recentRepos() {
    const recent = this.get('recentRepos', []).filter((r) => fs.existsSync(r))
    if (recent.length !== this.get('recentRepos', []).length) this.set({ recentRepos: recent })
    return recent
  }
}
