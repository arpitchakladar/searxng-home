const esbuild = require("esbuild");
const fs = require("fs");
const { minify: minifyHtml } = require("html-minifier-terser");

const watchMode = process.argv.includes("--watch");

async function build() {
  // Ensure dist directory exists
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist");
  }

  // 1. Minify and copy manifest.json
  const manifestRaw = fs.readFileSync("manifest.json", "utf8");
  const manifestContent = watchMode
    ? manifestRaw
    : JSON.stringify(JSON.parse(manifestRaw)); // Minifies JSON by stripping whitespace
  fs.writeFileSync("dist/manifest.json", manifestContent);

  // 2. Minify and copy index.html
  const htmlRaw = fs.readFileSync("src/index.html", "utf8");
  const htmlContent = watchMode
    ? htmlRaw
    : await minifyHtml(htmlRaw, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true,
      });
  fs.writeFileSync("dist/index.html", htmlContent);

  // 3. Bundling TS and minifying CSS using esbuild
  const options = {
    entryPoints: ["src/index.ts", "src/style.css"], // Added style.css as an entry point
    bundle: true,
    outdir: "dist", // Changed from outfile to outdir since we have multiple entry points
    target: ["esnext"],
    format: "esm",
    minify: !watchMode,
    sourcemap: watchMode ? "inline" : false,
  };

  if (watchMode) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("Watching in dev mode");
  } else {
    await esbuild.build(options);
    console.log("Build was successful");
  }
}

build().catch(() => process.exit(1));
