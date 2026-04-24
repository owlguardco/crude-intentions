import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "crude-bg": "#0d0d0f",
        "crude-panel": "#1a1a1e",
        "crude-border": "#2a2a2e",
        "crude-amber": "#d4a520",
        "crude-green": "#22c55e",
        "crude-red": "#ef4444",
        "crude-text": "#e0e0e0",
        "crude-muted": "#666670",
        "crude-dim": "#444450",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "monospace"],
        sans: ["Inter", "sans-serif"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};

export default config;
