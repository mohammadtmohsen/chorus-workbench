/**
 * The curve that joins the active tab to the pane below it.
 *
 * Browsers and editors all solve this the same way, and it is worth naming: the
 * tab and the panel are one surface, and where the tab's rounded top meets the
 * panel's flat edge there is a *concave* quarter-round turning outward on each
 * side. Without it a tab is a rounded rectangle sitting on a line — which is
 * what Chorus drew, and why the join read as two shapes touching rather than one
 * shape with a tab on it.
 *
 * Three layers, and each is load-bearing:
 *
 *  - **the bridge**, a 1px bar running from one curve's outer edge to the
 *    other's, painting over the pane body's top border for the tab's whole
 *    width plus both curves. Chorus already erased that border under the tab
 *    itself with `border-bottom-color`; the curves widen the erasure and this is
 *    what keeps it continuous across them.
 *  - **two curves**, each an SVG rather than a CSS pseudo-element, because the
 *    corner needs a *fill* — the pane's surface, flooding into the notch — and a
 *    *stroke* on the same arc, in the tab's border colour. A `border-radius`
 *    trick gives one or the other, not both, which is why every implementation
 *    of this reaches for SVG.
 *
 * Authored at 11px with a radius of 8, rather than scaling artwork drawn for a
 * chunkier tab: Chorus's corner is 9px with a 1px border, so a copy scaled down
 * from a 14px corner with a 2px border would have arrived carrying a 1.4px
 * stroke that renders soft. The control points are the usual quarter-arc
 * constant — 8 × 0.5523 — so the arc meets both straight edges tangentially.
 *
 * **11px and half-pixel coordinates, because 10px left visible breaks.** A 1px
 * stroke is centred on its path, so a path along the box's own edge renders half
 * outside it. The box is one pixel wider than the curve to hold that half, the
 * arc sits on `x = 10.5` — the centre of the tab's 1px border, not its inside
 * face — and the path carries a straight segment at each end that runs *into*
 * the lines it joins rather than stopping at them. Butting two strokes end to
 * end leaves a hairline at any fractional device-pixel offset; overlapping them
 * cannot.
 *
 * `currentColor` on the stroke and `--bg-pane-active` on the fill, so the curve
 * follows the tab it belongs to rather than restating either value.
 */
export function TabJoin(): React.JSX.Element {
  return (
    <>
      <span className="workspace-tab-bridge" aria-hidden="true" />
      <svg
        className="workspace-tab-curve workspace-tab-curve--left"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M11 0H10.5V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0V11H11Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M10.5 0V2.5C10.5 6.92 6.92 10.5 2.5 10.5H0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
      <svg
        className="workspace-tab-curve workspace-tab-curve--right"
        viewBox="0 0 11 11"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M0 0H0.5V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11V11H0Z" fill="var(--tab-join)" />
        <path
          className="workspace-tab-curve-line"
          d="M0.5 0V2.5C0.5 6.92 4.08 10.5 8.5 10.5H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    </>
  )
}
