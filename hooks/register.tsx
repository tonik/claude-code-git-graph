import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Commit, Graph } from '../types'

const PANE = 'git-graph'
const TITLE = 'Git graph'
const LIMIT = 150
const POLL_MS = 10_000
// The desktop pane reports its body width in text columns: measured at about
// 8.8 CSS pixels each (36 and 80 columns), a little less here so the drawing
// never runs past the pane's edge.
const PX_PER_COLUMN = 8.7

// Change the tag when Graph's fields change: an older stored value is dropped.
const graph = atom(
  { plugin: 'git-graph', key: 'graph' } as const,
  { commits: [], text: '', error: null },
  { shape: 'graph-2' },
)

const SEP = '\x1f'
const END = '\x1e'

function parse(stdout: string): Commit[] {
  return stdout
    .split(END)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(line => {
      const [
        hash = '',
        parents = '',
        short = '',
        date = '',
        author = '',
        email = '',
        subject = '',
        refs = '',
        body = '',
      ] = line.split(SEP)
      return {
        hash,
        short,
        parents: parents ? parents.split(' ') : [],
        date,
        author,
        email,
        subject,
        body: body.trim(),
        refs: refs ? refs.split(', ').filter(Boolean) : [],
      }
    })
}

async function refresh($: EngineInterface): Promise<void> {
  let next: Graph
  try {
    const log = await $.process.run([
      'git',
      'log',
      '--all',
      '--topo-order',
      `-n${LIMIT}`,
      '--date=format:%Y-%m-%d %H:%M',
      `--format=%H${SEP}%P${SEP}%h${SEP}%ad${SEP}%an${SEP}%ae${SEP}%s${SEP}%D${SEP}%b${END}`,
    ])
    if (log.exitCode !== 0) {
      next = { commits: [], text: '', error: log.stderr.trim() || 'git log failed' }
    } else {
      const text = await $.process.run([
        'git',
        'log',
        '--all',
        '--graph',
        '--oneline',
        '--decorate',
        '--color=never',
        `-n${LIMIT}`,
      ])
      next = { commits: parse(log.stdout), text: text.stdout, error: null }
    }
  } catch (err) {
    next = { commits: [], text: '', error: String(err) }
  }

  const current = await read($, graph)
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await update($, graph, () => next)
  }
}

// ---- Layout: give every commit a lane (column) and every edge a path ----

// `color`: which branch line the edge belongs to (each new line gets the next
// colour). `join`: a line that joins a lane already running down (two rounded
// turns between rows).
type Edge = { fromCol: number; fromRow: number; toCol: number; toRow: number; color: number; join?: true }
// `reach[i]`: how many lanes row i's lines take up, so its text starts after them.
type Layout = { cols: number[]; colors: number[]; edges: Edge[]; reach: number[] }

