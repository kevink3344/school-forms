// md-to-pdf configuration for the School Forms ADMIN guide.
//
// Renders docs/guides/admin/admin-guide.html to docs/guides/admin/admin-guide.pdf
// using the admin print stylesheet.
//
// Run with:  npm run guide:admin:pdf
const path = require("path");

module.exports = {
  stylesheet: [path.join(__dirname, "admin-guide.css")],
  dest: path.join(__dirname, "admin-guide.pdf"),
  pdf_options: {
    format: "Letter",
    printBackground: true,
    margin: { top: "18mm", right: "16mm", bottom: "16mm", left: "16mm" },
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      '<div style="font-family: Open Sans, sans-serif; font-size: 8px; color: #7b8794; width: 100%; padding: 0 16mm; display: flex; justify-content: space-between;">' +
      "<span>School Forms — Admin Guide</span>" +
      '<span class="pageNumber"></span>' +
      "</div>",
  },
  launch_options: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
};
