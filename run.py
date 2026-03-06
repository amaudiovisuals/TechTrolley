import os
import sys
import subprocess

if __name__ == "__main__":
    # Change directory to backend
    os.chdir(os.path.join(os.path.dirname(__file__), "backend"))
    
    # Run django server
    sys.argv = ["manage.py", "runserver"]
    
    # Use the same python executable that is running this script
    subprocess.call([sys.executable, "manage.py", "runserver"])