function layout(commits: Commit[]): Layout {
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]))
  let lanes: (string | null)[] = []
  let origins: number[] = []
  let laneColor: number[] = []
  let nextColor = 0
  const cols: number[] = []
  const colors: number[] = []
  const edges: Edge[] = []
  const last = commits.length - 1

  const grow = (n: number) => {
    while (lanes.length <= n) {
      lanes.push(null)
      origins.push(lanes.length - 1)
      laneColor.push(0)
    }
  }

  commits.forEach((c, i) => {
    let col = lanes.indexOf(c.hash)
    const isTip = col === -1
    if (isTip) {
      col = lanes.indexOf(null)
      if (col === -1) col = lanes.length
    }
    const color = isTip ? nextColor++ : (laneColor[col] ?? 0)

    // Lanes coming down from the row above: the one waiting for this commit
    // ends at its dot, the others pass by.
    lanes.forEach((h, j) => {
      if (h === c.hash) {
        edges.push({ fromCol: origins[j] ?? j, fromRow: i - 1, toCol: col, toRow: i, color: laneColor[j] ?? 0 })
      } else if (h !== null && i > 0) {
        edges.push({ fromCol: origins[j] ?? j, fromRow: i - 1, toCol: j, toRow: i, color: laneColor[j] ?? 0 })
      }
    })

    lanes = lanes.map(h => (h === c.hash ? null : h))
    origins = lanes.map((_, j) => j)
    // A lane that ends in this row is not handed to another branch until the
    // next one, so two lines never cross on their way in and out.
    const freed = new Set<number>()

    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p)
      if (existing !== -1 && k === 0 && existing > col) {
        // The first parent is already waited for by a lane to the right: keep
        // this commit's lane straight and let the lane on the right join it.
        grow(col)
        if (i < last) {
          edges.push({ fromCol: existing, fromRow: i, toCol: col, toRow: i + 1, color: laneColor[existing] ?? 0, join: true })
        }
        lanes[existing] = null
        freed.add(existing)
        lanes[col] = p
        origins[col] = col
        laneColor[col] = color
        return
      }
      if (existing !== -1) {
        // A parent another lane already leads to: join that lane on the next
        // row instead of opening a second one (git's `|/`). Coloured as the
        // branch it belongs to: a branch ending in a lane keeps its own colour,
        // a merge's second parent takes the lane's.
        if (i < last) {
          edges.push({
            fromCol: col,
            fromRow: i,
            toCol: existing,
            toRow: i + 1,
            color: k === 0 ? color : (laneColor[existing] ?? 0),
            join: true,
          })
        }
        if (k === 0) freed.add(col)
        return
      }
      let slot = col
      if (k > 0 || lanes[col] != null) {
        slot = lanes.findIndex((h, j) => h === null && j !== col && !freed.has(j))
        if (slot === -1) slot = Math.max(lanes.length, col + 1)
      }
      grow(slot)
      lanes[slot] = p
      origins[slot] = col
      laneColor[slot] = k === 0 ? color : nextColor++
    })
    if (c.parents.length === 0) freed.add(col)

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      origins.pop()
      laneColor.pop()
    }
    cols.push(col)
    colors.push(color)
  })

  // Lanes still open lead to parents older than the commits shown.
  lanes.forEach((h, j) => {
    if (h !== null && !rowOf.has(h)) {
      edges.push({ fromCol: origins[j] ?? j, fromRow: last, toCol: j, toRow: last + 0.6, color: laneColor[j] ?? 0 })
    }
  })

  const reach = cols.map(col => col + 1)
  for (const e of edges) {
    const wide = Math.max(e.fromCol, e.toCol) + 1
    for (const r of [Math.floor(e.fromRow), Math.ceil(e.toRow)]) {
      if (r >= 0 && r < reach.length) reach[r] = Math.max(reach[r] ?? 0, wide)
    }
  }

  return { cols, colors, edges, reach }
}

// ---- Drawing ----

const COLORS = ['#3e8ef7', '#e5484d', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#e54d2e']
const ROW = 26
const LANE = 14
const PAD = 12
const CHAR = 6.7
const PILL_CHAR = 5.7
const CORNER = 10

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const cut = (s: string, n: number) => (n <= 1 ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Git messages are hard-wrapped at ~72 characters: join those lines back into
// paragraphs, but keep list items and trailers (Co-Authored-By: ...) apart.
function reflow(text: string): string {
  const keep = /^(\s*[-*•]\s|\s*\d+[.)]\s|[A-Za-z-]+:\s)/
  const out: string[] = []
  for (const line of text.split('\n')) {
    const last = out[out.length - 1]
    if (line.trim() === '' || last === undefined || last.trim() === '' || keep.test(line)) out.push(line)
    else out[out.length - 1] = `${last} ${line.trim()}`
  }
  return out.join('\n')
}

// Breaks text into lines of at most `max` characters, at spaces where it can.
function wrap(text: string, max: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const chunks = word.length > max ? word.match(new RegExp(`.{1,${max}}`, 'g')) ?? [word] : [word]
      for (const w of chunks) {
        if (line === '') line = w
        else if (line.length + 1 + w.length <= max) line += ` ${w}`
        else {
          out.push(line)
          line = w
        }
      }
    }
    if (line !== '') out.push(line)
  }
  return out
}

