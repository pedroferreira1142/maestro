import { useEffect, useMemo, useRef, useState } from 'react'
import type { FactoryArtifactKind } from '../../../shared/types'

/**
 * A node of the connection graph. FactoryArtifact satisfies this structurally;
 * installed agents (Agents tab) are mapped onto it so they join the same graph.
 */
export interface FactoryGraphNode {
  name: string
  kind: FactoryArtifactKind
  description: string
  relatedArtifacts: string[]
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

/**
 * Force-directed connection graph of the registry (the visual counterpart of
 * the bidirectional `relatedArtifacts` edges) — drag nodes, hover to highlight
 * a node's neighbourhood, click to open the artifact in the Registry tab.
 * A tiny self-contained simulation: no chart library, just SVG + rAF.
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

  /** Mutable simulation state, keyed by artifact name. */
  const nodesRef = useRef(new Map<string, NodeState>())
  /** Simulation "heat" — decays to 0; re-warmed on data changes and drags. */
  const alphaRef = useRef(1)

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

  // Seed new nodes on a circle, drop removed ones, and re-warm the layout.
  useEffect(() => {
    const nodes = nodesRef.current
    const names = new Set(artifacts.map((a) => a.name))
    for (const name of [...nodes.keys()]) if (!names.has(name)) nodes.delete(name)
    let i = 0
    for (const a of artifacts) {
      if (!nodes.has(a.name)) {
        const angle = (i / Math.max(1, artifacts.length)) * Math.PI * 2
        nodes.set(a.name, {
          x: size.w / 2 + Math.cos(angle) * Math.min(size.w, size.h) * 0.3,
          y: size.h / 2 + Math.sin(angle) * Math.min(size.w, size.h) * 0.3,
          vx: 0,
          vy: 0,
          dragging: false
        })
      }
      i++
    }
    alphaRef.current = 1
  }, [artifacts, size.w, size.h])

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
        setFrame((f) => f + 1)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [links, size.w, size.h])

  // Drag interaction (click with <4px movement opens the artifact).
  const dragRef = useRef<{ name: string; moved: boolean; startX: number; startY: number } | null>(null)
  const svgPoint = (e: React.PointerEvent<SVGGElement>): { x: number; y: number } => {
    const svg = e.currentTarget.ownerSVGElement
    const rect = (svg ?? e.currentTarget).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onNodeDown = (e: React.PointerEvent<SVGGElement>, name: string): void => {
    e.preventDefault()
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
    const pt = svgPoint(e)
    node.x = pt.x
    node.y = pt.y
    alphaRef.current = Math.max(alphaRef.current, 0.3)
    setFrame((f) => f + 1)
  }
  const onNodeUp = (e: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    const node = nodesRef.current.get(drag.name)
    if (node) node.dragging = false
    ;(e.target as Element).releasePointerCapture(e.pointerId)
    if (!drag.moved) onOpen(drag.name)
  }

  if (artifacts.length === 0) {
    return (
      <div className="factory-graph-empty">
        Nothing to map yet — generated artifacts and their relations appear here as a graph.
      </div>
    )
  }

  const hoverSet = hover ? new Set([hover, ...(neighbours.get(hover) ?? [])]) : null

  return (
    <div className="factory-graph" ref={containerRef}>
      <svg width={size.w} height={size.h}>
        {links.map((l) => {
          const p = nodesRef.current.get(l.a)
          const q = nodesRef.current.get(l.b)
          if (!p || !q) return null
          const lit = hover !== null && (l.a === hover || l.b === hover)
          return (
            <line
              key={`${l.a}-${l.b}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              className={`factory-graph-link${lit ? ' lit' : ''}${hover && !lit ? ' dim' : ''}`}
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
              className={`factory-graph-node kind-${a.kind}${dim ? ' dim' : ''}`}
              transform={`translate(${p.x},${p.y})`}
              onPointerDown={(e) => onNodeDown(e, a.name)}
              onPointerMove={onNodeMove}
              onPointerUp={onNodeUp}
              onMouseEnter={() => setHover(a.name)}
              onMouseLeave={() => setHover(null)}
            >
              <circle r={r} />
              <text y={r + 12}>{a.name}</text>
              <title>{`${a.kind}: ${a.name}\n${a.description}`}</title>
            </g>
          )
        })}
      </svg>
      <div className="factory-graph-legend">
        <span className="kind-chip kind-skill">skill</span>
        <span className="kind-chip kind-agent">agent</span>
        <span className="factory-graph-hint">drag to arrange · click a node to open it</span>
      </div>
    </div>
  )
}
