import { useEffect, useMemo, useRef, useState } from 'react'
import type { FactoryArtifactKind } from '../../../shared/types'

/**
 * A node of the connection graph. FactoryArtifact satisfies this structurally;
 * installed agents (Agents tab) are mapped onto it so they join the same graph.
 * `pending` marks an open suggestion — a "ghost" node not yet built.
 */
export interface FactoryGraphNode {
  name: string
  kind: FactoryArtifactKind
  description: string
  relatedArtifacts: string[]
  pending?: boolean
}

interface NodeState {
  x: number
  y: number
  vx: number
  vy: number
  /** Pinned under the pointer while dragging. */
  dragging: boolean
}

interface GraphLink {
  a: string
  b: string
}

interface ViewTransform {
  x: number
  y: number
  k: number
}

const MIN_K = 0.4
const MAX_K = 2.5
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Force-directed connection graph of the registry (the visual counterpart of
 * the bidirectional `relatedArtifacts` edges) — drag nodes, hover to highlight
 * a node's neighbourhood, click to open a node; scroll to zoom, drag the
 * background to pan, ⤢ to fit. Open suggestions show as dashed ghost nodes, so
 * the network is visibly growing. A tiny self-contained simulation: no chart
 * library, just SVG + rAF.
 */
export function FactoryGraph({
  artifacts,
  onOpen
}: {
  artifacts: FactoryGraphNode[]
  onOpen: (name: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  // Bumped every simulation frame so React re-renders from the position map.
  const [, setFrame] = useState(0)

  const links = useMemo<GraphLink[]>(() => {
    const names = new Set(artifacts.map((a) => a.name))
    const seen = new Set<string>()
    const out: GraphLink[] = []
    for (const a of artifacts) {
      for (const rel of a.relatedArtifacts) {
        if (!names.has(rel) || rel === a.name) continue
        const key = [a.name, rel].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ a: a.name, b: rel })
      }
    }
    return out
  }, [artifacts])

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const l of links) {
      if (!map.has(l.a)) map.set(l.a, new Set())
      if (!map.has(l.b)) map.set(l.b, new Set())
      map.get(l.a)!.add(l.b)
      map.get(l.b)!.add(l.a)
    }
    return map
  }, [links])

  const pendingNames = useMemo(
    () => new Set(artifacts.filter((a) => a.pending).map((a) => a.name)),
    [artifacts]
  )
  const counts = useMemo(() => {
    let skills = 0
    let agents = 0
    let ghosts = 0
    for (const a of artifacts) {
      if (a.pending) ghosts++
      else if (a.kind === 'skill') skills++
      else agents++
    }
    return { skills, agents, ghosts, links: links.length }
  }, [artifacts, links])

  /** Mutable simulation state, keyed by artifact name. */
  const nodesRef = useRef(new Map<string, NodeState>())
  /** Simulation "heat" — decays to 0; re-warmed on data changes and drags. */
  const alphaRef = useRef(1)
  /** Auto-fit once per data shape, when the layout first settles. */
  const fittedRef = useRef(false)

  // Track the container size so the SVG always fills the tab.
  useEffect(() => {
    const measure = (): void => {
      const el = containerRef.current
      if (el) setSize({ w: Math.max(320, el.clientWidth), h: Math.max(280, el.clientHeight) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Seed new nodes (near their already-placed neighbours, else on a circle), drop
  // removed ones, and re-warm + re-fit the layout.
  useEffect(() => {
    const nodes = nodesRef.current
    const names = new Set(artifacts.map((a) => a.name))
    for (const name of [...nodes.keys()]) if (!names.has(name)) nodes.delete(name)
    let i = 0
    for (const a of artifacts) {
      if (!nodes.has(a.name)) {
        // Average of any neighbours already placed → a graceful join.
        let sx = 0
        let sy = 0
        let n = 0
        for (const rel of a.relatedArtifacts) {
          const p = nodes.get(rel)
          if (p) {
            sx += p.x
            sy += p.y
            n++
          }
        }
        const angle = (i / Math.max(1, artifacts.length)) * Math.PI * 2
        const seedX = n > 0 ? sx / n + (Math.random() - 0.5) * 40 : size.w / 2 + Math.cos(angle) * Math.min(size.w, size.h) * 0.3
        const seedY = n > 0 ? sy / n + (Math.random() - 0.5) * 40 : size.h / 2 + Math.sin(angle) * Math.min(size.w, size.h) * 0.3
        nodes.set(a.name, { x: seedX, y: seedY, vx: 0, vy: 0, dragging: false })
      }
      i++
    }
    alphaRef.current = 1
    fittedRef.current = false
  }, [artifacts, size.w, size.h])

  /** Frame the whole node cloud with padding. */
  const fit = (): void => {
    const nodes = nodesRef.current
    if (nodes.size === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [, p] of nodes) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const pad = 60
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = clamp(Math.min((size.w - pad * 2) / bw, (size.h - pad * 2) / bh), MIN_K, MAX_K)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setView({ k, x: size.w / 2 - cx * k, y: size.h / 2 - cy * k })
  }

  // The simulation loop: repulsion + link springs + centering, until cool.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const nodes = nodesRef.current
      const alpha = alphaRef.current
      if (alpha > 0.012 && nodes.size > 0) {
        const list = [...nodes.entries()]
        // Pairwise repulsion.
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [, p] = list[i]
            const [, q] = list[j]
            let dx = p.x - q.x
            let dy = p.y - q.y
            let d2 = dx * dx + dy * dy
            if (d2 < 1) {
              dx = Math.random() - 0.5
              dy = Math.random() - 0.5
              d2 = 1
            }
            const f = (2600 * alpha) / d2
            const d = Math.sqrt(d2)
            p.vx += (dx / d) * f
            p.vy += (dy / d) * f
            q.vx -= (dx / d) * f
            q.vy -= (dy / d) * f
          }
        }
        // Link springs.
        for (const l of links) {
          const p = nodes.get(l.a)
          const q = nodes.get(l.b)
          if (!p || !q) continue
          const dx = q.x - p.x
          const dy = q.y - p.y
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          const f = ((d - 120) / d) * 0.06 * alpha * 10
          p.vx += dx * f
          p.vy += dy * f
          q.vx -= dx * f
          q.vy -= dy * f
        }
        // Gentle pull to the centre + integrate.
        for (const [, p] of nodes) {
          p.vx += (size.w / 2 - p.x) * 0.0035 * alpha
          p.vy += (size.h / 2 - p.y) * 0.0035 * alpha
          if (!p.dragging) {
            p.x += p.vx
            p.y += p.vy
          }
          p.vx *= 0.85
          p.vy *= 0.85
          p.x = Math.min(size.w - 16, Math.max(16, p.x))
          p.y = Math.min(size.h - 16, Math.max(16, p.y))
        }
        alphaRef.current = alpha * 0.985
        // Once the layout has settled, frame it once.
        if (!fittedRef.current && alphaRef.current <= 0.05) {
          fittedRef.current = true
          fit()
        }
        setFrame((f) => f + 1)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, size.w, size.h])

  /** Screen (container-relative) → world (pre-transform) coords. */
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect()
    const sx = clientX - (rect?.left ?? 0)
    const sy = clientY - (rect?.top ?? 0)
    const v = viewRef.current
    return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k }
  }

  // ---- node drag (click with <4px movement opens the node) ----
  const dragRef = useRef<{ name: string; moved: boolean; startX: number; startY: number } | null>(null)

  const onNodeDown = (e: React.PointerEvent<SVGGElement>, name: string): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const node = nodesRef.current.get(name)
    if (!node) return
    node.dragging = true
    dragRef.current = { name, moved: false, startX: e.clientX, startY: e.clientY }
  }
  const onNodeMove = (e: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const node = nodesRef.current.get(drag.name)
    if (!node) return
    if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 4) drag.moved = true
    const pt = toWorld(e.clientX, e.clientY)
    node.x = pt.x
    node.y = pt.y
    alphaRef.current = Math.max(alphaRef.current, 0.3)
    setFrame((f) => f + 1)
  }
  const onNodeUp = (e: React.PointerEvent<SVGGElement>, name: string): void => {
    const drag = dragRef.current
    dragRef.current = null
    const node = nodesRef.current.get(name)
    if (node) node.dragging = false
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      // capture may already be gone
    }
    if (drag && !drag.moved) onOpen(name)
  }

  // ---- background pan ----
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const onBgDown = (e: React.PointerEvent<SVGRectElement>): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    panRef.current = { startX: e.clientX, startY: e.clientY, ox: view.x, oy: view.y }
  }
  const onBgMove = (e: React.PointerEvent<SVGRectElement>): void => {
    const pan = panRef.current
    if (!pan) return
    setView((v) => ({ ...v, x: pan.ox + (e.clientX - pan.startX), y: pan.oy + (e.clientY - pan.startY) }))
  }
  const onBgUp = (e: React.PointerEvent<SVGRectElement>): void => {
    panRef.current = null
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  // ---- wheel zoom (around the pointer) ----
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    const sx = e.clientX - (rect?.left ?? 0)
    const sy = e.clientY - (rect?.top ?? 0)
    setView((v) => {
      const k = clamp(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_K, MAX_K)
      const wx = (sx - v.x) / v.k
      const wy = (sy - v.y) / v.k
      return { k, x: sx - wx * k, y: sy - wy * k }
    })
  }

  if (artifacts.length === 0) {
    return (
      <div className="factory-graph-empty">
        Nothing to map yet — generated artifacts, installed agents and pending suggestions appear
        here as a graph.
      </div>
    )
  }

  const hoverSet = hover ? new Set([hover, ...(neighbours.get(hover) ?? [])]) : null

  return (
    <div className="factory-graph" ref={containerRef} onWheel={onWheel}>
      <svg width={size.w} height={size.h}>
        {/* Background pan surface (behind the transformed content). */}
        <rect
          x={0}
          y={0}
          width={size.w}
          height={size.h}
          fill="transparent"
          onPointerDown={onBgDown}
          onPointerMove={onBgMove}
          onPointerUp={onBgUp}
        />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const p = nodesRef.current.get(l.a)
            const q = nodesRef.current.get(l.b)
            if (!p || !q) return null
            const lit = hover !== null && (l.a === hover || l.b === hover)
            const pending = pendingNames.has(l.a) || pendingNames.has(l.b)
            return (
              <line
                key={`${l.a}-${l.b}`}
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
                className={`factory-graph-link${lit ? ' lit' : ''}${hover && !lit ? ' dim' : ''}${pending ? ' pending' : ''}`}
              />
            )
          })}
          {artifacts.map((a) => {
            const p = nodesRef.current.get(a.name)
            if (!p) return null
            const dim = hoverSet !== null && !hoverSet.has(a.name)
            const r = 7 + Math.min(6, (neighbours.get(a.name)?.size ?? 0) * 1.5)
            return (
              <g
                key={a.name}
                className={`factory-graph-node kind-${a.kind}${a.pending ? ' pending' : ''}${dim ? ' dim' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                onPointerDown={(e) => onNodeDown(e, a.name)}
                onPointerMove={onNodeMove}
                onPointerUp={(e) => onNodeUp(e, a.name)}
                onMouseEnter={() => setHover(a.name)}
                onMouseLeave={() => setHover(null)}
              >
                <circle r={r} />
                <text y={r + 12}>{a.name}</text>
                <title>{`${a.pending ? 'suggested ' : ''}${a.kind}: ${a.name}\n${a.description}`}</title>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="factory-graph-toolbar">
        <button className="btn ghost" title="Zoom in" onClick={() => setView((v) => ({ ...v, k: clamp(v.k * 1.2, MIN_K, MAX_K) }))}>
          ＋
        </button>
        <button className="btn ghost" title="Zoom out" onClick={() => setView((v) => ({ ...v, k: clamp(v.k / 1.2, MIN_K, MAX_K) }))}>
          －
        </button>
        <button className="btn ghost" title="Fit to view" onClick={fit}>
          ⤢
        </button>
      </div>
      <div className="factory-graph-stats">
        {counts.skills} skills · {counts.agents} agents
        {counts.ghosts > 0 && ` · ${counts.ghosts} suggested`} · {counts.links} links
      </div>
      <div className="factory-graph-legend">
        <span className="kind-chip kind-skill">skill</span>
        <span className="kind-chip kind-agent">agent</span>
        {counts.ghosts > 0 && <span className="kind-chip kind-suggestion">suggested</span>}
        <span className="factory-graph-hint">scroll to zoom · drag to arrange · click to open</span>
      </div>
    </div>
  )
}
