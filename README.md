<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1gP7iDQhKrF1df7cAFGyHaa1r5KX-MXw-

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

---

## Automatic Setup & Maintenance

To ensure "Antigravity" and all dependencies run smoothly every time you log in, we've provided a refresh script.

### One-Time Setup on Login
1. Press `Win + R`, type `shell:startup`, and press Enter.
2. Create a shortcut to `setup.bat` in this folder.
3. Now, every time you log in, the environment will automatically:
   - Detect the correct Python 3.12 interpreter.
   - Update backend and frontend dependencies.
   - Run any pending database migrations.

### Manual Refresh
You can manually refresh the environment at any time by running:
`./setup.bat`
or
`powershell -ExecutionPolicy Bypass -File refresh_environment.ps1`
