"""Transaction boundaries for database-contract tests, never application settings.

PostgreSQL read-only snapshots must begin before a transaction's first query.
Django TestCase wraps fixture writes and API calls in one outer transaction, so
these tests need TransactionTestCase there. SQLite retains its faster TestCase.
"""
from django.db import connection, transaction
from django.test import TestCase, TransactionTestCase

SnapshotTestCase = TransactionTestCase if connection.vendor == 'postgresql' else TestCase


def collect_readonly_snapshot(database):
    from .legacy_reconciliation import collect_snapshot
    with transaction.atomic(using=database.alias):
        if database.vendor == 'postgresql':
            with database.cursor() as cursor:
                cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return collect_snapshot(database)
