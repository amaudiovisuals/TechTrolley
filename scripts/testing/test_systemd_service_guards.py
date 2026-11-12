"""Refusal boundaries for VM-only root tooling. No services, filesystem or DB writes."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import systemd_service_probe as probe


class VMServiceGuards(unittest.TestCase):
    def sentinel(self,**fields):
        identity={'protocol':'tt-local-synthetic-vm-1','nonce':'synthetic-nonce','business_data_allowed':False,**fields}
        value=Mock();value.is_file.return_value=True;value.is_symlink.return_value=False
        value.stat.return_value=SimpleNamespace(st_uid=0,st_mode=0o100600)
        value.read_text.return_value=json.dumps(identity);return value

    def test_wrong_platform_or_nonroot_never_reads_identity(self):
        for platform,uid in [('darwin',0),('linux',501)]:
            with patch.object(probe.sys,'platform',platform),patch.object(probe.os,'geteuid',return_value=uid),patch.object(probe,'Path') as path:
                with self.assertRaises(ValueError):probe.guard('synthetic-nonce')
                path.assert_not_called()

    def test_missing_symlink_foreign_or_public_identity_refused(self):
        for kind in ['missing','symlink','foreign','public']:
            value=self.sentinel()
            if kind=='missing':value.is_file.return_value=False
            if kind=='symlink':value.is_symlink.return_value=True
            if kind=='foreign':value.stat.return_value.st_uid=501
            if kind=='public':value.stat.return_value.st_mode=0o100644
            with patch.object(probe.sys,'platform','linux'),patch.object(probe.os,'geteuid',return_value=0),patch.object(probe,'Path',return_value=value):
                with self.assertRaises(ValueError):probe.guard('synthetic-nonce')
                value.read_text.assert_not_called()

    def test_wrong_nonce_protocol_or_business_permission_refused(self):
        for fields in [{'nonce':'other'},{'protocol':'production'},{'business_data_allowed':True},{'business_data_allowed':None}]:
            with patch.object(probe.sys,'platform','linux'),patch.object(probe.os,'geteuid',return_value=0),patch.object(probe,'Path',return_value=self.sentinel(**fields)):
                with self.assertRaises(ValueError):probe.guard('synthetic-nonce')

    def test_matching_private_synthetic_identity_is_required(self):
        with patch.object(probe.sys,'platform','linux'),patch.object(probe.os,'geteuid',return_value=0),patch.object(probe,'Path',return_value=self.sentinel()):
            probe.guard('synthetic-nonce')

    def test_existing_site_refuses_before_any_command(self):
        existing=Mock();existing.exists.return_value=True
        with patch.object(probe,'ROOT',existing),patch.object(probe,'run') as run:
            with self.assertRaises(ValueError):probe.install(None,None,None,None)
            run.assert_not_called()


if __name__=='__main__':unittest.main()
