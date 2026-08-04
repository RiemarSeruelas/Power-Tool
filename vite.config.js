import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const devApiTarget = String(env.DEV_API_TARGET || "").trim();
  if (command === "serve" && !devApiTarget) {
    throw new Error("DEV_API_TARGET is required in .env.");
  }

  const server = {
    host: "0.0.0.0",
    port: Number(env.VITE_DEV_PORT || 5173)
  };
  if (command === "serve") {
    server.proxy = {
      "/api": {
        target: devApiTarget,
        changeOrigin: true
      }
    };
  }

  return {
    plugins: [react()],
    server
  };
});
