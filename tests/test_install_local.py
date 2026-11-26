"""Exercise the bootstrap against a disposable filesystem and system command doubles."""
from argparse import Namespace
from contextlib import ExitStack
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from scripts import install_local as installer


ROOT = Path(__file__).resolve().parents[1]


class LocalInstallerIsolation(TestCase):
    def test_existing_checkout_enrollment_pins_both_directory_identities(self):
        with TemporaryDirectory() as temporary:
            checkout = Path(temporary) / 'checkout'
            git = checkout / '.git'
            git.mkdir(parents=True)
            spec = json.loads((ROOT / 'examples/operational-installation.json').read_text())
            spec['agent']['existingCheckout'] = str(checkout)
            spec['configuration']['limits']['activeRuns'] = 1
            coding = Namespace(pw_uid=os.getuid())
            with self.assertRaisesRegex(RuntimeError, 'existing_checkout_requires_single_named_installation'):
                installer.enroll_existing_checkout(spec, installer.InstanceLayout(None), coding)
            policy = installer.enroll_existing_checkout(spec, installer.InstanceLayout('other'), coding)
            self.assertEqual(policy['checkout']['inode'], checkout.stat().st_ino)
            self.assertEqual(policy['gitDirectory']['inode'], git.stat().st_ino)
            git.rename(checkout / '.real-git')
            git.symlink_to(checkout / '.real-git', target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, 'symlink_path_preserved'):
                installer.enroll_existing_checkout(spec, installer.InstanceLayout('other'), coding)

    def test_named_bootstrap_preserves_the_original_installation(self):
        with TemporaryDirectory() as temporary:
            self.check_installations(Path(temporary))

    def check_installations(self, host):
        def relocate(path):
            return host / path.relative_to('/')

        def local_layout(name):
            layout = installer.InstanceLayout(name)
            for key, value in vars(layout).items():
                if isinstance(value, Path):
                    setattr(layout, key, relocate(value))
            layout.parents = [relocate(path) for path in layout.parents]
            return layout

        original, second = local_layout(None), local_layout('second')
        for directory in (original.release_root.parent.parent, original.config.parent, original.state.parent,
                          original.source_root.parent.parent, original.units, original.launcher.parent, original.host_key.parent):
            directory.mkdir(parents=True, exist_ok=True)
        original.host_key.write_text('ssh-ed25519 test-host-key test\n')

        bundle = host / 'bundle'
        files = {
            'bin/node': b'node', 'apps/cli/main.ts': b'cli', 'apps/target-helper/main.ts': b'helper',
            'schemas/config.schema.json': b'schema',
        }
        for package in ('provider-github', 'connector-ssh', 'action-workspace-create', 'action-self-build'):
            manifest = json.loads((ROOT / 'packages' / package / 'extension.json').read_text())
            files[f'artifacts/{package}.json'] = json.dumps({'manifest': manifest}).encode()
        entries = []
        for name, data in files.items():
            target = bundle / 'files' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entries.append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                            'executable': name == 'bin/node'})
        release_manifest = json.dumps({'schemaVersion': '1.0', 'nodeVersion': '24.22.0',
                                       'revision': 'a' * 40, 'files': entries}).encode()
        (bundle / 'release-manifest.json').write_bytes(release_manifest)

        spec = json.loads((ROOT / 'examples/operational-installation.json').read_text())
        configs = []
        for name in ('original', 'second'):
            credential = host / f'{name}-credential'
            credential.write_text('synthetic credential')
            credential.chmod(0o600)
            model = deepcopy(spec)
            model['configuration']['installationId'] = model['policy']['installationId'] = name
            model['credentials']['secret:github-app'] = str(credential)
            configuration = host / f'{name}-input.json'
            configuration.write_text(json.dumps(model))
            configs.append(Namespace(bundle=bundle, manifest_sha256=hashlib.sha256(release_manifest).hexdigest(),
                                     configuration=configuration, coding_user='coder', backend_socket=Path('/run/example.sock'),
                                     dry_run=False, stage_only=False, private_source=name == 'second'))

        uid, gid = os.getuid(), os.getgid()
        managed_directory, managed_file = installer.managed_directory, installer.managed_file
        calls = []

        def command(args):
            calls.append(args)
            if args[0] == '/usr/bin/ssh-keygen':
                Path(args[-1]).write_text('synthetic private key')
                Path(args[-1] + '.pub').write_text('ssh-ed25519 test-client-key test')
            if args[0] == '/usr/sbin/runuser':
                enrollment = json.loads(Path(args[-1]).read_text())['enrollment']
                return json.dumps({'enrollmentDirectory': args[-2], 'targetId': enrollment['targetId'],
                                   'revision': enrollment['revision'], 'digest': 'b' * 64}).encode()
            return b''

        def snapshot(paths):
            return {path: path.read_bytes() for item in paths
                    for path in ([item] if item.is_file() else item.rglob('*'))
                    if path.is_file() and item / 'instances' not in path.parents}

        with ExitStack() as patches:
            for name, effect in {
                'managed_directory': lambda path, *args: managed_directory(path, uid, gid, args[2] if args else 0o755),
                'managed_file': lambda path, data, uid=uid, gid=gid, mode=0o644: managed_file(path, data, os.getuid(), os.getgid(), mode),
                'ensure_user': lambda name, home: Namespace(pw_name=name, pw_dir=str(home), pw_uid=uid, pw_gid=gid),
                'ensure_group': lambda name: gid,
                'command': command,
            }.items():
                patches.enter_context(mock.patch.object(installer, name, side_effect=effect))
            patches.enter_context(mock.patch.object(installer.pwd, 'getpwnam', return_value=Namespace(pw_uid=uid, pw_gid=gid)))
            patches.enter_context(mock.patch.object(installer.os, 'geteuid', return_value=0))
            patches.enter_context(mock.patch.object(installer.os, 'chown'))
            patches.enter_context(mock.patch.object(installer.os, 'umask'))
            patches.enter_context(mock.patch('builtins.print'))

            installer.install(configs[0], original)
            original_paths = [original.config, original.state, original.source_root, original.launcher,
                              original.units / original.coordinator_unit, original.units / original.bridge_unit]
            original_files = snapshot(original_paths)
            calls.clear()
            installer.install(configs[1], second)

        self.assertEqual(original_files, snapshot(original_paths))
        self.assertFalse(any('coder' in call for call in calls))
        installation = json.loads((second.config / 'installation.json').read_text())
        bridge = json.loads((second.config / 'bridge.json').read_text())
        helper = json.loads((second.config / 'helper.json').read_text())
        ssh = json.loads((second.state / 'coordinator/enrollment-input.json').read_text())['enrollment']
        self.assertFalse(installation['configuration']['enabled'])
        self.assertEqual(installation['stateDirectory'], str(second.state / 'coordinator'))
        projection = next(entry['valueFrom'] for entry in installation['configuration']['projections'] if entry['field'] == 'path')
        self.assertEqual(projection['rootPath'], str(second.source_root))
        self.assertEqual(bridge['backendSocket'], '/run/example.sock')
        self.assertEqual(bridge['socket'], '/run/labstride-bridge-second/control.sock')
        self.assertEqual(bridge['reportDirectory'], str(second.state / 'bridge-reports'))
        self.assertEqual(bridge['sourceRoot'], str(second.source_root))
        self.assertEqual(bridge['installationId'], 'second')
        self.assertEqual(helper['sources'][0]['credentialFile'], str(second.config / 'source-token'))
        self.assertEqual(ssh['helperCommand'], str(second.config / 'helper-launch'))
        self.assertEqual(ssh['user'], 'ls-second-helper')
        self.assertIn(second.bridge_unit, (second.units / second.coordinator_unit).read_text())
        self.assertIn('runuser -u ls-second-coord', second.launcher.read_text())
        self.assertEqual([call[1:] for call in calls if call[0] == '/usr/bin/systemctl'], [['daemon-reload']])
