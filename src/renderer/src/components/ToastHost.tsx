import type { LucideIcon } from 'lucide-react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import type { ToastLevel } from '../store'
import { useStore } from '../store'
import { Icon } from './Icon'

const LEVEL_ICON: Record<ToastLevel, LucideIcon> = {
  success: CircleCheck,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert
}

/** Stacked, auto-dismissing toast notifications anchored bottom-right. */
export function ToastHost(): JSX.Element | null {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotice)
  if (notices.length === 0) return null
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.level}`} role="status">
          <Icon icon={LEVEL_ICON[n.level]} size={15} className="toast-icon" />
          <span className="toast-text">{n.text}</span>
          <button className="btn ghost toast-close" title="Dismiss" onClick={() => dismiss(n.id)}>
            <Icon icon={X} size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
