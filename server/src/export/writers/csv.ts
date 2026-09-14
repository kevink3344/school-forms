// -----------------------------------------------------------------------------
// CSV writer — the original export format, byte-for-byte compatible with the
// pre-existing /api/export/csv response (UTF-8 BOM + CRLF line endings).
// -----------------------------------------------------------------------------
import { csvEscape, type TableModel } from "../table.js";

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export function writeCsv(table: TableModel): string {
  const lines = [table.headers.map((h) => csvEscape(h.header)).join(",")];
  for (const row of table.rows) {
    lines.push(table.headers.map((h) => csvEscape(row[h.key])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}
