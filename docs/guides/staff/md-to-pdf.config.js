// md-to-pdf configuration for the School Forms STAFF guide.
//
// Renders docs/guides/staff/staff-guide.html to docs/guides/staff/staff-guide.pdf
// using the staff print stylesheet.
//
// Run with:  npm run guide:staff:pdf
const path = require("path");

module.exports = {
  stylesheet: [path.join(__dirname, "staff-guide.css")],
  dest: path.join(__dirname, "staff-guide.pdf"),
  // The HTML carries its own <head>; md-to-pdf still needs to know the document
  // is HTML rather than Markdown so it does not try to parse it as one.
  body_class: [],
  pdf_options: {
    format: "Letter",
    printBackground: true,
    margin: { top: "18mm", right: "16mm", bottom: "16mm", left: "16mm" },
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="font-family: Open Sans, sans-serif; font-size: 8px; color: #7b8794; width: 100%; padding: 0 16mm; display: flex; justify-content: space-between;">' +
      "<span>School Forms — Staff Guide</span>" +
      '<span class="pageNumber"></span>' +
      "</div>",
  },
  launch_options: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
};