const TIP_LINE = 16
const TIP_BODY_LINES = 18
const MAX_SOURCE = 125_000

type Drawing = { source: string; width: number; height: number }

function svg(commits: Commit[], totalWidth: number, footer: string): Drawing {
  // The pane takes at most 131,072 characters of SVG: if the hover cards make
  // it longer, the oldest commits' cards drop their message body, then go.
  let withBody = commits.length
  let withCard = commits.length
  let drawing = draw(commits, totalWidth, withBody, withCard, footer)
  while (drawing.source.length > MAX_SOURCE && withCard > 0) {
    if (withBody > 0) withBody = Math.floor(withBody / 2)
    else withCard = Math.floor(withCard / 2)
    drawing = draw(commits, totalWidth, withBody, withCard, footer)
  }
  return drawing
}

function draw(
  commits: Commit[],
  totalWidth: number,
  withBody: number,
  withCard: number,
  footer: string,
): Drawing {
  const { cols, colors, edges, reach } = layout(commits)
  const x = (col: number) => PAD + col * LANE
  const y = (row: number) => 6 + row * ROW + ROW / 2
  const color = (id: number) => COLORS[id % COLORS.length] ?? '#888888'
  const W = Math.max(totalWidth, 240)
  // The list, then one quiet line under it with the counts.
  const footY = 6 + commits.length * ROW + 22
  const listH = footY + 14

  // Hover cards: the full message, who made the commit and when.
  const tipW = Math.min(W - 16, 460)
  const tipChars = Math.floor((tipW - 24) / 6.4)
  const tips = commits.map((c, i) => {
    const lines: { text: string; cls: string }[] = []
    for (const l of wrap(c.subject, tipChars)) lines.push({ text: l, cls: 'tt-title' })
    if (c.body !== '' && i < withBody) {
      let body = wrap(reflow(c.body), tipChars)
      if (body.length > TIP_BODY_LINES) body = [...body.slice(0, TIP_BODY_LINES - 1), '…']
      lines.push({ text: '', cls: 'tt-body' })
      for (const l of body) lines.push({ text: l, cls: 'tt-body' })
    }
    lines.push({ text: '', cls: 'tt-meta' })
    for (const l of wrap(`${c.author} <${c.email}>`, tipChars)) lines.push({ text: l, cls: 'tt-who' })
    lines.push({ text: `${c.date} · ${c.short}`, cls: 'tt-meta' })
    if (c.refs.length > 0) {
      for (const l of wrap(c.refs.join(', '), tipChars)) lines.push({ text: l, cls: 'tt-meta' })
    }
    return { lines, height: 14 + lines.length * TIP_LINE }
  })
  const tallest = Math.max(0, ...tips.map(t => t.height))
  const H = Math.max(listH, tallest + ROW + 16)

  const paths = edges
    .map(e => {
      const x1 = x(e.fromCol)
      const y1 = y(e.fromRow)
      const x2 = x(e.toCol)
      const y2 = y(e.toRow)
      const dx = Math.abs(x2 - x1)
      const s = x2 > x1 ? 1 : -1
      let d: string
      if (x1 === x2) {
        d = `M${x1} ${y1}V${y2}`
      } else if (e.join) {
        // Joining a lane that is already running: leave downward, cross over
        // halfway between the rows and turn down into the lane, so the line
        // never touches the next row's dot.
        const ym = (y1 + y2) / 2
        const r = Math.min(CORNER, dx / 2, (y2 - y1) / 2)
        d =
          `M${x1} ${y1}V${ym - r}Q${x1} ${ym} ${x1 + s * r} ${ym}` +
          `H${x2 - s * r}Q${x2} ${ym} ${x2} ${ym + r}V${y2}`
      } else {
        // Elbows with a rounded corner: a branch leaves its dot sideways and
        // turns down into its lane; a lane that ends turns sideways into its dot.
        const r = Math.min(CORNER, dx, Math.abs(y2 - y1))
        d =
          x2 > x1
            ? `M${x1} ${y1}H${x2 - r}Q${x2} ${y1} ${x2} ${y1 + r}V${y2}`
            : `M${x1} ${y1}V${y2 - r}Q${x1} ${y2} ${x1 - r} ${y2}H${x2}`
      }
      return `<path d="${d}" stroke="${color(e.color)}"/>`
    })
    .join('')

  const msgEnd = W - 8
  let dots = ''
  let cards = ''
  let rules = ''
  const rows = commits
    .map((c, i) => {
      const cy = y(i)
      const col = cols[i] ?? 0
      const hue = colors[i] ?? 0
      const isHead = c.refs.some(r => r.startsWith('HEAD'))
      const isMerge = c.parents.length > 1

      // Text starts right after this row's own lines, as in VS Code.
      let textX = x((reach[i] ?? col + 1) - 1) + 12

      // Branch and tag names as pills: the checked-out branch filled, the
      // others (remote branches, tags) outlined.
      let pills = ''
      for (const r of c.refs) {
        if (r === 'HEAD') continue
        const label = r.replace('HEAD -> ', '').replace('tag: ', '#')
        const pillW = Math.round(label.length * PILL_CHAR + 14)
        if (textX + pillW + 60 > msgEnd) break
        const filled = r.startsWith('HEAD -> ')
        pills +=
          `<rect x="${textX}" y="${cy - 8.5}" width="${pillW}" height="17" rx="8.5" ` +
          (filled ? `fill="${color(hue)}"` : `fill="none" stroke="${color(hue)}"`) +
          `/><text x="${textX + pillW / 2}" y="${cy + 3.8}" text-anchor="middle" class="pill"` +
          (filled ? ' fill="#ffffff"' : ` fill="${color(hue)}"`) +
          `>${esc(label)}</text>`
        textX += pillW + 5
      }
      const budget = Math.floor((msgEnd - textX) / CHAR)

      // Dots as VS Code draws them: the checked-out commit a large ring, a
      // merge a ring with a dot inside, any other commit a small dot.
      const cx = x(col)
      dots += isHead
        ? `<circle cx="${cx}" cy="${cy}" r="6.5" class="ring head" stroke="${color(hue)}"/>`
        : isMerge
          ? `<circle cx="${cx}" cy="${cy}" r="5.2" class="ring" stroke="${color(hue)}"/>` +
            `<circle cx="${cx}" cy="${cy}" r="2.2" fill="${color(hue)}"/>`
          : `<circle cx="${cx}" cy="${cy}" r="4" fill="${color(hue)}"/>`

      // The card opens below the row, or above it where the drawing ends.
      const tip = tips[i]
      if (tip !== undefined && i < withCard) {
        const below = cy + ROW / 2 + 4
        const top = below + tip.height <= H ? below : Math.max(2, cy - ROW / 2 - 4 - tip.height)
        const tx = 8
        const text = tip.lines
          .map(
            (l, k) =>
              `<text x="${tx + 12}" y="${top + 20 + k * TIP_LINE}" class="${l.cls}">${esc(l.text)}</text>`,
          )
          .join('')
        cards +=
          `<g class="tip t${i}"><rect x="${tx}" y="${top}" width="${tipW}" height="${tip.height}" rx="8" class="tt-bg" filter="url(#shadow)"/>` +
          `<rect x="${tx}" y="${top}" width="3" height="${tip.height}" rx="1.5" fill="${color(hue)}"/>${text}</g>`
        rules += `svg:has(.r${i}:hover) .t${i}{display:inline}`
      }

      return (
        `<g class="row r${i}">` +
        `<rect class="bg" x="0" y="${cy - ROW / 2}" width="${W}" height="${ROW}" rx="4"/>` +
        pills +
        `<text x="${textX}" y="${cy + 4}" class="msg${isHead ? ' current' : ''}">${esc(cut(c.subject, budget))}</text>` +
        `</g>`
      )
    })
    .join('')

  const style = `
    text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .msg{fill:#1f1f1f}
    .foot{fill:#8b8b8b;font-size:11.5px}
    .current{font-weight:600}
    .pill{font-size:10.5px;font-weight:600}
    .ring{fill:#ffffff;stroke-width:1.6}
    .ring.head{stroke-width:2.2}
    .edges path{fill:none;stroke-width:1.6;stroke-linecap:round}
    .bg{fill:transparent}
    .row:hover .bg{fill:rgba(127,127,127,.14)}
    .tip{display:none;pointer-events:none}
    .tt-bg{fill:#ffffff;stroke:#dcdcdc}
    .tt-title{font-weight:600;fill:#1f1f1f}
    .tt-body{fill:#3a3a3a}
    .tt-who{fill:#1f1f1f;font-size:11.5px}
    .tt-meta{fill:#7a7a7a;font-size:11.5px}
    ${rules}
    @media (prefers-color-scheme: dark){
      .msg{fill:#e8e8e8}
      .ring{fill:#1e1e1e}
      .tt-bg{fill:#2a2a2a;stroke:#444444}
      .tt-title,.tt-who{fill:#ededed}
      .tt-body{fill:#cfcfcf}
      .tt-meta{fill:#9a9a9a}
    }`

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity=".18"/></filter></defs>` +
    `<style>${style}</style>` +
    `<g class="rows">${rows}</g>` +
    `<g class="edges" pointer-events="none">${paths}</g>` +
    `<g class="dots" pointer-events="none">${dots}</g>` +
    `<text x="${PAD - 4}" y="${footY}" class="foot">${esc(footer)}</text>` +
    `<g class="tips">${cards}</g>` +
    `</svg>`

  return { source, width: W, height: H }
}

export const register: Register = on => {
  let poll: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-graph',
      description: 'Show the git commit graph in a pane beside the chat',
    })
    await refresh($)
    // Open by itself only in a git repository; elsewhere /git-graph still opens it.
    if ((await read($, graph)).error === null) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))

    return next(e)
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Git graph pane opened.' }
  })

  // Commits usually happen through Bash: redraw right after one finishes.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    refresh($).catch(() => undefined)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const g = await read($, graph)
    const columns = e.props.bodyColumns ?? 80

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {g.error !== null && <Text color="red">{g.error}</Text>}
          {g.text
            .split('\n')
            .slice(0, Math.max(1, (e.viewport?.rows ?? 30) - 3))
            .map(line => (
              <Text wrap="truncate">{line}</Text>
            ))}
        </Box>
      )
    }

    const { Box, Text, Svg } = $.ui.resolve(e)
    // No header row: the pane scrolls as a whole and would cut it in half.
    // The counts sit under the list; the pane refreshes by itself.
    const branches = new Set(
      g.commits.flatMap(c => c.refs).filter(r => !r.startsWith('tag: ')).map(r => r.replace('HEAD -> ', '')),
    )
    branches.delete('HEAD')
    const footer =
      `${g.commits.length}${g.commits.length === LIMIT ? '+' : ''} commits · ` +
      `${branches.size} ${branches.size === 1 ? 'branch' : 'branches'}`
    // Width in CSS pixels: the pane reports its size in text columns.
    const drawing = svg(g.commits, Math.round(columns * PX_PER_COLUMN), footer)

    return (
      <Box flexDirection="column">
        {g.error !== null && <Text color="red">{g.error}</Text>}
        {g.commits.length > 0 && (
          <Svg
            source={drawing.source}
            width={drawing.width}
            height={drawing.height}
            alt={`Git commit graph with ${g.commits.length} commits`}
            isInteractive
          />
        )}
      </Box>
    )
  })
}
