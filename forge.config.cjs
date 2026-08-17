module.exports = {
  packagerConfig: {
    name: "Historical Evidence Workbench",
    productName: "史料研析台",
    executableName: "Historical Evidence Workbench",
    appBundleId: "org.historicalevidence.workbench",
    appCategoryType: "public.app-category.education",
    electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
    asar: true,
    prune: false,
    ignore: [
      /^\/(?:\.git|\.next|\.npm-cache|\.vinext|\.wrangler|app|db|drizzle|examples|node_modules|public|release|scripts|test-data|tests|worker)(?:\/|$)/,
      /^\/(?:drizzle\.config\.ts|eslint\.config\.mjs|next-env\.d\.ts|next\.config\.ts|postcss\.config\.mjs|tsconfig\.json|vite\.config\.ts)$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "win32"],
    },
  ],
};
