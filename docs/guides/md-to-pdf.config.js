// md-to-pdf configuration for the School Forms user guide.
// Renders docs/guides/user-guide.md to docs/guides/school-forms-user-guide.pdf
// using the WCPSS-branded print stylesheet.
//
// Run with:  npm run guide:pdf
const path = require("path");

module.exports = {
  stylesheet: [path.join(__dirname, "guide.css")],
  // md-to-pdf derives the output name from the input by default; set it
  // explicitly so the published filename is stable.
  dest: path.join(__dirname, "school-forms-user-guide.pdf"),
  pdf_options: {
    format: "Letter",
    printBackground: true,
    margin: { top: "20mm", right: "18mm", bottom: "18mm", left: "18mm" },
    // Page numbers in the footer, with the guide title.
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="font-family: Open Sans, sans-serif; font-size: 8px; color: #7b8794; width: 100%; padding: 0 18mm; display: flex; justify-content: space-between;">' +
      "<span>School Forms — User Guide</span>" +
      '<span class="pageNumber"></span>' +
      "</div>",
  },
  // Wait for the Google Fonts import in guide.css to load before printing.
  launch_options: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
};
