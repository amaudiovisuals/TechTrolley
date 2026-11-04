"""Private-proxy credential identity; no database access."""
from django.test import SimpleTestCase, override_settings
from .proxy_identity import credential_peer


class ProxyIdentityTests(SimpleTestCase):
    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=False)
    def test_default_never_trusts_client_headers(self):
        for direct in ('', None, '192.0.2.5'):
            self.assertEqual(credential_peer({'REMOTE_ADDR':direct, 'HTTP_X_TT_CLIENT_IP':'198.51.100.1',
                                             'HTTP_X_FORWARDED_FOR':'198.51.100.2'}),
                             direct if direct == '192.0.2.5' else 'unknown-peer')

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_unix_explicit_header_is_normalized(self):
        self.assertEqual(credential_peer({'REMOTE_ADDR':'', 'HTTP_X_TT_CLIENT_IP':'2001:db8:0:0::1'}), '2001:db8::1')
        self.assertEqual(credential_peer({'HTTP_X_TT_CLIENT_IP':'192.0.2.8'}), '192.0.2.8')

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_tcp_peers_never_gain_forwarded_identity(self):
        for direct in ('127.0.0.1','::1','192.0.2.1'):
            self.assertEqual(credential_peer({'REMOTE_ADDR':direct,'HTTP_X_TT_CLIENT_IP':'198.51.100.1'}),direct)

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_missing_malformed_or_chain_header_uses_shared_fail_closed_budget(self):
        for value in ('', None, 'unknown','192.0.2.1, 192.0.2.2','192.0.2.1:80',' 192.0.2.1','[::1]'):
            self.assertEqual(credential_peer({'REMOTE_ADDR':'','HTTP_X_TT_CLIENT_IP':value}), 'unknown-peer')

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_other_forwarded_headers_are_ignored(self):
        self.assertEqual(credential_peer({'REMOTE_ADDR':'','HTTP_X_FORWARDED_FOR':'192.0.2.1',
                                         'HTTP_X_REAL_IP':'192.0.2.1','HTTP_FORWARDED':'for=192.0.2.1'}),'unknown-peer')

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_throttle_uses_distinct_proxy_peers_and_shared_normalized_account(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from .auth_throttling import LoginAttemptThrottle
        with patch('core.auth_throttling.consume', return_value=0) as consume:
            for ip in ['192.0.2.1','192.0.2.2']:
                request=SimpleNamespace(META={'REMOTE_ADDR':'','HTTP_X_TT_CLIENT_IP':ip}, data={'email':' Staff@Example.test '})
                self.assertTrue(LoginAttemptThrottle().allow_request(request, None))
            self.assertEqual([c.args[:2] for c in consume.call_args_list], [
                ('credential-peer','192.0.2.1'),('credential-login','staff@example.test'),
                ('credential-peer','192.0.2.2'),('credential-login','staff@example.test')])

    @override_settings(PROXY_CLIENT_IP_FROM_UNIX=True)
    def test_missing_proxy_identity_still_consumes_shared_peer_budget(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from .auth_throttling import LoginAttemptThrottle
        with patch('core.auth_throttling.consume', return_value=60) as consume:
            request=SimpleNamespace(META={'REMOTE_ADDR':''},data={'email':'staff@example.test'})
            throttle=LoginAttemptThrottle()
            self.assertFalse(throttle.allow_request(request,None))
            consume.assert_called_once_with('credential-peer','unknown-peer',60,60)
            self.assertEqual(throttle.wait(),60)
