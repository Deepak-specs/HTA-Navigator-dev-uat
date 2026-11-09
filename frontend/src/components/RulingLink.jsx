/**
 * RulingLink.jsx — a ruling title that is a real link
 * ---------------------------------------------------
 * Ruling titles used to be <button>s, so the browser had nothing to offer on a
 * right-click or a ctrl/middle-click: no "Open link in new tab", no "Open link
 * in new window", no copyable address. This renders the same thing as an <a>
 * pointing at /ruling/:id, so the browser's own link affordances all work.
 *
 * A plain left-click is still handled in the app: when `onOpen` is given it
 * takes over (the in-page pane on the search results), otherwise react-router
 * navigates. Modified clicks — ctrl/cmd (new tab), shift (new window), alt
 * (download), middle button — are left to the browser untouched.
 */
import { Link } from "react-router-dom";

export default function RulingLink({
  id,
  onOpen,
  className,
  style,
  children,
  ...rest
}) {
  const handleClick = (e) => {
    // Let the browser own anything but an unmodified primary click.
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!onOpen) return;             // no in-page handler: let the Link route
    e.preventDefault();
    onOpen(id);
  };

  return (
    <Link
      to={id != null ? `/ruling/${id}` : "#"}
      onClick={handleClick}
      className={className}
      style={{ textDecoration: "none", ...style }}
      {...rest}
    >
      {children}
    </Link>
  );
}
