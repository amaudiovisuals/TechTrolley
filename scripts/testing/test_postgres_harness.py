"""Safety contracts for the isolated cluster harness; no database required."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from run_postgres_tests import clean_environment, verify_test_connection, worker

class Connection:
    vendor='postgresql'
    alias='default'
    def __init__(self, base, name='tt_validation_tests', host=None, data=None, listen='', actual=None):
        self.settings_dict={'NAME':name,'HOST':host or str(base/'socket')}
        self.results=iter([str(data or base/'data'),listen,actual or name]);self.closed=False;self.queries=[]
    def cursor(self):return self
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def execute(self,sql):self.queries.append(sql)
    def fetchone(self):return (next(self.results),)
    def close(self):self.closed=True

class HarnessSafetyTests(unittest.TestCase):
    base=Path('/private/tmp/tt-pg-synthetic')
    def test_expected_private_identity_is_read_only(self):
        connection=Connection(self.base);verify_test_connection(connection,self.base)
        self.assertFalse(connection.closed)
        self.assertEqual(connection.queries,['SHOW data_directory','SHOW listen_addresses','SELECT current_database()'])
    def test_business_database_name_rejected_before_query(self):
        connection=Connection(self.base,name='techtrolley_prod')
        with self.assertRaises(RuntimeError):verify_test_connection(connection,self.base)
        self.assertTrue(connection.closed);self.assertEqual(connection.queries,[])
    def test_tcp_or_other_socket_rejected_before_query(self):
        for host in ['localhost','127.0.0.1','/tmp/other-cluster']:
            connection=Connection(self.base,host=host)
            with self.assertRaises(RuntimeError):verify_test_connection(connection,self.base)
            self.assertTrue(connection.closed);self.assertEqual(connection.queries,[])
    def test_wrong_data_directory_is_refused_and_closed(self):
        connection=Connection(self.base,data=Path('/tmp/other-data'))
        with self.assertRaises(RuntimeError):verify_test_connection(connection,self.base)
        self.assertTrue(connection.closed)
    def test_tcp_listener_or_actual_database_mismatch_is_refused(self):
        for options in [{'listen':'localhost'},{'actual':'techtrolley_prod'}]:
            connection=Connection(self.base,**options)
            with self.assertRaises(RuntimeError):verify_test_connection(connection,self.base)
            self.assertTrue(connection.closed)
    def test_django_maintenance_alias_is_the_only_null_name_allowed(self):
        connection=Connection(self.base,name=None,actual='postgres');connection.alias='__no_db__'
        verify_test_connection(connection,self.base);self.assertFalse(connection.closed)
        connection=Connection(self.base,name=None,actual='postgres')
        with self.assertRaises(RuntimeError):verify_test_connection(connection,self.base)
        self.assertTrue(connection.closed)
    def test_inherited_database_settings_and_ai_keys_are_removed(self):
        with patch.dict(os.environ,{'PGHOST':'live-host','PGDATABASE':'business','PGSERVICEFILE':'private-file','DJANGO_ENV':'production','DJANGO_SETTINGS_MODULE':'config.settings','DATABASE_URL':'synthetic-url','GEMINI_API_KEY':'synthetic-key','TT_SAFE_SENTINEL':'kept'}):
            env=clean_environment()
            self.assertFalse(any(key.startswith('PG') for key in env))
            for key in ['DJANGO_ENV','DJANGO_SETTINGS_MODULE','DATABASE_URL','GEMINI_API_KEY']:self.assertNotIn(key,env)
            self.assertEqual(env['TT_SAFE_SENTINEL'],'kept')
    def test_unrelated_control_path_cannot_initialize_a_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            control=Path(folder)/'control.json';control.write_text('{}')
            with self.assertRaises(RuntimeError):worker(control)

if __name__=='__main__':unittest.main(verbosity=2)
