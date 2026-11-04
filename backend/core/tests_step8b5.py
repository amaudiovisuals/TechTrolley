from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase
from unittest.mock import patch


class RetiredCleanupTests(SimpleTestCase):
    def test_legacy_cleanup_refuses_before_any_database_connection(self):
        with patch('django.db.backends.base.base.BaseDatabaseWrapper.ensure_connection') as connect:
            with self.assertRaisesMessage(CommandError, 'cleanup_adhoc is retired'):
                call_command('cleanup_adhoc', verbosity=0)
            connect.assert_not_called()
