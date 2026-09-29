import { Compass } from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState } from '../components/ui'

export function NotFoundPage() {
  return (
    <EmptyState icon={<Compass size={28} />} title="没有这个页面">
      <Link to="/attention" className="link">
        回到需要关注
      </Link>
    </EmptyState>
  )
}
