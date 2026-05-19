/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'command-obsidian': '#0A0A09',
        'command-warm-white': '#F5F5DC',
        'command-crail-orange': '#C15F3C',
        'command-stone': '#FAFAF9',
        'command-accent': '#C15F3C',
        'command-border': 'rgba(255, 255, 255, 0.06)',
        'command-surface': 'rgba(255, 255, 255, 0.05)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif'],
      },
      letterSpacing: {
        eyebrow: '0.20em',
        label: '0.15em',
      }
    },
  },
  plugins: [],
}
