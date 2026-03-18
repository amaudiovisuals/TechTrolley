import os
import django
import sys

# Setup Django environment
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from core.models import Asset
from django.db import models

def cleanup_nan():
    print("Starting cleanup of 'nan' strings in Asset model...")
    
    # Identify CharFields and TextFields to check
    fields_to_check = [
        f for f in Asset._meta.get_fields() 
        if isinstance(f, (models.CharField, models.TextField))
    ]
    
    total_fixed = 0
    
    for field in fields_to_check:
        field_name = field.name
        # Filter for exact string "nan"
        queryset = Asset.objects.filter(**{f"{field_name}": "nan"})
        count = queryset.count()
        
        if count > 0:
            print(f"Found {count} records with 'nan' in field: {field_name}")
            # Update to empty string or None depending on nullability
            if field.null:
                queryset.update(**{field_name: None})
            else:
                queryset.update(**{field_name: ""})
            total_fixed += count
            
    print(f"Cleanup complete. Total 'nan' values fixed: {total_fixed}")

if __name__ == "__main__":
    cleanup_nan()
