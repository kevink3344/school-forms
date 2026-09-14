// -----------------------------------------------------------------------------
// PDF writer — server-side landscape table via pdfkit (pure JS, no Chromium).
//
// Chosen over a browser "print to PDF" so the downloaded file is generated from
// exactly the same server-side query that produced the on-screen preview, and so
// multi-thousand-row reports don't have to live in the DOM first.
//
// NOTE: pdfkit's built-in Helvetica uses WinAnsi encoding, so non-Latin glyphs
// (CJK, Cyrillic, ...) will not render. If that becomes a requirement, register
// a TTF with `doc.registerFont(...)` and `doc.font(...)` below.
// -----------------------------------------------------------------------------
import PDFDocument from "pdfkit";
import { cellText, type TableModel } from "../table.js";

export const PDF_CONTENT_TYPE = "application/pdf";

const MARGIN = 36;
const CELL_FONT_SIZE = 8;
const HEADER_FONT_SIZE = 8;
const CELL_PADDING = 4;
const MIN_COL_WIDTH = 46;
const MAX_CELL_LINES = 3;
const HEADER_BLOCK_HEIGHT = 54;
const FOOTER_HEIGHT = 20;

const BORDER = "#dfe5ea";
const HEADER_BG = "#eef2f6";
const ZEBRA_BG = "#f7f9fb";
const TEXT = "#1f2933";
const MUTED = "#6b7a8a";

// Natural width weight for a column: the longest sampled cell, clamped so one
// runaway value can't crowd out every other column.
function columnWeights(table: TableModel): number[] {
  return table.headers.map((h) => {
    let max = h.header.length;
    for (const row of table.rows.slice(0, 200)) {
      const len = cellText(row[h.key]).length;
      if (len > max) max = len;
    }
    return Math.min(Math.max(max, 6), 40);
  });
}

export async function writePdf(table: TableModel): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      layout: "landscape",
      margin: MARGIN,
      bufferPages: true,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - MARGIN * 2;
    const bottom = doc.page.height - MARGIN - FOOTER_HEIGHT;

    // --- Column widths: proportional to content, clamped, then re-scaled to the
    // printable width if the per-column minimum pushed us over.
    const weights = columnWeights(table);
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    let widths = weights.map((w) => Math.max((w / totalWeight) * pageWidth, MIN_COL_WIDTH));
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    if (totalWidth > pageWidth) {
      const factor = pageWidth / totalWidth;
      widths = widths.map((w) => w * factor);
    }

    // --- Letterhead -------------------------------------------------------
    doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(14);
    doc.text(table.title || "Report", MARGIN, MARGIN, { width: pageWidth });

    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    const sub = table.subtitle || "";
    doc.text(sub, MARGIN, MARGIN + 20, { width: pageWidth });

    doc.fontSize(8);
    doc.text(
      `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} · ${table.rows.length} rows · ${table.headers.length} columns`,
      MARGIN,
      MARGIN + 34,
      { width: pageWidth }
    );

    let y = MARGIN + HEADER_BLOCK_HEIGHT;

    // --- Table header row -------------------------------------------------
    doc.font("Helvetica-Bold").fontSize(HEADER_FONT_SIZE);
    const headerLineHeight = doc.currentLineHeight();
    const headerHeight = headerLineHeight + CELL_PADDING * 2;

    const drawHeader = (top: number) => {
      doc.rect(MARGIN, top, pageWidth, headerHeight).fill(HEADER_BG);
      let x = MARGIN;
      doc.fillColor(TEXT).font("Helvetica-Bold").fontSize(HEADER_FONT_SIZE);
      for (let i = 0; i < table.headers.length; i++) {
        doc.text(table.headers[i].header, x + CELL_PADDING, top + CELL_PADDING, {
          width: widths[i] - CELL_PADDING * 2,
          height: headerLineHeight,
          lineBreak: false,
          ellipsis: true,
        });
        x += widths[i];
      }
    };

    drawHeader(y);
    y += headerHeight;

    // --- Body rows --------------------------------------------------------
    doc.font("Helvetica").fontSize(CELL_FONT_SIZE);
    const bodyLineHeight = doc.currentLineHeight();

    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];

      // Measure the row: tallest cell wins, capped at MAX_CELL_LINES.
      let rowHeight = bodyLineHeight + CELL_PADDING * 2;
      const cells: string[] = [];
      for (let i = 0; i < table.headers.length; i++) {
        const text = cellText(row[table.headers[i].key]);
        cells.push(text);
        if (!text) continue;
        const h = doc.heightOfString(text, { width: widths[i] - CELL_PADDING * 2 });
        const capped = Math.min(h, bodyLineHeight * MAX_CELL_LINES) + CELL_PADDING * 2;
        if (capped > rowHeight) rowHeight = capped;
      }

      // Page break — repeat the header on the new page.
      if (y + rowHeight > bottom) {
        doc.addPage();
        y = MARGIN;
        drawHeader(y);
        y += headerHeight;
        doc.font("Helvetica").fontSize(CELL_FONT_SIZE);
      }

      if (r % 2 === 1) {
        doc.rect(MARGIN, y, pageWidth, rowHeight).fill(ZEBRA_BG);
      }

      let x = MARGIN;
      doc.fillColor(TEXT).font("Helvetica").fontSize(CELL_FONT_SIZE);
      for (let i = 0; i < cells.length; i++) {
        if (cells[i]) {
          doc.text(cells[i], x + CELL_PADDING, y + CELL_PADDING, {
            width: widths[i] - CELL_PADDING * 2,
            height: rowHeight - CELL_PADDING * 2,
            ellipsis: true,
          });
        }
        x += widths[i];
      }

      // Hairline under each row.
      doc
        .moveTo(MARGIN, y + rowHeight)
        .lineTo(MARGIN + pageWidth, y + rowHeight)
        .lineWidth(0.5)
        .strokeColor(BORDER)
        .stroke();

      y += rowHeight;
    }

    if (table.rows.length === 0) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10);
      doc.text("No rows match the current filters.", MARGIN, y + 12, { width: pageWidth });
    }

    // --- Page footers ("Page n of m") -------------------------------------
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8);
      doc.text(`Page ${p - range.start + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN - 10, {
        width: pageWidth,
        align: "right",
        lineBreak: false,
      });
    }

    doc.end();
  });
}
