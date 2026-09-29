import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { MORE_ITEMS } from '../components/Shell'
import { PageHeader } from '../components/ui'

export function MorePage() {
  return (
    <>
      <PageHeader title="更多" />
      <ul className="menu-list">
        {MORE_ITEMS.map(({ to, label, Icon, description }) => (
          <li key={to}>
            <Link to={to} className="menu-item">
              <Icon size={20} aria-hidden={true} />
              <span>
                <strong>{label}</strong>
                <span className="muted small">{description}</span>
              </span>
              <ChevronRight size={18} aria-hidden={true} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
