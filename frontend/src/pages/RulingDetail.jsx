/**
 * RulingDetail.jsx — Sr 53
 * ─────────────────────────────────────────────────────────────────────────────
 * Route wrapper for /ruling/:id.
 *
 * The view itself lives in components/RulingPane.jsx so one implementation
 * serves both this route and the in-place pane inside Ruling Search (Sr 50).
 * Keeping the route means existing deep links, bookmarks and the "Open" action
 * in the Home feed all still work.
 *
 * The previous 724-line page has not been discarded: its PDF export moved
 * verbatim to lib/rulingPdf.js, and its content was rebuilt in the v2 design
 * system inside RulingPane. The original is in frontend-bkp_20261002/.
 */
import { useParams, useNavigate } from "react-router-dom";
import RulingPane from "../components/RulingPane";

export default function RulingDetail() {
  const { id }   = useParams();
  const navigate = useNavigate();

  return (
    <div data-testid="ruling-detail-page">
      <div className="v2-crumb">
        <button
          type="button"
          onClick={() => navigate("/search")}
          style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }}
        >
          Research / Ruling search
        </button>
        {" / Ruling"}
      </div>

      <RulingPane rulingId={id} />
    </div>
  );
}
