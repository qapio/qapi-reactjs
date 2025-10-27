import esbuild from "esbuild";

import { nodeExternalsPlugin } from "esbuild-node-externals";

esbuild
    .build({
        bundle: true,
            format: "esm",
        minify: true,
        outdir: "dist",
        entryPoints: ["./src/Index.tsx"],
        treeShaking: true,
        plugins: [nodeExternalsPlugin()],
    })
    .catch(() => process.exit(1));