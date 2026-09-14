// -----------------------------------------------------------------------------
// XLSX writer — real Excel workbooks via exceljs (pure JS, no native build).
//
// Values are written as strings, matching the CSV export's semantics (no type
// guessing / no locale-dependent date coercion). The header row is bold, frozen,
// and auto-filtered so the sheet behaves like a table on open.
// -----------------------------------------------------------------------------
import ExcelJS from "exceljs";
import { cellText, type TableModel } from "../table.js";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Excel worksheets cap names at 31 chars and forbid : \ / ? * [ ]
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim();
  return (cleaned || "Report").slice(0, 31);
}

// Approximate width of the longest value in a column, clamped to a sane range.
function columnWidth(table: TableModel, key: string, headerLen: number): number {
  let max = headerLen;
  // Sample the first 200 rows — enough to size the column without walking a
  // 10k-row report twice.
  for (const row of table.rows.slice(0, 200)) {
    const len = cellText(row[key]).length;
    if (len > max) max = len;
  }
  return Math.min(Math.max(max + 2, 12), 50);
}

export async function writeXlsx(table: TableModel, sheetName = "Report"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "School Forms";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(safeSheetName(sheetName), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = table.headers.map((h) => ({
    header: h.header,
    key: h.key,
    width: columnWidth(table, h.key, h.header.length),
  }));

  for (const row of table.rows) {
    const out: Record<string, string> = {};
    for (const h of table.headers) out[h.key] = cellText(row[h.key]);
    sheet.addRow(out);
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 20;

  // Auto-filter spans the used range so the reader can sort/filter immediately.
  if (table.headers.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: table.headers.length },
    };
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}
