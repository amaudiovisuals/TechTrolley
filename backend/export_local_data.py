import os
import sys
import subprocess

def export_data():
    """
    Exports the current local Django database into a JSON fixture file
    compatible with the production load script.
    """
    # Ensure we are in the backend directory or point to the right manage.py
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    manage_py = os.path.join(backend_dir, 'manage.py')
    output_file = os.path.join(backend_dir, 'production_data.json')

    print(f"--- Exporting local data to {output_file} ---")
    
    try:
        # Use django-admin or python manage.py dumpdata
        # We exclude sessions, contenttypes, and admin.logentry to keep it clean
        cmd = [
            'python', manage_py, 'dumpdata',
            '--indent', '2',
            '--exclude', 'auth.permission',
            '--exclude', 'contenttypes',
            '--exclude', 'sessions',
            '--exclude', 'admin.logentry',
            '-o', output_file
        ]
        
        subprocess.run(cmd, check=True)
        print("Success! Data exported to backend/production_data.json")
        print("\nNext steps:")
        print("1. git add backend/production_data.json")
        print("2. git commit -m 'Update production data'")
        print("3. git push origin main")
        print("4. On your AWS server, run: python backend/load_production_data.py")
        
    except subprocess.CalledProcessError as e:
        print(f"Error during export: {e}")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    export_data()
