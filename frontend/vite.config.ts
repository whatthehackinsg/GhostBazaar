import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

// Engine proxy target — controlled by ENGINE var in .env.local:
//   ENGINE=local  → http://localhost:3000 (default)
//   ENGINE=fly    → https://ghost-bazaar-engine.fly.dev
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const target = env.ENGINE === "fly"
    ? "https://ghost-bazaar-engine.fly.dev"
    : "http://localhost:3000"

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/dashboard": target,
        "/admin": target,
        "/health": target,
        "/listings": target,
        "/rfqs": target,
      },
    },
  }
})
