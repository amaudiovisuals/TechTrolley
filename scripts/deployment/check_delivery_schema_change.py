"""Bound this release to one additive table and no existing model edits."""
import ast
import subprocess
import sys

previous, candidate = sys.argv[1:]
def source(revision, path):
    return subprocess.check_output(['git', 'show', f'{revision}:{path}'], text=True)

path = 'backend/core/models.py'
old = ast.parse(source(previous, path))
new = ast.parse(source(candidate, path))
added = [node for node in new.body if isinstance(node, ast.ClassDef) and node.name == 'ProgramDelivery']
assert len(added) == 1, 'Expected exactly one new document model.'
new.body.remove(added[0])
assert ast.dump(old) == ast.dump(new), 'Existing models must remain identical.'
migrations = subprocess.check_output(['git', 'diff', '--name-status', previous, candidate, '--', 'backend/core/migrations'], text=True).strip()
assert migrations == 'A\tbackend/core/migrations/0054_program_delivery_documents.py', 'Only the reviewed additive migration is allowed.'
print('Schema boundary: one new document table; existing models/migrations unchanged.')
