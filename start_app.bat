@echo off
set PATH=%PATH%;C:\Program Files\nodejs;C:\Users\amoff\AppData\Local\Programs\Python\Python312;C:\Users\amoff\AppData\Local\Programs\Python\Python312\Scripts
echoStarting Tech Trolley Asset Tracker...

echo Starting Django Backend...
start "Django Backend" cmd /k "cd backend && \"C:\Users\amoff\AppData\Local\Programs\Python\Python312\python.exe\" manage.py runserver"

echo Starting Vite Frontend...
start "Vite Frontend" cmd /k "npm run dev"

echo.
echo Application started!
echo Frontend: http://localhost:3000
echo Backend: http://127.0.0.1:8000
echo.
pause
