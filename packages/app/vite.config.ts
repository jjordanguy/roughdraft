import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(() => {
  const apiPort = parseInt(process.env.API_PORT || "3001", 10);

  return {
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: "dist",
      chunkSizeWarningLimit: 1000,
    },
    server: {
      proxy: {
        "/api": { target: `http://localhost:${apiPort}`, ws: true },
      },
    },
  };
});
