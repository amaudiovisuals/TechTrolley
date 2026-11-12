const path = require('node:path');
module.exports = {
  plugins: {
    // Test/dev tools may start Vite from the repository root.
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.cjs') },
    autoprefixer: {},
  },
};
