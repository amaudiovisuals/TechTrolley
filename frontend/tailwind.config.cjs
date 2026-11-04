/** @type {import('tailwindcss').Config} */
module.exports = {
  // Include complete class strings in data/configuration modules as well as JSX.
  // Conditional utilities use complete literal tokens; no broad safelist needed.
  content: {
    relative: true,
    files: ['./index.html', './*.{ts,tsx}', './components/**/*.{ts,tsx}', './state/**/*.{ts,tsx}'],
  },
  theme: {
    extend: {
      colors: {
        sky: { 400: 'var(--color-primary-light)', 500: 'var(--color-primary)', 600: 'var(--color-primary-dark)' },
        orange: { 400: 'var(--color-secondary)', 500: 'var(--color-secondary)' },
        slate: { 800: '#cbd5e1', 900: '#ffffff', 950: '#F0F9FF' },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
    },
  },
};
