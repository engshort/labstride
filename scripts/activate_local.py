#!/usr/bin/env python3
"""Checked, resumable activation of the native Linux install_local.py profile.

Default runs checks without starting services. --apply may start the enrolled bridge and coordinator;
it never starts another coding daemon or rewrites provider fields.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile

from install_local import no_links


def command(args):
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180).stdout
    except (subprocess.SubprocessError, OSError):
        # Provider/child stderr may contain credentials; never mirror it.
        raise RuntimeError('activation_check_failed') from None


def protected(path, uid=0, mode=None):
    no_links(path)
    info = path.stat()
    for parent in path.parents:
        directory = parent.stat()
        if directory.st_uid != 0 or directory.st_mode & 0o022 and not directory.st_mode & stat.S_ISVTX:
            raise RuntimeError('activation_path_unsafe')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_mode & 0o022:
        raise RuntimeError('activation_path_unsafe')
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('activation_permissions_mismatch')
    return info


def atomic_file(path, data, uid, gid, mode):
    no_links(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchown(output.fileno(), uid, gid)
            os.fchmod(output.fileno(), mode)  # Preserve group access even with umask 0077.
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Activation:
    def __init__(self, path, run=command):
        self.path, self.run = path, run
        self.info = protected(path, mode=0o640)
        self.original = path.read_bytes()
        self.spec = json.loads(self.original)
        if self.spec.get('schemaVersion') != '1.0' or not re.fullmatch(r'[a-f0-9]{40}', self.spec.get('revision', '')):
            raise RuntimeError('activation_profile_unsupported')
        self.release = Path('/opt/labstride/releases') / self.spec['revision']
        self.node, self.cli = str(self.release / 'bin/node'), str(self.release / 'apps/cli/main.ts')
        self.coordinator = pwd.getpwnam('labstride_coord')
        self.bridge = json.loads(Path('/etc/labstride/bridge.json').read_text())
        self.coding = pwd.getpwuid(Path(self.bridge['backendSocket']).stat().st_uid)
        self.helper = pwd.getpwnam('labstride_helper')
        if self.bridge.get('schemaVersion') != '1.0' or self.bridge.get('helperUid') != self.helper.pw_uid or self.bridge.get('sourceRoot') != self.spec['sourceRoot'] or self.bridge.get('backendVersion') != self.spec['agent']['backendVersion']:
            raise RuntimeError('activation_identity_mismatch')
        if self.coding.pw_uid < 1000 or self.info.st_gid != self.coordinator.pw_gid:
            raise RuntimeError('activation_identity_mismatch')

    def as_user(self, user, args, bridge=False):
        groups = ['labstride_work'] if bridge else ['labstride_bridge', 'labstride_work']
        group = 'labstride_bridge' if bridge else user.pw_name
        return self.run(['/usr/sbin/runuser', '-u', user.pw_name, '-g', group,
                         *[arg for value in groups for arg in ['-G', value]], '--', *args])

    def cli_check(self, *args):
        try:
            result = json.loads(self.as_user(self.coordinator, [self.node, self.cli, *args, '--config', str(self.path)]))
        except RuntimeError:
            raise RuntimeError('activation_doctor_blocked' if args == ('doctor',) else 'activation_configuration_blocked') from None
        if result.get('ok') is False:
            raise RuntimeError('activation_preflight_blocked')
        return result

    def verify(self):
        raw = self.release / 'release-manifest.json'
        protected(raw)
        manifest = json.loads(raw.read_bytes())
        if manifest['schemaVersion'] != '1.0' or manifest['revision'] != self.spec['revision'] or manifest['nodeVersion'] != '24.22.0':
            raise RuntimeError('activation_release_mismatch')
        for entry in manifest['files']:
            name = Path(entry['path'])
            if name.is_absolute() or '..' in name.parts:
                raise RuntimeError('activation_release_mismatch')
            file = self.release / name
            protected(file)
            if hashlib.sha256(file.read_bytes()).hexdigest() != entry['sha256'] or file.stat().st_size != entry['size']:
                raise RuntimeError('activation_release_mismatch')
        protected(Path('/etc/labstride/bridge.json'), mode=0o640)
        backend = Path(self.bridge['backendSocket']).stat()  # Enrolled stable socket symlink is supported.
        if not stat.S_ISSOCK(backend.st_mode) or backend.st_uid != self.coding.pw_uid or self.bridge['socket'] != self.spec['agent']['bridgeSocket']:
            raise RuntimeError('activation_socket_mismatch')
        for unit, user, group, start in [
            ('labstride.service', self.coordinator.pw_name, self.coordinator.pw_name,
             [self.node, self.cli, 'serve', '--config', str(self.path)]),
            ('labstride-bridge.service', self.coding.pw_name, 'labstride_bridge',
             [self.node, self.cli, 'bridge', '/etc/labstride/bridge.json'])]:
            unit_path = Path('/etc/systemd/system') / unit
            protected(unit_path)
            lines = unit_path.read_text().splitlines()
            if [line for line in lines if line.startswith('ExecStart=')] != ['ExecStart=' + ' '.join(start)] or f'User={user}' not in lines or f'Group={group}' not in lines:
                raise RuntimeError('activation_unit_mismatch')
            if self.run(['/usr/bin/systemctl', 'show', unit, '--property=FragmentPath', '--value']).decode().strip() != str(unit_path):
                raise RuntimeError('activation_unit_mismatch')
            if self.run(['/usr/bin/systemctl', 'show', unit, '--property=DropInPaths', '--value']).strip():
                raise RuntimeError('activation_unit_override')
        # Positive/negative access checks use the service identities, not root.
        probe = 'import os,sys; p=sys.argv[1]; mode=int(sys.argv[2]); expected=int(sys.argv[3]); sys.exit(0 if os.access(p,mode)==bool(expected) else 1)'
        for user, bridge in [(self.coding, True), (self.coordinator, False)]:
            for path in [self.path, self.release, self.release / 'bin/node']:
                self.as_user(user, ['/usr/bin/python3', '-c', probe, str(path), str(os.W_OK), '0'], bridge)
        for reference in self.spec['credentials'].values():
            file = Path(reference if isinstance(reference, str) else reference['keyFile'])
            protected(file, self.coordinator.pw_uid, 0o600)
            self.as_user(self.coordinator, ['/usr/bin/python3', '-c', probe, str(file), str(os.R_OK), '1'])
            for user in [self.coding, self.helper]:
                # runuser defaults also include the user's ordinary supplementary groups.
                self.run(['/usr/sbin/runuser', '-u', user.pw_name, '--', '/usr/bin/python3', '-c', probe, str(file), str(os.R_OK), '0'])
        for path in ['/var/lib/labstride/helper', '/etc/labstride/helper.json', self.spec['stateDirectory']]:
            self.as_user(self.coding, ['/usr/bin/python3', '-c', probe, str(path), str(os.W_OK), '0'], True)
        self.as_user(self.coding, ['/usr/bin/python3', '-c', probe, '/etc/labstride/bridge.json', str(os.R_OK), '1'], True)
        self.cli_check('config', 'validate')  # All field/option mappings and extension pins.

    def apply(self):
        self.verify()
        # No daemon restart: attach the bridge to the operator's enrolled socket.
        self.run(['/usr/bin/systemctl', 'start', 'labstride-bridge.service'])
        self.cli_check('doctor')  # Includes live catalog, target and SQLite checks.
        if self.path.read_bytes() != self.original:
            raise RuntimeError('activation_configuration_changed')
        if not self.spec['configuration']['enabled']:
            backup = self.path.with_name(self.path.name + '.before-activation-' + hashlib.sha256(self.original).hexdigest())
            if backup.exists():
                protected(backup, mode=0o600)
                if backup.read_bytes() != self.original:
                    raise RuntimeError('activation_backup_conflict')
            else:
                fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as output:
                    output.write(self.original)
                    output.flush()
                    os.fsync(output.fileno())
            self.spec['configuration']['enabled'] = True
            atomic_file(self.path, (json.dumps(self.spec, indent=2) + '\n').encode(), self.info.st_uid, self.info.st_gid, 0o640)
        # Failure after enablement is resumable. Never roll back execution state
        # or disable a coordinator that may already have dispatched an effect.
        self.run(['/usr/bin/systemctl', 'enable', 'labstride-bridge.service', 'labstride.service'])
        self.run(['/usr/bin/systemctl', 'start', 'labstride.service'])
        self.run(['/usr/bin/systemctl', 'is-active', '--quiet', 'labstride-bridge.service', 'labstride.service'])
        return {'schemaVersion': '1.0', 'code': 'activation_completed', 'enabled': True,
                'revision': self.spec['revision'], 'sessionContinuity': 'requires_independent_client_evidence'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configuration', type=Path, default=Path('/etc/labstride/installation.json'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('administrative_access_required')
    # Root-owned bootstrap directory; serialize activation without an ephemeral checkpoint.
    no_links(args.configuration)
    lock = args.configuration.with_name('.activation.lock')
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activation = Activation(args.configuration)
        if args.apply:
            result = activation.apply()
        else:
            activation.verify()
            result = {'schemaVersion': '1.0', 'code': 'activation_checks_passed', 'enabled': activation.spec['configuration']['enabled'],
                      'next': 'Run with --apply to start the bridge, check doctor and enable the coordinator.'}
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[a-z_]{1,100}', str(error)) else 'activation_failed'
        raise SystemExit(code)
