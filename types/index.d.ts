export type Commit = {
  hash: string
  short: string
  parents: string[]
  /** Author date, local time: `YYYY-MM-DD HH:MM`. */
  date: string
  author: string
  email: string
  subject: string
  /** The message after its first line (may be empty). */
  body: string
  refs: string[]
}

export type Graph = {
  commits: Commit[]
  /** `git log --graph` as text, for surfaces that cannot draw SVG. */
  text: string
  /** Why there is no graph (not a git repository, git failed), or null. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'git-graph': { graph: Shaped<Graph> }
  }
}
