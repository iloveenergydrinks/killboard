import type { CSSProperties } from "react";
import type { KillboardArt } from "#/lib/art-server";
import type { Container, ContainerItem } from "#/lib/api";

type Tooltips = {
  item: (source: Record<string, unknown>) => {
    Header: {
      Name: string;
      Type: string;
      Tier: string;
      Quality?: string;
      PointRating?: number;
    };
    Rows: {
      Label: string;
      Value?: string;
      Tone?: string;
      Badge?: string;
      Appearance?: string;
    }[];
  };
};

const SIZES: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/**
 * An item's footprint in cells: its shape is width x height ("ONExTHREE" is one column, three rows),
 * and a quarter turn swaps the two.
 */
function footprint(item: ContainerItem) {
  const [width = 1, height = 1] = item.shape
    .split("x")
    .map((part) => SIZES[part] ?? 1);
  return item.rotation % 2 === 0 ? { width, height } : { width: height, height: width };
}

/**
 * A ship's grid as the API gives it (rows x columns, each cell's slot type) with its items placed
 * on it: an item's render, rarity edge and, when it was lost with the ship, a struck-out mark. Every
 * item opens its details on hover or focus. Cells outside the ship's grid are left empty, and the
 * grid is cropped to the rows and columns the ship uses.
 */
export function FittingGrid({
  grid,
  art,
  tooltips,
  label,
}: {
  grid: Container;
  art: KillboardArt;
  tooltips: Tooltips;
  label: string;
}) {
  const used = (index: number) => grid.slots[index] && grid.slots[index] !== "None";
  let top = grid.rows;
  let bottom = -1;
  let left = grid.columns;
  let right = -1;
  for (let row = 0; row < grid.rows; row++)
    for (let col = 0; col < grid.columns; col++)
      if (used(row * grid.columns + col)) {
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        left = Math.min(left, col);
        right = Math.max(right, col);
      }
  for (const item of grid.items) {
    const { width, height } = footprint(item);
    top = Math.min(top, item.row);
    left = Math.min(left, item.col);
    bottom = Math.max(bottom, item.row + height - 1);
    right = Math.max(right, item.col + width - 1);
  }
  if (bottom < top || right < left) return <div className="kb-empty">Empty</div>;

  const cells = [];
  for (let row = top; row <= bottom; row++)
    for (let col = left; col <= right; col++) {
      const slot = grid.slots[row * grid.columns + col];
      if (!slot || slot === "None") continue;
      cells.push(
        <span
          key={`${row}:${col}`}
          className={`kb-cell is-${slot.toLowerCase()}`}
          style={{ gridRow: row - top + 1, gridColumn: col - left + 1 }}
        />,
      );
    }

  return (
    <div
      className="kb-grid"
      role="list"
      aria-label={label}
      style={
        {
          "--kb-grid-columns": right - left + 1,
          "--kb-grid-rows": bottom - top + 1,
        } as CSSProperties
      }
    >
      {cells}
      {grid.items.map((item, index) => {
        const { width, height } = footprint(item);
        const tooltip = tooltips.item({
          ...item,
          facts: {
            quality: item.quality,
            pointRating: item.pointRating,
            modifiers: item.modifiers,
          },
        });
        const rarity = (item.rarity ?? "Normal").toLowerCase();
        return (
          <div
            key={`${item.row}:${item.col}:${index}`}
            role="listitem"
            tabIndex={0}
            className={`kb-grid-item is-${rarity}${item.isDestroyed ? " is-destroyed" : ""}`}
            style={{
              gridRow: `${item.row - top + 1} / span ${height}`,
              gridColumn: `${item.col - left + 1} / span ${width}`,
            }}
            aria-label={`${item.name}${item.isDestroyed ? ", destroyed" : ", dropped"}`}
          >
            <img
              src={
                art.item(
                  { def: item.def, rarity: item.rarity, artifactDef: item.artifact },
                  item.name,
                ) ?? undefined
              }
              alt=""
              loading="lazy"
              decoding="async"
            />
            {item.quantity > 1 ? (
              <span className="kb-grid-quantity">{item.quantity}</span>
            ) : null}
            <div className="kb-tip" role="tooltip">
              <div className="kb-tip-name">{tooltip.Header.Name}</div>
              <div className="kb-tip-meta">
                <span>{tooltip.Header.Tier}</span>
                <span>{tooltip.Header.Type}</span>
                {tooltip.Header.Quality ? <span>{tooltip.Header.Quality}</span> : null}
                {tooltip.Header.PointRating ? (
                  <span>{tooltip.Header.PointRating} BR</span>
                ) : null}
              </div>
              {tooltip.Rows.map((row, rowIndex) =>
                row.Appearance === "Heading" ? (
                  <div key={rowIndex} className="kb-tip-heading">
                    {row.Label}
                  </div>
                ) : (
                  <div
                    key={rowIndex}
                    className={`kb-tip-row${row.Tone ? ` is-${row.Tone.toLowerCase()}` : ""}`}
                  >
                    <span>
                      {row.Label}
                      {row.Badge ? <em>{row.Badge}</em> : null}
                    </span>
                    {row.Value ? <b>{row.Value}</b> : null}
                  </div>
                ),
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
