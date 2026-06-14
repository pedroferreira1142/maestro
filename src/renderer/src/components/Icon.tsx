import type { LucideIcon } from 'lucide-react'
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  LoaderCircle
} from 'lucide-react'
import type { SessionStatus } from '../../../shared/types'

interface IconProps {
  icon: LucideIcon
  /** Pixel box (width = height); match the surrounding text/glyph sizing. */
  size?: number
  strokeWidth?: number
  className?: string
  /** When set the icon is exposed to assistive tech; otherwise it is hidden. */
  label?: string
}

/** Thin wrapper standardising size, stroke and a11y for a Lucide icon. */
export function Icon({
  icon: LucideGlyph,
  size = 14,
  strokeWidth = 2,
  className,
  label
}: IconProps): JSX.Element {
  return (
    <LucideGlyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

/**
 * Session/terminal status → icon. Shapes are deliberately distinguishable
 * without relying on colour (dashed ring / spinner / filled dot / check /
 * open ring / slash / alert), so status reads correctly for colour-blind users.
 */
export const STATUS_ICON: Record<SessionStatus, LucideIcon> = {
  starting: CircleDashed,
  working: LoaderCircle,
  'needs-attention': CircleDot,
  done: CircleCheck,
  idle: Circle,
  exited: CircleSlash,
  error: CircleAlert
}

/**
 * A status glyph rendered as an SVG inside the established
 * `.glyph.status-{status}` span — the existing colour and spin/pulse/done-pop
 * animations keyed off that class keep working unchanged.
 */
export function StatusIcon({
  status,
  className,
  label,
  title,
  size = 14
}: {
  status: SessionStatus
  className?: string
  label?: string
  title?: string
  size?: number
}): JSX.Element {
  return (
    <span
      className={`glyph status-${status}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={label}
    >
      <Icon icon={STATUS_ICON[status]} size={size} />
    </span>
  )
}
