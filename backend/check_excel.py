import pandas as pd
import os

excel_path = 'backend/Main_Inventory_Master.xlsx'
if not os.path.exists(excel_path):
    print("Excel not found")
    exit(1)

df = pd.read_excel(excel_path)
print(f"Excel loaded. {len(df)} rows.")

term = "TFT"
matches = df[df.apply(lambda row: row.astype(str).str.contains(term, case=False).any(), axis=1)]
print(f"Found {len(matches)} rows with '{term}'")
print(matches.head(10))

term2 = "5CD52409KL"
matches2 = df[df.apply(lambda row: row.astype(str).str.contains(term2, case=False).any(), axis=1)]
print(f"\nFound {len(matches2)} rows with '{term2}'")
print(matches2.head(10))
