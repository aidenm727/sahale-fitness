import { Link } from 'react-router'
import { Page } from '@/ui/Page'

export function NotFound({ what = 'place' }: { what?: string }) {
  return (
    <Page>
      <div className="notfound">
        <div className="label">Off the map</div>
        <h1 className="ph-title">There’s no {what} here.</h1>
        <p className="ph-lede">It may have been deleted, or the link is from somewhere else.</p>
        <div className="notfound-actions">
          <Link to="/" className="btn">
            Go to the overview
          </Link>
        </div>
      </div>
    </Page>
  )
}
