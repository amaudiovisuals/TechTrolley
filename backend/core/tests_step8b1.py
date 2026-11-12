"""Staging side-effect guard; synthetic data, no external requests."""
from unittest.mock import patch
from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

class ExternalIntegrationGateTests(TestCase):
    @override_settings(EXTERNAL_AI_ENABLED=False, GEMINI_API_KEY='synthetic-settings-key')
    def test_disabled_external_ai_uses_local_engine_even_with_inherited_key(self):
        user=User.objects.create_user('staging-ai-admin');user.profile.role='admin';user.profile.save()
        client=APIClient();client.force_authenticate(user)
        with patch.dict('os.environ',{'GEMINI_API_KEY':'synthetic-inherited-key'}), patch('core.ai_views.requests.post') as post:
            response=client.post('/api/ai-assistant/',{'message':'How many assets are available?'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.data['engine'],'local_rule_engine');post.assert_not_called()
