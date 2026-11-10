"""Activation failure boundaries; no host services or provider writes are made."""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import activate_local as activation


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='labstride-activate-')
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / 'installation.json'
        self.original = json.dumps({'schemaVersion': '1.0', 'revision': 'a' * 40, 'configuration': {'enabled': False}}).encode()
        self.path.write_bytes(self.original)
        self.path.chmod(0o640)
        self.calls = []
        self.a = activation.Activation.__new__(activation.Activation)
        self.a.path, self.a.original, self.a.spec = self.path, self.original, json.loads(self.original)
        self.a.info = self.path.stat()
        self.a.run = lambda args: self.calls.append(args) or b''
        self.a.verify = lambda: self.calls.append(['verify'])
        self.a.cli_check = lambda *args: self.calls.append(['cli', *args]) or {'ok': True}

    def test_checks_precede_enablement_and_atomic_write_preserves_group_read_under_private_umask(self):
        previous = os.umask(0o077)
        try:
            result = self.a.apply()
        finally:
            os.umask(previous)
        self.assertEqual(result['code'], 'activation_completed')
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)
        self.assertEqual(self.path.stat().st_gid, self.a.info.st_gid)
        self.assertTrue(json.loads(self.path.read_bytes())['configuration']['enabled'])
        backup = list(self.path.parent.glob('*.before-activation-*'))
        self.assertEqual(len(backup), 1)
        self.assertEqual(backup[0].read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(backup[0].stat().st_mode), 0o600)
        self.assertEqual(self.calls[:3], [['verify'], ['/usr/bin/systemctl', 'start', 'labstride-bridge.service'], ['cli', 'doctor']])

    def test_preflight_failure_keeps_listener_disabled_without_starting_coordinator(self):
        self.a.cli_check = Mock(side_effect=RuntimeError('activation_preflight_blocked'))
        with self.assertRaisesRegex(RuntimeError, 'preflight_blocked'):
            self.a.apply()
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(any('labstride.service' in args for args in self.calls))

    def test_interrupted_activation_resumes_without_rewriting_enabled_configuration(self):
        original_run = self.a.run
        def fail_start(args):
            if args == ['/usr/bin/systemctl', 'start', 'labstride.service']:
                raise RuntimeError('activation_check_failed')
            return original_run(args)
        self.a.run = fail_start
        with self.assertRaisesRegex(RuntimeError, 'activation_check_failed'):
            self.a.apply()
        enabled = self.path.read_bytes()
        self.a.original = enabled  # A new invocation binds the current file.
        self.a.spec = json.loads(enabled)
        self.a.run = original_run
        self.a.apply()
        self.assertEqual(self.path.read_bytes(), enabled)
        self.assertEqual(len(list(self.path.parent.glob('*.before-activation-*'))), 1)
        self.assertFalse(any('restart' in args or 'stop' in args for args in self.calls))

    def test_concurrent_configuration_change_is_preserved(self):
        def changed(*args):
            self.path.write_text('{"changed": true}')
            return {'ok': True}
        self.a.cli_check = changed
        with self.assertRaisesRegex(RuntimeError, 'configuration_changed'):
            self.a.apply()
        self.assertEqual(self.path.read_text(), '{"changed": true}')
        self.assertFalse(any('labstride.service' in args for args in self.calls))

    def test_unsafe_symlink_is_preserved(self):
        link = self.path.parent / 'unmanaged.json'
        link.symlink_to(self.path)
        with self.assertRaisesRegex(RuntimeError, 'symlink_path_preserved'):
            activation.atomic_file(link, b'changed', os.getuid(), os.getgid(), 0o640)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_service_identity_commands_do_not_use_root_for_checks(self):
        self.a.coordinator = types.SimpleNamespace(pw_name='labstride_coord')
        self.a.node, self.a.cli = '/release/bin/node', '/release/apps/cli/main.ts'
        output = {'ok': True, 'schemaVersion': '1.0'}
        def run(args):
            self.calls.append(args)
            return json.dumps(output).encode()
        self.a.run = run
        # Exercise the real method with its protected service user/group arguments.
        activation.Activation.cli_check(self.a, 'config', 'validate')
        self.assertEqual(self.calls[0][:4], ['/usr/sbin/runuser', '-u', 'labstride_coord', '-g'])
        self.assertIn('labstride_work', self.calls[0])
        self.assertIn('validate', self.calls[0])

    def test_child_errors_do_not_expose_stderr(self):
        with patch.object(activation.subprocess, 'run', side_effect=activation.subprocess.CalledProcessError(1, 'probe', stderr=b'private-key-value')):
            with self.assertRaisesRegex(RuntimeError, '^activation_check_failed$'):
                activation.command(['probe'])


if __name__ == '__main__':
    unittest.main()
