@echo off
echo --- Step 1: Exporting local data ---
python backend\export_local_data.py
if %ERRORLEVEL% NEQ 0 (
    echo Error during data export. Aborting.
    pause
    exit /b
)

echo --- Step 2: Adding changes to Git ---
git add .

echo --- Step 3: Committing data update ---
git commit -m "Automated data sync update"

echo --- Step 4: Pushing to GitHub (Triggers AWS Deployment) ---
git push origin main

echo --- Done! Check GitHub Actions for deployment status ---
