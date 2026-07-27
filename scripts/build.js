const esbuild = require("esbuild");
const fs = require("fs");

const watchMode = process.argv.includes("--watch");

async function build() {
  // Ensure dist directory exists
  if (!fs.existsSync("dist")) {
    fs.mkdirSync("dist");
  }

  // Copy static assets
  fs.copyFileSync("manifest.json", "dist/manifest.json");
  fs.copyFileSync("src/index.html", "dist/index.html");
  fs.copyFileSync("src/style.css", "dist/style.css");

  const options = {
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/index.js",
    target: ["esnext"], // Modern browsers only
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
