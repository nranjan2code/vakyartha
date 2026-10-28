// The desktop UI bundle. Vite resolves the framework's .ts packages
// (@vak/core, @vak/web) straight from the workspace; Tauri loads the result.
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "localhost" },
  build: { outDir: "dist", emptyOutDir: true, reportCompressedSize: false, target: ["es2023", "safari17", "chrome120"] },
});
