import { cpSync, mkdirSync } from "node:fs";

// tsc doesn't copy non-TS assets; the daemon serves dist/ui/index.html.
mkdirSync(new URL("../dist/ui", import.meta.url), { recursive: true });
cpSync(new URL("../src/ui/index.html", import.meta.url), new URL("../dist/ui/index.html", import.meta.url));
// stderr: prepack runs this during `npm pack --json`, whose stdout must stay pure JSON
console.error("copied src/ui -> dist/ui");
